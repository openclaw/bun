import assert from "node:assert/strict";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { getHeapStatistics, serialize } from "node:v8";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";

const MiB = 1024 * 1024;
const bytes = 16 * MiB;
const collect = () => (globalThis.Bun ? Bun.gc(true) : globalThis.gc());
const tick = () => new Promise(resolve => setImmediate(resolve));
function sample() {
  const m = process.memoryUsage();
  const v = getHeapStatistics();
  return {
    arrayBuffers: m.arrayBuffers,
    external: m.external,
    external_memory: v.external_memory,
    heapUsed: m.heapUsed,
    heapTotal: m.heapTotal,
    used_heap_size: v.used_heap_size,
    total_heap_size: v.total_heap_size,
  };
}
function externalDelta(after, before, expected, label) {
  for (const key of ["external", "external_memory"])
    assert.ok(
      Math.abs(after[key] - before[key] - expected) < 65536,
      `${label} ${key}: ${after[key] - before[key]} != ${expected}`,
    );
}
async function settle() {
  await tick();
  collect();
  await tick();
  collect();
}
async function lifecycle(kind) {
  if (["file", "blob", "response", "serialize", "serialize-buffer"].includes(kind)) return nativeOutput(kind);
  const isWasm = kind === "wasm" || kind === "wasm-shared";
  if (isWasm) {
    globalThis.warmWasm = new WebAssembly.Memory({ initial: 1, maximum: 256, shared: kind === "wasm-shared" });
    warmWasm.buffer;
  }
  const native =
    kind === "native" ? createRequire(import.meta.url)("../../../napi/napi-app/build/Debug/napitests.node") : undefined;
  await settle();
  const rows = [];
  if (kind === "fast") {
    function alloc(n) {
      return new Uint8Array(n);
    }
    globalThis.warm = Array.from({ length: 100000 }, () => alloc(128));
    await settle();
    rows.push(sample());
    globalThis.held = Array.from({ length: 8192 }, () => alloc(512));
  } else {
    rows.push(sample());
    if (kind === "typed") globalThis.held = new Uint8Array(bytes);
    if (kind === "buffer") globalThis.held = Buffer.alloc(bytes);
    if (kind === "native") globalThis.held = native.create_external_arraybuffer_for_transfer(bytes);
    if (["arraybuffer", "detach", "views", "resize-transfer"].includes(kind)) globalThis.held = new ArrayBuffer(bytes);
    if (kind === "resizable") globalThis.held = new ArrayBuffer(4 * MiB, { maxByteLength: bytes });
    if (kind === "shared") globalThis.held = new SharedArrayBuffer(bytes);
    if (kind === "growable") globalThis.held = new SharedArrayBuffer(4 * MiB, { maxByteLength: bytes });
    if (isWasm) globalThis.held = new WebAssembly.Memory({ initial: 64, maximum: 256, shared: kind === "wasm-shared" });
  }
  const expectedBuffers =
    kind === "resizable" || kind === "growable" || kind === "native" || isWasm ? 0 : kind === "fast" ? 4 * MiB : bytes;
  const expectedExternal =
    kind === "shared" || kind === "growable" || kind === "wasm-shared"
      ? 0
      : kind === "resizable" || kind === "wasm"
        ? 4 * MiB
        : kind === "native"
          ? bytes
          : expectedBuffers;
  rows.push(sample());
  assert.equal(rows[1].arrayBuffers - rows[0].arrayBuffers, expectedBuffers, `${kind} arrayBuffers before GC`);
  externalDelta(rows[1], rows[0], expectedExternal, `${kind} allocation`);
  assert.ok(rows[1].heapUsed - rows[0].heapUsed < 3 * MiB, `${kind} payload entered JS heap`);
  assert.ok(rows[1].used_heap_size - rows[0].used_heap_size < 3 * MiB, `${kind} payload entered v8 JS heap`);
  if (kind === "typed") {
    globalThis.materialized = held.buffer;
    assert.equal(sample().arrayBuffers, rows[1].arrayBuffers, "materialization counted twice");
    externalDelta(sample(), rows[1], 0, "materialization");
  }
  if (kind === "resizable") {
    held.resize(12 * MiB);
    assert.equal(sample().arrayBuffers, rows[0].arrayBuffers);
    externalDelta(sample(), rows[0], 12 * MiB, "grown");
    held.resize(2 * MiB);
    externalDelta(sample(), rows[0], 2 * MiB, "shrunk");
    globalThis.received = held.transferToFixedLength();
    assert.equal(held.byteLength, 0);
    assert.equal(sample().arrayBuffers - rows[0].arrayBuffers, 2 * MiB, "fixed transfer allocates");
    externalDelta(sample(), rows[0], 2 * MiB, "fixed transfer");
  }
  if (kind === "growable") {
    held.grow(12 * MiB);
    assert.equal(sample().arrayBuffers, rows[0].arrayBuffers);
    externalDelta(sample(), rows[0], 0, "shared growth");
  }
  if (kind === "detach") {
    globalThis.received = structuredClone(held, { transfer: [held] });
    assert.equal(held.byteLength, 0);
    assert.equal(sample().arrayBuffers, rows[1].arrayBuffers);
    externalDelta(sample(), rows[1], 0, "local transfer");
  }
  if (kind === "views") {
    globalThis.aliases = [
      new Uint8Array(held),
      new Uint32Array(held, 4, 64),
      new DataView(held, 1, 128),
      Buffer.from(held),
    ];
    aliases.push(aliases[0].subarray(3, 64));
    assert.equal(sample().arrayBuffers, rows[1].arrayBuffers, "views share one allocation");
    externalDelta(sample(), rows[1], 0, "views share one holder");
  }
  if (kind === "resize-transfer") {
    globalThis.received = held.transfer(bytes / 2);
    assert.equal(held.byteLength, 0);
    assert.equal(sample().arrayBuffers - rows[0].arrayBuffers, bytes / 2, "resized transfer replaces allocation");
    externalDelta(sample(), rows[0], bytes / 2, "resized transfer");
    globalThis.received = received.transfer(0);
    assert.equal(sample().arrayBuffers, rows[0].arrayBuffers, "zero transfer frees allocation");
    externalDelta(sample(), rows[0], 0, "zero transfer");
  }
  if (isWasm) {
    globalThis.materialized = held.buffer;
    externalDelta(sample(), rows[0], expectedExternal, "wasm buffer exposure");
    held.grow(128);
    const grownExternal = kind === "wasm" ? 12 * MiB : 0;
    externalDelta(sample(), rows[0], grownExternal, "wasm growth before buffer exposure");
    globalThis.materialized = held.buffer;
    globalThis.held = null;
    await settle();
    externalDelta(sample(), rows[0], grownExternal, "wasm backing storage outlives memory wrapper");
    assert.equal(sample().arrayBuffers, rows[0].arrayBuffers, "wasm bypasses ArrayBuffer allocator");
  }
  collect();
  rows.push(sample());
  assert.ok(rows[2].heapUsed - rows[0].heapUsed < 3 * MiB, `${kind} collected payload entered JS heap`);
  globalThis.held = globalThis.materialized = globalThis.received = globalThis.aliases = null;
  await settle();
  rows.push(sample());
  assert.equal(rows[3].arrayBuffers, rows[0].arrayBuffers, `${kind} release`);
  externalDelta(rows[3], rows[0], 0, `${kind} release`);
  globalThis.warm = null;
  globalThis.warmWasm = null;
  return rows;
}

