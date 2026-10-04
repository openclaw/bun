/** Configure-time tests for the committed OpenClaw WebKit pin. */
import { describe, expect, test } from "bun:test";
import { bunEnv, bunExe, tempDir } from "harness";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveConfig, type Config, type PartialConfig, type Toolchain } from "../../../scripts/build/config.ts";
import {
  webkit,
  WEBKIT_VERSION,
  webkitArtifact,
  webkitTestFFIPath,
  type WebKitArtifactManifest,
} from "../../../scripts/build/deps/webkit.ts";
import { Ninja } from "../../../scripts/build/ninja.ts";
import { registerDepRules, resolveDep } from "../../../scripts/build/source.ts";

/** A fully-populated fake toolchain — resolveConfig never spawns any of these. */
function mockToolchain(): Toolchain {
  return {
    cc: "/fake/llvm/bin/clang",
    cxx: "/fake/llvm/bin/clang++",
    hostCc: undefined,
    hostCxx: undefined,
    clangVersion: "23.1.1",
    clangResourceDir: "/fake/llvm/lib/clang/23",
    ar: "/fake/llvm/bin/llvm-ar",
    ranlib: "/fake/llvm/bin/llvm-ranlib",
    ld: "/fake/llvm/bin/ld.lld",
    ld64Lld: "/fake/llvm/bin/ld64.lld",
    rustLlvmVersion: "23.1.1",
    rustSysroot: undefined,
    rustHostTriple: undefined,
    strip: "/fake/bin/strip",
    llvmStrip: "/fake/llvm/bin/llvm-strip",
    nm: "/fake/llvm/bin/llvm-nm",
    readobj: "/fake/llvm/bin/llvm-readobj",
    objdump: "/fake/llvm/bin/llvm-objdump",
    cxxfilt: "/fake/llvm/bin/llvm-cxxfilt",
    dsymutil: "/fake/llvm/bin/dsymutil",
    bun: "/fake/bin/bun",
    jsRuntime: "/fake/bin/bun",
    esbuild: "/fake/bin/esbuild",
    ccache: undefined,
    cmake: "/fake/bin/cmake",
    cargo: undefined,
    cargoHome: undefined,
    rustupHome: undefined,
    msvcLinker: undefined,
    rc: undefined,
    mt: undefined,
    nasm: undefined,
  };
}

/** Shorthand: a Linux glibc x64 release target. linuxSysroot stubbed so the
 * cross-arch block in resolveConfig never throws on a non-x64-glibc host. */
function resolveLinuxRelease(partial: PartialConfig = {}): Config {
  return resolveConfig(
    {
      os: "linux",
      arch: "x64",
      abi: "gnu",
      buildType: "Release",
      lto: false,
      baseline: false,
      linuxSysroot: "/fake/linux-sysroot",
      winsysroot: "/fake/windows-sysroot",
      ...partial,
    },
    mockToolchain(),
  );
}

function fixture(name: string, digest = "a".repeat(64)): WebKitArtifactManifest {
  return {
    version: WEBKIT_VERSION,
    artifacts: {
      [name]: {
        url: `https://github.com/openclaw/WebKit/releases/download/autobuild-${WEBKIT_VERSION}/${name}`,
        sha256: digest,
      },
    },
  };
}

