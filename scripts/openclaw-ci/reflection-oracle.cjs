// Temporary hosted receiver oracle: never imported by the runtime or its tests.
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { readFileSync, writeFileSync, mkdirSync } = require("node:fs");
const { resolve, join } = require("node:path");

assert.equal(process.version, "v26.12.1");
const folder = resolve("build/openclaw-ci/receiver-oracle");
mkdirSync(folder, { recursive: true });
const fixturePath = "test/js/node/members-of-prototype-objects-for-any-receiver-fixture.js";
const fixture = readFileSync(fixturePath, "utf8");
const begin = fixture.indexOf("const textOfKey =");
const end = fixture.indexOf("const objects = receivers");
assert(begin >= 0 && end > begin);
const helpers = fixture.slice(begin, end);
const method = key => [
  { key, kind: "call", args: [] },
  { key, kind: "call", args: ["a", 1] },
];
const getter = key => ({ key, kind: "get", args: [] });
const groups = [
  { id: "worker", module: "node:worker_threads", export: "Worker", operations: [getter("resourceLimits")] },
  { id: "https", module: "node:https", export: "Server", operations: method("setSecureContext") },
  {
    id: "server",
    module: "node:http",
    export: "Server",
    operations: [...method("close"), ...method("listen"), ...method("asyncDispose")],
  },
  {
    id: "response",
    module: "node:http",
    export: "ServerResponse",
    operations: [
      getter("socket"),
      getter("connection"),
      getter("writableFinished"),
      ...method("cork"),
      ...method("uncork"),
    ],
  },
];

function execute(group) {
  const { writeSync } = require("node:fs");
  const emit = value => writeSync(1, JSON.stringify(value) + "\n");
  const later = [];
  const promises = [];
  process.on("uncaughtException", error => later.push(textOfError(error)));
  process.on("unhandledRejection", error => later.push("rejection: " + textOfError(error)));
  const level = require(group.module)[group.export].prototype;
  const ids = [];
  const descriptors = [];
  for (let operationIndex = 0; operationIndex < group.operations.length; operationIndex++) {
    if (operationIndex !== group.operationIndex) continue;
    const operation = group.operations[operationIndex];
    const key = operation.key === "asyncDispose" ? Symbol.asyncDispose : operation.key;
    let owner = level;
    let depth = 0;
    let descriptor;
    while (owner !== null) {
      descriptor = Object.getOwnPropertyDescriptor(owner, key);
      if (descriptor) break;
      owner = Object.getPrototypeOf(owner);
      depth++;
    }
    descriptors.push({
      operationIndex,
      key: operation.key,
      found: !!descriptor,
      depth: descriptor ? depth : null,
      get: typeof descriptor?.get,
      value: typeof descriptor?.value,
    });
    for (let receiverIndex = 0; receiverIndex < receivers.length; receiverIndex++) {
      if (receiverIndex !== group.receiverIndex) continue;
      const [name, make] = receivers[receiverIndex];
      const before = new Map(Reflect.ownKeys(level).map(key => [key, Object.getOwnPropertyDescriptor(level, key)]));
      const receiver = make(level);
      const isObject = typeof receiver === "object" && receiver !== null;
      const keysBefore = new Set(isObject ? Reflect.ownKeys(receiver) : []);
      const id = group.id + ":" + operationIndex + ":" + receiverIndex;
      const record = {
        type: "case",
        id,
        operation: operation.key,
        kind: operation.kind,
        args: operation.args,
        receiver: name,
      };
      const call = operation.kind === "get" ? descriptor?.get : descriptor?.value;
      try {
        if (typeof call !== "function") record.outcome = "absent";
        else {
          const result = Reflect.apply(call, receiver, operation.args);
          record.outcome = textOfValue(result, receiver);
          if (result instanceof Promise) {
            const promise = { id, state: "pending" };
            promises.push(promise);
            result.then(
              value => Object.assign(promise, { state: "fulfilled", outcome: textOfValue(value, receiver) }),
              error => Object.assign(promise, { state: "rejected", outcome: textOfError(error) }),
            );
          }
        }
      } catch (error) {
        record.outcome = textOfError(error);
      }
      record.stored = isObject
        ? Reflect.ownKeys(receiver)
            .filter(key => !keysBefore.has(key))
            .map(textOfKey)
        : [];
      for (const key of Reflect.ownKeys(level)) if (!before.has(key)) delete level[key];
      for (const [key, descriptor] of before) {
        try {
          Object.defineProperty(level, key, descriptor);
        } catch {}
      }
      ids.push(id);
      emit(record);
    }
  }
  let turns = 0;
  function finish() {
    if (++turns < 4) return setImmediate(finish);
    emit({ type: "complete", group: group.id, count: ids.length, ids, descriptors, later, promises });
    process.exit(0);
  }
  setImmediate(finish);
}

