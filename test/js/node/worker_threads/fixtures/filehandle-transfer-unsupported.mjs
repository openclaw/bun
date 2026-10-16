import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
const target = join(process.argv[2], "transfer.txt");
fs.writeFileSync(target, "still owned");
const worker = new Worker(
  `
  const fs = require('node:fs');
  const { parentPort, workerData } = require('node:worker_threads');
  (async () => {
    const handle = await fs.promises.open(workerData, 'r');
    let error;
    try { parentPort.postMessage(handle, [handle]); }
    catch (e) { error = {name: e.name, code: e.code, message: e.message}; }
    const content = await handle.readFile('utf8');
    await handle.close();
    parentPort.postMessage({error, content});
    parentPort.close();
  })();
`,
  { eval: true, workerData: target },
);
const exited = once(worker, "exit");
const [result] = await once(worker, "message");
assert.deepEqual(result, {
  error: { name: "DataCloneError", code: 25, message: "Found invalid value in transferList." },
  content: "still owned",
});
await exited;
console.log("unsupported transfer unchanged");
