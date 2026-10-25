import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const [sourceArg, engineRef, expectedSource, kind = "bisect"] = process.argv.slice(2);
assert(sourceArg && engineRef && expectedSource);
assert(["bisect", "async-clear"].includes(kind));
const source = resolve(sourceArg);
const git = (...args) => execFileSync("git", ["-C", source, ...args], { encoding: "utf8" }).trim();
assert.equal(git("rev-parse", "HEAD"), expectedSource);
const manifestPath = "scripts/build/deps/webkit-artifacts.json";
const manifestText = execFileSync("git", ["show", `${engineRef}:${manifestPath}`], { encoding: "utf8" });
const manifest = JSON.parse(manifestText);
const expectedEngines = {
  "807211511f81e0a6639bc9eb41d67120f6b85316": "a2976f02e69fde8ccc45dc8fb346173f9d63f8a1",
  "6aba42d75d4bcee905087fa518cb2df6ff49bb0d": "419b5a0470fc059a610e98697691bf6f7cedd841",
};
assert.equal(manifest.version, expectedEngines[engineRef]);
assert.equal(manifest.repository, "openclaw/WebKit");
writeFileSync(join(source, manifestPath), manifestText);
if (kind === "async-clear") {
  execFileSync("git", ["-C", source, "apply", resolve("scripts/openclaw-release/gc-r2-async-clear.patch")], { stdio: "inherit" });
}
const file = "test/js/node/worker_threads/worker_threads.test.ts";
const text = readFileSync(join(source, file), "utf8");
const start = text.indexOf('  test.concurrent("wakes a parked worker for an immediate GC timer"');
assert(start >= 0);
const caseHash = createHash("sha256").update(text.slice(start, text.indexOf("\n  test(", start))).digest("hex");
assert.equal(caseHash, "bad4f3c5c0bd81289843ce29719182dc536ecffc4b2c247e1882095c01f56efc");
const modified = git("diff", "--name-only").split("\n").filter(Boolean).sort();
const allowed = [manifestPath, ...(kind === "async-clear" ? ["src/jsc/bindings/bindings.cpp"] : [])].sort();
assert(modified.every(path => allowed.includes(path)));
const metadata = { source: expectedSource, engine: manifest.version, engineRef, kind, caseHash, modified,
  engineManifestSha256: createHash("sha256").update(manifestText).digest("hex") };
mkdirSync(join(source, "build"), { recursive: true });
writeFileSync(join(source, "build/gc-r2-metadata.json"), JSON.stringify(metadata, null, 2) + "\n");
console.log(JSON.stringify(metadata));
