const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

// Exercise the actual API-only workflow block without credentials or network access.
const workflow = fs.readFileSync(path.join(__dirname, "../workflows/sync-upstream.yml"), "utf8");
const blocks = workflow.split("          script: |\n");
assert.equal(blocks.length, 2);
const script = blocks[1].split("\n").map(line => {
  assert.ok(!line || line.startsWith("            "));
  return line.slice(12);
}).join("\n");
const run = new (Object.getPrototypeOf(async function () {}).constructor)("github", "core", "context", script);

const sha = n => n.toString(16).padStart(40, "0");
const branch = "automation/sync-upstream";
const mergedPR = head => ({
  merged_at: "2026-09-25",
  head: { sha: head, ref: branch, repo: { full_name: "openclaw/bun" } },
  base: { ref: "main", repo: { full_name: "openclaw/bun" } },
});

function fixture(options = {}) {
  const nodes = new Map([[sha(1), []], [sha(2), [sha(1)]], [sha(3), [sha(1)]]]);
  const refs = new Map([["heads/main", sha(2)]]);
  if (options.branch) refs.set(`heads/${branch}`, options.branch);
  if (options.contained) nodes.set(sha(2), [sha(3)]);
  const calls = [];
  const writes = [];
  const summaries = [];
  const failures = [];
  let next = 10;
  const ancestor = (base, head) => base === head || (nodes.get(head) || []).some(parent => ancestor(base, parent));
  const failure = status => Object.assign(new Error(`API status ${status}`), { status });
  const github = { rest: {
    pulls: {
      list: async args => {
        calls.push(["pulls.list", args]);
        const data = args.state === "open" ? options.pending || [] : options.previous || [];
        return { data: data.filter(pr => !args.base || !pr.base || pr.base.ref === args.base) };
      },
      create: async args => {
        writes.push(["pulls.create", args]);
        if (options.prError) throw failure(options.prError);
        return { data: {
          html_url: "https://github.com/openclaw/bun/pull/99",
          head: { sha: refs.get(`heads/${branch}`), ref: branch, repo: { full_name: "openclaw/bun" }, ...options.returnedHead },
          base: { ref: "main", repo: { full_name: "openclaw/bun" }, ...options.returnedBase },
        } };
      },
    },
    git: {
      getRef: async args => {
        calls.push(["git.getRef", args]);
        if (options.readError) throw failure(options.readError);
        if (!refs.has(args.ref)) throw failure(404);
        return { data: { object: { sha: refs.get(args.ref) } } };
      },
      createRef: async args => {
        writes.push(["git.createRef", args]);
        assert.equal(args.ref, `refs/heads/${branch}`);
        if (options.createError) throw failure(options.createError);
        refs.set(args.ref.slice(5), args.sha);
      },
    },
    repos: {
      getBranch: async args => {
        calls.push(["repos.getBranch", args]);
        assert.deepEqual(args, { owner: "oven-sh", repo: "bun", branch: "main" });
        return { data: { commit: { sha: sha(3) } } };
      },
      compareCommitsWithBasehead: async args => {
        const [base, head] = args.basehead.split("...");
        return { data: { status: base === head ? "identical" : ancestor(base, head) ? "ahead" : ancestor(head, base) ? "behind" : "diverged" } };
      },
      merge: async args => {
        writes.push(["repos.merge", args]);
        assert.equal(args.base, branch);
        if (args.head === sha(3) && options.mergeError) throw failure(options.mergeError);
        const before = refs.get(`heads/${branch}`);
        if (ancestor(args.head, before)) return { status: 204 };
        const merged = sha(next++);
        nodes.set(merged, [before, args.head]);
        refs.set(`heads/${branch}`, options.badAncestry ? sha(3) : merged);
        return { status: 201, data: { sha: merged } };
      },
    },
  } };
  const core = {
    info() {},
    setFailed(message) { failures.push(message); },
    summary: { addRaw(message) { summaries.push(message); return this; }, async write() {} },
  };
  return { nodes, refs, calls, writes, summaries, failures, ancestor, run: () => run(github, core, { runId: 7 }) };
}

