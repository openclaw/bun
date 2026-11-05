import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const executable = resolve("build/release/bun");
const folder = resolve("build/openclaw-ci/trim-diagnostics");
mkdirSync(folder, { recursive: true });
const hello = `console.log("hello world");`;
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
  if (file.readUInt32BE(0) !== 0x7f454c46 || file[4] !== 2 || file[5] !== 1)
    throw new Error("Expected a little-endian ELF64 diagnostic executable");
  const headers = Number(file.readBigUInt64LE(0x20));
  const headerSize = file.readUInt16LE(0x36);
  let mappedBytes = 0;
  for (let index = 0; index < file.readUInt16LE(0x38); index++) {
    const at = headers + index * headerSize;
    if (file.readUInt32LE(at) === 1) mappedBytes += Number(file.readBigUInt64LE(at + 32));
  }
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
