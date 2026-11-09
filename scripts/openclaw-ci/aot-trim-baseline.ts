// A matched stock-source control for the retention floors, independent of the test runner.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { featureFiles, loadFeatures } from "../build/trim/features.ts";
import { readRemovedFeatures } from "../../test/aot/trimmed-against-whole/removed-features.ts";

const source = "2596ac5d391d47804c93a42bdbe615804aa62387";
const engine = "5a61071f79134bf41844e7ea31a8449147d85dd4";
const root = resolve(".");
const baseline = resolve("baseline");
const folder = resolve("build/openclaw-ci/aot-baseline");
mkdirSync(folder, { recursive: true });
const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const measurements: { label: string; entry: string; removed: string[]; [key: string]: unknown }[] = [];
const summary: Record<string, unknown> = {
  complete: false,
  probeSource: process.env.GITHUB_SHA,
  candidate: {
    source: process.env.EXPECTED_NATIVE_SHA,
    runId: process.env.NATIVE_RUN_ID,
    artifactId: process.env.NATIVE_ARTIFACT_ID,
  },
  measurements,
  limitations:
    "This compares stock Bun/WebKit with the fork pair; it does not isolate source from engine changes or qualify shipping ICU.",
};
const record = () => writeFileSync(join(folder, "comparison.json"), JSON.stringify(summary, null, 2) + "\n");
record();

function git(cwd: string, ...args: string[]): string {
  return checked("git", ["-C", cwd, ...args], cwd).stdout.trim();
}

// Use the harness's controlled compile environment without importing its suites or internal probes.
const env: NodeJS.ProcessEnv = {
  ...process.env,
  JSC_useJIT: undefined,
  NODE_OPTIONS: undefined,
  BUN_OPTIONS: undefined,
  BUN_BE_BUN: undefined,
  BUN_INSPECT_CONNECT_TO: undefined,
  NODE_ENV: undefined,
  FOLDER: undefined,
  BODY: undefined,
  GITHUB_ACTIONS: "false",
  BUN_DEBUG_QUIET_LOGS: "1",
  NO_COLOR: "1",
  FORCE_COLOR: undefined,
  TZ: "Etc/UTC",
  CI: "1",
  BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
  BUN_FEATURE_FLAG_INTERNAL_FOR_TESTING: "1",
  BUN_DISABLE_SLOW_FILESYSTEM_WARNING: "1",
  BUN_CONFIG_HTTP_RETRY_BACKOFF: "1",
  BUN_INTERNAL_INTERACTIVE_ASSUME_TTY: "1",
  BUN_GARBAGE_COLLECTOR_LEVEL: "0",
  BUN_FEATURE_FLAG_EXPERIMENTAL_BAKE: "1",
  WANTS_LOUD: "0",
  AGENT: "false",
};
for (const key of Object.keys(env)) {
  if (
    (key.startsWith("BUN_DEBUG_") && key !== "BUN_DEBUG_QUIET_LOGS") ||
    key.startsWith("BUN_JSC_") ||
    key.startsWith("BUILDKITE") ||
    key === "NODE" ||
    key.startsWith("npm_") ||
    key.startsWith("NPM_CONFIG_")
  )
    delete env[key];
}

