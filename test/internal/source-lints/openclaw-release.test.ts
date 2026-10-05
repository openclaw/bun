// The OpenClaw fork's release pipeline (scripts/openclaw-release/release.ts):
// tag names, the slice of the upstream build image it provisions, and the
// manifest and checksums it publishes. The workflow's own run is what shows a
// build works.
import { expect, test } from "bun:test";
import { tempDir } from "harness";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { generateImage, imageKey, images } from "../../../scripts/build/ci-images/spec.ts";
import { computeBunTriplet } from "../../../scripts/build/ci.ts";
import type { Config } from "../../../scripts/build/config.ts";
import {
  checksums,
  formatTag,
  manifest,
  matrix,
  parseTag,
  parseWebkitVersion,
  provisionScript,
  releaseNotes,
  releaseTargets,
  sectionsFor,
  sha256File,
  splitBootstrap,
  tagFor,
  tagMismatches,
  targets,
  webkitTagPart,
  windowsSignerSubject,
  zip,
  type SourceFacts,
  type TargetName,
  type WindowsSigning,
} from "../../../scripts/openclaw-release/release.ts";

const facts: SourceFacts = {
  commit: "9e3414b3f7a39a71217bedb4aebd9e33460fcf31",
  date: "20260925",
  version: "1.4.3",
  webkitVersion: "35e8970dfd926abf6661c9d356f5d60d8f611c9b",
};

test("a tag names the version, commit date, commit and WebKit revision, and parses back", () => {
  const tag = tagFor(facts);
  expect(tag).toBe("openclaw-v1.4.3-20260925-9e3414b3f7-webkit-35e8970dfd");
  expect(parseTag(tag)).toEqual({ version: "1.4.3", date: "20260925", commit: "9e3414b3f7", webkit: "35e8970dfd" });
  expect(tagFor(facts, 2)).toBe(`${tag}-r2`);
  expect(parseTag(`${tag}-r2`).rebuild).toBe(2);
  expect(formatTag(parseTag(`${tag}-r12`))).toBe(`${tag}-r12`);
  expect(tagMismatches(tag, facts)).toEqual([]);
});

test("a tag that disagrees with its commit is refused, with every disagreement named", () => {
  expect(() => parseTag("openclaw-ci-ddfce5d0-webkit-4429d113")).toThrow("is not a release tag");
  expect(() => parseTag("openclaw-v1.4.3-20260925-9e3414b3f7-webkit-35e8970dfd-r1")).toThrow("is not a release tag");
  const problems = tagMismatches("openclaw-v1.4.2-20260924-9e3414b3f8-webkit-4429d11361", facts);
  expect(problems).toHaveLength(4);
  expect(problems.join("\n")).toContain("pins 35e8970dfd926abf6661c9d356f5d60d8f611c9b");
});

test("the WebKit part of a tag is the previewed commit of a preview build", () => {
  expect(webkitTagPart("autobuild-preview-pr-578-caa5d805")).toBe("caa5d805");
  expect(tagFor({ ...facts, webkitVersion: "autobuild-preview-pr-578-caa5d805" })).toEndWith("-webkit-caa5d805");
  expect(parseWebkitVersion(JSON.stringify({ version: facts.webkitVersion }))).toBe(facts.webkitVersion);
  expect(
    parseWebkitVersion(
      readFileSync(join(import.meta.dir, "../../../scripts/build/deps/webkit-artifacts.json"), "utf8"),
    ),
  ).toMatch(/^[0-9a-f]{40}$|^autobuild-/);
});

test("the zips carry upstream's artifact names", () => {
  for (const t of Object.values(targets)) {
    const cfg = { os: t.os, arch: t.buildArch, abi: t.os === "linux" ? t.abi : undefined } as Config;
    expect(t.triplet).toBe(computeBunTriplet(cfg));
  }
  expect(releaseTargets).toEqual([
    "darwin-arm64",
    "darwin-x64",
    "linux-x64",
    "linux-arm64",
    "windows-x64",
    "windows-arm64",
  ]);
  expect(matrix(["windows-x64", "windows-arm64"]).map(t => t.artifact)).toEqual([
    "test-only-windows",
    "test-only-windows",
  ]);
  expect(matrix(["windows-arm64"], true)[0]).toEqual({
    target: "windows-arm64",
    triplet: "bun-windows-aarch64",
    runner: "windows-11-arm",
    container: "",
    artifact: "signed-windows",
  });
  expect(matrix(["darwin-x64", "linux-arm64"])).toEqual([
    {
      target: "darwin-x64",
      triplet: "bun-darwin-x64",
      runner: "macos-15-intel",
      container: "",
      artifact: "signed-darwin-x64",
    },
    {
      target: "linux-arm64",
      triplet: "bun-linux-aarch64",
      runner: "ubuntu-24.04-arm",
      container: "",
      artifact: "build-linux-arm64",
    },
  ]);
});

