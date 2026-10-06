# OpenClaw build and test

[`openclaw-build-test.yml`](workflows/openclaw-build-test.yml) builds the PR merge
commit on `blacksmith-16vcpu-ubuntu-2404` (native Ubuntu 24.04 x64) and tests the new executable. Source, tests, build
scripts, native dependency inputs and this workflow trigger it; docs-only and
CHANGELOG-only PRs do not. New pushes cancel the superseded run. A nightly run
at 07:23 UTC tests `main`; manual dispatch tests the selected ref with the same
broader set.

The native x64 build uses `bun run build:release --lto=off`, the pinned prebuilt
WebKit, the LLVM release series and Rust/Node pins in `scripts/build/ci-images/spec.ts`.
It is a development release build against Ubuntu's native libraries, not the
portable, LTO-enabled binary from the separate release workflow. Its build
step has a 75-minute deadline. If warm builds reach that deadline, reassess the
runner before enabling this lane more broadly.

## Test selection

[`scripts/openclaw-ci/tests.ts`](../scripts/openclaw-ci/tests.ts) records the
exact selection in the run summary and `selected.json`. It reads the PR's
merge-base-to-head diff locally (including renames and deletions), while the
build and tests use GitHub's merge commit:

- Include every added or modified Bun `.test.*` or `.spec.*` file still present.
- For changed test fixtures, walk upward to the nearest directory containing
  tests and include those files. Deleted fixtures also select their owners.
- For `src/js/node/<module>` and `src/runtime/node/<module>`, include the
  corresponding `test/js/node/<module>/` tests.
- For shared native code, match child_process/subprocess/spawn to child_process;
  sockets/net/TLS/SSL and HTTP/Fetch to net, tls and http; filesystem code to fs;
  workers/process/environment to worker_threads and process; module/resolver/
  transpiler/compile-cache to module; SQLite to sqlite. These matches add the
  applicable files from the fixed and broader lists below.
- For changes to `scripts/build/deps/webkit.ts` or `webkit-artifacts.json`, run
  the fixed smoke, broader, and engine-sensitive suites on both native lanes.
  Darwin also retains its platform-specific tests.
- All other source changes still run the fixed smoke set. This is bounded
  compatibility coverage, not a complete dependency graph or the full upstream
  test suite. Extend the mapping when a new fork fix needs a different boundary.

The workflow invokes the built executable explicitly: `build.ts` ignores
trailing execution arguments in CI. A missing completed results file fails the
lane even if the test command exits zero. The upstream `scripts/runner.node.ts`
runs each file against the built binary
with crash isolation and its normal per-file deadlines. Vendor suites are off,
retries are zero, and the whole test step has a 20-minute deadline. A missing,
failed or expectation-skipped selected file fails the lane; the selection is
never truncated to fit the budget. A large upstream sync may need separate
full-suite qualification. Results, failures and per-file times appear in the
summary; diagnostics are retained for seven days even on failure.

When the net suite is selected, the lane also runs that file directly once and
records its runtime identity, exit status and output in `net-direct.json`.
Both the shared selection and this independent execution must pass, so a
grouped runner's internal recovery cannot be the sole net-suite proof.

### Every PR and nightly

```text
test/js/node/child_process/child-process-exec.test.ts
test/js/node/child_process/child-process-stdio.test.js
test/js/node/net/node-net-server.test.ts
test/js/node/net/node-net-allowHalfOpen.test.js
test/js/node/tls/node-tls-server.test.ts
test/js/node/http/node-http-server-close-drain.test.ts
test/js/node/http/node-http-server-abort-events.test.ts
test/js/node/fs/fs.test.ts
test/js/node/worker_threads/worker_threads.test.ts
test/js/node/module/node-module-module.test.js
test/js/bun/sqlite/sqlite.test.js
test/cli/run/run-process-env.test.ts
test/bundler/compile-node-compile-cache.test.ts
```

The worker suite covers `SHARE_ENV` and `process.env` identity; the module suite
covers compile-cache persistence, permissions, exit paths and module loading.

### Additional nightly/manual files

```text
test/js/node/child_process/child_process.test.ts
test/js/node/child_process/child_process_ipc.test.js
test/js/node/net/node-net.test.ts
test/js/node/tls/node-tls-connect.test.ts
test/js/node/tls/node-tls-wrapped-socket-close.test.ts
test/js/node/http/node-http.test.ts
test/js/node/http/node-http-server-socket-end-drain.test.ts
test/js/node/fs/promises.test.js
test/js/node/worker_threads/worker-transfer-list.test.ts
test/js/node/module/require-extensions.test.ts
test/js/node/process/process.test.js
test/js/bun/sqlite/column-types.test.js
```

The `vm.Script` leak regression checks live `Script` cells after collection and
collects between allocation batches. It measures RSS growth over all 10,000 scripts
after a separate 5,000-script cache and allocator warmup. It retains the 200 MiB release and 700 MiB ASAN limits; a deliberately
retained-script control must fail the live-cell assertion when qualifying changes
to this guard.

## Windows release qualification