describe("WebKit artifact manifest", () => {
  test("missing variants permit graph construction but fail the dependency edge", () => {
    using dir = tempDir("webkit-unavailable", {});
    const cfg = resolveLinuxRelease({ buildType: "Debug", asan: true, buildDir: String(dir) });
    const source = webkit.source(cfg);
    if (source.kind !== "unavailable") throw new Error("expected an unavailable debug artifact");
    expect(source.destDir).toStartWith(String(dir));
    const ninja = new Ninja({ buildDir: cfg.buildDir });
    registerDepRules(ninja, cfg);
    resolveDep(ninja, cfg, webkit, new Map());
    const encoded = /^  message = (.*)$/m.exec(ninja.toString())![1]!;
    expect(Buffer.from(encoded, "base64url").toString("utf8")).toBe(source.message);
    const child = spawnSync(
      bunExe(),
      [fileURLToPath(new URL("../../../scripts/build/fetch-cli.ts", import.meta.url)), "unavailable", encoded],
      { env: bunEnv, encoding: "utf8" },
    );
    expect(child.stderr).toContain("Missing SHA-256 for WebKit target bun-webkit-linux-amd64-debug-asan.tar.gz");
    expect(child.status).toBe(1);
    expect(existsSync(source.destDir)).toBe(false);
  });

  test("the committed pin supplies the URL, digest, cache and testFFI path", () => {
    const cfg = resolveLinuxRelease();
    expect(cfg.webkitVersion).toBe(WEBKIT_VERSION);
    expect(WEBKIT_VERSION).toMatch(/^[a-f0-9]{40}$/);
    const artifact = webkitArtifact(cfg);
    const source = webkit.source(cfg);
    if (source.kind !== "prebuilt") throw new Error("expected prebuilt source");
    expect(source.url).toBe(artifact.url);
    expect(source.sha256).toBe(artifact.sha256);
    expect(source.destDir).toEndWith(`webkit-sha256-${artifact.sha256}`);
    expect(dirname(dirname(webkitTestFFIPath(cfg)))).toBe(source.destDir);
    const ninja = new Ninja({ buildDir: cfg.buildDir });
    registerDepRules(ninja, cfg);
    resolveDep(ninja, cfg, webkit, new Map());
    const encoded = /^  url = (.*)$/m.exec(ninja.toString())![1]!;
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(Buffer.from(encoded, "base64url").toString("utf8")).toBe(source.url);
    expect(ninja.toString()).toContain(`sha256 = ${artifact.sha256}`);
  });

  test.each([
    [{}, "linux-amd64"],
    [{ lto: true }, "linux-amd64-lto"],
    [{ buildType: "Debug", asan: false }, "linux-amd64-debug"],
    [{ buildType: "Debug", asan: true }, "linux-amd64-debug-asan"],
    [{ asan: true }, "linux-amd64-asan"],
    [{ abi: "musl" }, "linux-amd64-musl"],
    [{ arch: "aarch64" }, "linux-arm64"],
    [{ os: "darwin", arch: "aarch64" }, "macos-arm64"],
    [{ os: "windows", abi: "msvc" }, "windows-amd64"],
    [{ os: "windows", abi: "msvc", arch: "aarch64" }, "windows-arm64"],
  ] as [PartialConfig, string][])("selects the exact ABI variant %j", (partial, target) => {
    using sysroot = tempDir("webkit-sysroot", { "usr/lib/libc.so": "", "usr/include/sys/syscall.h": "" });
    const previous = process.env.LINUX_MUSL_SYSROOT;
    try {
      process.env.LINUX_MUSL_SYSROOT = String(sysroot);
      const name = `bun-webkit-${target}.tar.gz`;
      const pin = fixture(name);
      expect(webkitArtifact(resolveLinuxRelease({ ...partial, macosSdk: String(sysroot) }), pin)).toEqual(
        pin.artifacts[name],
      );
    } finally {
      if (previous === undefined) delete process.env.LINUX_MUSL_SYSROOT;
      else process.env.LINUX_MUSL_SYSROOT = previous;
    }
  });

  test("missing variants, invalid digests, alternate pins and upstream URLs are hard errors", () => {
    const name = "bun-webkit-linux-amd64.tar.gz";
    const cfg = resolveLinuxRelease();
    expect(() => webkitArtifact(cfg, { version: WEBKIT_VERSION, artifacts: {} })).toThrow("Missing SHA-256");
    expect(() => webkitArtifact(cfg, fixture(name, "invalid"))).toThrow("Missing SHA-256");
    expect(() => webkitArtifact(resolveLinuxRelease({ webkitVersion: "0".repeat(40) }), fixture(name))).toThrow(
      "update the manifest and pin together",
    );
    for (const url of [
      `https://github.com/oven-sh/WebKit/releases/download/autobuild-${WEBKIT_VERSION}/${name}`,
      "http://github.com/openclaw/WebKit/releases/download/archive.tar.gz",
      "https://user:password@github.com/openclaw/WebKit/archive.tar.gz",
    ]) {
      const pin = fixture(name);
      pin.artifacts[name]!.url = url;
      expect(() => webkitArtifact(cfg, pin)).toThrow("pinned OpenClaw release URL");
    }
  });
});
