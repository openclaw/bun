import assert from "node:assert/strict";
import fs from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

const source = fs.readFileSync(new URL("./checker-compare.mts", import.meta.url), "utf8");
function section(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `missing source section: ${start}`);
  return source.slice(from, to);
}

// Load only the actual parser and gates; importing the driver starts a benchmark.
const context = vm.createContext({ path });
vm.runInContext(
  stripTypeScriptTypes(
    section("function matchesBunSummary(", "async function provision(") +
      section("function compare(", "async function main(") +
      `
  function output(facts) {
    const { overflow, error, resourceContractStable, cacheValid, inventoryValid,
      inventory, parsed, candidate, stderr, repo, cwd, code, state } = facts;
    ${section("    const validOutput =", "    const fileBase =")}
    return { validOutput, checkedFiles: Number.isNaN(checkedFiles) ? null : checkedFiles };
  }
  globalThis.api = { output, preflightPassed, scalarControlsPassed };
`,
  ),
  context,
);
const api = context.api;

function fixtureRows() {
  const diagnostic = {
    file: "fixture.ts",
    line: 1,
    column: 7,
    code: 2322,
    message: "Type 'string' is not assignable to type 'number'.",
  };
  const rows = [];
  for (const state of ["fixture-positive", "fixture-negative"])
    for (const candidate of ["current", "bun"])
      rows.push({
        graph: "fixture-scalar",
        candidate,
        state,
        exitCode: state === "fixture-negative" ? (candidate === "bun" ? 1 : 2) : 0,
        diagnostics: state === "fixture-negative" ? [diagnostic] : [],
        stderr:
          candidate !== "bun"
            ? ""
            : state === "fixture-negative"
              ? "Found 1 error in 1 file, checked 68 files [116.04ms]\n"
              : "✓ No type errors in 68 files [148.83ms]\n",
      });
  for (const [graph, count, time, listTime] of [
    ["core", "15,822", "69.13", "2.75"],
    ["ui", "14,645", "62.32", "4.29"],
  ])
    for (const candidate of ["current", "bun"])
      for (const state of ["preflight", "inventory"])
        rows.push({
          graph,
          candidate,
          state,
          exitCode: 0,
          diagnostics: [],
          inventory: state === "inventory" ? { application: [`${graph}/input.ts`], libraries: [] } : undefined,
          stderr:
            candidate !== "bun"
              ? ""
              : state === "inventory"
                ? `✓ No type errors in 0 files [${listTime}s]\n`
                : `✓ No type errors in ${count} files [${time}s]\n`,
        });
  return rows.map(row => ({ repetition: 0, resourceContractStable: true, error: null, cwd: "/fixture", ...row }));
}

// Optional argument replays the retained results.jsonl and complete stderr files.
const raw = process.argv[2];
const rows = raw
  ? fs.readFileSync(path.join(raw, "results.jsonl"), "utf8").trim().split("\n").map(JSON.parse)
  : fixtureRows();
function facts(row) {
  return {
    overflow: false,
    error: row.error,
    resourceContractStable: row.resourceContractStable,
    cacheValid: true,
    inventoryValid: true,
    inventory: row.inventory,
    parsed: { diagnostics: row.diagnostics, unparsed: [] },
    candidate: { name: row.candidate },
    stderr: raw ? fs.readFileSync(path.join(raw, row.stderrFile), "utf8") : row.stderr,
    repo: "/source",
    cwd: row.cwd,
    code: row.exitCode,
    state: row.state,
  };
}
const adapted = rows.map(row => ({ ...row, ...api.output(facts(row)) }));
const zero = facts(rows.find(row => row.candidate === "bun" && row.graph === "core" && row.state === "inventory"));

test("captured control and core/UI streams remain valid", () => {
  assert.equal(adapted.length, 12);
  for (const row of adapted) assert.equal(row.validOutput, true, `${row.graph}/${row.candidate}/${row.state}`);
  assert.equal(api.output(zero).checkedFiles, 0);
  const controls = adapted.filter(row => row.graph === "fixture-scalar");
  assert.equal(
    api.scalarControlsPassed(
      controls,
      ["current", "bun"],
      controls.find(row => row.state === "fixture-negative").diagnostics[0].file,
    ),
    true,
  );
});

