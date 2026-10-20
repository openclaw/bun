# Changelog

These entries describe the experimental `openclaw/aot-typed` fork.

## Unreleased

- Retry typed AOT Flow intersections that can be redefined through generic native code before requiring a fixed record layout.

- Retry bounded native Flow queries with their contributing modules compiled untyped while preserving source type errors.
- Retry exhausted typed AOT Flow families with affected modules compiled untyped, preserving function source text and explicit type-driven validation.
- Preserve typed object aliases across function boundaries and annotated local assignments.
- Prevent redundant plain-data union terms from multiplying typed AOT Flow layouts.
- Allow opt-in compiler trace byte limits up to 2 GiB while retaining the 256 MiB default.
- Add opt-in native IR body and Flow-query timings to the compiler trace.
- Normalize equivalent nested inline payload records during typed AOT flow narrowing.
- Keep typed AOT compilation bounded for flow-narrowed unions with equivalent inline payload records.
- Cover ordinary-array getter and iterator checks while preserving supported Proxy-array behavior.
- Preserve native object identity across overlapping flow-narrowed unions by retaining and deduplicating their intersection layouts.
- Fix typed-fact validation crashes when mutable captured strings enter a loop, and cover native compilation with sources hidden and JIT disabled.
- Keep ordinary nested generic records compatible across typed views while preserving open layouts for generic spreads and Proxy allocations.
- Pin WebKit's typed Proxy-array handling and ARM64 pre-frame outlining repair.
- Preserve nested generic Array.map result fields in typed AOT code without opening the enclosing object's fixed layout.
- Match native AOT Proxy-array admission and iteration in source execution without caching a Proxy's target type by Structure.
- Fix false temporal-dead-zone errors in typed AOT builds when a build plugin remaps an import to a different runtime module.
- Fix `process.env` and `Bun.env` references becoming stale when the first `SHARE_ENV` worker starts on macOS and Linux.
- Report final canonical body sizes for folded AOT map aliases.
- Use final branch-distance validation for large typed AOT images and cover caller-local veneers larger than the shared-stub reserve.
- Preserve checked argument types when declared imports return an argument during typed AOT compilation.

- Finish typed AOT analysis of arrays filled from their own elements, including mutually dependent arrays.
- Bound recursive generic layout families without changing their runtime values or shallow typed accesses.

- Avoid preparing discarded task results when typed AOT source analysis retries a boundary-limited module.

- Add bounded opt-in compiler source-search traces for slow typed AOT builds.
- Skip cast and union scans for source-search attempts that already need a boundary-limit retry.

- Preserve initial and final native-entry coverage while avoiding repeated GC snapshot writes.
- Reduce full native-entry snapshot write overhead in large AOT images.
- Restore guarded direct calls for fresh record literals while preserving ordinary-object conversion checks.
- Emit complete per-VM native-entry snapshots and preserve counter relocations in large AOT images.

- Preserve conversion checks and prototype-backed objects for literals explicitly typed as `any`.

- Preserve known host-property types through structural views of globalThis during typed AOT checks.

- Preserve macOS POSIX file locks when resolving paths, preventing SQLite WAL locks from being dropped by canonicalization.

- Keep automatic server startup on the primary AOT entrypoint; importing additional entries only evaluates their modules.
- Cover embedded Wasm SIMD bitmasks under hardened runtime without executable-memory permissions.
- Preserve property enumeration after AOT identifier names overflow the inline cache.

- Preserve incomplete Bun host namespaces, module augmentations, and inferred function names during typed AOT checks.
- Honor explicit function-source embedding in in-place executables.
- Support typed program lengths and section offsets above 4 GiB with format 38 and checked 32-bit logical IDs.
- Preserve the own types of ordinary object literals stored in a returned Map.
- Report declared-array accessor violations in source logging and audit modes before the normal read executes.
- Use the matching WebKit fixes for large-image veneer accounting, immutable-array audit guards, and full-width closure function IDs.
