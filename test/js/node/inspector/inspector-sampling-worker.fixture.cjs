const assert = require("node:assert/strict");
const { Worker, isMainThread, parentPort } = require("node:worker_threads");
const { Session } = require("node:inspector/promises");
async function run() {
  const session = new Session();
  session.connect();
  try {
    if (isMainThread) {
      await session.post("HeapProfiler.startSampling", { samplingInterval: 1024 });
      const worker = new Worker(__filename);
      try {
        await new Promise((resolve, reject) => {
          let result;
          worker.on("error", reject);
          worker.on("message", async message => {
            try {
              if (message === "ready") {
                await session.post("HeapProfiler.stopSampling");
                worker.postMessage("finish");
              } else result = message;
            } catch (error) {
              reject(error);
            }
          });
          worker.once("exit", code => {
            try {
              assert.equal(code, 0);
              assert(result?.samples > 0 && result?.bytes > 100000);
              resolve();
            } catch (error) {
              reject(error);
            }
          });
        });
      } finally {
        await worker.terminate();
      }
      console.log("worker allocation sampling passed");
    } else {
      await session.post("HeapProfiler.startSampling", {
        samplingInterval: 1024,
        includeObjectsCollectedByMajorGC: true,
        includeObjectsCollectedByMinorGC: true,
      });
      parentPort.postMessage("ready");
      await new Promise(resolve => parentPort.once("message", resolve));
      let retained = Array.from({ length: 20000 }, (_, i) => ({ i, a: i + 1, b: i + 2 }));
      assert.equal(retained.length, 20000);
      retained = undefined;
      await session.post("HeapProfiler.collectGarbage");
      const { profile } = await session.post("HeapProfiler.stopSampling");
      const sum = node => node.selfSize + node.children.reduce((n, child) => n + sum(child), 0);
      parentPort.postMessage({ samples: profile.samples.length, bytes: sum(profile.head) });
      parentPort.close();
    }
  } finally {
    session.disconnect();
  }
}
run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
