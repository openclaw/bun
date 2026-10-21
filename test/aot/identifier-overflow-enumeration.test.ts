import { expect } from "bun:test";
import { bunEnv, bunExe, tempDir } from "harness";
import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { test } from "./supported";

function program(count: number) {
  const source = ['const box = JSON.parse(process.argv[2] || "{}");', "const warmers = ["];
  for (let first = 0; first < count; first += 1000) {
    source.push("function(pad) { let found = 0;");
    for (let index = first; index < Math.min(count, first + 1000); index++)
      source.push(`found += pad.AOT_FAKE_PAD_${index} !== undefined ? 1 : 0;`);
    source.push("return found; },");
  }
  source.push(
    "]; let found = 0; for (const warm of warmers) found += warm(box); console.log(found);",
    "const target = {}; const getters = { probeFirst: () => 1, probeSecond: () => 2 };",
    "for (const name in getters) Object.defineProperty(target, name, { get: getters[name], enumerable: true, configurable: true });",
    "console.log(JSON.stringify(target));",
  );
  return source.join("\n");
}

for (const count of [256, 66000]) {
  test(`enumeration retains property names after ${count} distinct reads`, async () => {
    using directory = tempDir("identifier-overflow-enumeration", { "main.js": program(count) });
    const cwd = String(directory);
    const executable = join(cwd, "program");
    async function run(cmd: string[], env = bunEnv) {
      await using child = Bun.spawn({ cmd, cwd, env, stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr, exitCode] = await Promise.all([child.stdout.text(), child.stderr.text(), child.exited]);
      return { stdout, stderr, exitCode };
    }
    const expected = { stdout: '0\n{"probeFirst":1,"probeSecond":2}\n', stderr: "", exitCode: 0 };
    expect(await run([bunExe(), "main.js"])).toEqual(expected);
    const built = await run([bunExe(), "build", "--compile", "--aot", "main.js", "--outfile", executable]);
    expect(built.exitCode).toBe(0);
    expect(built.stderr).toBe("");
    unlinkSync(join(cwd, "main.js"));
    expect(await run([executable], { ...bunEnv, BUN_JSC_crashIfInterpreterIsUsed: "1" })).toEqual(expected);
  }, 120_000);
}
