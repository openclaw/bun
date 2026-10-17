import { expect } from "bun:test";
import { test } from "./supported";
import { bunEnv, bunExe, tempDir } from "harness";

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
