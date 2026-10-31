# Native x64 Teams follow-on

This mode restores selected artifacts from one exact completed R4 app attempt and runs the reviewed, untimed fetched-CJS Teams proof. It does not download or execute a compiler, install source dependencies, build OpenClaw, activate paging, or run a benchmark. The originating runner must be gone before dispatch. Root or `linux_x64_resume` owns dispatch after verifying the completed app export and publishing the reviewed helper head.

The workflow keeps the existing repository/branch guards, native `blacksmith-32vcpu-ubuntu-2404` runner, and noncanceling global concurrency. `mode=teams` is mutually exclusive with app, compiler, and benchmark jobs. It requires an explicit `app_variants=js-c2` or `app_variants=ts`; the app mode's default `all` is unchanged and is rejected by Teams mode.

## Dispatch

Run this only after setting the nine `P6_APP_*` variables from the verified originating export. No artifact identifiers, ZIP hashes, or ZIP sizes are fabricated here. The originating R4 app attempt under observation is run `40242181670`, helper head `a61fc72a57672fafe87fc1bda9a8e231a5f98bc7`; its completed export must supply and verify the remaining pins. A different completed attempt needs its own full set of pins.

```bash
gh workflow run openclaw-build-test.yml \
  --repo openclaw/bun --ref openclaw/aot-rd-P6 \
  -f mode=teams -f app_variants=js-c2 \
  -f app_run_id="${P6_APP_RUN_ID:?verified originating run required}" \
  -f app_run_attempt="${P6_APP_RUN_ATTEMPT:?verified originating attempt required}" \
  -f app_workflow_head="${P6_APP_WORKFLOW_HEAD:?verified originating head required}" \
  -f app_workflow_id="${P6_APP_WORKFLOW_ID:?verified workflow ID required}" \
  -f app_repository_id="${P6_APP_REPOSITORY_ID:?verified repository ID required}" \
  -f app_artifact_id="${P6_APP_ARTIFACT_ID:?verified artifact ID required}" \
  -f app_artifact_name="${P6_APP_ARTIFACT_NAME:?verified artifact name required}" \
  -f app_zip_sha256="${P6_APP_ZIP_SHA256:?verified ZIP SHA256 required}" \
  -f app_zip_bytes="${P6_APP_ZIP_BYTES:?verified ZIP size required}"
```

For a separately completed TS attempt, use `-f app_variants=ts` and all nine pins from that attempt. Selected variants must exist in the origin's selection and have the original successful build/core/transport evidence. Never combine receipts from separate attempts or treat TS as the benchmark's JS baseline.

## Time and identity boundaries

The job has a 100-minute limit and a 95-minute absolute work deadline. The final 1,200 seconds are reserved. Download and container bootstrap each have a 300-second ceiling; source clone and official Node preparation have 600 seconds; each selected replay has 180 seconds and each Teams wrapper has 1,410 seconds (reviewed 1,350-second phase plus 60-second cleanup). Admission checks the entire remaining selected window before preparation, including 30 seconds of outer cleanup plus a one-second margin per command: 5,135 seconds for JS/C2, or 3,483 seconds for TS. Earlier download/bootstrap time counts against the deadline; using both full earlier ceilings can therefore refuse JS/C2 before preparation. Insufficient time records exit 78 without launching preparation or replay. The inner 900-second install, 300-second inspection, and cleanup budgets are unchanged.

`teams-execution.json` binds the current job. Only the unchanged replay owner writes `execution.json`, bound to the originating app. The current helper checkout retains its real `.git` and all `scripts/openclaw-p6` files through sparse checkout. It is mounted read-only at `/p6-helper`, with Git trust scoped to that exact directory. The verified download is a read-only sibling `${P6_WORK}-download`, disjoint from the replay workspace and artifact root. The same absolute sibling path is used on the host and in the container. GitHub credentials are available only to the host download step.

The exporter requires current-job outer receipts, the exact origin/replay binding, reviewed per-variant Teams proof, and successful owned-workload cleanup for `teamsWorkComplete`. It preserves selected failure evidence even if a later replay is missing. It exports named synthetic receipts and raw proof, excluding source/state/cache trees, ZIP downloads, and application binaries. `scheduledPhasesComplete`, `applicationQualified`, `performanceEligible`, and `shipReady` always remain false.

## Local synthetic checks

Use Python 3.12 or newer and Bash 5, matching the Linux runner. Put temporary data on the external P6 volume:

```bash
TMPDIR="$HOME/.cache/oc-ty-ext/P6/x64-teams-fetched-r4-launch-v4/test-tmp" \
  /opt/homebrew/bin/python3.12 -B scripts/openclaw-p6/app/teams-mode/test_launch.py -v
```

The shared-host mount test invokes the actual shell with command doubles; it does not start Docker. Existing `app/test-teams.py` separately owns the fetched-CJS and replay behavior.
