# Workflow integration

`mode=benchmark` is a separate job on the existing native Linux x64 runner. Its
nine app inputs are all required by the input binder. They identify a completed
app run, exact attempt and workflow head, repository/workflow IDs, and exact
artifact ID/name/ZIP SHA256/size. An empty input or inconsistent attempt is an
error; no app run is inferred from the latest Actions row.

The compiler and app downloads run on the host under the existing absolute
230-minute work deadline. The token exists only in the download step. The fresh
container has a read-only mount for the app import and execution identity. The
shared bootstrap keeps its default app behavior; benchmark mode skips cryptsetup
and paging, and rejects direct app build/variant phases. Native preparation still
clones, installs and builds the exact source using its existing owners. Restored
AOT artifacts must pass the accepted transport and native contract before use.

Every measured phase runs with umask 077, a clean container environment, nice10,
and the shared deadline/process-group owner with a 1200-second reserve. An
ordinary backup failure permits the independent comparison only after the host
reconciliation check succeeds. Deadline/signal exits stop the sequence. A complete
comparison cannot turn failed backup or original qualification evidence into a
pass; the final job gate requires the new comparison, backup and cleanup receipts.
Application qualification and ship readiness remain false.

The host quiet helper inspects the real process/container state immediately before
the complete cohort. It never invents a lease or stops unrelated work. An admitted
cohort keeps its one warmup and six measured sweeps; exit78 preserves an
insufficient-window result without shortening the experiment.
It also samples aggregate and per-process CPU activity over one second, subtracts
only the inspector's measured work, and records a noise allowance of 0.10 CPU
seconds per wall second. Competing activity, substantial I/O wait, process churn,
and invalid counters reject admission even when executable names are unfamiliar.

The exporter selects named receipts, synthetic provider/CLI logs and measurement
outputs. It excludes installed trees, source/package copies, HOME, cache, tmp,
backup database/archive fixtures and paging material. The original app summary is
retained through availability and comparison metadata. Export and the result gate
run after cleanup even when an earlier step fails.

Local preparation checks are synthetic only:

```
python3.12 -B -m unittest discover -s scripts/openclaw-p6/app/benchmark -p 'test*.py'
```

The accepted benchmark payload and its hash manifest are unchanged. This wrapper
adds workflow identity, host orchestration, cleanup and export; it does not supply
native execution results.

The untimed functional phase runs a separate fresh `--knowledge-control` for
each restored AOT variant that passes the ordinary functional probe. It creates
an operator/direct session, then runs the admitted agent through `tool_search`,
`tool_describe`, and `dispatch_action`. A strict synthetic Responses provider
requires exactly four requests and consumes each actual tool output. Operator
RPC status and ontology results must match the agent's store and fingerprint.
Direct HTTP tool invocation is not used because that surface has no memory
audience. The existing core runner owns all processes and cleanup.

Normal AOT/Node/Bun functional probes and every timed cohort omit this flag.
Knowledge failures remain in `work/knowledge-controls.json` without changing
performance availability; exported completion still requires the controls to
pass. Only named proof files and logs are exported, never state or credentials.
