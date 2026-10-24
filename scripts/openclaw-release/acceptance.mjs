import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { releaseAcceptance } from "./acceptance-policy.mjs";

export const nativeRegressions = [
  "test/js/web/workers/structured-clone.test.ts",
  "test/js/web/structured-clone-shared-array-buffer.test.ts",
  "test/js/node/v8/v8-serdes-buffer.test.ts",
];
export const hookSuite = "src/plugins/hooks.before-tool-call.test.ts";
export const sha256 = file => createHash("sha256").update(readFileSync(file)).digest("hex");

export function inside(root, file) {
  const canonicalRoot = realpathSync(root);
  const part = relative(canonicalRoot, realpathSync(file));
  if (part === ".." || part.startsWith(".." + sep) || resolve(canonicalRoot, part) !== realpathSync(file))
    throw new Error("Private path escapes acceptance root");
  return realpathSync(file);
}

export async function archiveEntrySha256(archive, entry, env) {
  const hash = createHash("sha256");
  const child = spawn("unzip", ["-p", archive, entry], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stdout.on("data", chunk => hash.update(chunk));
  child.stderr.on("data", chunk => {
    stderr = (stderr + chunk).slice(-8192);
  });
  return await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (code !== 0 || signal) reject(new Error("Final archive extraction failed: " + stderr));
      else resolve(hash.digest("hex"));
    });
  });
}

export function checked(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: 1_200_000,
    maxBuffer: 32 * 1024 * 1024,
    ...options,
  });
  if (result.error || result.signal || result.status !== 0)
    throw new Error(
      "Command failed: " +
        command +
        " " +
        args.join(" ") +
        "\n" +
        (result.error ?? result.signal ?? result.status) +
        "\n" +
        (result.stderr ?? ""),
    );
  return result.stdout.trim();
}

export function sourceIdentity(root, commit) {
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error("Acceptance requires a full source commit");
  const git = (...args) => checked("git", ["-C", root, ...args]);
  if (git("rev-parse", "HEAD") !== commit || git("status", "--porcelain", "--untracked-files=no"))
    throw new Error("Acceptance source must be clean at the exact commit");
  return { commit, tree: git("rev-parse", "HEAD^{tree}") };
}

export function assertRuntime(facts, target, commit, webkit) {
  const [os, arch] = target.split("-");
  if (!/^(darwin|linux|windows)-(x64|arm64)$/.test(target))
    throw new Error("Unsupported native acceptance target: " + target);
  if (
    facts.platform !== (os === "windows" ? "win32" : os) ||
    facts.arch !== arch ||
    facts.revision !== commit ||
    facts.webkit !== webkit
  )
    throw new Error("Final executable identity does not match source/target/WebKit");
}

export function testCounts(log, kind) {
  const plain = log.replace(/\x1b\[[0-9;]*m/g, "");
  const passed = kind === "bun" ? /(?:^|\n)\s*(\d+) pass\b/m.exec(plain) : /Tests\s+(\d+) passed\b/.exec(plain);
  const failed = kind === "bun" ? /(?:^|\n)\s*(\d+) fail\b/m.exec(plain) : /Tests[^\n]*?(\d+) failed\b/.exec(plain);
  const skipped = kind === "bun" ? /(?:^|\n)\s*(\d+) skip\b/m.exec(plain) : /Tests[^\n]*?(\d+) skipped\b/.exec(plain);
  if (!passed || Number(passed[1]) === 0 || Number(failed?.[1] ?? 0) !== 0)
    throw new Error("Missing or failed test inventory");
  return {
    passed: Number(passed[1]),
    failed: Number(failed?.[1] ?? 0),
    skipped: Number(skipped?.[1] ?? 0),
  };
}

export function candidatePin(original, revision, target, archive, executable, tag, commit) {
  const pin = structuredClone(original);
  if (!pin.artifacts?.[target] || !/^\d+\.\d+\.\d+[^\s]*\+[a-f0-9]{7,40}$/.test(revision))
    throw new Error("Missing candidate pin target or revision");
  const suffix = revision.split("+").at(-1);
  if (!/^[a-f0-9]{40}$/.test(commit) || !commit.startsWith(suffix))
    throw new Error("Proposed pin commit does not match runtime revision");
  pin.commit = commit;
  pin.revision = revision;
  if (tag) pin.tag = tag;
  pin.artifacts[target] = {
    ...pin.artifacts[target],
    sha256: sha256(archive),
    executableSha256: sha256(executable),
  };
  return pin;
}

export function capture(label, command, args, cwd, env, out) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    timeout: 1_200_000,
    maxBuffer: 32 * 1024 * 1024,
  });
  const log = (result.stdout ?? "") + "\n" + (result.stderr ?? "");
  const path = join(out, label + ".log");
  writeFileSync(path, log, { flag: "wx" });
  const record = {
    label,
    command,
    args,
    cwd,
    exit: result.status,
    signal: result.signal,
    error: result.error?.message,
    log: path,
    logSha256: sha256(path),
  };
  writeFileSync(join(out, label + ".json"), JSON.stringify(record, null, 2) + "\n", { flag: "wx" });
  if (result.error || result.signal || result.status !== 0) throw new Error(label + " failed; see " + path);
  return { ...record, output: log };
}

