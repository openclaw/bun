import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execa } from "execa";

const runtime = process.versions.bun ? "bun" : "node";
const report = process.env.EXECA_REPORT_DIR;
mkdirSync(report, { recursive: true });
const pkg = JSON.parse(readFileSync(new URL("./node_modules/execa/package.json", import.meta.url)));
const lock = readFileSync(new URL("./package-lock.json", import.meta.url));
const integrity = "sha512-j1pFOVxaybMVCTNHSBuISL2KQcDS3KIE1wBmUp4n2X+1FgaQI2ZDJVy9TYxDyMCzYojRIMh9O8X/UoWZtxTJdw==";
assert.equal(pkg.version, "10.2.0");
assert.equal(JSON.parse(lock).packages["node_modules/execa"].integrity, integrity);
const receipt = {
  runtime,
  runtimeVersion: process.version,
  nativeSource: runtime === "bun" ? Bun.revision : undefined,
  engineSource: process.versions.webkit,
  controllerSource: process.env.GITHUB_SHA,
  executableSHA256: createHash("sha256").update(readFileSync(process.execPath)).digest("hex"),
  execaVersion: pkg.version,
  execaIntegrity: integrity,
  lockSHA256: createHash("sha256").update(lock).digest("hex"),
  complete: false,
  shippingArchiveQualified: false,
};
const save = () => writeFileSync(join(report, runtime + ".json"), JSON.stringify(receipt, null, 2) + "\n");
save();
if (runtime === "bun") {
  assert.equal(receipt.nativeSource, "cd861bb9f53102e92e23ce28684c258055c7e612");
  assert.equal(receipt.engineSource, "651eeaca6e2792378928033b1ae7ac66d6f91eab");
}

const marker = new URL("./child-started", import.meta.url);
const args = ["-e", 'require("node:fs").writeFileSync(process.argv[1], "started")', marker.pathname];
const options = { uid: 2 ** 32 };
let original;
assert.throws(
  () => spawn(process.execPath, args, options),
  error => {
    original = error;
    return /options\.uid/.test(error.message) && /^ERR_(?:INVALID_ARG_TYPE|OUT_OF_RANGE)$/.test(error.code);
  },
);

// This must return Execa's failed-subprocess handle instead of throwing while assigning its dummy streams.
const subprocess = execa(process.execPath, args, options);
assert.equal(typeof subprocess.then, "function");
for (const name of ["stdin", "stdout", "stderr", "stdio"]) {
  const descriptor = Object.getOwnPropertyDescriptor(subprocess, name);
  assert.deepEqual(
    { writable: descriptor?.writable, enumerable: descriptor?.enumerable, configurable: descriptor?.configurable },
    { writable: true, enumerable: true, configurable: true },
  );
}
assert.deepEqual(subprocess.stdio, [subprocess.stdin, subprocess.stdout, subprocess.stderr]);
let rejection;
await assert.rejects(subprocess, error => {
  rejection = error;
  return error.failed === true && error.code === original.code && error.cause?.message === original.message;
});
assert.equal(rejection.originalMessage, original.message);
assert.equal(existsSync(marker), false);
receipt.original = { name: original.name, code: original.code, message: original.message };
receipt.rejection = { name: rejection.name, code: rejection.code, originalMessage: rejection.originalMessage };
receipt.returnsPromiseHandle = true;
receipt.streamsAreOwnWritableProperties = true;
receipt.childStarted = false;
receipt.complete = true;
save();
console.log(JSON.stringify(receipt));
