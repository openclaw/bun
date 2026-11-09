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
};
// Capture exact current outputs for separately reviewed expectation migrations.
if (process.argv.includes("--capture-http")) {
  Object.assign(env, {
    GITHUB_ACTIONS: "false",
    CI: "1",
    BUN_DISABLE_SLOW_FILESYSTEM_WARNING: "1",
    BUN_CONFIG_HTTP_RETRY_BACKOFF: "1",
    BUN_INTERNAL_INTERACTIVE_ASSUME_TTY: "1",
    BUN_FEATURE_FLAG_EXPERIMENTAL_BAKE: "1",
    BUN_DEBUG_linkerctx: "0",
    WANTS_LOUD: "0",
    AGENT: "false",
  });
  delete env.JSC_useJIT;
  delete env.NODE_OPTIONS;
  delete env.FORCE_COLOR;
  const binary = resolve("build/release/bun");
  const http = "test/js/node/http/";
  const parallel = "test/aot/parallel/node-http/";
  const targets = [
    [
      "added-accessors",
      http + "node-http-accessors-added-between-a-socket-and-their-owner-fixture.ts",
      http + "node-http-accessors-added-between-a-socket-and-their-owner.test.ts",
      true,
    ],
    [
      "socket-accessors",
      http + "node-http-replaced-accessors-of-a-socket-fixture.ts",
      http + "node-http-replaced-accessors-of-a-socket.test.ts",
      true,
    ],
    [
      "response-accessors",
      http + "node-http-replaced-accessors-fixture.ts",
      http + "node-http-replaced-accessors.test.ts",
      true,
    ],
    [
      "own-keys",
      "test/aot/parallel/library-modules/keys-responses-sockets-emitters-lives.js",
      http + "node-http-own-keys-through-an-exchange.expected.txt",
      true,
    ],
    [
      "own-values",
      http + "node-http-own-values-through-an-exchange-fixture.js",
      http + "node-http-own-values-through-an-exchange.expected.txt",
      true,
    ],
    ["proxy-traps", parallel + "http-proxy-traps.js", http + "node-http-proxy-traps.expected.txt", false],
    [
      "foreign-receivers",
      parallel + "members-outgoing-messages-receivers.js",
      http + "node-http-members-of-outgoing-messages-for-receivers-that-are-no-messages.expected.txt",
      false,
    ],
    [
      "heir-headers",
      parallel + "headers-of-response-through-proxy-heir.ts",
      http + "node-http-headers-through-an-heir-and-a-proxy.expected.txt",
      true,
    ],
    [
      "heir-state",
      parallel + "state-of-response-through-proxy-and-heir.ts",
      http + "node-http-state-through-an-heir-and-a-proxy.expected.txt",
      true,
    ],
  ];
  const receipt = {
    complete: false,
    mode: "capture-only",
    probeSource: process.env.GITHUB_SHA,
    nativeSource: "56739277f7834a63cdd2ba8fd496672c5ab8f645",
    engineReceipt: JSON.parse(readFileSync("build/release/engine-source.json", "utf8")),
    binarySHA256: createHash("sha256").update(readFileSync(binary)).digest("hex"),
    captures: [],
  };
  const save = () => writeFileSync(join(folder, "http-capture.json"), JSON.stringify(receipt, null, 2) + "\n");
  save();
  function capture(id, args, target, emptyStderr = true, timeout = 60000) {
    const child = spawnSync(binary, args, { env, encoding: "utf8", timeout, maxBuffer: 32 * 1024 * 1024 });
    writeFileSync(join(folder, id + ".stdout.txt"), child.stdout ?? "");
    writeFileSync(join(folder, id + ".stderr.log"), child.stderr ?? "");
    const record = {
      id,
      args,
      target,
      exitCode: child.status,
      signal: child.signal,
      error: child.error?.message,
      stdoutSHA256: createHash("sha256")
        .update(child.stdout ?? "")
        .digest("hex"),
    };
    receipt.captures.push(record);
    save();
    assert(!child.error && !child.signal && child.status === 0, JSON.stringify(record));
    assert(child.stdout.length > 0, "empty output for " + id);
    if (emptyStderr) assert.equal(child.stderr, "", id);
    return child.stdout;
  }
  for (const [id, path, target, emptyStderr] of targets) capture(id, [path], target, emptyStderr);
  const ownFile = http + "node-http-own-accessors-on-an-exchange.test.ts";
  const ownSource = readFileSync(ownFile, "utf8");
  const argument = ownSource.indexOf('"-e",');
  assert(argument >= 0 && ownSource.lastIndexOf('"-e",') === argument);
  const quote = String.fromCharCode(96);
  const start = ownSource.indexOf(quote, argument);
  const end = ownSource.indexOf(quote, start + 1);
  assert(start > argument && end > start);
  const literal = ownSource.slice(start, end + 1);
  assert(!literal.includes("$" + "{"), "unexpected template interpolation");
  const cooked = Function("return " + literal)();
  capture("own-accessors", ["-e", cooked], ownFile);
  receipt.regressionRed = [];
  for (const aot of [false, true]) {
    const id = "https-validation-red-" + aot;
    const pattern = "setSecureContext validates options before its receiver.*AOT: " + aot;
    const child = spawnSync(
      binary,
      ["--expose-internals", "test", "test/js/node/http/node-https-server.test.ts", "--test-name-pattern", pattern],
      { env, encoding: "utf8", timeout: 60000, maxBuffer: 8 * 1024 * 1024 },
    );
    writeFileSync(join(folder, id + ".stdout.txt"), child.stdout ?? "");
    writeFileSync(join(folder, id + ".stderr.log"), child.stderr ?? "");
    const record = { aot, exitCode: child.status, signal: child.signal, error: child.error?.message };
    receipt.regressionRed.push(record);
    save();
    const output = (child.stdout ?? "") + (child.stderr ?? "");
    assert(!child.error && !child.signal && child.status === 1, JSON.stringify(record));
    assert(output.includes("1 fail") && output.includes("incorrect option validation"), id + " did not reproduce");
  }
  const changes = spawnSync("git", ["diff", "--name-only"], { encoding: "utf8" });
  assert.equal(changes.status, 0);
  assert.equal(changes.stdout, "", "capture modified tracked source");
  receipt.complete = true;
  save();
  console.log(JSON.stringify({ complete: true, captures: receipt.captures.length }));
  process.exit(0);
}
const summary = {
  complete: false,
  probeSource: process.env.GITHUB_SHA,
  nodeVersion: process.version,
  engineReceipt: JSON.parse(readFileSync("build/release/engine-source.json", "utf8")),
  binarySHA256: createHash("sha256").update(readFileSync("build/release/bun")).digest("hex"),
  nativeSource: "56739277f7834a63cdd2ba8fd496672c5ab8f645",
  engineSource: "651eeaca6e2792378928033b1ae7ac66d6f91eab",
  fixtureSHA256: createHash("sha256").update(fixture).digest("hex"),
  records: [],
  differences: [],
};
const save = () => writeFileSync(join(folder, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
save();
const observations = new Map();
for (const [runtime, executable] of [
  ["node", process.execPath],
  ["candidate", resolve("build/release/bun")],
]) {
  let total = 0;
  const cases = [];
  for (const group of groups) {
    const source = helpers + "\n(" + execute.toString() + ")(" + JSON.stringify(group) + ");";
    const child = spawnSync(executable, ["-e", source], {
      env,
      encoding: "utf8",
      timeout: 15000,
      maxBuffer: 4 * 1024 * 1024,
    });
    const name = runtime + "-" + group.id;
    writeFileSync(join(folder, name + ".stdout.jsonl"), child.stdout ?? "");
    writeFileSync(join(folder, name + ".stderr.log"), child.stderr ?? "");
    const status = {
      runtime,
      group: group.id,
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
    const expected = group.operations.flatMap((_, operation) =>
      Array.from({ length: 11 }, (_, receiver) => group.id + ":" + operation + ":" + receiver),
    );
    assert.equal(complete.length, 1);
    assert.deepEqual(
      actual.map(line => line.id),
      expected,
    );
    assert.deepEqual(complete[0].ids, expected);
    assert.equal(complete[0].count, expected.length);
    assert.equal(complete[0].descriptors.length, group.operations.length);
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
summary.complete = true;
save();
console.log(JSON.stringify({ complete: true, casesPerRuntime: 176, differences: summary.differences.length }));
