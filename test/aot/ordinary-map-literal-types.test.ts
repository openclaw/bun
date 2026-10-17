import { expect, test } from "bun:test";
import { bunEnv, bunExe, tempDir } from "harness";
import { join } from "node:path";
import { unlinkSync } from "node:fs";

const tsconfig = JSON.stringify({
  compilerOptions: {
    strict: true,
    target: "ESNext",
    module: "ESNext",
    types: [],
    lib: ["ESNext"],
  },
});

function program(
  record: unknown = { pluginId: "test", origin: "bundled", packageName: "test" },
  install = "{ npmSpec: 'test' }",
) {
  return `
declare const console: { log(...values: unknown[]): void };
type Install = { npmSpec?: string };
type Preferred = { origin: string; install: Install; packageName?: string };
type Catalog = { pluginId: string; choiceId: string; origin: string; install: Install };
type RecordInfo = { pluginId: string; origin: string; packageName?: string };
function sourceInfo(): { sources: Map<string, Preferred> } {
  const records: RecordInfo[] = JSON.parse(${JSON.stringify(JSON.stringify([record]))});
  const sources = new Map<string, Preferred>();
  for (const record of records) {
    sources.set(record.pluginId, {
      origin: record.origin,
      install: ${install},
      ...(record.packageName ? { packageName: record.packageName } : {}),
    });
  }
  return { sources };
}
function resolve(): Catalog[] {
  const { sources } = sourceInfo();
  return [{ pluginId: 'test', choiceId: 'choice' }].flatMap(choice => {
    const install = sources.get(choice.pluginId);
    if (!install) return [];
    return [{ ...choice, origin: install.origin, install: install.install } satisfies Catalog];
  });
}
const result = resolve()[0];
if (!result) throw new Error('missing');
console.log(result.choiceId, result.origin.toUpperCase(), result.install.npmSpec?.toUpperCase());
`;
}

async function run(cmd: string[], cwd: string, env = bunEnv) {
  await using proc = Bun.spawn({ cmd, cwd, env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
  return { stdout, stderr, exitCode };
}

test.each([
  ["strict", ["--aot"]],
  ["logging", ["--aot", "--aot-type-errors=log"]],
] as const)("ordinary literals stored in a returned Map retain their own type in %s mode", async (_mode, flags) => {
  using dir = tempDir("ordinary-map-literal", { "tsconfig.json": tsconfig, "main.ts": program() });
  const result = await run([bunExe(), "run", ...flags, "main.ts"], String(dir));
  expect(result).toEqual({ stdout: "choice BUNDLED TEST\n", stderr: "", exitCode: 0 });
});

test("compiled ordinary Map literals do not require properties of a stricter subtype", async () => {
  using dir = tempDir("ordinary-map-literal-compiled", { "tsconfig.json": tsconfig, "main.ts": program() });
  using output = tempDir("ordinary-map-literal-output", {});
  const executable = join(String(output), "program");
  const built = await run([bunExe(), "build", "--compile", "--aot", "main.ts", "--outfile", executable], String(dir));
  expect(built.exitCode).toBe(0);
  unlinkSync(join(String(dir), "main.ts"));
  const result = await run([executable], String(output), { ...bunEnv, BUN_JSC_crashIfInterpreterIsUsed: "1" });
  expect(result).toEqual({ stdout: "choice BUNDLED TEST\n", stderr: "", exitCode: 0 });
}, 60_000);

test.each([
  ["missing origin", { pluginId: "test", packageName: "test" }, "{ npmSpec: 'test' }", "toUpperCase"],
  ["numeric origin", { pluginId: "test", origin: 42, packageName: "test" }, "{ npmSpec: 'test' }", "expected string"],
  ["null install", { pluginId: "test", origin: "bundled", packageName: "test" }, 'JSON.parse("null")', "npmSpec"],
  [
    "numeric nested field",
    { pluginId: "test", origin: "bundled", packageName: "test" },
    "JSON.parse('{\"npmSpec\":42}')",
    "toUpperCase",
  ],
] as const)("ordinary Map literal still rejects %s when consumed", async (_name, record, install, reason) => {
  using dir = tempDir("ordinary-map-literal-invalid", {
    "tsconfig.json": tsconfig,
    "main.ts": program(record, install),
  });
  const result = await run([bunExe(), "run", "--aot", "main.ts"], String(dir));
  expect(result.exitCode).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("TypeError:");
  expect(result.stderr).toContain(reason);
  expect(result.stderr).not.toContain("required in");
});
