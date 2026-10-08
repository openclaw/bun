"use strict";

const { spawn } = require("node:child_process");
const { writeSync } = require("node:fs");
const { Duplex } = require("node:stream");
const tls = require("node:tls");

const originalTransportDestroy = Duplex.prototype.destroy;
const scenarios = {
  "isolated-immediate": ["immediate"],
  "isolated-after-check": ["after-check"],
  "consecutive-immediate-after-check": ["immediate", "after-check"],
  "consecutive-after-check-immediate": ["after-check", "immediate"],
};

function output(value) {
  writeSync(1, JSON.stringify(value) + "\n");
}

function deferred() {
  let resolve;
  const promise = new Promise(done => {
    resolve = done;
  });
  return { promise, resolve };
}

async function parent() {
  const results = [];
  let active;
  let timedOut = false;
  output({
    type: "runtime",
    version: process.version,
    versions: process.versions,
    platform: process.platform,
    arch: process.arch,
  });
  const watchdog = setTimeout(() => {
    timedOut = true;
    output({ type: "watchdog-failure", milliseconds: 5000 });
    active?.kill("SIGKILL");
  }, 5000);
  watchdog.unref();
  for (const scenario of Object.keys(scenarios)) {
    if (timedOut) break;
    results.push(
      await new Promise(resolve => {
        let stderrBytes = 0;
        let spawnError = null;
        active = spawn(process.execPath, [__filename, "--scenario", scenario], { stdio: ["ignore", "pipe", "pipe"] });
        active.stdout.on("data", chunk => writeSync(1, chunk));
        active.stderr.on("data", chunk => {
          stderrBytes += chunk.length;
          writeSync(2, chunk);
        });
        active.on("error", error => {
          spawnError = error.message;
        });
        active.on("close", (code, signal) => resolve({ scenario, code, signal, stderrBytes, spawnError }));
      }),
    );
    active = undefined;
  }
  clearTimeout(watchdog);
  const pass =
    !timedOut &&
    results.length === Object.keys(scenarios).length &&
    results.every(result => result.code === 0 && !result.signal && !result.stderrBytes && !result.spawnError);
  output({ type: "parent-result", pass, timedOut, results });
  process.exitCode = pass ? 0 : 1;
}