test("zero checked files are accepted only for a nonempty inventory", () => {
  for (const state of ["preflight", "first", "second"])
    assert.equal(api.output({ ...zero, state }).validOutput, false, state);
  assert.equal(api.output({ ...zero, inventory: { ...zero.inventory, application: [] } }).validOutput, false);
  assert.equal(api.output({ ...zero, inventoryValid: false }).validOutput, false);
});

test("malformed and incomplete summaries cannot qualify", () => {
  for (const stderr of ["", zero.stderr + "unexpected\n", "Could not finish checking 1 file, checked 0 files [1s]\n"])
    assert.equal(api.output({ ...zero, stderr }).validOutput, false, stderr);
  assert.equal(api.output({ ...zero, stderr: "" }).checkedFiles, null);
  const negative = facts(rows.find(row => row.candidate === "bun" && row.state === "fixture-negative"));
  assert.equal(
    api.output({ ...negative, stderr: negative.stderr.replace("checked 68", "checked 0") }).validOutput,
    false,
  );
  assert.equal(api.output({ ...zero, parsed: negative.parsed }).validOutput, false);
});

test("full nonempty application inventories must still agree", () => {
  const preflights = adapted.filter(row => ["preflight", "inventory"].includes(row.state));
  assert.equal(api.preflightPassed(preflights, 2), true);
  const target = preflights.find(row => row.candidate === "bun" && row.graph === "core" && row.state === "inventory");
  const mismatch = preflights.map(row =>
    row === target
      ? { ...row, inventory: { ...row.inventory, application: [...row.inventory.application, "extra.ts"] } }
      : row,
  );
  assert.equal(api.preflightPassed(mismatch, 2), false);
  const empty = preflights.map(row =>
    row.state === "inventory" ? { ...row, inventory: { ...row.inventory, application: [] } } : row,
  );
  assert.equal(api.preflightPassed(empty, 2), false);
});

// Policy guards load the actual caller functions; no compiler runs in these probes.
const policyContext = vm.createContext({ path, fs });
vm.runInContext(
  stripTypeScriptTypes(
    section("function policyEnvironment(", "function verifySource(") +
      section("function resourceContract(", "function parseDiagnostics(") +
      "globalThis.policyApi = { policyEnvironment, configuredBunWorkers, assertCiProfile };",
  ),
  policyContext,
);
const policyApi = policyContext.policyApi;
const runnerSource = fs.readFileSync(new URL("./input/runner.mjs", import.meta.url), "utf8");
const runnerContext = vm.createContext({ path, fs });
vm.runInContext(
  runnerSource.slice(
    runnerSource.indexOf("function policyEnvironment("),
    runnerSource.indexOf("function parseDiagnostics("),
  ) + "globalThis.policyApi = { policyEnvironment, configuredBunWorkers, assertCiProfile };",
  runnerContext,
);

test("Bun worker derivation follows the source grammar and override order", () => {
  const cases = [
    [{}, 4],
    [{ GOMAXPROCS: "1" }, 4],
    [{ UV_THREADPOOL_SIZE: "8", GOMAXPROCS: "2" }, 8],
    [{ UV_THREADPOOL_SIZE: "1", GOMAXPROCS: "3" }, 3],
    [{ UV_THREADPOOL_SIZE: "invalid", GOMAXPROCS: "3" }, 3],
    [{ UV_THREADPOOL_SIZE: "65536", GOMAXPROCS: "3" }, 3],
    [{ UV_THREADPOOL_SIZE: " \t+0_0_4\n" }, 4],
    [{ UV_THREADPOOL_SIZE: "1__024" }, 1024],
    [{ UV_THREADPOOL_SIZE: "65535" }, 1024],
    [{ UV_THREADPOOL_SIZE: "-4", GOMAXPROCS: "3" }, 3],
    [{ UV_THREADPOOL_SIZE: "_4", GOMAXPROCS: "3" }, 3],
    [{ UV_THREADPOOL_SIZE: "4_", GOMAXPROCS: "3" }, 3],
    [{ UV_THREADPOOL_SIZE: "\u00a04", GOMAXPROCS: "3" }, 3],
    [{ UV_THREADPOOL_SIZE: "\v4", GOMAXPROCS: "3" }, 3],
    [{ UV_THREADPOOL_SIZE: "4\v", GOMAXPROCS: "3" }, 3],
  ];
  for (const api of [policyApi, runnerContext.policyApi])
    for (const [env, expected] of cases) {
      const original = JSON.stringify(env);
      assert.equal(api.configuredBunWorkers(4, env), expected, original);
      assert.equal(JSON.stringify(env), original);
    }
});