const env = {
  ...process.env,
  NODE_OPTIONS: "",
  BUN_OPTIONS: "",
  NO_COLOR: "1",
  TZ: "Etc/UTC",
  BUN_FEATURE_FLAG_INTERNAL_FOR_TESTING: "1",
  BUN_GARBAGE_COLLECTOR_LEVEL: "0",
  BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
  BUN_DEBUG_QUIET_LOGS: "1",
  GITHUB_ACTIONS: "false",
  CI: "1",
  BUN_DISABLE_SLOW_FILESYSTEM_WARNING: "1",
  BUN_CONFIG_HTTP_RETRY_BACKOFF: "1",
  BUN_INTERNAL_INTERACTIVE_ASSUME_TTY: "1",
  BUN_FEATURE_FLAG_EXPERIMENTAL_BAKE: "1",
  BUN_DEBUG_linkerctx: "0",
  WANTS_LOUD: "0",
  AGENT: "false",
};
delete env.JSC_useJIT;
delete env.NODE_OPTIONS;
delete env.FORCE_COLOR;
const summary = {
  complete: false,
  probeSource: process.env.GITHUB_SHA,
  nodeVersion: process.version,
  engineReceipt: JSON.parse(readFileSync("build/release/engine-source.json", "utf8")),
  binarySHA256: createHash("sha256").update(readFileSync("build/release/bun")).digest("hex"),
  nativeSource: "11e3dd7ffa155cb63a38028adcc94be71553671d",
  isolation: "one operation, arguments and receiver per process; restore before four Immediate turns",
  engineSource: "651eeaca6e2792378928033b1ae7ac66d6f91eab",
  fixtureSHA256: createHash("sha256").update(fixture).digest("hex"),
  records: [],
  differences: [],
};
const save = () => writeFileSync(join(folder, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
save();
const receiversForParent = Array.from({ length: 11 });
const isolatedGroups = groups.flatMap(group =>
  group.operations.flatMap((_, operationIndex) =>
    receiversForParent.map((_, receiverIndex) => ({ ...group, operationIndex, receiverIndex })),
  ),
);
const observations = new Map();
for (const [runtime, executable] of [
  ["node", process.execPath],
  ["candidate", resolve("build/release/bun")],
]) {
  let total = 0;
  const cases = [];
  for (const group of isolatedGroups) {
    const source = helpers + "\n(" + execute.toString() + ")(" + JSON.stringify(group) + ");";
    const child = spawnSync(executable, ["-e", source], {
      env,
      encoding: "utf8",
      timeout: 15000,
      maxBuffer: 4 * 1024 * 1024,
    });
    const name = runtime + "-" + group.id + "-" + group.operationIndex + "-" + group.receiverIndex;
    writeFileSync(join(folder, name + ".stdout.jsonl"), child.stdout ?? "");
    writeFileSync(join(folder, name + ".stderr.log"), child.stderr ?? "");
    const status = {
      runtime,
      group: group.id,
      caseId: group.id + ":" + group.operationIndex + ":" + group.receiverIndex,
      exitCode: child.status,
      signal: child.signal,
      error: child.error?.message,
    };
    summary.records.push(status);
    save();
    assert(!child.error && !child.signal && child.status === 0, JSON.stringify(status));
    const lines = child.stdout
      .trim()
      .split("\n")
      .map(line => JSON.parse(line));
    const complete = lines.filter(line => line.type === "complete");
    const actual = lines.filter(line => line.type === "case");
    const expected = [group.id + ":" + group.operationIndex + ":" + group.receiverIndex];
    assert.equal(complete.length, 1);
    assert.deepEqual(
      actual.map(line => line.id),
      expected,
    );
    assert.deepEqual(complete[0].ids, expected);
    assert.equal(complete[0].count, expected.length);
    assert.equal(complete[0].descriptors.length, 1);
    status.count = expected.length;
    status.descriptors = complete[0].descriptors;
    status.later = complete[0].later;
    status.promises = complete[0].promises;
    total += actual.length;
    cases.push(...actual);
    save();
  }
  assert.equal(total, 176);
  observations.set(runtime, new Map(cases.map(value => [value.id, value])));
}
for (const [id, node] of observations.get("node")) {
  const candidate = observations.get("candidate").get(id);
  assert(candidate);
  if (JSON.stringify(node) !== JSON.stringify(candidate)) summary.differences.push({ id, node, candidate });
}
summary.pendingPromises = summary.records.flatMap(record =>
  record.promises
    .filter(promise => promise.state === "pending")
    .map(promise => ({ runtime: record.runtime, ...promise })),
);
summary.settlementLimitation =
  "Four Immediate turns are a bounded observation window; pending promises are unresolved proof gaps.";

// Capture the unchanged tests' failures before collecting candidate snapshot bytes.
const snapshotPaths = [
  "test/js/node/__snapshots__/members-of-prototype-objects-for-any-receiver.test.ts.snap",
  "test/js/node/__snapshots__/visible-surface.test.ts.snap",
];
const testPaths = [
  "test/js/node/members-of-prototype-objects-for-any-receiver.test.ts",
  "test/js/node/visible-surface.test.ts",
];
summary.snapshotRuns = [];
for (const update of [false, true]) {
  const child = spawnSync(
    resolve("build/release/bun"),
    ["test", ...testPaths, ...(update ? ["--update-snapshots"] : [])],
    {
      env,
      encoding: "utf8",
      timeout: 120000,
      maxBuffer: 32 * 1024 * 1024,
    },
  );
  const name = update ? "candidate-snapshots" : "original-snapshot-failures";
  writeFileSync(join(folder, name + ".stdout.log"), child.stdout ?? "");
  writeFileSync(join(folder, name + ".stderr.log"), child.stderr ?? "");
  const status = { update, exitCode: child.status, signal: child.signal, error: child.error?.message };
  summary.snapshotRuns.push(status);
  save();
  assert(!child.error && !child.signal && child.status === (update ? 0 : 1), JSON.stringify(status));
}
const changed = spawnSync("git", ["diff", "--name-only"], { encoding: "utf8" });
assert.equal(changed.status, 0);
assert.deepEqual(changed.stdout.trim().split("\n").sort(), [...snapshotPaths].sort());
summary.snapshotFiles = snapshotPaths.map(path => {
  const bytes = readFileSync(path);
  const target = path.split("/").at(-1);
  writeFileSync(join(folder, target), bytes);
  return { path, sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length };
});
const patch = spawnSync("git", ["diff", "--", ...snapshotPaths], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
assert.equal(patch.status, 0);
writeFileSync(join(folder, "candidate-snapshots.diff"), patch.stdout);

// Reuse the three unchanged descriptor/constructor walks under both runtimes.
const visiblePath = "test/js/node/visible-surface.test.ts";
const visible = readFileSync(visiblePath, "utf8");
assert(visible.startsWith('import { expect, test } from "bun:test";\n'));
const stripped = require("node:module").stripTypeScriptTypes(visible.slice(visible.indexOf("\n") + 1));
const shim = `
const assert = require("node:assert/strict");
const { writeSync } = require("node:fs");
let title, count = 0;
const emit = value => writeSync(1, JSON.stringify(value) + "\\n");
const test = (name, body) => { title = name; body(); };
const expect = value => ({
  toBe(other) { assert.strictEqual(value, other); },
  toMatchSnapshot() { count++; emit({ type: "snapshot", title, value }); },
});
`;
summary.visibleRuns = [];
for (const [runtime, executable] of [
  ["node", process.execPath],
  ["candidate", resolve("build/release/bun")],
]) {
  const child = spawnSync(
    executable,
    ["-e", shim + stripped + '\nassert.equal(count, 3); emit({ type: "complete", count }); process.exit(0);'],
    {
      env,
      encoding: "utf8",
      timeout: 15000,
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  writeFileSync(join(folder, runtime + "-visible.stdout.jsonl"), child.stdout ?? "");
  writeFileSync(join(folder, runtime + "-visible.stderr.log"), child.stderr ?? "");
  const status = { runtime, exitCode: child.status, signal: child.signal, error: child.error?.message };
  summary.visibleRuns.push(status);
  save();
  assert(!child.error && !child.signal && child.status === 0, JSON.stringify(status));
  const rows = child.stdout
    .trim()
    .split("\n")
    .map(line => JSON.parse(line));
  assert.equal(rows.filter(row => row.type === "snapshot").length, 3);
  assert.deepEqual(rows.at(-1), { type: "complete", count: 3 });
}
summary.visibleSourceSHA256 = createHash("sha256").update(visible).digest("hex");
summary.complete = true;
save();
console.log(JSON.stringify({ complete: true, casesPerRuntime: 176, differences: summary.differences.length }));