export function privateEnvironment(out, consumer) {
  const env = {};
  // No credentials or caller preload are forwarded to test/dependency processes.
  for (const key of ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "ComSpec", "COMSPEC", "PATHEXT", "LANG", "LC_ALL"])
    if (process.env[key]) env[key] = process.env[key];
  for (const [key, name] of Object.entries({
    HOME: "home",
    USERPROFILE: "home",
    TMPDIR: "tmp",
    TEMP: "tmp",
    TMP: "tmp",
    OPENCLAW_STATE_DIR: "state",
    XDG_CACHE_HOME: "cache",
  })) {
    mkdirSync(join(out, name), { recursive: true, mode: 0o700 });
    env[key] = inside(out, join(out, name));
  }
  env.OPENCLAW_CONFIG_PATH = join(out, "config.json");
  writeFileSync(env.OPENCLAW_CONFIG_PATH, "{}\n", { flag: "wx", mode: 0o600 });
  mkdirSync(join(out, "preflights"), { mode: 0o700 });
  return {
    ...env,
    CI: "true",
    NO_COLOR: "1",
    FORCE_COLOR: "0",
    GIT_OPTIONAL_LOCKS: "0",
    COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
    LAND175276_ROOT: out,
    LAND175276_CONSUMER: consumer,
    OPENCLAW_VITEST_FS_MODULE_CACHE_PATH: join(out, "vitest-cache.json"),
  };
}

export function installPreloads(out, source) {
  const base = join(dirname(fileURLToPath(import.meta.url)), "private-preflight.mjs");
  const bun = join(out, "bun-harness-preload.mjs");
  const keys = [
    "LAND175276_ROOT",
    "LAND175276_CONSUMER",
    "HOME",
    "USERPROFILE",
    "TMPDIR",
    "TEMP",
    "TMP",
    "OPENCLAW_STATE_DIR",
    "OPENCLAW_CONFIG_PATH",
    "NODE_OPTIONS",
    "BUN_OPTIONS",
  ];
  writeFileSync(
    bun,
    "import " +
      JSON.stringify(pathToFileURL(base).href) +
      ";\nconst {bunEnv}=await import(" +
      JSON.stringify(pathToFileURL(join(source, "test/harness.ts")).href) +
      ");\nfor(const key of " +
      JSON.stringify(keys) +
      ") bunEnv[key]=process.env[key];\n",
  );
  return { base, bun };
}

export function runNativeSuites(runtime, source, out, env, preload) {
  return nativeRegressions.map((suite, index) => {
    const run = capture("native-" + (index + 1), runtime, ["test", "--preload", preload, suite], source, env, out);
    const { output, ...record } = run;
    return { ...record, suite, ...testCounts(output, "bun") };
  });
}

export function corepackArgs(args) {
  return [
    join(
      dirname(process.execPath),
      process.platform === "win32"
        ? "node_modules/corepack/dist/corepack.js"
        : "../lib/node_modules/corepack/dist/corepack.js",
    ),
    "pnpm",
    ...args,
  ];
}

export function bootstrapConsumer(consumer, env, out) {
  return capture(
    "consumer-dependencies",
    process.execPath,
    corepackArgs(["install", "--frozen-lockfile", "--ignore-scripts"]),
    consumer,
    env,
    out,
  );
}

export function runConsumerHooks(runtime, consumer, archive, target, tag, commit, env, out) {
  const pinFile = join(consumer, "scripts/lib/openclaw-bun.json");
  const original = readFileSync(pinFile);
  const proposed = candidatePin(
    JSON.parse(original),
    checked(runtime, ["--revision"], { env }),
    target,
    archive,
    runtime,
    tag,
    commit,
  );
  const pin = {
    originalSha256: createHash("sha256").update(original).digest("hex"),
    proposed,
    scope: "disposable acceptance checkout only; not an admitted shared pin",
  };
  try {
    writeFileSync(pinFile, JSON.stringify(proposed, null, 2) + "\n");
    pin.sha256 = sha256(pinFile);
    const run = capture(
      "openclaw-hooks",
      process.execPath,
      corepackArgs(["test", hookSuite, "--maxWorkers=1"]),
      consumer,
      { ...env, OPENCLAW_VITEST_RUNTIME: "bun", OPENCLAW_BUN_PATH: runtime },
      out,
    );
    const counts = testCounts(run.output, "vitest");
    if (counts.passed !== 24 || counts.skipped) throw new Error("Expected the unchanged complete 24-hook inventory");
    const { output, ...record } = run;
    return {
      candidatePin: pin,
      result: { ...record, suite: hookSuite, ...counts },
    };
  } finally {
    writeFileSync(pinFile, original);
    if (sha256(pinFile) !== pin.originalSha256) throw new Error("Disposable proposed pin was not restored");
  }
}

