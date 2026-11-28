import { edenGC, fullGC } from "bun:jsc";

function equal(actual, expected, stage) {
  if (actual !== expected) throw new Error(stage + ": " + actual + " !== " + expected);
}

function allocate(length) {
  return new Float32Array(length);
}

const views = [];
fullGC();
const before = process.memoryUsage().arrayBuffers;
let bytes = 0;
for (const length of [1, 3, 5, 64]) {
  views.push(allocate(length));
  bytes += length * 4;
  equal(process.memoryUsage().arrayBuffers - before, bytes, "allocation");
}
for (const view of views) {
  equal(view.buffer.byteLength, view.byteLength, "materialized length");
}
equal(process.memoryUsage().arrayBuffers - before, bytes, "materialization");
edenGC();
equal(process.memoryUsage().arrayBuffers - before, bytes, "eden");
fullGC();
equal(process.memoryUsage().arrayBuffers - before, bytes, "full");
// Keep every backing store live through both collections.
equal(
  views.reduce((sum, view) => sum + view.byteLength, 0),
  bytes,
  "retained payload",
);
console.log("typed-array payload accounting");
