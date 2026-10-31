import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(process.argv[2]);
const input = join(root, "test/js/bun/net/socket-retention.test.ts");
const lifetime = pathToFileURL(join(root, "test/js/bun/module-graph/module-graph-lifetimes.ts")).href;
const original = readFileSync(input, "utf8");
const startupAt = original.indexOf('test("TLS Duplex cycles collect after startup');
const completionAt = original.indexOf("for (const destroyBeforeCompletion of [false, true])");
assert(startupAt > 0 && completionAt > startupAt);

function once(text, before, after) {
  assert.equal(text.split(before).length, 2, `expected one occurrence: ${before}`);
  return text.replace(before, after);
}

function instrument(text) {
  return once(
    text,
    "const turn = () => new Promise(resolve => setImmediate(resolve));",
    `const turn = () => new Promise(resolve => setImmediate(resolve));
        const { jscDescribe } = require("bun:jsc");
        const addressOf = object => BigInt(/0x[0-9a-fA-F]+/.exec(jscDescribe(object))[0]);
        async function reportRetention(phase, entries) {
          // End the WeakRef keep-alive job after recording the original observation.
          await turn();
          const { heapFromTimer } = await import(${JSON.stringify(lifetime)});
          const heap = await heapFromTimer();
          const paths = Object.fromEntries(entries.map(([name, address]) => [name, heap.pathTo(address) ?? null]));
          console.error("RETENTION_DIAGNOSTIC " + JSON.stringify({ phase, paths }));
        }`,
  );
}

let startup = instrument(original.slice(startupAt, completionAt));
startup = once(
  startup,
  "return { weak: new WeakRef(client._handle), origin: retain ? clientSide : null };",
  "return { address: addressOf(client._handle), weak: new WeakRef(client._handle), origin: retain ? clientSide : null };",
);
startup = once(
  startup,
  "const droppedCollected = !dropped.weak.deref();",
  `const droppedCollected = !dropped.weak.deref();
        if (!droppedCollected) await reportRetention("startup", [["retained", retained.address], ["dropped", dropped.address]]);`,
);
startup = once(startup, "expect(stdout.trim()).toBe(", "expect(stdout.trim(), stderr).toBe(");

let completion = instrument(original.slice(completionAt));
completion = once(
  completion,
  "const weak = new WeakRef(server._handle);",
  "const address = addressOf(server._handle);\n          const weak = new WeakRef(server._handle);",
);
completion = once(completion, "return { weak, completion, settled };", "return { address, weak, completion, settled };");
completion = once(
  completion,
  "console.log(JSON.stringify({ callbackRoot, queuedRoot, collected: !state.weak.deref(), settled: state.settled }));",
  `const collected = !state.weak.deref();
        if (!collected) await reportRetention("completion", [["owner", state.address]]);
        console.log(JSON.stringify({ callbackRoot, queuedRoot, collected, settled: state.settled }));`,
);
completion = once(completion, "expect(result).toEqual(", "expect(result, stderr).toEqual(");

const output = join(root, "test/js/bun/net/socket-retention.diagnostic.test.ts");
writeFileSync(output, original.slice(0, startupAt) + startup + completion);
console.log("prepared diagnostics after the original GC observations; assertions unchanged");
