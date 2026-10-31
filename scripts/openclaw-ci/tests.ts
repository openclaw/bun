import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, statfsSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, resolve } from "node:path";

// In 50 trials, the baseline fails about 1% versus 66–88% for the regression.
const OWNER_EXIT_ASSERTION_FAILURE_THRESHOLD = 5;

export function ownerExitStressFailed(trials: { exitCode: number | null; signal: string | null; error?: string }[]) {
  return (
    trials.some(trial => (trial.exitCode !== 0 && trial.exitCode !== 1) || trial.signal || trial.error) ||
    trials.filter(trial => trial.exitCode === 1).length >= OWNER_EXIT_ASSERTION_FAILURE_THRESHOLD
  );
}

export const forkRegressions = ["test/bundler/transpiler/runtime-transpiler.test.ts", "test/js/node/fs/dir.test.ts"];

export const smoke = [
  ...forkRegressions,
  "test/js/node/child_process/child-process-exec.test.ts",
  "test/js/node/child_process/child-process-stdio.test.js",
  "test/js/node/net/node-net-server.test.ts",
  "test/js/node/net/node-net-allowHalfOpen.test.js",
  "test/js/node/tls/node-tls-server.test.ts",
  "test/js/node/http/node-http-server-close-drain.test.ts",
  "test/js/node/http/node-http-server-abort-events.test.ts",
  "test/js/node/fs/fs.test.ts",
  "test/js/node/worker_threads/worker_threads.test.ts",
  "test/js/node/module/node-module-module.test.js",
  "test/js/bun/sqlite/sqlite.test.js",
  "test/cli/run/run-process-env.test.ts",
  "test/bundler/compile-node-compile-cache.test.ts",
];

export const broader = [
  "test/js/node/child_process/child_process.test.ts",
  "test/js/node/child_process/child_process_ipc.test.js",
  "test/js/node/net/node-net.test.ts",
  "test/js/node/tls/node-tls-connect.test.ts",
  "test/js/node/tls/node-tls-wrapped-socket-close.test.ts",
  "test/js/node/http/node-http.test.ts",
  "test/js/node/http/node-http-server-socket-end-drain.test.ts",
  "test/js/node/fs/promises.test.js",
  "test/js/node/worker_threads/worker-transfer-list.test.ts",
  "test/js/node/module/require-extensions.test.ts",
  "test/js/node/process/process.test.js",
  "test/js/bun/sqlite/column-types.test.js",
];

export const darwinSmoke = [
  ...forkRegressions,
  "test/js/node/watch/fs.watch.test.ts",
  "test/js/node/watch/fs.watch.close-exit.test.ts",
  "test/js/node/watch/fs.watch.events-cb-race.test.ts",
  "test/js/node/watch/fs.watch.rewrite.test.ts",
  "test/js/node/process/process.test.js",
  "test/js/node/process/process-signal-listener-count.test.ts",
  "test/js/node/child_process/child_process.test.ts",
  "test/js/node/child_process/child-process-exec.test.ts",
  "test/js/node/child_process/child-process-stdio.test.js",
];

// The same Windows compatibility selection runs on x64 and ARM64.
export const windowsSmoke = [
  ...smoke,
  ...broader,
  "test/js/node/worker_threads/15787.test.ts",
  "test/js/node/worker_threads/worker-async-dispose.test.ts",
  "test/js/node/worker_threads/worker-shutdown-post-leak.test.ts",
  "test/js/node/worker_threads/worker-top-level-await.test.ts",
  "test/js/node/worker_threads/worker-track-unmanaged-fds.test.ts",
  "test/js/node/worker_threads/worker-transfer-terminate-stress.test.ts",
  "test/js/node/worker_threads/worker_destruction.test.ts",
  "test/js/node/worker_threads/worker_heap_snapshot_gc.test.ts",
  "test/js/bun/plugin/plugin-resolved-key.test.ts",
  "test/js/bun/plugin/plugins.test.ts",
  "test/js/bun/resolve/import-meta-resolve.test.mjs",
  "test/js/bun/resolve/import-meta.test.js",
  "test/js/node/worker_threads/terminate-in-a-message-listener-of-a-worker-that-ends-by-itself.test.ts",
  "test/js/node/worker_threads/what-a-worker-wrote-before-it-exits-is-read.test.ts",
  "test/js/node/worker_threads/worker-stdout-own-functions.test.ts",
];

