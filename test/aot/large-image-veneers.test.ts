import { expect } from "bun:test";
import { bunEnv, bunExe, tempDir } from "harness";
import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { test } from "./supported";

test("far-call veneers share their caller's alignment reserve", async () => {
  const count = 896;
  const source = ["declare const console: { log(value: number): void };", "declare const process: { argv: string[] };"];
  for (let target = 0; target < count; target++) {
    source.push(`function target${target}(x: number): number {
      for (let step = 0; step < 3 + (x & 1); step++) x = (x * 33 + ${target} + step) | 0;
      return x;
    }`);
  }
  for (let caller = 0; caller < count; caller++) {
    const targets = Array.from({ length: count }, (_, index) => index);
    let seed = caller + 1;
    for (let index = targets.length - 1; index > 0; index--) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const other = seed % (index + 1);
      [targets[index], targets[other]] = [targets[other], targets[index]];
    }
    source.push(`function caller${caller}(x: number): number { x ^= ${caller};`);
    for (const target of targets) source.push(`x = target${target}(x);`);
    source.push("return x; }");
  }
  source.push(`const callers = [${Array.from({ length: count }, (_, index) => `caller${index}`).join(",")}];`);
  source.push(
    'let result = Number(process.argv[2] || "1"); for (const caller of callers) result ^= caller(result); console.log(result);',
  );
  using directory = tempDir("large-image-veneers", {
    "main.ts": source.join("\n"),
    "tsconfig.json": JSON.stringify({
      compilerOptions: { strict: true, target: "ESNext", module: "ESNext", types: [], lib: ["ESNext"] },
    }),
  });
  const cwd = String(directory);
  const executable = join(cwd, "program");
  async function run(cmd: string[], env = bunEnv) {
    await using child = Bun.spawn({ cmd, cwd, env, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([child.stdout.text(), child.stderr.text(), child.exited]);
    return { stdout, stderr, exitCode };
  }
  const plain = await run([bunExe(), "main.ts"]);
  expect(plain.exitCode).toBe(0);
  expect(plain.stdout).toMatch(/^-?\d+\n$/);
  const built = await run([bunExe(), "build", "--compile", "--aot", "main.ts", "--outfile", executable], {
    ...bunEnv,
    BUN_JSC_forceAOTVeneers: "1",
    BUN_JSC_aotHotByTextForTesting: "1",
  });
  expect(built.stderr).toBe("");
  expect(built.exitCode).toBe(0);
  unlinkSync(join(cwd, "main.ts"));
  expect(await run([executable], { ...bunEnv, BUN_JSC_crashIfInterpreterIsUsed: "1" })).toEqual(plain);
}, 120_000);
