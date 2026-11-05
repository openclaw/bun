// Plugins of `Bun.build` with `compile: { aot: true }`. The compiler is handed what the plugins resolve and load, not what is on the disk:
// each program is built with and without `aot`, and both executables print what is written here. The one built with `aot` is run with
// BUN_JSC_crashIfInterpreterIsUsed=1, which crashes it if any of its code is interpreted.
import { describe, expect, test } from "bun:test";
import { bunEnv, bunExe, isWindows, tempDir } from "harness";
import { join } from "path";
import { slot, spawned, unsupported } from "./harness/commands";

const build = `import plugin from "./plugin";
const result = await Bun.build({ entrypoints: [process.argv[2]], compile: { outfile: process.argv[3], aot: process.argv[4] === "aot" }, plugins: [plugin], throw: false });
for (const log of result.logs) console.log(String(log));
process.exit(result.success ? 0 : 1);
`;

const tsconfig = JSON.stringify({
  compilerOptions: { strict: true, module: "esnext", moduleResolution: "bundler", types: [] },
  include: ["*.ts"],
  exclude: ["build.ts", "plugin.ts"],
});

const cases: Record<string, { files: Record<string, string>; prints: string }> = {
  "a lazy initializer reads the resolved runtime export before the type source is evaluated": {
    files: {
      "package.json": JSON.stringify({ type: "module", sideEffects: false }),
      "tsconfig.json": JSON.stringify({
        compilerOptions: {
          strict: true,
          target: "ESNext",
          module: "ESNext",
          moduleResolution: "bundler",
          noEmit: true,
          allowImportingTsExtensions: true,
          paths: { library: ["./types/diagnostics.ts"] },
        },
        files: ["main.ts"],
      }),
      "main.ts": `import { has } from "./consumer.ts"; console.log(has("runtime")); await import("./types/constant.ts");`,
      "consumer.ts": `import { code } from "library"; const codes = new Set([code]); export function has(value: string): boolean { return codes.has(value); }`,
      "types/diagnostics.ts": `export { code } from "./constant.ts";`,
      "types/constant.ts": `export const code: string = "type source";`,
      "runtime/diagnostics.ts": `export { code } from "./constant.ts";`,
      "runtime/constant.ts": `export const code: string = "runtime";`,
      "plugin.ts": `import { join } from "path"; export default { name: "runtime-library", setup(b: any) { b.onResolve({ filter: /^library$/ }, () => ({ path: join(import.meta.dir, "runtime/diagnostics.ts") })); } };`,
    },
    prints: "true\n",
  },
  ...Object.fromEntries(
    [false, true].map(nested => [
      `a returned argument preserves JavaScript values across a declared import (nested call: ${nested})`,
      {
        files: {
          "package.json": JSON.stringify({ type: "module" }),
          "tsconfig.json": JSON.stringify({
            compilerOptions: {
              strict: true,
              target: "ESNext",
              module: "Preserve",
              moduleResolution: "bundler",
              noEmit: true,
              allowImportingTsExtensions: true,
              types: [],
              lib: ["ESNext"],
              paths: { sdk: ["./sdk.d.ts"] },
            },
            files: ["main.ts"],
          }),
          "sdk.d.ts": `export declare function prepareSource(code: string): string;`,
          "sdk.ts": `${nested ? "function consume(code: string): number { return code.length; }\n" : ""}export function prepareSource(code: string): string { ${nested ? "consume(code); " : ""}return code; }`,
          "main.ts": `import { prepareSource } from "sdk";
import { receive } from "./bridge.mjs";
type Input = { source: string };
async function run(input: Input): Promise<string> { return prepareSource(input.source); }
await receive(input => run(input as Input));`,
          "bridge.d.mts": `export declare function receive<Output, Input = unknown>(handler: (input: Input) => Promise<Output>): Promise<void>;`,
          "bridge.mjs": `import { prepareSource } from "./sdk.ts";
export async function receive(handler) {
  for (const source of ["hello", 42]) {
    const value = await handler({ source }); console.log(typeof value + ":" + value);
  }
  const value = prepareSource(42); console.log("direct:" + typeof value + ":" + value);
}`,
          "plugin.ts": `import { join } from "path"; export default { name: "sdk-code", setup(b: any) { b.onResolve({ filter: /^sdk$/ }, () => ({ path: join(import.meta.dir, "sdk.ts") })); } };`,
        },
        prints: "string:hello\nnumber:42\ndirect:number:42\n",
      },
    ]),
  ),
};

describe.concurrent("compile/aot/plugins of Bun.build", () => {
  if (unsupported) return void test.skip(unsupported, () => {});
  for (const [name, { files, prints }] of Object.entries(cases)) {
    test(
      name,
      () =>
        slot(async () => {
          using dir = tempDir("aot-build-plugins", { "tsconfig.json": tsconfig, ...files, "build.ts": build });
          const folder = String(dir);
          const main = Object.keys(files).find(file => file.startsWith("main."))!;
          for (const how of ["bundle", "aot"]) {
            const executable = join(folder, how + (isWindows ? ".exe" : ""));
            const built = await spawned([bunExe(), "build.ts", "./" + main, executable, how], folder, bunEnv);
            expect({ how, stdout: built.stdout, stderr: built.stderr, exitCode: built.exitCode }).toEqual({
              how,
              stdout: expect.any(String),
              stderr: expect.any(String),
              exitCode: 0,
            });
            const ran = await spawned(
              [executable],
              folder,
              how === "aot" ? { ...bunEnv, BUN_JSC_crashIfInterpreterIsUsed: "1" } : bunEnv,
            );
            expect({ how, stdout: ran.stdout, exitCode: ran.exitCode, signal: ran.signal }).toEqual({
              how,
              stdout: prints,
              exitCode: 0,
              signal: null,
            });
          }
        }),
      600_000,
    );
  }
});