test("four-CPU admission rejects contradictory or unknown resource policy", () => {
  const limits = { "/cg": { "cpu.max": "400000 100000", "cpuset.cpus.effective": "0-3" } };
  const contract = { affinity: "0-3", limits };
  const native = {
    args: ["--singleThreaded", "--checkers", "1"],
    env: { GOMAXPROCS: "2", GOGC: "30", GOMEMLIMIT: "3GiB" },
  };
  for (const api of [policyApi, runnerContext.policyApi]) {
    const check = (overrides = {}) =>
      api.assertCiProfile(
        ...Object.values({
          cpus: 4,
          capacity: 16 * 1024 ** 3,
          contract,
          hardware: 4,
          workers: 4,
          native,
          ...overrides,
        }),
      );
    check();
    for (const overrides of [
      { cpus: 3 },
      { capacity: null },
      { capacity: 0 },
      { capacity: 24 * 1024 ** 3 },
      { hardware: 8 },
      { workers: 2 },
      { contract: { ...contract, affinity: "0-2" } },
      { contract: { ...contract, affinity: "0,0,0,0" } },
      { contract: { ...contract, limits: { "/cg": { "cpu.max": "300000 100000" } } } },
      { contract: { ...contract, limits: { "/cg": { "cpu.max": "max invalid" } } } },
      { contract: { ...contract, limits: { "/cg": { "cpuset.cpus.effective": "0-2" } } } },
      { native: { ...native, env: { ...native.env, GOMAXPROCS: "1" } } },
    ])
      assert.throws(() => check(overrides), undefined, JSON.stringify(overrides));
    check({ contract: { ...contract, limits: { "/cg": { "cpu.max": "max 100000" } } } });
    check({ contract: { ...contract, affinity: "0-2,2-3" } });
  }
});

test("policy receipts expose only the explicit nonsecret allowlist", () => {
  const env = {
    CI: "true",
    OPENCLAW_LOCAL_CHECK: "0",
    OPENCLAW_LOCAL_CHECK_MODE: "auto",
    GOMAXPROCS: "1",
    GOGC: "30",
    GOMEMLIMIT: "3GiB",
    UV_THREADPOOL_SIZE: "4",
    GH_TOKEN: "never record this",
    PATH: "not part of policy",
  };
  for (const api of [policyApi, runnerContext.policyApi]) {
    const result = JSON.parse(JSON.stringify(api.policyEnvironment(env)));
    assert.deepEqual(result, Object.fromEntries(Object.entries(env).slice(0, 7)));
  }
});

test("one matrix argument owner covers controls, probes, checks and inventories", () => {
  const start = runnerSource.indexOf("    const config = path.resolve(repo, graph.config);");
  const end = runnerSource.indexOf("    const resourcesBefore = resourceContract();", start);
  assert.ok(start >= 0 && end > start);
  const ctx = vm.createContext({
    path,
    repo: "/source",
    ciEnv: { CI: "true", OPENCLAW_LOCAL_CHECK: "0" },
    nativeEnv: { CI: "true", OPENCLAW_LOCAL_CHECK: "0", nativeOnly: true },
    hostResources: { logicalCpuCount: 4, totalMemoryBytes: 16 * 1024 ** 3 },
    applyLocalTsgoPolicy: (args, env, resources) => ({ args, env, resources }),
  });
  vm.runInContext(
    "globalThis.prepare = (candidate, graph, phase) => { " + runnerSource.slice(start, end) + "return {args, env}; };",
    ctx,
  );
  for (const graph of [
    { config: "control.json" },
    { config: "semantic.json", all: true },
    { config: "core.json" },
    { config: "refs.json", build: true },
  ])
    for (const phase of ["check", "inventory"]) {
      const bun = ctx.prepare("bun", graph, phase);
      assert.equal(bun.args.includes("--threads"), false);
      assert.equal(bun.env.nativeOnly, undefined);
      assert.equal(bun.env.CI, "true");
      assert.equal(bun.args.includes("--listFilesOnly"), phase === "inventory");
      const native = ctx.prepare("native", graph, phase);
      assert.equal(native.env.nativeOnly, true);
      assert.equal(native.args.includes("--singleThreaded"), false, "the canonical helper owns thread flags");
      assert.equal(ctx.prepare("upstream", graph, phase).args.includes("--threads"), true);
    }
});

