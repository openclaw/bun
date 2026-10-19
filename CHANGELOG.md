# Changelog

These entries describe the experimental `openclaw/aot-typed` fork.

## Unreleased

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
