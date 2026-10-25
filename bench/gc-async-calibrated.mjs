// node calibrated-benchmark.mjs <baseline-bun> <candidate-bun> <output-directory> <noop-bun>
// Same frozen workloads; all three binaries share each interleaved round.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { arch, cpus, platform } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

const script = fileURLToPath(import.meta.url);
const cpuMs = usage => (usage.user + usage.system) / 1000;

async function measure(name) {
  assert(process.versions.bun, "Run benchmark cases with the selected Bun executable");
  if (name === "gc-loop") {
    for (let i = 0; i < 2000; i++) Bun.gc(false);
    Bun.gc(true);
    const cpu = process.cpuUsage();
    const start = performance.now();
    for (let i = 0; i < 200000; i++) Bun.gc(false);
    return { iterations: 200000, elapsedMs: performance.now() - start, cpuMs: cpuMs(process.cpuUsage(cpu)) };
  }

  assert.equal(name, "idle-worker");
  const worker = new Worker(
    `const { parentPort } = require("node:worker_threads");
     async function turn(i) {
       globalThis.payload = new Array(524288).fill(i);
       // The controller can throttle after quiet ticks; request collection before every park.
       Bun.gc(false);
       await new Promise(resolve => setTimeout(resolve, 0));
     }
     (async () => {
       for (let i = 0; i < 25; i++) await turn(i);
       Bun.gc(true);
       parentPort.postMessage("ready");
       parentPort.once("message", async () => {
         const start = performance.now();
         for (let i = 0; i < 500; i++) await turn(i);
         parentPort.postMessage({ iterations: 500, elapsedMs: performance.now() - start,
           checksum: payload[0] + payload.length });
         parentPort.close();
       });
     })().catch(error => { throw error; });`,
    { eval: true },
  );
  let measured;
  await new Promise((resolve, reject) => {
    let cpu;
    worker.on("error", reject);
    worker.on("message", message => {
      if (message === "ready") {
        cpu = process.cpuUsage();
        worker.postMessage("go");
      } else {
        measured = { ...message, cpuMs: cpuMs(process.cpuUsage(cpu)) };
      }
    });
    worker.on("exit", code => {
      if (code !== 0 || !measured) reject(new Error(`Worker exited with ${code} before completing the workload`));
      else resolve();
    });
  });
  assert.equal(measured.checksum, 524288 + 499);
  return measured;
}

