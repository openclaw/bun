import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { engines, revisions, variantsFor } from "./gc-r2-config.mjs";

const [experiment, outputArg] = process.argv.slice(2);
assert.equal(process.platform, "win32");
const output = resolve(outputArg);
mkdirSync(output, { recursive: true });
const file = "test/js/node/worker_threads/worker_threads.test.ts";
const name = "wakes a parked worker for an immediate GC timer";
const caseHash = "bad4f3c5c0bd81289843ce29719182dc536ecffc4b2c247e1882095c01f56efc";
const commonEnv = { ...process.env, BUN_FEATURE_FLAG_INTERNAL_FOR_TESTING: "1", BUN_GARBAGE_COLLECTOR_LEVEL: "1",
  BUN_JSC_randomIntegrityAuditRate: "1.0", BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0", BUN_DEBUG_QUIET_LOGS: "1", NO_COLOR: "1" };
for (const key of ["NODE_OPTIONS", "BUN_TEST_DRAIN_EVENT_LOOP", "BUN_DIAG_GC_WAKE_DIR", "BUN_DIAG_GC_WAKE_MODE", "BUN_DIAG_ASYNC_GC_CLEAR"]) delete commonEnv[key];
const cases = [
  { id: "original-s8", source: revisions.s8, engine: engines.s8, exe: resolve("s8-runtime/bun-windows-aarch64/bun.exe") },
  ...variantsFor(experiment).flatMap(variant => {
    const meta = JSON.parse(readFileSync(`runtime/gc-r2-build-${variant.id}/gc-r2-metadata.json`, "utf8"));
    assert.equal(meta.source, variant.source);
    assert.equal(meta.engineRef, variant.engineRef);
    assert.equal(meta.engine, variant.engineRef === revisions.s8 ? engines.s8 : engines.s7);
    assert.equal(meta.kind, variant.kind);
    assert.equal(meta.caseHash, caseHash);
    const entry = { id: variant.id, source: meta.source, engine: meta.engine,
      exe: resolve(`runtime/gc-r2-build-${variant.id}/bun-windows-aarch64/bun.exe`), metadata: meta };
    return experiment === "async-clear" ? [
      { ...entry, id: "async-clear-off", clear: "0" }, { ...entry, id: "async-clear-on", clear: "1" },
    ] : [entry];
  }),
  { id: "original-s7", source: revisions.s7, engine: engines.s7, exe: resolve("s7-runtime/bun-windows-aarch64/bun.exe") },
];
for (const entry of cases) {
  entry.cwd = resolve(entry.source === revisions.s8 ? "s8" : "s7");
  const source = readFileSync(join(entry.cwd, file), "utf8");
  const start = source.indexOf(`  test.concurrent("${name}"`);
  assert(start >= 0);
  assert.equal(createHash("sha256").update(source.slice(start, source.indexOf("\n  test(", start))).digest("hex"), caseHash);
  const binary = readFileSync(entry.exe);
  assert.equal(binary.readUInt16LE(binary.readUInt32LE(0x3c) + 4), 0xaa64);
  entry.sha256 = createHash("sha256").update(binary).digest("hex");
  const identity = spawnSync(entry.exe, ["-p", "JSON.stringify({revision:Bun.revision,webkit:process.versions.webkit,arch:process.arch})"], { env: commonEnv, encoding: "utf8" });
  assert.equal(identity.status, 0);
  entry.runtime = JSON.parse(identity.stdout);
  assert.deepEqual(entry.runtime, { revision: entry.source, webkit: entry.engine, arch: "arm64" });
}
const results = { experiment, caseHash, cases, trials: [] };
const save = () => writeFileSync(join(output, "results.json"), JSON.stringify(results, null, 2) + "\n");
save();
for (let round = 1; round <= 10; round++) {
  for (const entry of round % 2 ? cases : [...cases].reverse()) {
    const label = `${String(round).padStart(2, "0")}-${entry.id}`;
    const env = { ...commonEnv, ...(entry.clear === undefined ? {} : { BUN_DIAG_ASYNC_GC_CLEAR: entry.clear }) };
    const start = Date.now();
    const child = spawnSync(entry.exe, ["test", file, "-t", name], { cwd: entry.cwd, env, encoding: "utf8", maxBuffer: 32 * 1024 * 1024,
      // A process watchdog only; the fixture's ten-second limit is unchanged.
      timeout: 30_000 });
    const text = ((child.stdout ?? "") + (child.stderr ?? "")).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
    writeFileSync(join(output, `${label}.log`), text);
    const outcome = child.error || child.signal ? "invalid"
      : child.status === 0 && /\b1 pass\b/.test(text) && /\b0 fail\b/.test(text) ? "pass"
      : child.status !== 0 && /\b1 fail\b/.test(text) && text.includes(name) && /timed out after 10000ms/.test(text) ? "timeout" : "invalid";
    results.trials.push({ round, id: entry.id, outcome, durationMs: Date.now() - start, exitCode: child.status, signal: child.signal, error: child.error?.message });
    save();
    console.log(`${label}: ${outcome} (${Date.now() - start} ms)`);
    assert.notEqual(outcome, "invalid", `Invalid diagnostic trial ${label}`);
  }
}
results.counts = Object.fromEntries(cases.map(entry => [entry.id, Object.fromEntries(["pass", "timeout", "invalid"].map(outcome => [outcome, results.trials.filter(t => t.id === entry.id && t.outcome === outcome).length]))]));
const controlsValid = results.counts["original-s8"].timeout >= 2 && results.counts["original-s7"].timeout === 0;
results.controlsValid = controlsValid;
if (experiment === "bisect") {
  const a = results.counts["s8-bun-s7-engine"], b = results.counts["s7-bun-s8-engine"];
  results.interpretation = !controlsValid ? "controls-did-not-confirm"
    : a.timeout === 0 && b.timeout >= 2 ? "follows-engine"
    : a.timeout >= 2 && b.timeout === 0 ? "follows-bun"
    : "interaction-or-inconclusive";
} else {
  results.interpretation = !controlsValid ? "controls-did-not-confirm"
    : results.counts["async-clear-off"].timeout >= 2 && results.counts["async-clear-on"].timeout === 0 ? "clear-call-changes-outcome-not-root-proof" : "inconclusive-or-no-effect";
}
save();
console.log(JSON.stringify({ counts: results.counts, interpretation: results.interpretation }));
assert(controlsValid, "Original signed controls did not confirm the known regression");