test("only scheduled or manual main runs can mutate the fork; cancellation is disabled", () => {
  assert.match(workflow, /cron: "17 6 \* \* \*"/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /github.repository == 'openclaw\/bun' && github.ref == 'refs\/heads\/main'/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.doesNotMatch(workflow, /pull_request_target:|actions\/checkout@|force:|updateRef|deleteRef/);
});

test("creates one draft from frozen SHAs and preserves fork and upstream ancestry", async () => {
  const f = fixture();
  await f.run();
  assert.deepEqual(f.failures, []);
  assert.deepEqual(f.writes.map(([method]) => method), ["git.createRef", "repos.merge", "repos.merge", "pulls.create"]);
  assert.deepEqual(f.writes.filter(([method]) => method === "repos.merge").map(([, args]) => args.head), [sha(2), sha(3)]);
  assert.equal(f.refs.get("heads/main"), sha(2));
  const head = f.refs.get(`heads/${branch}`);
  assert.ok(f.ancestor(sha(2), head) && f.ancestor(sha(3), head));
  const pr = f.writes.at(-1)[1];
  assert.equal(pr.draft, true);
  assert.equal(pr.base, "main");
  assert.ok(pr.body.includes(head) && pr.body.includes(sha(2)) && pr.body.includes(sha(3)));
  assert.match(pr.body, /approve the generated PR workflow runs/);
});

for (const draft of [true, false]) test(`freezes an existing ${draft ? "draft" : "ready"} PR before inspecting or writing refs`, async () => {
  const f = fixture({ pending: [{ draft, html_url: "https://github.com/openclaw/bun/pull/98", head: { sha: sha(4) } }] });
  await f.run();
  assert.deepEqual(f.writes, []);
  assert.deepEqual(f.calls.map(([method]) => method), ["pulls.list"]);
  assert.match(f.summaries[0], /Review pending/);
});

test("a retargeted open PR still freezes its head", async () => {
  const f = fixture({ pending: [{ base: { ref: "release" }, html_url: "https://github.com/openclaw/bun/pull/98", head: { sha: sha(4) } }] });
  await f.run();
  assert.deepEqual(f.writes, []);
  assert.deepEqual(f.calls.map(([method]) => method), ["pulls.list"]);
  assert.match(f.summaries[0], /Review pending/);
});

test("already contained upstream is a visible no-op", async () => {
  const f = fixture({ contained: true });
  await f.run();
  assert.deepEqual(f.writes, []);
  assert.match(f.summaries[0], /No sync needed/);
});

test("reuses only a branch whose last PR merged and whose head is in main", async () => {
  const f = fixture({ branch: sha(1), previous: [mergedPR(sha(1))] });
  await f.run();
  assert.deepEqual(f.failures, []);
  assert.equal(f.writes[0][0], "repos.merge");
  assert.equal(f.writes[0][1].head, sha(2));
});

for (const options of [
  { branch: sha(1) },
  { branch: sha(3), previous: [mergedPR(sha(1))] },
  { branch: sha(3), previous: [mergedPR(sha(3))] },
]) test(`retains unknown or changed branch: ${JSON.stringify(options)}`, async () => {
  const f = fixture(options);
  await f.run();
  assert.deepEqual(f.writes, []);
  assert.match(f.failures[0], /Refusing to adopt/);
});

test("closed-unmerged review is not resurrected, even if its branch is absent", async () => {
  const f = fixture({ previous: [{ merged_at: null, html_url: "https://github.com/openclaw/bun/pull/98" }] });
  await f.run();
  assert.deepEqual(f.writes, []);
  assert.match(f.failures[0], /closed without merging/);
});

for (const merged_at of [null, "2026-09-25"]) test(`retargeted closed review is not bypassed (merged: ${!!merged_at})`, async () => {
  const pr = mergedPR(sha(1));
  pr.base.ref = "release";
  pr.merged_at = merged_at;
  const f = fixture({ previous: [pr] });
  await f.run();
  assert.deepEqual(f.writes, []);
  assert.equal(f.failures.length, 1);
});

for (const status of [403, 409, 422]) test(`merge error ${status} fails visibly without a PR, reset or retry`, async () => {
  const f = fixture({ mergeError: status });
  await f.run();
  assert.equal(f.failures.length, 1);
  assert.equal(f.writes.length, 3);
  assert.ok(f.summaries[0].includes(`API status ${status}`));
  assert.match(f.failures[0], status === 409 ? /Resolve the merge conflict/ : /Workflows write/);
  assert.equal(f.refs.get("heads/main"), sha(2));
});

test("failed ancestry verification cannot publish a misleading PR", async () => {
  const f = fixture({ badAncestry: true });
  await f.run();
  assert.match(f.failures[0], /Ancestry verification failed/);
  assert.ok(!f.writes.some(([method]) => method === "pulls.create"));
});

test("PR creation permission denial is not reported as successful sync", async () => {
  const f = fixture({ prError: 403 });
  await f.run();
  assert.equal(f.failures.length, 1);
  assert.match(f.failures[0], /repository PR permissions/);
});

test("read failures other than branch-not-found stop before mutation", async () => {
  const f = fixture({ readError: 503 });
  await f.run();
  assert.deepEqual(f.writes, []);
  assert.match(f.failures[0], /API status 503/);
});

test("branch creation failure stops before merging or opening a PR", async () => {
  const f = fixture({ createError: 422 });
  await f.run();
  assert.deepEqual(f.writes.map(([method]) => method), ["git.createRef"]);
  assert.equal(f.refs.has(`heads/${branch}`), false);
  assert.match(f.failures[0], /API status 422/);
});

for (const options of [
  { returnedHead: { sha: sha(99) } },
  { returnedHead: { ref: "different-branch" } },
  { returnedHead: { repo: { full_name: "another/bun" } } },
  { returnedBase: { ref: "release" } },
]) test(`PR readback drift fails visibly: ${JSON.stringify(options)}`, async () => {
  const f = fixture(options);
  await f.run();
  assert.equal(f.failures.length, 1);
  assert.match(f.failures[0], /changed before verification/);
  assert.ok(!f.summaries.some(message => message.startsWith("Created draft")));
  assert.equal(f.writes.at(-1)[0], "pulls.create");
});