test("matrix resource failures preserve completed streams and reject before new starts", async () => {
  const start = runnerSource.indexOf("  async function run(candidate, graph, phase)");
  const end = runnerSource.indexOf("  async function nativeInventory(", start);
  assert.ok(start >= 0 && end > start);
  for (const failure of ["before-change", "after-error", "after-change", "none"]) {
    const admitted = { cpu: 4 },
      written = new Map(),
      executions = [];
    let reads = 0,
      spawns = 0;
    const ctx = vm.createContext({
      path,
      Buffer,
      Date,
      repo: "/source",
      neutral: "/neutral",
      output: "/proof",
      deadline: Date.now() + 60_000,
      ciEnv: {},
      nativeEnv: {},
      hostResources: {},
      manifest: { nativeReferenceTimeoutSeconds: 600, rowTimeoutSeconds: 300 },
      executables: { bun: "/binary" },
      resources: admitted,
      executions,
      resourceContract() {
        reads++;
        if (reads === 1 && failure === "before-change") return { cpu: 3 };
        if (reads === 2 && failure === "after-error") throw new Error("snapshot unreadable");
        if (reads === 2 && failure === "after-change") return { cpu: 3 };
        return admitted;
      },
      async runManagedCommand(options) {
        spawns++;
        const stream = text => ({
          on(event, callback) {
            callback(Buffer.from(text));
          },
        });
        options.onReady({ stdout: stream("complete diagnostic stream"), stderr: stream("complete summary") });
        return 0;
      },
      hasUnjoinedWork: () => false,
      fileHash: () => "hash",
      policyEnvironment: env => env,
      parseDiagnostics: () => ({ diagnostics: [], unparsed: [] }),
      bunSummary: () => ({ valid: true, checkedFiles: 68 }),
      fs: {
        writeFileSync: (file, text) => written.set(file, text),
        appendFileSync: (file, text) => written.set(file, text),
      },
    });
    vm.runInContext(runnerSource.slice(start, end) + "globalThis.runProbe = run;", ctx);
    let error;
    try {
      await ctx.runProbe("bun", { name: "core", config: "core.json", configSha256: "hash" }, "check");
    } catch (caught) {
      error = caught;
    }
    assert.equal(spawns, failure === "before-change" ? 0 : 1, failure);
    if (failure === "before-change") {
      assert.equal(executions.length, 0);
    } else {
      assert.equal(executions.length, 1);
      const result = executions[0];
      assert.equal(written.get(path.join("/proof", result.stdoutFile)), "complete diagnostic stream");
      assert.equal(written.get(path.join("/proof", result.stderrFile)), "complete summary");
      assert.equal(result.code, 0);
      assert.equal(result.validOutput, failure === "none");
      if (failure === "after-error") assert.equal(result.resourceError, "snapshot unreadable");
    }
    assert.equal(Boolean(error), failure !== "none");
  }
});

