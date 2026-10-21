import { afterAll, describe, expect, test } from "bun:test";
import { appendFileSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { bunEnv, bunExe, isASAN, isDebug, normalizeBunSnapshot, tempDir } from "harness";
import { join } from "path";
import { built, slot, spawned, told, unsupported } from "./run-programs";

const host = join(import.meta.dir, "typed-packages", "react-reconciler-host");
const typedVersion = join(import.meta.dir, "..", "..", "packages", "bun-sound", "react-reconciler", "0.33.0", "lay");
const typedFile = "node_modules/react-reconciler/cjs/react-reconciler.production.ts";
const flags = ["--define", `process.env.NODE_ENV="production"`, "--outfile", "app"];

describe.skipIf(!!unsupported)("compile/aot/typed-packages", () => {
  const folders: string[] = [];
  afterAll(() => folders.forEach(folder => rmSync(folder, { recursive: true, force: true })));

  test("boundary-limit retries finish and preserve fallback warnings with one and four workers", () => slot(async () => {
    const keys = Array.from({ length: 256 }, (_, i) => `"k${i}"`).join(" | ");
    using folder = tempDir("aot-boundary-retry-tail", {
      "tsconfig.json": JSON.stringify({
        compilerOptions: { strict: true, allowJs: true, checkJs: false, target: "ESNext", module: "Preserve", moduleResolution: "Bundler", types: [], noEmit: true },
      }),
      "types.ts": `export type Key = ${keys};
export type Table = { [P in Key]: { [Q in Key]: { source: P; destination: Q; payload: { text: string } } } };`,
      "api0.ts": `import type { Table } from "./types.ts"; export function consume(table: Table): string { return table.k0.k0.payload.text; }`,
      "api1.ts": `import type { Table } from "./types.ts"; export function consume(table: Table): string { return table.k0.k0.payload.text; }`,
      "bridge.js": `import { consume as f0 } from "./api0.ts";
import { consume as f1 } from "./api1.ts";
export const functions = [f0, f1];`,
      "extra.ts": `export interface Simple { value: number; }
type Permutation<T, K = T> = [T] extends [never] ? [] : K extends K ? [K, ...Permutation<Exclude<T, K>>] : never;
export type Unused = Permutation<"a" | "b" | "c" | "d" | "e"> | { done: true };`,
      "main.ts": `import "./bridge.js"; import type { Simple } from "./extra.ts"; export const loaded: Simple = { value: 1 };`,
    });
    const cwd = String(folder);
    const expectedWarnings = [0, 1].map(i =>
      `warning TS100011: '<dir>/api${i}.ts' is compiled untyped, which costs speed, not correctness: too many types cross between it and untyped code through 'Table' at bridge.js:3 to analyze. [untyped-file]`,
    );
    for (const threads of [1, 4]) {
      await using checked = Bun.spawn({
        cmd: [bunExe(), "check", "--aot", `--threads=${threads}`, "--no-pretty", "main.ts"],
        cwd,
        env: bunEnv,
        stdout: "pipe",
        stderr: "pipe",
        timeout: isASAN || isDebug ? 90_000 : 30_000,
        killSignal: "SIGKILL",
      });
      const [stdout, stderr, exitCode] = await Promise.all([checked.stdout.text(), checked.stderr.text(), checked.exited]);
      expect({ signal: checked.signalCode, exitCode }).toEqual({ signal: null, exitCode: 0 });
      expect(normalizeBunSnapshot(stdout, cwd).split(/\r?\n/)).toEqual(expectedWarnings);
      expect(stderr).toContain("No type errors in 6 files");
    }
  }), isASAN || isDebug ? 185_000 : 65_000);

  function project(name: string) {
    const folder = String(tempDir(name, {}));
    folders.push(folder);
    for (const file of ["main.ts", "with-look-alikes.ts", "modules.d.ts", "tsconfig.json"]) cpSync(join(host, file), join(folder, file));
    mkdirSync(join(folder, "node_modules"));
    for (const name of ["react", "scheduler"]) cpSync(join(host, "stand-ins", name), join(folder, "node_modules", name), { recursive: true });
    cpSync(typedVersion, join(folder, "node_modules", "react-reconciler"), { recursive: true });
    writeFileSync(join(folder, "node_modules", "react-reconciler", "package.json"), JSON.stringify({ name: "react-reconciler", version: "0.33.0", main: "index.js" }));
    return folder;
  }

  function compiledOf(map: string, file: string) {
    const found = { typed: { bytes: 0, names: new Set<string>() }, untyped: { bytes: 0, names: new Set<string>() } };
    for (const line of readFileSync(map, "utf8").split("\n")) {
      const fields = line.split("\t");
      if (fields[0] !== "F" || fields[10] !== file || fields[8] === "module") continue;
      const kind = fields[8].includes("untyped") ? found.untyped : found.typed;
      kind.bytes += Number(fields[3]);
      kind.names.add(fields[7]);
    }
    return found;
  }
  const hot = [
    "beginWork",
    "completeWork",
    "bubbleProperties",
    "createWorkInProgress",
    "markUpdateLaneFromFiberToRoot",
    "getRootForUpdatedFiber",
    "propagateParentContextChanges",
    "propagateContextChanges",
    "checkIfContextChanged",
    "areHookInputsEqual",
    "updateWorkInProgressHook",
    "renderWithHooks",
    "commitRoot",
    "commitMutationEffectsOnFiber",
    "commitHookEffectListMount",
    "commitHookEffectListUnmount",
  ];
  function expectTyped(map: string) {
    const { typed, untyped } = compiledOf(map, typedFile);
    expect(typed.bytes).toBeGreaterThan(200_000);
    expect(untyped.bytes).toBeLessThan(typed.bytes / 50);
    expect(hot.filter(name => !typed.names.has(name) || untyped.names.has(name))).toEqual([]);
  }

  test("the typed react-reconciler is compiled typed", () =>
    slot(async () => {
      const folder = project("aot-typed-reconciler");
      const map = join(folder, "app.map");
      const build = await spawned([bunExe(), "build", "--compile", "--aot", ...flags, "main.ts"], folder, { ...bunEnv, BUN_JSC_aotMapFilePath: map });
      built(build);
      expect(build.stdout + build.stderr).not.toContain("compiled untyped");
      expectTyped(map);
      const compiled = await spawned([join(folder, "app")], folder, { ...bunEnv, BUN_JSC_crashIfInterpreterIsUsed: "1" });
      expect(compiled.signal).toBeNull();
      const plain = await spawned([bunExe(), "run", "main.ts"], folder, bunEnv);
      expect({ signal: plain.signal, exitCode: plain.exitCode }).toEqual({ signal: null, exitCode: 0 });
      expect(plain.stdout).toContain("commit <root><app>count 4<list 1,3>");
      expect(told(compiled)).toEqual(told(plain));
    }), 600_000);

  const typesInstalled: Record<string, (folder: string) => object> = {
    "a bun-types that lacks int32": folder => {
      const types = join(folder, "node_modules", "@types", "bun");
      mkdirSync(types, { recursive: true });
      writeFileSync(join(types, "package.json"), JSON.stringify({ name: "@types/bun", version: "1.0.0", types: "index.d.ts" }));
      writeFileSync(join(types, "index.d.ts"), `declare module "bun" { function inspect(value: unknown): string; }\n`);
      return { types: ["bun"] };
    },
    "the bun-types of this repository": () => ({ typeRoots: [join(import.meta.dir, "..", "..", "packages")], types: ["bun-types"] }),
  };
  for (const [world, install] of Object.entries(typesInstalled))
    test(`the typed react-reconciler is compiled typed with ${world}`, () =>
      slot(async () => {
        expect(readFileSync(join(typedVersion, "cjs", "react-reconciler.production.ts"), "utf8")).toContain(`type int32 = import("bun").int32;`);
        const folder = project("aot-typed-reconciler-types");
        const options = JSON.parse(readFileSync(join(folder, "tsconfig.json"), "utf8"));
        Object.assign(options.compilerOptions, install(folder));
        writeFileSync(join(folder, "tsconfig.json"), JSON.stringify(options));
        const map = join(folder, "app.map");
        const build = await spawned([bunExe(), "build", "--compile", "--aot", ...flags, "main.ts"], folder, { ...bunEnv, BUN_JSC_aotMapFilePath: map });
        built(build);
        expect(build.stdout + build.stderr).not.toContain("compiled untyped");
        expectTyped(map);
      }), 600_000);

  test("the reconciler runs as plain Bun beside look-alikes of its records", () =>
    slot(async () => {
      const folder = project("aot-typed-reconciler-look-alikes");
      const build = await spawned([bunExe(), "build", "--compile", "--aot", ...flags, "with-look-alikes.ts"], folder, bunEnv);
      built(build);
      expect(build.stdout + build.stderr).not.toContain("compiled untyped");
      const compiled = await spawned([join(folder, "app")], folder, { ...bunEnv, BUN_JSC_crashIfInterpreterIsUsed: "1" });
      expect(compiled.signal).toBeNull();
      expect(told(compiled)).toEqual(told(await spawned([bunExe(), "run", "with-look-alikes.ts"], folder, bunEnv)));
    }), 600_000);

  // TODO(aot): since `any` held to a record opens it for records of other layouts, all but StackCursor are open: a fifth more instructions an update.
  test.failing("the records that an update walks admit no object from outside, whatever the program is given", () =>
    slot(async () => {
      const folder = project("aot-typed-reconciler-records");
      const build = await spawned([bunExe(), "build", "--compile", "--aot", "--aot-explain=foreign", ...flags, "with-look-alikes.ts"], folder, bunEnv);
      built(build);
      const open = (build.stdout + build.stderr).split("\n").flatMap(line => /^aot: foreign: ([A-Za-z]+):/.exec(line)?.[1] ?? []);
      expect(open).toContain("ConcurrentQueue");
      const walked = ["Fiber", "FiberRoot", "Hook", "HookQueue", "Effect", "FunctionComponentUpdateQueue", "Update", "UpdateQueue", "SharedQueue", "ContextDependency", "StackCursor"];
      expect(walked.filter(name => open.includes(name))).toEqual([]);
    }), 600_000);

  test("a package of TypeScript files that has no typed version falls back to untyped, says why, and the compile line counts it", () =>
    slot(async () => {
      const folder = project("aot-typed-reconciler-falls");
      appendFileSync(join(folder, typedFile), `\nexport const wrong: number = "a string";\n`);
      const map = join(folder, "app.map");
      const build = await spawned([bunExe(), "build", "--compile", "--aot", ...flags, "main.ts"], folder, { ...bunEnv, BUN_JSC_aotMapFilePath: map });
      built(build);
      const said = build.stdout + build.stderr;
      expect(said).toContain("TS100009: 'react-reconciler' has 1 type error,");
      expect(said).toContain("TS2322: Type 'string' is not assignable to type 'number'.");
      expect(said).toMatch(/compile +app(\.exe)? +1 compiled untyped/);
      const { typed, untyped } = compiledOf(map, typedFile);
      expect(untyped.bytes).toBeGreaterThan(typed.bytes * 50);
      const compiled = await spawned([join(folder, "app")], folder, { ...bunEnv, BUN_JSC_crashIfInterpreterIsUsed: "1" });
      expect(compiled.signal).toBeNull();
      expect(told(compiled)).toEqual(told(await spawned([bunExe(), "run", "main.ts"], folder, bunEnv)));
    }), 600_000);
});
