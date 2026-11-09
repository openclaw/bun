// Temporary hosted proof of the exact node-class fixture's emitted entry guards.
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { mkdirSync, readFileSync, writeFileSync, symlinkSync } = require("node:fs");
const { resolve, join } = require("node:path");

const binary = resolve("build/release/bun");
const folder = resolve("build/openclaw-ci/receiver-oracle/node-class-guards");
const inputs = join(folder, "inputs");
const owner = "test/aot/types-of-node-classes-name-what-buns-modules-make.test.ts";
const source = readFileSync(owner, "utf8");
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const receipt = {
  complete: false,
  nativeSource: "11e3dd7ffa155cb63a38028adcc94be71553671d",
  probeSource: process.env.GITHUB_SHA,
  engine: JSON.parse(readFileSync("build/openclaw-ci/engine-source.json", "utf8")),
  binarySHA256: digest(readFileSync(binary)),
  fixture: { path: owner, sha256: digest(source) },
  bunLockSHA256: digest(readFileSync("bun.lock")),
  commands: [],
};
mkdirSync(join(inputs, "node_modules/@types"), { recursive: true });
mkdirSync(join(inputs, "node_modules/exercise"), { recursive: true });
const save = () => writeFileSync(join(folder, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
save();
function literal(name) {
  const begin = source.indexOf("const " + name + " = `");
  assert(begin >= 0);
  const start = begin + ("const " + name + " = `").length;
  const end = source.indexOf("`;", start);
  assert(end > start);
  const text = source.slice(start, end);
  assert(!text.includes("${") && !text.includes("\\"), "fixture requires literal cooking");
  return text;
}
writeFileSync(join(inputs, "main.ts"), literal("program"));
writeFileSync(join(inputs, "node_modules/exercise/index.ts"), literal("exercise"));
writeFileSync(
  join(inputs, "node_modules/exercise/package.json"),
  JSON.stringify({ name: "exercise", type: "module", main: "index.ts" }),
);
symlinkSync(resolve("packages/bun-types"), join(inputs, "node_modules/@types/bun"));
receipt.typesPackage = JSON.parse(readFileSync("packages/bun-types/package.json", "utf8")).version;
const typesTree = spawnSync("git", ["rev-parse", "HEAD:packages/bun-types"], { encoding: "utf8" });
assert.equal(typesTree.status, 0);
receipt.typesTree = typesTree.stdout.trim();
const env = {
  ...process.env,
  NO_COLOR: "1",
  TZ: "Etc/UTC",
  CI: "1",
  GITHUB_ACTIONS: "false",
  BUN_FEATURE_FLAG_INTERNAL_FOR_TESTING: "1",
  BUN_GARBAGE_COLLECTOR_LEVEL: "0",
  BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
  BUN_DEBUG_QUIET_LOGS: "1",
};
for (const key of ["JSC_useJIT", "NODE_OPTIONS", "BUN_OPTIONS", "BUN_BE_BUN", "BUN_INSPECT_CONNECT_TO", "FORCE_COLOR"])
  delete env[key];
function run(label, executable, args) {
  const child = spawnSync(executable, args, {
    cwd: inputs,
    env,
    encoding: "utf8",
    timeout: 120000,
    maxBuffer: 32 * 1024 * 1024,
  });
  writeFileSync(join(folder, label + ".stdout.log"), child.stdout ?? "");
  writeFileSync(join(folder, label + ".stderr.log"), child.stderr ?? "");
  const status = { label, args, exitCode: child.status, signal: child.signal, error: child.error?.message };
  receipt.commands.push(status);
  save();
  assert(!child.error && !child.signal && child.status === 0, JSON.stringify(status));
  return { stdout: child.stdout, stderr: child.stderr, exitCode: child.status, signal: child.signal };
}
const app = join(inputs, "app");
const compiled = run("compile", binary, [
  "build",
  "--compile",
  "--aot",
  "--explain=json",
  "--explain=guards-json",
  "main.ts",
  "--outfile",
  app,
]);
const rows = compiled.stdout
  .split("\n")
  .filter(line => line.startsWith("{"))
  .map(line => JSON.parse(line));
receipt.accessSummary = rows.find(row => row.accesses);
receipt.answerGuards = rows.filter(
  row => row.aot === "type-check" && row.file === "main.ts" && row.function === "answer",
);
const plain = run("plain", binary, ["main.ts"]);
const native = run("compiled", app, []);
const expected = {
  stdout: "true false 2 4\n200 text/plain hello\n404 text/plain hello\n",
  stderr: "",
  exitCode: 0,
  signal: null,
};
receipt.runtimeMatches =
  JSON.stringify(plain) === JSON.stringify(expected) && JSON.stringify(native) === JSON.stringify(expected);
receipt.requiredTypes = ["IncomingMessage", "ServerResponse"];
receipt.presentTypes = receipt.requiredTypes.filter(type =>
  receipt.answerGuards.some(row => row.type === type && row.failure === "leaves" && row.copies > 0),
);
receipt.complete = true;
receipt.limitations =
  "Temporary diagnostic only. Rejoining guard names describe operands, not tested types; use per-copy engine access costs and closed-access reasons. No production test assertion is changed.";
save();
assert.deepEqual(plain, expected);
assert.deepEqual(native, expected);
assert(receipt.answerGuards.length > 0, "guard report must cover answer");
console.log(
  JSON.stringify({ complete: true, runtimeMatches: true, diagnosticOnly: true, accessSummary: receipt.accessSummary }),
);
