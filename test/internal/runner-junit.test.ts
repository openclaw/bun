/**
 * scripts/runner.node.ts runs the bucket of parallel-safe test files as a single
 * `bun test --parallel` and reads the junit report it writes to decide which files
 * failed (to re-run them alone), what to print per file and what to put in the flaky
 * annotation. parseJunitFileSuites() in scripts/buildkite.ts is that parsing step.
 */
import { describe, expect, test } from "bun:test";
import { bunEnv, bunExe, nodeExeAtLeast, tempDir } from "harness";
import { join } from "node:path";
import { createLiveOutputFilter, parseJunitFileSuites } from "../../scripts/buildkite.ts";

const parse = (xml: string) => Object.fromEntries(parseJunitFileSuites(xml));

describe("machine diagnostics", () => {
  for (const [runtime, executable] of [
    ["Bun", bunExe()],
    ["Node", nodeExeAtLeast("24.2.0")],
  ] as const) {
    test.skipIf(!executable)(`does not expose environment or machine identity under ${runtime}`, async () => {
      using dir = tempDir("machine-diagnostics", {
        "package.json": '{"type":"module"}',
        "buildkite.ts": await Bun.file(new URL("../../scripts/buildkite.ts", import.meta.url)).text(),
        "agent.ts": await Bun.file(new URL("../../scripts/agent.ts", import.meta.url)).text(),
        "sh": "",
        "pwsh": "",
        "diagnostic.mjs": `
          import assert from "node:assert/strict";
          import childProcess, { spawnSync } from "node:child_process";
          import { syncBuiltinESMExports } from "node:module";

          const commands = [];
          const stub = (file, args = []) => {
            commands.push([file, ...args]);
            return { status: 0, signal: null, stdout: "synthetic command output", stderr: "" };
          };
          childProcess.spawnSync = stub;
          syncBuiltinESMExports();
          assert.equal(spawnSync, stub);
          spawnSync("binding-marker");
          if (process.argv[2] === "Node") {
            assert.equal(process.release.name, "node");
            assert.equal(process.versions.bun, undefined);
          } else {
            assert.equal(typeof process.versions.bun, "string");
          }

          // Import only after the stub is bound: even the old logger must not run a network command.
          const { printEnvironment } = await import("./buildkite.ts");
          printEnvironment();
          console.log("DIAGNOSTIC_COMMANDS " + JSON.stringify(commands));
        `,
      });
      // Never inherit credentials into this regression, including its unfixed control.
      await using proc = Bun.spawn({
        cmd: [executable!, "diagnostic.mjs", runtime],
        cwd: String(dir),
        env: {
          CI: "true",
          GITHUB_ACTIONS: "true",
          GITHUB_REPOSITORY: "example/project",
          GITHUB_RUN_ID: "123",
          GITHUB_SHA: "synthetic-commit",
          GITHUB_REF_NAME: "synthetic-branch",
          GITHUB_WORKFLOW: "synthetic-workflow",
          RUNNER_NAME: "synthetic-runner",
          SYNTHETIC_SECRET: "diagnostic-secret-sentinel",
          SYNTHETIC_SETTING: "diagnostic-setting-sentinel",
          PATH: String(dir),
          HOME: String(dir),
          TMPDIR: String(dir),
          TEMP: String(dir),
          TMP: String(dir),
          BUN_DEBUG_QUIET_LOGS: "1",
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
      const commandLine = stdout.split("\n").find(line => line.startsWith("DIAGNOSTIC_COMMANDS "));
      const commands: string[][] = JSON.parse(commandLine?.slice("DIAGNOSTIC_COMMANDS ".length) ?? "[]");
      const identities = [
        "Hostname",
        "Tailscale IP",
        "Public IP",
        "Username",
        "Working Directory",
        "Temporary Directory",
      ];
      const resourceGroups =
        process.platform === "win32"
          ? ["Disk (win)", "Memory"]
          : process.platform === "linux" || process.platform === "android"
            ? ["Limits", "Disk (df)", "Memory", "Docker"]
            : ["Limits", "Disk (df)"];

      // Assert only a safe projection; a failure must not print the captured diagnostic output.
      expect({
        exitCode,
        signal: proc.signalCode,
        hasStderr: stderr.length > 0,
        leakedSentinel: ["diagnostic-secret-sentinel", "diagnostic-setting-sentinel", "synthetic-runner"].some(value =>
          stdout.includes(value),
        ),
        identityLabels: identities.filter(label => stdout.includes(label + ":")),
        environmentGroup: stdout.includes("::group::Environment"),
        retainedGroups: ["Machine", "Repository", "CI", ...resourceGroups].every(group =>
          stdout.includes("::group::" + group),
        ),
        platform: stdout.includes("Operating System:") && stdout.includes("Architecture:"),
        runtime: stdout.includes(runtime + " Version:"),
        commit: stdout.includes("Commit: synthetic-commit"),
        ci: stdout.includes("Build ID: 123") && stdout.includes("Build Label: synthetic-workflow"),
        stubBound: commands.some(([file]) => file === "binding-marker"),
        resourceCommand: commands.some(([, arg]) => arg === "-c"),
        networkCommand: commands.some(([file]) => /curl|tailscale/i.test(file)),
      }).toEqual({
        exitCode: 0,
        signal: null,
        hasStderr: false,
        leakedSentinel: false,
        identityLabels: [],
        environmentGroup: false,
        retainedGroups: true,
        platform: true,
        runtime: true,
        commit: true,
        ci: true,
        stubBound: true,
        resourceCommand: true,
        networkCommand: false,
      });
    });
  }
});

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
