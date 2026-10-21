import { expect } from "bun:test";
import { bunEnv, bunExe, tempDir } from "harness";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "./supported";

test.each([
  ["wide total length", "the program's length does not match its header"],
  ["wide section offset", "a section extends outside the program"],
  ["overflowing section end", "a section extends outside the program"],
] as const)(
  "typed program rejects %s",
  async (kind, reason) => {
    using dir = tempDir("aot-program-format", {
      "main.ts": `declare const console: { log(value: number): void };
function twice(value: number) { return value * 2; }
console.log(twice(21));
`,
    });
    const cwd = String(dir);
    async function run(args: string[], env = bunEnv) {
      await using proc = Bun.spawn({ cmd: [bunExe(), ...args], cwd, env, stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
      return { stdout, stderr, exitCode };
    }
    const checked = await run(["check", "--aot", "--aot-out=program.typed", "main.ts"]);
    expect({ stderr: checked.exitCode ? checked.stderr : "", exitCode: checked.exitCode }).toEqual({
      stderr: "",
      exitCode: 0,
    });
    const typed = readFileSync(join(cwd, "program.typed"));
    expect(typed.readUInt32LE(4)).toBe(39);
    expect(typed.readBigUInt64LE(8)).toBe(BigInt(typed.length));
    expect(typed.readBigUInt64LE(28)).toBe(324n);
    if (kind === "wide total length") {
      typed.writeBigUInt64LE((1n << 32n) + BigInt(typed.length), 8);
    } else {
      const offset = kind === "wide section offset" ? (1n << 32n) + typed.readBigUInt64LE(28) : (1n << 64n) - 4n;
      typed.writeBigUInt64LE(offset, 28);
      typed.writeUInt32LE(8, 36);
    }
    const injected = join(cwd, "modified.typed");
    writeFileSync(injected, typed);
    const built = await run(["build", "--compile", "--aot", "main.ts", "--outfile", "app"], {
      ...bunEnv,
      BUN_AOT_TYPED_FILE: injected,
    });
    expect(built.stderr.split("\n").filter(line => line.startsWith("error: --aot:"))).toEqual([
      `error: --aot: internal error: the typed program cannot be read: ${reason}`,
    ]);
    expect(built.exitCode).toBe(1);
  },
  120_000,
);
