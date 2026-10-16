import assert from "node:assert/strict";
import { watch } from "node:fs";

for (const options of [undefined, {}, "utf8", null]) {
  const calls = [];
  let receiver;
  function listener(...args) {
    receiver = this;
    calls.push(args);
  }
  const watcher = options === undefined ? watch(process.argv[2], listener) : watch(process.argv[2], options, listener);
  try {
    assert.equal(watcher.listenerCount("change"), 1);
    assert.deepEqual(watcher.listeners("change"), [listener]);
    watcher.emit("change", "rename", "synthetic.txt");
    assert.equal(receiver, watcher);
    assert.deepEqual(calls, [["rename", "synthetic.txt"]]);
    watcher.removeListener("change", listener);
    watcher.emit("change", "change", "removed.txt");
    assert.equal(calls.length, 1);
    watcher.on("change", listener);
    watcher.removeAllListeners("change");
    assert.equal(watcher.listenerCount("change"), 0);
  } finally {
    watcher.close();
  }
}
console.log("listener oracle passed");
