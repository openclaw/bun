/** Replay the failed c4 shipping qualification and inspect its exact linked layout without rebuilding. */
import { spawnSync, type SpawnSyncOptions } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  createReadStream,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { findHolders, parseRetained } from "../build/trim/why.ts";
import { qualifyRuntime, targets, type TargetName } from "../openclaw-release/release.ts";

const producer = {
  run: 42311827376,
  commit: "c4ca435840cde345525407e1d260480dccc78467",
  webkit: "8c0ebbe34c570ae20ee14f433a62e83bb6ccf0c6",
};
const cases: Record<string, { target: TargetName; artifact: number; name: string; layout?: boolean }> = {
  "shipping-darwin-arm64": { target: "darwin-arm64", artifact: 13550938062, name: "signed-darwin-arm64" },
  "shipping-darwin-x64": { target: "darwin-x64", artifact: 13550623523, name: "signed-darwin-x64" },
  "shipping-windows-arm64": { target: "windows-arm64", artifact: 13550722605, name: "test-only-windows" },
  "shipping-layout-linux-x64": { target: "linux-x64", artifact: 13549904823, name: "build-linux-x64", layout: true },
};
const mode = process.env.DIAGNOSTIC ?? "";
const selected = cases[mode];
if (!selected) throw new Error("Unknown c4 shipping diagnostic");
const target = targets[selected.target];
const input = resolve("build/openclaw-ci/shipping-input");
const reports = resolve("build/openclaw-ci/shipping-diagnostics");
mkdirSync(reports, { recursive: true });
const receipt: Record<string, unknown> = { passed: false, mode, producer, probeSource: process.env.GITHUB_SHA };

