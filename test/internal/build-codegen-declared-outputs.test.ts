/**
 * The bindgen step in scripts/build/codegen.ts has to declare every file its
 * script writes, the Generated*.h headers included, not only the .cpp files
 * that get compiled.
 *
 * Compiles only order-depend on codegen; the compiler's depfile is what rebuilds
 * a TU when a generated header changes, and within one build ninja re-checks a
 * depfile entry after the step that writes it only if the entry is a declared
 * output of that step. A header no edge declares is stat'd once at startup, so
 * a TU including one (BunObject.cpp includes GeneratedBunObject.h) was
 * recompiled by the build AFTER the one that regenerated the header, and the
 * first build linked the stale object against the fresh generated code.
 *
 * The step is checked twice: what its emitter declares, and what its script
 * writes when run for real into a scratch dir.
 */
import { describe, expect, test } from "bun:test";
import { bunEnv, bunExe, isWindows, tempDir } from "harness";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

import { emitBindgen, emitCodegen, registerCodegenRules, type CodegenOutputs } from "../../scripts/build/codegen.ts";
import { cxx, pch, registerCompileRules, registerDirStamps } from "../../scripts/build/compile.ts";
import { resolveConfig, type Config, type Toolchain } from "../../scripts/build/config.ts";
import { Ninja, readManifest } from "../../scripts/build/ninja.ts";
import { quote, quoteArgs } from "../../scripts/build/shell.ts";
import type { Sources } from "../../scripts/glob-sources.ts";

/** A fully-populated fake toolchain. */
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
    bun: bunExe(),
    // A shell command prefix, quoted like the one configure makes.
    jsRuntime: quote(bunExe(), process.platform === "win32"),
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

interface Configured {
  cfg: Config;
  n: Ninja;
  o: CodegenOutputs;
  dirStamp: string;
}

/**
 * A linux-x64 debug target in `buildDir` (resolves on every host once told where
 * its sysroot is; the path is only recorded), with the rules the codegen
 * emitters reference registered and the empty output groups emitCodegen hands
 * them. Nothing is written to `buildDir`.
 */
function configure(buildDir: string): Configured {
  const cfg = resolveConfig(
    { os: "linux", arch: "x64", abi: "gnu", buildType: "Debug", buildDir, linuxSysroot: buildDir },
    mockToolchain(),
  );
  const n = new Ninja({ buildDir });
  registerDirStamps(n, cfg);
  registerCodegenRules(n, cfg);
  const o: CodegenOutputs = {
    all: [],
    generatedTypes: [],
    rustInputs: [],
    cppSources: [],
    builtinTableSources: [],
    cppHeaders: [],
    cppAll: [],
    internalModulesAsm: resolve(cfg.codegenDir, "InternalModuleRegistryConstants.S"),
    internalModulesBin: resolve(cfg.codegenDir, "InternalModuleRegistryConstants.bin"),
    rootInstall: resolve(buildDir, "stamps", "install.stamp"),
  };
  return { cfg, n, o, dirStamp: resolve(cfg.codegenDir, ".dir") };
}

/** Just the lists the emitter under test reads; it never looks at the rest of `Sources`. */
function sourceLists(lists: Partial<Sources>): Sources {
  return lists as Sources;
}

/**
 * The outputs of the `build` line in `n` that produces `output`, spelled as in
 * build.ninja (buildDir-relative), sorted. Ninja.build() also declares every
 * build-dir output under its absolute path (so depfile entries resolve to the
 * edge); those aliases are checked to be exactly the relative set and dropped.
 */
function edgeOutputs(n: Ninja, output: string): string[] {
  for (const edge of readManifest(n.toString()).edges) {
    if (!edge.outputs.includes(n.rel(output))) continue;
    const outputs = [...edge.outputs, ...edge.implicitOutputs];
    const relative = outputs.filter(o => !isAbsolute(o)).sort();
    const aliases = outputs.filter(o => isAbsolute(o)).sort();
    expect(aliases).toEqual(relative.map(o => resolve(n.buildDir, o)).sort());
    return relative;
  }
  throw new Error(`no build edge produces ${output}`);
}