if (process.argv[2] === "--case") {
  console.log(JSON.stringify(await measure(process.argv[3])));
} else {
  const [baselineArg, candidateArg, outputArg, noopArg] = process.argv.slice(2);
  assert(baselineArg && candidateArg && outputArg && noopArg, "Expected baseline, candidate, output directory, and no-op control");
  const output = resolve(outputArg);
  assert(!existsSync(output), "Use a fresh output directory to preserve every comparison");
  mkdirSync(output, { recursive: true });
  const baseEnv = { ...process.env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0", NO_COLOR: "1" };
  for (const key of ["NODE_OPTIONS", "BUN_OPTIONS", "BUN_DIAG_ASYNC_GC_CLEAR", "BUN_GC_TIMER_DISABLE",
    "BUN_GC_TIMER_INTERVAL", "BUN_IDLE_GC_SECONDS", "BUN_GARBAGE_COLLECTOR_LEVEL", "BUN_TEST_DRAIN_EVENT_LOOP"])
    delete baseEnv[key];
  const binaries = { baseline: resolve(baselineArg), candidate: resolve(candidateArg), noop: resolve(noopArg) };
  const identities = Object.fromEntries(Object.entries(binaries).map(([label, exe]) => {
    const child = spawnSync(exe, ["-p", "JSON.stringify({revision:Bun.revision,webkit:process.versions.webkit,arch:process.arch})"],
      { env: baseEnv, encoding: "utf8" });
    assert.equal(child.status, 0, child.stderr);
    return [label, { ...JSON.parse(child.stdout), sha256: createHash("sha256").update(readFileSync(exe)).digest("hex") }];
  }));
  assert.notEqual(identities.baseline.sha256, identities.candidate.sha256, "Select two distinct executables");
  assert.equal(identities.baseline.arch, arch());
  assert.equal(identities.candidate.arch, arch());
  assert.equal(identities.noop.arch, arch());
  assert.equal(new Set(Object.values(identities).map(i => i.sha256)).size, 3);
  const result = { platform: platform(), arch: arch(), cpu: cpus()[0].model, identities, trials: [], summaries: {} };
  const save = () => writeFileSync(join(output, "results.json"), JSON.stringify(result, null, 2) + "\n");
  save();
  const median = values => {
    const sorted = [...values].sort((a, b) => a - b);
    return (sorted[4] + sorted[5]) / 2;
  };
  for (const name of ["gc-loop", "idle-worker"]) {
    for (let round = 1; round <= 10; round++) {
      const orders = [["baseline", "candidate", "noop"], ["noop", "candidate", "baseline"],
        ["candidate", "noop", "baseline"], ["baseline", "noop", "candidate"],
        ["noop", "baseline", "candidate"], ["candidate", "baseline", "noop"]];
      for (const label of orders[(round - 1) % orders.length]) {
        const dir = join(output, `${name}-${round}-${label}`);
        mkdirSync(join(dir, "home"), { recursive: true, mode: 0o700 });
        mkdirSync(join(dir, "tmp"), { mode: 0o700 });
        const env = { ...baseEnv, HOME: join(dir, "home"), TMPDIR: join(dir, "tmp"),
          BUN_GC_TIMER_DISABLE: name === "gc-loop" ? "1" : "0", BUN_GC_TIMER_INTERVAL: "1",
          BUN_IDLE_GC_SECONDS: "1,2", BUN_GC_RUNS_UNTIL_SKIP_RELEASE_ACCESS: "0" };
        if (name === "idle-worker") env.BUN_JSC_numberOfGCMarkers = "2";
        const child = spawnSync(binaries[label], [script, "--case", name],
          { env, encoding: "utf8", timeout: 120000, maxBuffer: 1024 * 1024 });
        writeFileSync(join(dir, "stdout.log"), child.stdout ?? "");
        writeFileSync(join(dir, "stderr.log"), child.stderr ?? "");
        assert.equal(child.status, 0, child.error?.message ?? child.stderr);
        const measurement = JSON.parse(child.stdout);
        assert(Number.isFinite(measurement.elapsedMs) && measurement.elapsedMs > 0);
        assert(Number.isFinite(measurement.cpuMs) && measurement.cpuMs > 0);
        result.trials.push({ name, round, label, ...measurement });
        save();
        console.log(JSON.stringify(result.trials.at(-1)));
      }
    }
    const rows = label => result.trials.filter(t => t.name === name && t.label === label);
    const summary = {};
    for (const metric of ["elapsedMs", "cpuMs"]) {
      const baseline = rows("baseline"), candidate = rows("candidate"), noop = rows("noop");
      summary[metric] = { baselineMedian: median(baseline.map(t => t[metric])),
        candidateMedian: median(candidate.map(t => t[metric])),
        noopMedian: median(noop.map(t => t[metric])),
        noopPairedMedianRatio: median(noop.map((t, i) => t[metric] / baseline[i][metric])),
        pairedMedianRatio: median(candidate.map((t, i) => t[metric] / baseline[i][metric])) };
    }
    // Idle wall time includes intentional parking; CPU time exposes the collection cost.
    summary.primaryMetric = name === "idle-worker" ? "cpuMs" : "elapsedMs";
    summary.limit = Math.max(1.02, summary[summary.primaryMetric].noopPairedMedianRatio + 0.01);
    summary.passed = summary[summary.primaryMetric].pairedMedianRatio <= summary.limit;
    result.summaries[name] = summary;
    save();
  }
  console.log(JSON.stringify(result.summaries, null, 2));
  assert(Object.values(result.summaries).every(summary => summary.passed), "Async GC cost exceeded the predeclared calibrated limit");
}
