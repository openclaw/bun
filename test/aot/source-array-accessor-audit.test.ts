import { expect } from "bun:test";
import { test } from "./supported";
import { bunEnv, bunExe, isWindows, tempDir } from "harness";
import { readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";

const refusal = "Cannot read array element: the array or its prototype chain has accessors or a Proxy";
const tsconfig = JSON.stringify({
  compilerOptions: {
    strict: true,
    target: "ESNext",
    module: "Preserve",
    moduleResolution: "bundler",
    types: [],
    lib: ["esnext", "dom"],
  },
});

test.each([
  ["strict", ["--aot"]],
  ["logging", ["--aot", "--aot-type-errors=log"]],
  ["audit", ["--aot-audit"]],
] as const)(
  "source array element access in %s mode reports accessors without running them in strict mode",
  async (mode, flags) => {
    for (const accessor of [false, true]) {
      using dir = tempDir("typed-array-accessor", {
        "tsconfig.json": tsconfig,
        "main.ts": `
let reads = 0;
const names: string[] = ["ordinary"];
function first(): string { return names[0]; }
console.log("before", first());
${accessor ? 'Object.defineProperty(names, "0", { configurable: true, get() { reads++; return "changed"; } });' : ""}
try { console.log("after", first()); }
catch (error) { console.log(String(error).split(" (bun")[0]); }
console.log("reads", reads);
`,
      });
      await using proc = Bun.spawn({
        cmd: [bunExe(), "run", ...flags, "main.ts"],
        cwd: String(dir),
        env: { ...bunEnv, BUN_AOT_TYPE_ERROR_LOG: "stderr", BUN_AOT_TYPE_ERROR_LOG_FORMAT: "json" },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
      expect(exitCode).toBe(0);
      if (!accessor) {
        expect(stdout).toBe("before ordinary\nafter ordinary\nreads 0\n");
        expect(stderr).toBe("");
      } else if (mode === "strict") {
        expect(stdout).toStartWith("before ordinary\nTypeError: " + refusal);
        expect(stdout).toEndWith("\nreads 0\n");
        expect(stderr).toBe("");
      } else {
        expect(stdout).toBe("before ordinary\nafter changed\nreads 1\n");
        const records = stderr
          .trim()
          .split("\n")
          .filter(Boolean)
          .map(line => JSON.parse(line));
        expect(records).toHaveLength(1);
        expect(records[0]).toMatchObject({
          kind: "array-not-plain",
          what: "ArrayElementRead",
          action: "would-throw",
          fn: "first",
          count: 1,
        });
        expect(records[0].file).toEndWith("main.ts");
        expect(records[0].line).toBe(4);
        expect(records[0].reason).toContain("accessors or a Proxy");
      }
    }
  },
  30_000,
);

async function run(cmd: string[], cwd: string, env = bunEnv) {
  await using child = Bun.spawn({ cmd, cwd, env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([child.stdout.text(), child.stderr.text(), child.exited]);
  return { stdout, stderr, exitCode };
}

test("typed arrays preserve Proxy identity, traps, and element checks", async () => {
  using dir = tempDir("aot-proxy-array-boundary", {
    "main.ts": readFileSync(new URL("./fixtures/proxy-array-boundary.ts", import.meta.url), "utf8"),
    "tsconfig.json": JSON.stringify({
      compilerOptions: { strict: true, target: "ESNext", module: "ESNext", types: [], lib: ["ESNext"] },
    }),
  });
  const cwd = String(dir);
  const expected = { stdout: "proxy-array behavior passed\n", stderr: "", exitCode: 0 };
  expect(await run([bunExe(), "run", "--aot", "main.ts"], cwd)).toEqual(expected);
  const executable = join(cwd, "main" + (isWindows ? ".exe" : ""));
  const build = await run([bunExe(), "build", "--compile", "--aot", "main.ts", "--outfile", executable], cwd);
  expect({ stderr: build.stderr, exitCode: build.exitCode }).toEqual({ stderr: "", exitCode: 0 });
  unlinkSync(join(cwd, "main.ts"));
  expect(
    await run([executable], cwd, { ...bunEnv, BUN_JSC_useJIT: "0", BUN_JSC_crashIfInterpreterIsUsed: "1" }),
  ).toEqual(expected);
}, 120_000);
