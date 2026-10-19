import { expect } from "bun:test";
import { readFileSync } from "fs";
import { bunEnv, bunExe, isASAN, isDebug, tempDir } from "harness";
import { join } from "path";
import { programs } from "./run-programs";
import { test } from "./supported";

programs("type-rules");

const analysisRegressions = [
  "typed-objects/generic-type-growing-several-ways.ts",
  "type-rules/arrays-filled-with-sums-of-their-own-elements.ts",
];
const checkTimeout = isDebug || isASAN ? 90_000 : 15_000;

test.each(analysisRegressions)(
  "source analysis finishes for %s",
  async source => {
    using folder = tempDir("aot-source-analysis-regression", {
      "main.ts": readFileSync(join(import.meta.dir, "programs", source), "utf8"),
      "tsconfig.json": JSON.stringify({
        compilerOptions: {
          strict: true,
          target: "ESNext",
          module: "Preserve",
          moduleResolution: "Bundler",
          types: [],
          noEmit: true,
          incremental: false,
        },
        files: ["main.ts"],
      }),
    });
    await using checked = Bun.spawn({
      cmd: [bunExe(), "check", "--aot", "--threads=1", "--no-pretty", "main.ts"],
      cwd: String(folder),
      env: { ...bunEnv, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" },
      stdout: "pipe",
      stderr: "pipe",
      timeout: checkTimeout,
      killSignal: "SIGTERM",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      checked.stdout.text(),
      checked.stderr.text(),
      checked.exited,
    ]);
    expect({ exitCode, signal: checked.signalCode }).toEqual({ exitCode: 0, signal: null });
    expect(stdout).toBe("");
    expect(stderr).toMatch(/^✓ No type errors in 1 files? \[[0-9.]+(?:ms|s)\]\n$/);
  },
  checkTimeout + 5_000,
);
