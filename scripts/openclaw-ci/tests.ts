import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const smoke = [
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

export function selectTests(changed: string[], tracked: string[], nightly: boolean): string[] {
  const available = new Set(tracked);
  const selected = new Set([...smoke, ...(nightly ? broader : [])]);
  const tests = tracked.filter(isTest);
  for (const path of changed) {
    if (isTest(path)) {
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
    if (!available.has(test)) throw new Error(`Selected test is missing: ${test}; update the smoke list`);
  }
  return [...selected].sort();
}

function git(...args: string[]): string[] {
  const result = spawnSync("git", args, { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args[0]} failed`);
  return result.stdout.split("\0").filter(Boolean);
}

function summary(text: string) {
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, text);
  console.log(text);
}

if (import.meta.main) {
  const command = process.argv[2];
  const selectionPath = "build/openclaw-ci/selected.json";
  const resultsPath = "build/openclaw-ci/results.json";
  if (command === "select") {
    const base = process.env.PR_BASE_SHA;
    const head = process.env.PR_HEAD_SHA;
    if (process.env.GITHUB_EVENT_NAME === "pull_request" && (!base || !head)) throw new Error("Missing PR commits");
    const changed =
      base && head ? git("diff", "--no-renames", "--name-only", "--diff-filter=ACMTD", "-z", `${base}...${head}`) : [];
    const selected = selectTests(changed, git("ls-files", "-z", "test"), !base);
    mkdirSync(dirname(selectionPath), { recursive: true });
    writeFileSync(selectionPath, JSON.stringify(selected, null, 2) + "\n");
    summary(`## Selected tests (${selected.length})\n\n${selected.map(test => `- \`${test}\``).join("\n")}\n`);
  } else if (command === "test") {
    const selected: string[] = JSON.parse(readFileSync(selectionPath, "utf8"));
    if (!selected.length) throw new Error("Refusing an empty test selection");
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
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
    const results: { testPath: string; ok: boolean }[] = JSON.parse(readFileSync(resultsPath, "utf8"));
    for (const test of selected) {
      if (!results.some(result => result.testPath === test && result.ok)) {
        throw new Error(`Selected test did not pass (or was skipped by expectations): ${test}`);
      }
    }
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
    throw new Error("Usage: tests.ts select|test|summary");
  }
}
