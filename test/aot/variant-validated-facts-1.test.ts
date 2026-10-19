// Compiled code tests every value against the type that it otherwise relies on without a test, and crashes on a value that is not of it.
import { expect } from "bun:test";
import { readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { bunEnv, bunExe, isWindows, tempDir } from "harness";
import { built, slot, spawned, told, variant } from "./run-programs";
import { test } from "./supported";

const source = readFileSync(join(import.meta.dir, "programs/strings/captured-string-loop-entry.ts"), "utf8");

test("typed fact validation handles a captured string opened at a loop entry", () => slot(async () => {
  using dir = tempDir("aot-validated-captured-string-loop", {
    "main.ts": source,
    "package.json": JSON.stringify({ type: "module" }),
  });
  const folder = String(dir);
  const executable = join(folder, isWindows ? "program.exe" : "program");
  const plain = await spawned([bunExe(), "main.ts"], folder, bunEnv);
  expect(told(plain)).toEqual({ stdout: "other\n532\nprefix\n552\n", stderr: "", exitCode: 0 });
  built(await spawned([bunExe(), "build", "--compile", "--aot", "main.ts", "--outfile", executable], folder, {
    ...bunEnv,
    BUN_JSC_validateAOTTypedFacts: "1",
  }));
  renameSync(join(folder, "main.ts"), join(folder, "main.ts.hidden"));
  const compiled = await spawned([executable], folder, {
    ...bunEnv,
    BUN_JSC_validateAOTTypedFacts: "1",
    BUN_JSC_useJIT: "0",
    BUN_JSC_crashIfInterpreterIsUsed: "1",
  });
  expect(compiled.signal).toBeNull();
  expect(told(compiled)).toEqual(told(plain));
}), 60_000);

variant("validated-facts", { BUN_JSC_validateAOTTypedFacts: "1" }, {}, 1, 3);
