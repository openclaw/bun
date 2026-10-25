import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const [outputArg, s8Exe, s8Source, s7Exe, s7Source] = process.argv.slice(2);
assert(outputArg && s8Exe && s8Source && s7Exe && s7Source);
const output = resolve(outputArg);
mkdirSync(output, { recursive: true });
const testFile = "test/js/node/worker_threads/worker_threads.test.ts";
const testName = "wakes a parked worker for an immediate GC timer";
const variants = [
  { name: "S8", exe: resolve(s8Exe), source: resolve(s8Source), head: "a242c7f085316fb4c6c0a78c2e3a557e65a0c846" },
  { name: "S7", exe: resolve(s7Exe), source: resolve(s7Source), head: "4e3f28e9b2fb8abb296afd55a819b925b0a0c730" },
];
const report = { variants: [], fullFiles: [], trials: [] };
const save = () => writeFileSync(join(output, "trials.json"), JSON.stringify(report, null, 2) + "\n");

function environment(variant, traceDirectory) {
  const env = {
    ...process.env,
    PATH: `${dirname(variant.exe)};${process.env.PATH}`,
    BUN_FEATURE_FLAG_INTERNAL_FOR_TESTING: "1",
    BUN_GARBAGE_COLLECTOR_LEVEL: "1",
    BUN_JSC_randomIntegrityAuditRate: "1.0",
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
    BUN_DEBUG_QUIET_LOGS: "1",
    CI: "1",
    GITHUB_ACTIONS: "true",
    NO_COLOR: "1",
  };
  delete env.Path;
  delete env.NODE_OPTIONS;
  delete env.BUN_TEST_DRAIN_EVENT_LOOP;
  delete env.BUN_DIAG_GC_WAKE_DIR;
  if (traceDirectory) env.BUN_DIAG_GC_WAKE_DIR = traceDirectory;
  return env;
}

for (const variant of variants) {
  const sourceHead = spawnSync("git", ["rev-parse", "HEAD"], { cwd: variant.source, encoding: "utf8" });
  assert.equal(sourceHead.status, 0);
  assert.equal(sourceHead.stdout.trim(), variant.head);
  const source = readFileSync(join(variant.source, testFile), "utf8");
  const start = source.indexOf(`  test.concurrent("${testName}"`);
  assert(start >= 0);
  const end = source.indexOf("\n  test(", start);
  const caseHash = createHash("sha256").update(source.slice(start, end)).digest("hex");
  assert.equal(caseHash, "bad4f3c5c0bd81289843ce29719182dc536ecffc4b2c247e1882095c01f56efc");
  const identity = spawnSync(variant.exe, ["-p", "JSON.stringify({revision:Bun.revision,webkit:process.versions.webkit,arch:process.arch})"], { encoding: "utf8" });
  assert.equal(identity.status, 0);
  const runtime = JSON.parse(identity.stdout);
  assert(runtime.revision.includes(variant.head.slice(0, 9)));
  assert.equal(runtime.arch, process.env.EXPECTED_ARCH);
  report.variants.push({ ...variant, runtime, caseHash, binarySha256: createHash("sha256").update(readFileSync(variant.exe)).digest("hex") });
  save();

  // The shared runner installs the same dependencies and keeps its existing file/process deadlines.
  const result = spawnSync(process.execPath, ["scripts/runner.node.ts", "--exec-path", variant.exe, "--vendor=false", "--retries=0", "--results-json", join(output, `${variant.name}-full-results.json`), "--include", testFile.replace(/^test\//, "")], {
    cwd: variant.source,
    env: environment(variant),
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  writeFileSync(join(output, `${variant.name}-full.log`), (result.stdout ?? "") + (result.stderr ?? ""));
  report.fullFiles.push({ variant: variant.name, exitCode: result.status, error: result.error?.message });
  save();
}

for (const tracing of [false, true]) {
  for (let round = 1; round <= 10; round++) {
    const order = round % 2 ? variants : [...variants].reverse();
    for (const variant of order) {
      const label = `${tracing ? "trace" : "plain"}-${String(round).padStart(2, "0")}-${variant.name}`;
      const traceDirectory = tracing ? join(output, label) : undefined;
      if (traceDirectory) mkdirSync(traceDirectory, { recursive: true });
      const started = Date.now();
      const result = spawnSync(variant.exe, ["test", testFile, "-t", testName], {
        cwd: variant.source,
        env: environment(variant, traceDirectory),
        encoding: "utf8",
        maxBuffer: 32 * 1024 * 1024,
        // Process watchdog only; the unchanged test still has its original ten-second limit.
        timeout: 30_000,
      });
      const text = ((result.stdout ?? "") + (result.stderr ?? "")).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
      writeFileSync(join(output, `${label}.log`), text);
      const outcome = result.error || result.signal ? "invalid"
        : result.status === 0 && /\b1 pass\b/.test(text) && /\b0 fail\b/.test(text) ? "pass"
        : result.status !== 0 && text.includes(testName) && /\b1 fail\b/.test(text) ? "fail" : "invalid";
      report.trials.push({ variant: variant.name, tracing, round, label, outcome, exitCode: result.status, signal: result.signal, error: result.error?.message, durationMs: Date.now() - started });
      save();
      console.log(`${label}: ${outcome} (${Date.now() - started} ms)`);
      // An infrastructure/process failure must not contaminate later interleaved trials.
      if (outcome === "invalid") throw new Error(`Invalid diagnostic trial: ${label}`);
    }
  }
}
if (report.fullFiles.some(result => result.exitCode !== 0) || report.trials.some(result => result.outcome !== "pass")) process.exitCode = 1;
