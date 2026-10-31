# Final native x64 qualification preparation

Preparation only. No artifact is assumed to exist and no application, source
helper, Docker build, E2E lane, remote command or lease allocation has run here.
The native root is /home/runner/.cache/oc-ty-ext/P6/app-x64-final-r4-v1, source=root/source
at exact4fa442e332745f1f58ccedd27106abdafcf4e019, Node=root/opt/node/bin/node26.12.1.
The application guest/kernel lane is separate and is not provided by this bundle.

## Immutable inputs and actual-artifact gate

payload/harness contains12 unchanged existing P6 harness owner files and2 explicitly recorded adaptations and
needed direct dependencies. owner-inputs.json pins their original paths/bytes;
source-contract.json pins matching25a test imports and existing Docker lane
owners. Native staging uses a new root/qualification-harness-v2 directory; it
never changes root/manifest.json, original helpers, source or artifacts.

qualify.py requires actual artifact path, executable and manifest SHA256 values,
and the actual successful build-driver receipt path+SHA256. It rejects missing
or wrong bytes, source/target mismatch, stale source/test owners, non-native x64,
wrong Node or reused outputs. The existing source-owned runtime descriptor must
match the complete current sidecar tree and accepted build receipt. Values are
supplied only after a real build/acceptance; no example invents artifact hashes.
Without --run it prints a plan, not a qualification pass. With --run it execs the
unchanged lane owner so process/signal cleanup remains with that owner.

Each output must be a fresh root/qualification-results/<label>. It contains
input-proof.json and the original runner's run/result.json or ELF/image report.
Planned/image construction status is not application qualification. Failed rows,
traces and logs stay intact. Wrapper artifact collection should select only the
current case's text results/logs; trace bundles can be directly downloaded if
native collection limits require it, without rerunning completed workloads.

## Native serial cases

Supply real values as owner variables after actual build acceptance, then use:

```sh
python3 "$root/qualification-harness-v2/qualify.py" \
  --artifact "$artifact" --binary-sha256 "$binary_sha256" \
  --manifest-sha256 "$manifest_sha256" \
  --build-receipt "$build_receipt" --build-receipt-sha256 "$build_receipt_sha256" \
  --lane core --out "$root/qualification-results/$label-core" --run
```

Run the cases separately, with fresh labels for each actual JS/C2/TS artifact.
A JIT standalone can use native cases as a distinctly labeled comparator; the
Docker AOT recipes require mode=aot:

| Lane | Existing owner and claim |
| --- | --- |
| core | Direct AOT CLI/config/Doctor, Gateway log+/readyz, streamed deterministic turn, wait/history/provider proof and clean shutdown |
| zero-js | Same core workload with direct-app-only strace; positive source reads/maps fail, empty/incomplete traces fail |
| node-vm | Returning Code Mode Node executor/owning Worker/VM operation, no trace override |
| node-vm-native-workers | Separate diagnostic using the existing native-trace environment owner (`BUN_DESTRUCT_VM_ON_EXIT=1` plus `BUN_WORKER_VM_TRACE`) and unchanged lifecycle parser; not default performance/main-VM proof |
| pty | Actual exec pty:true operation requiring terminal stdin/stdout |
| plugin | Local CJS public-SDK install/load/command/inspect/uninstall; intentionally reads installed JS |
| elf-floor | Full artifact directory, including all physical ELF sidecars, with source-owner readelf reporter and native ldd version |

Requirements: completed source frozen install (including ws), python3, strace
for zero-js, readelf/ldd for ELF, and the real accepted artifact. Node26 runs test
clients only; the app launches directly from the selected executable. The ELF
lane rejects external sidecar symlinks rather than claiming complete coverage.
Keep maximumGlibcRequired and GLIBC_ABI_DT_RELR separate. This is import-floor
information, not an oldest-distribution/runtime pass. No compiler ELF census is
repeated here. Artifact/source/trace/performance claims remain distinct.

The NodeVM Worker diagnostic is separate from ordinary NodeVM, and installed
plugin execution is separate from zero-JS. Existing owner cleanup must complete
between serial commands. Worker census alone never proves lifecycle closure.
Core timings include existing warmup/config/Doctor work and are qualification
observations; this bundle does not produce a cold-start or comparative benchmark.

## Existing Docker E2E through AOT

First run lane docker-image with the same actual artifact/receipt hash arguments
and a fresh output. It builds the matching source's canonical Dockerfile target
bare, then the unchanged P6 Dockerfile.aot adapter using named contexts:

```sh
docker build --platform linux/amd64 --target bare \
  -f "$source/scripts/e2e/Dockerfile" -t "$bare_image" "$source"
docker build --platform linux/amd64 \
  --build-context "aot_artifact=$artifact" --build-context "test_source=$source" \
  --build-arg "P6_E2E_BASE=$bare_image" \
  -f "$harness/Dockerfile.aot" -t "$aot_image" "$harness"
```

