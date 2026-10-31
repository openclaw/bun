import { expect, test } from "bun:test";
import { bunEnv, bunExe, tempDir } from "harness";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  assertSelectedTestResults,
  broader,
  forkRegressions,
  isTest,
  ownerExitStressFailed,
  selectTests,
  smoke,
  windowsSmoke,
} from "../../../scripts/openclaw-ci/tests.ts";

// The lint/format fixture corpus puts the tracked path list above node:child_process's 1 MiB default.
const tracked = execFileSync("git", ["ls-files", "-z", "test"], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 })
  .split("\0")
  .filter(Boolean);

test("owner-exit fails at five assertion failures in 50 trials", () => {
  for (const [failures, expected] of [
    [0, false],
    [1, false],
    [4, false],
    [5, true],
    [50, true],
  ] as const) {
    const trials = Array.from({ length: 50 }, (_, index) => ({
      exitCode: index < failures ? 1 : 0,
      signal: null,
    }));
    expect(ownerExitStressFailed(trials)).toBe(expected);
  }
});

test("owner-exit rejects any abnormal process exit", () => {
  const pass = { exitCode: 0, signal: null };
  for (const exitCode of [null, -1073741819, 3221225477, 3221226356, 2]) {
    expect(ownerExitStressFailed([pass, { exitCode, signal: null }])).toBe(true);
  }
  expect(ownerExitStressFailed([{ exitCode: 0, signal: "SIGTERM" }])).toBe(true);
  expect(ownerExitStressFailed([{ exitCode: 0, signal: null, error: "spawn failed" }])).toBe(true);
});

test("PR and nightly smoke lists exist and nightly includes every PR smoke file", () => {
  expect(selectTests([], tracked, false)).toEqual([...smoke].sort());
  expect(selectTests([], tracked, true)).toEqual([...smoke, ...broader].sort());
});

test("both Windows architectures use the complete Windows compatibility selection", () => {
  expect(selectTests([], tracked, false, "windows")).toEqual([...windowsSmoke].sort());
  expect(selectTests([], tracked, true, "windows")).toEqual([...windowsSmoke].sort());
  expect(windowsSmoke).toHaveLength(42);
  for (const file of tracked.filter(file => file.startsWith("test/js/node/worker_threads/") && isTest(file))) {
    expect(windowsSmoke).toContain(file);
  }
  for (const file of [
    ...smoke,
    ...broader,
    "test/js/web/workers/structured-clone.test.ts",
    "test/js/web/structured-clone-shared-array-buffer.test.ts",
    "test/js/node/v8/v8-serdes-buffer.test.ts",
  ])
    expect(windowsSmoke).toContain(file);
  expect(windowsSmoke).toContain("test/js/bun/resolve/import-meta.test.js");
});

test.each(["linux", "darwin", "windows"])("fork printer and Dirent regressions always run on %s", platform => {
  for (const nightly of [false, true]) {
    const selected = selectTests([], tracked, nightly, platform);
    for (const path of forkRegressions) expect(selected).toContain(path);
  }
});

test("native Windows result paths prove coverage without admitting failed or missing tests", () => {
  const selected = ["test/js/node/fs/fs.test.ts", "test/js/node/process/process.test.js"];
  const results = selected.map(testPath => ({ testPath: testPath.replaceAll("/", "\\"), ok: true }));
  expect(() => assertSelectedTestResults(selected, results, "win32")).not.toThrow();
  expect(() => assertSelectedTestResults(selected, results.slice(1), "win32")).toThrow(selected[0]);
  expect(() => assertSelectedTestResults(selected, [{ ...results[0]!, ok: false }, results[1]!], "win32")).toThrow(
    selected[0],
  );
  // Backslashes remain literal filename characters on POSIX.
  expect(() => assertSelectedTestResults(selected, results, "linux")).toThrow(selected[0]);
  expect(() =>
    assertSelectedTestResults(
      selected,
      selected.map(testPath => ({ testPath, ok: true })),
      "linux",
    ),
  ).not.toThrow();
});

test("macOS selection includes file, directory, recursive, process and child-process coverage", () => {
  const selected = selectTests([], tracked, false, "darwin");
  expect(selected).toContain("test/js/node/watch/fs.watch.test.ts");
  expect(selected).toContain("test/js/node/watch/fs.watch.close-exit.test.ts");
  expect(selected).toContain("test/js/node/process/process.test.js");
  expect(selected).toContain("test/js/node/child_process/child_process.test.ts");
  expect(selected).not.toContain("test/js/bun/sqlite/sqlite.test.js");
  const nightly = selectTests([], tracked, true, "darwin");
  for (const path of selected) expect(nightly).toContain(path);
  expect(() => selectTests([], tracked, false, "unsupported")).toThrow("Unsupported CI platform");
});

