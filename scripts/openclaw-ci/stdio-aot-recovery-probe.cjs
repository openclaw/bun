// Hosted-only consumer proof using the admitted fork-native executable.
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } = require("node:fs");
const { join, resolve } = require("node:path");

const binary = resolve("build/release/bun");
const folder = resolve("build/openclaw-ci/receiver-oracle/stdio-aot");
mkdirSync(folder, { recursive: true });
const receipt = {
  nativeSource: "cd861bb9f53102e92e23ce28684c258055c7e612",
  engineSource: "651eeaca6e2792378928033b1ae7ac66d6f91eab",
  controllerSource: process.env.GITHUB_SHA,
  executableSHA256: createHash("sha256").update(readFileSync(binary)).digest("hex"),
  complete: false,
  runs: [],
};
const save = () => writeFileSync(join(folder, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
save();
const env = { ...process.env, BUN_AOT_VERBOSE: "1", BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0", BUN_DEBUG_QUIET_LOGS: "1" };

function execute(label, command, cwd, seconds = 120) {
  const ran = spawnSync("timeout", ["--kill-after=5s", seconds + "s", ...command], {
    cwd,
    env,
    encoding: "utf8",
    timeout: (seconds + 15) * 1000,
    maxBuffer: 8 * 1024 * 1024,
  });
  writeFileSync(join(folder, label + ".stdout.log"), ran.stdout ?? "");
  writeFileSync(join(folder, label + ".stderr.log"), ran.stderr ?? "");
  const row = {
    label,
    command,
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
  assert.equal(row.exitCode, 0, JSON.stringify(row));
  assert.equal(row.signal, null);
  return row;
}

const identity = execute("identity", [
  binary,
  "-p",
  "JSON.stringify({bun:Bun.revision,webkit:process.versions.webkit})",
]);
assert.deepEqual(JSON.parse(identity.stdout), { bun: receipt.nativeSource, webkit: receipt.engineSource });

for (const name of ["stdout", "stderr"]) {
  const inputs = mkdtempSync(join(process.env.RUNNER_TEMP, "stdio-aot-" + name + "-"));
  mkdirSync(join(inputs, "node_modules/@types"), { recursive: true });
  symlinkSync(resolve("packages/bun-types"), join(inputs, "node_modules/@types/bun"));
  const source =
    [
      'const fs = require("node:fs");',
      'const original = new Error("stdio constructor sentinel");',
      "const Constructor = fs.WriteStream;",
      "let calls = 0;",
      "fs.WriteStream = function () { calls++; throw original; };",
      "let caughtOriginal = false;",
      "try { void process." + name + "; } catch (error) { caughtOriginal = error === original; }",
      'fs.writeSync(1, JSON.stringify({ calls, caughtOriginal }) + "\\n");',
      "fs.WriteStream = Constructor;",
      "process." + name + ".write(" + JSON.stringify("recovered " + name + "\n") + ");",
      "process.exitCode = calls === 1 && caughtOriginal ? 0 : 1;",
    ].join("\n") + "\n";
  writeFileSync(join(inputs, "entry.cjs"), source);
  const fixtureSHA256 = createHash("sha256").update(source).digest("hex");
  const expected = {
    stdout: '{"calls":1,"caughtOriginal":true}\n' + (name === "stdout" ? "recovered stdout\n" : ""),
    stderr: name === "stderr" ? "recovered stderr\n" : "",
  };
  const inPlace = execute(name + ".in-place", [binary, "run", "--debug-aot", "entry.cjs"], inputs);
  inPlace.fixtureSHA256 = fixtureSHA256;
  assert.equal(inPlace.imageUsed, true, "in-place execution must consume its image");
  assert.deepEqual({ stdout: inPlace.stdout, stderr: inPlace.stderr }, expected);
  const output = join(inputs, "out");
  execute(name + ".compile", [binary, "build", "--compile", "--aot", "entry.cjs", "--outfile", output], inputs, 240);
  assert.equal(readFileSync(output).subarray(0, 4).toString("hex"), "7f454c46");
  const standalone = execute(name + ".standalone", [output], inputs);
  standalone.fixtureSHA256 = fixtureSHA256;
  assert.deepEqual({ stdout: standalone.stdout, stderr: standalone.stderr }, expected);
}
receipt.complete = true;
save();
console.log("Both output streams preserve the original error and recover through in-place and standalone AOT.");