const webkitSensitive = [
  "test/js/node/async_hooks/AsyncLocalStorage.test.ts",
  "test/js/node/worker_threads/worker_threads.test.ts",
  "test/js/bun/jsc/webkit-upgrade-7b485a76e9.test.ts",
  "test/js/bun/jsc/webkit-upgrade-9b02218df6.test.ts",
  "test/js/bun/jsc/webkit-upgrade-3722912f.test.ts",
  "test/js/bun/jsc/webkit-upgrade-6b879687ee.test.ts",
  "test/js/bun/jsc/webkit-upgrade-ccdcb8a026.test.ts",
  "test/js/bun/jsc/webkit-upgrade-8c4fd56347.test.ts",
  "test/js/bun/jsc/webkit-upgrade-df289ce551.test.ts",
  "test/js/bun/jsc/bun-jsc.test.ts",
  "test/js/web/intl/intl.test.ts",
  "test/js/node/vm/vm.test.ts",
  "test/js/node/vm/vm-sourceUrl.test.ts",
  "test/js/node/vm/script-leak.test.ts",
  "test/js/node/vm/vm-script-fetcher-leak.test.ts",
  "test/js/node/vm/sourcetextmodule-leak.test.ts",
  "test/js/node/vm/sourcetextmodule-link-gc.test.ts",
  "test/js/node/module/register-hooks-builtin-urls.test.ts",
  "test/js/node/module/register-hooks-virtual-urls.test.ts",
  "test/js/bun/plugin/plugin-resolved-key.test.ts",
  "test/js/bun/plugin/plugins.test.ts",
  "test/js/node/module/node-module-module.test.js",
];

const sourcePositionSensitive = [
  "test/js/bun/jsc/webkit-upgrade-7b485a76e9.test.ts",
  "test/js/node/vm/vm-sourceUrl.test.ts",
];

// Runtime implementations span JS, Rust and C++; keep their shared boundaries explicit.
const sourceSuites: [RegExp, string[]][] = [
  [/child_process|subprocess|spawn/i, ["child_process"]],
  [/socket|\/net[/.]|\/tls[/.]|TLS|SSL/i, ["net", "tls", "http"]],
  [/\/http|HTTP|Fetch/i, ["http", "net", "tls"]],
  [/\/fs[/.]|node_?fs|FileSystem/i, ["fs"]],
  [/worker|Environment|process/i, ["worker_threads", "process"]],
  [/module|Module|resolver|transpil|compile.cache/i, ["module"]],
  [/sqlite/i, ["sqlite"]],
];

export function isTest(path: string): boolean {
  return path.startsWith("test/") && /(?:\.test|\.spec)\.[cm]?[jt]sx?$/.test(path);
}