test("comparator resource failures retain completed rows and prevent unsafe starts", async () => {
  const start = source.indexOf("  const run = async (");
  const end = source.indexOf("  let completed = false;", start);
  assert.ok(start >= 0 && end > start);
  for (const failure of ["before-change", "after-error", "after-change", "none"]) {
    const admitted = { cpu: 4 },
      written = new Map(),
      results = [];
    let reads = 0,
      spawns = 0;
    const ctx = vm.createContext({
      path,
      Buffer,
      performance,
      Error,
      repo: "/source",
      neutral: "/neutral",
      runDir: "/proof",
      results,
      controls: [],
      ticks: 100,
      deadline: performance.now() + 60_000,
      ciEnv: {},
      nativeEnv: {},
      hostResources: {},
      host: { resourceContract: admitted },
      setInterval: () => 1,
      clearInterval() {},
      console: { log() {} },
      resourceContract() {
        reads++;
        if (reads === 1 && failure === "before-change") return { cpu: 3 };
        if (reads === 2 && failure === "after-error") throw new Error("snapshot unreadable");
        if (reads === 2 && failure === "after-change") return { cpu: 3 };
        return admitted;
      },
      createTsgoResourceSampler: () => ({ sample() {}, result: () => ({}) }),
      async runManagedCommand(options) {
        spawns++;
        const stream = text => ({
          on(event, callback) {
            callback(Buffer.from(text));
          },
        });
        options.onReady({
          pid: 1234,
          stdout: stream("complete diagnostic stream"),
          stderr: stream("✓ No type errors in 68 files [1s]"),
        });
        return 0;
      },
      hasUnjoinedWork: () => false,
      readHash: () => "hash",
      applyLocalTsgoPolicy: (args, env) => ({ args, env }),
      policyEnvironment: env => env,
      parseDiagnostics: () => ({ diagnostics: [], unparsed: [] }),
      matchesBunSummary: () => true,
      fs: {
        mkdirSync() {},
        writeFileSync: (file, text) => written.set(file, text),
        appendFileSync: (file, text) => written.set(file, text),
      },
    });
    vm.runInContext(stripTypeScriptTypes(source.slice(start, end)) + "globalThis.runProbe = run;", ctx);
    let error;
    try {
      await ctx.runProbe({ name: "bun", bin: "/binary" }, { name: "core", config: "core.json" }, "first", 0, "/cache");
    } catch (caught) {
      error = caught;
    }
    assert.equal(spawns, failure === "before-change" ? 0 : 1, failure);
    if (failure === "before-change") assert.equal(results.length, 0);
    else {
      assert.equal(results.length, 1);
      const result = results[0];
      assert.equal(written.get(path.join("/proof", result.stdoutFile)), "complete diagnostic stream");
      assert.equal(written.get(path.join("/proof", result.stderrFile)), "✓ No type errors in 68 files [1s]");
      assert.equal(result.exitCode, 0);
      assert.equal(result.validOutput, failure === "none");
      if (failure === "after-error") assert.equal(result.resourceError, "snapshot unreadable");
    }
    assert.equal(Boolean(error), failure !== "none");
  }
});

test("workflow dispatch selects exactly its intended workload", () => {
  const workflow = fs.readFileSync(
    new URL("../../../.github/workflows/openclaw-build-test.yml", import.meta.url),
    "utf8",
  );
  const jobs = ["comparison", "benchmark", "linux-x64", "darwin-arm64"];
  const expressions = jobs.map(job => {
    const block = workflow.slice(workflow.indexOf("  " + job + ":"));
    const expression = /^    if: (.*)$/m.exec(block)?.[1];
    assert.ok(expression, job);
    return [job, expression];
  });
  const admitted = (event, mode, platform = "both", repository = "openclaw/bun") =>
    expressions
      .filter(([, expression]) =>
        vm.runInNewContext(expression, {
          github: { event_name: event, repository },
          inputs: { mode, platform },
        }),
      )
      .map(([job]) => job);
  assert.deepEqual(admitted("workflow_dispatch", "comparison"), ["comparison"]);
  assert.deepEqual(admitted("workflow_dispatch", "benchmark"), ["benchmark"]);
  assert.deepEqual(admitted("workflow_dispatch", "native"), ["linux-x64", "darwin-arm64"]);
  assert.deepEqual(admitted("workflow_dispatch", "native", "linux-x64"), ["linux-x64"]);
  assert.deepEqual(admitted("workflow_dispatch", "native", "darwin-arm64"), ["darwin-arm64"]);
  assert.deepEqual(admitted("pull_request", undefined), ["linux-x64", "darwin-arm64"]);
  assert.deepEqual(admitted("schedule", undefined), ["linux-x64", "darwin-arm64"]);
  assert.deepEqual(admitted("workflow_dispatch", "benchmark", "both", "another/repo"), []);
});
