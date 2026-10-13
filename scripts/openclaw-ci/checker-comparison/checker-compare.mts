// Advisory, isolated comparison. This does not select the repository's checker.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { isDeepStrictEqual } from "node:util";
import { decodeMountInfoPath } from "../packages/normalization-core/src/mountinfo-path.ts";
import { ensureKyselyTypes } from "../scripts/generate-kysely-types.mts";
import { withDistArtifactOwnership } from "../scripts/lib/dist-artifact-ownership.mts";
import { applyLocalTsgoPolicy, resolveLocalCheckEnv } from "../scripts/lib/local-check-runtime.mts";
import { hasUnjoinedWork, runManagedCommand } from "../scripts/lib/managed-child-process.mts";
import { readProcessMemoryCapacity } from "../scripts/lib/process-memory.mts";
import { expandTsgoExecutionGraphs, TSGO_CI_GRAPHS } from "../scripts/lib/tsgo-core-test-shards.mts";
import { createTsgoResourceSampler } from "../scripts/lib/tsgo-performance.mts";

const SOURCE = "06af34cba25d549736807a334ca8028a1f6e9662";
const SOURCE_INVENTORY_SHA256 = "e5f1924bdb1aa5e32f17e4e9f257935892d6b7c3c197f70b3af84db82b5da8fa";
const DISCOVERY_INVENTORY_SHA256 = "c669073dc6baef7717181aaf2eb9c15a1c4f94c4322230679d78114f2a9ec8fc";
const LOCKFILE_SHA256 = "8264a0415a502b477c0f4be03de7f3a2021de6d4a9bd2a79aad33fa2cd788c9d";
const WORKSPACE_SHA256 = "fc3c1f3d669b9d9680fd9a5729012c59512457ae1948005a48bda30af79db8b9";
const NODE_BINARY_SHA256 = "b2959781cc5a74c357ffa02367efa8a0330cbb1c9cb347732fdfaaaca381cbcd";
const DRIVER_PATH = "tools/checker-compare.mts";
// Exact 06af hosted matrix transports for the final upstream candidate. A completed matching matrix
// receipt is still mandatory; different batches require new reviewed bindings.
const MATRIX_TRANSPORT_BLOBS = {
  "tools/bun-checker-matrix-input/runner.mjs": "91a8c8a6c7b11c0c2571159c4539d1fd37859c33",
  "tools/bun-checker-matrix-input/manifest.json": "6e7f22532b9c85d3a118a96ee4fe7ab136158924",
  "tools/bun-checker-matrix-input/binary.archive": "",
  "tools/bun-checker-matrix-input/upstream.archive": "f164058004a813f329fe73afbd6a0a98bbe5c479",
  "tools/bun-checker-matrix-input/oracle.archive": "52ce00e26b2eeb223f32621b1bfb0302ce959dcb",
  "tools/bun-checker-matrix-input/semantic-cases.json": "d252c21f7ec0c1bc71d9245776d0603184a74576",
  "tools/bun-checker-matrix-input/resume-receipt.json": "6a8e69d3c4b62c44dade149e006671fa8ad936fc",
} as const;
const NATIVE_PACKAGES = [
  {
    name: "current",
    version: "7.1.0-dev.20260922.1",
    packageName: "@typescript/typescript-linux-x64",
    executable: "lib/tsc",
    integrity: "E4/JVTP1bJFk99cdsIG+AjLAuQEPpRDlwyhUExb6n6tqCPBeI4QlQa9bHZwv3xAMwRpYx5yHyYde2G5Isou7Dg==",
  },
  {
    name: "next",
    version: "7.1.0-dev.20261012.1",
    packageName: "@typescript/typescript-linux-x64",
    executable: "lib/tsc",
    integrity: "w4fm+dzdwiEUAPkTteEaZc9dNOvSVRU/598CacHclgiOHpMo4k+ak3Qkkgs0WTy3L7vXflGteEIvGRFs3SMd5g==",
  },
] as const;
type Candidate = {
  name: string;
  version: string;
  bin: string;
  sha256: string;
  observedVersion: string;
  source?: string;
  revision?: string;
  artifactSha256?: string;
};
type Graph = { name: string; config: string };
type Diagnostic = { file: string; line: number; column: number; code: number; message: string };
type Result = {
  graph: string;
  candidate: string;
  state: string;
  repetition: number;
  exitCode: number | null;
  error: string | null;
  validOutput: boolean;
  diagnostics: Diagnostic[];
  inventory?: { application: string[]; libraries: string[] };
  wallMs: number;
  resources: ReturnType<ReturnType<typeof createTsgoResourceSampler>["result"]>;
  stdoutFile: string;
  stderrFile: string;
  configSha256: string;
  args: string[];
  cwd: string;
  buildInfoBefore: string | null;
  buildInfoAfter: string | null;
  cacheMode: string;
  checkedFiles: number | null;
  resourceContractStable: boolean;
  policyEnvironment: Record<string, string | undefined>;
};
const sha256 = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const readHash = (file: string) => (fs.existsSync(file) ? sha256(fs.readFileSync(file)) : null);
function exec(bin: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env) {
  const result = spawnSync(bin, args, {
    cwd,
    env,
    encoding: "utf8",
    timeout: 60_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error || result.status !== 0)
    throw new Error(`${bin} ${args[0]} failed: ${result.error?.message ?? result.stderr}`);
  return result.stdout.trim();
}
function policyEnvironment(env: NodeJS.ProcessEnv) {
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
function configuredBunWorkers(hardware: number, env: NodeJS.ProcessEnv) {
  // Mirrors Linux bun_core::get_thread_count and its decimal u16 parser.
  for (const key of ["UV_THREADPOOL_SIZE", "GOMAXPROCS"]) {
    const value = env[key]?.replace(/^[\t-\r ]+|[\t-\r ]+$/g, "");
    if (!value || !/^\+?[0-9](?:[0-9_]*[0-9])?$/.test(value)) continue;
    const number = Number(value.replaceAll("_", ""));
    if (number >= 2 && number <= 65535) return Math.min(number, 1024);
  }
  return Math.min(Math.max(hardware, 2), 1024);
}
function verifySource(repo: string) {
  if (Object.values(MATRIX_TRANSPORT_BLOBS).some(blob => !/^[a-f0-9]{40}$/.test(blob)))
    throw new Error("Final matrix transport records are not bound; comparison is not admitted");
  const driver = path.join(repo, DRIVER_PATH);
  if (fs.realpathSync(new URL(import.meta.url)) !== fs.realpathSync(driver))
    throw new Error("Comparison driver is not the reviewed source transport");
  verifyHash(driver, requiredOption("--driver-sha256"));
  const gitBlob = (bytes: Buffer) => createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
  const transports = new Map<string, string>([
    ...Object.entries(MATRIX_TRANSPORT_BLOBS),
    [DRIVER_PATH, gitBlob(fs.readFileSync(driver))],
  ]);
  const records = exec("git", ["ls-tree", "-r", "--full-tree", "HEAD"], repo).split("\n");
  const expectedRecords = [...transports].map(([file, blob]) => `100644 blob ${blob}\t${file}`);
  for (const [index, [file, blob]] of [...transports].entries()) {
    const absolute = path.join(repo, file);
    const stat = fs.lstatSync(absolute);
    if (
      !stat.isFile() ||
      (stat.mode & 0o111) !== 0 ||
      gitBlob(fs.readFileSync(absolute)) !== blob ||
      !records.includes(expectedRecords[index]!)
    )
      throw new Error(`Source transport record differs: ${file}`);
  }
  // The receiver's carrier may add only these exact records to the frozen source.
  const inventory = records.filter(line => !expectedRecords.includes(line)).join("\n");
  if (sha256(inventory) !== SOURCE_INVENTORY_SHA256)
    throw new Error("Materialized tracked source differs from frozen source inventory");
  if (
    readHash(path.join(repo, "pnpm-lock.yaml")) !== LOCKFILE_SHA256 ||
    readHash(path.join(repo, "pnpm-workspace.yaml")) !== WORKSPACE_SHA256
  )
    throw new Error("Frozen dependency inputs differ");
  exec("git", ["diff", "--exit-code", "--"], repo);
  exec("git", ["diff", "--cached", "--exit-code", "--"], repo);
  if (exec("git", ["ls-files", "--others", "--exclude-standard"], repo))
    throw new Error("Unexpected untracked source input");
  return expectedRecords;
}
function option(name: string, fallback: string) {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : (process.argv[index + 1] ?? fallback);
}
function requiredOption(name: string) {
  const value = option(name, "");
  if (!value || value.startsWith("--")) throw new Error(`Required option: ${name}`);
  return value;
}
function verifyHash(file: string, expected: string) {
  if (!/^[a-f0-9]{64}$/.test(expected) || readHash(file) !== expected) throw new Error(`SHA256 mismatch: ${file}`);
}
function externalFile(repo: string, file: string) {
  const actual = fs.realpathSync(file);
  if (actual === repo || actual.startsWith(`${repo}${path.sep}`))
    throw new Error("Final artifact and completed discovery receipt must be outside source");
  return actual;
}
function inputState(repo: string, receipt: string, expected: string) {
  verifyHash(receipt, expected);
  const discovery = JSON.parse(fs.readFileSync(receipt, "utf8"));
  const identity = discovery.identity;
  const manifest = JSON.parse(fs.readFileSync(path.join(repo, "tools/bun-checker-matrix-input/manifest.json"), "utf8"));
  const priorHost = identity?.host;
  const priorPolicy = priorHost?.policy;
  if (
    priorPolicy?.bun?.env?.CI !== "true" ||
    priorPolicy.bun.env.OPENCLAW_LOCAL_CHECK !== "0" ||
    priorPolicy.bun.args?.length !== 0
  )
    throw new Error("Discovery did not use Bun default workers under canonical CI");
  assertCiProfile(
    priorHost.cpus,
    priorHost.memoryCapacity?.capacityBytes ?? null,
    priorHost.resourceContract,
    priorPolicy.bun.hardwareConcurrency,
    priorPolicy.bun.configuredLimit,
    priorPolicy.native,
  );
  const controls = discovery.controls;
  const rows = discovery.rows;
  const graphs = identity?.manifest?.graphs;
  const graphKey = (graph: { name: string; config: string; build?: boolean }) =>
    JSON.stringify([graph.name, graph.config, graph.build ?? false]);
  const candidate = identity?.manifest?.bun;
  const hostedBaseline = manifest.native?.hostedBaseline;
  // Hosted CI binds source and version, not the ELF used for these measurements.
  // Each omitted native check must retain its exact CI config and job evidence.
  const nativeProofMatches = (row: {
    nativeCode: number | null;
    nativeValidOutput: boolean | null;
    baseline: string;
    baselineEvidence?: unknown;
    config: string;
    build: boolean;
  }) => {
    if (row.nativeCode === 0 && row.nativeValidOutput === true)
      return row.baseline === "same-source remote native" && row.baselineEvidence === undefined;
    const baseline = hostedBaseline?.rows?.find((proof: { config: string }) => proof.config === row.config);
    return (
      row.build === false &&
      row.nativeCode === null &&
      row.nativeValidOutput === null &&
      row.baseline === "exact-source hosted CI (version-bound)" &&
      baseline !== undefined &&
      isDeepStrictEqual(row.baselineEvidence, {
        ...baseline,
        source: hostedBaseline.source,
        version: hostedBaseline.version,
        run: hostedBaseline.run,
        binding: "version-only",
      })
    );
  };
  // Only the completed final-candidate matrix admits timing; older discoveries
  // remain historical evidence, even when they verified the same source inputs.
  if (
    discovery.completed !== true ||
    discovery.batchComplete !== true ||
    discovery.sourceVerified !== true ||
    discovery.failure !== null ||
    discovery.sourceVerificationError !== null ||
    discovery.canonicalRows !== 37 ||
    discovery.projectReferenceRows !== 1 ||
    discovery.clean !== 38 ||
    discovery.failures !== 0 ||
    !isDeepStrictEqual(identity?.manifest, manifest) ||
    manifest.receiptSchema !== 3 ||
    manifest.resumeReceipt !== null ||
    identity?.priorReceipt !== undefined ||
    hostedBaseline?.source !== SOURCE ||
    hostedBaseline?.version !== NATIVE_PACKAGES[0].version ||
    hostedBaseline?.binding !== "version-only" ||
    hostedBaseline?.rows?.length !== 37 ||
    identity?.source !== SOURCE ||
    identity?.manifest?.source !== SOURCE ||
    identity?.sourceInventorySha256 !== DISCOVERY_INVENTORY_SHA256 ||
    identity?.manifest?.sourceInventorySha256 !== DISCOVERY_INVENTORY_SHA256 ||
    identity?.manifest?.lockfileSha256 !== LOCKFILE_SHA256 ||
    candidate?.source !== requiredOption("--bun-source") ||
    candidate?.binarySha256 !== requiredOption("--bun-sha256") ||
    candidate?.archiveSha256 !== requiredOption("--bun-artifact-sha256") ||
    candidate?.revision !== requiredOption("--bun-revision") ||
    candidate?.version !== requiredOption("--bun-version") ||
    candidate?.typescript !== "7.0.2" ||
    identity?.bun?.version !== candidate?.version ||
    identity?.bun?.revision !== candidate?.revision ||
    identity?.bun?.embedded !== candidate?.typescript ||
    identity?.bun?.binarySha256 !== candidate?.binarySha256 ||
    identity?.native?.version !== `Version ${NATIVE_PACKAGES[0].version}` ||
    !/^[a-f0-9]{64}$/.test(identity?.native?.binarySha256 ?? "") ||
    identity?.native?.binarySha256 !== identity?.manifest?.native?.binarySha256 ||
    process.version !== "v24.16.0" ||
    identity?.host?.node !== process.version ||
    readHash(process.execPath) !== NODE_BINARY_SHA256 ||
    !Array.isArray(controls) ||
    controls.length !== 4 ||
    ["bun", "native", "upstream", "oracle"].some(
      candidate => controls.filter(control => control.candidate === candidate && control.passed === true).length !== 1,
    ) ||
    !Array.isArray(rows) ||
    rows.length !== 38 ||
    !Array.isArray(graphs) ||
    graphs.length !== 38 ||
    new Set(rows.map(graphKey)).size !== 38 ||
    new Set(graphs.map(graphKey)).size !== 38 ||
    JSON.stringify(rows.map(graphKey).sort()) !== JSON.stringify(graphs.map(graphKey).sort()) ||
    rows.filter(row => row.build === false).length !== 37 ||
    rows.filter(row => row.build === true).length !== 1 ||
    rows.some(
      row =>
        row.clean !== true ||
        row.inventoryMatches !== true ||
        row.bunCode !== 0 ||
        row.bunValidOutput !== true ||
        !nativeProofMatches(row) ||
        !Array.isArray(row.bunDiagnostics) ||
        row.bunDiagnostics.length !== 0 ||
        !Array.isArray(row.nativeDiagnostics) ||
        row.nativeDiagnostics.length !== 0 ||
        !Array.isArray(row.bunApplicationFiles) ||
        row.bunApplicationFiles.length === 0 ||
        !Array.isArray(row.nativeApplicationFiles) ||
        row.bunApplicationCount !== row.bunApplicationFiles.length ||
        row.nativeApplicationCount !== row.nativeApplicationFiles.length ||
        !/^[a-f0-9]{64}$/.test(row.bunFileHash ?? "") ||
        row.bunFileHash !== row.nativeFileHash ||
        JSON.stringify(row.bunApplicationFiles) !== JSON.stringify(row.nativeApplicationFiles),
    )
  )
    throw new Error("Completed final-candidate matrix, inputs or strict controls do not qualify timing");
  const metadata = ["node_modules/.modules.yaml", "node_modules/.pnpm/lock.yaml"].map(file => [
    file,
    readHash(path.join(repo, file)),
  ]);
  if (metadata.some(([, hash]) => hash === null)) throw new Error("Qualified dependency metadata is missing");
  return {
    receiptSha256: expected,
    nodeModules: fs.realpathSync(path.join(repo, "node_modules")),
    metadata,
    generated: ["openclaw-state", "openclaw-agent"].map(name => [
      name,
      readHash(path.join(repo, ".artifacts/kysely", `${name}-db.generated.ts`)),
    ]),
  };
}
function validBuildInfo(file: string, version: string) {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    return (
      Array.isArray(value.fileNames) &&
      value.fileNames.length > 0 &&
      Array.isArray(value.root) &&
      value.root.length > 0 &&
      value.version === version
    );
  } catch {
    return false;
  }
}
function cacheBefore(file: string, expected: string | null | undefined) {
  const before = readHash(file);
  if (expected !== undefined && before !== expected)
    throw new Error("Native incremental cache does not match the admitted pair state");
  return before;
}
function resourceContract(read = (file: string) => fs.readFileSync(file, "utf8")) {
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
      const parts = fields!.split(" ");
      const root = decodeMountInfoPath(parts[3]!);
      const mount = decodeMountInfoPath(parts[4]!);
      if (root.split("/").includes("..") || (root !== "/" && relative !== root && !relative.startsWith(`${root}/`)))
        return [];
      return [{ root, mount, relative: root === "/" ? relative : relative.slice(root.length) }];
    });
  if (mounts.length === 0) throw new Error("No visible cgroup v2 mount maps this process");
  const limits = new Map<string, Record<string, string | null>>();
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
              if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
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
function assertCiProfile(
  cpus: number,
  capacity: number | null,
  contract: ReturnType<typeof resourceContract>,
  hardware: number,
  workers: number,
  native: { args: string[]; env: NodeJS.ProcessEnv },
) {
  const cpuCount = (value: string | null) => {
    if (!value || !/^\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*$/.test(value)) throw new Error("Unknown CPU set");
    const ranges = value
      .split(",")
      .map(range => {
        const [start, end = start] = range.split("-").map(Number);
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end! < start!)
          throw new Error("Invalid CPU range");
        return [start!, end!] as const;
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
    if (limits["cpuset.cpus.effective"] && cpuCount(limits["cpuset.cpus.effective"]!) < 4)
      throw new Error("CPU set contradicts the CI profile");
    if (limits["cpu.max"]) {
      const [quota, period] = limits["cpu.max"]!.split(/\s+/);
      if (
        !/^\d+$/.test(period!) ||
        Number(period!) <= 0 ||
        (quota !== "max" && (!/^\d+$/.test(quota!) || Number(quota!) / Number(period!) < 4))
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
function parseDiagnostics(output: string, root: string, cwd: string) {
  const diagnostics: Diagnostic[] = [];
  const unparsed: string[] = [];
  for (const line of output.replace(/\x1b\[[0-9;]*m/g, "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    const match = /^(.*)\((\d+),(\d+)\): error TS(\d+): (.*)$/.exec(line);
    if (match) {
      const file = match[1]!.startsWith("bundled:///") ? match[1]! : path.relative(root, path.resolve(cwd, match[1]!));
      diagnostics.push({
        file,
        line: Number(match[2]),
        column: Number(match[3]),
        code: Number(match[4]),
        message: match[5]!,
      });
    } else if (/^\s+/.test(line) && diagnostics.length > 0) {
      diagnostics[diagnostics.length - 1]!.message += `\n${line}`;
    } else unparsed.push(line);
  }
  return { diagnostics, unparsed };
}
function matchesBunSummary(
  stderr: string,
  diagnostics: Diagnostic[],
  root: string,
  cwd: string,
  mode: "check" | "inventory",
) {
  const lines = stderr.replace(/\n$/, "").split("\n");
  const header = lines.shift() ?? "";
  const count = "(\\d{1,3}(?:,\\d{3})*|\\d+)";
  const success = new RegExp(
    `^✓ No type errors in ${count} files?(?: across ${count} projects?)? \\[[\\d.]+(?:ms|s)\\]$`,
  );
  const passed = success.exec(header);
  // listFilesOnly lists the loaded program without checking its files.
  if (passed)
    return (
      (mode === "inventory" || Number(passed[1]!.replaceAll(",", "")) > 0) &&
      diagnostics.length === 0 &&
      lines.length === 0
    );
  const failure = new RegExp(
    `^Found ${count} errors? in ${count} files?, checked ${count} files?(?: across ${count} projects?)? \\[[\\d.]+(?:ms|s)\\]$`,
  ).exec(header);
  if (
    !failure ||
    Number(failure[1]!.replaceAll(",", "")) !== diagnostics.length ||
    Number(failure[3]!.replaceAll(",", "")) === 0
  )
    return false;
  const files = new Map<string, { count: number; firstLine: number }>();
  for (const diagnostic of diagnostics) {
    const prior = files.get(diagnostic.file);
    files.set(diagnostic.file, {
      count: (prior?.count ?? 0) + 1,
      firstLine: Math.min(prior?.firstLine ?? diagnostic.line, diagnostic.line),
    });
  }
  if (Number(failure[2]!.replaceAll(",", "")) !== files.size) return false;
  if (files.size < 2) return lines.length === 0;
  if (lines.shift() !== "" || lines.length !== files.size) return false;
  for (const line of lines) {
    const row = /^\s+(\d+)  (.*):(\d+)$/.exec(line);
    if (!row) return false;
    const file = path.relative(root, path.resolve(cwd, row[2]!));
    const expected = files.get(file);
    if (!expected || expected.count !== Number(row[1]) || expected.firstLine !== Number(row[3])) return false;
    files.delete(file);
  }
  return files.size === 0;
}
async function provision(root: string, names: string[]): Promise<Candidate[]> {
  const candidates: Candidate[] = [];
  for (const entry of NATIVE_PACKAGES.filter(entry => names.includes(entry.name))) {
    const directory = path.join(root, "compilers", entry.name);
    const bin = path.join(directory, "package", entry.executable);
    const tarball = path.join(directory, "package.tgz");
    fs.mkdirSync(directory, { recursive: true });
    const basename = entry.packageName.split("/")[1]!;
    const url = `https://registry.npmjs.org/${entry.packageName}/-/${basename}-${entry.version}.tgz`;
    if (!fs.existsSync(tarball)) {
      const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
      if (!response.ok) throw new Error(`Compiler download HTTP ${response.status}: ${url}`);
      fs.writeFileSync(tarball, Buffer.from(await response.arrayBuffer()), { flag: "wx" });
    }
    const observedIntegrity = createHash("sha512").update(fs.readFileSync(tarball)).digest("base64");
    if (observedIntegrity !== entry.integrity) throw new Error(`Compiler integrity mismatch: ${entry.name}`);
    if (!fs.existsSync(bin)) {
      // Reject links and non-package paths before extracting any downloaded bytes.
      exec(
        "python3",
        [
          "-c",
          "import pathlib,sys,tarfile; t=tarfile.open(sys.argv[1]); ms=t.getmembers(); assert all((m.isfile() or m.isdir()) and pathlib.PurePosixPath(m.name).parts[0]=='package' and '..' not in pathlib.PurePosixPath(m.name).parts for m in ms); t.extractall(sys.argv[2],members=ms,filter='data')",
          tarball,
          directory,
        ],
        root,
      );
    }
    const observedVersion = exec(bin, ["--version"], root);
    if (!observedVersion.includes(entry.version))
      throw new Error(`Unexpected ${entry.name} version: ${observedVersion}`);
    candidates.push({ ...entry, bin, sha256: readHash(bin)!, observedVersion });
  }
  return candidates;
}
function providedBun(neutral: string, repo: string): Candidate {
  const bin = fs.realpathSync(requiredOption("--bun-bin"));
  const binaryHash = requiredOption("--bun-sha256");
  const artifact = externalFile(repo, requiredOption("--bun-artifact"));
  const artifactHash = requiredOption("--bun-artifact-sha256");
  const source = requiredOption("--bun-source");
  const revision = requiredOption("--bun-revision");
  const version = requiredOption("--bun-version");
  if (!/^[a-f0-9]{40}$/.test(source) || !revision.includes(source.slice(0, 9)))
    throw new Error("Bun revision does not identify the supplied source commit");
  verifyHash(bin, binaryHash);
  verifyHash(artifact, artifactHash);
  const observedVersion = exec(bin, ["--version"], neutral);
  if (observedVersion !== version || exec(bin, ["--revision"], neutral) !== revision)
    throw new Error("Supplied Bun version/revision mismatch");
  return {
    name: "bun",
    version,
    bin,
    sha256: binaryHash,
    observedVersion,
    source,
    revision,
    artifactSha256: artifactHash,
  };
}
function summarize(results: Result[], eligible: boolean) {
  const groups = new Map<string, Result[]>();
  for (const row of results) {
    const key = `${row.graph}/${row.candidate}/${row.state}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return [...groups.entries()].map(([key, rows]) => {
    const times = rows.map(row => row.wallMs).toSorted((a, b) => a - b);
    const cpu = rows
      .map(row => row.resources.cpuMs)
      .filter(value => value !== null)
      .toSorted((a, b) => a - b);
    const rss = rows.map(row => row.resources.peakRssBytes).filter(value => value !== null);
    const expectedDiagnostic = rows.every(row => ["new-root-negative", "fixture-negative"].includes(row.state));
    const passed = rows.filter(
      row =>
        row.validOutput &&
        (expectedDiagnostic
          ? (row.candidate === "bun" ? row.exitCode === 1 : [1, 2].includes(row.exitCode ?? -1)) &&
            row.diagnostics.length === 1 &&
            row.diagnostics[0]!.code === 2322
          : row.exitCode === 0),
    ).length;
    return {
      key,
      runs: rows.length,
      expectedOutcome: expectedDiagnostic ? "one-TS2322" : "clean",
      passed,
      timingEligible:
        eligible &&
        ["first", "second"].includes(rows[0]!.state) &&
        !expectedDiagnostic &&
        passed === rows.length &&
        rows.every(row => row.resourceContractStable),
      medianMs: times[Math.floor(times.length / 2)],
      minMs: times[0],
      maxMs: times.at(-1),
      medianSampledCpuMs: cpu.length === rows.length ? cpu[Math.floor(cpu.length / 2)] : null,
      maxSampledLeaderRssBytes: rss.length === rows.length ? Math.max(...rss) : null,
      diagnosticCodes: [...new Set(rows.flatMap(row => row.diagnostics.map(diagnostic => diagnostic.code)))],
    };
  });
}
function compare(results: Result[], candidateCount: number) {
  const keys = [...new Set(results.map(row => `${row.graph}/${row.state}/${row.repetition}`))];
  return keys.map(key => {
    const rows = results.filter(row => `${row.graph}/${row.state}/${row.repetition}` === key);
    const signatures = rows.map(row =>
      JSON.stringify(
        row.inventory?.application ??
          row.diagnostics.toSorted((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
      ),
    );
    return {
      key,
      complete:
        rows.length === candidateCount &&
        new Set(rows.map(row => row.candidate)).size === candidateCount &&
        rows.every(row => row.validOutput),
      matches:
        rows.length === candidateCount &&
        new Set(signatures).size === 1 &&
        rows.every(row => !row.inventory || row.inventory.application.length > 0),
      counts: rows.map(row => ({
        candidate: row.candidate,
        count: row.inventory?.application.length ?? row.diagnostics.length,
        libraries: row.inventory?.libraries.length,
      })),
    };
  });
}
function scalarControlsPassed(controls: Result[], candidates: string[], fixture: string) {
  return (
    controls.length === candidates.length * 2 &&
    candidates.every(candidate => {
      const positive = controls.filter(row => row.candidate === candidate && row.state === "fixture-positive");
      const negative = controls.filter(row => row.candidate === candidate && row.state === "fixture-negative");
      const row = negative[0];
      const diagnostic = row?.diagnostics[0];
      return (
        positive.length === 1 &&
        positive[0]!.validOutput &&
        positive[0]!.exitCode === 0 &&
        positive[0]!.diagnostics.length === 0 &&
        negative.length === 1 &&
        row!.validOutput &&
        row!.exitCode === (candidate === "bun" ? 1 : 2) &&
        row!.diagnostics.length === 1 &&
        diagnostic?.file === fixture &&
        diagnostic.line === 1 &&
        diagnostic.column === 7 &&
        diagnostic.code === 2322 &&
        diagnostic.message === "Type 'string' is not assignable to type 'number'."
      );
    })
  );
}
function timingEligible(results: Result[], candidateCount: number, completed: boolean, controlsPassed: boolean) {
  const timed = results.filter(row => ["first", "second"].includes(row.state));
  return (
    completed &&
    controlsPassed &&
    preflightPassed(results, candidateCount) &&
    results.length === candidateCount * 16 &&
    timed.length === candidateCount * 12 &&
    ["core", "ui"].every(graph =>
      ["first", "second"].every(state =>
        [0, 1, 2].every(
          repetition =>
            timed.filter(row => row.graph === graph && row.state === state && row.repetition === repetition).length ===
            candidateCount,
        ),
      ),
    ) &&
    cleanComparisons(timed, candidateCount)
  );
}
function cleanComparisons(results: Result[], candidateCount: number) {
  return (
    compare(results, candidateCount).every(row => row.complete && row.matches) &&
    results.every(row => row.validOutput && row.exitCode === 0 && row.resourceContractStable)
  );
}
function preflightPassed(results: Result[], candidateCount: number) {
  const rows = results.filter(row => ["preflight", "inventory"].includes(row.state));
  return (
    rows.length === candidateCount * 4 &&
    ["core", "ui"].every(graph =>
      ["preflight", "inventory"].every(
        state =>
          rows.filter(
            row =>
              row.graph === graph &&
              row.state === state &&
              row.repetition === 0 &&
              (state !== "inventory" || (row.inventory?.application.length ?? 0) > 0),
          ).length === candidateCount,
      ),
    ) &&
    cleanComparisons(rows, candidateCount)
  );
}
async function main() {
  const repo = fs.realpathSync(process.cwd());
  if (process.platform !== "linux" || process.arch !== "x64")
    throw new Error("This pinned experiment requires Linux x64; run it through the repository remote wrapper.");
  const materializedHead = exec("git", ["rev-parse", "HEAD"], repo);
  const sourceTransportRecords = verifySource(repo);
  const phase = option("--phase", "smoke");
  if (!["smoke", "matrix", "timing", "probe"].includes(phase))
    throw new Error("Expected --phase smoke|matrix|timing|probe");
  const repetitions = Number(option("--repetitions", phase === "timing" ? "3" : "1"));
  if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 5)
    throw new Error("Repetitions must be 1 through 5");
  if (phase === "timing" && repetitions !== 3)
    throw new Error("The admitted timing protocol requires three repetitions");
  const nativeNames = option("--native", "current").split(",");
  if (
    new Set(nativeNames).size !== nativeNames.length ||
    nativeNames.some(name => !NATIVE_PACKAGES.some(candidate => candidate.name === name))
  )
    throw new Error("Expected admitted native comparators: current and/or next");
  const discoveryReceipt = externalFile(repo, requiredOption("--discovery-receipt"));
  const discoveryReceiptHash = requiredOption("--discovery-receipt-sha256");
  const initialInputs = inputState(repo, discoveryReceipt, discoveryReceiptHash);
  const output = path.resolve(option("--out", path.join(os.tmpdir(), "openclaw-checker-compare-20261013")));
  if (output.startsWith(`${repo}${path.sep}`) || output === repo)
    throw new Error("Evidence must be outside the synchronized checkout");
  const identityPath = path.join(output, "identity.json");
  const identity = {
    source: SOURCE,
    sourceInventorySha256: SOURCE_INVENTORY_SHA256,
    sourceTransportRecords,
    driverSha256: readHash(new URL(import.meta.url).pathname),
    lockfileSha256: readHash(path.join(repo, "pnpm-lock.yaml")),
    discoveryReceiptSha256: discoveryReceiptHash,
    nativeNames,
    bunSha256: requiredOption("--bun-sha256"),
    bunSource: requiredOption("--bun-source"),
    bunRevision: requiredOption("--bun-revision"),
    bunArtifactSha256: requiredOption("--bun-artifact-sha256"),
  };
  if (
    fs.existsSync(output) &&
    (!fs.existsSync(identityPath) ||
      JSON.stringify(JSON.parse(fs.readFileSync(identityPath, "utf8"))) !== JSON.stringify(identity))
  )
    throw new Error("Evidence directory belongs to different inputs");
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(identityPath, `${JSON.stringify(identity)}\n`);
  const neutral = path.join(output, "neutral");
  fs.mkdirSync(neutral, { recursive: true });
  const bun = providedBun(neutral, repo);
  const candidates = [...(await provision(output, nativeNames)), bun];
  const embeddedTypeScript = exec(bun.bin, ["-p", "process.versions.typescript"], neutral);
  if (embeddedTypeScript !== "7.0.2") throw new Error(`Unexpected Bun TypeScript: ${embeddedTypeScript}`);
  const ciEnv = { ...process.env, CI: "true", OPENCLAW_LOCAL_CHECK: "0" };
  const nativeEnv = resolveLocalCheckEnv(ciEnv);
  const hostResources = {
    logicalCpuCount: os.availableParallelism(),
    totalMemoryBytes: os.totalmem(),
  };
  const hardwareConcurrency = Number(exec(bun.bin, ["-p", "navigator.hardwareConcurrency"], neutral, ciEnv));
  if (!Number.isSafeInteger(hardwareConcurrency) || hardwareConcurrency < 1)
    throw new Error("Invalid Bun hardware concurrency observation");
  const nativePolicy = applyLocalTsgoPolicy(["--project", "<config>"], nativeEnv, hostResources);
  const resources = resourceContract();
  const memory = readProcessMemoryCapacity({});
  const workers = configuredBunWorkers(hardwareConcurrency, ciEnv);
  const allGraphs = expandTsgoExecutionGraphs(TSGO_CI_GRAPHS);
  const requested = option(
    "--graphs",
    phase === "smoke" || phase === "timing"
      ? "core,ui"
      : "core,ui,extensions,scripts,core-test-packages,test-root-tooling",
  ).split(",");
  const graphs =
    phase === "matrix"
      ? allGraphs
      : requested.map(name => {
          const graph = allGraphs.find(value => value.name === name);
          if (!graph) throw new Error(`Unknown canonical graph: ${name}`);
          return graph;
        });
  if (
    phase === "timing" &&
    (graphs.length !== 2 || !graphs.some(graph => graph.name === "core") || !graphs.some(graph => graph.name === "ui"))
  )
    throw new Error("The admitted timing protocol covers exactly core and ui");
  const host = {
    materializedHead,
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    release: os.release(),
    cpus: os.availableParallelism(),
    totalMemory: os.totalmem(),
    cpuModel: os.cpus()[0]?.model,
    limits: exec("bash", ["-c", "ulimit -n; ulimit -u; cat /proc/self/cgroup"], repo),
    policy: {
      inherited: policyEnvironment(process.env),
      native: { args: nativePolicy.args, env: policyEnvironment(nativePolicy.env) },
      bun: {
        args: [],
        env: policyEnvironment(ciEnv),
        hardwareConcurrency,
        configuredLimit: workers,
        evidence: "source-derived configured limit; active workers not measured",
      },
    },
    osPageCache: "uncontrolled",
    resourceContract: resources,
    memoryCapacity: memory,
    rssScope: "leader process, sampled lower bound, excludes descendants",
    interpretation: "constrained CI deployment-policy comparison, not equal-thread; core/UI only; no overall winner",
  };
  const runId = `${phase}-${Date.now()}`;
  const runDir = path.join(output, runId);
  fs.mkdirSync(runDir);
  const results: Result[] = [];
  const controls: Result[] = [];
  let controlsPassed = false;
  let frozenInputs = initialInputs;
  const verifyInputs = () => {
    verifySource(repo);
    if (JSON.stringify(inputState(repo, discoveryReceipt, discoveryReceiptHash)) !== JSON.stringify(frozenInputs))
      throw new Error("Source dependency/generated inputs changed");
    for (const candidate of candidates) verifyHash(candidate.bin, candidate.sha256);
  };
  const start = performance.now();
  const deadline = start + Number(option("--budget-seconds", "2400")) * 1000;
  const ticks = Number(exec("getconf", ["CLK_TCK"], repo));
  fs.writeFileSync(
    path.join(runDir, "manifest.json"),
    `${JSON.stringify(
      {
        identity,
        host,
        candidates,
        embeddedTypeScript,
        phase,
        graphs,
        repetitions,
        standardLibraries: candidates.map(candidate => ({
          name: candidate.name,
          baseline: candidate.name === "bun" ? embeddedTypeScript : candidate.version,
        })),
      },
      null,
      2,
    )}\n`,
  );
  assertCiProfile(
    hostResources.logicalCpuCount,
    memory.capacityBytes,
    resources,
    hardwareConcurrency,
    workers,
    nativePolicy,
  );
  console.log(
    `[checker-compare] ready ${JSON.stringify({ source: SOURCE, output: runDir, phase, graphCount: graphs.length, candidates: candidates.map(({ name, version, sha256 }) => ({ name, version, sha256 })), host })}`,
  );
  const run = async (
    candidate: Candidate,
    graph: Graph,
    state: string,
    repetition: number,
    cache: string,
    expectedCache?: string | null,
  ): Promise<Result> => {
    if (performance.now() >= deadline) throw new Error("Comparison budget exhausted; partial evidence retained");
    const config = path.resolve(repo, graph.config);
    fs.mkdirSync(path.dirname(cache), { recursive: true });
    const policy = applyLocalTsgoPolicy(
      ["--project", config, "--pretty", "false", "--noEmit", "--incremental", "--tsBuildInfoFile", cache],
      nativeEnv,
      hostResources,
    );
    const args =
      candidate.name === "bun"
        ? ["check", "--no-pretty", "--noEmit", "--declaration", "false", "--project", config]
        : policy.args;
    if (state === "inventory") args.push("--listFilesOnly");
    const cwd = neutral;
    const before = candidate.name === "bun" ? null : cacheBefore(cache, expectedCache);
    const resourcesBefore = resourceContract();
    const sampler = createTsgoResourceSampler({ ticksPerSecond: ticks });
    const buffers: Buffer[][] = [[], []];
    let bytes = 0;
    let overflow = false;
    let interval: NodeJS.Timeout | undefined;
    let code: number | null = null;
    let interrupted = false;
    let error: string | null = null;
    let unjoined: unknown;
    const began = performance.now();
    try {
      code = await runManagedCommand({
        bin: candidate.bin,
        args,
        cwd,
        env: candidate.name === "bun" ? ciEnv : policy.env,
        stdio: ["ignore", "pipe", "pipe"],
        requireProcessTreeExit: true,
        timeoutMs: Math.min(600_000, deadline - began),
        onSignal() {
          interrupted = true;
        },
        onReady(child) {
          if (!child.pid) throw new Error("Compiler has no PID");
          const pid = child.pid;
          sampler.sample(pid);
          interval = setInterval(() => sampler.sample(pid), 100);
          for (const [index, stream] of [child.stdout, child.stderr].entries())
            stream?.on("data", (chunk: Buffer) => {
              bytes += chunk.length;
              if (bytes <= 8 * 1024 * 1024) buffers[index]!.push(chunk);
              else overflow = true;
            });
        },
      });
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
      if (hasUnjoinedWork(caught)) unjoined = caught;
    } finally {
      clearInterval(interval);
    }
    const wallMs = performance.now() - began;
    const resourceContractStable =
      JSON.stringify(resourcesBefore) === JSON.stringify(host.resourceContract) &&
      JSON.stringify(resourcesBefore) === JSON.stringify(resourceContract());
    const stdout = Buffer.concat(buffers[0]!).toString("utf8");
    const stderr = Buffer.concat(buffers[1]!).toString("utf8");
    const parsed = state === "inventory" ? { diagnostics: [], unparsed: [] } : parseDiagnostics(stdout, repo, cwd);
    const inventory = state === "inventory" ? { application: [] as string[], libraries: [] as string[] } : undefined;
    let inventoryValid = true;
    if (inventory)
      for (const line of stdout.split(/\r?\n/).filter(Boolean)) {
        if (!line.startsWith("bundled:///libs/") && (!path.isAbsolute(line) || !fs.existsSync(line)))
          inventoryValid = false;
        if (
          line.startsWith("bundled:///libs/") ||
          (line.startsWith(path.dirname(candidate.bin) + path.sep) && /\/lib\.[^/]+\.d\.ts$/.test(line))
        )
          inventory.libraries.push(line);
        else inventory.application.push(path.relative(repo, path.resolve(cwd, line)));
      }
    inventory?.application.sort();
    const after = candidate.name === "bun" ? null : readHash(cache);
    const cacheValid =
      candidate.name === "bun" || expectedCache === undefined || validBuildInfo(cache, candidate.version);
    const validOutput =
      !overflow &&
      error === null &&
      resourceContractStable &&
      cacheValid &&
      inventoryValid &&
      (!inventory || inventory.application.length > 0) &&
      parsed.unparsed.length === 0 &&
      (candidate.name === "bun"
        ? matchesBunSummary(stderr, parsed.diagnostics, repo, cwd, state === "inventory" ? "inventory" : "check") &&
          ((code === 0 && parsed.diagnostics.length === 0) || (code === 1 && parsed.diagnostics.length > 0))
        : stderr === "" &&
          ((code === 0 && parsed.diagnostics.length === 0) ||
            ([1, 2].includes(code ?? -1) && parsed.diagnostics.length > 0)));
    const checkedFiles =
      candidate.name === "bun"
        ? Number(
            /^✓ No type errors in ([\d,]+) files?/.exec(stderr)?.[1]?.replaceAll(",", "") ??
              /^Found .* checked ([\d,]+) files?/.exec(stderr)?.[1]?.replaceAll(",", "") ??
              NaN,
          )
        : inventory
          ? inventory.application.length + inventory.libraries.length
          : null;
    const fileBase = `${(results.length + controls.length).toString().padStart(3, "0")}-${graph.name}-${candidate.name}-${state}-${repetition}`;
    const row: Result = {
      graph: graph.name,
      candidate: candidate.name,
      state,
      repetition,
      exitCode: code,
      error: overflow ? "output-overflow" : error,
      validOutput,
      diagnostics: parsed.diagnostics,
      inventory,
      wallMs,
      resources: sampler.result(),
      stdoutFile: `${fileBase}.stdout`,
      stderrFile: `${fileBase}.stderr`,
      configSha256: readHash(config)!,
      args,
      policyEnvironment: policyEnvironment(candidate.name === "bun" ? ciEnv : policy.env),
      cwd,
      buildInfoBefore: before,
      buildInfoAfter: after,
      cacheMode:
        candidate.name === "bun"
          ? state === "second"
            ? "fresh-process; warm OS page cache, uncontrolled"
            : "fresh-process; OS page cache uncontrolled"
          : expectedCache === null
            ? "fresh incremental build-info"
            : expectedCache === undefined
              ? "unmeasured cache state"
              : "reused incremental build-info",
      checkedFiles: Number.isNaN(checkedFiles) ? null : checkedFiles,
      resourceContractStable,
    };
    fs.writeFileSync(path.join(runDir, row.stdoutFile), stdout);
    fs.writeFileSync(path.join(runDir, row.stderrFile), stderr);
    (state.startsWith("fixture-") ? controls : results).push(row);
    fs.appendFileSync(path.join(runDir, "results.jsonl"), `${JSON.stringify(row)}\n`);
    console.log(
      `[checker-compare] ${JSON.stringify({ graph: row.graph, candidate: row.candidate, state, repetition, code, validOutput, diagnostics: row.diagnostics.length, wallMs: Math.round(wallMs), resources: row.resources, error: row.error, firstDiagnostic: row.diagnostics[0] ?? null, unexpected: validOutput ? undefined : { stdout: stdout.slice(0, 600), stderr: stderr.slice(0, 600) } })}`,
    );
    // A recorded failure cannot admit another measurement while children remain.
    if (unjoined) throw unjoined;
    if (interrupted) throw new Error("Comparison interrupted; no further compiler started");
    return row;
  };
  let completed = false;
  try {
    await withDistArtifactOwnership(repo, async () => {
      await ensureKyselyTypes(repo);
      const prepared = inputState(repo, discoveryReceipt, discoveryReceiptHash);
      if (
        prepared.nodeModules !== initialInputs.nodeModules ||
        JSON.stringify(prepared.metadata) !== JSON.stringify(initialInputs.metadata) ||
        prepared.generated.some(([, hash]) => hash === null)
      )
        throw new Error("Prepared inputs are not the qualified dependency/generated set");
      frozenInputs = prepared;
      verifySource(repo);
      const manifest = JSON.parse(fs.readFileSync(path.join(runDir, "manifest.json"), "utf8"));
      fs.writeFileSync(
        path.join(runDir, "manifest.json"),
        `${JSON.stringify({ ...manifest, preparedInputs: frozenInputs }, null, 2)}\n`,
      );
      if (phase === "smoke" || phase === "timing") {
        const fixture = path.join(runDir, "fixture.ts");
        const config = path.join(runDir, "fixture.json");
        fs.writeFileSync(
          config,
          JSON.stringify({
            compilerOptions: { strict: true, noEmit: true, target: "es2023", types: [] },
            files: [fixture],
          }),
        );
        for (const [state, source] of [
          ["fixture-positive", "const value: string = 'valid';\n"],
          ["fixture-negative", "const value: number = 'intentional negative';\n"],
        ]) {
          fs.writeFileSync(fixture, source!);
          for (const candidate of candidates)
            await run(
              candidate,
              { name: "fixture-scalar", config },
              state!,
              0,
              path.join(runDir, "cache", `fixture-${candidate.name}.tsbuildinfo`),
            );
        }
        controlsPassed = scalarControlsPassed(
          controls,
          candidates.map(({ name }) => name),
          path.relative(repo, fixture),
        );
        if (!controlsPassed) throw new Error("Strict scalar controls failed; no timed pair started");
      }
      if (phase === "timing") {
        for (const graph of graphs)
          for (const candidate of candidates) {
            verifyInputs();
            await run(
              candidate,
              graph,
              "preflight",
              0,
              path.join(runDir, "cache", `preflight-${graph.name}-${candidate.name}.tsbuildinfo`),
            );
            await run(
              candidate,
              graph,
              "inventory",
              0,
              path.join(runDir, "cache", `inventory-${graph.name}-${candidate.name}.tsbuildinfo`),
            );
          }
        if (!preflightPassed(results, candidates.length))
          throw new Error("Core/UI diagnostics or application inputs differ; no timed pair started");
      }
      if (phase === "probe") {
        const graph = allGraphs.find(value => value.name === "core")!;
        const probe = path.join(repo, "src", "__checker_comparison_probe__.ts");
        if (fs.existsSync(probe)) throw new Error("Refusing to replace existing source probe");
        try {
          for (const candidate of candidates)
            await run(candidate, graph, "prime", 0, path.join(runDir, "cache", `${candidate.name}.tsbuildinfo`));
          fs.writeFileSync(probe, 'export const checkerComparisonProbe: number = "intentional negative control";\n', {
            flag: "wx",
          });
          for (const candidate of candidates)
            await run(
              candidate,
              graph,
              "new-root-negative",
              0,
              path.join(runDir, "cache", `${candidate.name}.tsbuildinfo`),
            );
          fs.writeFileSync(probe, "export const checkerComparisonProbe: number = 1;\n");
          for (const candidate of candidates)
            await run(
              candidate,
              graph,
              "changed-valid",
              0,
              path.join(runDir, "cache", `${candidate.name}.tsbuildinfo`),
            );
        } finally {
          fs.rmSync(probe, { force: true });
        }
      } else {
        for (const graph of graphs)
          for (let repetition = 0; repetition < repetitions; repetition += 1) {
            const ordered = [
              ...candidates.slice(repetition % candidates.length),
              ...candidates.slice(0, repetition % candidates.length),
            ];
            for (const candidate of ordered) {
              verifyInputs();
              const cache = path.join(runDir, "cache", `${graph.name}-${candidate.name}-${repetition}.tsbuildinfo`);
              const first = await run(candidate, graph, "first", repetition, cache, null);
              if (phase !== "matrix") {
                if (candidate.name !== "bun" && !validBuildInfo(cache, candidate.version))
                  throw new Error("Native first pass did not produce usable incremental state");
                await run(candidate, graph, "second", repetition, cache, first.buildInfoAfter);
              }
              verifyInputs();
            }
            if (repetition === 0 && phase !== "timing")
              for (const candidate of ordered)
                await run(
                  candidate,
                  graph,
                  "inventory",
                  0,
                  path.join(runDir, "cache", `inventory-${graph.name}-${candidate.name}.tsbuildinfo`),
                );
          }
      }
      verifyInputs();
    });
    completed = true;
  } finally {
    const comparisons = compare(results, candidates.length);
    const eligible = timingEligible(results, candidates.length, completed, controlsPassed);
    const summary = {
      source: SOURCE,
      runId,
      completed,
      elapsedMs: performance.now() - start,
      comparisons,
      controlsPassed,
      controls,
      results: summarize(results, eligible),
      interpretation: "informational policy-specific timings; differing standard-library baselines; no overall winner",
      output: runDir,
    };
    fs.writeFileSync(path.join(runDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
    console.log(`[checker-compare:summary] ${JSON.stringify(summary)}`);
  }
  const negatives = results.filter(row => ["new-root-negative", "fixture-negative"].includes(row.state));
  const expectedFailures =
    ((phase !== "smoke" && phase !== "timing") || controlsPassed) &&
    (phase !== "probe" || negatives.length === candidates.length) &&
    negatives.every(
      row =>
        row.validOutput &&
        (row.candidate === "bun" ? row.exitCode === 1 : [1, 2].includes(row.exitCode ?? -1)) &&
        row.diagnostics.length === 1 &&
        row.diagnostics[0]!.code === 2322 &&
        row.diagnostics[0]!.file.endsWith(
          row.state === "fixture-negative" ? "/fixture.ts" : "/__checker_comparison_probe__.ts",
        ),
    );
  if (
    !expectedFailures ||
    compare(results, candidates.length).some(row => !row.complete || !row.matches) ||
    results.some(
      row => !row.validOutput || (!["new-root-negative", "fixture-negative"].includes(row.state) && row.exitCode !== 0),
    )
  )
    process.exitCode = 1;
}
main().catch(error => {
  console.error(`[checker-compare] FAILED: ${error instanceof Error ? error.stack : String(error)}`);
  process.exitCode = 1;
});
