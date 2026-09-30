const assert = require("node:assert/strict");
const { createHook } = require("node:async_hooks");
const { Worker } = require("node:worker_threads");
const { once } = require("node:events");
const { setImmediate: turn } = require("node:timers/promises");
(async () => {
  const records = new Map();
  const hook = createHook({
    init(id, type, _trigger, resource) {
      if (type === "WORKER") records.set(id, { resource, destroys: 0, events: ["init"] });
    },
    destroy(id) {
      const record = records.get(id);
      if (record) {
        record.destroys++;
        record.events.push("destroy");
        assert.equal(record.resource.hasRef(), undefined);
      }
    },
  }).enable();
  for (const mode of ["natural", "terminate", "error", "exit-throw"]) {
    const worker = new Worker(
      mode === "natural" || mode === "exit-throw"
        ? ""
        : mode === "error"
          ? 'throw new Error("synthetic worker failure")'
          : 'setInterval(()=>{},1000);require("node:worker_threads").parentPort.postMessage("ready")',
      { eval: true },
    );
    const record = [...records.values()].at(-1);
    worker.on("error", () => {});
    const exit = new Promise(resolve =>
      worker.once("exit", code => {
        record.events.push("exit");
        assert.equal(record.destroys, 0);
        resolve(code);
      }),
    );
    let exitErrorHandled = false;
    if (mode === "exit-throw") {
      process.once("uncaughtException", error => {
        assert.equal(error.message, "synthetic exit listener failure");
        exitErrorHandled = true;
      });
      worker.once("exit", () => {
        throw new Error("synthetic exit listener failure");
      });
    }
    if (mode === "terminate") {
      await once(worker, "message");
      await Promise.all([worker.terminate(), worker.terminate()]);
    }
    const code = await exit;
    assert.equal(code, mode === "natural" || mode === "exit-throw" ? 0 : 1);
    const deadline = Date.now() + 2000;
    while (record.destroys === 0 && Date.now() < deadline) await turn();
    assert.equal(record.destroys, 1, mode + ":" + JSON.stringify(record.events));
    assert.deepEqual(record.events, ["init", "exit", "destroy"]);
    if (mode === "exit-throw") assert.equal(exitErrorHandled, true);
    await worker.terminate();
    await turn();
    assert.equal(record.destroys, 1, mode + ":" + JSON.stringify(record.events));
  }
  hook.disable();
  // Mutation during a destroy dispatch must not alter its current snapshot.
  let target;
  const calls = [];
  const first = createHook({
    init(id, type) {
      if (type === "WORKER") target = id;
    },
    destroy(id) {
      if (id === target) {
        calls.push("first");
        second.disable();
        third.enable();
      }
    },
  }).enable();
  const second = createHook({
    destroy(id) {
      if (id === target) calls.push("second");
    },
  }).enable();
  const third = createHook({
    destroy(id) {
      if (id === target) calls.push("third");
    },
  });
  const worker = new Worker("", { eval: true });
  await once(worker, "exit");
  const deadline = Date.now() + 2000;
  while (calls.length === 0 && Date.now() < deadline) await turn();
  first.disable();
  second.disable();
  third.disable();
  assert.deepEqual(calls, ["first", "second"]);
  console.log("ok");
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
