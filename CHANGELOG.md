# Changelog

## Unreleased

- Read the current engine's per-module object-export table, including defaults that are not own properties.

- Sync the AOT integration with layered compiled-test builds, retaining runtime, loader, trim, and build-owner fixes.

- Drop the obsolete built-in replacement flow-result adapter after upstream moved replacement discovery before analysis.

- Refresh generated AOT IR snapshots for heap-frame generators and current upstream optimization output without changing embedded programs or handwritten checks.

- Model and serialize the engine’s built-in replacement lists, keeping ordinary linked programs empty and full-program wire tests complete.

- Expose current engine flow-result sections and preserve their name offsets and callback layout.

- Match the engine object-spread flag and empty mutable-built-in program lists while preserving ordinary built-in locking.

- Match WebKit’s thread-pool ABI and reclaim unused per-thread allocator memory without reading a missing callback.

- Align the circular CommonJS error regression with upstream AOT behavior matching the source loader.

- Refresh generated AOT IR snapshots for the current WebKit optimizer while preserving their source programs and handwritten runtime checks.

- Expose new WebKit flow-result sections and match the extended callback layout.

- Match WebKit’s synthetic-export wire format while keeping existing exports fixed and conditional require values dynamic.

- Match the current WebKit AOT require-prototype host role and preserve per-global CommonJS prototype identity.

- Use current upstream IR expectations in place of obsolete fork-generated snapshots.

- Sync upstream main, shared-library AOT entry grouping, once-per-build macros, and runtime fixes while preserving the retained-runtime fork.

- Align property-read and unclonable-stretch counts with upstream conservative analysis while retaining runtime-output checks.

- Refresh generated IR expectations for the current upstream WebKit generator and type-prediction passes.

- Sync upstream large-program loading, deterministic generated paths, and runtime corrections; keep regression coverage while using upstream path naming.

- Sync upstream CommonJS cycle and JSX handling, trim retention, and cold-call outlining while preserving the AOT fork fixes.

- Preserve deterministic evaluated-text display names with lazily initialized source paths.

- Sync AOT async tail calls, segmented cell-cage allocation, strict IR checks, and upstream runtime fixes while preserving retained runtime and loader support.

- Sync upstream exception checks and runtime safety fixes; omit system CA prefetch from standalone executables.

- Sync AOT turn limits and compiler scheduling with upstream; use upstream macOS path resolution while retaining its POSIX-lock regression.

- Sync AOT host-option analysis, selective built-in loading, and loop optimizations with upstream; use upstream generic-version decline reporting.

- Sync the AOT integration with upstream lazy stub generation, per-program library retries, and IPC retention; use upstream typed-query expected-result flags.

- Rebase the AOT integration onto upstream main and its pinned WebKit while preserving Worker lifecycle tracing and scheduling.

- Sync with upstream static-field and prototype-store scaling fixes while preserving retained runtime and loader behavior.
- Keep ChildProcess stdio properties assignable before spawn and refresh them when spawning, including missing executables.
- Retain Worker lifecycle tracing with upstream's nonblocking AOT worker scheduling.

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
