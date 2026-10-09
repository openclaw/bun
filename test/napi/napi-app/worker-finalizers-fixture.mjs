import assert from "node:assert/strict";
import {
  Worker,
  isMainThread,
  parentPort,
  workerData,
  MessageChannel,
  BroadcastChannel,
  SHARE_ENV,
} from "node:worker_threads";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const addon = require("./build/Debug/test_worker_finalizers.node");
const expectedStrings = [
  Buffer.alloc(4096, "x").toString(),
  Buffer.alloc(2048 * 2, "λ", "utf16le").toString("utf16le"),
];
const assertStrings = strings => assert.deepEqual(strings, expectedStrings);

if (!isMainThread && workerData.receiver) {
  const strings =
    workerData.route === "workerData"
      ? workerData.strings
      : workerData.route === "argv"
        ? process.argv.slice(-2)
        : [process.env.NAPI_EXTERNAL_LATIN, process.env.NAPI_EXTERNAL_UTF16];
  assertStrings(strings);
  workerData.port.postMessage(strings);
  workerData.port.close();
} else if (!isMainThread) {
  globalThis.held = addon.make(() => {});
  let strings = [held[3], held[4]];
  parentPort.on("message", () => {
    if (workerData.route === "gc-before-exit") {
      globalThis.held = null;
      strings = null;
      if (globalThis.Bun) Bun.gc(true);
      else globalThis.gc();
    }
    process.exit(0);
  });
  switch (workerData.route) {
    case "retained":
      parentPort.postMessage(null);
      break;
    case "gc-before-exit":
      parentPort.postMessage(null);
      break;
    case "latin":
      parentPort.postMessage(strings[0]);
      break;
    case "utf16":
      parentPort.postMessage(strings[1]);
      break;
    case "array":
      parentPort.postMessage(strings);
      break;
    case "object":
      parentPort.postMessage({ latin: strings[0], utf16: strings[1] });
      break;
    case "nested":
      parentPort.postMessage([0, { latin: strings[0], utf16: strings[1] }]);
      break;
    case "map":
      parentPort.postMessage(new Map([["strings", strings]]));
      break;
    case "structured":
      parentPort.postMessage(structuredClone(strings));
      break;
    case "keys":
      parentPort.postMessage({ [strings[0]]: strings[1] });
      break;
    case "object-url":
      parentPort.postMessage(strings.map(name => URL.createObjectURL(new File(["body"], name))));
      break;
    case "transfer": {
      const buffer = new ArrayBuffer(8);
      parentPort.postMessage({ strings, buffer }, [buffer]);
      break;
    }
    case "invalid-transfer":
      assert.throws(() => parentPort.postMessage(null, [strings[0]]), { name: "DataCloneError" });
      parentPort.postMessage(strings);
      break;
    case "shared": {
      const buffer = new SharedArrayBuffer(4);
      Atomics.store(new Int32Array(buffer), 0, 42);
      parentPort.postMessage({ strings, buffer });
      break;
    }
    case "port":
      workerData.port.postMessage(strings);
      workerData.port.close();
      break;
    case "broadcast": {
      const channel = new BroadcastChannel(workerData.channel);
      channel.postMessage(strings);
      channel.close();
      break;
    }
    case "workerData":
    case "env":
    case "share-env":
    case "argv": {
      if (workerData.route === "share-env") {
        process.env.NAPI_EXTERNAL_LATIN = strings[0];
        process.env.NAPI_EXTERNAL_UTF16 = strings[1];
      }
      const receiver = new Worker(new URL(import.meta.url), {
        workerData: {
          receiver: true,
          route: workerData.route,
          port: workerData.port,
          strings: workerData.route === "workerData" ? strings : undefined,
        },
        transferList: [workerData.port],
        env:
          workerData.route === "share-env"
            ? SHARE_ENV
            : workerData.route === "env"
              ? { NAPI_EXTERNAL_LATIN: strings[0], NAPI_EXTERNAL_UTF16: strings[1] }
              : undefined,
        argv: workerData.route === "argv" ? strings : undefined,
      });
      receiver.on("error", error => {
        throw error;
      });
      break;
    }
    default:
      throw new Error(`unknown route ${workerData.route}`);
  }
} else if (process.argv[2] === "main") {
  globalThis.held = addon.make(() => {});
  console.log("registered");
  if (process.argv[3] === "explicit") process.exit(0);
} else if (process.argv[2] === "copy-cost") {
  const { BunString_crossThreadCopyBytes: copyBytes } = require("bun:internal-for-testing");
  globalThis.held = addon.make(() => {});
  assert.equal(copyBytes(held[3]), 4096);
  assert.equal(copyBytes(held[4]), 4096);
  const cloned = structuredClone([held[3], held[4]]);
  assert.equal(copyBytes(cloned[0]), 0);
  assert.equal(copyBytes(cloned[1]), 0);
  assert.equal(copyBytes(Buffer.alloc(4096, "x").toString()), 0);
  assert.equal(copyBytes(expectedStrings[0], true), 0);
  assert.equal(copyBytes(expectedStrings[1], true), 0);
  console.log("latin1=4096 utf16=4096 received=0 ordinary=0");
} else {
  const mode = process.argv[2] ?? "terminate";
  const route = process.argv[3] ?? "retained";
  const repeat = Number(process.argv[4] ?? 1);
  for (let i = 1; i <= repeat; ++i) {
    const usesPort = ["port", "workerData", "env", "share-env", "argv"].includes(route);
    const ports = usesPort ? new MessageChannel() : null;
    const channel = route === "broadcast" ? new BroadcastChannel(`napi-finalizers-${process.pid}-${i}`) : null;
    let resolveMessage, rejectMessage;
    const message = new Promise((resolve, reject) => {
      resolveMessage = resolve;
      rejectMessage = reject;
    });
    if (ports) {
      ports.port1.once("message", resolveMessage);
      ports.port1.once("messageerror", rejectMessage);
    }
    if (channel) channel.onmessage = event => resolveMessage(event.data);
    const worker = new Worker(new URL(import.meta.url), {
      workerData: { route, port: ports?.port2, channel: channel?.name },
      transferList: ports ? [ports.port2] : [],
    });
    if (!usesPort && !channel) worker.once("message", resolveMessage);
    const exited = new Promise((resolve, reject) => {
      worker.once("exit", resolve);
      worker.once("error", reject);
    });
    try {
      const data = await Promise.race([
        message,
        exited.then(code => {
          throw new Error(`early exit ${code}`);
        }),
      ]);
      if (mode === "terminate") assert.equal(await worker.terminate(), 1);
      else {
        worker.postMessage("exit");
        assert.equal(await exited, 0);
      }
      switch (route) {
        case "retained":
          assert.equal(data, null);
          break;
        case "gc-before-exit":
          assert.equal(data, null);
          break;
        case "latin":
          assert.equal(data, expectedStrings[0]);
          break;
        case "utf16":
          assert.equal(data, expectedStrings[1]);
          break;
        case "object":
          assertStrings([data.latin, data.utf16]);
          break;
        case "nested":
          assertStrings([data[1].latin, data[1].utf16]);
          break;
        case "map":
          assertStrings(data.get("strings"));
          break;
        case "keys":
          assertStrings([Object.keys(data)[0], Object.values(data)[0]]);
          break;
        case "object-url": {
          const { resolveObjectURL } = require("node:buffer");
          try {
            const files = data.map(resolveObjectURL);
            assertStrings(files.map(file => file.name));
            assert.deepEqual(await Promise.all(files.map(file => file.text())), ["body", "body"]);
          } finally {
            data.forEach(url => URL.revokeObjectURL(url));
          }
          break;
        }
        case "shared":
          assert.equal(Atomics.load(new Int32Array(data.buffer), 0), 42);
          assertStrings(data.strings);
          break;
        case "transfer":
          assert.equal(data.buffer.byteLength, 8);
          assertStrings(data.strings);
          break;
        default:
          assertStrings(data);
      }
      const observed = addon.stats();
      assert.deepEqual(observed, {
        counts: Array(10).fill(i),
        nullEnv: [0, 0, 0, route === "gc-before-exit" ? 0 : i, route === "gc-before-exit" ? 0 : i, 0, 0, i, 0, 0],
        liveFds: 0,
        offThread: 0,
        reentered: 0,
        unexpectedStatus: 0,
      });
    } finally {
      await worker.terminate();
      ports?.port1.close();
      channel?.close();
    }
  }
  console.log(`ok ${mode} ${route} ${repeat}`);
}