The executable recipe derives tags from real accepted identities and records
actual base/AOT image IDs. An explicit P6_E2E_BASE avoids differing default tags.
The canonical bare image currently uses its source-owned Node24.22.1 pin for
Docker clients; native clients use26.12.1. The AOT app itself uses neither Node.
This functional Docker adapter is not a performance or zero-JS entry path.

Then run docker-gateway-network, docker-kitchen-sink and docker-cron, adding
--docker-image-receipt <actual docker-image output/result.json>. The current
local image ID must match that receipt and artifact identity. These phases call
unchanged source scripts with OPENCLAW_SKIP_DOCKER_BUILD=1,
OPENCLAW_DOCKER_E2E_REQUIRE_LOCAL_IMAGE=1, selected source SHA and explicit image.
Gateway-network requires embedded admin-http-rpc. The adapter keeps Node only
for mock servers/clients/assertions, copies the full standalone tree, and uses
process.execve to replace the normal test app entry with the AOT executable.

Kitchen-sink success is pinned exactly to npm:@openclaw/kitchen-sink@0.4.1;
the copied pin records registry integrity. Existing negative and local ClawHub
fixture cases remain unchanged. Registry/network failures are distinguished
from application/plugin defects. These three existing lanes cover deterministic
behavior, not a live credentialed model turn.

## Honest npm comparison label

The canonical installed npm package is a genuine npm-deployment comparator.
Root observed77 plugin directories there versus73 in selected AOT, with extras
cloudflare, cua-computer, image-generation-core and opencode-go. Keep those
canonical files. Do not prune, rename or curate the npm installation to force
plugin equality, and do not report it as an equal-plugin-content comparison.
Record actual inventory/source/version, package+entry/runtime hashes, lifecycle
completion and this deployment distinction with any future measurements.

This artifact-only qualification bundle does not convert npm into a synthetic
standalone wrapper. Use the reviewed comparison owner for an ordinary runtime+
installed-package entry, label it node-npm-deployment, and preserve its actual
content. Qualification successes here cannot replace npm install/update proof.

## Native runtime isolation correction (v2)

The original accepted preparation prepended build Node and /usr/local to PATH.
That could mask an external runtime dependency in the AOT process subtree.
This new version preserves v1 and keeps13 harness owners unchanged and adapts the plugin fixture helper call.
For every native lane, the controller and directly launched AOT processes inherit
PATH=/usr/bin:/bin, and preflight refuses node, nodejs, bun, bunx, deno, js, qjs or
quickjs discoverable there. The expected native inventory has not been observed
yet; do not claim runtime independence until this guard and the actual lane pass.
Node-based controllers, mock providers and clients use the verified absolute
Node26 executable, which is recorded separately. The unchanged owners launch
the AOT executable directly and preserve that PATH in its descendants.

Docker phases retain the explicit build-Node/tools PATH needed for test clients;
their receipts label them functional Docker proof. They cannot establish native
external-runtime independence. A runtime-free PATH is also not a claim that
no absolute external runtime can ever execute; inspect raw execve evidence.

For zero-js, preserve the entire run/traces directory without modifying files,
and preserve run/zero-js.json, run/result.json and input-proof.json. The analyzer
already hashes every raw trace and records successful execve calls with source
file/line. The direct-app strace covers the app process tree and excludes fixture
Node clients. Verify the successful child executable records name this admitted
AOT binary and inspect any additional executable before claiming self-child
coverage. Source reads/maps and executable identity are distinct claims.
If more than256 files or10MiB exceed native text collection limits, download the
complete raw trace directory separately and verify the analyzer's hashes; do not
drop traces, trim them, rerun a completed workload, or treat a summary as raw proof.

The current R4 application capsule stages this owner under app-x64-final-r4-v1/qualification.
Use its runtime-controller recipes and collect .artifacts/P6-FINAL-R4-x64/runtime/<variant>-<lane>/result.json. Historical v2/v3 transport names below describe owner provenance only.

The single capability-runner adaptation supplies the verified process.execPath
only to the fixture helper's bare node call, using a non-exported Bash function.
It does not add Node to PATH or export a function/variable into the AOT child.
The original source helper and its package-compat parser stay byte-identical.
owner-inputs.json records original and staged hashes separately.


## Fixture correction v3

This version preserves v2 and sets umask077 before fixture creation, resolves the admitted source to its physical path before existing Docker test-state helpers, and copies only runtime/package.json into readable /app/package.json instead of a symlink into the private artifact runtime. Docker image construction already uses a verified-by-build task local tag and checked Python subprocess exits; it does not use the ARM-specific base image ID/digest or Bash3.2 conditional pattern. No product source, artifact mode or app security change is made. Use fresh qualification-harness-v3 and transport qualification-v3.data.