function require(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function hash(path: string): Promise<string> {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest("hex");
}

function command(args: string[], options: Omit<SpawnSyncOptions, "encoding"> = {}) {
  const result = spawnSync(args[0]!, args.slice(1), { encoding: "utf8", maxBuffer: 1 << 20, ...options });
  require(!result.error &&
    !result.signal &&
    result.status === 0, `${args[0]} failed: ${result.stderr ?? result.error}`);
  return result.stdout ?? "";
}

function extract(zip: string, entry: string, path: string): void {
  const fd = openSync(path, "wx", 0o755);
  try {
    command(["unzip", "-p", zip, entry], { stdio: ["ignore", fd, "pipe"] });
  } finally {
    closeSync(fd);
  }
}

try {
  require(process.env.EXPECTED_NATIVE_SHA === producer.commit &&
    process.env.NATIVE_RUN_ID === String(producer.run), "Unexpected replay producer");
  require(process.env.NATIVE_ARTIFACT_ID === String(selected.artifact), "Unexpected replay artifact");
  const artifact = JSON.parse(readFileSync(join(input, "artifact.json"), "utf8"));
  const run = JSON.parse(readFileSync(join(input, "run.json"), "utf8"));
  require(artifact.id === selected.artifact &&
    artifact.name === selected.name &&
    !artifact.expired, "Artifact identity mismatch");
  require(artifact.workflow_run.id === producer.run && run.id === producer.run, "Artifact producer mismatch");
  // This counterfactual is deliberately pinned to the known tagless producer, not general cross-revision releases.
  require(run.repository.full_name === "openclaw/bun" &&
    run.head_repository.full_name === "openclaw/bun" &&
    run.path === ".github/workflows/openclaw-release.yml" &&
    run.event === "workflow_dispatch" &&
    run.head_sha === producer.commit &&
    artifact.workflow_run.head_sha === producer.commit, "Unexpected producer source");
  require(typeof artifact.digest === "string" &&
    /^sha256:[0-9a-f]{64}$/.test(artifact.digest), "Missing artifact digest");
  const archive = join(input, "artifact.zip");
  require(statSync(archive).size === artifact.size_in_bytes &&
    artifact.size_in_bytes <= 2 * 1024 ** 3, "Artifact size mismatch");
  const digest = await hash(archive);
  require(`sha256:${digest}` === artifact.digest, "Artifact digest mismatch");
  receipt.admission = {
    artifact: artifact.id,
    name: artifact.name,
    pipelineSource: run.head_sha,
    builtSource: producer.commit,
    sha256: digest,
  };
  const zip = join(input, "selected.zip");
  const triplet = target.triplet + (selected.layout ? "-profile" : "");
  extract(archive, `${triplet}.zip`, zip);
  if (selected.layout) {
    const files: Record<string, unknown> = {};
    for (const name of ["sections.txt", "retained.txt"]) {
      const path = join(reports, name);
      extract(zip, `${triplet}/${name}`, path);
      files[name] = { bytes: statSync(path).size, sha256: await hash(path) };
    }
    const holders = findHolders(
      parseRetained(readFileSync(join(reports, "retained.txt"), "utf8")),
      /node_compile_cache|NodeCompileCache/,
    );
    receipt.layout = {
      files,
      matchingRetainedBytes: holders.reduce((sum, holder) => sum + holder.bytes, 0),
      holders: holders.slice(0, 30),
      limitation:
        "Matching retained sections and their shortest root paths; not marginal growth or the complete outgoing closure. No candidate code executed.",
    };
  } else {
    const exe = join(input, target.exe);
    extract(zip, `${triplet}/${target.exe}`, exe);
    const executableSHA256 = await hash(exe);
    const identity = JSON.parse(
      command([
        exe,
        "--no-env-file",
        "-e",
        "console.log(JSON.stringify({revision:Bun.revision,webkit:process.versions.webkit,platform:process.platform,arch:process.arch}))",
      ]),
    );
    require(identity.revision === producer.commit &&
      identity.webkit === producer.webkit &&
      identity.platform === (target.os === "windows" ? "win32" : target.os) &&
      identity.arch === target.arch, "Executable identity mismatch");
    receipt.executable = { sha256: executableSHA256, ...identity };
    const source = resolve("native-source");
    let isolatedFailed = false;
    if (target.os === "windows" || selected.target === "darwin-x64") {
      const file = "test/js/bun/net/socket-retention.test.ts";
      const name = "TLS Duplex cycles collect after startup while a retained origin keeps its wrapper alive";
      const isolated = spawnSync(
        exe,
        ["test", file, "-t", name, "--reporter=junit", `--reporter-outfile=${join(reports, "isolated-retention.xml")}`],
        { cwd: source, encoding: "utf8", timeout: 120_000, maxBuffer: 1 << 20 },
      );
      writeFileSync(join(reports, "isolated-retention.log"), `${isolated.stdout ?? ""}${isolated.stderr ?? ""}`);
      isolatedFailed = !!isolated.error || !!isolated.signal || isolated.status !== 0;
      receipt.isolated = { exitCode: isolated.status, signal: isolated.signal, error: isolated.error?.message };
      if (isolatedFailed) {
        const original = readFileSync(join(source, file), "utf8");
        if (target.os === "darwin") {
          const section = original.slice(original.indexOf(`test("${name}"`));
          const template = /cmd: \[\s*bunExe\(\),\s*"-e",\s*`([\s\S]*?)`,\s*\]/.exec(section)?.[1];
          require(template, "Retention child template changed");
          const interpolation = "${JSON.stringify(tlsCert)}";
          require(template.split(interpolation).length === 2, "Retention certificate interpolation changed");
          const { tls, bunEnv } = await import(join(source, "test/harness.ts"));
          let child = template.replace(interpolation, JSON.stringify(tls));
          require(!child.includes("${"), "Unexpected retention child interpolation");
          const returned = "return { weak: new WeakRef(client._handle), origin: retain ? clientSide : null };";
          require(child.split(returned).length === 2, "Retention handle checkpoint changed");
          child = child.replace(
            returned,
            'return { weak: new WeakRef(client._handle), origin: retain ? clientSide : null, description: require("bun:jsc").jscDescribe(client._handle) };',
          );
          const checkpoint = "const droppedCollected = !dropped.weak.deref();";
          require(child.split(checkpoint).length === 2, "Retention collection checkpoint changed");
          child = child.replace(
            checkpoint,
            `${checkpoint}
          if (!droppedCollected) {
            const jsc = require("bun:jsc");
            const stats = jsc.heapStats();
            jsc.releaseWeakRefs();
            require("node:fs").writeFileSync(process.env.SOCKET_RETENTION_SNAPSHOT, JSON.stringify({
              pid: process.pid, revision: Bun.revision, stats,
              descriptions: { retained: retained.description, dropped: dropped.description },
              snapshot: jsc.generateHeapSnapshotForDebugging()
            }));
            process.kill(process.pid, "SIGSTOP");
          }`,
          );
          const childFile = join(reports, "retention-child.js");
          const commands = join(reports, "retention.lldb");
          writeFileSync(childFile, child);
          writeFileSync(
            commands,
            [
              "settings set target.disable-aslr false",
              `process launch --stop-at-entry --stdout ${JSON.stringify(join(reports, "inferior.stdout"))} --stderr ${JSON.stringify(join(reports, "inferior.stderr"))}`,
              "process handle SIGSTOP --stop true --notify true --pass false",
              `command script import ${JSON.stringify(resolve("scripts/openclaw-ci/retention_stack.py"))}`,
            ].join("\n") + "\n",
          );
          const traced = spawnSync("lldb", ["--batch", "--source", commands, "--", exe, "--no-env-file", childFile], {
            cwd: source,
            encoding: "utf8",
            timeout: 120_000,
            maxBuffer: 1 << 20,
            env: { ...bunEnv, SOCKET_RETENTION_SNAPSHOT: join(reports, "socket-first-checkpoint.json") },
          });
          writeFileSync(join(reports, "retention-debugger.log"), `${traced.stdout ?? ""}${traced.stderr ?? ""}`);
          receipt.debugger = { exitCode: traced.status, signal: traced.signal, error: traced.error?.message };
        } else {
          // Instrument a separate probe copy only. The admitted qualification checkout stays untouched.
          const needle = "const droppedCollected = !dropped.weak.deref();";
          require(original.split(needle).length === 2, "Retention checkpoint changed");
          const probe = resolve("test/js/bun/net/socket-retention-diagnostic.test.ts");
          const snapshot = join(reports, "socket-first-checkpoint.json");
          const injection = `${needle}
        if (!droppedCollected) {
          const jsc = require("bun:jsc");
          const stats = jsc.heapStats();
          jsc.releaseWeakRefs();
          require("node:fs").writeFileSync(process.env.SOCKET_RETENTION_SNAPSHOT, JSON.stringify({ stats, snapshot: jsc.generateHeapSnapshotForDebugging() }));
        }`;
          writeFileSync(probe, original.replace(needle, injection), { flag: "wx" });
          try {
            const traced = spawnSync(exe, ["test", probe, "-t", name], {
              encoding: "utf8",
              timeout: 120_000,
              maxBuffer: 1 << 20,
              env: { ...process.env, SOCKET_RETENTION_SNAPSHOT: snapshot },
            });
            writeFileSync(join(reports, "retention-trace.log"), `${traced.stdout ?? ""}${traced.stderr ?? ""}`);
            receipt.trace = {
              exitCode: traced.status,
              signal: traced.signal,
              error: traced.error?.message,
              limitation:
                "Separate instrumented observation after the first failed deref; kept WeakRef objects released before snapshot. Conservative stack roots still require debugger evidence.",
            };
          } finally {
            rmSync(probe);
          }
        }
      }
    }
    qualifyRuntime(exe, target, source, reports, producer.commit, producer.webkit, true);
    require(!isolatedFailed, "Isolated TLS retention assertion failed; diagnostics do not waive it");
    require((await hash(exe)) === executableSHA256, "Executable changed during replay");
    require(command(["git", "diff", "HEAD", "--name-only"], { cwd: source }).trim() ===
      "", "Qualification source changed");
  }
  receipt.passed = true;
} catch (error) {
  receipt.error = error instanceof Error ? error.message : String(error);
  throw error;
} finally {
  writeFileSync(join(reports, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
}
