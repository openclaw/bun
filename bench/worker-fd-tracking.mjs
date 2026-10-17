// bun run build:release bench/worker-fd-tracking.mjs [counts] [rounds] [sync,async]
import { once } from "node:events";
import { closeSync, promises as fs, openSync } from "node:fs";
import { devNull } from "node:os";
import { performance } from "node:perf_hooks";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";

if (!isMainThread) {
  const { count, mode } = workerData;
  const started = performance.now();
  if (mode === "sync") {
    const fds = Array.from({ length: count }, () => openSync(devNull, "r"));
    for (const fd of fds) closeSync(fd);
  } else {
    const handles = [];
    for (let i = 0; i < count; i++) handles.push(await fs.open(devNull, "r"));
    for (const handle of handles) await handle.close();
  }
  parentPort.postMessage({ openCloseMs: performance.now() - started });
  parentPort.close();
} else {
  const counts = (process.argv[2] ?? "1,16,256,2000,4000").split(",").map(Number);
  const rounds = Number(process.argv[3] ?? 30);
  const modes = (process.argv[4] ?? "sync,async").split(",");
  if (!counts.every(n => Number.isSafeInteger(n) && n > 0) || !Number.isSafeInteger(rounds) || rounds < 1) {
    throw new RangeError("counts and rounds must be positive integers");
  }
  if (!modes.every(mode => mode === "sync" || mode === "async")) {
    throw new RangeError("modes must be sync or async");
  }
  const median = values => {
    const sorted = values.toSorted((a, b) => a - b);
    return (sorted[(sorted.length - 1) >> 1] + sorted[sorted.length >> 1]) / 2;
  };
  async function run(count, mode) {
    const worker = new Worker(new URL(import.meta.url), { workerData: { count, mode } });
    const exited = once(worker, "exit");
    const result = await new Promise((resolve, reject) => {
      worker.once("message", resolve);
      worker.once("error", reject);
      worker.once("exit", code => reject(new Error(`Worker exited before reporting: ${code}`)));
    });
    const started = performance.now();
    const [code] = await exited;
    if (code !== 0) throw new Error(`Worker exited with code ${code}`);
    return { ...result, exitMs: performance.now() - started };
  }
  const results = [];
  for (const mode of modes) {
    for (const count of counts) {
      await run(count, mode);
      const samples = [];
      for (let i = 0; i < rounds; i++) samples.push(await run(count, mode));
      results.push({
        mode,
        count,
        rounds,
        openCloseMs: median(samples.map(sample => sample.openCloseMs)),
        exitMs: median(samples.map(sample => sample.exitMs)),
        samples,
      });
    }
  }
  console.log(JSON.stringify({ runtime: process.versions.bun ?? process.version, results }));
}
