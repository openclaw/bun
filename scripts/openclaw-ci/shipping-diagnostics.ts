/** Diagnose immutable shipping artifacts without rebuilding them. */
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

const mode = process.env.DIAGNOSTIC ?? "";
const pendingWrite = mode === "shipping-pending-write-darwin-x64";
const producer = pendingWrite
  ? {
      run: 42397790517,
      commit: "037399efe520ddbacd6aa75b61ed7a52b95c7664",
      webkit: "8c0ebbe34c570ae20ee14f433a62e83bb6ccf0c6",
    }
  : {
      run: 42311827376,
      commit: "c4ca435840cde345525407e1d260480dccc78467",
      webkit: "8c0ebbe34c570ae20ee14f433a62e83bb6ccf0c6",
    };
const cases: Record<string, { target: TargetName; artifact: number; name: string; layout?: boolean }> = {
  "shipping-pending-write-darwin-x64": { target: "darwin-x64", artifact: 13585357191, name: "signed-darwin-x64" },
  "shipping-darwin-arm64": { target: "darwin-arm64", artifact: 13550938062, name: "signed-darwin-arm64" },
  "shipping-darwin-x64": { target: "darwin-x64", artifact: 13550623523, name: "signed-darwin-x64" },
  "shipping-windows-arm64": { target: "windows-arm64", artifact: 13550722605, name: "test-only-windows" },
  "shipping-layout-linux-x64": { target: "linux-x64", artifact: 13549904823, name: "build-linux-x64", layout: true },
};
const selected = cases[mode];
if (!selected) throw new Error("Unknown shipping diagnostic");
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

