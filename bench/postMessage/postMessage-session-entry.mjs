import assert from "node:assert/strict";
import { once } from "node:events";
import { performance } from "node:perf_hooks";
import { Worker, isMainThread, parentPort } from "node:worker_threads";
const payloadToken = value => value.inputTokens + value.outputTokens + value.origin.label.length;

if (!isMainThread) {
  let count = 0;
  let checksum = 0;
  parentPort.on("message", message => {
    if (message?.__benchmark === "barrier") {
      parentPort.postMessage({ count, checksum });
      count = 0;
      checksum = 0;
    } else if (message?.__benchmark === "close") {
      parentPort.close();
    } else {
      count++;
      checksum += payloadToken(message);
    }
  });
  parentPort.postMessage({ ready: true });
} else {
  const kind = "postMessage";
  const name = "session-entry";
  const payload = {
    sessionId: "synthetic-session",
    updatedAt: 1760000000000,
    sessionFile: "synthetic/session.jsonl",
    model: "fixture-model",
    provider: "fixture-provider",
    inputTokens: 1200,
    outputTokens: 640,
    totalTokens: 1840,
    contextTokens: 16384,
    label: "Synthetic session",
    channel: "fixture-channel",
    lastChannel: "fixture-channel",
    origin: {
      label: "Synthetic sender",
      provider: "fixture-provider",
      surface: "fixture-surface",
      chatType: "direct",
      from: "fixture:sender",
      to: "fixture:recipient",
      accountId: "fixture-account",
    },
    deliveryContext: { channel: "fixture-channel", to: "fixture:recipient", accountId: "fixture-account" },
    systemSent: true,
    abortedLastRun: false,
  };
  const expectedToken = payloadToken(payload);
  const shape = { operations: 250000, warmupOperations: 25000, batchSize: 1000 };
  let worker;
  let workerExit;
  let workerError;
  let sentNs = 0;
  let observedChecksum = 0;
  worker = new Worker(new URL(import.meta.url));
  worker.on("error", error => {
    workerError = error;
  });
  workerExit = once(worker, "exit");
  const [ready] = await once(worker, "message");
  assert.equal(ready.ready, true);
  async function phase(operations) {
    let ns = 0;
    let checksum = 0;
    const elapsedStart = performance.now();
    for (let offset = 0; offset < operations; offset += shape.batchSize) {
      const count = Math.min(shape.batchSize, operations - offset);
      const ack = once(worker, "message");
      const started = performance.now();
      for (let index = 0; index < count; index++) worker.postMessage(payload);
      ns += (performance.now() - started) * 1e6;
      worker.postMessage({ __benchmark: "barrier" });
      const [receipt] = await ack;
      assert.equal(receipt.count, count, "Worker did not consume every message");
      assert.equal(receipt.checksum, count * expectedToken, "Worker clone checksum differs");
      checksum += receipt.checksum;
      if (workerError) throw workerError;
    }
    assert.equal(checksum, operations * expectedToken);
    return { synchronousNs: ns, elapsedMs: performance.now() - elapsedStart, checksum };
  }
  try {
    await phase(shape.warmupOperations);
    const cpuBefore = process.cpuUsage();
    const memoryBefore = process.memoryUsage();
    const sample = await phase(shape.operations);
    sentNs = sample.synchronousNs;
    observedChecksum = sample.checksum;
    const cpu = process.cpuUsage(cpuBefore);
    const memoryAfter = process.memoryUsage();
    const maxRssKiB = process.resourceUsage().maxRSS;
    if (worker) {
      worker.postMessage({ __benchmark: "close" });
      const [code] = await workerExit;
      assert.equal(code, 0, "Worker failed clean exit");
      worker = undefined;
    }
    console.log(
      JSON.stringify({
        schema: 1,
        kind,
        name,
        runtime: process.versions,
        operations: shape.operations,
        batchSize: shape.batchSize,
        warmupOperations: shape.warmupOperations,
        synchronousNs: sentNs,
        nsPerOperation: sentNs / shape.operations,
        elapsedMs: sample.elapsedMs,
        checksum: observedChecksum,
        expectedToken,
        cpuMicros: cpu,
        memoryBefore,
        memoryAfter,
        maxRssKiB,
        cleanExit: true,
      }),
    );
  } finally {
    if (worker) await worker.terminate();
  }
}
