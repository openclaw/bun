# Dedicated native x64 benchmark mode

This folder is a preparation for a later `mode=benchmark` on the already-registered P6 workflow. It does not alter or delay initial app dispatch. No native app, build, package/install, lease or GitHub write ran during preparation. The workflow/shared-bootstrap/export owner must review and integrate the files and API below.

Use the same native x64 32 GB runner/provider as app mode, with a fresh empty ROOT and 240-minute job budget. ROOT remains `/home/runner/.cache/oc-ty-ext/P6/app-x64-final-r4-v1`. The job consumes one explicit, **completed** app run/attempt and exact artifact. Failure of the overall app job is acceptable; each reused application cell must independently have its complete successful build, admission, original core/controller and preservation proof. No original execution result becomes a new performance sample.

`app-inputs.template.json` is filled only after app export exists: repository ID, workflow ID, app run ID, attempt, workflow head, artifact ID/name/ZIP SHA256/ZIP bytes. Keep the artifact name's exact attempt binding. `download.py --pins FILE --out DIR` runs on the host with its existing GitHub token and strips Authorization on redirects; neither token nor token-bearing environment enters the container. It verifies exact run/repository/workflow/head/attempt, artifact metadata, ZIP hash/length, safe paths/types and a complete content index. Completed success or failure is accepted. Cancelled/timed-out runs additionally require an indexed cleanup receipt matching the exported summary and the reviewed host cleanup ordering (owned workloads are removed before paging cleanup); absent or failed cleanup rejects the import. The container repeats verification of the already-downloaded ZIP and exported files before restoring anything.

The shared bootstrap owns the fresh native container and compiler download, with a benchmark-specific execution identity. It must not call app initialization unchanged because that initializer requires job `linux-x64-app`. Compiler adoption, exact R4 source clone/frozen install/canonical runtime/boundary/selection still run through the existing native-prep owners. No AOT or compiler build runs in this mode. Do not copy the original prep receipts over those new receipts.

After native preparation, run `stage.py` to place the unchanged runtime/measurement owners and thin adapters at ROOT/benchmark-prep. `restore.py --download DIR` checks both original and new compiler records and plugin selections, and invokes the unchanged `preserve.py verify` against each complete usable app archive. Its native plan/result/transport bytes stay unchanged. The verified application directory is moved into the original ROOT/artifacts/<variant> path; only the verification owner creates a derived local-check plan. Original core results remain clearly identified with the originating app run.

Missing/failed/unpreserved JS/C2/TS are written to `availability.json` as **unavailable** with a reason and `performanceQualified:false`. They are never fabricated as zero measurements or passes. A valid JS AOT is required as the declared baseline; unavailable C2 or TS does not block the remaining selected comparison. Present but contradictory identities fail restoration. `bind-inputs.py` enables only available variants. The existing cohort owner already supports an arbitrary selected cell list and is unchanged.

The package/install path reuses the previous prepared comparator owners: private copy of the freshly built source, canonical package owner, source-selected extra bundles, a fresh npm prefix/cache/HOME and all19 exact source allow/deny decisions plus the exact tarball file alias. The install is labeled **npm lifecycle with source allowScripts policy**, with strict hook admission. It records tarball hash/size, actual lock SRI, source stamp, schema, package contents, installed logical bytes/files, ELF inventory, entry hash and measured installation CPU/RSS/wall. There is no incremental install, pruning or relaxed hook policy.

Run `run-functional.py` once after installation/inventory. It uses the existing measurement/core owners for each currently available AOT and Node/Bun JIT baseline with fresh state. An optional C2/TS functional failure is preserved and explicitly excludes that cell; failure of JS, Node or Bun stops comparison. The adapter rebinds available inputs after any optional failure. Cancellation is never treated as an optional-cell failure. These functional timings are scheduler evidence only, not performance rows.

`prepare-window.py` computes the entire unchanged cohort budget from this runner's measured probes: **7 × sum(selected-cell elapsed seconds) × 2 + 300 seconds**, representing one warmup plus six measured sweeps, 2× timing headroom and five minutes for controller/cleanup variation. It compares against the absolute job deadline minus the existing1200-second cleanup reserve. The prior functional measurements were roughly34 seconds for Node and91 seconds for Bun JIT including Doctor; they justify measuring whole probe cost, not just Gateway readiness. Those old ARM64/d754 results remain excluded from R4 performance. No fixed7200-second start gate remains. If the complete budget cannot fit, exit78 records `cohort-budget.json` as insufficient; do not cut sweeps.

