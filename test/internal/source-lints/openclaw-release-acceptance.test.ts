import { test } from "bun:test";
import { bunEnv, bunExe, tempDir } from "harness";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { selectTests, windowsSmoke } from "../../../scripts/openclaw-ci/tests.ts";
import { acceptancePolicyPath, releaseAcceptance } from "../../../scripts/openclaw-release/acceptance-policy.mjs";
import {
  archiveEntrySha256,
  assertRuntime,
  candidatePin,
  capture,
  inside,
  nativeRegressions,
  privateEnvironment,
  sha256,
  sourceIdentity,
  testCounts,
} from "../../../scripts/openclaw-release/acceptance.mjs";

const fixture = callback => {
  using directory = tempDir("release-acceptance-test", {});
  return callback(String(directory));
};
const commit = "a".repeat(40),
  webkit = "b".repeat(40);

for (const os of ["darwin", "linux", "windows"])
  for (const arch of ["x64", "arm64"]) {
    test("native identity " + os + "-" + arch + " rejects other bytes/platform", () => {
      const facts = {
        platform: os === "windows" ? "win32" : os,
        arch,
        revision: commit,
        webkit,
      };
      assert.doesNotThrow(() => assertRuntime(facts, os + "-" + arch, commit, webkit));
      for (const key of ["platform", "arch", "revision", "webkit"])
        assert.throws(() => assertRuntime({ ...facts, [key]: "wrong" }, os + "-" + arch, commit, webkit));
    });
  }
