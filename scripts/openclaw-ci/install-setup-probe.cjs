// Temporary hosted diagnosis of dependency setup; this controller never lands in production.
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const { join, resolve } = require("node:path");

const binary = resolve("build/release/bun");
const folder = resolve("build/openclaw-ci/receiver-oracle/install-setup");
mkdirSync(folder, { recursive: true });
const digest = file => createHash("sha256").update(readFileSync(file)).digest("hex");
const inputs = ["package.json", "bun.lock", "test/package.json", "test/bun.lock", "scripts/runner.node.ts"];
const before = Object.fromEntries(inputs.map(file => [file, digest(file)]));
const receipt = {
  complete: false,
  nativeSource: "5cd0cffa4a84f8a9285fc8b55d98c3d1deabab58",
  probeSource: process.env.GITHUB_SHA,
  binarySHA256: digest(binary),
  inputs: before,
  commands: [],
};
const save = () => writeFileSync(join(folder, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
save();
function run(name, command, args, options = {}) {
  const started = Date.now();
  const result = spawnSync("timeout", ["--kill-after=5s", "240s", command, ...args], {
    encoding: "utf8",
    timeout: 270_000,
    maxBuffer: 16 * 1024 * 1024,
    ...options,
  });
  writeFileSync(join(folder, name + ".stdout.log"), result.stdout ?? "");
  writeFileSync(join(folder, name + ".stderr.log"), result.stderr ?? "");
  const record = {
    name,
    exitCode: result.status,
    signal: result.signal,
    error: result.error?.message,
    milliseconds: Date.now() - started,
  };
  receipt.commands.push(record);
  save();
  console.log(JSON.stringify(record));
  if (result.error) throw result.error;
  return result;
}
function runner(name, env) {
  return run(
    name,
    process.execPath,
    [
      "scripts/runner.node.ts",
      "--exec-path",
      binary,
      "--vendor=false",
      "--retries=0",
      "--results-json",
      join(folder, name + ".json"),
      "--include",
      "js/node/path/matches-glob.test.ts",
    ],
    { env },
  );
}
const unconfigured = { ...process.env };
delete unconfigured.BUN_INSTALL_CACHE_DIR;
runner("default-setup", unconfigured);
const env = {
  ...process.env,
  PUPPETEER_SKIP_DOWNLOAD: "1",
  BUN_INSTALL_CACHE_DIR: join(process.env.RUNNER_TEMP, "install-setup-cache"),
};
assert.equal(run("frozen-root", binary, ["install", "--frozen-lockfile"], { env }).status, 0);
assert.equal(run("frozen-test", binary, ["install", "--frozen-lockfile"], { env, cwd: resolve("test") }).status, 0);
const warmed = runner("frozen-shared-cache-setup", env);
receipt.inputsAfter = Object.fromEntries(inputs.map(file => [file, digest(file)]));
assert.deepEqual(receipt.inputsAfter, before, "dependency setup changed frozen inputs");
receipt.complete = true;
save();
assert.equal(warmed.status, 0, "grouped runner still fails after explicit frozen setup");
