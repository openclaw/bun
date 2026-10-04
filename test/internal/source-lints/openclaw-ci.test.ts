import { expect, test } from "bun:test";
import { bunExe, tempDir } from "harness";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, renameSync } from "node:fs";
import { join, resolve } from "node:path";
import { broader, isTest, selectTests, smoke } from "../../../scripts/openclaw-ci/tests.ts";

const tracked = execFileSync("git", ["ls-files", "-z", "test"], { encoding: "utf8" }).split("\0").filter(Boolean);

test("PR and nightly smoke lists exist and nightly includes every PR smoke file", () => {
  expect(selectTests([], tracked, false)).toEqual([...smoke].sort());
  expect(selectTests([], tracked, true)).toEqual([...smoke, ...broader].sort());
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
  execFileSync(bunExe(), [resolve(import.meta.dir, "../../../scripts/openclaw-ci/tests.ts"), "select"], {
    cwd: String(dir),
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
