import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const executable = resolve("build/release/bun");
const folder = resolve("build/openclaw-ci/trim-diagnostics");
mkdirSync(folder, { recursive: true });
const hello = `console.log("hello world");`;

function mappedBytesOf(file: Buffer): number {
  if (file.readUInt32BE(0) !== 0x7f454c46 || file[4] !== 2 || file[5] !== 1)
    throw new Error("Expected a little-endian ELF64 diagnostic executable");
  const headers = Number(file.readBigUInt64LE(0x20));
  const headerSize = file.readUInt16LE(0x36);
  let mappedBytes = 0;
  for (let index = 0; index < file.readUInt16LE(0x38); index++) {
    const at = headers + index * headerSize;
    if (file.readUInt32LE(at) === 1) mappedBytes += Number(file.readBigUInt64LE(at + 32));
  }
  return mappedBytes;
}

// Keep the historical archive bound to its original Buildkite producer.
async function compareUpstream135015(): Promise<void> {
  const historical = {
    build: 135015,
    source: "3688162c4cf3089ade1117eb4c89db2af25fe1ae",
    job: "01a18678-669f-4f91-a52f-83aeb59da2af",
    artifact: "01a1867f-c57b-4d56-b685-6ffb0835e514",
    archiveBytes: 68_011_752,
    archiveSHA256: "12ba4c7694d5ea06178b442540631024a0442fe28dd6ac8be502bb29e938460a",
    webkitTag: "autobuild-preview-pr-923-b67a0b1a",
    profile: "ci-build",
    orderingBuild: 134996,
  };
  const url = `https://buildkite.com/organizations/bun/pipelines/bun/builds/${historical.build}/jobs/${historical.job}/artifacts/${historical.artifact}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Historical artifact download failed: HTTP ${response.status}`);
  const archive = Buffer.from(await response.arrayBuffer());
  const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
  if (archive.length !== historical.archiveBytes || sha256(archive) !== historical.archiveSHA256)
    throw new Error("Historical artifact does not match the fixed Buildkite archive identity");
  const inputFolder = join(folder, "historical-input");
  mkdirSync(inputFolder, { recursive: true });
  const zip = join(inputFolder, "bun-linux-x64.zip");
  writeFileSync(zip, archive);
  const extracted = spawnSync("unzip", ["-q", zip, "bun-linux-x64/bun", "-d", inputFolder], { encoding: "utf8" });
  if (extracted.error || extracted.signal || extracted.status !== 0)
    throw extracted.error ?? new Error(`Historical artifact extraction failed: ${extracted.stderr}`);
  const baseline = join(inputFolder, "bun-linux-x64/bun");
  chmodSync(baseline, 0o755);
  const env = {
    ...process.env,
    BUN_FEATURE_FLAG_INTERNAL_FOR_TESTING: "1",
    BUN_GARBAGE_COLLECTOR_LEVEL: "0",
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
    BUN_OPTIONS: undefined,
    NODE_OPTIONS: undefined,
    BUN_BE_BUN: undefined,
  };
  const input = join(folder, "paired-hello.ts");
  writeFileSync(input, hello);
  const measurements: {
    label: string;
    trim: boolean;
    facts: Record<string, unknown>;
    executableSHA256: string;
    command: string[];
    fileSHA256: string;
    fileBytes: number;
    mappedBytes: number;
    execution: { stdout: string; stderr: string; exitCode: number };
  }[] = [];
  const summary = {
    complete: false,
    historical: { ...historical, url },
    candidate: {
      source: process.env.EXPECTED_NATIVE_SHA,
      runId: process.env.NATIVE_RUN_ID,
      artifactId: process.env.NATIVE_ARTIFACT_ID,
    },
    probeSource: process.env.GITHUB_SHA,
    inputSHA256: sha256(Buffer.from(hello)),
    limitations:
      "Source, engine, toolchain provisioning and ordering differ between builds. Historical ci-build uses preview WebKit and inherited ordering.",
    measurements,
  };
  const report = join(folder, "baseline-comparison.json");
  writeFileSync(report, JSON.stringify(summary, null, 2) + "\n");
  for (const [label, exe, source] of [
    ["historical", baseline, historical.source],
    ["candidate", executable, process.env.EXPECTED_NATIVE_SHA],
  ] as const) {
    const identity = spawnSync(
      exe,
      [
        "--no-env-file",
        "-e",
        `console.log(JSON.stringify({revision:Bun.revision,webkit:process.versions.webkit,version:Bun.version,platform:process.platform,arch:process.arch}))`,
      ],
      { encoding: "utf8", env },
    );
    if (identity.error || identity.signal || identity.status !== 0 || identity.stderr !== "")
      throw identity.error ?? new Error(`${label} identity probe failed: ${identity.stderr}`);
    const facts: Record<string, unknown> = JSON.parse(identity.stdout);
    if (
      facts.revision !== source ||
      facts.platform !== "linux" ||
      facts.arch !== "x64" ||
      typeof facts.webkit !== "string"
    )
      throw new Error(`${label} runtime does not match the admitted source and platform`);
    const executableSHA256 = sha256(readFileSync(exe));
    for (const trim of [false, true]) {
      const output = join(folder, `${label}-paired-hello${trim ? "-trim" : ""}`);
      const command = ["build", "--compile", "--aot", ...(trim ? ["--trim"] : []), input, "--outfile", output];
      const result = spawnSync(exe, command, { encoding: "utf8", env, timeout: 120_000, maxBuffer: 32 * 1024 * 1024 });
      writeFileSync(output + ".stdout.log", result.stdout ?? "");
      writeFileSync(output + ".stderr.log", result.stderr ?? "");
      if (result.error || result.signal || result.status !== 0)
        throw result.error ?? new Error(`${label} trim=${trim}: exit=${result.status}, signal=${result.signal}`);
      const ran = spawnSync(output, [], { encoding: "utf8", env, timeout: 30_000 });
      if (ran.error || ran.signal || ran.status !== 0 || ran.stdout !== "hello world\n" || ran.stderr !== "")
        throw ran.error ?? new Error(`${label} trim=${trim}: compiled hello did not execute correctly`);
      const file = readFileSync(output);
      measurements.push({
        label,
        trim,
        facts,
        executableSHA256,
        command: [exe, ...command],
        fileSHA256: sha256(file),
        fileBytes: file.length,
        mappedBytes: mappedBytesOf(file),
        execution: { stdout: ran.stdout, stderr: ran.stderr, exitCode: ran.status },
      });
      writeFileSync(report, JSON.stringify(summary, null, 2) + "\n");
    }
  }
  summary.complete = true;
  writeFileSync(report, JSON.stringify(summary, null, 2) + "\n");
  console.log(JSON.stringify(summary));
}
const cases = [
  { name: "hello", source: hello, trim: false, testing: true },
  { name: "hello-public", source: hello, trim: false, testing: false },
  { name: "hello-trim", source: hello, trim: true, testing: true },
  { name: "hello-trim-public", source: hello, trim: true, testing: false },
  {
    name: "text",
    source: `console.log(new Function("return " + process.argv[2])(), /a+/u.test("aa"), [3, 1, 2].toSorted().join());`,
    trim: true,
    testing: false,
  },
  {
    name: "bundles",
    source: `console.log(typeof Bun.build); if (process.argv.length > 5) await Bun.build({ entrypoints: [process.argv[5]] });`,
    trim: true,
    testing: false,
  },
];

