# Changelog

These entries describe the experimental `openclaw/aot-typed` fork.

## Unreleased

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
