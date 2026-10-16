import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
const target = join(process.argv[2], "handles.txt");
fs.writeFileSync(target, "synthetic worker ownership");
const parentFd = fs.openSync(target, "r");
for (const exit of ["terminate", "natural"]) {
  for (const trackUnmanagedFds of [true, false]) {
    const worker = new Worker(
      `
      const fs = require('node:fs');
      const { parentPort, workerData } = require('node:worker_threads');
      (async () => {
        globalThis.handles = await Promise.all(Array.from({length: 8}, () => fs.promises.open(workerData.target, 'r')));
        const closed = handles.pop();
        const closedFd = closed.fd;
        await closed.close();
        await closed.close();
        parentPort.on('message', () => parentPort.close());
        parentPort.postMessage({fds: handles.map(h => h.fd), closedFd});
      })();
    `,
      { eval: true, workerData: { target, parentFd }, trackUnmanagedFds },
    );
    const exited = once(worker, "exit");
    const [{ fds, closedFd }] = await once(worker, "message");
    assert.throws(() => fs.fstatSync(closedFd), { code: "EBADF" });
    // Reuse the slot in the parent: the already-closed handle must not close it again.
    const replacement = fs.openSync(target, "r");
    try {
      for (const fd of fds) assert.equal(fs.fstatSync(fd).ino, fs.statSync(target).ino);
      if (exit === "terminate") await worker.terminate();
      else worker.postMessage("exit");
      await exited;
      for (const fd of fds) assert.throws(() => fs.fstatSync(fd), { code: "EBADF" });
      assert.equal(fs.fstatSync(parentFd).ino, fs.statSync(target).ino);
      assert.equal(fs.fstatSync(replacement).ino, fs.statSync(target).ino);
    } finally {
      fs.closeSync(replacement);
    }
  }
}
fs.closeSync(parentFd);
console.log("FileHandle lifecycle passed");