test("invalid native target cannot inherit a valid platform prefix", () => {
  assert.throws(() => assertRuntime({}, "other-x64", commit, webkit));
});
test("full native and hook inventories are counted, not an exit-only pass", () => {
  assert.deepEqual(testCounts("\n 464 pass\n 0 fail\n", "bun"), {
    passed: 464,
    failed: 0,
    skipped: 0,
  });
  assert.deepEqual(testCounts("\n Tests  24 passed (24)\n", "vitest"), {
    passed: 24,
    failed: 0,
    skipped: 0,
  });
  assert.deepEqual(testCounts("\n 4 pass\n 2 skip\n 0 fail\n", "bun"), {
    passed: 4,
    failed: 0,
    skipped: 2,
  });
  for (const log of ["", "\n 0 pass\n 0 fail\n", "\n 4 pass\n 1 fail\n"]) assert.throws(() => testCounts(log, "bun"));
  assert.throws(() => testCounts(" Tests  24 passed | 1 failed", "vitest"));
});
test("Windows fixed selection includes all clone suites and keeps inherited coverage", () => {
  const selected = selectTests([], windowsSmoke, false, "windows");
  for (const suite of nativeRegressions) assert(selected.includes(suite));
  for (const suite of [
    "test/js/node/worker_threads/worker_threads.test.ts",
    "test/js/node/net/node-net.test.ts",
    "test/js/node/fs/fs.test.ts",
  ])
    assert(selected.includes(suite));
  assert.throws(
    () =>
      selectTests(
        [],
        windowsSmoke.filter(path => path !== nativeRegressions[0]),
        false,
        "windows",
      ),
    /Selected test is missing/,
  );
});
test("private environment strips tokens and closes temp aliases", () =>
  fixture(root => {
    const sentinels = {
      GH_TOKEN: "synthetic-token",
      SSH_AUTH_SOCK: "synthetic-agent",
      NODE_OPTIONS: "--import=synthetic-caller",
      BUN_OPTIONS: "--preload=synthetic-caller",
    };
    const saved = Object.fromEntries(Object.keys(sentinels).map(key => [key, process.env[key]]));
    try {
      Object.assign(process.env, sentinels);
      const env = privateEnvironment(root, root);
      for (const key of Object.keys(sentinels)) assert.equal(env[key], undefined, key);
      assert.equal(env.CI, "true");
      for (const key of ["TMP", "TEMP", "TMPDIR", "HOME", "OPENCLAW_STATE_DIR"]) assert(inside(root, env[key]));
    } finally {
      for (const [key, value] of Object.entries(saved))
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
  }));
test("private path check rejects a symlink to a different temp root", () =>
  fixture(root =>
    fixture(other => {
      symlinkSync(other, join(root, "escape"), process.platform === "win32" ? "junction" : "dir");
      assert.throws(() => inside(root, join(root, "escape")), /escapes/);
    }),
  ));
test("candidate pin binds archive and executable without mutating original or siblings", () =>
  fixture(root => {
    const archive = join(root, "archive"),
      exe = join(root, "bun");
    writeFileSync(archive, "archive");
    writeFileSync(exe, "executable");
    const original = {
      revision: "old",
      artifacts: {
        "darwin-arm64": { asset: "bun.zip" },
        "linux-x64": { executableSha256: "old" },
      },
    };
    const pin = candidatePin(
      original,
      "1.4.4+abcdef012",
      "darwin-arm64",
      archive,
      exe,
      "candidate-tag",
      "abcdef012" + "0".repeat(31),
    );
    assert.equal(original.revision, "old");
    assert.equal(pin.artifacts["darwin-arm64"].sha256, sha256(archive));
    assert.equal(pin.artifacts["darwin-arm64"].executableSha256, sha256(exe));
    assert.deepEqual(pin.artifacts["linux-x64"], original.artifacts["linux-x64"]);
    assert.equal(pin.tag, "candidate-tag");
    assert.equal(pin.commit, "abcdef012" + "0".repeat(31));
    assert.throws(
      () => candidatePin(original, "1.4.4+abcdef012", "darwin-arm64", archive, exe, "candidate-tag", "b".repeat(40)),
      /commit does not match/,
    );
    assert.throws(() => candidatePin(original, "nonsense", "darwin-arm64", archive, exe));
    assert.throws(() => candidatePin(original, "1.4.4+abcdef012", "windows-arm64", archive, exe));
  }));
test("real subprocess failures retain hashed evidence and cannot pass", () =>
  fixture(root => {
    assert.throws(
      () =>
        capture(
          "failure",
          process.execPath,
          ["-e", "console.error('intentional-fixture-failure');process.exit(7)"],
          root,
          process.env,
          root,
        ),
      /failure failed/,
    );
    const record = JSON.parse(readFileSync(join(root, "failure.json")));
    assert.equal(record.exit, 7);
    assert.equal(record.logSha256, sha256(record.log));
    assert.match(readFileSync(record.log, "utf8"), /intentional-fixture-failure/);
  }));
test("source gate refuses abbreviated commits before starting a runtime", () =>
  fixture(root => {
    assert.throws(() => sourceIdentity(root, "abc123"), /full source commit/);
  }));

test("archive entry hash binds bytes and refuses a missing entry", async () => {
  using directory = tempDir("release-archive-test", {});
  const root = String(directory);
  {
    const archive = join(root, "runtime.zip"),
      exe = join(root, "bun");
    writeFileSync(
      archive,
      Buffer.from(
        "UEsDBBQAAAAAAKimUl0sYOVICAAAAAgAAAADAAAAYnVuYXJ0aWZhY3RQSwECFAMUAAAAAACoplJdLGDlSAgAAAAIAAAAAwAAAAAAAAAAAAAAgAEAAAAAYnVuUEsFBgAAAAABAAEAMQAAACkAAAAAAA==",
        "base64",
      ),
    );
    writeFileSync(exe, "artifact");
    assert.equal(await archiveEntrySha256(archive, "bun", process.env), sha256(exe));
    writeFileSync(exe, "different bytes");
    assert.notEqual(await archiveEntrySha256(archive, "bun", process.env), sha256(exe));
    await assert.rejects(archiveEntrySha256(archive, "missing", process.env), /extraction failed/);
  }
});
test("escaped temp root is rejected before resolver or payload execution", () =>
  fixture(root =>
    fixture(other => {
      const env = privateEnvironment(root, root);
      env.TMPDIR = other;
      env.NODE_OPTIONS =
        "--import=" + new URL("../../../scripts/openclaw-release/private-preflight.mjs", import.meta.url).href;
      env.BUN_OPTIONS =
        "--preload=" + new URL("../../../scripts/openclaw-release/private-preflight.mjs", import.meta.url).href;
      const result = spawnSync(process.execPath, ["-e", "require('node:fs').writeFileSync('payload-ran','bad')"], {
        cwd: root,
        env,
        encoding: "utf8",
      });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /Unsafe acceptance path/);
      assert.equal(existsSync(join(root, "payload-ran")), false);
    }),
  ));

