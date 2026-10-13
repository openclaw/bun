import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const inputs = path.dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(fs.readFileSync(path.join(inputs, "manifest.json"), "utf8"));
const repo = fs.realpathSync(process.cwd());
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const fileHash = file => hash(fs.readFileSync(file));
function exec(bin, args, cwd = repo, env = process.env) {
  const r = spawnSync(bin, args, { cwd, env, encoding: "utf8", maxBuffer: 64 * 1024 ** 2, timeout: 60_000 });
  if (r.error || r.status !== 0) throw new Error(`${path.basename(bin)} failed: ${r.error?.message ?? r.stderr}`);
  return r.stdout;
}
const diagnosticExitCode = { bun: 1, upstream: 1, native: 2, oracle: 1 };
const measured = [
  "src",
  "ui",
  "extensions",
  "packages",
  "scripts",
  "test",
  "tsconfig*.json",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
];
function verifySource() {
  // The native receiver commits these reviewed transport files into its carrier.
  const transport = new Set(
    [
      "runner.mjs",
      "manifest.json",
      "binary.archive",
      "upstream.archive",
      "oracle.archive",
      "semantic-cases.json",
      "resume-receipt.json",
    ].map(file => `tools/bun-checker-matrix-input/${file}`),
  );
  const tracked = exec("git", ["ls-tree", "-r", "--full-tree", "HEAD"])
    .split("\n")
    .filter(line => !transport.has(line.slice(line.indexOf("\t") + 1)))
    .join("\n");
  if (hash(tracked) !== manifest.sourceInventorySha256)
    throw new Error("Materialized tracked tree differs from frozen source");
  exec("git", ["diff", "--exit-code", "HEAD", "--", ...measured]);
  if (exec("git", ["ls-files", "--others", "--exclude-standard", "--", ...measured]).trim())
    throw new Error("Unexpected untracked compiler input");
  for (const graph of manifest.graphs)
    if (fileHash(path.join(repo, graph.config)) !== graph.configSha256)
      throw new Error(`Changed config: ${graph.name}`);
}
function policyEnvironment(env) {
  const keys = [
    "CI",
    "OPENCLAW_LOCAL_CHECK",
    "OPENCLAW_LOCAL_CHECK_MODE",
    "GOMAXPROCS",
    "GOGC",
    "GOMEMLIMIT",
    "UV_THREADPOOL_SIZE",
  ];
  return Object.fromEntries(keys.filter(key => env[key] !== undefined).map(key => [key, env[key]]));
}
function configuredBunWorkers(hardware, env) {
  // Mirrors Linux bun_core::get_thread_count and its decimal u16 parser.
  for (const key of ["UV_THREADPOOL_SIZE", "GOMAXPROCS"]) {
    const value = env[key]?.replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, "");
    if (!value || !/^\+?[0-9](?:[0-9_]*[0-9])?$/.test(value)) continue;
    const number = Number(value.replaceAll("_", ""));
    if (number >= 2 && number <= 65535) return Math.min(number, 1024);
  }
  return Math.min(Math.max(hardware, 2), 1024);
}
function decodeMountInfoPath(value) {
  return value.replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8)));
}
function resourceContract(read = file => fs.readFileSync(file, "utf8")) {
  const cgroup = read("/proc/self/cgroup");
  const relative = cgroup
    .split("\n")
    .find(line => line.startsWith("0::"))
    ?.slice(3);
  const files = ["cpu.max", "cpuset.cpus.effective", "memory.max", "memory.high", "pids.max"];
  if (!relative?.startsWith("/") || relative.split("/").includes(".."))
    throw new Error("A resolvable cgroup v2 hierarchy is required");
  const mounts = read("/proc/self/mountinfo")
    .split("\n")
    .flatMap(line => {
      const [fields, description] = line.split(" - ");
      if (description?.split(" ")[0] !== "cgroup2") return [];
      const parts = fields.split(" ");
      const root = decodeMountInfoPath(parts[3]);
      const mount = decodeMountInfoPath(parts[4]);
      if (root.split("/").includes("..") || (root !== "/" && relative !== root && !relative.startsWith(`${root}/`)))
        return [];
      return [{ root, mount, relative: root === "/" ? relative : relative.slice(root.length) }];
    });
  if (mounts.length === 0) throw new Error("No visible cgroup v2 mount maps this process");
  const limits = new Map();
  for (const { mount, relative: mapped } of mounts) {
    const parts = mapped.split("/").filter(Boolean);
    for (let depth = parts.length; depth >= 0; depth -= 1) {
      const directory = path.join(mount, ...parts.slice(0, depth));
      limits.set(
        directory,
        Object.fromEntries(
          files.map(name => {
            try {
              return [name, read(path.join(directory, name)).trim()];
            } catch (error) {
              if (error.code !== "ENOENT") throw error;
              return [name, null];
            }
          }),
        ),
      );
    }
  }
  return {
    cgroup,
    affinity: read("/proc/self/status").match(/^Cpus_allowed_list:\s*(.+)$/m)?.[1] ?? null,
    mounts,
    limits: Object.fromEntries([...limits].sort(([a], [b]) => a.localeCompare(b))),
    scope: "all visible leaf-to-mount-root constraints; ancestors outside this namespace are unobserved",
  };
}
function assertCiProfile(cpus, capacity, contract, hardware, workers, native) {
  const cpuCount = value => {
    if (!value || !/^\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*$/.test(value)) throw new Error("Unknown CPU set");
    const ranges = value
      .split(",")
      .map(range => {
        const [start, end = start] = range.split("-").map(Number);
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start)
          throw new Error("Invalid CPU range");
        return [start, end];
      })
      .sort(([a], [b]) => a - b);
    let count = 0,
      last = -1;
    for (const [start, end] of ranges) {
      count += Math.max(0, end - Math.max(start, last + 1) + 1);
      last = Math.max(last, end);
    }
    return count;
  };
  if (
    cpus !== 4 ||
    hardware !== 4 ||
    workers !== 4 ||
    capacity === null ||
    !Number.isFinite(capacity) ||
    capacity <= 0 ||
    capacity >= 24 * 1024 ** 3
  )
    throw new Error("Host is outside the admitted four-CPU constrained CI profile");
  if (cpuCount(contract.affinity) < 4) throw new Error("CPU affinity contradicts the CI profile");
  for (const limits of Object.values(contract.limits)) {
    if (limits["cpuset.cpus.effective"] && cpuCount(limits["cpuset.cpus.effective"]) < 4)
      throw new Error("CPU set contradicts the CI profile");
    if (limits["cpu.max"]) {
      const [quota, period] = limits["cpu.max"].split(/\s+/);
      if (
        !/^\d+$/.test(period) ||
        Number(period) <= 0 ||
        (quota !== "max" && (!/^\d+$/.test(quota) || Number(quota) / Number(period) < 4))
      )
        throw new Error("CPU quota contradicts the CI profile");
    }
  }
  if (
    !native.args.includes("--singleThreaded") ||
    native.args[native.args.indexOf("--checkers") + 1] !== "1" ||
    native.env.GOMAXPROCS !== "2" ||
    native.env.GOGC !== "30" ||
    native.env.GOMEMLIMIT !== "3GiB"
  )
    throw new Error("Native settings differ from the admitted constrained CI policy");
}
function parseDiagnostics(output, cwd) {
  const diagnostics = [],
    unparsed = [];
  for (const line of output.replace(/\x1b\[[0-9;]*m/g, "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    const m = /^(.*)\((\d+),(\d+)\): error TS(\d+): (.*)$/.exec(line);
    const global = /^error TS(\d+): (.*)$/.exec(line);
    if (m)
      diagnostics.push({
        file: m[1].startsWith("bundled:///") ? m[1] : path.relative(repo, path.resolve(cwd, m[1])),
        line: +m[2],
        column: +m[3],
        code: +m[4],
        message: m[5],
      });
    else if (global) diagnostics.push({ file: null, line: null, column: null, code: +global[1], message: global[2] });
    else if (/^\s+/.test(line) && diagnostics.length) diagnostics.at(-1).message += `\n${line}`;
    else unparsed.push(line);
  }
  return { diagnostics, unparsed };
}
function bunSummary(stderr, diagnostics, cwd) {
  const lines = stderr.replace(/\n$/, "").split("\n");
  const header = lines.shift() ?? "";
  const count = "(\\d{1,3}(?:,\\d{3})*|\\d+)";
  const n = x => Number(x.replaceAll(",", ""));
  const success = new RegExp(
    `^✓ No type errors in ${count} files?(?: across ${count} projects?)? \\[[\\d.]+(?:ms|s)\\]$`,
  ).exec(header);
  if (success)
    return {
      valid: diagnostics.length === 0 && lines.length === 0,
      checkedFiles: n(success[1]),
      projects: success[2] ? n(success[2]) : 0,
    };
  const failure = new RegExp(
    `^Found ${count} errors? in ${count} files?, checked ${count} files?(?: across ${count} projects?)? \\[[\\d.]+(?:ms|s)\\]$`,
  ).exec(header);
  if (!failure) return { valid: false, checkedFiles: null, projects: null };
  const files = new Map();
  for (const d of diagnostics) {
    const prior = files.get(d.file);
    files.set(d.file, { count: (prior?.count ?? 0) + 1, firstLine: Math.min(prior?.firstLine ?? d.line, d.line) });
  }
  let valid = n(failure[1]) === diagnostics.length && n(failure[2]) === files.size;
  if (files.size < 2) valid &&= lines.length === 0;
  else {
    valid &&= lines.shift() === "" && lines.length === files.size;
    for (const line of lines) {
      const m = /^\s+(\d+)  (.*):(\d+)$/.exec(line);
      if (!m) {
        valid = false;
        continue;
      }
      const file = path.relative(repo, path.resolve(cwd, m[2]));
      const expected = files.get(file);
      if (!expected || expected.count !== +m[1] || expected.firstLine !== +m[3]) valid = false;
      files.delete(file);
    }
    valid &&= files.size === 0;
  }
  return { valid, checkedFiles: n(failure[3]), projects: failure[4] ? n(failure[4]) : 0 };
}
function inventory(stdout, nativeLibRoots, cwd) {
  const application = [],
    libraries = [],
    invalid = [];
  for (const line of stdout.split(/\r?\n/).filter(Boolean)) {
    if (
      line.startsWith("bundled:///libs/") ||
      (nativeLibRoots.some(root => line.startsWith(root + path.sep)) && /\/lib\.[^/]+\.d\.ts$/.test(line))
    )
      libraries.push(line);
    else if (path.isAbsolute(line) && fs.existsSync(line))
      application.push(path.relative(repo, path.resolve(cwd, line)));
    else invalid.push(line);
  }
  application.sort();
  return { application, libraries, invalid, applicationSha256: hash(JSON.stringify(application)) };
}
async function main() {
  if (process.argv.length > 2) throw new Error("Runner options must be bound in the reviewed manifest");
  if (process.platform !== "linux" || process.arch !== "x64") throw new Error("Requires Linux x64");
  if (fileHash(fileURLToPath(import.meta.url)) !== manifest.runnerSha256) throw new Error("Runner hash mismatch");
  verifySource();
  const outputRoot = path.resolve(process.env.BUN_MATRIX_OUTPUT_ROOT ?? "/");
  if (!outputRoot.startsWith("/work/crabbox/")) throw new Error("Output must use the task-owned disk-backed work root");
  fs.mkdirSync(outputRoot, { recursive: true });
  if (!fs.realpathSync(outputRoot).startsWith("/work/crabbox/"))
    throw new Error("Output root escapes the task work root");
  if (exec("stat", ["-f", "-c", "%T", outputRoot]).trim() === "tmpfs") throw new Error("Output root is tmpfs");
  const output = fs.mkdtempSync(path.join(outputRoot, "bun-matrix-"));
  fs.writeFileSync(path.join(output, "executions.jsonl"), "", { flag: "wx" });
  const neutral = path.join(output, "neutral");
  fs.mkdirSync(neutral);
  const archive = path.join(inputs, "binary.archive");
  if (fileHash(archive) !== manifest.bun.archiveSha256) throw new Error("Bun archive hash mismatch");
  if (exec("tar", ["-tzf", archive]).trim() !== "bun" || !exec("tar", ["-tvzf", archive]).startsWith("-"))
    throw new Error("Unsafe archive entries");
  exec("tar", ["-xzf", archive, "-C", output]);
  const bun = path.join(output, "bun");
  if (fileHash(bun) !== manifest.bun.binarySha256) throw new Error("Bun binary hash mismatch");
  const version = exec(bun, ["--version"], neutral).trim();
  const revision = exec(bun, ["--revision"], neutral).trim();
  const embedded = exec(bun, ["-p", "process.versions.typescript"], neutral).trim();
  if (version !== manifest.bun.version || revision !== manifest.bun.revision || embedded !== manifest.bun.typescript)
    throw new Error("Unexpected Bun version/revision/oracle");
  const upstreamArchive = path.join(inputs, "upstream.archive");
  if (fileHash(upstreamArchive) !== manifest.upstream.archiveSha256) throw new Error("Official Bun archive differs");
  if (
    exec("python3", [
      "-c",
      "import sys,zipfile;print('\\n'.join(zipfile.ZipFile(sys.argv[1]).namelist()))",
      upstreamArchive,
    ]).trim() !== "bun-linux-x64/\nbun-linux-x64/bun"
  )
    throw new Error("Unsafe official Bun archive paths");
  const upstream = path.join(output, "upstream-bun"),
    fd = fs.openSync(upstream, "wx", 0o700);
  try {
    const extraction = spawnSync(
      "python3",
      [
        "-c",
        "import shutil,sys,zipfile;shutil.copyfileobj(zipfile.ZipFile(sys.argv[1]).open('bun-linux-x64/bun'),sys.stdout.buffer)",
        upstreamArchive,
      ],
      { stdio: ["ignore", fd, "pipe"] },
    );
    if (extraction.error || extraction.status !== 0) throw new Error("Official Bun extraction failed");
  } finally {
    fs.closeSync(fd);
  }
  if (fileHash(upstream) !== manifest.upstream.binarySha256) throw new Error("Official Bun binary differs");
  const upstreamRevision = exec(upstream, ["--revision"], neutral).trim(),
    upstreamTypeScript = exec(upstream, ["-p", "process.versions.typescript"], neutral).trim();
  if (!upstreamRevision.endsWith("+" + manifest.upstream.source.slice(0, 9)) || upstreamTypeScript !== "7.0.2")
    throw new Error("Official Bun revision/oracle differs");
  const oracleArchive = path.join(inputs, "oracle.archive");
  if (fileHash(oracleArchive) !== manifest.oracle.archiveSha256) throw new Error("Fixture oracle archive differs");
  const oracleDir = path.join(output, "oracle");
  fs.mkdirSync(oracleDir);
  exec("python3", [
    "-c",
    "import tarfile,pathlib,sys;t=tarfile.open(sys.argv[1]);ms=t.getmembers();assert all((m.isfile() or m.isdir()) and pathlib.PurePosixPath(m.name).parts[0]=='package' and '..' not in pathlib.PurePosixPath(m.name).parts for m in ms);t.extractall(sys.argv[2],members=ms,filter='data')",
    oracleArchive,
    oracleDir,
  ]);
  const oracle = path.join(oracleDir, "package/lib/tsc");
  if (
    fileHash(oracle) !== manifest.oracle.binarySha256 ||
    exec(oracle, ["--version"], neutral).trim() !== "Version 7.0.2"
  )
    throw new Error("Fixture oracle binary/version differs");
  const { resolveRepoToolBinPath, resolveLocalCheckEnv, applyLocalTsgoPolicy } = await import(
    pathToFileURL(path.join(repo, "scripts/lib/local-check-runtime.mts"))
  );
  const native = resolveRepoToolBinPath("tsgo", { cwd: repo });
  const { readProcessMemoryCapacity } = await import(pathToFileURL(path.join(repo, "scripts/lib/process-memory.mts")));
  const ciEnv = { ...process.env, NODE_OPTIONS: "", CI: "true", OPENCLAW_LOCAL_CHECK: "0" };
  const nativeEnv = resolveLocalCheckEnv(ciEnv);
  const hostResources = { logicalCpuCount: os.availableParallelism(), totalMemoryBytes: os.totalmem() };
  const hardwareConcurrency = Number(exec(bun, ["-p", "navigator.hardwareConcurrency"], neutral, ciEnv));
  if (!Number.isSafeInteger(hardwareConcurrency) || hardwareConcurrency < 1)
    throw new Error("Invalid Bun hardware concurrency observation");
  const nativePolicy = applyLocalTsgoPolicy(["--project", "<config>"], nativeEnv, hostResources);
  const resources = resourceContract(),
    memory = readProcessMemoryCapacity({});
  const workers = configuredBunWorkers(hardwareConcurrency, ciEnv);
  const policy = {
    inherited: policyEnvironment(process.env),
    native: { args: nativePolicy.args, env: policyEnvironment(nativePolicy.env) },
    bun: {
      args: [],
      env: policyEnvironment(ciEnv),
      hardwareConcurrency,
      configuredLimit: workers,
      evidence: "source-derived configured limit; active workers not measured",
    },
    upstream: { args: ["--threads", "1"], role: "historical official95a comparison" },
  };
  const nativeLibRoots = [
    path.dirname(native),
    path.join(path.dirname(createRequire(path.join(repo, "package.json")).resolve("typescript/package.json")), "lib"),
  ];
  const nativeVersion = exec(native, ["--version"], neutral).trim();
  if (!nativeVersion.includes(manifest.native.version)) throw new Error("Native compiler pin mismatch");
  const nativeBinaryHash = fileHash(native);
  if (nativeBinaryHash !== manifest.native.binarySha256)
    throw new Error("Native compiler binary differs from frozen pin");
  const { ensureKyselyTypes } = await import(pathToFileURL(path.join(repo, "scripts/generate-kysely-types.mts")));
  const { withDistArtifactOwnership } = await import(
    pathToFileURL(path.join(repo, "scripts/lib/dist-artifact-ownership.mts"))
  );
  const { runManagedCommand, hasUnjoinedWork } = await import(
    pathToFileURL(path.join(repo, "scripts/lib/managed-child-process.mts"))
  );
  const { TSGO_CI_GRAPHS, expandTsgoExecutionGraphs } = await import(
    pathToFileURL(path.join(repo, "scripts/lib/tsgo-core-test-shards.mts"))
  );
  const graphs = expandTsgoExecutionGraphs(TSGO_CI_GRAPHS);
  if (
    JSON.stringify(graphs) !==
    JSON.stringify(manifest.graphs.filter(g => !g.build).map(({ name, config }) => ({ name, config })))
  )
    throw new Error("Canonical graph registry mismatch");
  let resume = null,
    resumeRows = [];
  // Explicit null starts a new dataset without inventing a prior control receipt.
  // Same-source resumes retain every existing identity and coverage check.
  if (manifest.resumeReceipt !== null) {
    const resumePath = path.join(inputs, "resume-receipt.json");
    if (fileHash(resumePath) !== manifest.resumeReceipt.sha256) throw new Error("Resume receipt hash differs");
    resume = JSON.parse(fs.readFileSync(resumePath, "utf8"));
    if (
      resume.identity.source !== manifest.source ||
      resume.identity.sourceInventorySha256 !== manifest.sourceInventorySha256 ||
      resume.identity.manifest.lockfileSha256 !== manifest.lockfileSha256 ||
      JSON.stringify(resume.identity.manifest.graphs) !== JSON.stringify(manifest.graphs) ||
      resume.identity.bun.binarySha256 !== manifest.resumeReceipt.binarySha256 ||
      resume.identity.native.binarySha256 !== manifest.native.binarySha256 ||
      resume.identity.manifest.runnerSha256 !== manifest.resumeReceipt.runnerSha256 ||
      resume.identity.materializedHead !== manifest.resumeReceipt.materializedHead
    )
      throw new Error("Resume source or compiler identity differs");
    if (
      JSON.stringify(resume.controls) !==
        JSON.stringify(["bun", "native", "upstream", "oracle"].map(candidate => ({ candidate, passed: true }))) ||
      JSON.stringify(resume.rows.map(row => row.name)) !== JSON.stringify(manifest.resumeReceipt.rows) ||
      JSON.stringify(manifest.resumeReceipt.rows) !==
        JSON.stringify(manifest.graphs.slice(0, resume.rows.length).map(graph => graph.name))
    )
      throw new Error("Resume coverage or controls differ");
    if (
      resume.rows.some(
        (row, index) =>
          row.config !== manifest.graphs[index].config ||
          !/^[a-f0-9]{64}$/.test(row.bunFileHash) ||
          !/^[a-f0-9]{64}$/.test(row.nativeFileHash) ||
          row.bunApplicationCount <= 0 ||
          row.nativeApplicationCount <= 0,
      )
    )
      throw new Error("Resume contains an incomplete prior row");
    // A different compiler or dataset cannot reuse prior checks.
    resumeRows =
      resume.identity.bun.binarySha256 === manifest.bun.binarySha256 &&
      resume.identity.manifest.receiptSchema === manifest.receiptSchema &&
      (resume.sourceCheckpoint?.verified === true || resume.sourceVerified === true)
        ? resume.rows
        : [];
  }
  const baseline = manifest.native.hostedBaseline;
  if (
    baseline.source !== manifest.source ||
    baseline.version !== manifest.native.version ||
    baseline.binding !== "version-only" ||
    !Number.isSafeInteger(baseline.run)
  )
    throw new Error("Native hosted baseline identity differs");
  if (
    JSON.stringify(baseline.rows.map(({ config, configSha256 }) => ({ config, configSha256 }))) !==
      JSON.stringify(
        manifest.graphs.filter(graph => !graph.build).map(({ config, configSha256 }) => ({ config, configSha256 })),
      ) ||
    baseline.rows.some(row => !Number.isSafeInteger(row.job))
  )
    throw new Error("Native hosted baseline coverage differs");
  const nativeBaselines = new Map(baseline.rows.map(row => [row.config, row]));
  const began = Date.now(),
    leaseDeadline = Number(process.env.BUN_MATRIX_DEADLINE_MS);
  if (!Number.isSafeInteger(leaseDeadline) || leaseDeadline <= began)
    throw new Error("Missing authoritative lease work deadline");
  if (!Number.isInteger(manifest.maxNewRows) || manifest.maxNewRows < 1 || manifest.maxNewRows > manifest.graphs.length)
    throw new Error("Invalid batch row limit");
  const deadline = Math.min(began + manifest.budgetSeconds * 1000, leaseDeadline);
  const rows = [],
    executions = [],
    controls = [],
    probes = [],
    comparisons = [],
    nativeInventories = new Map();
  if (resumeRows.length > 0 && resume.identity.upstream.binarySha256 === manifest.upstream.binarySha256)
    comparisons.push(...(resume.comparisons ?? []));
  const executables = { bun, native, upstream, oracle };
  const identity = {
    kind: "constrained CI compatibility qualification, not default adoption",
    source: manifest.source,
    materializedHead: exec("git", ["rev-parse", "HEAD"]).trim(),
    sourceInventorySha256: manifest.sourceInventorySha256,
    manifest,
    native: { version: nativeVersion, binarySha256: nativeBinaryHash, bin: native },
    bun: { version, revision, embedded, binarySha256: fileHash(bun), bin: bun },
    upstream: { revision: upstreamRevision, embedded: upstreamTypeScript, binarySha256: fileHash(upstream) },
    oracle: { version: "7.0.2", binarySha256: fileHash(oracle) },
    host: {
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      cpus: os.availableParallelism(),
      totalMemory: os.totalmem(),
      policy,
      resourceContract: resources,
      memoryCapacity: memory,
    },
    output,
  };
  if (resume)
    identity.priorReceipt = {
      sha256: manifest.resumeReceipt.sha256,
      materializedHead: resume.identity.materializedHead,
      runnerSha256: resume.identity.manifest.runnerSha256,
      lease: manifest.resumeReceipt.lease,
      binarySha256: resume.identity.bun.binarySha256,
      reusedChecks: resumeRows.length,
    };
  identity.leaseWorkDeadlineAt = new Date(deadline).toISOString();
  fs.writeFileSync(path.join(output, "identity.json"), JSON.stringify(identity, null, 2));
  function writeReceipt(receipt) {
    const target = path.join(output, "receipt.json"),
      temporary = target + ".tmp";
    fs.writeFileSync(temporary, JSON.stringify(receipt, null, 2));
    fs.renameSync(temporary, target);
  }
  function checkpoint() {
    let error = null;
    try {
      verifySource();
    } catch (caught) {
      error = caught.stack ?? String(caught);
    }
    const sourceCheckpoint = { verifiedAt: new Date().toISOString(), verified: error === null, error };
    // A checkpoint proves source only at this instant. Final verification still
    // belongs to the completed run; retain all evidence needed after transport loss.
    writeReceipt({
      identity,
      admission,
      controls,
      rows,
      probes,
      comparisons,
      completed: false,
      sourceVerified: false,
      sourceCheckpoint,
    });
    if (error !== null) throw new Error(error);
  }
  async function run(candidate, graph, phase) {
    if (Date.now() >= deadline) throw new Error("Matrix budget exhausted; no more compiler starts");
    const config = path.resolve(repo, graph.config);
    const isBun = candidate === "bun" || candidate === "upstream";
    const rawArgs = isBun
      ? [
          "check",
          ...(candidate === "upstream" ? ["--threads", "1"] : []),
          "--no-pretty",
          ...(graph.all ? ["--all"] : []),
          "--noEmit",
          "--declaration",
          "false",
          ...(graph.build ? ["-b", config] : ["--project", config]),
        ]
      : [
          ...(graph.build ? ["-b", config] : []),
          "--pretty",
          "false",
          "--noEmit",
          "--declaration",
          "false",
          ...(!graph.build ? ["--project", config, "--incremental", "false"] : []),
        ];
    if (phase === "inventory") rawArgs.push("--listFilesOnly");
    const resolved = isBun ? { args: rawArgs, env: ciEnv } : applyLocalTsgoPolicy(rawArgs, nativeEnv, hostResources);
    const { args, env } = resolved;
    const resourcesBefore = resourceContract();
    if (JSON.stringify(resourcesBefore) !== JSON.stringify(resources))
      throw new Error("Host resource constraints changed before compiler start");
    const bin = executables[candidate];
    const buffers = [[], []];
    let bytes = 0,
      overflow = false,
      error = null,
      interrupted = false,
      code = null,
      fatal = null;
    const started = Date.now();
    try {
      code = await runManagedCommand({
        bin,
        args,
        cwd: neutral,
        env,
        stdio: ["ignore", "pipe", "pipe"],
        requireProcessTreeExit: true,
        timeoutMs: Math.min(
          (candidate === "native" && graph.build && phase === "check"
            ? manifest.nativeReferenceTimeoutSeconds
            : manifest.rowTimeoutSeconds) * 1000,
          deadline - started,
        ),
        onSignal() {
          interrupted = true;
        },
        onReady(child) {
          for (const [i, stream] of [child.stdout, child.stderr].entries())
            stream?.on("data", chunk => {
              bytes += chunk.length;
              if (bytes <= 64 * 1024 ** 2) buffers[i].push(chunk);
              else overflow = true;
            });
        },
      });
    } catch (caught) {
      error = caught.message;
      if (hasUnjoinedWork(caught)) fatal = caught;
    }
    let resourcesAfter = null,
      resourceError = null;
    try {
      resourcesAfter = resourceContract();
    } catch (caught) {
      resourceError = caught.message;
    }
    const resourceContractStable =
      resourceError === null && JSON.stringify(resourcesAfter) === JSON.stringify(resources);
    const stdout = Buffer.concat(buffers[0]).toString("utf8"),
      stderr = Buffer.concat(buffers[1]).toString("utf8");
    const parsed = phase === "inventory" ? { diagnostics: [], unparsed: [] } : parseDiagnostics(stdout, neutral);
    const summary = isBun ? bunSummary(stderr, parsed.diagnostics, neutral) : null;
    const listed = phase === "inventory" ? inventory(stdout, nativeLibRoots, neutral) : null;
    // listFilesOnly follows tsc's early exit; inventory acceptance is independent of checker acceptance.
    const validOutput =
      resourceContractStable &&
      !overflow &&
      !error &&
      !interrupted &&
      (phase === "inventory"
        ? code === 0 &&
          listed.invalid.length === 0 &&
          listed.application.length > 0 &&
          (!isBun ? stderr === "" : summary.valid)
        : parsed.unparsed.length === 0 &&
          (!isBun
            ? stderr === "" &&
              ((code === 0 && parsed.diagnostics.length === 0) ||
                (code === diagnosticExitCode[candidate] && parsed.diagnostics.length > 0))
            : summary.valid &&
              ((code === 0 && parsed.diagnostics.length === 0) || (code === 1 && parsed.diagnostics.length > 0))));
    const name = `${executions.length.toString().padStart(3, "0")}-${graph.name}-${candidate}-${phase}`;
    fs.writeFileSync(path.join(output, name + ".stdout"), stdout);
    fs.writeFileSync(path.join(output, name + ".stderr"), stderr);
    const result = {
      graph: graph.name,
      config: graph.config,
      configSha256: graph.configSha256 ?? fileHash(config),
      candidate,
      phase,
      args,
      env: policyEnvironment(env),
      resourceContractStable,
      resourcesBefore,
      resourcesAfter,
      resourceError,
      cwd: neutral,
      executableSha256: fileHash(bin),
      code,
      validOutput,
      error: overflow ? "output-overflow" : (error ?? resourceError),
      diagnostics: parsed.diagnostics,
      unparsed: parsed.unparsed,
      summary,
      inventory: listed,
      elapsedMs: Date.now() - started,
      stdoutFile: name + ".stdout",
      stderrFile: name + ".stderr",
    };
    executions.push(result);
    fs.appendFileSync(path.join(output, "executions.jsonl"), JSON.stringify(result) + "\n");
    if (fatal) throw fatal;
    if (!resourceContractStable)
      throw new Error(resourceError ?? "Host resource constraints changed; no further compiler starts");
    if (interrupted) throw new Error("Interrupted; compiler joined; no further rows start");
    return result;
  }
  async function nativeInventory(graph) {
    if (!graph.build) {
      const result = await run("native", graph, "inventory");
      nativeInventories.set(graph.config, result);
      return result;
    }
    // Native build mode cannot list files. Preserve both referenced leaves as
    // a sorted multiset, including repeated files that Bun reports per project.
    const references = JSON.parse(fs.readFileSync(path.join(repo, graph.config), "utf8")).references.map(ref =>
      path.normalize(path.join(path.dirname(graph.config), ref.path)),
    );
    if (JSON.stringify(references) !== JSON.stringify(manifest.buildReferences.map(ref => ref.config)))
      throw new Error("Project reference inputs differ");
    const leaves = references.map(config => nativeInventories.get(config));
    if (leaves.some(leaf => !leaf)) throw new Error("Missing native reference inventory");
    const application = leaves.flatMap(leaf => leaf.inventory.application).sort();
    return {
      validOutput: leaves.every(leaf => leaf.validOutput),
      inventory: {
        application,
        libraries: leaves.flatMap(leaf => leaf.inventory.libraries),
        applicationSha256: hash(JSON.stringify(application)),
      },
    };
  }
  let completed = false,
    batchComplete = false,
    failure = null,
    admission = { status: "pending" };
  try {
    assertCiProfile(
      hostResources.logicalCpuCount,
      memory.capacityBytes,
      resources,
      hardwareConcurrency,
      workers,
      nativePolicy,
    );
    admission = { status: "accepted" };
    await withDistArtifactOwnership(repo, async () => {
      await ensureKyselyTypes(repo);
      verifySource();
      const controlConfig = path.join(output, "control.json"),
        controlSource = path.join(output, "control.ts");
      fs.writeFileSync(
        controlConfig,
        JSON.stringify({
          compilerOptions: { strict: true, noEmit: true, target: "es2023", types: [] },
          files: [controlSource],
        }),
      );
      const controlGraph = { name: "negative-control", config: controlConfig };
      fs.writeFileSync(controlSource, 'const checkerControl: number = "intentional negative";\n');
      for (const candidate of ["bun", "native", "upstream", "oracle"]) {
        const r = await run(candidate, controlGraph, "check");
        const d = r.diagnostics[0];
        controls.push({
          candidate,
          passed:
            r.validOutput &&
            r.code === diagnosticExitCode[candidate] &&
            r.diagnostics.length === 1 &&
            d.file === path.relative(repo, controlSource) &&
            d.line === 1 &&
            d.column === 7 &&
            d.code === 2322 &&
            d.message === "Type 'string' is not assignable to type 'number'.",
        });
      }
      if (controls.some(x => !x.passed)) throw new Error("Negative control failed");
      checkpoint();
      console.log("[bun-matrix:controls] " + JSON.stringify({ controls }));
      const casesPath = path.join(inputs, "semantic-cases.json");
      if (fileHash(casesPath) !== manifest.semanticProbes.sha256) throw new Error("Semantic fixture digest differs");
      const cases = JSON.parse(fs.readFileSync(casesPath, "utf8"));
      if (JSON.stringify(Object.keys(cases)) !== JSON.stringify(manifest.semanticProbes.cases))
        throw new Error("Unexpected semantic cases");
      for (const [name, value] of Object.entries(cases)) {
        const dir = path.join(output, name);
        fs.mkdirSync(dir);
        for (const [file, source] of Object.entries(value.files)) {
          if (path.isAbsolute(file) || file.split("/").includes("..") || typeof source !== "string")
            throw new Error("Unsafe semantic fixture path");
          fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
          fs.writeFileSync(path.join(dir, file), source);
        }
        const graph = { name, config: path.join(dir, "tsconfig.json"), all: true };
        const checked = await run("bun", graph, "check"),
          baseline = await run("oracle", graph, "check"),
          official = await run("upstream", graph, "check");
        const signature = result =>
          result.diagnostics
            .map(({ file, line, column, code }) => ({ file, line, column, code }))
            .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
        const probe = {
          name,
          oracle: "TypeScript 7.0.2",
          bunCode: checked.code,
          nativeCode: baseline.code,
          upstreamCode: official.code,
          bunValidOutput: checked.validOutput,
          nativeValidOutput: baseline.validOutput,
          upstreamValidOutput: official.validOutput,
          bunDiagnostics: checked.diagnostics,
          nativeDiagnostics: baseline.diagnostics,
          upstreamDiagnostics: official.diagnostics,
          diagnosticLocationsMatch: JSON.stringify(signature(checked)) === JSON.stringify(signature(baseline)),
          upstreamDiagnosticLocationsMatch: JSON.stringify(signature(official)) === JSON.stringify(signature(baseline)),
        };
        probe.rawOutputs = Object.fromEntries(
          [
            ["bun", checked],
            ["native", baseline],
            ["upstream", official],
          ].map(([candidate, result]) => [
            candidate,
            {
              args: result.args,
              executableSha256: result.executableSha256,
              stdout: fs.readFileSync(path.join(output, result.stdoutFile), "utf8"),
              stderr: fs.readFileSync(path.join(output, result.stderrFile), "utf8"),
            },
          ]),
        );
        probes.push(probe);
        checkpoint();
        console.log(
          "[bun-matrix:probe] " +
            JSON.stringify({
              ...probe,
              rawOutputs: undefined,
              bunDiagnostics: { count: probe.bunDiagnostics.length, first: probe.bunDiagnostics.slice(0, 3) },
              nativeDiagnostics: { count: probe.nativeDiagnostics.length, first: probe.nativeDiagnostics.slice(0, 3) },
              upstreamDiagnostics: {
                count: probe.upstreamDiagnostics.length,
                first: probe.upstreamDiagnostics.slice(0, 3),
              },
            }),
        );
      }
      for (const prior of resumeRows) {
        const graph = manifest.graphs.find(graph => graph.name === prior.name);
        const bunFiles = await run("bun", graph, "inventory"),
          nativeFiles = await nativeInventory(graph);
        if (
          !bunFiles.validOutput ||
          !nativeFiles.validOutput ||
          bunFiles.inventory.applicationSha256 !== prior.bunFileHash ||
          nativeFiles.inventory.applicationSha256 !== prior.nativeFileHash ||
          bunFiles.inventory.application.length !== prior.bunApplicationCount ||
          nativeFiles.inventory.application.length !== prior.nativeApplicationCount
        )
          throw new Error(`Resume inventory differs: ${prior.name}`);
        rows.push({
          ...prior,
          bunApplicationFiles: bunFiles.inventory.application,
          nativeApplicationFiles: nativeFiles.inventory.application,
          checkOrigin: prior.checkOrigin ?? identity.priorReceipt,
          inventoryOrigin: "same-source resumed inventory",
        });
        checkpoint();
        console.log(
          "[bun-matrix:recovered] " +
            JSON.stringify({
              name: prior.name,
              applicationCount: prior.bunApplicationCount,
              applicationSha256: prior.bunFileHash,
            }),
        );
      }
      for (const graph of manifest.graphs
        .filter(graph => !resumeRows.some(row => row.name === graph.name))
        .slice(0, manifest.maxNewRows)) {
        const checked = await run("bun", graph, "check");
        const bunFiles = await run("bun", graph, "inventory");
        const nativeFiles = await nativeInventory(graph);
        const inventoryMatches =
          bunFiles.validOutput &&
          nativeFiles.validOutput &&
          bunFiles.inventory.application.length > 0 &&
          nativeFiles.inventory.application.length > 0 &&
          bunFiles.inventory.applicationSha256 === nativeFiles.inventory.applicationSha256 &&
          JSON.stringify(bunFiles.inventory.application) === JSON.stringify(nativeFiles.inventory.application);
        const nativeChecked =
          checked.code === 0 &&
          checked.validOutput &&
          inventoryMatches &&
          !graph.build &&
          nativeBaselines.has(graph.config)
            ? null
            : await run("native", graph, "check");
        const row = {
          name: graph.name,
          build: graph.build ?? false,
          config: graph.config,
          bunCode: checked.code,
          bunValidOutput: checked.validOutput,
          bunDiagnostics: checked.diagnostics,
          bunCheckedFiles: checked.summary?.checkedFiles,
          bunProjects: checked.summary?.projects,
          inventoryMatches,
          nativeInventoryMethod: graph.build ? "referenced-leaf sorted multiset" : "listFilesOnly",
          nativeInventoryReferences: graph.build ? manifest.buildReferences : undefined,
          bunApplicationCount: bunFiles.inventory?.application.length,
          nativeApplicationCount: nativeFiles.inventory?.application.length,
          bunFileHash: bunFiles.inventory?.applicationSha256,
          nativeFileHash: nativeFiles.inventory?.applicationSha256,
          nativeCode: nativeChecked?.code ?? null,
          nativeValidOutput: nativeChecked?.validOutput ?? null,
          nativeDiagnostics: nativeChecked?.diagnostics ?? [],
          baseline: nativeChecked ? "same-source remote native" : "exact-source hosted CI (version-bound)",
          baselineEvidence: nativeChecked
            ? undefined
            : {
                ...nativeBaselines.get(graph.config),
                source: baseline.source,
                version: baseline.version,
                run: baseline.run,
                binding: baseline.binding,
              },
          clean:
            checked.code === 0 &&
            checked.validOutput &&
            checked.summary?.checkedFiles > 0 &&
            inventoryMatches &&
            (!nativeChecked || (nativeChecked.code === 0 && nativeChecked.validOutput)),
        };
        row.bunApplicationFiles = bunFiles.inventory.application;
        row.nativeApplicationFiles = nativeFiles.inventory.application;
        rows.push(row);
        checkpoint();
        console.log(
          "[bun-matrix:row] " +
            JSON.stringify({
              ...row,
              bunApplicationFiles: undefined,
              nativeApplicationFiles: undefined,
              bunDiagnostics: { count: row.bunDiagnostics.length, first: row.bunDiagnostics.slice(0, 3) },
              nativeDiagnostics: { count: row.nativeDiagnostics.length, first: row.nativeDiagnostics.slice(0, 3) },
            }),
        );
      }
      for (const row of rows.filter(
        row =>
          (!row.clean || row.name === "core" || row.name === "ui" || row.build) &&
          !comparisons.some(comparison => comparison.name === row.name),
      )) {
        const graph = manifest.graphs.find(graph => graph.name === row.name);
        const checked = await run("upstream", graph, "check"),
          files = await run("upstream", graph, "inventory");
        const comparison = {
          name: row.name,
          code: checked.code,
          validOutput: checked.validOutput,
          diagnostics: checked.diagnostics,
          checkedFiles: checked.summary?.checkedFiles,
          applicationCount: files.inventory.application.length,
          applicationSha256: files.inventory.applicationSha256,
          inventoryMatches: files.validOutput && files.inventory.applicationSha256 === row.nativeFileHash,
        };
        comparisons.push(comparison);
        checkpoint();
        console.log(
          "[bun-matrix:upstream] " +
            JSON.stringify({
              ...comparison,
              diagnostics: { count: comparison.diagnostics.length, first: comparison.diagnostics.slice(0, 3) },
            }),
        );
      }
      verifySource();
      batchComplete = true;
      completed = rows.length === manifest.graphs.length;
    });
  } catch (caught) {
    completed = false;
    batchComplete = false;
    failure = caught.stack ?? String(caught);
    if (admission.status === "pending")
      admission = { status: "rejected", reason: "resource-profile", error: caught.message ?? String(caught) };
  }
  let sourceVerified = false,
    sourceVerificationError = null;
  try {
    verifySource();
    sourceVerified = true;
  } catch (caught) {
    sourceVerificationError = caught.stack ?? String(caught);
  }
  completed &&= sourceVerified;
  batchComplete &&= sourceVerified;
  const receipt = {
    identity,
    admission,
    controls,
    rows,
    probes,
    comparisons,
    completed,
    batchComplete,
    failure,
    sourceVerified,
    sourceVerificationError,
    canonicalRows: rows.filter(r => !r.build).length,
    projectReferenceRows: rows.filter(r => r.build).length,
    clean: rows.filter(r => r.clean).length,
    failures: rows.filter(r => !r.clean).length,
    elapsedMs: Date.now() - began,
  };
  writeReceipt(receipt);
  console.log(
    "[bun-matrix:done] " +
      JSON.stringify({
        source: manifest.source,
        output,
        completed,
        canonicalRows: receipt.canonicalRows,
        projectReferenceRows: receipt.projectReferenceRows,
        clean: receipt.clean,
        failures: receipt.failures,
        failure,
      }),
  );
  if (
    !completed ||
    receipt.failures > 0 ||
    probes.some(probe => !probe.bunValidOutput || !probe.nativeValidOutput || !probe.diagnosticLocationsMatch)
  )
    process.exitCode = 1;
}
main().catch(error => {
  console.error("[bun-matrix] " + (error.stack ?? error));
  process.exitCode = 1;
});
