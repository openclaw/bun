import { heapStats } from "bun:jsc";
import { describe, expect, it } from "bun:test";
import { isASAN, rss } from "harness";
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

    const retained = globalThis.__w179Retained = [];
    let result;
    function go(i) {
      const script = new vm.Script(source + "//" + i);
      result = script.runInThisContext();
      retained.push(Buffer.alloc(25 * 1024, 1));
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
    const finalStats = heapStats();
    const finalCount = finalStats.objectTypeCounts.Script ?? 0;
    const megabytes = Math.round(((finalUsage - initialUsage) / 1024 / 1024) * 100) / 100;
    console.log("W179_SAMPLE " + JSON.stringify({ retainedCount: retained.length, initialCount, finalCount, megabytes, created: finalStats.w179ProvidersCreated, destroyed: finalStats.w179ProvidersDestroyed }));
    expect(finalCount).toBeLessThanOrEqual(initialCount + 10);
    // ASAN's quarantine retains freed allocations (default 256 MB).
    expect(megabytes).toBeLessThan(isASAN ? 700 : 200);
  });
});
