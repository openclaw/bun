import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { bunEnv, bunExe, tempDir } from "harness";
import inspector from "node:inspector";
import inspectorPromises from "node:inspector/promises";

const profileDurationFixture = (mode: "idle" | "busy") => `
import assert from 'node:assert/strict';
import { Session, url } from 'node:inspector/promises';
import { setTimeout as delay } from 'node:timers/promises';
const mode = ${JSON.stringify(mode)};
const session = new Session();
session.connect();
try {
  await session.post('Profiler.enable');
  await session.post('Profiler.setSamplingInterval', { interval: mode === 'idle' ? 1000000000 : 1000 });
  let previousEnd = 0;
  for (let iteration = 0; iteration < 3; iteration++) {
    function beginCapture() { return { result: session.post('Profiler.start') }; }
    const before = performance.now();
    await beginCapture().result;
    const started = performance.now();
    if (mode === 'busy') {
      function work() { let x=0; for (let i=0;i<10000;i++) x += Math.sqrt(i); return x; }
      while (performance.now() - started < 30) work();
    }
    // Elapsed idle time is the behavior under test; no readiness event represents it.
    await delay(25);
    const stopping = performance.now();
    const { profile } = await session.post('Profiler.stop');
    const stopped = performance.now();
    const actual = (profile.endTime - profile.startTime) / 1000;
    assert.ok(actual > 0, JSON.stringify(profile));
    assert.ok(actual >= stopping - started - 0.001, "capture omitted idle time: " + actual);
    assert.ok(actual <= stopped - before + 0.001, "capture exceeds elapsed time: " + actual);
    assert.ok(profile.startTime >= previousEnd);
    previousEnd = profile.endTime;
    assert.ok(profile.samples.length > 0);
    assert.equal(profile.samples.length, profile.timeDeltas.length);
    assert.ok(profile.timeDeltas.every(d => Number.isFinite(d) && d >= 0));
    const ids = new Set(profile.nodes.map(n => n.id));
    assert.ok(profile.samples.every(id => ids.has(id)));
    assert.ok(profile.nodes.some(n => n.callFrame.functionName === 'beginCapture'));
    assert.equal(url(), undefined);
  }
  await session.post('Profiler.disable');
} finally { session.disconnect(); }
console.log('ok');
`;

const heapSnapshotCleanupFixture = `
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Session } from 'node:inspector/promises';
import { Session as CallbackSession } from 'node:inspector';
import path from 'node:path';
import { writeHeapSnapshot } from 'node:v8';
const mode = process.argv[1];
const url = await new Promise((resolve, reject) => {
  process.once('message', resolve);
  process.once('disconnect', () => reject(new Error('parent disconnected before inspector URL')));
});
const socket = new WebSocket(url);
const pending = new Map();
let nextId = 1;
let closing = false;
const fail = error => {
  for (const request of pending.values()) request.reject(error);
  pending.clear();
};
socket.onmessage = event => {
  const message = JSON.parse(event.data);
  const request = pending.get(message.id);
  if (request) {
    pending.delete(message.id);
    request.resolve(message);
  }
};
socket.onerror = () => fail(new Error('inspector socket failed'));
socket.onclose = () => { if (!closing) fail(new Error('inspector socket closed')); };
const post = (method, params) => new Promise((resolve, reject) => {
  if (socket.readyState !== WebSocket.OPEN) return reject(new Error('inspector is not connected'));
  const id = nextId++;
  pending.set(id, { resolve, reject });
  socket.send(JSON.stringify({ id, method, params }));
});
const actor = mode === 'disable-callback' ? new CallbackSession() : new Session();
try {
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(new Error('inspector connection failed')), { once: true });
    socket.addEventListener('close', () => reject(new Error('inspector closed before connecting')), { once: true });
  });
  actor.connect();
  if (mode.endsWith('-enabled')) await actor.post('HeapProfiler.enable');
  globalThis.snapshotCleanupMarker = 'inspector-snapshot-cleanup-marker';
  const snapshot = JSON.parse(readFileSync(writeHeapSnapshot(path.join(process.cwd(), 'capture.heapsnapshot')), 'utf8'));
  const fields = snapshot.snapshot.meta.node_fields;
  const stride = fields.length;
  const nameIndex = fields.indexOf('name');
  const idIndex = fields.indexOf('id');
  const typeIndex = fields.indexOf('type');
  const stringType = snapshot.snapshot.meta.node_types[typeIndex].indexOf('string');
  let heapObjectId;
  for (let offset = 0; offset < snapshot.nodes.length; offset += stride) {
    if (snapshot.nodes[offset + typeIndex] === stringType && snapshot.strings[snapshot.nodes[offset + nameIndex]] === globalThis.snapshotCleanupMarker) {
      // BunV8HeapSnapshotBuilder reserves IDs 1 and 2 for synthetic roots.
      heapObjectId = snapshot.nodes[offset + idIndex] - 2;
      break;
    }
  }
  assert(Number.isInteger(heapObjectId) && heapObjectId > 0, 'snapshot did not contain the marker');
  const before = await post('Heap.getPreview', { heapObjectId });
  assert.equal(before.error, undefined, JSON.stringify(before));
  assert.equal(before.result.string, globalThis.snapshotCleanupMarker);
  if (mode.startsWith('disconnect')) {
    actor.disconnect();
  } else if (mode === 'disable-callback') {
    let completed = false;
    actor.post('HeapProfiler.disable', error => {
      assert.equal(error, null);
      completed = true;
    });
    assert.equal(completed, true);
  } else {
    await actor.post('HeapProfiler.disable');
  }
  // Keep the native observer attached: detaching it could itself clear the snapshot.
  const after = await post('Heap.getPreview', { heapObjectId });
  assert.deepEqual(after.error, {
    code: -32000,
    message: 'No heap snapshot',
    data: [{ code: -32000, message: 'No heap snapshot' }],
  });
  assert.equal(globalThis.snapshotCleanupMarker, 'inspector-snapshot-cleanup-marker');
  console.log(JSON.stringify({ mode, trackedBefore: true, snapshotCleared: true, observerConnected: socket.readyState === WebSocket.OPEN }));
} finally {
  actor.disconnect();
  closing = true;
  socket.close();
  process.disconnect();
}
`;

// Mirrors how vitest's @vitest/coverage-v8 provider drives the inspector: a
// promise Session, Profiler.enable, startPreciseCoverage, evaluating modules
// through node:vm, then takePreciseCoverage.
const coverageVmFixture = `
import { Session } from "node:inspector/promises";
import vm from "node:vm";

const callCount = process.argv[2] === "true";
const detailed = process.argv[3] === "true";

const session = new Session();
session.connect();
await session.post("Profiler.enable");
await session.post("Profiler.startPreciseCoverage", { callCount, detailed });

const code = [
  "function add(a, b) {",
  "  return a + b;",
  "}",
  "function classify(n) {",
  "  if (n < 0) {",
  "    return 'negative';",
  "  }",
  "  return 'positive';",
  "}",
  "function neverCalled(x) {",
  "  return x * 2;",
  "}",
  "({ add, classify, neverCalled });",
].join("\\n");
const url = "file:///inspector-coverage-fixture/virtual.js";
const exported = vm.runInThisContext(code, { filename: url });
exported.add(1, 2);
exported.add(3, 4);
exported.add(5, 6);
exported.classify(1);
exported.classify(2);

const coverage = await session.post("Profiler.takePreciseCoverage");
await session.post("Profiler.stopPreciseCoverage");
await session.post("Profiler.disable");
session.disconnect();

const entry = coverage.result.find(script => script.url === url);
console.log(
  JSON.stringify({
    codeLength: code.length,
    timestampType: typeof coverage.timestamp,
    offsets: {
      addBody: code.indexOf("return a + b"),
      negativeReturn: code.indexOf("'negative'"),
      positiveReturn: code.indexOf("'positive'"),
      neverCalledBody: code.indexOf("x * 2"),
    },
    entry,
  }),
);
`;

const coverageImportFixture = `
import { Session } from "node:inspector/promises";

const session = new Session();
session.connect();
await session.post("Profiler.enable");
await session.post("Profiler.startPreciseCoverage", { callCount: true, detailed: true });

const { double } = await import("./covered-module.mjs");
double(2);
double(3);

const coverage = await session.post("Profiler.takePreciseCoverage");
await session.post("Profiler.stopPreciseCoverage");
session.disconnect();

const entry = coverage.result.find(script => script.url.endsWith("covered-module.mjs"));
console.log(
  JSON.stringify({
    url: entry?.url ?? null,
    functionCounts: entry ? entry.functions.map(f => f.ranges[0].count) : null,
  }),
);
`;