test.each(["linux", "darwin"])("WebKit updates select VM, Intl, GC, hook and plugin coverage on %s", platform => {
  const selected = selectTests(["scripts/build/deps/webkit.ts"], tracked, false, platform);
  expect(selectTests(["scripts/build/deps/webkit-artifacts.json"], tracked, false, platform)).toEqual(selected);
  expect(selected).toContain("test/js/node/async_hooks/AsyncLocalStorage.test.ts");
  expect(selected).toContain("test/js/node/worker_threads/worker_threads.test.ts");
  expect(selected).toContain("test/js/node/vm/vm.test.ts");
  expect(selected).toContain("test/js/web/intl/intl.test.ts");
  expect(selected).toContain("test/js/bun/jsc/bun-jsc.test.ts");
  expect(selected).toContain("test/js/bun/jsc/webkit-upgrade-7b485a76e9.test.ts");
  expect(selected).toContain("test/js/node/module/register-hooks-builtin-urls.test.ts");
  expect(selected).toContain("test/js/node/module/register-hooks-virtual-urls.test.ts");
  expect(selected).toContain("test/js/bun/plugin/plugin-resolved-key.test.ts");
  expect(selected).not.toContain("test/bundler/esbuild/default.test.ts");
});

test.each(["linux", "darwin"])("stack position changes select WebKit and VM sourceURL coverage on %s", platform => {
  for (const source of [
    "CallSitePrototype.cpp",
    "ErrorStackFrame.cpp",
    "ErrorStackFrame.h",
    "ErrorStackTrace.cpp",
    "FormatStackTraceForJS.cpp",
    "ZigSourceProvider.cpp",
  ]) {
    const selected = selectTests([`src/jsc/bindings/${source}`], tracked, false, platform);
    expect(selected).toContain("test/js/bun/jsc/webkit-upgrade-7b485a76e9.test.ts");
    expect(selected).toContain("test/js/node/vm/vm-sourceUrl.test.ts");
  }
});

test("changed tests are added exactly once, renamed tests use the new path, deleted tests are omitted", () => {
  const added = "test/js/node/fs/new check.test.ts";
  const deleted = "test/js/node/fs/removed.test.ts";
  const selection = selectTests([added, deleted, smoke[0]!], [...tracked, added], false);
  expect(selection).toEqual([...smoke, added].sort());
  expect(isTest("test/fixture.js")).toBe(false);
  expect(isTest("test/new.test.mts")).toBe(true);
  expect(isTest("test/new.spec.tsx")).toBe(true);
});

test("fixture changes select the nearest directory's tests, without unrelated suites", () => {
  const owner = "test/js/custom/owner.test.ts";
  const unrelated = "test/js/unrelated/other.test.ts";
  const selection = selectTests(["test/js/custom/fixtures/input.json"], [...tracked, owner, unrelated], false);
  expect(selection).toEqual([...smoke, owner].sort());
});

test("JS and native Node modules select their adjacent tests", () => {
  const adjacent = "test/js/node/dns/resolve.test.ts";
  for (const source of ["src/js/node/dns.ts", "src/runtime/node/dns/Resolver.rs"]) {
    expect(selectTests([source], [...tracked, adjacent], false)).toContain(adjacent);
  }
});

test("C++ and Rust boundaries select the documented broader suites", () => {
  const selection = selectTests(["src/jsc/bindings/NodeTLS.cpp", "src/jsc/web_worker.rs"], tracked, false);
  expect(selection).toContain("test/js/node/tls/node-tls-connect.test.ts");
  expect(selection).toContain("test/js/node/worker_threads/worker-transfer-list.test.ts");
  expect(selection).not.toContain("test/js/node/fs/promises.test.js");
});

test("lowercase Fetch implementation paths select HTTP, net and TLS coverage", () => {
  const selection = selectTests(["src/runtime/webcore/fetch.rs"], tracked, false);
  expect(selection).toContain("test/js/node/http/node-http.test.ts");
  expect(selection).toContain("test/js/node/net/node-net.test.ts");
  expect(selection).toContain("test/js/node/tls/node-tls-connect.test.ts");
});

