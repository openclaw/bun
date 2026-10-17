import { heapStats } from "bun:jsc";
import { describe, expect, it } from "bun:test";
import { isASAN, isDebug, rss } from "harness";
import vm from "node:vm";

const iterations = 10_000;
const warmupIterations = 5_000;
const batch = 500;

describe("vm.Script", () => {
  it("shouldn't leak memory", () => {
    Bun.gc(true);
    const initialCount = heapStats().objectTypeCounts.Script ?? 0;
    let initialUsage = 0;
    // The measured source payload exceeds the RSS bound if native sources are retained.
    const source = `/*\n${Buffer.alloc(32_768, " * aaaaa\n").toString("utf8")}\n*/ Buffer.alloc(10, 'hello').toString();`;

    let result;
    function go(i) {
      const script = new vm.Script(source + "//" + i);
      result = script.runInThisContext();
    }

    for (let i = 0; i < warmupIterations + iterations; ++i) {
      go(i);
      // Bound temporary garbage before it inflates the allocator's resident pages.
      if ((i + 1) % batch === 0) Bun.gc(true);
      // Measure all 10,000 scripts after a separate cache and allocator warmup.
      if (i + 1 === warmupIterations) initialUsage = rss();
    }
    expect(result).toBe("hellohello");
    Bun.gc(true);

    const finalUsage = rss();
    const finalCount = heapStats().objectTypeCounts.Script ?? 0;
    const megabytes = Math.round(((finalUsage - initialUsage) / 1024 / 1024) * 100) / 100;
    expect(finalCount).toBeLessThanOrEqual(initialCount + 10);
    // ASAN's quarantine retains freed allocations (default 256 MB).
    expect(megabytes).toBeLessThan(isASAN ? 700 : 200);
  });
});

it("shares exact source buffers without sharing provider metadata", async () => {
  const { bunEnv, bunExe } = await import("harness");
  await using child = Bun.spawn({
    cmd: [
      bunExe(),
      "--expose-internals",
      "-e",
      `
      const assert = require("node:assert/strict");
      const { createHash } = require("node:crypto");
      const { Script, runInThisContext } = require("node:vm");
      // Warm the VM and allocator before retaining 128 functions from 16 distinct large sources.
      new Script("(() => 1)").runInThisContext();
      Bun.gc(true);
      const before = process.memoryUsage.rss();
      const functions = [];
      const digests = [];
      for (let round = 0; round < 8; round++) {
        for (let i = 0; i < 16; i++) {
          const padding = Buffer.alloc(1024 * 1024, i % 2 ? 120 : 121).toString();
          const functionSource = "function kept() {\\nthrow new Error('source-" + i + "'); }";
          const source = "/*" + padding + "*/\\n(" + functionSource + ")";
          const options = { filename: 'retained-' + round + '-' + i + '.js', lineOffset: 3, columnOffset: 2 };
          const fn = (round % 2 ? runInThisContext(source, options) : new Script(source, options).runInThisContext());
          functions.push(fn);
          assert.equal(fn.toString(), functionSource);
          const digest = createHash('sha256').update(fn.toString()).digest('hex');
          if (round) assert.equal(digest, digests[i]); else digests.push(digest);
          try { fn(); assert.fail('did not throw'); } catch (error) {
            assert.ok(error.stack.includes(options.filename + ':6:7'), error.stack);
          }
        }
        Bun.gc(true);
      }
      assert.equal(functions.length, 128);
      const growth = process.memoryUsage.rss() - before;
      console.log(JSON.stringify({ growth, count: functions.length }));
    `,
    ],
    env: { ...bunEnv, BUN_VM_COMPILE_CACHE_SIZE: "0" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([child.stdout.text(), child.stderr.text(), child.exited]);
  expect({ stderr, exitCode }).toEqual({ stderr: "", exitCode: 0 });
  const result = JSON.parse(stdout);
  expect(result.count).toBe(128);
  // ASAN's quarantine keeps the short-lived input copies resident.
  expect(result.growth).toBeLessThan((isASAN ? 400 : isDebug ? 160 : 110) * 1024 * 1024);
});

it("shares large source-map URI strings with the compilation cache disabled", async () => {
  const { bunEnv, bunExe } = await import("harness");
  await using child = Bun.spawn({
    cmd: [
      bunExe(),
      "--expose-internals",
      "-e",
      `
      const assert = require('node:assert/strict');
      const { Script } = require('node:vm');
      const { nodeVMSourceBufferStats, nodeVMSourceBufferTest } = require('bun:internal-for-testing');
      const checks = nodeVMSourceBufferTest();
      for (const [key, value] of Object.entries(checks)) {
        if (key !== 'metadataBytes') assert.equal(value, true, key);
      }
      assert.ok(checks.metadataBytes < 4 * 1024 * 1024);
      const before = nodeVMSourceBufferStats();
      const held = [];
      let uriLength;
      for (let i = 0; i < 48; i++) {
        // Distinct complete sources must still share the identical, separately parsed directive.
        const uri = 'data:application/json;base64,' + Buffer.from(JSON.stringify({
          version: 3, sources: ['original.js'], sourcesContent: [Buffer.alloc(128 * 1024, 120).toString()],
          names: [], mappings: ''
        })).toString('base64');
        uriLength = uri.length;
        const script = new Script('(function value() { return ' + i + '; })\\n//# sourceMappingURL=' + uri);
        assert.equal(script.sourceMapURL, uri);
        const fn = script.runInThisContext();
        assert.equal(fn(), i);
        held.push(fn);
      }
      Bun.gc(true);
      const after = nodeVMSourceBufferStats();
      assert.equal(after.sourceMapBytes - before.sourceMapBytes, uriLength);
      assert.ok(after.hits - before.hits >= 47);
      console.log(held.length);
    `,
    ],
    env: { ...bunEnv, BUN_VM_COMPILE_CACHE_SIZE: "0" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([child.stdout.text(), child.stderr.text(), child.exited]);
  expect({ stdout, stderr, exitCode }).toEqual({ stdout: "48\n", stderr: "", exitCode: 0 });
});