const coveredModuleFixture = `
export function double(x) {
  return x * 2;
}

export function neverCalled(x) {
  return x + 1;
}
`;

// The exported-declaration form makes JSC emit a zero-width basic block past
// the end of the function, and an empty vm script would get a zero-width
// whole-script range (issue #39821).
const zeroWidthRangeFixture = `
import { Session } from "node:inspector/promises";
import vm from "node:vm";

const session = new Session();
session.connect();
await session.post("Profiler.enable");
await session.post("Profiler.startPreciseCoverage", { callCount: true, detailed: true });

const { f } = await import("./exported-fn.mjs");
f(1);
vm.runInThisContext("", { filename: "file:///empty-script.js" });

const coverage = await session.post("Profiler.takePreciseCoverage");
await session.post("Profiler.stopPreciseCoverage");
session.disconnect();

const zeroWidth = [];
let rangeCount = 0;
for (const script of coverage.result) {
  for (const fn of script.functions) {
    for (const range of fn.ranges) {
      rangeCount++;
      if (range.startOffset >= range.endOffset) {
        zeroWidth.push({ url: script.url, ...range });
      }
    }
  }
}
const entry = coverage.result.find(script => script.url.endsWith("exported-fn.mjs"));
console.log(JSON.stringify({ rangeCount, zeroWidth, fixtureRanges: entry?.functions.length ?? 0 }));
`;

// Picks the entry whose primary range most tightly encloses the offset, the
// same way a coverage consumer attributes an AST node to a function.
function entryCoveringOffset(functions: any[], offset: number) {
  let best: any;
  for (const fn of functions) {
    const range = fn.ranges[0];
    if (range.startOffset <= offset && offset < range.endOffset) {
      if (
        !best ||
        range.startOffset > best.ranges[0].startOffset ||
        (range.startOffset === best.ranges[0].startOffset && range.endOffset < best.ranges[0].endOffset)
      ) {
        best = fn;
      }
    }
  }
  return best;
}

