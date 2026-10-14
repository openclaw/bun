import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
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

test("rejected resource admission preserves an empty execution log and seals its receipt", async () => {
  const written = new Map();
  let receipt;
  const manifest = { source: "fixture", budgetSeconds: 60, bun: { binarySha256: "fixture" } };
  const ctx = vm.createContext({
    path,
    Date,
    output: "/proof",
    hostResources: {},
    memory: {},
    resources: {},
    hardwareConcurrency: 2,
    workers: 2,
    nativePolicy: {},
    identity: { manifest, bun: { binarySha256: "fixture" } },
    manifest,
    rows: [],
    controls: [],
    probes: [],
    comparisons: [],
    began: Date.now(),
    process: { exitCode: 0 },
    console: { log() {} },
    fs: {
      writeFileSync: (file, data, options) => {
        if (options) assert.equal(options.flag, "wx");
        written.set(file, data);
      },
    },
    assertCiProfile() {
      throw new Error("Host is outside the admitted four-CPU constrained CI profile");
    },
    withDistArtifactOwnership() {
      assert.fail("a rejected host must not start compiler work");
    },
    verifySource() {},
    writeReceipt(value) {
      receipt = JSON.parse(JSON.stringify(value));
    },
  });
  const initialize = runnerSource.match(/^  fs\.writeFileSync\(path\.join\(output, "executions\.jsonl"\).*$/m)?.[0];
  assert.ok(initialize);
  const start = runnerSource.indexOf("  let completed = false,");
  const end = runnerSource.lastIndexOf("\n}\nmain().catch");
  assert.ok(start >= 0 && end > start);
  await vm.runInContext("(async () => {\n" + initialize + "\n" + runnerSource.slice(start, end) + "\n})()", ctx);
  assert.equal(ctx.process.exitCode, 1);
  assert.equal(written.get("/proof/executions.jsonl"), "");
  assert.equal(receipt.admission.status, "rejected");
  assert.equal(receipt.admission.reason, "resource-profile");
  assert.equal(receipt.sourceVerified, true);
  assert.equal(receipt.rows.length, 0);
  const rejected = receipt;
  Object.assign(manifest, JSON.parse(fs.readFileSync(new URL("./input/manifest.json", import.meta.url), "utf8")));
  manifest.semanticProbes.sha256 = "fixture";
  ctx.identity.bun.binarySha256 = manifest.bun.binarySha256;
  const records = [];
  Object.assign(ctx, {
    repo: "/source",
    inputs: "/input",
    resumeRows: [],
    nativeInventories: new Map(),
    diagnosticExitCode: { bun: 1, native: 2, upstream: 1, oracle: 1 },
    baseline: manifest.native.hostedBaseline,
    nativeBaselines: new Map(manifest.native.hostedBaseline.rows.map(row => [row.config, row])),
    rows: [],
    controls: [],
    probes: [],
    comparisons: [],
    process: { exitCode: 0 },
    hash: text => text,
    fileHash: () => "fixture",
    checkpoint() {},
    assertCiProfile() {},
    ensureKyselyTypes() {},
    withDistArtifactOwnership: (_repo, callback) => callback(),
    async run(candidate, graph, phase) {
      const record = { candidate, graph: graph.name, phase };
      records.push(record);
      const application = graph.build ? manifest.buildReferences.map(ref => ref.config).sort() : [graph.config];
      const negative = graph.name === "negative-control";
      return {
        ...record,
        validOutput: true,
        code: negative ? (candidate === "native" ? 2 : 1) : 0,
        diagnostics: negative
          ? [
              {
                file: path.relative("/source", "/proof/control.ts"),
                line: 1,
                column: 7,
                code: 2322,
                message: "Type 'string' is not assignable to type 'number'.",
              },
            ]
          : [],
        summary: { checkedFiles: 1, projects: graph.build ? 2 : 0 },
        inventory: { application, libraries: [], applicationSha256: JSON.stringify(application) },
        args: [],
        executableSha256: "fixture",
        stdoutFile: "stdout",
        stderrFile: "stderr",
      };
    },
  });
  ctx.fs.mkdirSync = () => {};
  ctx.fs.readFileSync = file => {
    if (String(file).endsWith("semantic-cases.json"))
      return fs.readFileSync(new URL("./input/semantic-cases.json", import.meta.url), "utf8");
    const graph = manifest.graphs.find(graph => graph.build && path.join("/source", graph.config) === file);
    if (graph)
      return JSON.stringify({
        references: manifest.buildReferences.map(ref => ({
          path: path.relative(path.dirname(graph.config), ref.config),
        })),
      });
    return written.get(file) ?? "";
  };
  const inventoryStart = runnerSource.indexOf("  async function nativeInventory(");
  await vm.runInContext("(async () => {\n" + runnerSource.slice(inventoryStart, end) + "\n})()", ctx);
  assert.equal(ctx.process.exitCode, 0, receipt.failure);
  assert.equal(receipt.completed, true);
  assert.equal(receipt.rows.length, 38);
  assert.equal(records.length, 133);
  const successful = receipt;

  const python = String.raw`
import copy,gzip,importlib.util,json,os,signal,sys,tempfile
from pathlib import Path
from types import SimpleNamespace
spec=importlib.util.spec_from_file_location("hosted",sys.argv[1])
hosted=importlib.util.module_from_spec(spec);spec.loader.exec_module(hosted)
original=json.load(sys.stdin)
for case in ("rejected","missing","nonempty","unexplained-empty","success","success-empty","success-corrupt","success-truncated","success-missing-comparisons"):
    with tempfile.TemporaryDirectory(prefix="checker-collection-") as directory:
        root=Path(directory);source=root/"source";output=root/"output";leaf=output/"results"/"bun-matrix-case"
        source.mkdir();leaf.mkdir(parents=True)
        success=case.startswith("success")
        receipt=copy.deepcopy(original["success" if success else "rejected"])
        if case=="unexplained-empty": receipt["admission"]={"status":"accepted"}
        if case=="success-missing-comparisons": receipt["comparisons"]=[]
        (leaf/"receipt.json").write_text(json.dumps(receipt))
        records=original["records"][:-1] if case=="success-truncated" else original["records"]
        if case=="success-missing-comparisons": records=records[:-6]
        text="".join(json.dumps(record)+"\n" for record in records) if case in ("success","success-truncated","success-missing-comparisons") else ""
        if case in ("nonempty","success-corrupt"): text="invalid record"
        if case!="missing": (leaf/"executions.jsonl").write_text(text)
        hosted.prepare_dependencies=lambda *args:(receipt["identity"]["manifest"],dict(os.environ),{})
        hosted.subprocess.run=lambda *args,**kwargs:SimpleNamespace(returncode=0 if success else 1)
        try:
            result=hosted.run(source,root,output)
            assert case in ("rejected","success") and result==(0 if success else 1)
            sealed=json.loads(gzip.decompress((output/"receipt.json.gz").read_bytes()))
            assert sealed["admission"]==receipt["admission"] and sealed["failure"]==receipt["failure"]
            assert gzip.decompress((output/"executions.jsonl.gz").read_bytes()).decode()==text
            assert "controlOutputs" not in sealed
        except (RuntimeError,json.JSONDecodeError):
            assert case not in ("rejected","success"),case
        finally:
            signal.alarm(0)
print("producer/collector: nine cases passed")
`;
  const result = spawnSync("python3", ["-c", python, new URL("./hosted.py", import.meta.url).pathname], {
    input: JSON.stringify({ rejected, success: successful, records }),
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /nine cases passed/);
});

test("workflow dispatch selects exactly its intended workload", () => {
  const workflow = fs.readFileSync(
    new URL("../../../.github/workflows/openclaw-build-test.yml", import.meta.url),
    "utf8",
  );
  const jobs = ["comparison", "benchmark", "linux-x64", "darwin-arm64"];
  const expressions = jobs.map(job => {
    const block = workflow.slice(workflow.indexOf("  " + job + ":"));
    if (job === "comparison" || job === "benchmark")
      assert.equal(/^    runs-on: (.*)$/m.exec(block)?.[1], "ubuntu-24.04");
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
  assert.deepEqual(admitted("workflow_dispatch", "production-trial"), ["benchmark"]);
  assert.deepEqual(admitted("workflow_dispatch", "native"), ["linux-x64", "darwin-arm64"]);
  assert.deepEqual(admitted("workflow_dispatch", "native", "linux-x64"), ["linux-x64"]);
  assert.deepEqual(admitted("workflow_dispatch", "native", "darwin-arm64"), ["darwin-arm64"]);
  assert.deepEqual(admitted("pull_request", undefined), ["linux-x64", "darwin-arm64"]);
  assert.deepEqual(admitted("schedule", undefined), ["linux-x64", "darwin-arm64"]);
  assert.deepEqual(admitted("workflow_dispatch", "benchmark", "both", "another/repo"), []);
});

function productionOutput(graphs) {
  return graphs
    .map((graph, index) => {
      const id = `wrapper-${index}`;
      return (
        `[ci-static:tsgo:leaf] ${JSON.stringify({ version: 1, id: `${id}:0`, config: graph.config, exitCode: 0, stdout: "", stderr: "" })}\n` +
        `[ci-static:tsgo:completion] ${JSON.stringify({ version: 1, id, planned: 1, completed: 1, leaves: [`${id}:0`] })}\n`
      );
    })
    .join("");
}
const productionGraphs = ["core", "ui", "extensions"].map(name => ({ name, config: `tsconfig.${name}.json` }));

test("production proof requires every wrapper completion and all three inventories", () => {
  const ctx = vm.createContext({ path });
  vm.runInContext(
    stripTypeScriptTypes(
      section("function compare(", "async function main(") +
        "globalThis.api = { productionEvidence, productionEligible };",
    ),
    ctx,
  );
  const raw = productionOutput(productionGraphs);
  assert.equal(ctx.api.productionEvidence(raw, "", productionGraphs).leaves.length, 3);
  for (const invalid of [
    productionOutput(productionGraphs.slice(0, 2)),
    raw.replace('"completed":1', '"completed":0'),
    raw.replace('"exitCode":0', '"exitCode":2'),
    raw.replace('"stdout":""', '"stdout":"unexpected diagnostic"'),
    raw.replace("tsconfig.ui.json", "tsconfig.core.json"),
    raw
      .split("\n")
      .filter(line => line.includes(":leaf]"))
      .join("\n") +
      "\n" +
      raw
        .split("\n")
        .filter(line => line.includes(":completion]"))
        .join("\n"),
    raw + raw,
  ])
    assert.throws(() => ctx.api.productionEvidence(invalid, "", productionGraphs));
  assert.throws(() => ctx.api.productionEvidence(raw, "warning", productionGraphs));
  const preflight = adapted.filter(row => ["preflight", "inventory"].includes(row.state));
  const complete = [
    ...preflight,
    ...preflight.filter(row => row.graph === "core").map(row => ({ ...row, graph: "extensions" })),
  ];
  const samples = ["current", "bun"].flatMap(candidate =>
    ["first", "second"].map(state => ({ candidate, state, valid: true })),
  );
  assert.equal(ctx.api.productionEligible(samples, complete, true), true);
  assert.equal(ctx.api.productionEligible(samples, preflight, true), false);
  assert.equal(ctx.api.productionEligible(samples.slice(0, 3), complete, true), false);
  assert.equal(ctx.api.productionEligible(samples, complete, false), false);
});

test("production binds the actual canonical resolver and rejects an unavailable or different native ELF", () => {
  const expected = "ade0aa4724ed7164fb4644255e94d4f98cbcd9f53dbb3973f19aea130fceb51d";
  for (const failure of ["none", "skip", "wrong-elf", "wrong-version", "wrong-script"]) {
    const calls = [];
    const ctx = vm.createContext({
      path,
      JSON,
      phase: "production",
      repo: "/source",
      graphs: productionGraphs,
      ciEnv: { CI: "true", OPENCLAW_LOCAL_CHECK: "0" },
      candidates: [{ name: "current", sha256: failure === "wrong-version" ? "other" : expected }],
      readHash: () => (failure === "wrong-elf" ? "other" : expected),
      verifyHash(_file, hash) {
        assert.equal(hash, expected);
        assert.notEqual(failure, "wrong-elf");
      },
      prepareTsgoCommand(args, env, cwd) {
        calls.push({ args: Array.from(args), env, cwd });
        if (failure === "skip") return null;
        return { args, env, cwd, bin: "/source/node_modules/native/bin/tsgo", timeoutMs: 600000 };
      },
      policyEnvironment: env => env,
      exec: () => "12.9.0",
      fs: {
        readFileSync() {
          const scripts = { "tsgo:prod": "pnpm tsgo:core && pnpm tsgo:ui && pnpm tsgo:extensions" };
          for (const graph of productionGraphs)
            scripts[`tsgo:${graph.name}`] =
              `node scripts/run-tsgo.mjs -p ${graph.config} --incremental --tsBuildInfoFile .artifacts/tsgo-cache/${graph.name}.tsbuildinfo`;
          if (failure === "wrong-script") scripts["tsgo:prod"] = "exit 0";
          return JSON.stringify({ scripts });
        },
      },
    });
    const code = stripTypeScriptTypes(
      section("const PRODUCTION_SCRIPTS =", "type ProductionSample =") +
        section("  const productionEnv =", "  const host =") +
        "globalThis.bound = production;",
    );
    if (failure !== "none") assert.throws(() => vm.runInContext(code, ctx), failure);
    else {
      vm.runInContext(code, ctx);
      assert.equal(calls.length, 3);
      assert.deepEqual(
        calls.map(call => call.args[1]),
        productionGraphs.map(graph => graph.config),
      );
      assert.ok(
        calls.every(
          call => call.env.OPENCLAW_CI_STATIC_EVIDENCE === "1" && call.env.OPENCLAW_TSGO_TIMEOUT_MS === "600000",
        ),
      );
      assert.equal(ctx.bound.nativeCommands.length, 3);
    }
  }
});

test("production adapter rejects partial, wrong-protocol and ineligible summaries", () => {
  const python = String.raw`
import copy,importlib.util,json,sys
from pathlib import Path
sys.path.insert(0, str(Path(sys.argv[1]).parent))
spec=importlib.util.spec_from_file_location("adapter",sys.argv[1]); adapter=importlib.util.module_from_spec(spec);spec.loader.exec_module(adapter)
proof={"source":adapter.hosted.SOURCE,"runId":"production-fixture","completed":True,"controlsPassed":True,"production":{"eligible":True,"protocol":{"name":"production-cold-reuse","version":1,"graphs":["core","ui","extensions"],"repetitions":1},"samples":[{"candidate":candidate,"state":state,"valid":True,"wallMs":100} for candidate in ("current","bun") for state in ("first","second")]}}
assert adapter.production_complete(proof)
for case in ("missing-row","wrong-phase","wrong-protocol","wrong-source","ineligible","failed-row","bad-duration","missing-control","wrong-order"):
    value=copy.deepcopy(proof)
    if case=="missing-row": value["production"]["samples"].pop()
    if case=="wrong-phase": value["runId"]="timing-fixture"
    if case=="wrong-protocol": value["production"]["protocol"]["repetitions"]=3
    if case=="wrong-source": value["source"]="another-source"
    if case=="ineligible": value["production"]["eligible"]=False
    if case=="failed-row": value["production"]["samples"][0]["valid"]=False
    if case=="bad-duration": value["production"]["samples"][0]["wallMs"]=float("nan")
    if case=="missing-control": value["controlsPassed"]=False
    if case=="wrong-order": value["production"]["samples"].reverse()
    assert not adapter.production_complete(value),case
print("adapter production gate: ten cases passed")
`;
  const result = spawnSync(
    "python3",
    ["-c", python, new URL("./checker-benchmark-hosted.py", import.meta.url).pathname],
    { encoding: "utf8", timeout: 10_000, env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } },
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /ten cases passed/);
});

test("production adapter exposes only task-owned Corepack pnpm shims", () => {
  const python = String.raw`
import importlib.util,json,os,shutil,subprocess,sys,tempfile
from pathlib import Path
sys.path.insert(0,str(Path(sys.argv[1]).parent))
spec=importlib.util.spec_from_file_location("adapter",sys.argv[1]);adapter=importlib.util.module_from_spec(spec);spec.loader.exec_module(adapter)
with tempfile.TemporaryDirectory(prefix="production-pnpm-",dir=os.environ.get("BUN_PRODUCTION_TEST_TMP")) as directory:
    root=Path(directory).resolve();source=root/"source";source.mkdir();tools=root/"tools";tools.mkdir()
    corepack=tools/"corepack"
    corepack.write_text("#!"+sys.executable+"\nimport os,pathlib,sys\nassert sys.argv[1:3]==['enable','--install-directory'] and sys.argv[4:]==['pnpm']\nbin_dir=pathlib.Path(sys.argv[3]);assert bin_dir.is_dir()\nfor name in ('pnpm','pnpx'): (bin_dir/name).symlink_to(os.environ['FIXTURE_DIST'])\n")
    corepack.chmod(0o755)
    def fixture(name):
        output=root/name;dist=output/"runtime/node-v24.16.0-linux-x64/lib/node_modules/corepack/dist/pnpm.js";dist.parent.mkdir(parents=True)
        dist.write_text("#!"+sys.executable+"\nimport os,subprocess,sys\nif sys.argv[1:]==['--version']: print(os.environ['FIXTURE_VERSION'])\nelif sys.argv[1:]==['tsgo:prod']: print(subprocess.check_output(['pnpm','tsgo:core'],text=True).strip())\nelif sys.argv[1:]==['tsgo:core']: print('nested-pnpm-ok')\nelse: raise SystemExit(1)\n")
        dist.chmod(0o755)
        return output,dict(PATH=str(tools),FIXTURE_DIST=str(dist),FIXTURE_VERSION="12.9.0")
    output,env=fixture("valid");dependency={"pnpm":"12.9.0"};original=dict(env)
    assert shutil.which("pnpm",path=env["PATH"]) is None
    assert adapter.prepare_production_pnpm(source,output,env,dependency,"timing") is env
    assert not (output/"production-bin").exists() and dependency=={"pnpm":"12.9.0"}
    prepared=adapter.prepare_production_pnpm(source,output,env,dependency,"production")
    assert env==original and prepared["PATH"].split(os.pathsep)[1:]==[env["PATH"]]
    assert subprocess.check_output(["pnpm","tsgo:prod"],cwd=source,env=prepared,text=True).strip()=="nested-pnpm-ok"
    binding=json.loads((output/"dependency-receipt.json").read_text())["productionPnpm"]
    assert binding["version"]=="12.9.0" and binding["corepackVersion"]=="0.35.0"
    assert binding["executable"]==env["FIXTURE_DIST"] and binding["sha256"]==adapter.hosted.sha(Path(env["FIXTURE_DIST"]))
    for case in ("wrong-version","foreign-runtime"):
        output,env=fixture(case)
        if case=="wrong-version":env["FIXTURE_VERSION"]="12.8.0"
        else:env["FIXTURE_DIST"]=binding["executable"]
        try:adapter.prepare_production_pnpm(source,output,env,{},"production")
        except RuntimeError:pass
        else:raise AssertionError(case)
        assert not (output/"dependency-receipt.json").exists()
print("production pnpm: timing untouched, owned nested launcher valid, wrong version/runtime rejected")
`;
  const result = spawnSync(
    "python3",
    ["-c", python, new URL("./checker-benchmark-hosted.py", import.meta.url).pathname],
    { encoding: "utf8", timeout: 10_000, env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } },
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /timing untouched, owned nested launcher valid/);
});

test("whole production samples preserve lock ownership, exact caches and failures", async () => {
  for (const failure of ["none", "missing-completion", "cache-change", "timeout", "resource-after"]) {
    const files = new Map();
    const samples = [];
    let ownership = 0,
      nativeStarts = 0,
      bunStarts = 0,
      clock = 0,
      snapshot = 0;
    const cache = graph => path.join("/repo/.artifacts/tsgo-cache", `${graph.name}.tsbuildinfo`);
    for (const graph of productionGraphs) files.set(cache(graph), "old cache");
    files.set("/repo/.artifacts/tsgo-cache/unrelated.tsbuildinfo", "preserve");
    const ctx = vm.createContext({
      path,
      Buffer,
      JSON,
      console: { log() {} },
      graphs: productionGraphs,
      repo: "/repo",
      runDir: "/proof",
      deadline: 1e9,
      neutral: "/neutral",
      ciEnv: { CI: "true", OPENCLAW_LOCAL_CHECK: "0" },
      productionEnv: { CI: "true", OPENCLAW_CI_STATIC_EVIDENCE: "1", OPENCLAW_TSGO_TIMEOUT_MS: "600000" },
      production: { nativeCommands: ["bound actual native ELF"] },
      productionSamples: samples,
      warmCaches: undefined,
      performance: { now: () => ++clock },
      host: { resourceContract: { stable: true } },
      verifyInputs() {},
      prepareProduction: () => ["bound actual native ELF"],
      resourceContract() {
        snapshot++;
        if (failure === "resource-after" && snapshot === 2) throw new Error("post-snapshot unavailable");
        return { stable: true };
      },
      policyEnvironment: env => env,
      readHash: file => files.get(file) ?? null,
      validBuildInfo(file, version) {
        try {
          return JSON.parse(files.get(file)).version === version;
        } catch {
          return false;
        }
      },
      fs: {
        existsSync: file => files.has(file),
        lstatSync: file => (files.has(file) ? { isFile: () => true } : undefined),
        unlinkSync: file => {
          assert.ok(productionGraphs.some(graph => cache(graph) === file));
          files.delete(file);
        },
        writeFileSync: (file, value) => files.set(file, value),
        appendFileSync: (file, value) => files.set(file, (files.get(file) ?? "") + value),
      },
      async withDistArtifactOwnership(_repo, callback) {
        ownership++;
        try {
          return await callback();
        } finally {
          ownership--;
        }
      },
      async runManagedCommand(command) {
        assert.equal(ownership, 0, "canonical wrappers must acquire their own lock");
        assert.deepEqual(Array.from(command.args), ["tsgo:prod"]);
        assert.equal(command.bin, "pnpm");
        assert.equal(command.env.OPENCLAW_CI_STATIC_EVIDENCE, "1");
        if (nativeStarts++ === 0) assert.ok(productionGraphs.every(graph => !files.has(cache(graph))));
        if (failure === "timeout") throw new Error("ETIMEDOUT");
        for (const graph of productionGraphs)
          files.set(cache(graph), JSON.stringify({ version: "pinned", root: [1], fileNames: ["input.ts"] }));
        const raw = productionOutput(
          failure === "missing-completion" ? productionGraphs.slice(0, 2) : productionGraphs,
        );
        command.onReady({ stdout: { on: (_event, callback) => callback(Buffer.from(raw)) }, stderr: { on() {} } });
        return 0;
      },
      async run(_candidate, graph, state) {
        assert.equal(ownership, 1);
        bunStarts++;
        return {
          graph: graph.name,
          state,
          validOutput: true,
          exitCode: 0,
          args: ["check", "--project", graph.config],
          stdoutFile: "child.stdout",
          stderrFile: "child.stderr",
        };
      },
    });
    vm.runInContext(
      stripTypeScriptTypes(
        section("function productionEvidence(", "async function main(") +
          section("  const runProduction = async (", "  let completed = false;") +
          "globalThis.runProduction = runProduction;",
      ),
      ctx,
    );
    let caught;
    try {
      await ctx.runProduction({ name: "current", version: "pinned" }, "first");
      if (failure === "cache-change")
        files.set(cache(productionGraphs[0]), JSON.stringify({ version: "pinned", changed: true }));
      await ctx.runProduction({ name: "current", version: "pinned" }, "second");
      await ctx.runProduction({ name: "bun" }, "first");
      await ctx.runProduction({ name: "bun" }, "second");
    } catch (error) {
      caught = error;
    }
    assert.equal(files.get("/repo/.artifacts/tsgo-cache/unrelated.tsbuildinfo"), "preserve");
    assert.equal(ownership, 0);
    if (failure === "none") {
      assert.equal(caught, undefined);
      assert.equal(nativeStarts, 2);
      assert.equal(bunStarts, 6);
      assert.equal(samples.length, 4);
      assert.ok(samples.every(sample => sample.valid && sample.wallMs > 0));
      assert.deepEqual(samples[1].cacheBefore, samples[0].cacheAfter);
    } else {
      assert.ok(caught, failure);
      assert.equal(bunStarts, 0);
      if (failure !== "cache-change") {
        assert.equal(samples.length, 1);
        assert.equal(samples[0].valid, false);
        assert.ok(files.has("/proof/production-current-first.stdout"));
      }
    }
  }
});
