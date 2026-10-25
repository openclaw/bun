import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";

const [exe, outputArg] = process.argv.slice(2);
assert(exe && outputArg);
const output = resolve(outputArg);
mkdirSync(output, { recursive: true });
const testFile = "test/js/node/worker_threads/worker_threads.test.ts";
const testName = "wakes a parked worker for an immediate GC timer";
const source = readFileSync(testFile, "utf8");
const start = source.indexOf(`  test.concurrent("${testName}"`);
assert(start >= 0);
const end = source.indexOf("\n  test(", start);
assert.equal(createHash("sha256").update(source.slice(start, end)).digest("hex"), "bad4f3c5c0bd81289843ce29719182dc536ecffc4b2c247e1882095c01f56efc");
const results = [];
for (let round = 1; round <= 10; round++) {
  for (const mode of round % 2 ? ["plain", "memory", "background"] : ["background", "memory", "plain"]) {
    const label = `${String(round).padStart(2, "0")}-${mode}`;
    const env = {
      ...process.env,
      BUN_FEATURE_FLAG_INTERNAL_FOR_TESTING: "1",
      BUN_GARBAGE_COLLECTOR_LEVEL: "1",
      BUN_JSC_randomIntegrityAuditRate: "1.0",
      BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
      BUN_DEBUG_QUIET_LOGS: "1",
      NO_COLOR: "1",
    };
    delete env.NODE_OPTIONS;
    delete env.BUN_TEST_DRAIN_EVENT_LOOP;
    delete env.BUN_DIAG_GC_WAKE_DIR;
    delete env.BUN_DIAG_GC_WAKE_MODE;
    if (mode !== "plain") {
      const directory = join(output, label);
      mkdirSync(directory, { recursive: true });
      env.BUN_DIAG_GC_WAKE_DIR = directory;
      env.BUN_DIAG_GC_WAKE_MODE = mode;
    }
    const started = Date.now();
    const child = spawnSync(exe, ["test", testFile, "-t", testName], {
      env,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      // Process watchdog only; the test's own ten-second limit is unchanged.
      timeout: 30_000,
    });
    const text = ((child.stdout ?? "") + (child.stderr ?? "")).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
    writeFileSync(join(output, `${label}.log`), text);
    const outcome = child.error || child.signal ? "invalid"
      : child.status === 0 && /\b1 pass\b/.test(text) && /\b0 fail\b/.test(text) ? "pass"
      : child.status !== 0 && text.includes(testName) && /\b1 fail\b/.test(text) ? "fail" : "invalid";
    results.push({ round, mode, outcome, exitCode: child.status, signal: child.signal, error: child.error?.message, durationMs: Date.now() - started });
    writeFileSync(join(output, "probe.json"), JSON.stringify(results, null, 2) + "\n");
    console.log(`${label}: ${outcome} (${Date.now() - started} ms)`);
    if (outcome === "invalid") throw new Error(`Invalid probe: ${label}`);
  }
}
if (results.some(result => result.outcome !== "pass")) process.exitCode = 1;
