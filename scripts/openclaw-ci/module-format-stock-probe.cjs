// Hosted-only reproduction against the immutable upstream PR and engine source pair.
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } = require("node:fs");
const { join, resolve } = require("node:path");

const binary = resolve("build/release/bun");
const folder = resolve("../build/openclaw-ci/module-format-stock");
mkdirSync(folder, { recursive: true });
const receipt = {
  nativeSource: "72e01da726087318dae55b808a6b5e6bb543bb2f",
  engineSource: "5a61071f79134bf41844e7ea31a8449147d85dd4",
  controllerSource: process.env.GITHUB_SHA,
  executableSHA256: createHash("sha256").update(readFileSync(binary)).digest("hex"),
  complete: false,
  runs: [],
};
const save = () => writeFileSync(join(folder, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
save();
const identity = spawnSync(
  "timeout",
  ["--kill-after=5s", "120s", binary, "-p", "JSON.stringify({bun:Bun.revision,webkit:process.versions.webkit})"],
  { encoding: "utf8", timeout: 135_000 },
);
assert.ifError(identity.error);
assert.equal(identity.status, 0, identity.stderr);
assert.deepEqual(JSON.parse(identity.stdout), { bun: receipt.nativeSource, webkit: receipt.engineSource });

const inputs = mkdtempSync(join(process.env.RUNNER_TEMP, "stock-module-format-"));
mkdirSync(join(inputs, "pkg"));
mkdirSync(join(inputs, "node_modules/@types"), { recursive: true });
symlinkSync(resolve("packages/bun-types"), join(inputs, "node_modules/@types/bun"));
writeFileSync(join(inputs, "pkg/package.json"), '{"type":"module"}');
writeFileSync(join(inputs, "pkg/target.tsx"), "process.env.SEEN_DIRNAME = __dirname;\n");
writeFileSync(
  join(inputs, "entry.mjs"),
  'await new Promise(resolve => setImmediate(resolve)); const imported = await import("./pkg/target.tsx"); console.log("default" in imported, typeof process.env.SEEN_DIRNAME);\n',
);
writeFileSync(
  join(inputs, "entry.cjs"),
  'const imported = require("./pkg/target.tsx"); console.log(Object.getPrototypeOf(imported) === Object.prototype, typeof process.env.SEEN_DIRNAME);\n',
);
const env = { ...process.env, BUN_AOT_VERBOSE: "1", BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" };
delete env.BUN_FEATURE_FLAG_DISABLE_ASYNC_TRANSPILER;
delete env.NODE_COMPILE_CACHE;
delete env.SEEN_DIRNAME;

function execute(entry, { aot = false, asyncDisabled = false } = {}) {
  const name = entry + (aot ? ".aot" : ".plain") + (asyncDisabled ? ".async-disabled" : "");
  const ran = spawnSync("timeout", ["--kill-after=5s", "120s", binary, "run", ...(aot ? ["--debug-aot"] : []), entry], {
    cwd: inputs,
    env: { ...env, ...(asyncDisabled ? { BUN_FEATURE_FLAG_DISABLE_ASYNC_TRANSPILER: "1" } : {}) },
    encoding: "utf8",
    timeout: 135_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  writeFileSync(join(folder, name + ".stderr.log"), ran.stderr ?? "");
  const row = {
    entry,
    aot,
    asyncDisabled,
    stdout: ran.stdout,
    stderr: (ran.stderr ?? "").replace(/^\[aot\] .*\r?\n/gm, ""),
    exitCode: ran.status,
    signal: ran.signal,
    error: ran.error?.message,
    imageUsed: /\[aot\] image: /.test(ran.stderr ?? ""),
  };
  receipt.runs.push(row);
  save();
  assert.ifError(ran.error);
  return row;
}

const plainImport = execute("entry.mjs");
const aotImport = execute("entry.mjs", { aot: true });
const plainRequire = execute("entry.cjs");
const aotRequire = execute("entry.cjs", { aot: true });
receipt.importMatches = plainImport.stdout === aotImport.stdout && plainImport.exitCode === aotImport.exitCode;
if (!receipt.importMatches) execute("entry.mjs", { asyncDisabled: true });
receipt.complete = true;
save();
console.log(JSON.stringify(receipt));

for (const row of receipt.runs) {
  assert.equal(row.exitCode, 0, JSON.stringify(row));
  assert.equal(row.signal, null);
  assert.equal(row.stderr, "");
  if (row.aot) assert.equal(row.imageUsed, true, "in-place image must be used");
}
assert.match(plainImport.stdout, /^(true|false) string\n$/);
assert.match(aotImport.stdout, /^(true|false) string\n$/);
assert.equal(plainRequire.stdout, "true string\n");
assert.equal(aotRequire.stdout, plainRequire.stdout);
// Import parity is the measured unknown, recorded above rather than assumed from fork-native evidence.