Docker fixture now uses the exact root-approved v6 Dockerfile, adding source-matched jszip3.10.2 and tar7.5.22 alongside ws8.22.0 under /opt/openclaw-e2e with /app/node_modules pointing to that tooling. This repairs existing ClawHub fixture dependencies; it does not supply the AOT application or change its embedded/installed plugin resolver. The nested SDK product investigation remains separate.

## Fetched Teams follow-on

`teams-fetched` is an explicit functional lane; default variant phases and benchmarks do not schedule it. It uses the accepted ARM R4 Teams assertion and config unchanged, with the same package pin (only its historical operator path is omitted), then verifies the loaded `dist/index.cjs` bytes and its compiled SDK import. Every native x64 artifact must supply its own successful build/admission and pass the existing complete runtime-tree and runtime-free-PATH gates. The fixture copies the artifact before use and keeps all package/state writes in a fresh output directory.

After separate root admission, `python3 -B /p6-recipe/app/teams.py --variant js` (or `c2-off`, or a later selected `ts`) invokes the existing deadline and runtime-controller owners. Install is bounded at 900 seconds, inspection at 300, and the read-only assertion at 30. The 1350-second functional phase allows their cleanup and finalization. Its 45-second outer cleanup exceeds the 15-second inner command cleanup; the deadline owner allows 60 seconds. Insufficient enclosing budget records not-run. Timeout, signal, and forced cleanup remain failures.

The result is under `qualification-results/<variant>-teams-fetched/run/result.json`, with unchanged assertion output in `verification.json`, installed-CJS evidence in `cjsBoundary`, and raw command output/receipts. The runtime owner archives it and export reports it under `followOnProof`; duration/CPU/RSS are excluded from performance conclusions. No prior-platform or prior-run evidence is promoted to a current pass.

### Replay after the originating runner is removed

The adapter does not depend on keeping the originating runner alive. Use the existing `app/benchmark/download.py` owner to fetch one completed app export with actual run/attempt/head/artifact/ZIP pins. For the initial R4 JS/C2 run the originating helper head is `a61fc72a57672fafe87fc1bda9a8e231a5f98bc7`; the artifact ID/digest and completion evidence remain unbound until that run finishes. Interrupted exports still need the download owner's explicit cleanup proof. Do not combine different originating runs.

On a fresh native Linux x64 host, check out the separately reviewed follow-on helper commit, run its `app/packet/payload/stage.py`, clone OpenClaw commit `4fa442e332745f1f58ccedd27106abdafcf4e019` into ROOT/source, and unpack official Node26.12.1 linux-x64 into ROOT/opt/node. No dependency install, pnpm build, compiler build, or AOT compile is needed: the source-owned archive checker imports only source files. The replay driver verifies the exact source HEAD/tree and clean checkout, Node bytes against the original native build, both originating compiler pins/records, the complete indexed export, and each preserved artifact through unchanged `preserve.py verify`. Compiler provenance is verified from the originating build/adoption/archive chain; no compiler executes on the replay host.

With a new synthetic P6_WORK directory and an absolute P6_DEADLINE_EPOCH, invoke these explicit phases from the reviewed helper checkout (ROOT is the fixed `/home/runner/.cache/oc-ty-ext/P6/app-x64-final-r4-v1`):

```sh
python3 -B scripts/openclaw-p6/deadline_process.py --deadline-epoch "$P6_DEADLINE_EPOCH" --reserve-seconds 1200 --cleanup-grace-seconds 60 --receipt "$P6_WORK/restore-js-deadline.json" -- python3 -B scripts/openclaw-p6/app/teams-replay.py --download /absolute/verified-app-download --helper-head <reviewed-follow-on-commit> --variant js
python3 -B scripts/openclaw-p6/app/teams.py --variant js
python3 -B scripts/openclaw-p6/deadline_process.py --deadline-epoch "$P6_DEADLINE_EPOCH" --reserve-seconds 1200 --cleanup-grace-seconds 60 --receipt "$P6_WORK/restore-c2-deadline.json" -- python3 -B scripts/openclaw-p6/app/teams-replay.py --download /absolute/verified-app-download --helper-head <reviewed-follow-on-commit> --variant c2-off
python3 -B scripts/openclaw-p6/app/teams.py --variant c2-off
python3 -B scripts/openclaw-p6/app/export.py
```

The replay driver is preparation only: it never runs the app. It requires an original successful build, original passing core/controller evidence, and complete preserved artifact for that selected variant; missing or contradictory evidence refuses restoration. Original build/admission bytes are retained unchanged. `teams-replay/<variant>/replay-binding.json` identifies the source run and local restoration, while the current workspace is marked `untimed-functional-replay`. Each actual Teams phase still needs its own successful outer deadline receipt; an inner pass with missing/failed/cancelled outer evidence remains an unrun proof gap. Run later TS from its own completed TS export with the same procedure, in a fresh host/root/work directory. Actual artifact/pins and native execution remain pending.
