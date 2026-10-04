import assert from "node:assert/strict";
import { Script } from "node:vm";

const length = Number(process.argv[2] ?? 4096);
const encoding = process.argv[3] ?? "latin1";
const count = Number(process.argv[4] ?? 2500);
const passes = Number(process.argv[5] ?? 12);
assert.ok(Number.isSafeInteger(length) && length >= 0);
assert.ok(Number.isSafeInteger(count) && count >= 1);
assert.ok(Number.isSafeInteger(passes) && passes >= 3);
assert.ok(encoding === "latin1" || encoding === "utf16");

const padding = (encoding === "utf16" ? "λ" : "x").repeat(length);
const inputs = Array.from({ length: count }, (_, index) => ({
  source: `/*${padding}*/(() => ${index})`,
  options: { filename: `source-${index}.js` },
}));
const times = [];
let last;
for (let pass = 0; pass < passes; pass++) {
  const start = performance.now();
  for (const { source, options } of inputs) last = new Script(source, options);
  times.push(performance.now() - start);
  assert.equal(last.runInThisContext()(), count - 1);
}
console.log(JSON.stringify({ runtime: process.versions.bun ?? process.version, length, encoding, count, times }));