async function allocateNativeOutput(kind, isSerializer) {
  if (kind === "file") globalThis.held = readFileSync(isMainThread ? process.argv[3] : workerData.path);
  if (kind === "blob" || kind === "response") globalThis.held = await nativeInput.arrayBuffer();
  if (isSerializer) globalThis.held = serialize(nativeInput);
  // Return a scalar so the measuring async frame cannot retain the output during release checks.
  return held.byteLength;
}

async function nativeOutput(kind) {
  const isSerializer = kind === "serialize" || kind === "serialize-buffer";
  if (kind === "blob") globalThis.nativeInput = new Blob([new Uint8Array(bytes)]);
  if (kind === "response") globalThis.nativeInput = new Response("x".repeat(bytes));
  if (kind === "serialize") globalThis.nativeInput = new Uint8Array(bytes);
  if (kind === "serialize-buffer") globalThis.nativeInput = Buffer.alloc(bytes);
  await settle();
  const before = sample();
  const length = await allocateNativeOutput(kind, isSerializer);
  await settle();
  const retained = sample();
  if (isSerializer) {
    assert.ok(held.buffer instanceof ArrayBuffer, "serializer Buffer has unshared backing storage");
    assert.equal(retained.arrayBuffers, before.arrayBuffers, "serializer storage is external to the allocator");
    externalDelta(retained, before, length, "serializer backing store");
  } else {
    assert.ok(retained.arrayBuffers >= length, `${kind} native output is counted`);
    if (kind !== "response")
      assert.equal(retained.arrayBuffers - before.arrayBuffers, length, `${kind} native allocation origin`);
  }
  globalThis.nativeInput = null;
  await settle();
  const isolated = sample();
  globalThis.held = null;
  await settle();
  const released = sample();
  assert.equal(
    isolated.arrayBuffers - released.arrayBuffers,
    isSerializer ? 0 : length,
    `${kind} origin release`,
  );
  externalDelta(released, isolated, -length, `${kind} external release`);
  return [before, retained, isolated, released];
}