function child(scenario) {
  const records = [];
  const errorOwners = new Map();
  const trace = [];
  const seenUncaught = [];
  const failures = [];
  let activeCase = null;
  let phase = "observe";
  let sequenceComplete = false;
  let cleanupComplete = false;
  let pendingBoundaries = 0;
  let uncaughtCount = 0;
  let rejectionCount = 0;

  function event(owner, name, data = {}) {
    const entry = { type: "event", scenario, seq: trace.length + 1, phase, owner, activeCase, name, ...data };
    trace.push(entry);
    output(entry);
  }

  function identity(error) {
    return errorOwners.get(error)?.id ?? "unknown";
  }

  function boundaries(record, from) {
    pendingBoundaries += 3;
    process.nextTick(() => {
      pendingBoundaries--;
      event(record.id, "boundary.nextTick", { from });
    });
    queueMicrotask(() => {
      pendingBoundaries--;
      event(record.id, "boundary.microtask", { from });
    });
    setImmediate(() => {
      pendingBoundaries--;
      event(record.id, "boundary.check", { from });
    });
  }

  process.on("uncaughtException", (error, origin) => {
    uncaughtCount++;
    const owner = errorOwners.get(error);
    seenUncaught.push(identity(error));
    event(owner?.id ?? null, "uncaughtException", { errorId: identity(error), message: error.message, origin });
    if (owner) boundaries(owner, "uncaughtException");
  });
  process.on("unhandledRejection", error => {
    rejectionCount++;
    event(null, "unhandledRejection", { errorId: identity(error), message: String(error) });
  });

  async function runCase(timing, index) {
    const id = `${scenario}/${index + 1}-${timing}`;
    activeCase = id;
    const record = {
      id,
      timing,
      writes: 0,
      writesAtDestroy: null,
      getterCount: 0,
      destroyCalls: [],
      tlsCloses: [],
      tlsErrors: [],
      transportErrors: [],
      transportCloses: [],
      continuation: false,
      cleanupRequested: false,
      closed: deferred(),
      transportClosed: deferred(),
    };
    records.push(record);
    const thrown = new Error(`unexpected end getter: ${id}`);
    errorOwners.set(thrown, record);
    event(id, "case.begin", { timing });
    const transport = new Duplex({
      read() {},
      write(chunk, encoding, callback) {
        record.writes++;
        event(id, "transport.write", { bytes: chunk.length });
        callback();
      },
    });
    record.transport = transport;
    Object.defineProperty(transport, "end", {
      get() {
        record.getterCount++;
        event(id, "transport.end.get", { errorId: id });
        throw thrown;
      },
    });
    transport.destroy = function (error) {
      const call = { phase, hasError: error != null, errorId: error == null ? null : identity(error) };
      record.destroyCalls.push(call);
      event(id, "transport.destroy.noop", call);
      return this;
    };
    transport.on("error", error => {
      record.transportErrors.push(identity(error));
      event(id, "transport.error", { errorId: identity(error), message: error.message });
    });
    transport.on("close", () => {
      record.transportCloses.push({ phase, cleanupRequested: record.cleanupRequested });
      event(id, "transport.close", { cleanupRequested: record.cleanupRequested });
      record.transportClosed.resolve();
    });
    const socket = tls.connect({ socket: transport, rejectUnauthorized: false });
    socket.on("error", error => {
      record.tlsErrors.push(identity(error));
      event(id, "tls.error", { errorId: identity(error), message: error.message });
    });
    socket.on("close", hadError => {
      record.tlsCloses.push(hadError);
      event(id, "tls.close", { hadError });
      record.closed.resolve();
      event(id, "close.promise.resolved");
      boundaries(record, "tls.close");
    });
    if (timing === "after-check") {
      await new Promise(resolve =>
        setImmediate(() => {
          event(id, "timing.check", { writes: record.writes });
          resolve();
        }),
      );
      event(id, "timing.check.continuation", { writes: record.writes });
    }
    record.writesAtDestroy = record.writes;
    event(id, "tls.destroy.call", { writes: record.writes });
    socket.destroy();
    event(id, "tls.destroy.return");
    boundaries(record, "tls.destroy.return");
    await record.closed.promise;
    record.continuation = true;
    event(id, "close.promise.continuation", { seenUncaught: [...seenUncaught] });
    boundaries(record, "close.promise.continuation");
  }

  function checkCommon(at) {
    if (!sequenceComplete) failures.push(`${at}: sequence incomplete`);
    if (records.length !== scenarios[scenario].length) failures.push(`${at}: missing cases`);
    if (pendingBoundaries) failures.push(`${at}: missing boundary callbacks ${pendingBoundaries}`);
    if (uncaughtCount || rejectionCount)
      failures.push(`${at}: uncaught/rejection counts ${uncaughtCount}/${rejectionCount}`);
    for (const record of records) {
      if (record.getterCount !== 0)
        failures.push(`${at}: ${record.id}: end getter accessed ${record.getterCount} times`);
      if (
        record.destroyCalls.length !== 1 ||
        record.destroyCalls[0].phase !== "observe" ||
        record.destroyCalls[0].hasError
      )
        failures.push(`${at}: ${record.id}: expected one runtime destroy without error`);
      if (record.tlsCloses.length !== 1 || record.tlsCloses[0] !== false || !record.continuation)
        failures.push(`${at}: ${record.id}: TLS close/continuation contract`);
      if (record.tlsErrors.length || record.transportErrors.length)
        failures.push(`${at}: ${record.id}: unexpected error event`);
    }
  }

  async function cleanup() {
    for (const record of records) {
      record.cleanupRequested = true;
      event(record.id, "cleanup.transport.destroy.call");
      originalTransportDestroy.call(record.transport);
    }
    await Promise.all(records.map(record => record.transportClosed.promise));
    cleanupComplete = true;
    event(null, "cleanup.complete");
  }

  process.on("beforeExit", () => {
    if (phase === "observe") {
      event(null, "observation.natural-quiescence", { sequenceComplete, pendingBoundaries });
      checkCommon("before cleanup");
      for (const record of records) {
        if (record.transportCloses.length) failures.push(`before cleanup: ${record.id}: premature transport close`);
      }
      phase = "cleanup";
      setImmediate(() => {
        event(null, "cleanup.check");
        cleanup().catch(error => {
          failures.push(`cleanup rejected: ${String(error)}`);
          event(null, "cleanup.rejected", { errorId: identity(error) });
        });
      });
      return;
    }
    if (phase !== "cleanup") return;
    event(null, "cleanup.natural-quiescence", { cleanupComplete, pendingBoundaries });
    checkCommon("after cleanup");
    if (!cleanupComplete) failures.push("cleanup incomplete at natural quiescence");
    for (const record of records) {
      if (
        record.transportCloses.length !== 1 ||
        record.transportCloses[0].phase !== "cleanup" ||
        !record.transportCloses[0].cleanupRequested
      )
        failures.push(`${record.id}: expected one reviewer-owned transport close`);
    }
    phase = "done";
    const cases = records.map(record => ({
      id: record.id,
      timing: record.timing,
      writesAtDestroy: record.writesAtDestroy,
      writes: record.writes,
      getterCount: record.getterCount,
      destroyCalls: record.destroyCalls,
      tlsCloses: record.tlsCloses,
      continuation: record.continuation,
      tlsErrors: record.tlsErrors,
      transportErrors: record.transportErrors,
      transportCloses: record.transportCloses,
    }));
    output({
      type: "scenario-result",
      scenario,
      pass: failures.length === 0,
      failures,
      sequenceComplete,
      cleanupComplete,
      uncaughtCount,
      rejectionCount,
      cases,
    });
    process.exitCode = failures.length === 0 ? 0 : 1;
  });

  async function main() {
    for (const [index, timing] of scenarios[scenario].entries()) await runCase(timing, index);
    sequenceComplete = true;
    event(null, "sequence.close-continuations.complete");
  }
  main().catch(error => {
    failures.push(`sequence rejected: ${String(error)}`);
    event(null, "sequence.rejected", { errorId: identity(error) });
  });
}

if (process.argv[2] === "--scenario" && Object.hasOwn(scenarios, process.argv[3])) {
  child(process.argv[3]);
} else {
  parent().catch(error => {
    writeSync(2, String(error) + "\n");
    process.exitCode = 1;
  });
}
