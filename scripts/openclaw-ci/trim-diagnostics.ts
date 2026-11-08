import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

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

type Span = { start: number; end: number; offset: number };
function elfSpans(file: Buffer, allocations = false): Span[] {
  mappedBytesOf(file); // Validate the ELF format before reading its tables.
  const table = Number(file.readBigUInt64LE(allocations ? 0x28 : 0x20));
  const stride = file.readUInt16LE(allocations ? 0x3a : 0x36);
  const count = file.readUInt16LE(allocations ? 0x3c : 0x38);
  const spans: Span[] = [];
  for (let index = 0; index < count; index++) {
    const at = table + index * stride;
    if (allocations) {
      if (file.readUInt32LE(at + 4) === 8 || !(file.readBigUInt64LE(at + 8) & 2n)) continue;
    } else if (file.readUInt32LE(at) !== 1) continue;
    const start = Number(file.readBigUInt64LE(at + 16));
    const size = Number(file.readBigUInt64LE(at + 32));
    const offset = Number(file.readBigUInt64LE(at + (allocations ? 24 : 8)));
    if (!Number.isSafeInteger(start + size) || offset + size > file.length)
      throw new Error("Invalid file-backed ELF span");
    if (size) spans.push({ start, end: start + size, offset });
  }
  spans.sort((a, b) => a.start - b.start);
  for (let index = 1; index < spans.length; index++) {
    if (spans[index]!.start < spans[index - 1]!.end) throw new Error("Overlapping ELF spans");
  }
  return spans;
}