test("a removed fixed smoke test fails loudly instead of shrinking coverage", () => {
  expect(() =>
    selectTests(
      [],
      tracked.filter(path => path !== smoke[0]),
      false,
    ),
  ).toThrow("Selected test is missing");
});

test("CLI diff selects owners at both ends of a moved fixture", () => {
  const oldTest = "test/js/old/owner.test.ts";
  const newTest = "test/js/new/owner.test.ts";
  using dir = tempDir(
    "openclaw-ci-rename",
    Object.fromEntries([...smoke, oldTest, newTest, "test/js/old/fixture.txt"].map(path => [path, "fixture content"])),
  );
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: String(dir),
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Test",
        GIT_AUTHOR_EMAIL: "test@example.com",
        GIT_COMMITTER_NAME: "Test",
        GIT_COMMITTER_EMAIL: "test@example.com",
      },
    }).trim();
  git("init", "--quiet");
  git("add", ".");
  git("-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "before");
  const base = git("rev-parse", "HEAD");
  renameSync(join(String(dir), "test/js/old/fixture.txt"), join(String(dir), "test/js/new/fixture.txt"));
  git("add", ".");
  git("-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "after");
  const output = execFileSync(bunExe(), [resolve(import.meta.dir, "../../../scripts/openclaw-ci/tests.ts"), "select"], {
    cwd: String(dir),
    encoding: "utf8",
    env: {
      ...process.env,
      GITHUB_STEP_SUMMARY: "",
      GITHUB_EVENT_NAME: "pull_request",
      OPENCLAW_CI_PLATFORM: "linux",
      PR_BASE_SHA: base,
      PR_HEAD_SHA: git("rev-parse", "HEAD"),
    },
  });
  const selected = JSON.parse(readFileSync(join(String(dir), "build/openclaw-ci/selected.json"), "utf8"));
  expect(selected).toEqual([...smoke, oldTest, newTest].sort());
  expect(output).toContain("Upstream parents (newest first): none.");
  expect(output).toContain(`Changed files: 2. Fork-delta files: 2. Selected tests: ${selected.length}.`);
});

test.each([false, true])("sync CLI retains resolutions and ignores a later fork-main merge: %s", mergeMain => {
  const pure = "test/js/custom/upstream.test.ts";
  const resolved = "test/js/custom/resolved.test.ts";
  using dir = tempDir(
    "openclaw-ci-sync",
    Object.fromEntries([...smoke, ...broader, pure, resolved].map(path => [path, "original\n"])),
  );
  const env = {
    ...bunEnv,
    GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@example.com",
  };
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "commit.gpgsign=false", ...args], {
      cwd: String(dir),
      encoding: "utf8",
      env,
    }).trim();
  const write = (path: string, content: string) => writeFileSync(join(String(dir), path), content);
  git("init", "--quiet", "--initial-branch=fork-main");
  git("add", ".");
  git("commit", "--quiet", "-m", "common ancestor");
  git("checkout", "--quiet", "-b", "upstream");
  write(pure, "upstream\n");
  write(resolved, "upstream\n");
  git("commit", "--quiet", "-am", "upstream changes");
  const upstream = git("rev-parse", "HEAD");
  git("checkout", "--quiet", "fork-main");
  write(resolved, "fork\n");
  git("commit", "--quiet", "-am", "fork changes");
  let base = git("rev-parse", "HEAD");
  git("checkout", "--quiet", "-b", "sync");
  const merge = spawnSync("git", ["merge", "--no-ff", "--no-commit", "upstream"], {
    cwd: String(dir),
    encoding: "utf8",
    env,
  });
  expect(merge.stdout).toContain("CONFLICT (content)");
  expect(merge.status).toBe(1);
  write(resolved, "resolved\n");
  git("add", ".");
  git("commit", "--quiet", "-m", "resolve upstream merge");
  if (mergeMain) {
    git("checkout", "--quiet", "fork-main");
    write("fork-main.txt", "later main change\n");
    git("add", ".");
    git("commit", "--quiet", "-m", "advance fork main");
    base = git("rev-parse", "HEAD");
    git("checkout", "--quiet", "sync");
    git("merge", "--quiet", "--no-ff", "-m", "merge fork main", "fork-main");
  }
  const output = execFileSync(bunExe(), [resolve(import.meta.dir, "../../../scripts/openclaw-ci/tests.ts"), "select"], {
    cwd: String(dir),
    encoding: "utf8",
    env: {
      ...env,
      GITHUB_STEP_SUMMARY: join(String(dir), "summary.md"),
      GITHUB_EVENT_NAME: "pull_request",
      OPENCLAW_CI_PLATFORM: "linux",
      PR_BASE_SHA: base,
      PR_HEAD_SHA: git("rev-parse", "HEAD"),
    },
  });
  const selected = JSON.parse(readFileSync(join(String(dir), "build/openclaw-ci/selected.json"), "utf8"));
  expect(selected).toEqual([...smoke, ...broader, resolved].sort());
  expect(output).toContain(`Upstream parents (newest first): \`${upstream}\`.`);
  expect(output).toContain(`Changed files: 2. Fork-delta files: 1. Selected tests: ${selected.length}.`);
  expect(readFileSync(join(String(dir), "summary.md"), "utf8")).toContain(
    `Changed files: 2. Fork-delta files: 1. Selected tests: ${selected.length}.`,
  );
});

