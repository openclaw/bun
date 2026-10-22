# Changelog

## Unreleased

- Collect unsupported Flow families across pending pair batches before retrying typed compilation.
- Retry independent unsupported Flow layouts together, avoiding a full program analysis for each failed family.
- Index per-file AOT parser options while preserving normalized-path and deferred-source precedence.
- Build the native toolchain from paths containing spaces without quoting compilation database arguments.

- Preserve constant-symbol field names when a base constructor exposes a partially initialized typed instance.
- Keep stateless typed functions free of VM state when native-entry counters are enabled.
- Preserve typed validation results across native fallback joins, prune redundant plain-data Flow union arms, and retry generated layouts that exceed native nesting limits.

- Bound repeated nested Flow intersections by reusing equivalent record contracts, and preserve explicit typed parsing and validation during native fallback.

- Preserve overlapping Flow object views across reached functions, with bounded shared-layout construction and exact generated-contract interning.
- Retry unsupported Flow families as untyped native code while preserving source errors, untyped-file rule policy, worker metadata, and the original cause in typed-share reports.

- Rebase the OpenClaw typed-AOT fork onto the latest checked-program compiler, with paired format-39 Bun/WebKit images and large-image relocation fixes.
- Preserve runtime type checks across returned arguments, narrowed local stores, generic containers, object spreads, logical fallbacks, and source-array audits.
- Keep captured `process.env` references live across `SHARE_ENV` worker adoption and resolve lazy runtime imports by their bound symbol.
- Add exact native compiler-input exports and per-VM native-entry snapshots for typed coverage measurements.
- Regenerate external build directories from their owning source checkout on Unix and Windows.