The separate [`openclaw-release.yml`](workflows/openclaw-release.yml) keeps
Windows x64 and ARM64 test-only builds, smoke tests and compatibility lanes in
PRs and non-publishing dry runs. Publication defaults to the four Darwin/Linux
targets. The plan job reads `OPENCLAW_RELEASE_WINDOWS_SIGNED` once; only the
exact value `true` enables Windows publication and requires both architectures
with verified Foundation Authenticode signatures. Missing signing configuration
then fails the entire release; unsigned Windows artifacts are never published.

Before enabling the repository variable, configure the Azure OIDC secrets in
`release-signing` with federated credential subject
`repo:openclaw/bun:environment:release-signing`. See
[the release signing instructions](OPENCLAW_RELEASE.md#windows-signing-and-qualification).

## Caches and artifacts

The lane caches the build system's download/prebuilt/ccache directory, Rust
unit artifacts (`build/release/rust-target`) and Cargo registry/git downloads.
Rust compilation uses Ninja's direct rustc rules, so `RUSTC_WRAPPER=sccache`
would not help; this fork no longer builds Zig. ccache is pruned to 3 GiB before
saving. Keys include the platform, build scripts/toolchain pins and Cargo/Bun
lockfiles plus the complete checked-out Git tree, including workflow and
package scripts. Restores never cross that prefix: a code change builds cold;
an empty commit or rerun of the same tree can reuse compiled outputs. Each run saves a new key before
testing, so a failed test does not discard a successful build's cache. GitHub
scopes PR caches to the merge ref; nightly caches on main can seed runs of that same tree. PR
code gets no secrets, checkout credentials or write-capable repository token.

The build summary reports elapsed seconds and the matched cache key (or
`none`); the build also uploads its timing chart and ccache log. Compare a
first PR run with an empty-commit push on the same PR to measure cold and warm
builds. Source mtimes still invalidate native build outputs after checkout;
cache reuse does not bypass the build graph or reuse a finished executable.

The seven-day `bun-linux-x64-<merge SHA>-attempt<n>` artifact contains a tarball preserving
the executable bit, a SHA-256 checksum and the built commit. It is uploaded
before tests, so a failing test can be reproduced with the exact binary. Check
the run's test result before using it. Download the artifact, unpack the tarball
and use `./bun`; it requires Linux x64 with Ubuntu 24.04-compatible libraries.

The existing Blacksmith installation covers this repository, so the lane uses
its 16-vCPU Ubuntu 24.04 x64 runner without an app installation or settings
change. GitHub's `ubuntu-24.04` is the fallback if the owner later removes
Blacksmith access. Larger GitHub runners could not be enumerated with the
current token; no new runner or runner group is provisioned. Neither the sync
nor release workflow changes.

## Initial measurements and known failure

On the 16-vCPU Blacksmith runner, [run 36846964479](https://github.com/openclaw/bun/actions/runs/36846964479)
built in 6m 00s cold and 3m 19s with restored caches. The warm attempt reused
all 1,146 cacheable C/C++ compilations. Tests finished within a minute in both
attempts. These are build-step times, excluding provisioning and artifact upload.

The first test attempt failed `compile cache wakes an idle loop for deferred
modules` in `test/js/node/module/node-module-module.test.js` with `idle
persistence stalled`. [PR #53](https://github.com/openclaw/bun/pull/53) fixed
that Linux idle-accounting bug: a poll following a consumed native wake could
block without counting its wait as idle.

Windows x64 [run 37340737589](https://github.com/openclaw/bun/actions/runs/37340737589)
later hit the outer 30-second deadlines in both cache-exit and deferred-idle
tests. The same failure reproduces with continuous cache-file progress under
Microsoft Defender. The Windows rename helper requested `FILE_TRAVERSE`, which
is `FILE_EXECUTE` for a regular file, forcing synchronous executable-file scans
for each cache entry. The helper now uses its existing non-executable access
rights directly in [PR #130](https://github.com/openclaw/bun/pull/130), without
changing the test workloads, deadlines, idle-generation window, or signal-exit budget.

The deferred-idle test hit its outer 30-second deadline again in Windows x64
[run 37386790583](https://github.com/openclaw/bun/actions/runs/37386790583), with
#130 present. That run retained no progress timeline, so its runner-level cause
is unknown. On a separate Windows x64 host with Defender enabled, limiting the
exact binary's CPU budget reproduced the timeout while entries kept increasing.
An independent driver completed all 2,002 entries in 64.7 seconds; suspending the
child instead triggered the existing ten-second no-progress guard.

Using a progress-only deadline also exposed a test-runner bug: a stale file
timer treated the unlimited entry's zero timestamp as expired and killed its
child. The process-reaping check now excludes the no-deadline sentinel, matching
the entry's timeout check. A separate regression covers the completed-deadline
and live-child sequence.

The test now bounds module loading, pipe flushes, and child exit individually
and keeps the ten-second persistence stall guard. It has no aggregate duration
limit: slow, steadily increasing entry counts satisfy the idle-progress
contract. The 2,000-module workload, late-module handshake, expected 2,002 files,
idle-generation window, and signal-exit budget are unchanged.

Keep later failures distinguishable from these causes; a green rerun does not
establish a cause. The native lane has no automatic test retries or exclusion
for this file. Artifact names include the run attempt so a download cannot
confuse an earlier failed report with a later one.
