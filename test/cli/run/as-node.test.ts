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
  describe.each([false, true])("post-script separators, node alias = %s", asNode => {
    test.each([
      { args: ["--"], pre: [] },
      { args: ["--", "--", "sentinel"], pre: [] },
      { args: ["--", "sentinel"], pre: ["--"] },
      { args: ["--", "sentinel"], pre: ["--import", "./preload.mjs"] },
      { args: ["--", "sentinel"], pre: ["--import", "data:text/javascript,globalThis.preloaded=true"] },
    ])("preserves $args after $pre", async ({ args, pre }) => {
      using dir = tempDir("script-separator", {
        "entry.mjs": "console.log(JSON.stringify({ args: process.argv.slice(2), preloaded: !!globalThis.preloaded }))",
        "preload.mjs": "globalThis.preloaded = true;",
      });
      await using proc = Bun.spawn({
        cmd: [bunExe(), ...pre, "entry.mjs", ...args],
        ...(asNode ? { argv0: "node" } : {}),
        cwd: String(dir),
        env: bunEnv,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
      expect(JSON.parse(stdout)).toEqual({ args, preloaded: pre[0] === "--import" });
      expect(stderr).toBe("");
      expect(exitCode).toBe(0);
    });
  });

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

describe("Node heap limit", () => {
  const fixture = join(import.meta.dir, "heap-limit-fixture.cjs");
  const completedWorker = { events: ["exit"], messages: ["completed"], code: 0 };
  const exhaustedWorker = {
    events: ["error", "exit"],
    messages: [],
    code: 1,
    error: {
      name: "Error",
      code: "ERR_WORKER_OUT_OF_MEMORY",
      message: "Worker terminated due to reaching memory limit: JS heap out of memory",
    },
  };

  async function runHeap(flags: string[], mode: string, options: Record<string, unknown> = {}, nodeOptions = "") {
    const argv = [bunExe(), "--expose-gc", ...flags, fixture, mode, JSON.stringify(options)];
    // Intentional OOM aborts must not fill CI disks with core dumps; descendants inherit the limit.
    const cmd = process.platform === "win32" ? argv : ["/bin/sh", "-c", 'ulimit -c 0 && exec "$@"', "--", ...argv];
    await using proc = Bun.spawn({
      cmd,
      env: {
        ...bunEnv,
        NODE_OPTIONS: nodeOptions,
        BUN_OPTIONS: undefined,
        BUN_ENABLE_CRASH_REPORTING: "0",
        BUN_CRASH_REPORT_URL: "",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
    return { stdout, stderr, exitCode, signal: proc.signalCode };
  }

  test("the allocation fixture uses full GC in both main and worker VMs", async () => {
    const result = await runHeap([], "gc-api");
    expect(JSON.parse(result.stdout)).toEqual({
      gcApi: "Bun.gc(true)",
      worker: { events: ["exit"], messages: ["Bun.gc(true)"], code: 0 },
    });
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
  });

  test.each([
    "--max-old-space-size=32",
    "--max_old_space_size=32",
    "--max-old_space-size=32",
    "--max-old-space-size=17592186044448",
  ])("%s enforces a lower command-line cap than NODE_OPTIONS", async flag => {
    const result = await runHeap([flag], "arrays", { mib: 80 }, "--max-old-space-size=128");
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("JavaScript heap out of memory");
    if (process.platform === "win32") expect(result.exitCode).toBe(134);
    else expect(result.signal).toBe("SIGABRT");
  });

  test("NODE_OPTIONS alone enforces the heap cap", async () => {
    const result = await runHeap([], "arrays", { mib: 80 }, "--max-old-space-size=32");
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("JavaScript heap out of memory");
    if (process.platform === "win32") expect(result.exitCode).toBe(134);
    else expect(result.signal).toBe("SIGABRT");
  });

  test.each([
    ["under limit", ["--max-old-space-size=128"], "arrays", 64, ""],
    ["wrapped nonzero limit", ["--max-old-space-size=17592186044544"], "arrays", 64, ""],
    ["last alias wins", ["--max-old-space-size=32", "--max_old_space_size=128"], "arrays", 64, ""],
    ["zero overrides environment", ["--max-old-space-size=0"], "arrays", 64, "--max-old-space-size=32"],
    ["short-lived allocations", ["--max-old-space-size=32"], "churn", 128, ""],
    ["ArrayBuffer exclusion", ["--max-old-space-size=32"], "buffers", 128, ""],
  ] as const)("%s", async (_name, flags, mode, mib, nodeOptions) => {
    const result = await runHeap([...flags], mode, { mib }, nodeOptions);
    expect({ stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode }).toEqual({
      stdout: "completed\n",
      stderr: "",
      exitCode: 0,
    });
  });

  test.each([
    ["process cap overrides smaller resourceLimits", 128, { resource: 16, mib: 64 }, completedWorker],
    ["process cap overrides larger resourceLimits", 32, { resource: 128, mib: 80 }, exhaustedWorker],
    ["empty execArgv retains process cap", 32, { resource: 128, mib: 80, emptyExecArgv: true }, exhaustedWorker],
    [
      "worker environment cannot raise process cap",
      32,
      { resource: 128, mib: 80, workerEnv: "--max-old-space-size=128" },
      exhaustedWorker,
    ],
    ["zero restores resourceLimits", 0, { resource: 16, mib: 80 }, exhaustedWorker],
    [
      "nested worker retains process cap",
      128,
      { resource: 16, mib: 64, nested: true },
      { events: ["exit"], messages: [completedWorker], code: 0 },
    ],
  ] as const)("%s", async (_name, cap, options, expected) => {
    const result = await runHeap([`--max-old-space-size=${cap}`], "worker", options);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual(expected);
    expect(result.exitCode).toBe(0);
  });

  test.each([
    ["fork inherits CLI", { fork: true }, "oom"],
    ["fork can clear execArgv", { fork: true, emptyExecArgv: true }, "completed"],
    ["execFile-style spawn inherits environment only", {}, "completed"],
    ["fork retains CLI with cleared environment", { fork: true, clearEnv: true }, "oom"],
  ] as const)("%s", async (_name, options, expected) => {
    const result = await runHeap(
      ["--max-old-space-size=32"],
      "child",
      { ...options, mib: 80 },
      "--max-old-space-size=128",
    );
    expect({ stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode }).toEqual({
      stdout: `${expected}\n`,
      stderr: "",
      exitCode: 0,
    });
  });

  test.each(["--max-old-space-size=32", "--max_old_space_size=32"])(
    "explicit Worker execArgv rejects %s",
    async flag => {
      const result = await runHeap([], "invalid-worker", { flag });
      expect({ stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode }).toEqual({
        stdout: "rejected\n",
        stderr: "",
        exitCode: 0,
      });
    },
  );

  test.each(["--max-old-space-size=oops", "--max-old-space-size=32.5", "--max-old-space-size"])(
    "rejects %s",
    async flag => {
      const result = await runHeap([flag], "argv");
      expect(result.stdout).toBe("");
      expect(result.exitCode).toBe(9);
    },
  );

  test.each(["-1", "18446744073709551615"])("out-of-range %s preserves the prior cap", async value => {
    const result = await runHeap(["--max-old-space-size=32", `--max-old-space-size=${value}`], "arrays", { mib: 80 });
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("out of bounds");
    expect(result.stderr).toContain("JavaScript heap out of memory");
    if (process.platform === "win32") expect(result.exitCode).toBe(134);
    else expect(result.signal).toBe("SIGABRT");
  });

  test("NODE_OPTIONS flags stay out of execArgv", async () => {
    const result = await runHeap(["--max_old_space_size=128"], "argv", {}, "--max-old-space-size=32");
    expect(JSON.parse(result.stdout)).toEqual(["--expose-gc", "--max_old_space_size=128"]);
    expect(result.exitCode).toBe(0);
  });

  test("a positive limit wrapping to zero is exhausted, not the default", async () => {
    const result = await runHeap(["--max-old-space-size=17592186044416"], "argv");
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("JavaScript heap out of memory");
    if (process.platform === "win32") expect(result.exitCode).toBe(134);
    else expect(result.signal).toBe("SIGABRT");
  });

  test("heap limits do not prevent help before VM initialization", async () => {
    await using proc = Bun.spawn({
      cmd: [bunExe(), "--max-old-space-size=17592186044416", "--help"],
      env: { ...bunEnv, NODE_OPTIONS: undefined, BUN_OPTIONS: undefined },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
    expect(stdout).toContain("Usage:");
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
  });

  test("a capped main VM detaches its observer during teardown", async () => {
    await using proc = Bun.spawn({
      cmd: [bunExe(), "--expose-gc", "--max-old-space-size=128", fixture, "arrays", '{"mib":8}'],
      env: { ...bunEnv, NODE_OPTIONS: undefined, BUN_OPTIONS: undefined, BUN_DESTRUCT_VM_ON_EXIT: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
    expect({ stdout, stderr, exitCode }).toEqual({ stdout: "completed\n", stderr: "", exitCode: 0 });
  });
});