function checked(exe: string, args: string[], cwd: string, output?: string, execution = false) {
  const result = spawnSync(exe, args, {
    cwd,
    env: execution ? { ...env, FOLDER: join(folder, "inputs") } : env,
    encoding: "utf8",
    timeout: execution ? 30_000 : 120_000,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (output) {
    writeFileSync(output + ".stdout.log", result.stdout ?? "");
    writeFileSync(output + ".stderr.log", result.stderr ?? "");
    writeFileSync(
      output + ".status.json",
      JSON.stringify({ exitCode: result.status, signal: result.signal, error: result.error?.message }) + "\n",
    );
  }
  if (result.error || result.signal || result.status !== 0)
    throw result.error ?? new Error(`${exe}: exit=${result.status}, signal=${result.signal}`);
  return result;
}

assert.equal(git(baseline, "rev-parse", "HEAD"), source);
assert.equal(git(baseline, "rev-parse", "HEAD^{tree}"), "7c4f4e8ab1a9b71cf31824847daa45050f255bc9");
assert.equal(git(baseline, "status", "--porcelain", "--untracked-files=no"), "");
assert.deepEqual(readFileSync(join(root, "bun.lock")), readFileSync(join(baseline, "bun.lock")));
for (const file of featureFiles)
  assert.deepEqual(
    readFileSync(join(root, "src/trim/features", file)),
    readFileSync(join(baseline, "src/trim/features", file)),
  );

const inputs = join(folder, "inputs");
mkdirSync(join(inputs, "node_modules/@types"), { recursive: true });
const types = join(baseline, "packages/bun-types");
symlinkSync(types, join(inputs, "node_modules/@types/bun"));
const requireTypes = createRequire(join(types, "package.json"));
const nodeTypes = dirname(requireTypes.resolve("@types/node/package.json"));
const undiciTypes = dirname(requireTypes.resolve("undici-types/package.json"));
assert.equal(
  createRequire(join(nodeTypes, "package.json")).resolve("undici-types/package.json"),
  join(undiciTypes, "package.json"),
);
symlinkSync(nodeTypes, join(inputs, "node_modules/@types/node"));
symlinkSync(undiciTypes, join(inputs, "node_modules/undici-types"));

function hashTree(path: string): string {
  const hash = createHash("sha256");
  function visit(relative: string) {
    for (const entry of readdirSync(join(path, relative), { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      const name = join(relative, entry.name);
      if (entry.isDirectory()) visit(name);
      else
        hash
          .update(name + "\0")
          .update(readFileSync(join(path, name)))
          .update("\0");
    }
  }
  visit("");
  return hash.digest("hex");
}

summary.types = {
  bun: { tree: git(baseline, "rev-parse", "HEAD:packages/bun-types"), sha256: hashTree(types) },
  node: {
    version: JSON.parse(readFileSync(join(nodeTypes, "package.json"), "utf8")).version,
    sha256: hashTree(nodeTypes),
  },
  undici: {
    version: JSON.parse(readFileSync(join(undiciTypes, "package.json"), "utf8")).version,
    sha256: hashTree(undiciTypes),
  },
  lockSHA256: sha256(readFileSync(join(baseline, "bun.lock"))),
};
const fixtureOwner = "test/bundler/compile-trim-by-use.test.ts";
function fixture(cwd: string, name: string): string {
  const text = readFileSync(join(cwd, fixtureOwner), "utf8");
  const prefix = `  "${name}": \``;
  assert.equal(text.split(prefix).length, 2, `ambiguous fixture ${name}`);
  const value = text.split(prefix)[1]!.split("`", 1)[0]!;
  assert(!value.includes("\\") && !value.includes("${"), `nonliteral fixture ${name}`);
  return value;
}
const fixtures = ["serves.ts", "serves-values-nobody-knows.ts", "bundled.ts"];
for (const name of fixtures) {
  const value = fixture(root, name);
  assert.equal(value, fixture(baseline, name));
  writeFileSync(join(inputs, name), value);
}
assert.equal(
  sha256(readFileSync(join(inputs, fixtures[0]!))),
  "2e388c8f38798b4f9f6766265790e808d3c18341119206a9e7b40151d9716fbb",
);
assert.equal(
  sha256(readFileSync(join(inputs, fixtures[1]!))),
  "5ceb3977ed6a6b51b8f271e62d8ccd84a79e5efdcd2daaed993962d98f5c003f",
);
writeFileSync(join(inputs, "tsconfig.json"), `{ "compilerOptions": { "types": ["bun"] } }`);
summary.inputs = Object.fromEntries(
  [...fixtures, "tsconfig.json"].map(name => [name, sha256(readFileSync(join(inputs, name)))]),
);
summary.upstream = {
  source,
  tree: git(baseline, "rev-parse", "HEAD^{tree}"),
  engine,
  engineTree: git(resolve("baseline-webkit"), "rev-parse", "HEAD^{tree}"),
};
summary.upstreamBuild = JSON.parse(readFileSync(join(folder, "upstream-build.json"), "utf8"));
const build = join(baseline, "build/release");
const order = readFileSync(join(build, "linker.order"), "utf8");
assert.equal(order.split("\n").filter(line => line.trim() && !line.trimStart().startsWith("#")).length, 0);
summary.orderingSHA256 = sha256(order);
summary.toolIdentities = Object.fromEntries(
  readdirSync(join(build, "toolchain-identity"))
    .sort()
    .map(name => [name, readFileSync(join(build, "toolchain-identity", name), "utf8")]),
);
summary.buildManifestSHA256 = sha256(readFileSync(join(build, "build.ninja")));
record();

for (const [label, checkout, exe, revision, webkit] of [
  ["upstream", baseline, join(build, "bun"), source, engine],
  [
    "candidate",
    root,
    resolve("build/release/bun"),
    process.env.EXPECTED_NATIVE_SHA,
    "651eeaca6e2792378928033b1ae7ac66d6f91eab",
  ],
] as const) {
  const identity = checked(
    exe,
    [
      "--no-env-file",
      "-e",
      "console.log(JSON.stringify({revision:Bun.revision,webkit:process.versions.webkit,platform:process.platform,arch:process.arch}))",
    ],
    inputs,
  );
  assert.equal(identity.stderr, "");
  const facts = JSON.parse(identity.stdout);
  assert.deepEqual(facts, { revision, webkit, platform: "linux", arch: "x64" });
  const model = loadFeatures(checkout);
  assert.equal(model.features.length, 267);
  for (const entry of fixtures.slice(0, 2)) {
    const output = join(folder, `${label}-${entry.replace(/\.ts$/, "")}`);
    const command = ["build", "--compile", "--aot", "--trim", "--explain=trim", entry, "--outfile", output];
    checked(exe, command, inputs, output + ".compile");
    const removedIndexes = readRemovedFeatures(output);
    assert(removedIndexes, "missing ELF feature bitmap");
    const removed = model.features
      .filter(feature => removedIndexes.includes(feature.index))
      .map(feature => feature.name);
    const kept = model.features.filter(feature => !removedIndexes.includes(feature.index)).map(feature => feature.name);
    const result = checked(output, [], inputs, output + ".execution", true);
    measurements.push({
      label,
      entry,
      facts,
      command: [exe, ...command],
      executableSHA256: sha256(readFileSync(exe)),
      outputSHA256: sha256(readFileSync(output)),
      removedIndexes,
      removed,
      kept,
      execution: { stdout: result.stdout, stderr: result.stderr, exitCode: result.status },
    });
    record();
    assert.equal(result.stderr, "");
    assert.equal(
      result.stdout,
      entry === "serves.ts"
        ? `served\na\nb\n${readFileSync(join(inputs, "bundled.ts"), "utf8")}\n`
        : "1 2     6,8 object\n",
    );
  }
}
summary.complete = true;
record();
console.log(measurements.map(({ label, entry, removed }) => ({ label, entry, removed: removed.length })));
