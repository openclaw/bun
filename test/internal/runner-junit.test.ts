/**
 * scripts/runner.node.ts runs the bucket of parallel-safe test files as a single
 * `bun test --parallel` and reads the junit report it writes to decide which files
 * failed (to re-run them alone), what to print per file and what to put in the flaky
 * annotation. parseJunitFileSuites() in scripts/buildkite.ts is that parsing step.
 */
import { describe, expect, test } from "bun:test";
import { bunEnv, bunExe, nodeExe, tempDir } from "harness";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, lstatSync, readdirSync, rmSync } from "node:fs";
import { getOs, tmpdir } from "../../scripts/agent.ts";
import { createLiveOutputFilter, parseJunitFileSuites, parseTestStdout } from "../../scripts/buildkite.ts";

const parse = (xml: string) => Object.fromEntries(parseJunitFileSuites(xml));

describe("live worker output", () => {
  const annotation = "::error file=src/js/node/_http_client.ts,line=650::socket hang up";
  const input = `::group::test/js/node/http/example.test.ts\n${annotation}\n::endgroup::\n`;

  test.each(["\n", "\r\n", "\r"])("keeps file context and unchanged annotations across chunks with %j", newline => {
    for (const prefix of ["", "\x1b[0m", "\x1b[0m\x1b[31m"]) {
      const output = `${prefix}::group::test/example.test.ts${newline}${annotation}${newline}::endgroup::${newline}`;
      for (let split = 0; split <= output.length; split++) {
        const filter = createLiveOutputFilter({ github: true, buildkite: false });
        expect(filter(output.slice(0, split)) + filter(output.slice(split)) + filter.end()).toBe(
          `test: test/example.test.ts${newline}${annotation}${newline}`,
        );
      }
    }
  });

  test.each(["\n", "\r\n", "\r"])("keeps ANSI-prefixed file headers with %j line endings", newline => {
    const filter = createLiveOutputFilter({ github: true, buildkite: false });
    const output = filter(`\x1b[0m::group::test/example.test.ts${newline}${annotation}${newline}::endgroup::`);
    expect(output + filter.end()).toBe(`test: test/example.test.ts${newline}${annotation}${newline}`);
  });

  test.each([false, true])("retains file context outside GitHub with Buildkite=%s", buildkite => {
    const filter = createLiveOutputFilter({ github: false, buildkite });
    expect(filter(input) + filter.end()).toBe("test: test/js/node/http/example.test.ts\n");
  });

  test("preserves an unterminated file header and defuses Buildkite groups", () => {
    const filter = createLiveOutputFilter({ github: false, buildkite: true });
    expect(filter("--- not a group\n::gro")).toBe(" not a group\n");
    expect(filter("up::test/example.test.ts")).toBe("");
    expect(filter.end()).toBe("test: test/example.test.ts");
  });

  test("does not treat a marker in the middle of a line as a command", () => {
    const filter = createLiveOutputFilter({ github: true, buildkite: false });
    expect(filter("literal ") + filter("::group::not a file\n") + filter.end()).toBe("literal ::group::not a file\n");
  });
});