/** `names` in the codegen dir, spelled as in build.ninja, sorted. */
function inCodegenDir({ cfg, n }: Configured, names: string[]): string[] {
  return names.map(name => n.rel(resolve(cfg.codegenDir, name))).sort();
}

/** `paths` normalized, sorted. */
function normalized(paths: string[]): string[] {
  return paths.map(p => resolve(p)).sort();
}

/**
 * Every .bind.ts under src/: the pattern glob-sources.ts expands for
 * emitBindgen (through node:fs globSync, which is too slow under a debug
 * build to run its whole pattern set here).
 */
function repoBindFiles(cfg: Config): string[] {
  return Array.from(new Bun.Glob("src/**/*.bind.ts").scanSync({ cwd: cfg.cwd }), p => resolve(cfg.cwd, p)).sort();
}

// The tests below that run a generator script run it under the build being
// tested; a debug build takes a few seconds to load one, more than the 5s
// default allows for.
const generatorTimeout = 60_000;

test.skipIf(isWindows || Bun.which("ninja") === null)(
  "include paths stay intact in shell commands and raw in the compilation database",
  async () => {
    using dir = tempDir("build-include-paths", {
      "probe.ts": "console.log(JSON.stringify(process.argv.slice(2)));",
      "source.cpp": "",
      "header.h": "",
    });
    const root = String(dir);
    const cxxTool = resolve(root, "compiler 'quoted' path");
    writeFileSync(cxxTool, `#!/bin/sh\nexec ${quoteArgs([bunExe(), resolve(root, "probe.ts")], false)} "$@"\n`);
    chmodSync(cxxTool, 0o755);
    const { cfg, n } = configure(resolve(root, "build"));
    cfg.cwd = root;
    cfg.cxx = cxxTool;
    registerCompileRules(n, cfg);
    const includes = [resolve(root, "include 'quoted' $literal $(printf expanded)")];
    const opts = { flags: ["-DPROBE=1"], includes };
    const object = cxx(n, cfg, resolve(root, "source.cpp"), opts);
    const header = pch(n, cfg, resolve(root, "header.h"), opts);
    await n.write();
    for (const target of [object, header.pch]) {
      const expanded = Bun.spawnSync(
        [Bun.which("ninja")!, "-f", resolve(cfg.buildDir, "build.ninja"), "-t", "commands", "-s", n.rel(target)],
        { cwd: cfg.buildDir, env: bunEnv },
      );
      expect(expanded.stderr.toString()).toBe("");
      expect(expanded.exitCode).toBe(0);
      const executed = Bun.spawnSync(["/bin/sh", "-c", expanded.stdout.toString()], {
        cwd: cfg.buildDir,
        env: bunEnv,
      });
      expect(executed.stderr.toString()).toBe("");
      const args: string[] = JSON.parse(executed.stdout.toString());
      expect(args.filter(arg => arg.startsWith("-I"))).toEqual([`-I${includes[0]}`]);
      expect(executed.exitCode).toBe(0);
    }
    const database = JSON.parse(readFileSync(resolve(cfg.buildDir, "compile_commands.json"), "utf8"));
    expect(database).toHaveLength(1);
    expect(database[0].arguments).toContain(`-I${includes[0]}`);
  },
);

