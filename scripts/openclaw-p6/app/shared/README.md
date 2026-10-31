# Gateway shutdown in P6 qualification

`process-stop.mjs` owns the process-stop implementation. Run
`python3 scripts/openclaw-p6/app/shared/sync-process-stop.py` to refresh its two
transport copies. The app and benchmark manifests bind those bytes separately.

Gateway runners read `GATEWAY_SHUTDOWN_TIMEOUT_MS` and
`GATEWAY_SERVICE_STOP_TIMEOUT_MS` from the admitted OpenClaw source's
`gateway-shutdown-budget.mjs`. At source `59baf4a` these are 325 and 330 seconds:
315 seconds of drain, 10 seconds of cleanup reserve, and 5 seconds of supervisor
margin. `src/cli/gateway-cli/run-loop.ts` keeps that deadline through final
shared-state cleanup; a server-close log is not process completion.

The first signal starts the same cached Gateway stop that finalization awaits.
Ordinary child commands retain their 10-second grace. Every stop records whether
it required SIGKILL, and both core and capability qualification reject a forced
stop or a nonzero Gateway exit even when the final process census is empty.
Knowledge still uses the admitted four-request agent flow, with its stable
provider receipt checked after Gateway/provider cleanup.

Gateway-owning runtime wrappers allow the source service budget plus 30 seconds
for the existing tail: Gateway force-reap (5), provider grace/reap (10+5), and
final descendant census (10). This opt-in does not alter build, install, backup,
or other non-Gateway cleanup defaults, or the existing 600/900-second operation
limits. A timeout or interruption remains a failed run after cleanup.

The external Actions cancellation window can forcibly end the harness before
this budget expires. Likewise, terminating a Docker client alone does not prove
that its in-container workload received SIGTERM. Existing outer/container
forced-cancellation paths remain failed, unqualified evidence; this repair does
not claim a natural Gateway exit for them.

`node --test scripts/openclaw-p6/app/shared/test-process-stop.mjs` exercises real
synthetic children: natural exit beyond the former 10-second cutoff, unchanged
non-Gateway default grace, and bounded forced cleanup with one shared deadline.
It does not run OpenClaw or establish native AOT qualification.