describe("parseTestStdout", () => {
  for (const [emoji, status] of [
    ["✓", "pass"],
    ["✗", "fail"],
    ["»", "skip"],
    ["✎", "todo"],
  ]) {
    for (const name of ["plain name", "name [bracket] continues", "name [literal]"]) {
      for (const { suffix, duration } of [
        { suffix: "", duration: undefined },
        { suffix: " [1.25ms]", duration: 1.25 },
        { suffix: " [1.25s]", duration: 1250 },
      ]) {
        test(`${status}: ${name}${suffix}`, () => {
          for (const stdout of [
            `${emoji} ${name}${suffix}`,
            `\x1b[32m${emoji}\x1b[0m ${name}\x1b[2m${suffix}\x1b[0m`,
          ]) {
            expect(parseTestStdout(stdout)).toEqual({
              tests: [{ url: undefined, file: undefined, test: name, status, errors: [], duration }],
              errors: [],
              stdout,
            });
          }
        });
      }
    }
  }

  test("associates annotations with the complete durationless name and ignores the summary", () => {
    const lines = [
      "::group::example.test.ts",
      "✓ passed [literal]",
      "::error title=Error,line=12,col=3::first%0Astack%25",
      "::error title=TypeError::second%0D%0Astack",
      "✗ failed [literal]",
      "» skipped [literal]",
      "✎ pending [literal]",
      "::endgroup::",
      "✗ failed [literal]",
      "::error title=Ignored::after summary",
    ];
    const result = parseTestStdout(lines.join("\n"));
    expect(result.errors).toEqual([
      {
        url: undefined,
        file: undefined,
        line: "12",
        col: "3",
        name: "Error",
        stack: "Error\nfirst\nstack%",
        test: "failed [literal]",
      },
      {
        url: undefined,
        file: undefined,
        line: undefined,
        col: undefined,
        name: "TypeError",
        stack: "TypeError\nsecond\r\nstack",
        test: "failed [literal]",
      },
    ]);
    expect(result.tests).toEqual([
      { url: undefined, file: undefined, test: "passed [literal]", status: "pass", errors: [], duration: undefined },
      {
        url: undefined,
        file: undefined,
        test: "failed [literal]",
        status: "fail",
        errors: result.errors,
        duration: undefined,
      },
      { url: undefined, file: undefined, test: "skipped [literal]", status: "skip", errors: [], duration: undefined },
      { url: undefined, file: undefined, test: "pending [literal]", status: "todo", errors: [], duration: undefined },
    ]);
    expect(result.stdout).toBe(
      "✓ passed [literal]\n✗ failed [literal]\n» skipped [literal]\n✎ pending [literal]\n✗ failed [literal]",
    );
  });

  test("shortens consecutive non-failing output without discarding parsed tests", () => {
    const result = parseTestStdout("✓ first\n✓ second\n✓ third\n» fourth [literal]\n✗ fifth [literal]");
    expect(result.tests.map(({ test, status }) => [test, status])).toEqual([
      ["first", "pass"],
      ["second", "pass"],
      ["third", "pass"],
      ["fourth [literal]", "skip"],
      ["fifth [literal]", "fail"],
    ]);
    expect(result.stdout).toBe(
      "✓ first\n\x1b[90m... omitted 2 tests ...\x1b[0m\n» fourth [literal]\n✗ fifth [literal]",
    );
  });

  test("keeps the last 100 lines in a long preview without discarding parsed tests", () => {
    const lines = ["✓ fast [literal]", ...Array.from({ length: 110 }, (_, i) => `output ${i}`)];
    const result = parseTestStdout(lines.join("\n"));
    expect(result.tests).toEqual([
      { url: undefined, file: undefined, test: "fast [literal]", status: "pass", errors: [], duration: undefined },
    ]);
    expect(result.errors).toEqual([]);
    expect(result.stdout).toBe(`\x1b[90m... omitted 11 lines ...\x1b[0m\n\n${lines.slice(-100).join("\n")}`);
  });
});