const pipeline = fileURLToPath(new URL("../../../", import.meta.url));
const workflow = Bun.YAML.parse(readFileSync(join(pipeline, ".github/workflows/openclaw-release.yml"), "utf8"));

async function withReleaseSource(policy, callback) {
  using directory = tempDir("acceptance-route", {});
  const root = String(directory),
    source = join(root, "source");
  mkdirSync(join(source, "scripts/build/deps"), { recursive: true });
  mkdirSync(join(source, "scripts/openclaw-release"), { recursive: true });
  writeFileSync(join(source, "package.json"), JSON.stringify({ version: "1.4.4" }));
  writeFileSync(join(source, "scripts/build/deps/webkit-artifacts.json"), JSON.stringify({ version: webkit }));
  if (policy !== undefined) writeFileSync(join(source, acceptancePolicyPath), JSON.stringify(policy));
  const git = (...args) => {
    const run = spawnSync("git", ["-C", source, "-c", "core.hooksPath=/dev/null", ...args], {
      env: {
        ...bunEnv,
        GIT_AUTHOR_NAME: "Release fixture",
        GIT_AUTHOR_EMAIL: "fixture@example.invalid",
        GIT_COMMITTER_NAME: "Release fixture",
        GIT_COMMITTER_EMAIL: "fixture@example.invalid",
      },
      encoding: "utf8",
    });
    assert.equal(run.status, 0, run.stderr);
    return run.stdout.trim();
  };
  git("init", "-b", "main");
  git("add", ".");
  git("commit", "--no-gpg-sign", "-m", "release fixture");
  const sha = git("rev-parse", "HEAD");
  const tagRun = spawnSync(
    bunExe(),
    [join(pipeline, "scripts/openclaw-release/release.ts"), "tag", "--source", source],
    { env: bunEnv, encoding: "utf8" },
  );
  assert.equal(tagRun.status, 0, tagRun.stderr);
  const tag = tagRun.stdout.trim();
  git("tag", tag);
  git("update-ref", "refs/remotes/origin/main", sha);
  symlinkSync(pipeline, join(root, "pipeline"), process.platform === "win32" ? "junction" : "dir");
  const run = async ({ event = "push", input = "", publish = true, windows = true, targets = "" } = {}) => {
    await using child = Bun.spawn(
      ["bash", "-e", "-o", "pipefail", "-c", workflow.jobs.plan.steps.find(step => step.id === "plan").run],
      {
        cwd: root,
        env: {
          ...bunEnv,
          PATH: join(bunExe(), "..") + (process.platform === "win32" ? ";" : ":") + bunEnv.PATH,
          GITHUB_EVENT_NAME: event,
          RELEASE_TAG: tag,
          PUBLISH: String(publish),
          WINDOWS_SIGNED: String(windows),
          ACCEPTANCE_INPUT: input,
          TARGETS: targets,
          GITHUB_OUTPUT: undefined,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, stderr, status] = await Promise.all([child.stdout.text(), child.stderr.text(), child.exited]);
    return { stdout, stderr, status };
  };
  await callback({ source, sha, run });
}

test.concurrent(
  "tag-push plan supplies immutable policy, requires six targets, and refuses competing dispatch before build",
  async () => {
    await withReleaseSource({ consumerCommit: commit }, async ({ source, sha, run }) => {
      const pushed = await run();
      assert.equal(pushed.status, 0, pushed.stderr);
      assert.match(pushed.stdout, new RegExp("^acceptance-ref=" + commit + "$", "m"));
      const matrix = JSON.parse(
        pushed.stdout
          .split("\n")
          .find(line => line.startsWith("matrix="))
          .slice(7),
      );
      assert.equal(matrix.length, 6);
      assert.equal(
        matrix.filter(row => row.target.startsWith("windows")).every(row => row.artifact === "signed-windows"),
        true,
      );
      // An uncommitted policy cannot alter the released commit's acceptance source.
      writeFileSync(join(source, acceptancePolicyPath), JSON.stringify({ consumerCommit: webkit }));
      assert.equal(releaseAcceptance(source, sha).ref, commit);
      await Promise.all(
        ["", commit].map(async input => {
          const competing = await run({ event: "workflow_dispatch", input });
          assert.notEqual(competing.status, 0);
          assert.match(competing.stderr, /requires tag-push publication/);
          assert.equal(competing.stdout.includes("matrix="), false);
        }),
      );
      await Promise.all(
        [webkit, "main", "abc123"].map(async input => {
          const mismatch = await run({ input });
          assert.notEqual(mismatch.status, 0);
          assert.match(mismatch.stderr, /immutable commit|disagrees/);
          assert.equal(mismatch.stdout.includes("matrix="), false);
        }),
      );
      assert.match(pushed.stdout, /^build-release=true$/m);
      const [dry, unsigned, partial, pullRequest] = await Promise.all([
        run({ event: "workflow_dispatch", publish: false }),
        run({ windows: false }),
        run({ targets: "darwin-arm64" }),
        run({ event: "pull_request", publish: false }),
      ]);
      assert.equal(pullRequest.status, 0, pullRequest.stderr);
      assert.match(pullRequest.stdout, /^build-release=false$/m);
      assert.match(pullRequest.stdout, new RegExp("^acceptance-ref=" + commit + "$", "m"));
      assert.equal(dry.status, 0, dry.stderr);
      assert.match(dry.stdout, /^build-release=true$/m);
      assert.match(dry.stdout, new RegExp("^acceptance-ref=" + commit + "$", "m"));
      assert.notEqual(unsigned.status, 0);
      assert.match(unsigned.stderr, /all six signed/);
      assert.notEqual(partial.status, 0);
      assert.match(partial.stderr, /every release target/);
    });
  },
);

test.concurrent("ordinary source without policy preserves tag and publishing dispatch behavior", async () => {
  await withReleaseSource(undefined, async ({ run }) => {
    for (const event of ["push", "workflow_dispatch", "pull_request"]) {
      const ordinary = await run({ event, windows: false, publish: event !== "pull_request" });
      assert.equal(ordinary.status, 0, ordinary.stderr);
      assert.match(ordinary.stdout, /^acceptance-ref=$/m);
      assert.match(ordinary.stdout, /^build-release=true$/m);
      const optional = await run({ event, input: commit, windows: false, publish: event !== "pull_request" });
      assert.equal(optional.status, 0, optional.stderr);
      assert.match(optional.stdout, new RegExp("^acceptance-ref=" + commit + "$", "m"));
    }
  });
});

test.concurrent("malformed committed policy refuses even an omitted dispatch input", async () => {
  await withReleaseSource({ consumerCommit: "main" }, async ({ run }) => {
    const result = await run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Invalid committed consumer/);
    assert.equal(result.stdout.includes("matrix="), false);
  });
});

test("publication retains final-artifact acceptance and signing dependencies", () => {
  const jobs = workflow.jobs;
  assert.equal(jobs.plan.outputs["acceptance-ref"], "${{ steps.plan.outputs.acceptance-ref }}");
  assert.equal(jobs.smoke.env.ACCEPTANCE_REF, "${{ needs.plan.outputs.acceptance-ref }}");
  assert.equal(jobs.plan.outputs["build-release"], "${{ steps.plan.outputs.build-release }}");
  assert.equal(jobs.build.if, "needs.plan.outputs.build-release == 'true'");
  assert(jobs.smoke.needs.includes("sign-macos"));
  assert(jobs.smoke.needs.includes("sign-windows"));
  assert(jobs.manifest.needs.includes("smoke"));
  assert.match(jobs.manifest.if, /needs.smoke.result == 'success'/);
  assert(jobs.publish.needs.includes("manifest"));
  assert.match(jobs.publish.if, /needs.manifest.result == 'success'/);
  const acceptance = jobs.smoke.steps.find(step => step.name === "LAND175276 final-artifact acceptance");
  assert.equal(acceptance.if, "env.ACCEPTANCE_REF != ''");
  assert.equal(acceptance["continue-on-error"], undefined);
  assert(acceptance.run.includes('--consumer-commit "$ACCEPTANCE_REF"'));
  assert(acceptance.run.includes('--archive "dist/$TRIPLET.zip"'));
});

for (const runtime of ["node", "bun"])
  for (const group of ["sync", "async"]) {
    test(
      "private descendant API contracts: " + runtime + ":" + group,
      () =>
        fixture(root => {
          // Unit CI has no OpenClaw checkout. Local acceptance supplies the exact real
          // consumer; the unit resolver tests only the wrapper's API contract.
          const consumer = process.env.LAND175276_CONSUMER ?? join(root, "consumer");
          if (!process.env.LAND175276_CONSUMER) {
            mkdirSync(join(consumer, "scripts"), { recursive: true });
            mkdirSync(join(consumer, "src/infra"), { recursive: true });
            writeFileSync(join(consumer, "package.json"), '{"type":"module"}');
            writeFileSync(join(consumer, "scripts/tsx.mjs"), "");
            writeFileSync(
              join(consumer, "src/infra/update-managed-service-handoff-lease.ts"),
              'import {join} from "node:path";export const resolveManagedUpdateLeaseDatabasePath=()=>join(process.env.OPENCLAW_STATE_DIR,"unit-resolver.sqlite");',
            );
          }
          const env = privateEnvironment(root, consumer);
          const preload = new URL("../../../scripts/openclaw-release/private-preflight.mjs", import.meta.url).href;
          env.NODE_OPTIONS = "--import=" + preload;
          env.BUN_OPTIONS = "--preload=" + preload;
          const node = spawnSync("node", ["-p", "process.execPath"], { env, encoding: "utf8" });
          assert.equal(node.status, 0, node.stderr);
          env.CONTRACT_NODE = node.stdout.trim();
          env.CONTRACT_FORK = join(root, "fork.cjs");
          writeFileSync(
            env.CONTRACT_FORK,
            'console.log(JSON.stringify({pid:process.pid,cwd:process.cwd(),marker:process.env.CONTRACT_MARKER}));console.error("child-stderr");',
          );
          const run = spawnSync(
            runtime === "node" ? env.CONTRACT_NODE : bunExe(),
            [fileURLToPath(new URL("./fixtures/private-preflight-contract.mjs", import.meta.url)), group],
            { cwd: root, env, encoding: "utf8", timeout: 90000, maxBuffer: 4 * 1024 * 1024 },
          );
          assert.equal(run.error, undefined);
          const report = JSON.parse(run.stdout.trim());
          assert.deepEqual(
            report.results.filter(result => !result.ok),
            [],
            run.stdout + "\n" + run.stderr,
          );
          assert.equal(run.status, 0, run.stderr);
          assert(readdirSync(join(root, "preflights")).length > 10);
        }),
      100000,
    );
  }