export function selectTests(changed: string[], tracked: string[], nightly: boolean, platform = "linux"): string[] {
  if (platform !== "linux" && platform !== "darwin" && platform !== "windows")
    throw new Error(`Unsupported CI platform: ${platform}`);
  const available = new Set(tracked);
  const selected = new Set([
    ...(platform === "windows" ? windowsSmoke : platform === "darwin" ? darwinSmoke : smoke),
    ...(nightly ? broader : []),
  ]);
  const tests = tracked.filter(isTest);
  for (const path of changed) {
    if (path === "scripts/build/deps/webkit.ts" || path === "scripts/build/deps/webkit-artifacts.json") {
      [...smoke, ...broader, ...webkitSensitive].forEach(test => selected.add(test));
    } else if (isTest(path)) {
      if (available.has(path)) selected.add(path);
    } else if (path.startsWith("test/")) {
      // A fixture can live one directory below its owning tests.
      for (let dir = dirname(path); dir !== "." && dir !== "test"; dir = dirname(dir)) {
        const adjacent = tests.filter(test => dirname(test) === dir);
        if (adjacent.length) {
          adjacent.forEach(test => selected.add(test));
          break;
        }
      }
    } else if (path.startsWith("src/")) {
      if (
        /^src\/jsc\/bindings\/(?:CallSite\w*|ErrorStack\w*|FormatStackTraceForJS|ZigSourceProvider)\.(?:cpp|h)$/.test(
          path,
        )
      ) {
        sourcePositionSensitive.forEach(test => selected.add(test));
      }
      for (const [pattern, suites] of sourceSuites) {
        if (!pattern.test(path)) continue;
        for (const test of [...smoke, ...broader]) {
          if (suites.some(suite => test.includes(`/${suite}/`))) selected.add(test);
        }
      }
      const module = /^src\/(?:js|runtime)\/node\/([^/.]+)/.exec(path)?.[1];
      if (module) tests.filter(test => test.startsWith(`test/js/node/${module}/`)).forEach(test => selected.add(test));
    }
  }
  for (const test of selected) {
    if (!available.has(test)) throw new Error(`Selected test is missing: ${test}; update the fixed coverage lists`);
  }
  return [...selected].sort();
}

