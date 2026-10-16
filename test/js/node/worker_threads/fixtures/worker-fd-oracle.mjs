import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { Worker } from "node:worker_threads";

const target = path.join(process.argv[2], "owned.txt");
fs.writeFileSync(target, "worker-fd-oracle");
const parentFd = fs.openSync(target, "r");
const source = `
const fs = require('node:fs');
const { parentPort, workerData } = require('node:worker_threads');
const readParent = () => {
  const buffer = Buffer.alloc(6);
  fs.readSync(workerData.parentFd, buffer, 0, 6, 0);
  return buffer.toString();
};
(async () => {
  let fd;
  if (workerData.kind === 'promise') {
    globalThis.handle = await fs.promises.open(workerData.target, 'r');
    fd = globalThis.handle.fd;
  } else if (workerData.kind === 'callback') {
    fd = await new Promise((resolve, reject) => fs.open(workerData.target, 'r', (err, fd) => err ? reject(err) : resolve(fd)));
  } else {
    fd = fs.openSync(workerData.target, 'r');
  }
  parentPort.on('message', () => parentPort.close());
  parentPort.postMessage({ fd, parent: readParent() });
})();
`;
try {
  for (const exit of ["terminate", "natural"]) {
    for (const kind of ["sync", "callback", "promise"]) {
      for (const trackUnmanagedFds of [undefined, true, false, null]) {
        const worker = new Worker(source, { eval: true, workerData: { target, parentFd, kind }, trackUnmanagedFds });
        const exited = once(worker, "exit");
        const [message] = await once(worker, "message");
        assert.equal(message.parent, "worker");
        assert.equal(fs.fstatSync(message.fd).ino, fs.statSync(target).ino);
        if (exit === "terminate") await worker.terminate();
        else worker.postMessage("exit");
        await exited;
        if (trackUnmanagedFds !== false || kind === "promise") {
          assert.throws(() => fs.fstatSync(message.fd), { code: "EBADF" });
        } else {
          assert.equal(fs.fstatSync(message.fd).ino, fs.statSync(target).ino);
          fs.closeSync(message.fd);
        }
        assert.equal(fs.fstatSync(parentFd).ino, fs.statSync(target).ino);
      }
    }
  }
  for (const parentTracking of [true, false]) {
    for (const childTracking of [true, false]) {
      const outer = new Worker(
        `
        const { Worker, parentPort, workerData } = require('node:worker_threads');
        const nested = new Worker(workerData.source, {
          eval: true, workerData: { ...workerData, kind: 'sync' },
          trackUnmanagedFds: workerData.childTracking,
        });
        nested.on('error', error => { throw error; });
        nested.on('message', message => parentPort.postMessage(message));
        parentPort.on('message', () => nested.postMessage('exit'));
        nested.on('exit', () => { parentPort.postMessage('exited'); parentPort.close(); });
      `,
        { eval: true, workerData: { target, parentFd, source, childTracking }, trackUnmanagedFds: parentTracking },
      );
      const exited = once(outer, "exit");
      const [message] = await once(outer, "message");
      assert.equal(fs.fstatSync(message.fd).ino, fs.statSync(target).ino);
      const nestedExited = once(outer, "message");
      outer.postMessage("exit");
      assert.deepEqual(await nestedExited, ["exited"]);
      if (parentTracking || childTracking) {
        assert.throws(() => fs.fstatSync(message.fd), { code: "EBADF" });
      } else {
        assert.equal(fs.fstatSync(message.fd).ino, fs.statSync(target).ino);
        fs.closeSync(message.fd);
      }
      await exited;
    }
  }
} finally {
  fs.closeSync(parentFd);
}
console.log("worker fd oracle passed");