// ELF cutting preserves virtual addresses, while file offsets and symbol sizes can become stale.
async function attributePlainLayout(): Promise<void> {
  const { readTrimTable } = await import("bun:internal-for-testing");
  const nativeTable = readTrimTable(executable);
  const native = readFileSync(executable);
  const plain = readFileSync(join(folder, "hello"));
  const loads = elfSpans(plain);
  const originalLoads = elfSpans(native);
  const allocations = elfSpans(native, true);
  const input = resolve("build/openclaw-ci/layout-input");
  const records = ["sections.txt", "retained.txt"]
    .flatMap(file =>
      readFileSync(join(input, file), "utf8")
        .trim()
        .split("\n")
        .map(line => {
          const fields = line.split(" ");
          const retained = file === "retained.txt";
          const start = Number.parseInt(fields[retained ? 2 : 0]!, 16);
          const size = Number(fields[retained ? 3 : 1]);
          const name = fields.slice(retained ? 5 : 4).join(" ") || "<unnamed>";
          if (!Number.isSafeInteger(start) || !Number.isSafeInteger(size) || size < 0)
            throw new Error("Invalid native layout record");
          return { start, end: start + size, names: [name], mapped: 0, unchanged: 0 };
        })
        .filter(record => record.end > record.start),
    )
    .sort((a, b) => a.start - b.start || a.end - b.end || a.names[0]!.localeCompare(b.names[0]!));
  const groups: typeof records = [];
  for (const record of records) {
    const previous = groups.at(-1);
    if (previous && record.start < previous.end) {
      previous.end = Math.max(previous.end, record.end);
      previous.names.push(...record.names);
    } else groups.push(record);
  }
  const boundaries = [
    ...new Set([...loads, ...originalLoads, ...allocations, ...groups].flatMap(span => [span.start, span.end])),
  ].sort((a, b) => a - b);
  const buckets = { namedNative: 0, changedNative: 0, headersOrAlignment: 0, unmatchedNative: 0, newMappedStorage: 0 };
  let loadIndex = 0,
    originalIndex = 0,
    allocationIndex = 0,
    groupIndex = 0;
  for (let index = 0; index + 1 < boundaries.length; index++) {
    const start = boundaries[index]!,
      end = boundaries[index + 1]!,
      size = end - start;
    while (loadIndex < loads.length && loads[loadIndex]!.end <= start) loadIndex++;
    const load = loads[loadIndex];
    if (!load || load.start > start) continue;
    while (originalIndex < originalLoads.length && originalLoads[originalIndex]!.end <= start) originalIndex++;
    const original = originalLoads[originalIndex];
    if (!original || original.start > start) {
      buckets.newMappedStorage += size;
      continue;
    }
    while (allocationIndex < allocations.length && allocations[allocationIndex]!.end <= start) allocationIndex++;
    const allocation = allocations[allocationIndex];
    if (!allocation || allocation.start > start) {
      buckets.headersOrAlignment += size;
      continue;
    }
    while (groupIndex < groups.length && groups[groupIndex]!.end <= start) groupIndex++;
    const group = groups[groupIndex];
    const named = group && group.start <= start;
    const actual = load.offset + start - load.start,
      expected = original.offset + start - original.start;
    let unchanged = 0;
    for (let byte = 0; byte < size; byte++) if (plain[actual + byte] === native[expected + byte]) unchanged++;
    buckets.changedNative += size - unchanged;
    if (named) {
      group.mapped += size;
      group.unchanged += unchanged;
      buckets.namedNative += unchanged;
    } else buckets.unmatchedNative += unchanged;
  }
  const mappedBytes = mappedBytesOf(plain);
  if (Object.values(buckets).reduce((sum, bytes) => sum + bytes, 0) !== mappedBytes)
    throw new Error("Mapped-byte accounting mismatch");
  const ran = spawnSync(join(folder, "hello"), [], { encoding: "utf8", timeout: 30_000 });
  if (ran.error || ran.signal || ran.status !== 0 || ran.stdout !== "hello world\n" || ran.stderr !== "")
    throw new Error("Attributed hello did not execute");
  const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
  const report = {
    nativeSource: process.env.EXPECTED_NATIVE_SHA,
    probeSource: process.env.GITHUB_SHA,
    webkit: process.versions.webkit,
    version: Bun.version,
    platform: process.platform,
    arch: process.arch,
    nativeRun: process.env.NATIVE_RUN_ID,
    nativeArtifact: process.env.NATIVE_ARTIFACT_ID,
    layoutArtifact: 13584172708,
    layoutSHA256: "3242e8e21cc65c6aea2d7a60c925b3b434bf58df23fe20b0ebf48733fada8fe5",
    featuresHash: nativeTable.featuresHash.toString(),
    compilerSHA256: digest(native),
    executableSHA256: digest(plain),
    inputSHA256: digest(Buffer.from(hello)),
    mappedBytes,
    buckets,
    owners: groups
      .filter(group => group.mapped)
      .sort((a, b) => b.mapped - a.mapped)
      .slice(0, 100)
      .map(({ names, ...group }) => ({
        ...group,
        names: [...new Set(names)].slice(0, 8),
        nameCount: new Set(names).size,
      })),
    limitations:
      "Actual mapped native VA ownership, not marginal fork growth. Overlapping section names share one interval. Changed native bytes include fills and fixups; new mapped storage includes AOT payload, padding and newly file-backed bytes. Reports list primary symbols, not complete source/object ownership or every ICF alias.",
  };
  writeFileSync(join(folder, "plain-layout.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ mappedBytes, buckets, owners: report.owners.slice(0, 15) }));
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
  compareHelloBinaries(baseline, historical.source, "baseline-comparison.json", {
    historical: { ...historical, url },
    limitations:
      "Source, engine, toolchain provisioning and ordering differ between builds. Historical ci-build uses preview WebKit and inherited ordering.",
  });
}

function compareHelloBinaries(
  baseline: string,
  baselineSource: string,
  reportName: string,
  context: Record<string, unknown>,
  sameEngine = false,
): void {
  const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
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
    fileBackedSegments?: Span[];
    nativeFileBackedSegments?: Span[];
    nativeAllocatedSections?: Span[];
    aotReport?: { file: string; bytes: number; sha256: string };
    execution: { stdout: string; stderr: string; exitCode: number };
  }[] = [];
  const summary = {
    complete: false,
    ...context,
    candidate: {
      source: process.env.EXPECTED_NATIVE_SHA,
      runId: process.env.NATIVE_RUN_ID,
      artifactId: process.env.NATIVE_ARTIFACT_ID,
    },
    probeSource: process.env.GITHUB_SHA,
    inputSHA256: sha256(Buffer.from(hello)),
    measurements,
  };
  const report = join(folder, reportName);
  writeFileSync(report, JSON.stringify(summary, null, 2) + "\n");
  for (const [label, exe, source] of [
    [reportName === "baseline-comparison.json" ? "historical" : "upstream", baseline, baselineSource],
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
      typeof facts.webkit !== "string" ||
      (label === "upstream" &&
        facts.webkit !==
          (sameEngine ? "8c0ebbe34c570ae20ee14f433a62e83bb6ccf0c6" : "4d45755fed4aeef19e95beb90d3d0c884a2812bd")) ||
      (sameEngine && label === "candidate" && facts.webkit !== "8c0ebbe34c570ae20ee14f433a62e83bb6ccf0c6")
    )
      throw new Error(`${label} runtime does not match the admitted source and platform`);
    const native = readFileSync(exe);
    const executableSHA256 = sha256(native);
    for (const trim of [false, true]) {
      const output = join(folder, `${label}-paired-hello${trim ? "-trim" : ""}`);
      const reportPath = sameEngine ? output + ".report.json" : undefined;
      const command = [
        "build",
        "--compile",
        "--aot",
        ...(trim ? ["--trim"] : []),
        ...(reportPath ? [`--aot-report=${reportPath}`, "--aot-report-detail=sites"] : []),
        input,
        "--outfile",
        output,
      ];
      const result = spawnSync(exe, command, { encoding: "utf8", env, timeout: 120_000, maxBuffer: 32 * 1024 * 1024 });
      writeFileSync(output + ".stdout.log", result.stdout ?? "");
      writeFileSync(output + ".stderr.log", result.stderr ?? "");
      if (result.error || result.signal || result.status !== 0)
        throw result.error ?? new Error(`${label} trim=${trim}: exit=${result.status}, signal=${result.signal}`);
      const ran = spawnSync(output, [], { encoding: "utf8", env, timeout: 30_000 });
      writeFileSync(
        output + ".execution.json",
        JSON.stringify({
          stdout: ran.stdout,
          stderr: ran.stderr,
          exitCode: ran.status,
          signal: ran.signal,
          error: ran.error?.message,
        }) + "\n",
      );
      if (ran.error || ran.signal || ran.status !== 0 || ran.stdout !== "hello world\n" || ran.stderr !== "")
        throw ran.error ?? new Error(`${label} trim=${trim}: compiled hello did not execute correctly`);
      const file = readFileSync(output);
      const reportBytes = reportPath ? readFileSync(reportPath) : undefined;
      if (reportBytes) JSON.parse(reportBytes.toString("utf8"));
      measurements.push({
        label,
        trim,
        facts,
        executableSHA256,
        command: [exe, ...command],
        fileSHA256: sha256(file),
        fileBytes: file.length,
        mappedBytes: mappedBytesOf(file),
        // Match each compiled image against its own native map; VAs differ across builds.
        fileBackedSegments: sameEngine ? elfSpans(file) : undefined,
        nativeFileBackedSegments: sameEngine ? elfSpans(native) : undefined,
        nativeAllocatedSections: sameEngine ? elfSpans(native, true) : undefined,
        aotReport:
          reportPath && reportBytes
            ? { file: basename(reportPath), bytes: reportBytes.length, sha256: sha256(reportBytes) }
            : undefined,
        execution: { stdout: ran.stdout, stderr: ran.stderr, exitCode: ran.status },
      });
      writeFileSync(report, JSON.stringify(summary, null, 2) + "\n");
    }
  }
  summary.complete = true;
  writeFileSync(report, JSON.stringify(summary, null, 2) + "\n");
  console.log(JSON.stringify(summary));
}
function compareBuiltUpstream(sameEngine = false): void {
  const source = "3f3a9ff87cdccf3d32d7ec6b648c664eddaae840";
  const upstream = resolve("baseline");
  const git = (args: string[]) => {
    const result = spawnSync("git", ["-C", upstream, ...args], { encoding: "utf8" });
    if (result.error || result.status !== 0 || result.signal) throw new Error("Upstream source inspection failed");
    return result.stdout.trim();
  };
  if (git(["rev-parse", "HEAD"]) !== source) throw new Error("Expected the frozen upstream checkout");
  const routingPath = "scripts/build/deps/webkit.ts";
  const namespacePath = "src/jsc/bindings/ZigGlobalObject.cpp";
  const expectedStatus = sameEngine ? [`M ${routingPath}`, `M ${namespacePath}`] : [];
  const actualStatus = git(["status", "--porcelain", "--untracked-files=no"])
    .split("\n")
    .map(line => line.trim())
    .filter(Boolean);
  if (JSON.stringify(actualStatus) !== JSON.stringify(expectedStatus))
    throw new Error("Unexpected upstream tracked changes");
  const routing = sameEngine ? JSON.parse(readFileSync(join(folder, "upstream-routing.json"), "utf8")) : null;
  const engineInput = sameEngine ? JSON.parse(readFileSync(join(folder, "upstream-engine-input.json"), "utf8")) : null;
  const namespaceAdapter = sameEngine
    ? JSON.parse(readFileSync(join(folder, "upstream-namespace-adapter.json"), "utf8"))
    : null;
  if (sameEngine) {
    const original = git(["show", `HEAD:${routingPath}`]) + "\n";
    const routed = readFileSync(join(upstream, routingPath), "utf8");
    const from = "https://github.com/oven-sh/WebKit/releases/download/";
    const to = "https://github.com/openclaw/WebKit/releases/download/";
    const hash = (text: string) => createHash("sha256").update(text).digest("hex");
    if (
      original.split(from).length !== 2 ||
      routed !== original.replace(from, to) ||
      routing.path !== routingPath ||
      routing.from !== from ||
      routing.to !== to ||
      routing.originalSHA256 !== hash(original) ||
      routing.routedSHA256 !== hash(routed)
    )
      throw new Error("Expected exactly the recorded prebuilt WebKit download routing change");
    const originalNamespace = git(["show", `HEAD:${namespacePath}`]) + "\n";
    const adaptedNamespace = readFileSync(join(upstream, namespacePath), "utf8");
    if (
      namespaceAdapter.path !== namespacePath ||
      namespaceAdapter.originalSHA256 !== "453771c5670c499c056b24004cb1b395b7c58f393bf78287cc9ee152c9851758" ||
      namespaceAdapter.adaptedSHA256 !== "cb4e4d9254c83d238eaa0e513a00dae19ed02193d67f32e714cde389be695b9f" ||
      hash(originalNamespace) !== namespaceAdapter.originalSHA256 ||
      hash(adaptedNamespace) !== namespaceAdapter.adaptedSHA256 ||
      namespaceAdapter.removedLines !== 36 ||
      namespaceAdapter.diff !== git(["diff", "--", namespacePath]) + "\n"
    )
      throw new Error("Expected exactly the recorded compile-only namespace ABI adapter");
  }
  const build = join(upstream, "build/release");
  const order = readFileSync(join(build, "linker.order"), "utf8");
  const entries = order.split("\n").filter(line => line.trim() && !line.trimStart().startsWith("#")).length;
  if (entries !== 0) throw new Error("Upstream baseline unexpectedly inherited linker ordering");
  const toolIdentities = Object.fromEntries(
    readdirSync(join(build, "toolchain-identity")).map(name => [
      name,
      readFileSync(join(build, "toolchain-identity", name), "utf8"),
    ]),
  );
  compareHelloBinaries(
    join(build, "bun"),
    source,
    sameEngine ? "upstream-same-engine-comparison.json" : "upstream-build-comparison.json",
    {
      upstream: {
        source,
        routing,
        engineInput,
        namespaceAdapter,
        tree: git(["rev-parse", "HEAD^{tree}"]),
        build: JSON.parse(readFileSync(join(folder, "upstream-build.json"), "utf8")),
        toolIdentities,
        nativeLayout: sameEngine
          ? ["sections.txt", "retained.txt"].map(name => {
              const file = "upstream-" + name;
              const data = readFileSync(join(folder, file));
              return { file, bytes: data.length, sha256: createHash("sha256").update(data).digest("hex") };
            })
          : undefined,
        ordering: { entries, sha256: createHash("sha256").update(order).digest("hex") },
        manifestSHA256: createHash("sha256")
          .update(readFileSync(join(build, "build.ninja")))
          .digest("hex"),
      },
      limitations: sameEngine
        ? "ABI-adapted upstream hello comparison: matched manifest-verified WebKitS archive, hosted toolchain, release LTO, trim flags and empty ordering. Upstream uses its supported engine override, one recorded prebuilt-download routing substitution and a hash-pinned 36-line removal of obsolete namespace-marker accessors/initializer. The build display label differs. This is not unchanged upstream, module-semantic or source qualification, individual-fix savings, or a repaired size gate."
        : "Matched hosted toolchain, release LTO, trim flags and empty ordering. The upstream-to-fork difference still combines Bun source and WebKit changes.",
    },
    sameEngine,
  );
}

if (
  process.argv.includes("--compare-built-upstream") ||
  process.argv.includes("--compare-built-upstream-same-engine")
) {
  compareBuiltUpstream(process.argv.includes("--compare-built-upstream-same-engine"));
  process.exit(0);
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
if (process.argv.includes("--attribute-layout")) await attributePlainLayout();
if (process.argv.includes("--compare-upstream-135015")) await compareUpstream135015();
