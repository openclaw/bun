import { createRequire } from "node:module";
const addon = createRequire(import.meta.url)("./build/Debug/test_worker_finalizers.node");
globalThis.held = addon.makeEventName();
// A matching string literal would prime the atom table before the addon can own its storage.
const codes = [
  114, 101, 115, 111, 117, 114, 99, 101, 116, 105, 109, 105, 110, 103, 98, 117, 102, 102, 101, 114, 102, 117, 108, 108,
];
if (held.length !== codes.length || codes.some((c, i) => held.charCodeAt(i) !== c)) {
  throw new Error("incorrect event name bytes");
}
globalThis.addEventListener(held, () => {});
globalThis.onmessage = () => process.exit(0);
postMessage(addon.stats());