// Keep JIT compilation of the busy loop separate from this large fixture.
function spinUntilReleased(flag) {
  while (!Atomics.load(flag, 0)) {}
}

function warmReporting() {
  // Compile the reporting path before measuring backing-store changes.
  for (let i = 0; i < 64; i++) sample();
}

async function warmWorkerLifecycle() {
  // Worker and stdio teardown also compile code charged as native overhead.
  const worker = new Worker(
    'const { parentPort } = require("node:worker_threads"); parentPort.on("message", () => {}); parentPort.postMessage("ready");',
    { eval: true },
  );
  try {
    await once(worker, "message");
  } finally {
    await worker.terminate();
  }
}

const kind = isMainThread ? process.argv[2] : typeof workerData === "string" ? workerData : workerData.kind;
warmReporting();
if (!isMainThread && ["busy", "wait", "shutdown", "startup"].includes(kind)) {
  // Finish startup work before comparing snapshots of a fresh allocation.
  if (kind === "busy" || kind === "wait") await settle();
  globalThis.held = new Uint8Array(bytes);
  const flag = new Int32Array(workerData.shared);
  parentPort.postMessage(sample());
  if (kind === "wait") {
    assert.equal(Atomics.wait(flag, 0, 0), "ok");
  } else {
    spinUntilReleased(flag);
  }
  parentPort.postMessage("released");
} else if (!isMainThread && kind === "transfer") {
  await settle();
  parentPort.postMessage(sample());
  parentPort.on("message", async message => {
    if (message instanceof ArrayBuffer) {
      globalThis.held = message;
      // Only held should retain the payload when the later release command runs.
      message = null;
      parentPort.postMessage(sample());
    } else if (message === "release") {
      globalThis.held = null;
      await settle();
      parentPort.postMessage(sample());
    }
  });
} else if (!isMainThread && kind === "owner-exit") {
  parentPort.once("message", () => {
    globalThis.held = new ArrayBuffer(bytes);
    parentPort.postMessage(held, [held]);
  });
  parentPort.postMessage("ready");
} else if (!isMainThread) {
  parentPort.postMessage(await lifecycle(kind));
} else if (kind === "shutdown" || kind === "startup") {
  const shared = new SharedArrayBuffer(4);
  const worker = new Worker(new URL(import.meta.url), { workerData: { kind, shared } });
  let timer;
  try {
    if (kind === "shutdown") await once(worker, "message");
    const requests = Array.from({ length: 32 }, () =>
      worker.getHeapStatistics().then(
        stats => ({ used: stats.used_heap_size }),
        error => ({ code: error.code }),
      ),
    );
    const ending = kind === "shutdown" ? worker.terminate() : undefined;
    const results = await Promise.race([
      Promise.all(requests),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${kind} requests did not settle`)), 1500);
      }),
    ]);
    for (const result of results) {
      if ("code" in result) assert.equal(result.code, "ERR_WORKER_NOT_RUNNING");
      else assert.ok(result.used >= 0);
    }
    await ending;
    console.log(JSON.stringify({ kind, results }));
  } finally {
    clearTimeout(timer);
    Atomics.store(new Int32Array(shared), 0, 1);
    await worker.terminate();
  }
} else if (kind === "busy" || kind === "wait") {
  const shared = new SharedArrayBuffer(4);
  const flag = new Int32Array(shared);
  const worker = new Worker(new URL(import.meta.url), { workerData: { kind, shared } });
  let timer;
  try {
    const self = (await once(worker, "message"))[0];
    const start = performance.now();
    const stats = await Promise.race([
      Promise.all(Array.from({ length: 32 }, () => worker.getHeapStatistics())),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${kind} worker snapshot blocked`)), 1500);
      }),
    ]);
    clearTimeout(timer);
    for (const stat of stats) {
      assert.ok(stat.external_memory >= bytes, "fresh external payload");
      assert.ok(
        Math.abs(stat.external_memory - self.external_memory) < 65536,
        "worker-local and parent snapshot agree",
      );
      assert.ok(stat.total_heap_size >= stat.used_heap_size);
    }
    const released = once(worker, "message");
    if (kind === "wait") {
      // Keep the expected value unchanged until a notification reaches a parked waiter.
      while (Atomics.notify(flag, 0, 1) !== 1) {
        assert.ok(performance.now() - start < 1500, "worker did not enter its atomic wait");
        await tick();
      }
    } else Atomics.store(flag, 0, 1);
    assert.equal((await released)[0], "released", "inspection preserves wait result");
    console.log(JSON.stringify({ kind, elapsedMs: performance.now() - start, self, stats }));
  } finally {
    clearTimeout(timer);
    Atomics.store(flag, 0, 1);
    Atomics.notify(flag, 0);
    await worker.terminate();
  }
} else if (kind === "transfer") {
  const worker = new Worker(new URL(import.meta.url), { workerData: kind });
  try {
    const workerBefore = (await once(worker, "message"))[0];
    await settle();
    const before = sample();
    globalThis.held = new ArrayBuffer(bytes);
    const response = once(worker, "message");
    worker.postMessage(held, [held]);
    assert.equal(held.byteLength, 0);
    const sent = sample();
    assert.equal(sent.arrayBuffers - before.arrayBuffers, bytes, "origin charge follows allocator");
    externalDelta(sent, before, 0, "sender after transfer");
    const received = (await response)[0];
    assert.equal(received.arrayBuffers, workerBefore.arrayBuffers, "receiver did not allocate");
    externalDelta(received, workerBefore, bytes, "receiver");
    assert.ok(received.heapUsed - workerBefore.heapUsed < 3 * MiB, "transfer pressure is not JS heap");
    assert.ok(received.used_heap_size - workerBefore.used_heap_size < 3 * MiB, "transfer pressure is not V8 heap");
    const parentRead = await worker.getHeapStatistics();
    assert.ok(Math.abs(parentRead.external_memory - received.external_memory) < 65536);
    globalThis.held = null;
    await settle();
    assert.equal(sample().arrayBuffers - before.arrayBuffers, bytes, "sender GC preserves origin");
    const release = once(worker, "message");
    worker.postMessage("release");
    await release;
    await settle();
    assert.equal(sample().arrayBuffers, before.arrayBuffers, "receiver frees origin charge");
    console.log(JSON.stringify({ kind, before, sent, received, parentRead, after: sample() }));
  } finally {
    await worker.terminate();
  }
} else if (kind === "owner-exit") {
  await warmWorkerLifecycle();
  const worker = new Worker(new URL(import.meta.url), { workerData: kind });
  try {
    assert.equal((await once(worker, "message"))[0], "ready");
    await settle();
    const before = sample();
    let received = once(worker, "message");
    worker.postMessage("allocate");
    globalThis.held = (await received)[0];
    // The fulfilled events.once promise otherwise retains the transferred buffer.
    received = null;
    await worker.terminate();
    assert.equal(held.byteLength, bytes);
    assert.equal(sample().arrayBuffers, before.arrayBuffers, "allocator exit does not move charge");
    externalDelta(sample(), before, bytes, "allocator exited");
    await settle();
    const retained = sample();
    globalThis.held = null;
    await settle();
    externalDelta(sample(), retained, -bytes, "allocator exited and storage freed");
    console.log(JSON.stringify({ kind, before, retained, after: sample() }));
  } finally {
    await worker.terminate();
  }
} else {
  const main = await lifecycle(kind);
  const worker = new Worker(new URL(import.meta.url), { workerData: { kind, path: process.argv[3] } });
  try {
    const workerRows = (await once(worker, "message"))[0];
    console.log(JSON.stringify({ kind, main, worker: workerRows }));
  } finally {
    await worker.terminate();
  }
}