test.skipIf(isWindows || Bun.which("ninja") === null)("codegen rules preserve shell paths and stamp outputs", () => {
  using dir = tempDir("build-codegen-shell", {
    "probe.ts": `console.log(JSON.stringify({args: process.argv.slice(2), cwd: process.cwd()}));`,
  });
  const root = String(dir);
  const tricky = "space 'quoted' $literal $(printf expanded)";
  const source = resolve(root, "source 'quoted' path");
  const buildDir = resolve(root, "build " + tricky);
  const executable = resolve(root, "tool 'quoted' path");
  const runtime = quoteArgs([bunExe(), resolve(root, "probe.ts")], false);
  writeFileSync(executable, `#!/bin/sh\nexec ${runtime} "$@"\n`);
  chmodSync(executable, 0o755);
  for (const pkg of [source, resolve(source, "packages/bun-error"), resolve(source, "src/node-fallbacks")]) {
    mkdirSync(pkg, { recursive: true });
    writeFileSync(resolve(pkg, "package.json"), JSON.stringify({ dependencies: { fixture: "1.0.0" } }));
  }

  for (const packageManager of ["bun", "npm"] as const) {
    const cfg = {
      ...configure(buildDir).cfg,
      cwd: source,
      codegenDir: resolve(buildDir, "codegen " + tricky),
      typesDir: resolve(buildDir, "types " + tricky),
      bun: executable,
      esbuild: executable,
      npm: executable,
      jsRuntime: runtime,
      packageManager,
    };
    const n = new Ninja({ buildDir: root });
    registerDirStamps(n, cfg);
    registerCodegenRules(n, cfg);
    const fallback = resolve(source, "src/node-fallbacks/fallback.js");
    const o = emitCodegen(
      n,
      cfg,
      sourceLists({
        bunError: [],
        nodeFallbacks: [fallback],
        stringMaps: [],
        lintRuleDocs: [],
        rust: [],
        cxx: [],
        jsCodegen: [],
        js: [],
        removableFeatures: [],
        bakeRuntime: [],
        bindgen: [],
        bindgenCodegen: [],
      }),
    );
    const file = resolve(root, "build.ninja");
    writeFileSync(file, n.toString());
    const cases: { target: string; cwd?: string; args?: string[]; stamp?: string }[] = [
      ...["obj/.dir", "pch/.dir", "stamps/.dir"].map(path => ({
        target: resolve(buildDir, path),
        stamp: resolve(buildDir, path),
      })),
      { target: resolve(cfg.codegenDir, ".dir"), stamp: resolve(cfg.codegenDir, ".dir") },
      {
        target: resolve(cfg.codegenDir, "removable-features.json"),
        cwd: source,
        args: ["run", resolve(source, "src/codegen/generate-removable-features.ts"), source, cfg.codegenDir],
      },
      {
        target: o.rootInstall,
        cwd: packageManager === "bun" ? source : root,
        args:
          packageManager === "bun"
            ? ["install", "--frozen-lockfile"]
            : [resolve(source, "scripts/build/npm-ci.ts"), executable, source],
        stamp: o.rootInstall,
      },
      {
        target: resolve(cfg.codegenDir, "ErrorCode+List.h"),
        cwd: source,
        args: [resolve(source, "src/codegen/generate-node-errors.ts"), cfg.codegenDir, cfg.typesDir],
      },
      {
        target: resolve(cfg.codegenDir, "bun-error/index.js"),
        cwd: resolve(source, "packages/bun-error"),
        args: [
          "index.tsx",
          "bun-error.css",
          `--outdir=${resolve(cfg.codegenDir, "bun-error")}`,
          '--define:process.env.NODE_ENV="production"',
          "--minify",
          "--bundle",
          "--platform=browser",
          "--format=esm",
        ],
      },
      {
        target: resolve(cfg.codegenDir, "node-fallbacks/fallback.js"),
        cwd: resolve(source, "src/node-fallbacks"),
        args: ["run", "build-fallbacks", resolve(cfg.codegenDir, "node-fallbacks"), fallback],
      },
    ];
    for (const item of cases) {
      const expanded = Bun.spawnSync([Bun.which("ninja")!, "-f", file, "-t", "commands", "-s", n.rel(item.target)], {
        cwd: root,
        env: bunEnv,
      });
      expect(expanded.stderr.toString()).toBe("");
      expect(expanded.exitCode).toBe(0);
      const executed = Bun.spawnSync(["/bin/sh", "-c", expanded.stdout.toString()], { cwd: root, env: bunEnv });
      expect(executed.stderr.toString()).toBe("");
      if (item.args) {
        expect(JSON.parse(executed.stdout.toString())).toEqual({ args: item.args, cwd: item.cwd });
      } else {
        expect(executed.stdout.toString()).toBe("");
      }
      expect(executed.exitCode).toBe(0);
      if (item.stamp) expect(existsSync(item.stamp)).toBe(true);
    }
  }
});