describe("node:inspector", () => {
  describe("Session", () => {
    let session: inspector.Session;

    beforeEach(() => {
      session = new inspector.Session();
    });

    afterEach(() => {
      try {
        session.disconnect();
      } catch {
        // Ignore if already disconnected
      }
    });

    test("Session is a constructor", () => {
      expect(inspector.Session).toBeInstanceOf(Function);
      expect(session).toBeInstanceOf(inspector.Session);
    });

    test("Session extends EventEmitter", () => {
      expect(typeof session.on).toBe("function");
      expect(typeof session.emit).toBe("function");
      expect(typeof session.removeListener).toBe("function");
    });

    test("connect() establishes connection", () => {
      expect(() => session.connect()).not.toThrow();
    });

    test("connect() throws if already connected", () => {
      session.connect();
      expect(() => session.connect()).toThrow("already connected");
    });

    test("connectToMainThread() throws ERR_INSPECTOR_NOT_WORKER on the main thread", () => {
      expect(() => session.connectToMainThread()).toThrow(
        expect.objectContaining({ code: "ERR_INSPECTOR_NOT_WORKER" }),
      );
    });

    test("disconnect() closes connection cleanly", () => {
      session.connect();
      expect(() => session.disconnect()).not.toThrow();
    });

    test("disconnect() is a no-op if not connected", () => {
      expect(() => session.disconnect()).not.toThrow();
    });

    test("post() throws if not connected", () => {
      expect(() => session.post("Profiler.enable")).toThrow("not connected");
    });

    test("post() with callback throws synchronously if not connected", async () => {
      let called = false;
      expect(() => session.post("HeapProfiler.collectGarbage", () => (called = true))).toThrow(
        expect.objectContaining({ code: "ERR_INSPECTOR_NOT_CONNECTED", message: "Session is not connected" }),
      );
      await Promise.resolve();
      expect(called).toBe(false);
    });
  });

  describe("HeapProfiler", () => {
    test.each([
      "disable-enabled",
      "disable-unenabled",
      "disconnect-enabled",
      "disconnect-unenabled",
      "disable-callback",
    ])("%s releases native snapshot metadata with another observer connected", async mode => {
      using directory = tempDir("inspector-heap-snapshot-cleanup", {});
      await using proc = Bun.spawn({
        cmd: [bunExe(), "--inspect=127.0.0.1:0", "-e", heapSnapshotCleanupFixture, mode],
        env: bunEnv,
        cwd: String(directory),
        ipc() {},
        stdout: "pipe",
        stderr: "pipe",
      });
      const stderrPromise = (async () => {
        let stderr = "";
        let sent = false;
        for await (const chunk of proc.stderr) {
          stderr += new TextDecoder().decode(chunk);
          const url = stderr.match(/ws:\/\/127\.0\.0\.1:\d+\/[^\s]+/)?.[0];
          if (url && !sent) {
            sent = true;
            proc.send(url);
          }
        }
        return stderr;
      })();
      const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), stderrPromise, proc.exited]);
      expect({ stdout, exitCode }, stderr).toEqual({
        stdout: JSON.stringify({ mode, trackedBefore: true, snapshotCleared: true, observerConnected: true }) + "\n",
        exitCode: 0,
      });
    });

    test("allocation sampling reports integral bytes for live and stopped profiles", async () => {
      await using proc = Bun.spawn({
        cmd: [
          bunExe(),
          "--input-type=module",
          "-e",
          `
import assert from 'node:assert/strict';
import { Session } from 'node:inspector/promises';
const session = new Session();
session.connect();
function allocateHeapProfileWorkload() {
  const retained = [];
  for (let i = 0; i < 8; i++) {
    const row = [];
    row.length = 131072;
    row.fill(i);
    retained.push(row);
  }
  return retained;
}
function validate(profile) {
  const nodes = [profile.head];
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    assert(Number.isSafeInteger(node.selfSize) && node.selfSize >= 0, 'fractional node byte size: ' + node.selfSize);
    nodes.push(...node.children);
  }
  const allocated = nodes.filter(node => node.callFrame.functionName === 'allocateHeapProfileWorkload' && node.selfSize > 0);
  assert(allocated.length > 0, 'allocation site missing');
  assert(profile.samples.some(sample => allocated.some(node => node.id === sample.nodeId)), 'allocation samples missing');
  for (const sample of profile.samples) {
    assert(Number.isSafeInteger(sample.size) && sample.size > 0, 'fractional sample byte size: ' + sample.size);
  }
}
try {
  await session.post('HeapProfiler.startSampling', { samplingInterval: 65536 });
  globalThis.retainedHeapProfileWorkload = allocateHeapProfileWorkload();
  validate((await session.post('HeapProfiler.getSamplingProfile')).profile);
  validate((await session.post('HeapProfiler.stopSampling')).profile);
} finally {
  session.disconnect();
  delete globalThis.retainedHeapProfileWorkload;
}
console.log('integral allocation bytes passed');
`,
        ],
        env: bunEnv,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
      expect(stdout).toBe("integral allocation bytes passed\n");
      expect(stderr).toBe("");
      expect(exitCode).toBe(0);
    });

    test("worker allocation sampling is independent of the main VM", async () => {
      await using proc = Bun.spawn({
        cmd: [bunExe(), import.meta.dir + "/inspector-sampling-worker.fixture.cjs"],
        env: bunEnv,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
      expect({ stdout, stderr, exitCode }).toEqual({
        stdout: "worker allocation sampling passed\n",
        stderr: "",
        exitCode: 0,
      });
    });

    test("byte allocation sampling retains collected samples, tracks live samples, and matches Session lifecycle", async () => {
      await using proc = Bun.spawn({
        cmd: [
          bunExe(),
          "--input-type=module",
          "-e",
          `
import assert from 'node:assert/strict';
import { Session } from 'node:inspector/promises';
import { Session as CallbackSession } from 'node:inspector';
const session = new Session();
session.connect();
let retained;
function allocateObjects(count) {
  retained = Array.from({ length: count }, (_, index) => ({ index, x: index + 1, y: index + 2 }));
}
function allocateArrays(count) {
  retained = Array.from({ length: count }, (_, index) => [index, index + 1, index + 2]);
}
function total(node, name) {
  return (node.callFrame.functionName === name ? node.selfSize : 0) + node.children.reduce((sum, child) => sum + total(child, name), 0);
}
function validate(profile) {
  const nodes = new Map();
  let bytes = 0;
  const walk = node => {
    assert(!nodes.has(node.id));
    nodes.set(node.id, node);
    assert(node.selfSize >= 0);
    assert.equal(typeof node.callFrame.functionName, 'string');
    assert.equal(typeof node.callFrame.scriptId, 'string');
    assert.equal(typeof node.callFrame.url, 'string');
    assert(Number.isInteger(node.callFrame.lineNumber));
    assert(Number.isInteger(node.callFrame.columnNumber));
    bytes += node.selfSize;
    node.children.forEach(walk);
  };
  walk(profile.head);
  const ordinals = new Set();
  let sampleBytes = 0;
  for (const sample of profile.samples) {
    assert(nodes.has(sample.nodeId));
    assert(sample.size > 0);
    assert(Number.isInteger(sample.ordinal) && sample.ordinal > 0);
    assert(!ordinals.has(sample.ordinal));
    ordinals.add(sample.ordinal);
    sampleBytes += sample.size;
  }
  if (profile.samples.length) {
    assert(bytes > 0 && sampleBytes > 0);
    assert(Math.abs(bytes - sampleBytes) < bytes / 4);
  }
  return bytes;
}
try {
  await assert.rejects(session.post('HeapProfiler.getSamplingProfile'), { code: 'ERR_INSPECTOR_COMMAND' });
  for (let i = 0; i < 30; ++i) { allocateObjects(1000); allocateArrays(1000); }
  retained = undefined;
  await session.post('HeapProfiler.collectGarbage');
  await session.post('HeapProfiler.startSampling', {
    samplingInterval: 1024,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
  // A repeated start keeps existing samples and their ordinals.
  allocateObjects(20000);
  const first = (await session.post('HeapProfiler.getSamplingProfile')).profile;
  assert(validate(first) > 100000);
  await session.post('HeapProfiler.startSampling', { samplingInterval: 32768 });
  allocateArrays(20000);
  retained = undefined;
  await session.post('HeapProfiler.collectGarbage');
  const last = (await session.post('HeapProfiler.stopSampling')).profile;
  assert(validate(last) >= validate(first));
  const byOrdinal = new Map(last.samples.map(sample => [sample.ordinal, sample]));
  for (const sample of first.samples) assert.deepEqual(byOrdinal.get(sample.ordinal), sample);
  assert(total(last.head, 'allocateObjects') + total(last.head, '') > 0);
  assert(last.samples.length > first.samples.length);
  await assert.rejects(session.post('HeapProfiler.stopSampling'), { code: 'ERR_INSPECTOR_COMMAND' });
  // Default flags discard dead allocations rather than strongly retaining them.
  await session.post('HeapProfiler.startSampling', { samplingInterval: 512 });
  allocateObjects(30000);
  const before = validate((await session.post('HeapProfiler.getSamplingProfile')).profile);
  retained = undefined;
  const liveAfter = validate((await session.post('HeapProfiler.getSamplingProfile')).profile);
  assert(liveAfter < before / 3, \`live profile did not collect: \${before} -> \${liveAfter}\`);
  const after = validate((await session.post('HeapProfiler.stopSampling')).profile);
  assert(before > 100000);
  assert(after < before / 3, \`dead samples remain: \${before} -> \${after}\`);
  await session.post('HeapProfiler.startSampling');
  await session.post('HeapProfiler.disable');
  await assert.rejects(session.post('HeapProfiler.getSamplingProfile'), { code: 'ERR_INSPECTOR_COMMAND' });
  await session.post('HeapProfiler.startSampling');
  session.disconnect();
  session.connect();
  await assert.rejects(session.post('HeapProfiler.getSamplingProfile'), { code: 'ERR_INSPECTOR_COMMAND' });
} finally { session.disconnect(); }
const callback = new CallbackSession();
callback.connect();
try {
  for (const [target, name] of [[Math, 'floor'], [Number, 'isFinite']]) {
    const original = target[name];
    let completed = false;
    let callbackError;
    target[name] = () => { throw new Error('mutable numeric builtin called'); };
    try {
      callback.post('HeapProfiler.startSampling', { samplingInterval: 1024.75 }, error => {
        callbackError = error;
        completed = true;
      });
    } finally {
      target[name] = original;
    }
    assert.equal(completed, true);
    assert.equal(callbackError, null);
    callback.post('HeapProfiler.stopSampling', error => assert.equal(error, null));
  }
  for (const [params, message] of [
    [{ samplingInterval: 0 }, '-32000: Invalid sampling interval'],
    [{ samplingInterval: -1 }, '-32000: Invalid sampling interval'],
    [{ samplingInterval: '32' }, '-32602: Invalid parameters'],
    [{ samplingInterval: null }, '-32602: Invalid parameters'],
    [{ samplingInterval: NaN }, '-32602: Invalid parameters'],
    [{ includeObjectsCollectedByMajorGC: 1 }, '-32602: Invalid parameters'],
    [{ includeObjectsCollectedByMinorGC: null }, '-32602: Invalid parameters'],
  ]) {
    let called = false;
    assert.equal(callback.post('HeapProfiler.startSampling', params, (error, result) => {
      called = true;
      assert.equal(error.code, 'ERR_INSPECTOR_COMMAND');
      assert.equal(error.message, 'Inspector error ' + message);
      assert.equal(result, undefined);
    }), undefined);
    assert(called, 'callback was not synchronous');
  }
  assert.equal(callback.post('HeapProfiler.startSampling'), undefined);
  let completed = false;
  callback.post('HeapProfiler.stopSampling', (error, { profile }) => {
    assert.equal(error, null);
    validate(profile);
    completed = true;
  });
  assert(completed);
} finally { callback.disconnect(); }
console.log('allocation sampling contract passed');
`,
        ],
        env: bunEnv,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
      expect({ stdout, stderr, exitCode }).toEqual({
        stdout: "allocation sampling contract passed\n",
        stderr: "",
        exitCode: 0,
      });
    });

    test("enable and disable complete synchronously and return undefined", () => {
      const session = new inspector.Session();
      session.connect();
      try {
        for (const method of [
          "HeapProfiler.disable",
          "HeapProfiler.enable",
          "HeapProfiler.enable",
          "HeapProfiler.disable",
        ]) {
          const replies: unknown[] = [];
          expect(session.post(method, (error, result) => replies.push([error, result]))).toBeUndefined();
          expect(replies).toEqual([[null, {}]]);
          expect(session.post(method)).toBeUndefined();
        }
      } finally {
        session.disconnect();
      }
    });

    test("disconnect settles pending collections once and reconnect isolates the new session", async () => {
      const session = new inspector.Session();
      session.connect();
      const replies: unknown[] = [];
      try {
        const pending = Array.from(
          { length: 2 },
          () =>
            new Promise<void>(resolve => {
              session.post("HeapProfiler.collectGarbage", function (error, result) {
                replies.push([error?.code, error?.message, result, arguments.length]);
                resolve();
              });
            }),
        );
        session.disconnect();
        expect(replies).toEqual([]);
        session.connect();
        await new Promise<void>((resolve, reject) => {
          session.post("HeapProfiler.collectGarbage", (error, result) => {
            if (error) return reject(error);
            replies.push([error, result]);
            resolve();
          });
        });
        await Promise.all(pending);
        expect(replies).toEqual([
          ["ERR_INSPECTOR_CLOSED", "Session was closed", undefined, 1],
          ["ERR_INSPECTOR_CLOSED", "Session was closed", undefined, 1],
          [null, {}],
        ]);
      } finally {
        session.disconnect();
      }
    });

    test.concurrent("a disconnected collection callback throws through nextTick", async () => {
      await using proc = Bun.spawn({
        cmd: [
          bunExe(),
          "-e",
          `
          const assert = require("node:assert/strict");
          const { Session } = require("node:inspector");
          const session = new Session();
          const failure = new Error("closed callback");
          process.once("uncaughtException", error => {
            assert.equal(error, failure);
            console.log("uncaught callback");
          });
          session.connect();
          session.post("HeapProfiler.collectGarbage", function(error) {
            assert.equal(arguments.length, 1);
            assert.equal(error.code, "ERR_INSPECTOR_CLOSED");
            throw failure;
          });
          session.disconnect();
        `,
        ],
        env: bunEnv,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
      expect({ stdout, stderr, exitCode }).toEqual({ stdout: "uncaught callback\n", stderr: "", exitCode: 0 });
    });

    test.concurrent("a main-thread connection in a worker does not collect the worker heap", async () => {
      const workerSource = `
        const assert = require("node:assert/strict");
        (async () => {
          for (const promises of [false, true]) {
            const { Session } = require(promises ? "node:inspector/promises" : "node:inspector");
            const session = new Session();
            const collect = () => promises ? session.post("HeapProfiler.collectGarbage") : new Promise((resolve, reject) => {
              session.post("HeapProfiler.collectGarbage", (error, result) => error ? reject(error) : resolve(result));
            });
            session.connectToMainThread();
            await assert.rejects(collect, {
              code: "ERR_INSPECTOR_COMMAND",
              message: "Inspector error -32601: 'HeapProfiler.collectGarbage' wasn't found",
            });
            session.disconnect();
            session.connect();
            assert.deepEqual(await collect(), {});
            session.disconnect();
          }
          console.log("local-only");
        })().catch(error => { console.error(error); process.exitCode = 1; });
      `;
      await using proc = Bun.spawn({
        cmd: [
          bunExe(),
          "-e",
          `
          const { Worker } = require("node:worker_threads");
          new Worker(${JSON.stringify(workerSource)}, { eval: true })
            .on("error", error => { console.error(error); process.exitCode = 1; })
            .on("exit", code => { process.exitCode = code; });
        `,
        ],
        env: bunEnv,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
      expect({ stdout, stderr, exitCode }).toEqual({ stdout: "local-only\n", stderr: "", exitCode: 0 });
    });

    for (const worker of [false, true]) {
      test.concurrent(
        `collectGarbage reclaims unreachable objects after the posting job (${worker ? "worker" : "main"})`,
        async () => {
          const fixture = `
          const assert = require("node:assert/strict");
          const { Session } = require("node:inspector");
          const { Session: PromiseSession } = require("node:inspector/promises");
          const session = new Session();
          const promised = new PromiseSession();
          session.connect(); promised.connect();
          try {
            const strong = { alive: true };
            const alive = new WeakRef(strong);
            const dead = new WeakRef({ released: true });
            let jobFinished = false;
            const collected = new Promise((resolve, reject) => {
              assert.equal(session.post("HeapProfiler.collectGarbage", (error, result) => {
                try {
                  assert.equal(error, null);
                  assert.deepEqual(result, {});
                  assert.equal(jobFinished, true);
                  assert.equal(dead.deref(), undefined);
                  assert.equal(alive.deref(), strong);
                  resolve();
                } catch (error) { reject(error); }
              }), undefined);
            });
            queueMicrotask(() => { jobFinished = true; });
            await collected;
            assert.deepEqual(await promised.post("HeapProfiler.collectGarbage"), {});
            assert.equal(session.post("HeapProfiler.collectGarbage"), undefined);
            console.log("collected");
          } finally { session.disconnect(); promised.disconnect(); }
        `;
          const source = worker
            ? `const { Worker } = require("node:worker_threads"); new Worker(${JSON.stringify(`(async () => { ${fixture} })().catch(error => { console.error(error); process.exitCode = 1; });`)}, { eval: true }).on("error", error => { console.error(error); process.exitCode = 1; }).on("exit", code => { process.exitCode = code; });`
            : `(async () => { ${fixture} })().catch(error => { console.error(error); process.exitCode = 1; });`;
          await using proc = Bun.spawn({ cmd: [bunExe(), "-e", source], env: bunEnv, stdout: "pipe", stderr: "pipe" });
          const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
          expect({ stdout, stderr, exitCode }).toEqual({ stdout: "collected\n", stderr: "", exitCode: 0 });
        },
      );
    }
  });

  describe("Profiler", () => {
    for (const mode of ["idle", "busy"] as const) {
      for (const worker of [false, true]) {
        test.concurrent(
          `measures the whole ${mode} capture and samples its startup stack (worker: ${worker})`,
          async () => {
            const fixture = profileDurationFixture(mode);
            const source = worker
              ? `import { Worker } from 'node:worker_threads';
               const worker = new Worker(new URL(${JSON.stringify("data:text/javascript," + encodeURIComponent(fixture))}));
               worker.on('error', error => { console.error(error); process.exitCode = 1; });
               worker.on('exit', code => { if (code) process.exitCode = code; });`
              : fixture;
            await using proc = Bun.spawn({
              cmd: [bunExe(), "--input-type=module", "-e", source],
              env: bunEnv,
              stdout: "pipe",
              stderr: "pipe",
            });
            const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
            expect({ stdout, stderr, exitCode }).toEqual({ stdout: "ok\n", stderr: "", exitCode: 0 });
          },
        );
      }
    }
    test.concurrent("includes idle time in an externally started worker CPU profile", async () => {
      await using proc = Bun.spawn({
        cmd: [
          bunExe(),
          "--input-type=module",
          "-e",
          `import assert from 'node:assert/strict';
           import { Worker } from 'node:worker_threads';
           import { setTimeout as delay } from 'node:timers/promises';
           const worker = new Worker(\`const { parentPort } = require('node:worker_threads');
             parentPort.on('message', () => {}); parentPort.postMessage('ready');\`, { eval: true });
           try {
             await new Promise((resolve, reject) => {
               worker.once('message', resolve);
               worker.once('error', reject);
               worker.once('exit', () => reject(new Error('worker exited before ready')));
             });
             const before = performance.now();
             const handle = await worker.startCpuProfile();
             const started = performance.now();
             // The worker stays outside JS: JSC can return no periodic samples.
             await delay(25);
             const stopping = performance.now();
             const profile = JSON.parse(await handle.stop());
             const stopped = performance.now();
             const duration = (profile.endTime - profile.startTime) / 1000;
             assert.ok(duration >= stopping - started - 0.001, JSON.stringify(profile));
             assert.ok(duration <= stopped - before + 0.001);
           } finally { await worker.terminate(); }
           console.log('ok');`,
        ],
        env: bunEnv,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
      expect({ stdout, stderr, exitCode }).toEqual({ stdout: "ok\n", stderr: "", exitCode: 0 });
    });

    let session: inspector.Session;

    beforeEach(() => {
      session = new inspector.Session();
      session.connect();
    });

    afterEach(() => {
      try {
        session.disconnect();
      } catch {
        // Ignore
      }
    });

    test("Profiler.enable succeeds", () => {
      const result: any = session.post("Profiler.enable");
      expect(result).toEqual({});
    });

    test("Profiler.disable succeeds", () => {
      session.post("Profiler.enable");
      const result: any = session.post("Profiler.disable");
      expect(result).toEqual({});
    });

    test("Profiler.start without enable throws", () => {
      expect(() => session.post("Profiler.start")).toThrow("not enabled");
    });

    test("Profiler.start after enable succeeds", () => {
      session.post("Profiler.enable");
      const result: any = session.post("Profiler.start");
      expect(result).toEqual({});
    });

    test("Profiler.stop without start throws", () => {
      session.post("Profiler.enable");
      expect(() => session.post("Profiler.stop")).toThrow("not started");
    });

    test("Profiler.stop returns valid profile", () => {
      session.post("Profiler.enable");
      session.post("Profiler.start");

      // Do some work to generate profile data
      let sum = 0;
      for (let i = 0; i < 10000; i++) {
        sum += Math.sqrt(i);
      }

      const result: any = session.post("Profiler.stop");

      expect(result).toHaveProperty("profile");
      const profile = result.profile;

      // Validate profile structure
      expect(profile).toHaveProperty("nodes");
      expect(profile).toHaveProperty("startTime");
      expect(profile).toHaveProperty("endTime");
      expect(profile).toHaveProperty("samples");
      expect(profile).toHaveProperty("timeDeltas");

      expect(profile.nodes).toBeArray();
      expect(profile.nodes.length).toBeGreaterThanOrEqual(1);

      // First node should be (root)
      const rootNode = profile.nodes[0];
      expect(rootNode).toHaveProperty("id", 1);
      expect(rootNode).toHaveProperty("callFrame");
      expect(rootNode.callFrame).toHaveProperty("functionName", "(root)");
      expect(rootNode.callFrame).toHaveProperty("scriptId", "0");
      expect(rootNode.callFrame).toHaveProperty("url", "");
      expect(rootNode.callFrame).toHaveProperty("lineNumber", -1);
      expect(rootNode.callFrame).toHaveProperty("columnNumber", -1);
    });

    test("complete enable->start->stop workflow", () => {
      // Enable profiler
      const enableResult: any = session.post("Profiler.enable");
      expect(enableResult).toEqual({});

      // Start profiling
      const startResult: any = session.post("Profiler.start");
      expect(startResult).toEqual({});

      // Do some work
      function fibonacci(n: number): number {
        if (n <= 1) return n;
        return fibonacci(n - 1) + fibonacci(n - 2);
      }
      fibonacci(20);

      // Stop profiling
      const stopResult = session.post("Profiler.stop");
      expect(stopResult).toHaveProperty("profile");

      // Disable profiler
      const disableResult: any = session.post("Profiler.disable");
      expect(disableResult).toEqual({});
    });

    test("samples and timeDeltas have same length", () => {
      session.post("Profiler.enable");
      session.post("Profiler.start");

      // Do some work
      let sum = 0;
      for (let i = 0; i < 5000; i++) {
        sum += Math.sqrt(i);
      }

      const result: any = session.post("Profiler.stop");
      const profile = result.profile;

      expect(profile.samples.length).toBe(profile.timeDeltas.length);
    });

    test("samples reference valid node IDs", () => {
      session.post("Profiler.enable");
      session.post("Profiler.start");

      // Do some work
      let sum = 0;
      for (let i = 0; i < 5000; i++) {
        sum += Math.sqrt(i);
      }

      const result: any = session.post("Profiler.stop");
      const profile = result.profile;

      const nodeIds = new Set(profile.nodes.map((n: any) => n.id));
      for (const sample of profile.samples) {
        expect(nodeIds.has(sample)).toBe(true);
      }
    });

    test("Profiler.setSamplingInterval works", () => {
      session.post("Profiler.enable");
      const result: any = session.post("Profiler.setSamplingInterval", { interval: 500 });
      expect(result).toEqual({});
    });

    test("Profiler.setSamplingInterval throws if profiler is running", () => {
      session.post("Profiler.enable");
      session.post("Profiler.start");
      expect(() => session.post("Profiler.setSamplingInterval", { interval: 500 })).toThrow(
        "Cannot change sampling interval while profiler is running",
      );
      session.post("Profiler.stop");
    });

    test("Profiler.setSamplingInterval requires positive interval", () => {
      session.post("Profiler.enable");
      expect(() => session.post("Profiler.setSamplingInterval", { interval: 0 })).toThrow();
      expect(() => session.post("Profiler.setSamplingInterval", { interval: -1 })).toThrow();
    });

    test("double Profiler.start is a no-op", () => {
      session.post("Profiler.enable");
      session.post("Profiler.start");
      const result: any = session.post("Profiler.start");
      expect(result).toEqual({});
      session.post("Profiler.stop");
    });

    test("profiler can be restarted after stop", () => {
      // First run
      session.post("Profiler.enable");
      session.post("Profiler.start");
      let sum = 0;
      for (let i = 0; i < 1000; i++) sum += i;
      const result1: any = session.post("Profiler.stop");
      expect(result1).toHaveProperty("profile");

      // Second run
      session.post("Profiler.start");
      for (let i = 0; i < 1000; i++) sum += i;
      const result2: any = session.post("Profiler.stop");
      expect(result2).toHaveProperty("profile");

      // Both profiles should be valid
      expect(result1.profile.nodes.length).toBeGreaterThanOrEqual(1);
      expect(result2.profile.nodes.length).toBeGreaterThanOrEqual(1);
    });

    test("disconnect() stops running profiler", () => {
      session.post("Profiler.enable");
      session.post("Profiler.start");
      session.disconnect();

      // Create new session and verify profiler was stopped
      const session2 = new inspector.Session();
      session2.connect();
      session2.post("Profiler.enable");

      // This should work without error (profiler is not running)
      const result: any = session2.post("Profiler.setSamplingInterval", { interval: 500 });
      expect(result).toEqual({});
      session2.disconnect();
    });
  });

  describe("callback API", () => {
    test("post() with callback receives result", async () => {
      const session = new inspector.Session();
      session.connect();

      const { promise, resolve } = Promise.withResolvers<any>();
      session.post("Profiler.enable", (err, result) => {
        resolve({ err, result });
      });

      const { err, result } = await promise;
      expect(err).toBeNull();
      expect(result).toEqual({});
      session.disconnect();
    });

    test("post() with callback receives error", async () => {
      const session = new inspector.Session();
      session.connect();

      const { promise, resolve } = Promise.withResolvers<any>();
      session.post("Profiler.start", (err, result) => {
        resolve({ err, result });
      });

      const { err, result } = await promise;
      expect(err).toBeInstanceOf(Error);
      expect(err.message).toContain("not enabled");
      session.disconnect();
    });
  });

  describe("unsupported methods", () => {
    test("unsupported method throws ERR_INSPECTOR_COMMAND", () => {
      const session = new inspector.Session();
      session.connect();
      expect(() => session.post("Runtime.evaluate")).toThrow(
        expect.objectContaining({ code: "ERR_INSPECTOR_COMMAND" }),
      );
      session.disconnect();
    });
  });

  describe("precise coverage", () => {
    test("startPreciseCoverage requires Profiler.enable", () => {
      const session = new inspector.Session();
      session.connect();
      expect(() => session.post("Profiler.startPreciseCoverage")).toThrow("Profiler is not enabled");
      expect(() => session.post("Profiler.stopPreciseCoverage")).toThrow("Profiler is not enabled");
      session.disconnect();
    });

    test("takePreciseCoverage before startPreciseCoverage throws", () => {
      const session = new inspector.Session();
      session.connect();
      session.post("Profiler.enable");
      expect(() => session.post("Profiler.takePreciseCoverage")).toThrow("Precise coverage has not been started.");
      session.disconnect();
    });

    test("Profiler.disable stops precise coverage, like V8", () => {
      const session = new inspector.Session();
      session.connect();
      session.post("Profiler.enable");
      session.post("Profiler.startPreciseCoverage", { callCount: true, detailed: true });
      session.post("Profiler.disable");
      session.post("Profiler.enable");
      expect(() => session.post("Profiler.takePreciseCoverage")).toThrow("Precise coverage has not been started.");
      session.disconnect();
    });

    // Unlike V8 (which has always-on invocation counters), JSC has none, so
    // best-effort coverage is empty until startPreciseCoverage has run in the
    // process (once started, the profiler stays for the VM's lifetime).
    test("getBestEffortCoverage returns [] without a prior startPreciseCoverage", async () => {
      await using proc = Bun.spawn({
        cmd: [
          bunExe(),
          "-e",
          `const { Session } = require("node:inspector");
           const session = new Session();
           session.connect();
           console.log(JSON.stringify(session.post("Profiler.getBestEffortCoverage").result));`,
        ],
        env: bunEnv,
        stderr: "inherit",
      });
      const [stdout, exitCode] = await Promise.all([proc.stdout.text(), proc.exited]);
      expect(stdout).toBe("[]\n");
      expect(exitCode).toBe(0);
    });

    // CDP contract: takePreciseCoverage resets execution counters, so a second
    // take reports the delta rather than the cumulative count.
    test.concurrent("takePreciseCoverage reports counts since the previous take", async () => {
      using dir = tempDir("inspector-coverage-delta", {
        "fixture.mjs": `
import { Session } from "node:inspector/promises";
import vm from "node:vm";
const session = new Session();
session.connect();
await session.post("Profiler.enable");
await session.post("Profiler.startPreciseCoverage", { callCount: true, detailed: true });
const url = "file:///delta-fixture/virtual.js";
const f = vm.runInThisContext("function f(){return 1}; f", { filename: url });
f(); f(); f();
const first = await session.post("Profiler.takePreciseCoverage");
f();
const second = await session.post("Profiler.takePreciseCoverage");
await session.post("Profiler.stopPreciseCoverage");
session.disconnect();
const bodyOffset = "function f(){".length;
const countFor = c => {
  const entry = c.result.find(s => s.url === url);
  // Innermost function entry that covers the body of f().
  const fn = entry?.functions
    .filter(f => f.ranges[0].startOffset <= bodyOffset && bodyOffset < f.ranges[0].endOffset)
    .sort((a, b) => a.ranges[0].endOffset - b.ranges[0].endOffset)[0];
  return fn?.ranges[0].count;
};
console.log(JSON.stringify({ first: countFor(first), second: countFor(second) }));
`,
      });
      await using proc = Bun.spawn({ cmd: [bunExe(), "fixture.mjs"], env: bunEnv, cwd: String(dir), stderr: "pipe" });
      const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
      expect({ stderrIfFailed: exitCode === 0 ? "" : stderr, exitCode }).toEqual({ stderrIfFailed: "", exitCode: 0 });
      expect(JSON.parse(stdout.trim())).toEqual({ first: 3, second: 1 });
    });

    // The VM's profiler outlives a stop, so a later start must re-base its
    // counters: executions between stop and the next start are not reported.
    test.concurrent("startPreciseCoverage after a stop counts from zero", async () => {
      using dir = tempDir("inspector-coverage-restart", {
        "fixture.mjs": `
import { Session } from "node:inspector/promises";
import vm from "node:vm";
const session = new Session();
session.connect();
await session.post("Profiler.enable");
await session.post("Profiler.startPreciseCoverage", { callCount: true, detailed: true });
const url = "file:///restart-fixture/virtual.js";
const f = vm.runInThisContext("function f(){return 1}; f", { filename: url });
f();
await session.post("Profiler.takePreciseCoverage");
await session.post("Profiler.stopPreciseCoverage");
for (let i = 0; i < 100; i++) f();
await session.post("Profiler.startPreciseCoverage", { callCount: true, detailed: true });
f(); f();
const after = await session.post("Profiler.takePreciseCoverage");
session.disconnect();
const bodyOffset = "function f(){".length;
const entry = after.result.find(s => s.url === url);
const fn = entry?.functions
  .filter(f => f.ranges[0].startOffset <= bodyOffset && bodyOffset < f.ranges[0].endOffset)
  .sort((a, b) => a.ranges[0].endOffset - b.ranges[0].endOffset)[0];
console.log(JSON.stringify({ count: fn?.ranges[0].count }));
`,
      });
      await using proc = Bun.spawn({ cmd: [bunExe(), "fixture.mjs"], env: bunEnv, cwd: String(dir), stderr: "pipe" });
      const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
      expect({ stderrIfFailed: exitCode === 0 ? "" : stderr, exitCode }).toEqual({ stderrIfFailed: "", exitCode: 0 });
      expect(JSON.parse(stdout.trim())).toEqual({ count: 2 });
    });

    // What Node 26 lists for this script, less the "<instance_members_initializer>" of Fields and of Inner.
    test.concurrent("lists a function once, and nothing that is not in the text", async () => {
      using dir = tempDir("inspector-coverage-functions", {
        "fixture.mjs": `
import { Session } from "node:inspector/promises";
import vm from "node:vm";
const session = new Session();
session.connect();
await session.post("Profiler.enable");
await session.post("Profiler.startPreciseCoverage", { callCount: true, detailed: true });
const code = [
  "class Fields { a = 1; ['b'] = 2; }",
  "class Derived extends Fields { }",
  "class Empty { }",
  "function around() { class Inner { c = 7; } new Inner; }",
  "new Fields; new Derived; new Empty; around();",
  "function* generator() { yield 3; }",
  "function* notResumed() { yield 4; }",
  "function* notCalled() { yield 5; }",
  "async function asynchronous() { await 6; }",
  "class Static { static { generator; } }",
  "[...generator()]; notResumed(); asynchronous();",
].join("\\n");
const url = "file:///functions-fixture/virtual.js";
vm.runInThisContext(code, { filename: url });
const { result } = await session.post("Profiler.takePreciseCoverage");
session.disconnect();
const functions = result.find(script => script.url === url).functions.map(({ ranges: [range] }) => [
  range.count,
  range.startOffset === 0 && range.endOffset === code.length ? "the script" : code.slice(range.startOffset, range.endOffset),
]);
console.log(JSON.stringify(functions));
`,
      });
      await using proc = Bun.spawn({ cmd: [bunExe(), "fixture.mjs"], env: bunEnv, cwd: String(dir), stderr: "pipe" });
      const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
      expect({ stderrIfFailed: exitCode === 0 ? "" : stderr, exitCode }).toEqual({ stderrIfFailed: "", exitCode: 0 });
      expect(JSON.parse(stdout.trim())).toEqual([
        [1, "the script"],
        [1, "function around() { class Inner { c = 7; } new Inner; }"],
        [1, "function* generator() { yield 3; }"],
        [1, "function* notResumed() { yield 4; }"],
        [0, "function* notCalled() { yield 5; }"],
        [1, "async function asynchronous() { await 6; }"],
        [1, "static { generator; }"],
      ]);
    });

    test.concurrent("lists a function that is the whole script", async () => {
      using dir = tempDir("inspector-coverage-whole-script", {
        "fixture.mjs": `
import { Session } from "node:inspector/promises";
import vm from "node:vm";
const session = new Session();
session.connect();
await session.post("Profiler.enable");
await session.post("Profiler.startPreciseCoverage", { callCount: true, detailed: true });
const url = "file:///whole-script-fixture/virtual.js";
vm.runInThisContext("function whole() { }", { filename: url });
whole();
whole();
const notCalled = "file:///whole-script-fixture/not-called.js";
vm.runInThisContext("function never() { }", { filename: notCalled });
const { result } = await session.post("Profiler.takePreciseCoverage");
session.disconnect();
console.log(
  JSON.stringify([url, notCalled].map(url => result.find(script => script.url === url).functions.map(({ ranges }) => ranges))),
);
`,
      });
      await using proc = Bun.spawn({ cmd: [bunExe(), "fixture.mjs"], env: bunEnv, cwd: String(dir), stderr: "pipe" });
      const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
      expect({ stderrIfFailed: exitCode === 0 ? "" : stderr, exitCode }).toEqual({ stderrIfFailed: "", exitCode: 0 });
      expect(JSON.parse(stdout.trim())).toEqual([
        [[{ startOffset: 0, endOffset: 20, count: 1 }], [{ startOffset: 0, endOffset: 20, count: 2 }]],
        // The script ran, and only declared the function.
        [[{ startOffset: 0, endOffset: 20, count: 1 }], [{ startOffset: 0, endOffset: 20, count: 0 }]],
      ]);
    });

    test.concurrent("collects block coverage with call counts for vm scripts", async () => {
      using dir = tempDir("inspector-coverage-vm", {
        "fixture.mjs": coverageVmFixture,
      });

      await using proc = Bun.spawn({
        cmd: [bunExe(), "fixture.mjs", "true", "true"],
        env: bunEnv,
        cwd: String(dir),
        stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);

      expect({ stderrIfFailed: exitCode === 0 ? "" : stderr, exitCode }).toEqual({ stderrIfFailed: "", exitCode: 0 });
      const { codeLength, timestampType, offsets, entry } = JSON.parse(stdout);

      expect(timestampType).toBe("number");
      expect(entry).toBeDefined();
      expect(entry.scriptId).toBeString();

      // Whole-script entry spans the entire source and ran once.
      expect(entry.functions[0].isBlockCoverage).toBe(true);
      expect(entry.functions[0].ranges[0]).toEqual({ startOffset: 0, endOffset: codeLength, count: 1 });

      // add() was called 3 times.
      const addEntry = entryCoveringOffset(entry.functions, offsets.addBody);
      expect(addEntry.isBlockCoverage).toBe(true);
      expect(addEntry.ranges[0].count).toBe(3);

      // classify() was called twice and never took the negative branch, so a
      // block range with count 0 covers the untaken branch.
      const classifyEntry = entryCoveringOffset(entry.functions, offsets.positiveReturn);
      expect(classifyEntry.ranges[0].count).toBe(2);
      expect(
        classifyEntry.ranges.some(
          (range: any) =>
            range.count === 0 &&
            range.startOffset <= offsets.negativeReturn &&
            offsets.negativeReturn < range.endOffset,
        ),
      ).toBe(true);

      // neverCalled() reports a single function-granularity range with count 0.
      const neverCalledEntry = entryCoveringOffset(entry.functions, offsets.neverCalledBody);
      expect(neverCalledEntry).toEqual({
        functionName: "",
        isBlockCoverage: false,
        ranges: [{ startOffset: expect.any(Number), endOffset: expect.any(Number), count: 0 }],
      });
    });

    test.concurrent("a function's range is its text, and the script is reported once", async () => {
      using dir = tempDir("inspector-coverage-ranges", {
        "fixture.cjs": `
          const inspector = require("node:inspector");
          const vm = require("node:vm");
          const code = [
            "function called(x) { if (x) { return 1; } return 2; }",
            "function neverCalled() { return 3; }",
            "const arrow = y => y;",
            "called(true); arrow(1);",
            "",
          ].join("\\n");
          const session = new inspector.Session();
          session.connect();
          session.post("Profiler.enable");
          session.post("Profiler.startPreciseCoverage", { callCount: true, detailed: false });
          vm.runInThisContext(code, { filename: "/virtual/ranges.js" });
          session.post("Profiler.takePreciseCoverage", (err, { result }) => {
            const { functions } = result.find(script => script.url.endsWith("/virtual/ranges.js"));
            console.log(JSON.stringify(functions.map(f => code.slice(f.ranges[0].startOffset, f.ranges[0].endOffset))));
          });
        `,
      });

      await using proc = Bun.spawn({
        cmd: [bunExe(), "fixture.cjs"],
        env: bunEnv,
        cwd: String(dir),
        stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);

      expect({ stderrIfFailed: exitCode === 0 ? "" : stderr, exitCode }).toEqual({ stderrIfFailed: "", exitCode: 0 });
      const [script, ...functions] = JSON.parse(stdout);
      expect(script).toStartWith("function called(x)");
      expect(script).toEndWith("arrow(1);\n");
      expect(functions).toEqual([
        "function called(x) { if (x) { return 1; } return 2; }",
        "function neverCalled() { return 3; }",
        "y => y",
      ]);
    });

    test.concurrent("what is skipped, or after a yield or an await that is not resumed, is a range", async () => {
      using dir = tempDir("inspector-coverage-skipped", {
        "fixture.cjs": `
          const inspector = require("node:inspector");
          const vm = require("node:vm");
          const code = [
            "function one() { return 1; }",
            "function parameter(v = one()) { return v; }",
            "function chain(o) { return o?.a(one()); }",
            "function assign(o) { o.a ||= one(); return o; }",
            "function* generator() { yield 1; one(); }",
            "async function stuck() { await new Promise(() => {}); one(); }",
            "parameter(1); parameter(); chain(); assign({ a: 1 }); generator().next(); stuck();",
            "",
          ].join("\\n");
          const session = new inspector.Session();
          session.connect();
          session.post("Profiler.enable");
          session.post("Profiler.startPreciseCoverage", { callCount: true, detailed: true });
          vm.runInThisContext(code, { filename: "/virtual/skipped.js" });
          session.post("Profiler.takePreciseCoverage", (err, { result }) => {
            const [script, ...functions] = result.find(script => script.url.endsWith("/virtual/skipped.js")).functions;
            console.log(
              JSON.stringify(functions.map(f => f.ranges.map(r => [r.count, code.slice(r.startOffset, r.endOffset)]))),
            );
          });
        `,
      });

      await using proc = Bun.spawn({
        cmd: [bunExe(), "fixture.cjs"],
        env: bunEnv,
        cwd: String(dir),
        stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);

      expect({ stderrIfFailed: exitCode === 0 ? "" : stderr, exitCode }).toEqual({ stderrIfFailed: "", exitCode: 0 });
      expect(JSON.parse(stdout)).toEqual([
        [[1, "function one() { return 1; }"]],
        [
          [2, "function parameter(v = one()) { return v; }"],
          [1, " one()"],
        ],
        [
          [1, "function chain(o) { return o?.a(one()); }"],
          [0, "?.a(one())"],
        ],
        [
          [1, "function assign(o) { o.a ||= one(); return o; }"],
          [0, " one()"],
        ],
        [
          [1, "function* generator() { yield 1; one(); }"],
          [0, " one(); "],
        ],
        [
          [1, "async function stuck() { await new Promise(() => {}); one(); }"],
          [0, " one(); "],
        ],
        [[1, "() => {}"]],
      ]);
    });

    test.concurrent("respects callCount: false and detailed: false", async () => {
      using dir = tempDir("inspector-coverage-flags", {
        "fixture.mjs": coverageVmFixture,
      });

      await using proc = Bun.spawn({
        cmd: [bunExe(), "fixture.mjs", "false", "false"],
        env: bunEnv,
        cwd: String(dir),
        stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);

      expect({ stderrIfFailed: exitCode === 0 ? "" : stderr, exitCode }).toEqual({ stderrIfFailed: "", exitCode: 0 });
      const { offsets, entry } = JSON.parse(stdout);

      expect(entry).toBeDefined();
      for (const fn of entry.functions) {
        expect(fn.isBlockCoverage).toBe(false);
        expect(fn.ranges).toHaveLength(1);
        expect([0, 1]).toContain(fn.ranges[0].count);
      }
      // Counts are clamped to 0/1 when callCount is false.
      expect(entryCoveringOffset(entry.functions, offsets.addBody).ranges[0].count).toBe(1);
      expect(entryCoveringOffset(entry.functions, offsets.neverCalledBody).ranges[0].count).toBe(0);
    });

    test.concurrent("collects coverage for modules imported after start", async () => {
      using dir = tempDir("inspector-coverage-import", {
        "fixture.mjs": coverageImportFixture,
        "covered-module.mjs": coveredModuleFixture,
      });

      await using proc = Bun.spawn({
        cmd: [bunExe(), "fixture.mjs"],
        env: bunEnv,
        cwd: String(dir),
        stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);

      expect({ stderrIfFailed: exitCode === 0 ? "" : stderr, exitCode }).toEqual({ stderrIfFailed: "", exitCode: 0 });
      const { url, functionCounts } = JSON.parse(stdout);

      // Filesystem-backed scripts are reported with file:// URLs, like V8.
      expect(url).toStartWith("file://");
      expect(url).toEndWith("covered-module.mjs");
      // double() ran twice, neverCalled() never ran.
      expect(functionCounts).toContain(2);
      expect(functionCounts).toContain(0);
    });

    // V8 never emits startOffset === endOffset; @bcoe/v8-coverage (vitest/c8
    // --coverage) recurses forever on a zero-width range (issue #39821).
    test.concurrent("never emits zero-width ranges", async () => {
      using dir = tempDir("inspector-coverage-zero-width", {
        "fixture.mjs": zeroWidthRangeFixture,
        "exported-fn.mjs": "export function f(x){return x}\n",
      });

      await using proc = Bun.spawn({
        cmd: [bunExe(), "fixture.mjs"],
        env: bunEnv,
        cwd: String(dir),
        stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);

      expect({ stderrIfFailed: exitCode === 0 ? "" : stderr, exitCode }).toEqual({ stderrIfFailed: "", exitCode: 0 });
      const { rangeCount, zeroWidth, fixtureRanges } = JSON.parse(stdout);

      // The fixture module was reported and coverage was non-trivial.
      expect(fixtureRanges).toBeGreaterThan(0);
      expect(rangeCount).toBeGreaterThan(0);
      // Every range across every script satisfies startOffset < endOffset.
      expect(zeroWidth).toEqual([]);
    });

    test.concurrent("lists a range only where its count is not that of the range it is in", async () => {
      using dir = tempDir("inspector-coverage-nested", {
        "fixture.cjs": `
          const inspector = require("node:inspector");
          const vm = require("node:vm");
          const code = [
            "function called(x) {",
            "  if (x) {",
            "    return 1;",
            "  }",
            "  return 2;",
            "}",
            "function neverCalled() {}",
            "called(0);",
          ].join("\\n");
          const session = new inspector.Session();
          session.connect();
          session.post("Profiler.enable");
          session.post("Profiler.startPreciseCoverage", { callCount: true, detailed: true });
          vm.runInThisContext(code, { filename: "/virtual/nested.js" });
          session.post("Profiler.takePreciseCoverage", (error, { result }) => {
            const { functions } = result.find(script => script.url.endsWith("/virtual/nested.js"));
            console.log(JSON.stringify(functions.map(f => f.ranges.map(r => [code.slice(r.startOffset, r.endOffset), r.count]))));
          });
        `,
      });

      await using proc = Bun.spawn({
        cmd: [bunExe(), "fixture.cjs"],
        env: bunEnv,
        cwd: String(dir),
        stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);

      expect({ stderrIfFailed: exitCode === 0 ? "" : stderr, exitCode }).toEqual({ stderrIfFailed: "", exitCode: 0 });
      const [script, called, neverCalled] = JSON.parse(stdout);
      // The text between the two functions ran as often as the script: it is not a range,
      // and so nothing but the function's own range is next to "function neverCalled".
      expect(script).toHaveLength(1);
      expect(called).toEqual([
        ["function called(x) {\n  if (x) {\n    return 1;\n  }\n  return 2;\n}", 1],
        ["{\n    return 1;\n  }", 0],
      ]);
      expect(neverCalled).toEqual([["function neverCalled() {}", 0]]);
    });

    // A range is between « and », after its count. As in Node 26, but where it says otherwise.
    const rangesInFunctions: Record<string, string> = {
      "a return that is last": `
function f() {
  return 2;
}
f();
`,
      "a throw that is last": `
function f() {
  throw 1;
}
try { f() } catch {}
`,
      "after a return": `
function f() {
  return 2;«0:
  f();
»}
f();
`,
      "a function declaration after a return": `
function f() {
  return g();
  function g() {}
}
f();
`,
      "after an if that returns": `
function f(x) {
  if (x) {
    return 1;
  }«0:
  return 2;
»}
f(1);
`,
      "an if that is not taken": `
function f(x) {
  if (x) «0:{
    return 1;
  }»
  return 2;
}
f(0);
`,
      "an if that is last": `
function f(x) {
  g();
  if (x) «0:{
    g();
  }»
}
function g() {}
f(0);
`,
      "else": `
function f(x) {
  if (x) {
    g();
  }«0: else {
    g();
  }»
  g();
}
function g() {}
f(1);
`,
      "else if": `
function f(x) {
  if (x === 1) «0:{
    g();
  }» else if (x === 2) {
    g();
  }«0: else {
    g();
  }»
}
function g() {}
f(2);
`,
      "an if without braces": `
function f(x) {
  if (x)
    return 1;«0:
  return 2;
»}
f(1);
`,
      "an if in an if that is not taken": `
function f(x, y) {
  if (x) «0:{
    if (y) {
      g();
    }
    g();
  }»
  g();
}
function g() {}
f(0, 0);
`,
      "an if that is last in an if that is last": `
function f(x, y) {
  if (x) {
    g();
    if (y) «0:{
      g();
    }»
  }
}
function g() {}
f(1, 0);
`,
      // Node has the two as one range.
      "after an if that returns, in an if": `
function f(x, y) {
  if (x) {
    if (y) {
      return;
    }«0:
    g();
  }»«0:
  g();
»}
function g() {}
f(1, 1);
`,
      "two ifs that return": `
function f(x, y) {
  if (x) «0:{
    return 1;
  }»
  g();
  if (y) {
    return 2;
  }«0:
  g();
»}
function g() {}
f(0, 1);
`,
      // Node ends the range before `|| g()` and has what is after it as run.
      "a part of an expression after an if that returns": `
function f(x) {
  if (x) {
    return 1;
  }«0:
  let a = x || g();
  g();
»}
function g() {}
f(1);
`,
      "a break that is last": `
function f() {
  for (;;) {
    break;
  }
  g();
}
function g() {}
f();
`,
      "a continue that is last": `
function f() {
  for (let i = 0; i < 2; i++) «2:{
    continue;
  }»
  g();
}
function g() {}
f();
`,
      "a loop that is not entered": `
function f() {
  for (let i = 0; i < 0; i++) «0:{
    g();
  }»
}
function g() {}
f();
`,
      // Node has the last two as one range.
      "after an if that continues": `
function f() {
  for (let i = 0; i < 2; i++) «2:{
    if (i) «1:{
      continue;
    }»«1:
    g();
  }»»
}
function g() {}
f();
`,
      // Node has no count for the condition.
      "do while": `
function f() {
  let n = 0;
  do «3:{
    n++;
  }»«3: while (n < 3);»
  g();
}
function g() {}
f();
`,
      "for in": `
function f() {
  for (const x in {}) «0:{
    g();
  }»
  g();
}
function g() {}
f();
`,
      "a switch that returns": `
function f(x) {
  switch (x) {
    case 1:
      return 1;
    «0:default:
      return 2;»
  }
}
f(1);
`,
      "a switch that breaks": `
function f(x) {
  switch (x) {
    case 1:
      g();
      break;
    «0:case 2:
      g();
      break;»
  }
  g();
}
function g() {}
f(1);
`,
      "a switch that falls through": `
function f(x) {
  switch (x) {
    «0:case 1:
      g();»
    case 2:
      g();
  }
}
function g() {}
f(2);
`,
      "a try that returns": `
function f() {
  try {
    return 1;
  } finally {
  }
}
f();
`,
      // Node starts the range at `catch`.
      "try, catch and finally": `
function f() {
  try {
    g();
  }«0: catch (e) {
    g();
  }» finally {
    g();
  }
  g();
}
function g() {}
f();
`,
      "after a catch that throws": `
function f() {
  try {
    throw 1;
  } catch (e) {
    throw e;
  }«0:
  g();
»}
function g() {}
try { f() } catch {}
`,
      "after a block that returns": `
function f() {
  {
    return 1;
  }«0:
  g();
»}
function g() {}
f();
`,
      "a break with a label": `
function f() {
  a: for (;;) {
    for (;;) {
      break a;
    }«0:
    g();
  }»
  g();
}
function g() {}
f();
`,
      "an arrow function": `
const f = x => {
  if (x) {
    return 1;
  }«0:
  return 2;
»};
f(1);
`,
      "a generator": `
function* f(x) {
  if (x) {
    return 1;
  }«0:
  yield 2;
»}
[...f(1)];
`,
      "the script": `
var x = 1;
if (x) {
  x++;
}«0: else {
  x--;
}»
for (;;) {
  break;
}
`,
    };

    test.concurrent("the ranges in a function are the statements that do not have its count", async () => {
      const scripts = Object.fromEntries(
        Object.entries(rangesInFunctions).map(([name, marked]) => [name, marked.trim().replace(/«\d+:|»/g, "")]),
      );
      using dir = tempDir("inspector-coverage-ranges", {
        "scripts.json": JSON.stringify(scripts),
        "fixture.mjs": `
import { readFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import vm from "node:vm";
const scripts = JSON.parse(readFileSync(new URL("./scripts.json", import.meta.url), "utf8"));
const session = new Session();
session.connect();
await session.post("Profiler.enable");
await session.post("Profiler.startPreciseCoverage", { callCount: true, detailed: true });
const url = name => "file:///ranges/" + encodeURIComponent(name);
for (const name in scripts) vm.runInContext(scripts[name], vm.createContext({}), { filename: url(name) });
const { result } = await session.post("Profiler.takePreciseCoverage");
for (const name in scripts) {
  const ranges = result.find(script => script.url === url(name)).functions.flatMap(({ ranges }) => ranges.slice(1));
  let marked = "";
  for (let offset = 0; offset <= scripts[name].length; offset++) {
    marked += "»".repeat(ranges.filter(range => range.endOffset === offset).length);
    for (const range of ranges.filter(range => range.startOffset === offset).sort((a, b) => b.endOffset - a.endOffset))
      marked += "«" + range.count + ":";
    marked += scripts[name][offset] ?? "";
  }
  scripts[name] = marked;
}
console.log(JSON.stringify(scripts));
`,
      });
      await using proc = Bun.spawn({ cmd: [bunExe(), "fixture.mjs"], env: bunEnv, cwd: String(dir), stderr: "pipe" });
      const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
      expect({ stderrIfFailed: exitCode === 0 ? "" : stderr, exitCode }).toEqual({ stderrIfFailed: "", exitCode: 0 });
      expect(JSON.parse(stdout)).toEqual(
        Object.fromEntries(Object.entries(rangesInFunctions).map(([name, marked]) => [name, marked.trim()])),
      );
    });
  });

  describe("exports", () => {
    test("url() returns undefined", () => {
      expect(inspector.url()).toBeUndefined();
    });

    test("console is exported", () => {
      expect(inspector.console).toBeObject();
      expect(inspector.console.log).toBe(globalThis.console.log);
    });

    // open()/close()/waitForDebugger() behavior is covered in inspector.test.ts;
    // opening a server is process-global state, so it is not exercised here.
    test("open(), close() and waitForDebugger() are functions", () => {
      expect(inspector.open).toBeInstanceOf(Function);
      expect(inspector.close).toBeInstanceOf(Function);
      expect(inspector.waitForDebugger).toBeInstanceOf(Function);
    });

    test("waitForDebugger() throws when the inspector is not active", () => {
      expect(() => inspector.waitForDebugger()).toThrow("Inspector is not active");
    });
  });
});

describe("node:inspector/promises", () => {
  test("Session is exported", () => {
    expect(inspectorPromises.Session).toBeInstanceOf(Function);
  });

  test("post() returns a Promise", async () => {
    const session = new inspectorPromises.Session();
    session.connect();

    const result: Promise<unknown> = session.post("Profiler.enable");
    expect(result).toBeInstanceOf(Promise);

    await expect(result).resolves.toEqual({});
    session.disconnect();
  });

  test("post() rejects on error", async () => {
    const session = new inspectorPromises.Session();
    session.connect();

    await expect(session.post("Profiler.start")).rejects.toThrow("not enabled");
    session.disconnect();
  });

  test("complete profiling workflow with promises", async () => {
    const session = new inspectorPromises.Session();
    session.connect();

    await session.post("Profiler.enable");
    await session.post("Profiler.start");

    // Do some work
    function work(n: number): number {
      if (n <= 1) return n;
      return work(n - 1) + work(n - 2);
    }
    work(15);

    const result = await session.post("Profiler.stop");
    expect(result).toHaveProperty("profile");
    expect(result.profile.nodes).toBeArray();

    await session.post("Profiler.disable");
    session.disconnect();
  });

  test("other exports are the same as node:inspector", () => {
    expect(inspectorPromises.url).toBe(inspector.url);
    expect(inspectorPromises.console).toBe(inspector.console);
    expect(inspectorPromises.open).toBe(inspector.open);
    expect(inspectorPromises.close).toBe(inspector.close);
    expect(inspectorPromises.waitForDebugger).toBe(inspector.waitForDebugger);
  });
});