export async function main(args = process.argv.slice(2)) {
  if (!/^v24\./.test(process.version)) throw new Error("Acceptance requires the Node 24 control runtime");
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!args[i]?.startsWith("--") || !args[i + 1] || options[args[i].slice(2)])
      throw new Error("Invalid acceptance arguments");
    options[args[i].slice(2)] = args[i + 1];
  }
  for (const key of [
    "source",
    "consumer",
    "runtime",
    "archive",
    "target",
    "commit",
    "consumer-commit",
    "webkit",
    "tag",
    "out",
  ])
    if (!options[key]) throw new Error("Missing --" + key);
  const source = realpathSync(options.source),
    consumer = realpathSync(options.consumer);
  const runtime = realpathSync(options.runtime),
    archive = realpathSync(options.archive),
    out = resolve(options.out);
  const sources = {
    bun: sourceIdentity(source, options.commit),
    openclaw: sourceIdentity(consumer, options["consumer-commit"]),
  };
  const acceptance = releaseAcceptance(source, options.commit, options["consumer-commit"]);
  const pipeline = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
  const hashes = {
    preflight: sha256(join(dirname(fileURLToPath(import.meta.url)), "private-preflight.mjs")),
    archive: sha256(archive),
    executable: sha256(runtime),
    harness: sha256(fileURLToPath(import.meta.url)),
  };
  mkdirSync(out, { mode: 0o700 });
  const env = privateEnvironment(out, consumer);
  const report = {
    status: "incomplete",
    target: options.target,
    tag: options.tag,
    sources,
    acceptance,
    hashes,
    pipeline: checked("git", ["-C", pipeline, "rev-parse", "HEAD"]),
    node: {
      version: process.version,
      executable: process.execPath,
      sha256: sha256(process.execPath),
    },
    run: {
      id: process.env.GITHUB_RUN_ID,
      attempt: process.env.GITHUB_RUN_ATTEMPT,
      job: process.env.GITHUB_JOB,
      runner: process.env.RUNNER_NAME,
    },
    results: [],
  };
  const pinFile = join(consumer, "scripts/lib/openclaw-bun.json"),
    originalPin = readFileSync(pinFile);
  try {
    if (!/^(darwin|linux|windows)-(x64|arm64)$/.test(options.target)) throw new Error("Unsupported acceptance target");
    const [os, arch] = options.target.split("-");
    const entry =
      "bun-" + os + "-" + (arch === "arm64" ? "aarch64" : arch) + "/" + (os === "windows" ? "bun.exe" : "bun");
    report.archiveEntry = {
      path: entry,
      sha256: await archiveEntrySha256(archive, entry, env),
    };
    if (report.archiveEntry.sha256 !== hashes.executable)
      throw new Error("Runtime is not the final archive executable");
    // Bootstrap never executes package lifecycle scripts or an OpenClaw runtime.
    bootstrapConsumer(consumer, env, out);
    const { base, bun } = installPreloads(out, source);
    env.NODE_OPTIONS = "--import=" + pathToFileURL(base).href;
    env.BUN_OPTIONS = "--preload=" + pathToFileURL(base).href;
    const facts = JSON.parse(
      checked(
        runtime,
        [
          "-e",
          "console.log(JSON.stringify({revision:Bun.revision,version:Bun.version,webkit:process.versions.webkit,platform:process.platform,arch:process.arch}))",
        ],
        { env },
      ),
    );
    assertRuntime(facts, options.target, options.commit, options.webkit);
    report.runtime = facts;
    report.inputs = {};
    for (const [name, root, files] of [
      [
        "bun",
        source,
        [...nativeRegressions, "bun.lock", "test/bun.lock", "test/harness.ts", "test/preload.ts", "bunfig.toml"],
      ],
      [
        "openclaw",
        consumer,
        [
          hookSuite,
          "pnpm-lock.yaml",
          "package.json",
          "scripts/lib/pinned-bun.mts",
          "scripts/lib/test-runtime.mts",
          "src/infra/update-managed-service-handoff-lease.ts",
        ],
      ],
    ])
      for (const file of files) report.inputs[name + "/" + file] = sha256(join(root, file));
    report.results = runNativeSuites(runtime, source, out, env, bun);
    const hooks = runConsumerHooks(runtime, consumer, archive, options.target, options.tag, options.commit, env, out);
    report.candidatePin = hooks.candidatePin;
    report.results.push(hooks.result);
    if (hashes.archive !== sha256(archive) || hashes.executable !== sha256(runtime))
      throw new Error("Final artifact changed during acceptance");
    report.status = report.results.some(result => result.skipped)
      ? "passed-with-recorded-skips-not-full-case-coverage"
      : "passed";
  } catch (error) {
    report.error = error.message;
    throw error;
  } finally {
    report.pinRestored = sha256(pinFile) === createHash("sha256").update(originalPin).digest("hex");
    report.hashesAfter = {
      archive: sha256(archive),
      executable: sha256(runtime),
    };
    try {
      report.sourcesAfter = {
        bun: sourceIdentity(source, options.commit),
        openclaw: sourceIdentity(consumer, options["consumer-commit"]),
      };
    } catch (error) {
      report.status = "incomplete";
      report.sourceError = error.message;
    }
    writeFileSync(join(out, "acceptance.json"), JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
    if (report.sourceError) throw new Error(report.sourceError);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