function probePendingWrite(exe: string, source: string): void {
  const file = "test/js/node/tls/node-tls-duplex-end-verify.test.ts";
  const original = readFileSync(join(source, file), "utf8");
  const start = original.indexOf("// The pre-upgrade plain TCP queue");
  const end = original.indexOf('test("native nested TLS pauses', start);
  require(start >= 0 && end > start, "Pending-write fixture boundaries changed");
  let section = original.slice(start, end);
  const replace = (before: string, after: string) => {
    require(section.split(before).length === 2, "Pending-write checkpoint changed");
    section = section.replace(before, after);
  };
  replace(
    "      const accepted = Promise.withResolvers<net.Socket>();",
    [
      "      const started = performance.now();",
      '      const state = { received: 0, callbacks: 0, tlsCallbacks: 0, phase: "setup" };',
      "      const phase = (name: string) => {",
      "        state.phase = name;",
      "      };",
      "      const flush = () => {",
      "        if (!pendingWriteSnapshots.delete(flush)) return;",
      '        console.error(JSON.stringify({ diagnostic: "pending-plain-write", side, ...state, ms: performance.now() - started }));',
      "      };",
      "      pendingWriteSnapshots.add(flush);",
      "      t.after(flush);",
      "      const accepted = Promise.withResolvers<net.Socket>();",
    ].join("\n"),
  );
  replace(
    '      await new Promise<void>(resolve => listener.listen(0, "127.0.0.1", resolve));',
    '      await new Promise<void>(resolve => listener.listen(0, "127.0.0.1", resolve));\n      phase("listener-ready");',
  );
  replace(
    '      const [rawServer] = await Promise.all([accepted.promise, once(rawClient, "connect")]);',
    '      const [rawServer] = await Promise.all([accepted.promise, once(rawClient, "connect")]);\n      phase("raw-connected");',
  );
  replace(
    "      const preamble = Buffer.alloc(64 * 1024 * 1024, 0x61);",
    '      phase("connected");\n      const preamble = Buffer.alloc(64 * 1024 * 1024, 0x61);',
  );
  replace(
    "        callbacks++;",
    '        callbacks++;\n        state.callbacks = callbacks;\n        phase("plain-callback");',
  );
  replace(
    "      // Consume only the known plaintext prefix.",
    '      phase("first-attached");\n\n      // Consume only the known plaintext prefix.',
  );
  replace("        received += chunk.length;", "        received += chunk.length;\n        state.received = received;");
  replace("      const second =", '      phase("prefix-complete");\n      const second =');
  replace(
    '      await guard(Promise.all([once(client, "secureConnect"), once(server, "secure"), written.promise]));',
    [
      '      phase("peer-attached");',
      '      await guard(Promise.all([once(client, "secureConnect"), once(server, "secure"), written.promise]));',
      '      phase("handshake-complete");',
    ].join("\n"),
  );
  require(section.split("tlsCallbacks++;").length === 3, "TLS callback checkpoints changed");
  section = section.replaceAll("tlsCallbacks++;", "tlsCallbacks++;\n        state.tlsCallbacks = tlsCallbacks;");
  replace(
    "      assert.strictEqual(received, preamble.length);",
    '      phase("finished");\n      assert.strictEqual(received, preamble.length);',
  );
  const probeFile = "test/js/node/tls/node-tls-duplex-pending-write-diagnostic.test.ts";
  const probe = join(source, probeFile);
  const hook = [
    "const pendingWriteSnapshots = new Set<() => void>();",
    "if (isBun) {",
    '  require("bun:test").afterEach(() => {',
    "    for (const flush of pendingWriteSnapshots) flush();",
    "  });",
    "}",
    "",
  ].join("\n");
  const instrumented = original.slice(0, start) + hook + section + original.slice(end);
  const release = readFileSync(join(source, "scripts/openclaw-release/release.ts"), "utf8");
  const listedFile = JSON.stringify(file);
  require(release.split(listedFile).length === 2, "Shipping TLS qualification entry changed");
  const instrumentedRelease = release.replace(listedFile, JSON.stringify(probeFile));
  const controller = join(source, "scripts/openclaw-release/release-pending-write-diagnostic.ts");
  const run = (name: string, args: string[]) => {
    const result = spawnSync(args[0]!, args.slice(1), {
      cwd: source,
      encoding: "utf8",
      timeout: name === "quiet-instrumented-smoke-context" ? 20 * 60_000 : 90_000,
      maxBuffer: 1 << 20,
    });
    writeFileSync(join(reports, name + ".log"), (result.stdout ?? "") + (result.stderr ?? ""));
    return { name, exitCode: result.status, signal: result.signal, error: result.error?.message };
  };
  const results = [];
  writeFileSync(probe, instrumented, { flag: "wx" });
  try {
    writeFileSync(controller, instrumentedRelease, { flag: "wx" });
    try {
      results.push(
        run("quiet-instrumented-smoke-context", [
          exe,
          controller,
          "smoke",
          "--zip",
          join(input, "selected.zip"),
          "--target",
          selected.target,
          "--commit",
          producer.commit,
          "--webkit",
          producer.webkit,
          "--source",
          source,
          "--out",
          join(reports, "qualification-context"),
          "--qualify-tls",
        ]),
      );
    } finally {
      rmSync(controller);
    }
    results.push(
      run("original-full-file", [
        exe,
        "test",
        file,
        "--reporter=junit",
        "--reporter-outfile=" + join(reports, "original-full-file.xml"),
      ]),
    );
    results.push(run("node-full-file", ["node", "--test", probe]));
  } finally {
    rmSync(probe);
  }
  receipt.pendingWrite = {
    sourceSHA256: createHash("sha256").update(original).digest("hex"),
    instrumentedSHA256: createHash("sha256").update(instrumented).digest("hex"),
    releaseSHA256: createHash("sha256").update(release).digest("hex"),
    instrumentedReleaseSHA256: createHash("sha256").update(instrumentedRelease).digest("hex"),
    payloadBytes: 64 * 1024 * 1024,
    scope:
      "Copied frozen smoke controller changes only its TLS list entry to the quiet probe; JIT, compiled runtime, clone suites and retention run first in canonical order. Untouched original file runs second, Node last. Only test cleanup or the native Bun afterEach hook prints phase state.",
    results,
    limitation:
      "Diagnostic phases can change timing. Original Bun timeout, payload and assertions are unchanged; this is not a repaired shipping gate.",
  };
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
    if (pendingWrite) probePendingWrite(exe, source);
    let isolatedFailed = false;
    if (!pendingWrite && (target.os === "windows" || selected.target === "darwin-x64")) {
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

          const loop = "for (let i = 0; i < 30; i++) { await turn(); Bun.gc(true); }";
          require(template.split(loop).length === 3, "Retention collection loops changed");
          // Change only the first existing checkpoint; the second loop and assertion stay unchanged.
          const variant = template
            .replace(interpolation, JSON.stringify(tls))
            .replace(
              loop,
              "for (let i = 0; i < 30; i++) { await new Promise(resolve => setImmediate(() => { Bun.gc(true); resolve(); })); }",
            );
          const compared = spawnSync(exe, ["--no-env-file", "-e", variant], {
            cwd: source,
            encoding: "utf8",
            timeout: 120_000,
            maxBuffer: 1 << 20,
            env: bunEnv,
          });
          writeFileSync(join(reports, "retention-gc-boundary.log"), `${compared.stdout ?? ""}${compared.stderr ?? ""}`);
          receipt.gcBoundaryVariant = {
            exitCode: compared.status,
            signal: compared.signal,
            error: compared.error?.message,
            passed:
              !compared.error &&
              !compared.signal &&
              compared.status === 0 &&
              compared.stderr === "" &&
              compared.stdout.trim() === '{"retainedAlive":true,"droppedCollected":true,"releasedCollected":true}',
            limitation: "Same admitted binary; separate fixture variant, not a passing original qualification gate.",
          };
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
        const fixture = readFileSync(file);
        const probe = join(source, "test/js/bun/net/socket-retention-source-probe.test.ts");
        writeFileSync(probe, fixture, { flag: "wx" });
        try {
          const gate = spawnSync(
            exe,
            ["test", probe, "--reporter=junit", `--reporter-outfile=${join(reports, "changed-retention.xml")}`],
            { cwd: source, encoding: "utf8", timeout: 120_000, maxBuffer: 1 << 20 },
          );
          writeFileSync(join(reports, "changed-retention.log"), `${gate.stdout ?? ""}${gate.stderr ?? ""}`);
          receipt.changedFixtureGate = {
            source: process.env.GITHUB_SHA,
            sha256: createHash("sha256").update(fixture).digest("hex"),
            exitCode: gate.status,
            signal: gate.signal,
            error: gate.error?.message,
            passed: !gate.error && !gate.signal && gate.status === 0,
            limitation:
              "Current fixture bytes replayed on the admitted older executable, not source-head qualification.",
          };
        } finally {
          rmSync(probe);
        }
      }
    }
    if (!pendingWrite) qualifyRuntime(exe, target, source, reports, producer.commit, producer.webkit, true);
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