const findings = [];
for (const probe of cases) {
  const input = join(folder, probe.name + ".ts");
  const output = join(folder, probe.name);
  writeFileSync(input, probe.source);
  const result = spawnSync(
    executable,
    [
      "build",
      "--compile",
      "--aot",
      ...(probe.trim ? ["--trim"] : []),
      input,
      "--outfile",
      output,
      "--explain=trim",
      `--aot-report=${output}.report.json`,
      "--aot-report-detail=sites",
      ...(["text", "bundles"].includes(probe.name) ? [`--aot-out=${output}.ir`] : []),
    ],
    {
      encoding: "utf8",
      timeout: 120_000,
      maxBuffer: 32 * 1024 * 1024,
      env: {
        ...process.env,
        BUN_FEATURE_FLAG_INTERNAL_FOR_TESTING: probe.testing ? "1" : undefined,
        BUN_GARBAGE_COLLECTOR_LEVEL: "0",
        BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
        BUN_JSC_logAOTPhaseTimes: "true",
        BUN_JSC_dumpAOTIR: "AnalyzeFlow",
      },
    },
  );
  writeFileSync(output + ".stdout.log", result.stdout ?? "");
  writeFileSync(output + ".stderr.log", result.stderr ?? "");
  if (result.error || result.signal || result.status !== 0)
    throw result.error ?? new Error(`${probe.name}: exit=${result.status}, signal=${result.signal}`);

  const file = readFileSync(output);
  const mappedBytes = mappedBytesOf(file);
  const fragments = ["-module-specifie", "-top-level-await", "module-specifier"].map(text => {
    const occurrences = [];
    let at = file.indexOf(text);
    while (at !== -1 && occurrences.length < 3) {
      occurrences.push({
        offset: at,
        context: file.subarray(Math.max(0, at - 40), at + text.length + 80).toString("utf8"),
      });
      at = file.indexOf(text, at + text.length);
    }
    return { text, occurrences };
  });
  findings.push({
    name: probe.name,
    trim: probe.trim,
    testing: probe.testing,
    fileBytes: file.length,
    mappedBytes,
    fragments,
  });
}
const summary = {
  nativeSource: process.env.EXPECTED_NATIVE_SHA,
  probeSource: process.env.GITHUB_SHA,
  findings,
};
writeFileSync(join(folder, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
console.log(JSON.stringify(summary));
if (process.argv.includes("--compare-upstream-135015")) await compareUpstream135015();