describe("emitBindgen", () => {
  test("declares a .cpp and a .h per .bind.ts, the tables, a .rs per crate and the .d.ts, on one edge", () => {
    using dir = tempDir("build-codegen-bindgen", {});
    const c = configure(String(dir));
    const { cfg, n, o, dirStamp } = c;
    const bindgen = [
      resolve(cfg.cwd, "src", "runtime", "node", "node_os.bind.ts"),
      resolve(cfg.cwd, "src", "jsc", "fmt_jsc.bind.ts"),
    ];

    emitBindgen({ n, cfg, sources: sourceLists({ bindgen, bindgenCodegen: [] }), o, dirStamp });

    const inDir = (name: string) => resolve(cfg.codegenDir, name);
    const cpp = ["GeneratedFmtJsc.cpp", "GeneratedNodeOs.cpp"].map(inDir);
    const headers = [
      "GeneratedBindings+Classes.h",
      "GeneratedBindings+Counts.h",
      "GeneratedBindings+Tables.h",
      "GeneratedFmtJsc.h",
      "GeneratedNodeOs.h",
    ].map(inDir);
    const rust = ["generated_bindgen_bun_jsc.rs", "generated_bindgen_bun_runtime.rs"].map(inDir);
    const types = resolve(cfg.typesDir, "Bindgen.d.ts");
    expect(edgeOutputs(n, cpp[0])).toEqual([...cpp, ...headers, ...rust, types].map(p => n.rel(p)).sort());
    expect(normalized(o.cppSources)).toEqual(cpp);
    expect(normalized(o.cppHeaders)).toEqual(headers);
    expect(normalized(o.rustInputs)).toEqual(rust);
    expect(o.generatedTypes).toEqual([types]);
    expect(normalized(o.all)).toEqual(normalized([...cpp, ...headers, ...rust, types]));
  });

  test.concurrent(
    "declares exactly the files bindgen.ts writes for the repo's .bind.ts files",
    async () => {
      using dir = tempDir("build-codegen-bindgen-generate", {});
      const c = configure(String(dir));
      const { cfg, n, o, dirStamp } = c;
      cfg.typesDir = resolve(String(dir), "types");
      const bindgen = repoBindFiles(cfg);
      expect(bindgen).not.toBeEmpty();

      emitBindgen({ n, cfg, sources: sourceLists({ bindgen, bindgenCodegen: [] }), o, dirStamp });

      const edge = readManifest(n.toString()).edges.find(edge =>
        edge.outputs.includes(n.rel(resolve(cfg.typesDir, "Bindgen.d.ts"))),
      )!;
      const command = `${cfg.jsRuntime} ${edge.bindings.args}`;
      await using proc = Bun.spawn(isWindows ? ["cmd", "/c", command] : ["/bin/sh", "-c", command], {
        cwd: cfg.cwd,
        env: bunEnv,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
      expect(stdout).toBe("");
      expect(stderr).toBe("");
      expect(exitCode).toBe(0);

      const written = readdirSync(cfg.codegenDir).sort();
      const declared = edgeOutputs(n, resolve(cfg.codegenDir, "GeneratedBindings+Tables.h"));
      expect(declared.filter(p => p !== n.rel(resolve(cfg.typesDir, "Bindgen.d.ts")))).toEqual(
        inCodegenDir(c, written),
      );
      expect(readdirSync(cfg.typesDir)).toEqual(["Bindgen.d.ts"]);
    },
    generatorTimeout,
  );
});
