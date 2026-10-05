// Usage: node bench/module-loader/cold-cache.js /absolute/path/to/bun [modules=2093] [rounds=3]
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { mkdtempSync, mkdirSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { isAbsolute, join } = require("node:path");

const [runtime = process.execPath, countArg = "2093", roundsArg = "3"] = process.argv.slice(2);
const count = Number(countArg);
const rounds = Number(roundsArg);
assert(isAbsolute(runtime), "runtime must be an absolute path");
assert(Number.isSafeInteger(count) && count > 0, "modules must be a positive integer");
assert(Number.isSafeInteger(rounds) && rounds > 0, "rounds must be a positive integer");
const root = mkdtempSync(join(tmpdir(), "bun-cold-cache-"));
try {
  const padding = "x".repeat(8 * 1024);
  for (let i = 0; i < count; i++) {
    writeFileSync(
      join(root, `${i}.mjs`),
      `export const value = ${i}; export const padding = ${JSON.stringify(padding)};`,
    );
  }
  writeFileSync(
    join(root, "entry.mjs"),
    `const modules = await Promise.all(Array.from({ length: ${count} }, (_, i) => import('./' + i + '.mjs')));
     const sum = modules.reduce((sum, m) => sum + m.value, 0);
     if (sum !== ${((count - 1) * count) / 2}) throw new Error('incorrect module values');
     console.log(JSON.stringify({ count: modules.length, cpu: process.cpuUsage() }));`,
  );
  for (let round = 0; round < rounds; round++) {
    const home = join(root, `home-${round}`);
    mkdirSync(home, { mode: 0o700 });
    const env = { ...process.env, HOME: home, TMPDIR: home, BUN_RUNTIME_TRANSPILER_CACHE_PATH: join(home, "cache") };
    delete env.NODE_OPTIONS;
    delete env.BUN_OPTIONS;
    for (const state of ["cold", "warm"]) {
      const start = performance.now();
      const child = spawnSync(runtime, [join(root, "entry.mjs")], { cwd: root, env, encoding: "utf8" });
      const wallMs = performance.now() - start;
      assert.equal(child.status, 0, child.stderr || String(child.error));
      const result = JSON.parse(child.stdout);
      assert.equal(result.count, count);
      console.log(JSON.stringify({ runtime, round, state, wallMs, ...result }));
    }
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}
