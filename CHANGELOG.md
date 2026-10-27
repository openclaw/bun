# Changelog

## Unreleased

- Resolve literal embedded entry paths through the current source-provider fast path, even without user plugins.

- Keep self-as-Bun disk scripts, runtime plugin source/resolution hooks, and deterministic generated-function paths working in the current upstream AOT compiler.

- Cover source-less generated helper entry counters in AOT image-map regression tests.

- Resolve literal embedded module paths against prepared AOT entry points, including TypeScript and custom output names.

- Add `Bun.Terminal.pause()` and `resume()` for PTY output backpressure without blocking the event loop.

- Add opt-in native Worker VM lifecycle tracing with `BUN_WORKER_VM_TRACE`.
- Deduplicate ambient type packages shared by AOT source projects so copied timer declarations remain callable.
- Allow AOT runtime views of Bun without installed type declarations while checking declared member types.
- Avoid repeated chunk-hash reachability scans when bundling long dependency chains or cycles.
- Retain built-in startup metadata when trimming the interpreter from AOT executables.
- Add Bun.build branch and arrival instrumentation options for native AOT coverage, matching the CLI counters.
- Keep removed built-in source text empty when constructing its source provider, so trimmed AOT executables can start.
- Preserve references captured from `process.env` and `Bun.env` when a worker joins a `SHARE_ENV` tree on macOS and Linux.
- Preserve process-owned POSIX file locks when resolving real paths on macOS.
- Support external build directories and source checkouts whose paths contain spaces, and keep generated-code reconfiguration rooted in the source checkout.
- Enable explicitly requested trimmable native macOS builds with a matching `ld64.lld` linker.
