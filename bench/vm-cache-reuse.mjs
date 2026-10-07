// BUN_VM_COMPILE_CACHE_THRESHOLD=0 bun bench/vm-cache-reuse.mjs 2000 32 utf16
import { runInThisContext, Script } from "node:vm";
import { performance } from "node:perf_hooks";
import assert from "node:assert/strict";
const count = Number(process.argv[2] ?? 2000);
const functions = Number(process.argv[3] ?? 32);
const encoding = process.argv[4] ?? "latin1";
assert.ok(Number.isSafeInteger(count) && count > 0, "count must be a positive integer");
assert.ok(Number.isSafeInteger(functions) && functions > 0, "functions must be a positive integer");
assert.ok(["latin1", "utf16"].includes(encoding));
const prefix = encoding === "utf16" ? "/*☃*/" : "/*x*/";
const sources = Array.from(
  { length: count },
  (_, n) =>
    prefix +
    "(function(){" +
    Array.from(
      { length: functions },
      (_, f) =>
        `function f${f}(x){${Array.from({ length: 24 }, (_, k) => `x=(x+${k + 1})|0;`).join("")}return x+${n};}`,
    ).join("") +
    "return f0(0);})()",
);
const runs = [];
for (let pass = 0; pass < 3; pass++) {
  const before = process.cpuUsage();
  const start = performance.now();
  let sum = 0;
  for (let i = 0; i < sources.length; i++) sum += runInThisContext(sources[i], { filename: `entry-${i}.js` });
  const cpu = process.cpuUsage(before);
  assert.equal(sum, count * 300 + (count * (count - 1)) / 2);
  runs.push({ pass, wallMs: performance.now() - start, cpuMs: (cpu.user + cpu.system) / 1000, sum });
}
const code = "(function(x){return x+42})";
const script = new Script(code, { filename: "public.js" });
const bytes = script.createCachedData();
const roundtrip = new Script(code, { filename: "public.js", cachedData: bytes });
assert.equal(roundtrip.cachedDataRejected, false);
assert.equal(roundtrip.runInThisContext()(1), 43);
console.log(
  JSON.stringify({
    runtime: process.versions.bun ? "bun" : "node",
    count,
    functions,
    encoding,
    runs,
    maxRSS: process.resourceUsage().maxRSS,
  }),
);
