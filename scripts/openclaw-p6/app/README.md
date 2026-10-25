# P6 native x64 application attempt

This is a bounded qualification attempt for OpenClaw
`670a7ab33bbd2e3ed4f0a5681e138159d74540a1` using the compiler pair from Actions
run `40214829538`, attempt 1, wrapper head
`f9fa08790bf45b3e995280f6eb249e14fd9191c1`. It never builds the compiler itself.
Both compiler artifacts must have reviewed IDs, ZIP digests, compiler digests,
transport digests and archive digests in `compiler-pins.json` before dispatch.

The existing registered workflow defaults to compiler mode. Its app mode has
the same P6 branch guard, its own job and no dependency on the skipped compiler
job. The app job's 230-minute deadline leaves 20 minutes for workload shutdown,
paging evacuation and upload before the 240-minute job limit. Native preparation
and each JS, physical ShadowRealm-off C2 and TypeScript attempt use the existing
owners. Every build gets a fresh live paging verification. Variant timeouts and
failures stop the container before cleanup; a later variant restarts only the
same identity-labelled container after its E2E resources are gone. All
phase ceilings do not fit in the job budget. Missing/failed/skipped proof remains
unqualified and the final job check fails unless all requested phases passed.
Build and preservation are prerequisites. Runtime phase failures are collected
while later independent phases continue; owning-controller cancellation,
deadline and signal exits stop the variant. A bounded, reaped guest-test timeout
remains an ordinary failed case. Docker dependents retain their existing image-receipt guards.
Any failed phase makes the variant return nonzero.

The container gets only the task trees, a read-only recipe, public execution
identity, the Docker client/Buildx plugin and the dedicated runner's Docker socket. The GitHub
token is used only by the host downloader and is removed on artifact redirects.
The original Docker E2E lanes create the application containers; a thin client
adapter labels created containers/networks with the actual Actions run/attempt.
Cleanup stops the app container, removes only that label's resources and verifies
their absence before paging cleanup. It never prunes the Docker host.

`packet/payload` is a P6-derived public input projection, not a byte-identical P0
index clone. Its selected CB6 record retains the exact source, signed status,
qualified status, executable hash and compiler facts of the private frozen
reference. That reference is historical provenance only. It supplies no Linux
application or performance qualification. The original capsule and P0 index are
unchanged; their hashes are provenance in `packet/input-projection.json`.
Unrelated CB4/CB5 history, local paths and private operational notes are excluded.
All executable owners except `runtime-controller.py` and `native-prep.py` are
unchanged from the accepted capsule. Native preparation exposes pnpm through a
task-local executable shim that runs the pinned Node and official `pnpm.mjs`,
avoiding the archive's shebang-less native placeholder. The official tarball
integrity, signed native download and Linux x64 ELF checks remain unchanged.
The runtime controller preserves terminal exit classifications
after evidence collection and uses a shorter generated guest label so C2's QMP
socket path fits Linux's 107-byte limit. The original capsule is unchanged.
The source proof
retains the exact R2 tree, all 26 required ancestors and dependency/source file
hashes; native clone, frozen install, runtime build, boundary generation and plugin
selection still run afresh.

`export.py` is the sole upload selection owner. It copies only explicitly named
build results, synthetic runtime archives and the preservation owner's app
archives. It does not export paging backing, private paging state, approval
directories, credentials, kernel keys, source trees or dependency caches.
The summary always leaves `applicationQualified` and `shipReady` false. This job
does not provide the post-run raw-trace Worker/strict zero-disk-JS assessment,
live provider evidence, or same-machine
Node/JIT versus AOT Gateway-ready/first-turn/RSS/CPU comparison backed by a fresh
npm installation. Old N1 measurements are not current evidence. The scheduled
native zero-JS and Worker diagnostic phases preserve their raw evidence for that
assessment; a zero exit from this workflow means only its named phases completed.

After heavy builds, the available host `/dev/kvm` is passed to the app container.
With at least 1900 seconds left before the reserve, the unchanged prerequisite
owner installs the pinned guest tools/image, then the unchanged actual-app guest
owner tests each built JS/C2 artifact while at least 950 seconds remain. Missing
KVM, prerequisites, artifact/version receipts, failures and insufficient budget
are recorded as explicit gaps. This uses native KVM only; it adds no emulated
timings. The guest phase covers the actual app's main-thread MDWE boundary, not
Gateway or Worker guest behavior.

The comparison follow-on consumes the exact completed app run/attempt and
artifact digest, plus the compiler pair above. The exported admissions,
build/core/controller receipts, plugin selection and projected reference facts
retain their native relative paths. On one fresh native x64 runner, recreate
the exact R2 source and canonical runtime with the existing preparation owner;
package with `scripts/package-openclaw-for-docker.mts`; install into a new prefix
using the source's exact lifecycle policy; then run the existing comparison
owner with one warmup and six alternating measured sweeps. No build-host sample
is reused. The separately prepared comparator capsule is
`46057637d4872e3660aa7ca7a2e8b5610e84da8f8ff4065fab82bb933c5c5420`;
its dedicated dispatch adapter requires separate review before execution.

R2 uses the root freeze at `2026-10-25T18:15:36.057232+00:00`, including PR183756, acpx 0.21.0 and Knowledge with two workers. Fresh frozen installation, canonical build, boundary artifacts and plugin selection are required. Prior plugin counts, worker counts and dependency caches are not qualification evidence.
