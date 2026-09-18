import { describe, expect, test } from "bun:test";
import { join } from "path";
import { bunEnv, bunExe, fakeNodeRun, tempDir } from "../../harness";

async function runNodeAlias(args: string[], stdin = "", files: Record<string, string> = {}) {
  using temp = tempDir("fake-node-stdio", files);
  await using proc = Bun.spawn({
    cmd: [bunExe(), ...args],
    argv0: "node",
    cwd: String(temp),
    env: bunEnv,
    stdin: Buffer.from(stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
  return { stdout, stderr, exitCode };
}

describe("fake node cli", () => {
  test("the node cli actually works", () => {
    using temp = tempDir("fake-node", {
      "index.ts": "console.log(Bun.version)",
    });
    expect(fakeNodeRun(temp, join(temp, "index.ts")).stdout).toBe(Bun.version);
  });
  test("doesnt resolve bins", () => {
    using temp = tempDir("fake-node", {
      "vite.js": "console.log('pass')",
      "node_modules/.bin/vite": "#!/usr/bin/sh\necho fail && exit 1",
    });
    expect(fakeNodeRun(temp, "vite").stdout).toBe("pass");
  });
  test("doesnt resolve scripts", () => {
    using temp = tempDir("fake-node", {
      "vite.js": "console.log('pass')",
      "package.json": '{"scripts":{"vite":"echo fail && exit 1"}}',
    });
    expect(fakeNodeRun(temp, "vite").stdout).toBe("pass");
  });
  test("can run a script named run.js", () => {
    using temp = tempDir("fake-node", {
      "run.js": "console.log('pass')",
      "run/index.js": "console.log('fail')",
      "node_modules/run/index.js": "console.log('fail')",
    });
    expect(fakeNodeRun(temp, "run").stdout).toBe("pass");
  });
  describe("entrypoint file extension picking", () => {
    // Bun supports JSX and TS, and node doesnt, so our behavior here differs a bit
    // Hopefully these priorization rules will not break any node apps.
    test("picks tsx over any other ext", () => {
      using temp = tempDir("fake-node", {
        "build.js": "console.log('fail (build.js)')",
        "build.jsx": "console.log('fail (build.jsx)')",
        "build.cjs": "console.log('fail (build.cjs)')",
        "build.mjs": "console.log('fail (build.mjs)')",
        "build.ts": "console.log('fail (build.ts)')",
        "build.cts": "console.log('fail (build.cts)')",
        "build.mts": "console.log('fail (build.mts)')",
        "build.tsx": "console.log('pass')",
      });
      expect(fakeNodeRun(temp, "build").stdout).toBe("pass");
    });
    test("picks jsx over ts", () => {
      using temp = tempDir("fake-node", {
        "build.js": "console.log('fail (build.js)')",
        "build.jsx": "console.log('pass')",
        "build.cjs": "console.log('fail (build.cjs)')",
        "build.mjs": "console.log('fail (build.mjs)')",
        "build.ts": "console.log('fail (build.ts)')",
        "build.cts": "console.log('fail (build.cts)')",
        "build.mts": "console.log('fail (build.mts)')",
      });
      expect(fakeNodeRun(temp, "build").stdout).toBe("pass");
    });
    test("picks mts over ts", () => {
      using temp = tempDir("fake-node", {
        "build.js": "console.log('fail (build.js)')",
        "build.cjs": "console.log('fail (build.cjs)')",
        "build.mjs": "console.log('fail (build.mjs)')",
        "build.ts": "console.log('fail (build.ts)')",
        "build.cts": "console.log('fail (build.cts)')",
        "build.mts": "console.log('pass')",
      });
      expect(fakeNodeRun(temp, "build").stdout).toBe("pass");
    });
    test("picks ts over js/cjs/etc", () => {
      using temp = tempDir("fake-node", {
        "build.js": "console.log('fail (build.js)')",
        "build.cjs": "console.log('fail (build.cjs)')",
        "build.mjs": "console.log('fail (build.mjs)')",
        "build.ts": "console.log('pass')",
        "build.cts": "console.log('fail (build.cts)')",
      });
      expect(fakeNodeRun(temp, "build").stdout).toBe("pass");
    });
  });

  test("node -e ", () => {
    using temp = tempDir("fake-node", {});
    expect(fakeNodeRun(temp, ["-e", "console.log('pass')"]).stdout).toBe("pass");
  });

  describe.each(["-e", "--eval", "-p", "--print"])("node %s arguments", flag => {
    // Debug launchers recreate a shared node-shim directory.
    test.each([
      { args: [], expected: [] },
      { args: ["42"], expected: ["42"] },
      { args: ["first", "second"], expected: ["first", "second"] },
      { args: ["", "second"], expected: ["", "second"] },
      { args: ["--", "first", "second"], expected: ["first", "second"] },
    ])("preserves $args", async ({ args, expected }) => {
      using temp = tempDir("fake-node-eval-args", {});
      const expression = "JSON.stringify(process.argv.slice(1))";
      const source = flag === "-p" || flag === "--print" ? expression : `console.log(${expression})`;
      await using proc = Bun.spawn({
        cmd: [bunExe(), "--bun", "node", flag, source, ...args],
        cwd: String(temp),
        env: bunEnv,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
      expect({ stdout, stderr, exitCode }).toEqual({
        stdout: `${JSON.stringify(expected)}\n`,
        stderr: "",
        exitCode: 0,
      });
    });
  });

  test("process args work", () => {
    using temp = tempDir("fake-node", {
      "index.js": "console.log(JSON.stringify(process.argv.slice(1)))",
    });
    expect(fakeNodeRun(temp, ["index", "a", "b", "c"]).stdout).toBe(
      // note: no extension here is INTENTIONAL
      JSON.stringify([join(temp, "index"), "a", "b", "c"]),
    );
  });

  test.each([
    { args: ["-v"] },
    { args: ["--version"] },
    { args: ["--no-warnings", "-v"] },
    { args: ["--no-warnings", "--version"] },
  ])("reports the Node compatibility version for $args", async ({ args }) => {
    expect(await runNodeAlias(args)).toEqual({
      stdout: `v${process.versions.node}\n`,
      stderr: "",
      exitCode: 0,
    });
  });

  test.each([
    { args: ["--revision"] },
    { args: ["--revision", "entry.cjs"] },
    { args: ["--revision", "-e", 'console.log("eval ran")'] },
  ])("rejects Bun-only revision before executing $args", async ({ args }) => {
    expect(
      await runNodeAlias(args, 'console.log("stdin ran")', {
        "entry.cjs": 'console.log("script ran")',
      }),
    ).toEqual({ stdout: "", stderr: "error: Invalid Argument '--revision'\n", exitCode: 1 });
  });

  test("passes revision after the script name through to the script", async () => {
    expect(
      await runNodeAlias(["entry.cjs", "--revision"], "", {
        "entry.cjs": "console.log(JSON.stringify(process.argv.slice(2)))",
      }),
    ).toEqual({ stdout: '["--revision"]\n', stderr: "", exitCode: 0 });
  });

  test("Node help advertises version without the rejected revision flag", async () => {
    const { stdout, stderr, exitCode } = await runNodeAlias(["--help"]);
    expect(stdout).toContain("--version");
    expect(stdout).not.toContain("--revision");
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
  });

  test.each([
    { args: [], source: "", expected: "" },
    { args: ["-"], source: "", expected: "" },
    {
      args: [],
      source: "console.log(JSON.stringify(process.argv.slice(1)))",
      expected: "[]\n",
    },
    {
      args: ["-", "first", "second"],
      source: "console.log(JSON.stringify(process.argv.slice(1)))",
      expected: '["-","first","second"]\n',
    },
    {
      args: ["--input-type=module"],
      source:
        'import { basename } from "node:path"; console.log(basename("/fixture/input"), JSON.stringify(process.argv.slice(1)))',
      expected: "input []\n",
    },
    {
      args: ["--input-type=module", "-", "first", "--literal"],
      source:
        'import { basename } from "node:path"; console.log(basename("/fixture/input"), JSON.stringify(process.argv.slice(1)))',
      expected: 'input ["-","first","--literal"]\n',
    },
    {
      args: ["--input-type=commonjs"],
      source:
        'const { basename } = require("node:path"); console.log(basename("/fixture/input"), JSON.stringify(process.argv.slice(1)))',
      expected: "input []\n",
    },
  ])("executes stdin with $args", async ({ args, source, expected }) => {
    expect(await runNodeAlias(args, source)).toEqual({ stdout: expected, stderr: "", exitCode: 0 });
  });

  test("empty eval takes precedence over piped source", async () => {
    expect(await runNodeAlias(["-e", ""], 'throw new Error("stdin must not run")')).toEqual({
      stdout: "",
      stderr: "",
      exitCode: 0,
    });
  });

  test("runs preloads before empty stdin", async () => {
    expect(
      await runNodeAlias(["--require", "./preload.cjs"], "", {
        "preload.cjs": 'console.log("preload", JSON.stringify(process.argv.slice(1)))',
      }),
    ).toEqual({ stdout: "preload []\n", stderr: "", exitCode: 0 });
  });
});