test("Windows manifest binds signature receipts to final archive and executable bytes", () => {
  using dir = tempDir("openclaw-windows-manifest", {});
  const dist = String(dir);
  const records: Record<string, WindowsSigning> = {};
  for (const name of releaseTargets) {
    const t = targets[name];
    const file = join(dist, t.exe);
    writeFileSync(file, `${name} executable`);
    zip(join(dist, `${t.triplet}.zip`), t.triplet, [file], 1790353014);
    if (t.os !== "windows") continue;
    const profile = join(dist, "bun-profile.exe");
    writeFileSync(profile, `${name} profile executable`);
    zip(join(dist, `${t.triplet}-profile.zip`), `${t.triplet}-profile`, [profile], 1790353014);
    records[name] = {
      authenticodeSigned: true,
      signerSubject: windowsSignerSubject,
      executableSha256: sha256File(file),
      profileExecutableSha256: sha256File(profile),
      archiveSha256: sha256File(join(dist, `${t.triplet}.zip`)),
      profileArchiveSha256: sha256File(join(dist, `${t.triplet}-profile.zip`)),
    };
  }
  const input = { tag: tagFor(facts), repository: "openclaw/bun", facts, dist, signing: {} };
  const unsigned = manifest(input).assets.filter(a => a.os === "windows");
  expect(unsigned.map(a => [a.executable.authenticodeSigned, a.executable.testOnly])).toEqual([
    [false, true],
    [false, true],
  ]);
  expect(() => manifest({ ...input, publish: true })).toThrow("release requires Authenticode");
  const signed = manifest({ ...input, windowsSigning: records, publish: true });
  expect(
    signed.assets
      .filter(a => a.os === "windows")
      .map(a => [a.executable.authenticodeSigned, a.executable.signerSubject, a.executable.testOnly]),
  ).toEqual([
    [true, windowsSignerSubject, false],
    [true, windowsSignerSubject, false],
  ]);
  for (const key of ["executableSha256", "profileExecutableSha256", "archiveSha256", "profileArchiveSha256"]) {
    const changed = { ...records, "windows-arm64": { ...records["windows-arm64"]!, [key]: "0".repeat(64) } };
    expect(() => manifest({ ...input, windowsSigning: changed, publish: true })).toThrow("receipt does not match");
  }
  expect(() =>
    manifest({
      ...input,
      windowsSigning: { ...records, "windows-arm64": { ...records["windows-arm64"]!, signerSubject: "CN=Other" } },
      publish: true,
    }),
  ).toThrow("unexpected Authenticode signer");
});

test("the upstream build image still has every section the pipeline provisions", () => {
  using dir = tempDir("openclaw-release-image", {});
  const image = images.find(image => imageKey(image) === "linux-aarch64-debian")!;
  const { directory } = generateImage(image, String(dir));
  const bootstrap = readFileSync(join(directory, "bootstrap.sh"), "utf8");
  const all = sectionsFor(Object.keys(targets) as TargetName[]);
  const script = provisionScript(bootstrap, all);
  expect([...script.matchAll(/^# ---- (\S+)$/gm)].map(m => m[1])).toEqual(
    [...splitBootstrap(bootstrap).sections.keys()].filter(name => all.includes(name)),
  );
  expect(script.startsWith(splitBootstrap(bootstrap).header)).toBe(true);
  expect(sectionsFor(["linux-x64"])).not.toContain("macos-sdk");
  expect(() => provisionScript(bootstrap, ["packages", "no-such-tool"])).toThrow("has no section no-such-tool");
});

test("the manifest pins each archive and the executable inside it", () => {
  using dir = tempDir("openclaw-release-manifest", {});
  const dist = join(String(dir), "dist");
  mkdirSync(dist);
  const exe = (name: string, body: string) => {
    const path = join(String(dir), name);
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, "bun"), body);
    return join(path, "bun");
  };
  const mtime = 1790353014;
  zip(join(dist, "bun-linux-aarch64.zip"), "bun-linux-aarch64", [exe("linux", "linux executable")], mtime);
  zip(join(dist, "bun-darwin-aarch64.zip"), "bun-darwin-aarch64", [exe("darwin", "darwin executable")], mtime);

  const tag = tagFor(facts);
  const m = manifest({
    tag,
    repository: "openclaw/bun",
    facts,
    dist,
    signing: { "darwin-arm64": { kind: "developer-id", teamId: "FWJYW4S8P8", notarized: true } },
  });
  expect(m.assets.map(a => a.target)).toEqual(["darwin-arm64", "linux-arm64"]);
  const linux = m.assets.find(a => a.target === "linux-arm64")!;
  expect(linux.url).toBe(`https://github.com/openclaw/bun/releases/download/${tag}/bun-linux-aarch64.zip`);
  expect(linux.sha256).toBe(sha256File(join(dist, "bun-linux-aarch64.zip")));
  expect(linux.executable).toEqual({
    path: "bun-linux-aarch64/bun",
    size: 16,
    sha256: new Bun.CryptoHasher("sha256").update("linux executable").digest("hex"),
  });
  expect(linux.libc).toBe("glibc");
  expect(linux).not.toHaveProperty("signing");
  expect(m.assets[0]!.signing).toEqual({ kind: "developer-id", teamId: "FWJYW4S8P8", notarized: true });
  expect(m.webkit.version).toBe(facts.webkitVersion);
  expect(releaseNotes(m)).not.toContain("ad-hoc");
  const adhoc = manifest({ tag, repository: "openclaw/bun", facts, dist, signing: {} });
  expect(adhoc.assets[0]!.signing).toEqual({ kind: "adhoc", notarized: false });
  expect(releaseNotes(adhoc)).toContain("`darwin-arm64` is not signed with a Developer ID or notarized");
  expect(m.bun.commit).toBe(facts.commit);

  // Same inputs, same bytes: the zips have fixed mtimes.
  const again = join(String(dir), "again.zip");
  zip(again, "bun-linux-aarch64", [join(String(dir), "linux", "bun")], mtime);
  expect(sha256File(again)).toBe(linux.sha256);

  const sums = checksums([join(dist, "bun-linux-aarch64.zip"), join(dist, "bun-darwin-aarch64.zip")]);
  expect(
    sums
      .trim()
      .split("\n")
      .map(line => line.slice(66)),
  ).toEqual(["bun-darwin-aarch64.zip", "bun-linux-aarch64.zip"]);
  expect(sums).toContain(`${linux.sha256}  bun-linux-aarch64.zip`);
});
