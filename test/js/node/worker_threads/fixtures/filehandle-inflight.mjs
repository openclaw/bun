import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
const target = join(process.argv[2], "pending-write.bin");
const worker = new Worker(
  `
  const fs = require('node:fs');
  const { parentPort, workerData } = require('node:worker_threads');
  (async () => {
    globalThis.handle = await fs.promises.open(workerData, 'w+');
    const writes = [];
    for (let i = 0; i < 8; i++) writes.push(handle.write(Buffer.alloc(1 << 20, i + 1), 0, 1 << 20, i << 20));
    parentPort.postMessage(handle.fd);
    parentPort.close();
    await Promise.all(writes);
  })();
`,
  { eval: true, workerData: target },
);
const exited = once(worker, "exit");
const [fd] = await once(worker, "message");
await exited;
assert.throws(() => fs.fstatSync(fd), { code: "EBADF" });
const bytes = fs.readFileSync(target);
assert.equal(bytes.length, 8 << 20);
for (let i = 0; i < 8; i++)
  assert.equal(
    bytes.subarray(i << 20, (i + 1) << 20).every(b => b === i + 1),
    true,
  );
console.log("in-flight natural-exit writes passed");