The host owner then reconciles all build/install hooks, containers/guest work and other workloads, writes a current `quiet-admission.json` from the template with the computed reservation, and binds a sanitized task-only host receipt. Avoid arbitrary process command-line dumps in exported evidence. `check-window.py` requires a recent receipt on the same boot and the complete reservation immediately before launch. The existing absolute deadline owner remains responsible for cancellation/cleanup; the estimate is not a guaranteed upper bound.

Use the phase sequence and exact argv in `integration.json`. Every executable phase stays behind the shared deadline owner. For cohort, use the existing `run-phase.sh cohort`, which rechecks all source/receipt/runtime/entry hashes and uses `stream-cohort.py` to retain completed row progress. At completion `summarize.py` requires one warmup plus exactly six measured rows per selected cell. Its result is `partial-comparison-passed` when an original requested variant is unavailable; `fullRequestedMatrixComplete` remains false. Original app results, exported inputs and new measurements remain distinguishable.

Report Gateway readiness, first streamed delta, completed first turn, root/tree RSS and CPU with medians/quartiles/min/max and paired ratios. Results are same-machine deployment comparisons with recorded plugin-content differences, warm shared file caches and a synthetic streaming provider. They are not cold-cache, live-provider or compiler-only claims. A Worker census is not complete Worker lifecycle qualification. `summarize.py` includes the explicit unavailable cells beside successful statistics.

`test_contract.py` is pure synthetic transport/selection proof: completed failed run acceptance, wrong attempt/ZIP rejection, changed exported bytes, path traversal, unavailable TS and independent valid JS with missing TS. Run it under Python3.12 (matching the native environment). The cohort invocation remains unchanged. The opt-in Knowledge control below changes only untimed AOT functional cells; local checks do not establish native results or an autoreview verdict.


## Untimed backup qualification in version2

After install/inventory and before functional probes/the quiet barrier, `run-backup.py` exercises the existing synthetic backup owner for canonical Node and Bun JIT controls plus every admitted available AOT cell. This does not alter `core-runner`, its timed workload or its six measured sweeps. Each backup invocation retains the original 120-second per-command limit and an outer 300-second controller bound. Previous controls completed create+verify in roughly3.6 seconds on Node and2.3 seconds on Bun; these are scheduling context only, not R4 proof.

The only change to the previously reviewed backup harness itself is its SOURCE constant. `backup/SOURCE-AUDIT.md` records the exact source audit, including the changed PostgreSQL-only discovery branch. AOT still needs admitted lineage, now supplied by the native restored-cell metadata verification. JIT backup controls use ROOT/source/openclaw.mjs because the packaged npm launcher does not carry the required dist/.buildstamp. No stamp is fabricated and no guard is removed.

Backup results remain their own qualification evidence. Missing TS remains unavailable. Every failed backup exits nonzero and records failed status, never pass. The workflow owner may explicitly continue to collect independent performance after reconciling those child processes; `comparison-summary.json` then includes the failed backup summary beside any successful performance. The overall application remains unqualified by this performance job.

Version3 preserves the complete originating qualification summary, including strict-zero-JS and other failures, beside performance results. A per-cell benchmark pass never erases those failures.

## R4 source freeze

This packet binds source4fa442e332745f1f58ccedd27106abdafcf4e019, tree5409457bc1b8a901b00193469a3c2b7a74dc2f30, frozen2026-10-25T22:30:39.990290+00:00. It includes the landed typed resolver repair PR183822 and later main runtime changes. Source-contract entries, package/lock/workspace and source npm policy are freshly audited against immutable R4 blobs. Actual selection, compiler/runtime hashes, installed contents and AOT facts still require new native receipts; no prior counts, binaries or originating runs are reused.

## Untimed Knowledge control

Each available AOT variant gets a fresh dedicated Knowledge control under the
existing runtime owner. Operator RPC checks unprovisioned status and creates an
operator/direct session without starting a run. An admitted agent then consumes
exactly four scripted provider requests: tool search, tool description, actual
ontology dispatch, and the final marker. Operator status/ontology must show the
same ready store and fingerprint, with registry, store and vault files present.
There is no direct HTTP tool call or fabricated memory audience.

Normal functional runs and timed cohorts are unchanged. A failed Knowledge
control is reported independently and prevents scheduled completion; it does
not rewrite performance availability. Actual artifact qualification remains
pending execution. The former direct-HTTP fixture was invalid and is removed.