describe("parseJunitFileSuites", () => {
  test("reports each file from its own suite, not from the describe suites nested in it", () => {
    // Shape of bun's reporter: a suite per file, and inside it a suite per describe
    // block, every one of them carrying the file attribute. The file suite's counts
    // include the describe blocks; its time is the file's wall clock, theirs is the
    // sum of their tests.
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="bun test" tests="5" assertions="5" failures="2" skipped="0" time="2.5">
  <testsuite name="test/a.test.ts" file="test/a.test.ts" tests="4" assertions="4" failures="2" skipped="0" time="1.5" hostname="ci">
    <testcase name="top level" classname="" time="0.1" file="test/a.test.ts" assertions="1">
      <failure type="AssertionError" message="expect(received).toBe(expected)&#10;&#10;Expected: 2&#10;Received: 1">AssertionError: expect(received).toBe(expected)</failure>
    </testcase>
    <testsuite name="first" file="test/a.test.ts" line="3" tests="1" assertions="1" failures="1" skipped="0" time="0.2" hostname="ci">
      <testcase name="in &quot;first&quot;" classname="first" time="0.2" file="test/a.test.ts" assertions="1">
        <failure type="Error" message="a &lt; b &amp;&amp; c &gt; d" />
      </testcase>
    </testsuite>
    <testsuite name="second" file="test/a.test.ts" line="6" tests="2" assertions="2" failures="0" skipped="0" time="9" hostname="ci">
      <testsuite name="inner" file="test/a.test.ts" line="7" tests="2" assertions="2" failures="0" skipped="0" time="9" hostname="ci">
        <testcase name="fast" classname="second &gt; inner" time="0.3" file="test/a.test.ts" assertions="1" />
        <testcase name="skipped" classname="second &gt; inner" time="0" file="test/a.test.ts" assertions="0">
          <skipped />
        </testcase>
        <testcase name="slow" classname="second &gt; inner" time="8.7" file="test/a.test.ts" assertions="1" />
      </testsuite>
    </testsuite>
  </testsuite>
  <testsuite name="test/b.test.ts" file="test/b.test.ts" tests="1" assertions="1" failures="0" skipped="0" time="0.25" hostname="ci">
    <testcase name="plain" classname="" time="0.01" file="test/b.test.ts" assertions="1" />
  </testsuite>
</testsuites>
`;
    expect(parse(xml)).toEqual({
      "test/a.test.ts": {
        failures: 2,
        seconds: 1.5,
        cases: [
          { name: "top level", message: "expect(received).toBe(expected)\n\nExpected: 2\nReceived: 1" },
          { name: 'in "first"', message: "a < b && c > d" },
        ],
      },
      "test/b.test.ts": { failures: 0, seconds: 0.25, cases: [] },
    });
  });

  test("keys files by their unescaped path with forward slashes", () => {
    // On Windows the reporter writes the path with backslashes; the runner looks files
    // up by their forward-slash path.
    const xml = `<testsuites name="bun test" tests="1" failures="1" time="0.5">
  <testsuite name="test\\js\\a &amp; b.test.ts" file="test\\js\\a &amp; b.test.ts" tests="1" failures="1" time="0.5">
    <testcase name="t" classname="" time="0.1" file="test\\js\\a &amp; b.test.ts" assertions="1">
      <failure type="Error" message="boom" />
    </testcase>
  </testsuite>
</testsuites>
`;
    expect(parse(xml)).toEqual({
      "test/js/a & b.test.ts": { failures: 1, seconds: 0.5, cases: [{ name: "t", message: "boom" }] },
    });
  });

  test("reports the suite bun test --parallel writes for a file whose worker crashed", () => {
    // The coordinator records a synthetic failing case for the file, after any
    // cases the worker reported before it died.
    const xml = `<testsuites name="bun test" tests="1" assertions="0" failures="1" skipped="0" time="0.3">
  <testsuite name="test/crash.test.ts" file="test/crash.test.ts" tests="1" assertions="0" failures="1" skipped="0" time="0.12" hostname="h">
    <testcase name="(worker crashed)" classname="" time="0" file="test/crash.test.ts" assertions="0">
      <failure type="Error" message="worker process crashed before reporting results" />
    </testcase>
  </testsuite>
</testsuites>
`;
    expect(parse(xml)).toEqual({
      "test/crash.test.ts": {
        failures: 1,
        seconds: 0.12,
        cases: [{ name: "(worker crashed)", message: "worker process crashed before reporting results" }],
      },
    });
  });

  test("reports nothing for a report without file suites", () => {
    expect(parse("")).toEqual({});
    expect(parse(`<testsuites name="bun test" tests="0" failures="0" time="0">\n</testsuites>\n`)).toEqual({});
  });
  test("accepts zero-test files, skipped cases, and a describe named after its file", () => {
    const xml =
      '<testsuites><testsuite name="test/a.test.ts" file="test/a.test.ts" tests="1" failures="0" time="0.5">' +
      '<properties><property name="ci" value="https://example.com/run" /></properties>' +
      '<testsuite name="test/a.test.ts" file="test/a.test.ts" tests="1" failures="0" time="0.2">' +
      '<testcase name="skipped" file="test/a.test.ts"><skipped /></testcase></testsuite></testsuite>' +
      '<testsuite name="test/empty.test.ts" file="test/empty.test.ts" tests="0" failures="0" time="0" /></testsuites>';
    expect(parse(xml)).toEqual({
      "test/a.test.ts": { failures: 0, seconds: 0.5, cases: [] },
      "test/empty.test.ts": { failures: 0, seconds: 0, cases: [] },
    });
  });

  test.each([
    'tests="0" time="0"',
    'failures="0" time="0"',
    'tests="0" failures="0"',
    'tests="NaN" failures="0" time="0"',
    'tests="9007199254740992" failures="0" time="0"',
    'tests="0" failures="-1" time="0"',
    'tests="0" failures="NaN" time="0"',
    'tests="0" failures="0" time="Infinity"',
    'tests="0" failures="0" time="-1"',
    'tests="0" failures="0" failures="1" time="0"',
  ])("rejects invalid or ambiguous file metrics: %s", attributes => {
    expect(() =>
      parse('<testsuites><testsuite name="test/a.test.ts" file="test/a.test.ts" ' + attributes + " /></testsuites>"),
    ).toThrow("invalid native JUnit report");
  });

  test.each(["duplicate", "truncated", "mismatched", "unsupported", "misplaced"])(
    "rejects %s native report structure",
    mode => {
      const suite = '<testsuite name="test/a.test.ts" file="test/a.test.ts" tests="0" failures="0" time="0">';
      const reports = {
        duplicate: "<testsuites>" + suite + "</testsuite>" + suite + "</testsuite></testsuites>",
        truncated: "<testsuites>" + suite + "</testsuite>",
        mismatched: "<testsuites>" + suite + "</testsuites></testsuite>",
        unsupported: "<testsuites>" + suite + "<error /></testsuite></testsuites>",
        misplaced: '<testsuites><testcase name="bad" /></testsuites>',
      };
      expect(() => parse(reports[mode as keyof typeof reports])).toThrow("invalid native JUnit report");
    },
  );
});

test("parseJunitFileSuites reads the report bun test --parallel --reporter=junit writes", async () => {
  using dir = tempDir("runner-junit", {
    "test/describes.test.ts": `
      import { describe, expect, test } from "bun:test";
      test("top level fails", () => expect(1).toBe(2));
      describe("first", () => {
        test('fails in "first"', () => expect("a").toBe("b"));
      });
      describe("second", () => {
        describe("inner", () => {
          test("passes", () => expect(1).toBe(1));
        });
        test("passes too", () => expect(2).toBe(2));
      });
    `,
    "test/plain.test.ts": `
      import { expect, test } from "bun:test";
      test("passes", () => expect(1).toBe(1));
    `,
    "test/crash.test.ts": `
      import { test } from "bun:test";
      test("exits the worker", () => process.exit(7));
    `,
  });
  await using proc = Bun.spawn({
    cmd: [bunExe(), "test", "--parallel=2", "--reporter=junit", "--reporter-outfile=report.xml"],
    cwd: String(dir),
    env: bunEnv,
    stdout: "ignore",
    stderr: "pipe",
  });
  const [stderr, exitCode] = await Promise.all([proc.stderr.text(), proc.exited]);
  expect(stderr).toContain("worker crashed");
  const xml = await Bun.file(join(String(dir), "report.xml")).text();

  // The suites describes.test.ts gets: the file's own, "first", "second" and "inner",
  // the last three nested in the first. All of them name the file.
  expect(xml.match(/<testsuite [^>]*\sfile="test[\\/]describes\.test\.ts"/g)).toHaveLength(4);
  const fileSuiteSeconds = Number(/<testsuite name="test[\\/]describes\.test\.ts"[^>]*\stime="([^"]+)"/.exec(xml)![1]);

  expect(parse(xml)).toEqual({
    "test/describes.test.ts": {
      failures: 2,
      seconds: fileSuiteSeconds,
      cases: [
        { name: "top level fails", message: expect.stringContaining("Expected: 2") },
        { name: 'fails in "first"', message: expect.stringContaining('Expected: "b"') },
      ],
    },
    "test/plain.test.ts": { failures: 0, seconds: expect.any(Number), cases: [] },
    "test/crash.test.ts": {
      failures: 1,
      seconds: expect.any(Number),
      cases: [{ name: "(worker crashed)", message: "worker process crashed before reporting results" }],
    },
  });
  expect(exitCode).toBe(1);
});

const files = Array.from({ length: 8 }, (_, i) => `test/js/node/module/fixture-${i}.test.ts`);
async function runnerFixture(extra: Record<string, string> = {}) {
  const fixture: Record<string, string> = {
    "test/parallel-allowlist.json": JSON.stringify({ dirs: ["js/node/module"], excludeFiles: [] }),
    "test/leaksan.supp": "",
    "alternate-tmp/keep": "",
  };
  for (const file of [
    "scripts/runner.node.ts",
    "scripts/agent.ts",
    "scripts/buildkite.ts",
    "test/docker/prestart-map.mjs",
  ])
    fixture[file] = await Bun.file(join(import.meta.dir, "../..", file)).text();
  for (const file of files)
    fixture[file] = 'import { test, expect } from "bun:test"; test("passes", () => expect(1).toBe(1));';
  const dir = tempDir("runner-junit-files", { ...fixture, ...extra });
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], {
      cwd: String(dir),
      encoding: "utf8",
      env: {
        ...bunEnv,
        GIT_AUTHOR_NAME: "Test",
        GIT_AUTHOR_EMAIL: "test@example.com",
        GIT_COMMITTER_NAME: "Test",
        GIT_COMMITTER_EMAIL: "test@example.com",
      },
    }).trim();
  try {
    git("init", "--quiet");
    git("remote", "add", "origin", "https://github.com/oven-sh/bun.git");
    git("add", ".");
    git("commit", "--quiet", "-m", "fixture");
    return dir;
  } catch (error) {
    dir[Symbol.dispose]();
    throw error;
  }
}

const node = nodeExe();
test.skipIf((process.platform !== "linux" && process.platform !== "darwin") || !node)(
  "explicit Linux/macOS JUnit keeps per-file reports while default execution batches allowlisted files",
  async () => {
    {
      await using probe = Bun.spawn({
        cmd: [node!, "-p", "process.release.name === 'node' && !process.versions.bun"],
        env: bunEnv,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([probe.stdout.text(), probe.stderr.text(), probe.exited]);
      expect(stdout.trim()).toBe("true");
      expect(exitCode, stderr).toBe(0);
    }
    using dir = await runnerFixture();
    const prefix = `runner-junit-files-${randomUUID()}-`;
    const nativeTemp = tmpdir();
    const reports = () => readdirSync(nativeTemp).filter(name => name.startsWith(prefix));
    expect(reports()).toEqual([]);
    try {
      for (const junit of [false, true]) {
        await using proc = Bun.spawn({
          cmd: [
            node!,
            "scripts/runner.node.ts",
            "--exec-path",
            bunExe(),
            "--quiet",
            "--vendor=false",
            "--retries=0",
            ...(junit ? ["--junit", "--junit-temp-dir", prefix] : []),
          ],
          cwd: String(dir),
          env: { ...bunEnv, CI: "", GITHUB_ACTIONS: "", BUILDKITE: "", TMPDIR: join(String(dir), "alternate-tmp") },
          stdout: "pipe",
          stderr: "pipe",
        });
        const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
        expect(stdout.includes("8 files in parallel")).toBe(!junit);
        if (!junit) {
          expect(reports()).toEqual([]);
          expect(exitCode, stderr).toBe(0);
          continue;
        }
        expect(reports()).toHaveLength(1);
        const directory = join(nativeTemp, reports()[0]!);
        expect(lstatSync(directory).isDirectory()).toBe(true);
        expect(lstatSync(directory).isSymbolicLink()).toBe(false);
        expect(readdirSync(join(String(dir), "alternate-tmp"))).toEqual(["keep"]);
        const expected = files.map(file => `test-${createHash("sha1").update(file).digest("base64url")}.xml`);
        expect(readdirSync(directory).sort()).toEqual(expected.sort());
        for (const file of files) {
          const name = `test-${createHash("sha1").update(file).digest("base64url")}.xml`;
          const xml = await Bun.file(join(directory, name)).text();
          expect(xml.match(/<testcase\b/g)).toHaveLength(1);
          expect(parse(xml)).toEqual({ [file]: { failures: 0, seconds: expect.any(Number), cases: [] } });
        }
        expect(exitCode, stderr).toBe(0);
      }
    } finally {
      for (const name of reports()) rmSync(join(nativeTemp, name), { recursive: true, force: true });
    }
  },
);

// Exercise the real runner with controlled native-report/exit outcomes, not a second retry implementation.
test
  .skipIf((process.platform !== "linux" && process.platform !== "darwin") || !node)
  .each([
    "failed",
    "retry",
    "missing",
    "stale",
    "truncated",
    "duplicate",
    "invalid",
    "missing-file",
    "process-failure",
    "suite-failure",
    "fatal",
  ])(
  "parallel bucket retains first-attempt evidence: %s",
  async mode => {
    const suite = (file: string, failed = false) =>
      '<testsuite name="' +
      file +
      '" file="' +
      file +
      '" tests="1" failures="' +
      Number(failed) +
      '" time="0">' +
      (failed
        ? '<testcase name="first attempt" file="' + file + '"><failure message="grouped failure" /></testcase>'
        : "") +
      "</testsuite>";
    const valid = "<testsuites>" + files.map(file => suite(file)).join("") + "</testsuites>";
    let report =
      "<testsuites>" +
      files.map((file, i) => suite(file, i === 0 && ["failed", "retry", "suite-failure"].includes(mode))).join("") +
      "</testsuites>";
    if (mode === "truncated") report = report.slice(0, -13);
    if (mode === "duplicate") report = report.replace("</testsuites>", suite(files[0]!) + "</testsuites>");
    if (mode === "invalid") report = report.replace('failures="0"', 'failures="NaN"');
    if (mode === "missing-file") report = report.replace(suite(files[0]!), "");
    const program =
      "#!" +
      node +
      "\n" +
      `
    const fs = require("node:fs");
    const args = process.argv.slice(2);
    if (args[0] === "--print") console.log(__filename);
    else if (args[0] === "--revision") console.log("fixture");
    else {
      fs.appendFileSync("attempts.jsonl", JSON.stringify(args) + "\\n");
      const output = args.find(arg => arg.startsWith("--reporter-outfile="));
      if (output) {
        if (${JSON.stringify(mode)} === "fatal") process.kill(process.pid, "SIGKILL");
        if (!${JSON.stringify(["missing", "stale"].includes(mode))}) fs.writeFileSync(output.split("=")[1], ${JSON.stringify(report)});
        process.exit(${["failed", "retry", "process-failure"].includes(mode) ? 1 : 0});
      }
      console.log("✓ passed");
    }
  `;
    using dir = await runnerFixture({ "reporter.cjs": program });
    const executable = join(String(dir), "reporter.cjs");
    chmodSync(executable, 0o700);
    if (mode === "stale") await Bun.write(join(String(dir), `parallel-bucket-junit-${getOs()}-shard0.xml`), valid);
    await using proc = Bun.spawn({
      cmd: [
        node!,
        "scripts/runner.node.ts",
        "--exec-path",
        executable,
        "--quiet",
        "--vendor=false",
        `--retries=${["retry", "fatal"].includes(mode) ? 1 : 0}`,
        "--results-json=results.json",
      ],
      cwd: String(dir),
      env: { ...bunEnv, CI: "", GITHUB_ACTIONS: "", BUILDKITE: "" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
    const attempts = (await Bun.file(join(String(dir), "attempts.jsonl")).text())
      .trim()
      .split("\n")
      .map(line => JSON.parse(line) as string[]);
    expect(stdout).toContain("8 files in parallel");
    expect(attempts).toHaveLength(mode === "retry" ? 2 : 1);
    expect(attempts[0]!.some(arg => arg.startsWith("--parallel="))).toBe(true);
    if (mode === "retry") expect(attempts[1]!.at(-1)).toBe(join(String(dir), files[0]!));
    const rows = await Bun.file(join(String(dir), "results.json")).json();
    expect(rows).toHaveLength(8);
    const failed = rows.filter((row: { ok: boolean }) => !row.ok);
    expect(failed).toHaveLength(["failed", "retry", "suite-failure", "missing-file"].includes(mode) ? 1 : 8);
    for (const row of failed) {
      expect(row.status).toBe("fail");
      expect(row.error).toBeTruthy();
      expect(row).not.toHaveProperty("exitCode");
    }
    if (mode === "retry") {
      expect(failed[0].stdoutPreview).toContain("grouped failure");
      expect(stdout).toContain("[attempt #2]");
    }
    if (mode === "fatal") expect(failed.every((row: { error: string }) => /sigkill/i.test(row.error))).toBe(true);
    // The CLI permits flakes; its JSON must still retain their failed first attempt.
    expect(exitCode, stderr).toBe(mode === "retry" ? 0 : 1);
  },
  30_000,
); // A permitted retry keeps the runner's real 5–15 second backoff.