function git(...args: string[]): string[] {
  const result = spawnSync("git", args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args[0]} failed`);
  return result.stdout.split("\0").filter(Boolean);
}

function upstreamParents(base: string, head: string): string[] {
  const merges = git("rev-list", "--first-parent", "--merges", "--parents", `${base}..${head}`);
  const parents = new Set<string>();
  // rev-list visits the newest first-parent merge first, independent of commit timestamps.
  for (const merge of (merges[0] ?? "").trim().split("\n").filter(Boolean)) {
    for (const parent of merge.split(" ").slice(2)) {
      const result = spawnSync("git", ["merge-base", "--is-ancestor", parent, base], { encoding: "utf8" });
      if (result.status === 1) parents.add(parent);
      else if (result.status !== 0) throw new Error(result.stderr || "git merge-base failed");
    }
  }
  return [...parents];
}

function summary(text: string) {
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, text);
  console.log(text);
}

function reportDiskUsage(stage: "before" | "after") {
  if (process.platform === "win32") return;
  const filesystem = statfsSync(".");
  const directories: Record<string, number | null> = {};
  const paths: [string, string | undefined][] = [
    ["git", ".git"],
    ["build", "build/release"],
    ["buildCache", process.env.BUN_BUILD_CACHE_DIR ?? ".cache/openclaw-build"],
    ["dependencies", "node_modules"],
    ["testDependencies", "test/node_modules"],
    ["cargo", `${homedir()}/.cargo`],
    ["rustup", `${homedir()}/.rustup`],
    ["runnerTemp", process.env.RUNNER_TEMP],
    ["crashReports", process.platform === "linux" ? "/var/crash" : undefined],
    ["systemCores", process.platform === "linux" ? "/var/lib/systemd/coredump" : undefined],
  ];
  for (const [name, path] of paths) {
    if (!path || !existsSync(path)) continue;
    const usage = spawnSync("du", ["-sk", resolve(path)], {
      encoding: "utf8",
      timeout: 5_000,
      killSignal: "SIGKILL",
    });
    const kibibytes = Number.parseInt(usage.stdout, 10);
    directories[name] = usage.status === 0 && Number.isFinite(kibibytes) ? kibibytes * 1024 : null;
  }
  let coreDump: { piped: boolean; handler: string; limits: string | null } | undefined;
  if (process.platform === "linux") {
    try {
      const pattern = readFileSync("/proc/sys/kernel/core_pattern", "utf8").trim();
      const piped = pattern.startsWith("|");
      coreDump = {
        piped,
        handler: basename(piped ? pattern.slice(1).split(/\s+/)[0]! : pattern),
        limits:
          readFileSync("/proc/self/limits", "utf8")
            .split("\n")
            .find(line => line.startsWith("Max core file size"))
            ?.replace(/\s+/g, " ") ?? null,
      };
    } catch (error) {
      console.warn("Could not inspect Linux core-dump settings", error);
    }
  }
  const snapshot = {
    stage,
    availableBytes: filesystem.bavail * filesystem.bsize,
    availableInodes: filesystem.ffree,
    coreDump,
    directories,
  };
  // Runner ENOSPC can lose the log blob; annotations preserve the last completed disk snapshot.
  console.log(`::notice title=Native test disk usage::${JSON.stringify(snapshot)}`);
  try {
    writeFileSync(`build/openclaw-ci/disk-${stage}-tests.json`, JSON.stringify(snapshot, null, 2) + "\n");
  } catch (error) {
    console.warn("Could not write disk snapshot artifact", error);
  }
}

export function assertSelectedTestResults(
  selected: readonly string[],
  results: readonly { testPath: string; ok: boolean }[],
  platform: string = process.platform,
): void {
  // The runner reports native paths; selections come from Git with forward slashes.
  const passed = new Set(
    results
      .filter(result => result.ok)
      .map(result => (platform === "win32" ? result.testPath.replaceAll("\\", "/") : result.testPath)),
  );
  for (const test of selected) {
    if (!passed.has(test)) throw new Error(`Selected test did not pass (or was skipped by expectations): ${test}`);
  }
}

if (import.meta.main) {
  const command = process.argv[2];
  const selectionPath = "build/openclaw-ci/selected.json";
  const resultsPath = "build/openclaw-ci/results.json";
  if (command === "select-windows") {
    const selected = selectTests([], git("ls-files", "-z", "test"), false, "windows");
    mkdirSync(dirname(selectionPath), { recursive: true });
    writeFileSync(selectionPath, JSON.stringify(selected, null, 2) + "\n");
    summary(`Windows compatibility selection: ${selected.length} files\n`);
  } else if (command === "select") {
    const base = process.env.PR_BASE_SHA;
    const head = process.env.PR_HEAD_SHA;
    if (process.env.GITHUB_EVENT_NAME === "pull_request" && (!base || !head)) throw new Error("Missing PR commits");
    const changed =
      base && head ? git("diff", "--no-renames", "--name-only", "--diff-filter=ACMTD", "-z", `${base}...${head}`) : [];
    const parents = base && head ? upstreamParents(base, head) : [];
    const upstream = parents[0];
    const differentFromUpstream = upstream
      ? new Set(git("diff", "--no-renames", "--name-only", "-z", upstream, head!))
      : undefined;
    const forkDelta = differentFromUpstream ? changed.filter(path => differentFromUpstream.has(path)) : changed;
    const selected = selectTests(
      forkDelta,
      git("ls-files", "-z", "test"),
      !base || !!upstream,
      process.env.OPENCLAW_CI_PLATFORM,
    );
    mkdirSync(dirname(selectionPath), { recursive: true });
    writeFileSync(selectionPath, JSON.stringify(selected, null, 2) + "\n");
    summary(
      `## Test selection\n\nUpstream parents (newest first): ${parents.length ? parents.map(parent => `\`${parent}\``).join(", ") : "none"}.\n` +
        `Changed files: ${changed.length}. Fork-delta files: ${forkDelta.length}. Selected tests: ${selected.length}.\n\n`,
    );
    summary(`## Selected tests (${selected.length})\n\n${selected.map(test => `- \`${test}\``).join("\n")}\n`);
  } else if (command === "test") {
    const selected: string[] = JSON.parse(readFileSync(selectionPath, "utf8"));
    if (!selected.length) throw new Error("Refusing an empty test selection");
    reportDiskUsage("before");
    // Fresh processes preserve the original owner's GC sequence and expose late frees.
    let ownerExitFailed = false;
    if (process.platform === "win32" && process.arch === "arm64") {
      const trials = Array.from({ length: 50 }, (_, index) => {
        const trial = spawnSync(
          process.execPath,
          ["--expose-gc", "test/js/node/process/arraybuffer-accounting.fixture.mjs", "owner-exit"],
          { encoding: "utf8", timeout: 30_000 },
        );
        return {
          trial: index + 1,
          exitCode: trial.status,
          signal: trial.signal,
          error: trial.error?.message,
          stdout: trial.stdout,
          stderr: trial.stderr,
        };
      });
      const failures = trials.filter(trial => trial.exitCode !== 0 || trial.signal || trial.error).length;
      ownerExitFailed = ownerExitStressFailed(trials);
      writeFileSync(
        "build/openclaw-ci/owner-exit-stress.json",
        JSON.stringify(
          { revision: Bun.revision, platform: process.platform, arch: process.arch, failures, trials },
          null,
          2,
        ) + "\n",
      );
      console.log(`Owner-exit: ${failures}/50 failed`);
    }
    // CI invokes this script with the built executable; the upstream runner uses it for every test.
    const result = spawnSync(
      "node",
      [
        "scripts/runner.node.ts",
        "--exec-path",
        process.execPath,
        "--vendor=false",
        "--retries=0",
        "--results-json",
        resultsPath,
        ...selected.flatMap(test => ["--include", test.replace(/^test\//, "")]),
      ],
      { stdio: "inherit" },
    );
    const netTest = "test/js/node/net/node-net.test.ts";
    let direct: SpawnSyncReturns<string> | undefined;
    if (selected.includes(netTest)) {
      console.log("Running the selected net suite directly once, outside the grouped runner");
      direct = spawnSync(process.execPath, ["test", netTest], { encoding: "utf8" });
      writeFileSync(
        "build/openclaw-ci/net-direct.json",
        JSON.stringify(
          {
            testPath: netTest,
            revision: Bun.revision,
            webkit: process.versions.webkit,
            platform: process.platform,
            arch: process.arch,
            exitCode: direct.status,
            signalCode: direct.signal,
            error: direct.error?.message,
            stdout: direct.stdout,
            stderr: direct.stderr,
          },
          null,
          2,
        ) + "\n",
      );
      if (direct.stdout) process.stdout.write(direct.stdout);
      if (direct.stderr) process.stderr.write(direct.stderr);
    }
    reportDiskUsage("after");
    if (ownerExitFailed) throw new Error("Owner-exit stress exceeded the Windows ARM64 limit");
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
    const results: { testPath: string; ok: boolean }[] = JSON.parse(readFileSync(resultsPath, "utf8"));
    assertSelectedTestResults(selected, results);
    if (direct?.error) throw direct.error;
    if (direct && direct.status !== 0) process.exit(direct.status ?? 1);
  } else if (command === "summary") {
    summary(`## Result\n\nBuild: **${process.env.BUILD_OUTCOME}**. Tests: **${process.env.TEST_OUTCOME}**.\n`);
    if (existsSync(resultsPath)) {
      const results: { testPath: string; status: string; duration: number }[] = JSON.parse(
        readFileSync(resultsPath, "utf8"),
      );
      summary(
        `| File | Result | Seconds |\n| --- | --- | --- |\n${results.map(result => `| ${result.testPath} | ${result.status} | ${(result.duration / 1000).toFixed(1)} |`).join("\n")}\n`,
      );
    } else {
      const message = "No completed test report. Inspect the failed setup/build step or the test deadline in the log.";
      summary(message + "\n");
      if (process.env.TEST_OUTCOME === "success") throw new Error(message);
    }
  } else {
    throw new Error("Usage: tests.ts select|select-windows|test|summary");
  }
}