test("a successful test step without a completed report cannot produce a green summary", () => {
  using dir = tempDir("openclaw-ci-missing-report", {});
  const result = spawnSync(bunExe(), [resolve(import.meta.dir, "../../../scripts/openclaw-ci/tests.ts"), "summary"], {
    cwd: String(dir),
    encoding: "utf8",
    env: { ...process.env, GITHUB_STEP_SUMMARY: "", BUILD_OUTCOME: "success", TEST_OUTCOME: "success" },
  });
  expect(result.stderr).toContain("No completed test report");
  expect(result.status).toBe(1);
});

test("the native test launcher preserves disk snapshots before and after its runner", () => {
  using dir = tempDir("openclaw-ci-disk", {
    "build/release/artifact": "fixture",
    "build/openclaw-ci/selected.json": JSON.stringify(["test/fixture.test.ts"]),
    "scripts/runner.node.ts": `require("node:fs").writeFileSync("build/openclaw-ci/results.json", JSON.stringify([{ testPath: "test/fixture.test.ts", ok: true }]));`,
  });
  const result = spawnSync(bunExe(), [resolve(import.meta.dir, "../../../scripts/openclaw-ci/tests.ts"), "test"], {
    cwd: String(dir),
    encoding: "utf8",
    env: { ...bunEnv, HOME: String(dir), RUNNER_TEMP: String(dir), BUN_BUILD_CACHE_DIR: String(dir) },
  });
  for (const stage of ["before", "after"]) {
    const path = join(String(dir), `build/openclaw-ci/disk-${stage}-tests.json`);
    if (process.platform === "win32") {
      expect(existsSync(path)).toBe(false);
    } else {
      const snapshot = JSON.parse(readFileSync(path, "utf8"));
      expect(snapshot.stage).toBe(stage);
      expect(snapshot.availableBytes).toBeGreaterThan(0);
      // Container filesystems can report zero inode counters while allowing file creation.
      expect(Number.isInteger(snapshot.availableInodes)).toBe(true);
      expect(snapshot.availableInodes).toBeGreaterThanOrEqual(0);
      expect(snapshot.directories.build).toBeGreaterThan(0);
      expect(result.stdout).toContain(`::notice title=Native test disk usage::${JSON.stringify(snapshot)}`);
    }
  }
  expect({ stderr: result.stderr, exitCode: result.status }).toEqual({ stderr: "", exitCode: 0 });
});

test.each([
  ["before", 0],
  ["after", 0],
  ["before", 7],
  ["after", 7],
] as const)("a failed %s disk artifact preserves runner exit %s", (stage, exitCode) => {
  using dir = tempDir("openclaw-ci-disk-write", {
    "build/openclaw-ci/selected.json": JSON.stringify(["test/fixture.test.ts"]),
    [`build/openclaw-ci/disk-${stage}-tests.json/directory`]: "prevents a file write",
    "scripts/runner.node.ts": `require("node:fs").writeFileSync("build/openclaw-ci/results.json", JSON.stringify([{ testPath: "test/fixture.test.ts", ok: true }])); process.exitCode = ${exitCode};`,
  });
  const result = spawnSync(bunExe(), [resolve(import.meta.dir, "../../../scripts/openclaw-ci/tests.ts"), "test"], {
    cwd: String(dir),
    encoding: "utf8",
    env: { ...bunEnv, HOME: String(dir), RUNNER_TEMP: String(dir), BUN_BUILD_CACHE_DIR: String(dir) },
  });
  expect(existsSync(join(String(dir), "build/openclaw-ci/results.json"))).toBe(true);
  if (process.platform !== "win32") expect(result.stderr).toContain("Could not write disk snapshot artifact");
  expect(result.status).toBe(exitCode);
});
