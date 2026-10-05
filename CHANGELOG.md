# OpenClaw Bun fork changelog

## Unreleased

- Validate `vm.Script` cached data without compiling an unused executable, avoiding crashes when JSC runs without a JIT. Adapts [oven-sh/bun#41769](https://github.com/oven-sh/bun/pull/41769); thanks @robobun!

- Reject explicitly empty `vm.Script` cached data like Node.js and cover cache round-trips and incompatible data in interpreter, baseline, DFG, FTL, and default modes. Extends the crash regression from [oven-sh/bun#41769](https://github.com/oven-sh/bun/pull/41769); thanks @robobun!

- Align WebKit and VM source-position assertions with Node's constructor locations and select these regressions for native stack-formatting changes in both fork CI lanes.

- Preserve the native-context count in the fast `v8.getHeapStatistics()` adapter and avoid appending a second strict code-generation flag to inherited worker arguments.

- Return one-based CallSite columns and null native positions, preserve column 1 in stack strings, and align constructor locations across stack formats and line breaks. Adapts [oven-sh/bun#35179](https://github.com/oven-sh/bun/pull/35179) and [oven-sh/bun#37396](https://github.com/oven-sh/bun/pull/37396). Thanks @robobun!

- Honor deleted, restored, and redefined `Error.prepareStackTrace` properties instead of retaining a stale native formatter.

- Defer stdin and eval package-scope validation until module resolution needs it, so inline scripts can diagnose malformed ancestor metadata themselves.

- Dispatch child IPC messages and disconnects through JavaScript `process.emit`, preserving wrappers, accessors, and inherited overrides.

- Synchronize resolver entry-cache snapshots with symlink fills, fd updates, and re-stats, preventing torn path reads during concurrent worker resolution.
- Implement `node:v8.queryObjects()` with full garbage collection, prototype-chain matching, and count or shallow-summary results for retention diagnostics.
- Make child stdout/stderr `ref()` and `unref()` idempotent so idle subprocess pipes release parent liveness, and return the stream for chaining. Adapts the return-value fix from [oven-sh/bun#36316](https://github.com/oven-sh/bun/pull/36316). Thanks @robobun!
- Enable the Node-compatible `module-sync` condition for Bun and Node package resolution while preserving target module kind and export-key precedence. Ports [oven-sh/bun#20770](https://github.com/oven-sh/bun/pull/20770). Thanks @RiskyMH!
- Preserve re-registered process once wrappers after dispatch and match removal by the wrapper or its original callback to Node's last-match semantics.

- Return callable once wrappers from `process.rawListeners()`, preserving `.listener`, wrapper identity, duplicate registrations, and once-only dispatch. Adapts [oven-sh/bun#33495](https://github.com/oven-sh/bun/pull/33495). Thanks @robobun!

- Keep deferred Node compile-cache generation progressing on idle Linux event loops after native wakeups, without changing the idle-generation window or signal-exit budget.

- Keep CommonJS and ESM module keys aligned for literal `#` paths, preventing duplicate evaluation and split-bundle namespace crashes.

- Sync upstream through `4b02e1031d6195d96fc0446dfbff49297f89f2d6`, preserving unfinished HTTP aborts and immediate header flushing on the server socket's response ownership contract, promise-aware console writes, and module URL cache identity.

- Build and test Linux x64 pull requests with cached no-LTO release builds, selected compatibility tests, downloadable binaries, and nightly main coverage.

- Preserve ownership of Node-API threadsafe-function payloads when a worker stops between callbacks, returning queued payloads before finalization. Adapts the checkpoint ordering from [oven-sh/bun#36831](https://github.com/oven-sh/bun/pull/36831). Thanks @robobun!

- Preserve zero byte counts and original buffers in filesystem read/write error callbacks so nonblocking WriteStreams can retry EAGAIN. Ports [oven-sh/bun#41440](https://github.com/oven-sh/bun/pull/41440). Thanks @robobun!

- Start TLS reads after adopting paused Duplex and HTTP CONNECT transports, including buffered handshake bytes and pending plaintext acknowledgements.
- Clone only Map and Set entries, ignoring custom own properties without invoking getters, while retaining compatibility with existing serialized records.
- Deliver socket close events through the native immediate scheduler even when fake timers replace user-visible timer APIs, preserving end/finish/close ordering.

- Support independent IPC channel references, writable child stdio properties, and failed-spawn exit codes. Thanks @robobun!
- Await buffered FileSink writes before completing Writable callbacks, preserving cork, drain, error, final-flush, and parent-end descriptor behavior.
- Preserve inferred function and class names, format captured stacks for object targets, and retain query/fragment identity in file-URL preloads.
- Restore fast realpath lookup without releasing POSIX locks: use O_PATH on Linux and fd-free full-path attributes on macOS, preserving symlink, firmlink, hard-link, and literal-path behavior.
- Return undefined from filesystem access operations and null on successful symlink callbacks. Thanks @robobun!
- Keep empty-histogram NaN values and macOS SDK signpost attributes portable across supported compilers.
- Preserve custom Headers iterators and copy server.fetch header ownership. Thanks @robobun!
- Match Undici timeout metadata and WebSocket heartbeat APIs, HTTP listen errors and byte counters, and HTTPS constructor, half-open, and ALPN behavior.

- Preserve Node-alias stdin, eval arguments, version queries, and lexical entry paths; close transferred MessagePorts when worker startup fails.
- Honor dynamic plugin targets and import kinds, preserve literal POSIX paths and ESM fragments, and match Node loading for untyped dependencies and inline TypeScript type clauses.
- Report referenced Timeout and Immediate resources from `process.getActiveResourcesInfo()`, isolated per worker.
- Release callback async contexts when timers are canceled, even while their handles remain reachable.
- Point `NODE` and `npm_node_execpath` at the selected executable Node shim, including private fallback directories.
- Avoid allocator handoffs during nonblocking event-loop polls.
- Close idle Node HTTP connections after bodyless responses finish inside their handlers, while preserving pending request bodies, queued responses, and tunnels.
- Report the actual stat error when an install patch file cannot be read, including symlink-loop errors. Thanks @SebTardif!
- Resume injected HTTP and TLS connections after attaching server listeners so paused proxy sockets can deliver requests. Thanks @RomneyDa!
- Sync upstream through `ba3f27d1d1ce359d4eed842c135f0f6fba1acb00`, preserving fork process retries, module URL identity, worker preloads, TLS trust settings, and CPU profiling while integrating upstream TTY handling and code-generation restrictions.
- Copy regular-file `/dev/fd` sources on macOS with `fs.copyFile` and `fs.cp` above 128 KiB, preserving the source descriptor's offset at every size.
- Keep runtime plugin resolution out of the content-addressed transpiler cache so changed plugin answers and temporary module generations cannot reuse stale import paths. Thanks @vincentkoc!
- Preserve child signals and inherited stdio in `bun run --silent` on macOS when startup marks descriptors close-on-exec.
- Expose live parent-end child stdio descriptors through `_handle.fd` and blocking-mode control, with idempotent stdin `ref()`/`unref()`, so TypeScript's synchronous native API can use piped IPC. Ports [oven-sh/bun#39760](https://github.com/oven-sh/bun/pull/39760). Thanks @robobun!
- Publish Node-compatible `http.server.response.finish` diagnostics with request, response, socket, and server identities before advancing queued HTTP responses.
- Resolve `file:` URL preloads (`--preload`, `--import`, and Worker `execArgv`) like `import()` specifiers, so percent-encoded paths and Windows drive letters load instead of failing with "preload not found".
- Sync upstream through `a4f1429148114ddc3bccc13764781be27a7a9523`, preserving the fork's compatibility patches and contributor histories. Reconcile HTTP body, pipeline, close, and TLS lifecycles with upstream Node compatibility changes.
- Preserve child signal masks when Worker threads spawn terminals concurrently, so terminal Ctrl-C continues to interrupt foreground processes.
- Restore default Ctrl+C handling before spawning a Windows `Bun.Terminal` ConPTY child, as node-pty does, so `\x03` interrupts the foreground program even when Bun was started with Ctrl+C ignored (SSH, services, `detached: true`). Like node-pty, this also re-enables Ctrl+C handling in the Bun process itself.
- Add `Bun.Terminal.pause()` and `resume()` for output backpressure: child writes block when the PTY queue fills, and PTY exit follows resumed output delivery.
- Keep macOS subprocess exit handling non-blocking when kqueue reports ESRCH before a terminal child can be reaped.
- Use a private fallback for unusable POSIX `node` shim directories instead of silently dropping `node`, warn when no shim can be created, and honor `BUN_TMPDIR` for the shim like the node-gyp directory.
- Adapt upstream [#35565](https://github.com/oven-sh/bun/pull/35565): key the lifecycle-script and `--bun` `node` shim directory on the user id (`/tmp/bun-node-<uid>-<sha>`), so a shim directory another user created on the same host no longer drops `node` from lifecycle-script `PATH` (upstream [#42048](https://github.com/oven-sh/bun/issues/42048)).
- Adapt upstream [#33288](https://github.com/oven-sh/bun/pull/33288) to preserve `node:diagnostics_channel` subscribers for an in-flight publication when callbacks subscribe, unsubscribe, or publish recursively.
- Mark inherited POSIX descriptors close-on-exec at startup like Node, preventing native-spawned children from keeping stdio pipes open after Bun exits.
- Adapt upstream [#34980](https://github.com/oven-sh/bun/pull/34980): read explicit `--tsconfig-override` paths without borrowing an unrelated directory descriptor, avoiding spurious directory-mismatch diagnostics while preserving override resolution.
- Integrate upstream [#40005](https://github.com/oven-sh/bun/pull/40005) at `900eae3`: `node:sqlite` `DatabaseSync.close()` and `Symbol.dispose()` finalize outstanding statements, so WAL/shared-memory files, file locks, and descriptors are released immediately. Virtual-table modules such as FTS5 and sqlite-vec keep ownership of their private statements.
- Publish tagged `main` commits as GitHub releases: release builds for darwin-arm64, darwin-x64, linux-x64 and linux-arm64, smoke-tested on their own platforms, with SHA-256 checksums, a pinnable `manifest.json` naming the fork commit and WebKit revision, and build provenance attestations. See `.github/OPENCLAW_RELEASE.md`.
- Preserve file-URL entry identity and literal `?` paths in `Bun.ModuleGraph`, and avoid retaining GC-backed string views across macro transpilation.
- Prepare daily or manually requested upstream merges as frozen draft PRs, preserving fork history and stopping visibly on conflicts or permission failures.
- Deliver `node:http` write callbacks when uncorking introduces transport backpressure, and retain error callbacks when the peer resets before the buffered write drains.
- Preserve `node:http` request bodies after early responses, including paused reads, pipelined requests, and incomplete-upload cancellation.
- Sync upstream through `29d9638da3dd5b498a5b608d3fa02549b0bdddf1`, preserving the fork's compatibility patches and their contributor histories. Reconcile timer hooks, module cache keys, and HTTP/TLS lifecycle behavior with upstream ModuleGraph ownership and builtin type checking.
- Backport upstream [#42767](https://github.com/oven-sh/bun/pull/42767) to preserve keyword spacing after a long-lived process transpiles more than 2 GiB of modules.
- Preserve raw Buffer filename bytes and file types in `fs.readdir` and `fs.opendir` directory entries when `encoding: "buffer"` is requested.
- Integrate 19 pending upstream PRs for filesystem, SQLite, worker, async-hook, HTTP/TLS, module-loader, process, and path compatibility, retaining their original histories and required worker/query-cache prerequisites.
- Resolve interactions between worker and timer hooks, pending HTTPS listen configuration, forceful shutdown after graceful close, and literal filename delimiters in module resolution and lookup paths.
- Generate Node compile-cache entries after idle periods and bound automatic persistence to 250 ms after SIGTERM, SIGINT, or SIGHUP; preserve full persistence on normal exits and explicit flushes, with atomic cache writes.
- Emit exactly one `async_hooks` destroy event after a Worker exits, including termination and errors, while preserving hook dispatch snapshots.
- Abort HTTP connections when a request or response is destroyed asynchronously, preserving pending-write and pipelined-response cleanup without sending an empty success response.
- Honor `tls.setDefaultCACertificates()` in native fetch, including empty trust sets, while preserving explicit request/session CAs and matching TLS pool configuration.

- Match Node child-process diagnostics, unspawned getters, failed-spawn EOF and IPC, exit-before-drain ordering, and POSIX PATH permission errors. Adapts the diagnostics proposal in [oven-sh/bun#30080](https://github.com/oven-sh/bun/pull/30080). Thanks @robobun!

- Keep recursive `fs.promises.readdir` Dirent traversal out of directory symlink targets and preserve the immutable full startup argv in `process.report` on every platform.

- Match Node minimatch semantics in `path.matchesGlob()`, including negated extglobs and dot-segment normalization, using the existing filesystem glob matcher.
- Preserve cached `process.env` and `Bun.env` references when the first `SHARE_ENV` worker starts, including shared writes, deletes, property definitions, and enumeration.
- Route Windows environment writes to the shared store when value coercion starts the first `SHARE_ENV` worker, preserving symbol errors and descriptor validation.
- Keep JIT-optimized environment deletes connected to the shared store after `SHARE_ENV` promotion. Adapts the property-cache guard from [oven-sh/bun#38871](https://github.com/oven-sh/bun/pull/38871). Thanks @robobun!
- Preserve literal post-script `--` arguments for direct Bun and Node-compatible file entrypoints, including preloads, while retaining command separator handling for `bun run` and package scripts.
- Include nonenumerable CommonJS data exports in modules with `__esModule` and accessors, matching Node without exposing nonenumerable getters.
- Support POSIX `process.stdout` and `process.stderr` `_handle.setBlocking()` so native writers can clear nonblocking mode and avoid truncated pipe output.
- Port [oven-sh/bun#44067](https://github.com/oven-sh/bun/pull/44067): register macOS file watches with kqueue before returning, deliver unlink and open-writer changes, and let new watchers observe replaced files. Directory watches retain FSEvents. Thanks @robobun!
- Report allocated worker heap capacity in `Worker.getHeapStatistics().total_heap_size`, separately from occupied bytes in `used_heap_size`.
- Make `process.title` and `--title` visible to OS process tools on Linux and macOS while preserving startup argv and worker-local assignments. Ports [oven-sh/bun#44318](https://github.com/oven-sh/bun/pull/44318). Thanks @tnrich!
- Propagate synchronous `process.emit()` listener exceptions to the caller, preserving once-listener removal and stopping dispatch before later listeners.
- Poll macOS file watches on their owning JavaScript event loop so kqueue coalesces bursts like Node, preserving directory watches, inode replacement, and unref behavior.
- Emit queued HTTP upgrades immediately and defer built-in WebSocket adoption until earlier responses drain. Adapts [oven-sh/bun#43441](https://github.com/oven-sh/bun/pull/43441), preserving the fork's socket backpressure and pause behavior. Thanks @robobun!
- Disable runtime auto-install by default in the OpenClaw fork, including workers and child processes; retain explicit CLI/bunfig opt-ins and package-manager installs.
- Build and test macOS arm64 pull requests with cached release builds, downloadable executables, and file, directory, recursive watch, process, and child-process coverage.
- Publish `child_process.spawn` tracing start, end, and error events with Node-compatible timing and child identity.
- Preserve socket destroy errors before canceling in-flight writes with `ECANCELED`, including TLS and corked writes. Ports [oven-sh/bun#43250](https://github.com/oven-sh/bun/pull/43250). Thanks @robobun!
- Preserve MessagePort creation async context for message and close events, including transferred ports and garbage collection.
- Borrow process stdout/stderr descriptors without duplicating them, so explicitly closing an initialized output fd publishes EOF while the process remains alive.
- Read implemented Node runtime flags from `NODE_OPTIONS`, including ordered require/import preloads in children, while keeping injected flags out of `process.execArgv`. Ports [oven-sh/bun#40328](https://github.com/oven-sh/bun/pull/40328). Thanks @robobun!
- Preserve emitted MessagePort and parentPort payloads and return listener presence from `emit()`. Ports [oven-sh/bun#35796](https://github.com/oven-sh/bun/pull/35796). Thanks @robobun!

- Drain the calling VM's concurrent JIT plans before `Bun.gc(true)`, `globalThis.gc()`, and `bun:jsc` full collections so compiler roots do not retain otherwise unreachable objects.

- Half-close POSIX socket stdout/stderr after `end()` or pipeline completion without closing fd 1/2, restore nonblocking pipe setup, and preserve Node's pipe shutdown and later-write behavior.
- Implement synchronous `node:module.registerHooks()` with Node 24 resolution context, URL identity, source transformation, dynamic import attributes, and deregistration semantics; static import attributes remain unavailable to hooks. Ports [oven-sh/bun#35690](https://github.com/oven-sh/bun/pull/35690). Thanks @cirospaciari!
- Reject unsafe same-key hook loads with `ERR_MODULE_HOOK_REENTRANCY` and static resolve-returned type attributes with `ERR_MODULE_HOOK_ATTRIBUTE_IDENTITY`; document JavaScriptCore's static input-attribute and repeated cycle-resolution limits.
- Deduplicate identical static hook loads, preserve native Bun-module handoffs, and decode data-URL base64 markers with Node-compatible casing rules.
- Preserve reentrant native builtin loads without losing load-hook calls, keep conflicting builtin source overrides loud, and reject invalid data-URL base64 bytes and padding.
- Give synchronous module hooks valid, consistent URLs for Bun's built-in package replacements, using installed package file URLs or `bun-builtin:` fallback URLs while preserving native delegation and hook source overrides.
- Normalize opaque plugin module identifiers to valid `bun-virtual:` hook URLs while preserving native plugin callbacks and synthetic URL loading after hook deregistration.

- Close silent pre-request `node:http` clients on Linux during `server.close()` plus `closeAllConnections()` by accepting them immediately. Ports [oven-sh/bun#36074](https://github.com/oven-sh/bun/pull/36074). Thanks @robobun!

- Match Node read/write overload defaults and validation for explicit undefined/null arguments, zero-length reads, bigint positions, and buffer ranges. Adapts [oven-sh/bun#37647](https://github.com/oven-sh/bun/pull/37647). Thanks @robobun!

- Make newly assigned Windows native environment variables enumerable so environment copies and children retain them. Adapts [oven-sh/bun#35254](https://github.com/oven-sh/bun/pull/35254). Thanks @robobun!

- Allow later Windows pipe stdout/stderr writes after `end()` and pipeline completion, matching Node while preserving POSIX socket shutdown.

- Preserve already-fetched CommonJS-to-ESM module keys through linking so Windows forward-slash aliases and paths containing dot segments do not crash when reading exports.

- Cache repeated `node:vm` compilations after 1,750 distinct source fingerprints with a 256 MiB per-VM byte LRU, configurable through `BUN_VM_COMPILE_CACHE_SIZE`, while preserving fresh evaluations, context globals, import callback identities, and cached-data validation.

- Use glibc's vectorized comparison for long, same-encoding VM compilation-cache sources on Linux x64 while preserving complete source validation.

- Match Node 24.21 package metadata validation during import and require, preserve lazy scope/condition checks and ignored fields, reject unreadable selected metadata, and retain CommonJS parent paths in resolution diagnostics. Adapts [oven-sh/bun#33890](https://github.com/oven-sh/bun/pull/33890) and [oven-sh/bun#35711](https://github.com/oven-sh/bun/pull/35711). Thanks @robobun and @cirospaciari!

- Preserve Node's deferred JSON diagnostics for both package maps and accept JSON-encoded maps in string fields.
- Refresh missing runtime files after `Bun.plugin` hook registration so delegated resolution sees newly created package-import targets.

- Sync upstream through `7a503a7899dcf12186187c38df9f3c96b3ab9ad4`, preserving fork module hooks, plugin import kinds, URL identity, and compatibility patches while adopting resolution-once loading and WebKit `1600131e46b5af48bbda3559af8d8a3327230b6e`.

- Allow package imports to target recognized `bun:` built-ins while retaining Node 24.21 validation for unknown names, other URL schemes, and exports targets.

- Limit the `bun:` package-import exception to scalar targets outside fallback arrays, preserving Node 24.21 array selection and errors for native and captured module loading.

- Count allocations since the most recent garbage collection in process, V8-compatible, and worker heap statistics, including newly retained JavaScript array storage.

- Publish cached resolver paths once so worker resolution and filesystem-router reloads cannot expose truncated symlink targets. Adapts [oven-sh/bun#40258](https://github.com/oven-sh/bun/pull/40258). Thanks @robobun!

- Support asynchronous full garbage collection through `node:inspector` HeapProfiler sessions on the main thread and workers, with Node-compatible connection errors and pending callback cleanup.

- Publish Node HTTP server request-start and response-created diagnostics before request dispatch, preserving response constructor timing and covering injected HTTP/1 connections. Adapts [oven-sh/bun#29588](https://github.com/oven-sh/bun/pull/29588) and [oven-sh/bun#32628](https://github.com/oven-sh/bun/pull/32628). Thanks @robobun and @cirospaciari!

- Apply `NODE_OPTIONS` and `BUN_OPTIONS` preloads in Node workers with explicit environments and `execArgv`, preserve selected CLI arguments through nested workers, and apply supported worker restrictions before preloads. Builds on [oven-sh/bun#42620](https://github.com/oven-sh/bun/pull/42620).

- Emit `ws` text messages as Buffers regardless of `binaryType` on clients and server connections, preserving JSON decoding and the `isBinary=false` flag.

- Support `ws` server-connection `pause()`, `resume()`, and `isPaused` with native socket read backpressure.

- Validate `net`, `http`, and `https` listen ports synchronously before binding, preserving asynchronous bind errors and Node-compatible numeric string parsing. Adapts string routing from [oven-sh/bun#34083](https://github.com/oven-sh/bun/pull/34083). Thanks @robobun!

- Match Node process property descriptors, including lazy `argv`/`execArgv` data properties and descriptor replacement in native argument readers. Adapts [oven-sh/bun#34229](https://github.com/oven-sh/bun/pull/34229) and [oven-sh/bun#44356](https://github.com/oven-sh/bun/pull/44356). Thanks @robobun!

- Switch the fork’s default WebKit source to immutable openclaw/WebKit releases with a committed SHA-256 manifest, verified extraction, and digest-keyed caches.

- Allow Proxy objects in VM and main-realm global prototype chains with the pinned OpenClaw WebKit, including jsdom Window prototypes. Ports [oven-sh/bun#42347](https://github.com/oven-sh/bun/pull/42347). Thanks @robobun!

- Add experimental Node worker resource limits with per-VM managed-heap termination, nursery and stack sizing, and effective-limit reporting using the pinned OpenClaw WebKit. Code-range limits remain reporting-only. Adapts [oven-sh/bun#32896](https://github.com/oven-sh/bun/pull/32896). Thanks @robobun!

- Preserve importing AsyncLocalStorage contexts across module-loader hooks, static and dynamic dependencies, top-level await, shared imports, and errors with the pinned OpenClaw WebKit; add Node-comparable loader regressions. Related to [oven-sh/bun#37933](https://github.com/oven-sh/bun/pull/37933). Thanks @robobun!

- Fix Intl.Segments.containing() at both halves of surrogate pairs with the pinned OpenClaw WebKit; cover grapheme, word, and sentence boundaries in both lookup directions. Ports [oven-sh/WebKit#753](https://github.com/oven-sh/WebKit/pull/753). Thanks @robobun!

- Reduce kernel CPU during cold module imports on macOS by serializing transpiler-cache writes while preserving parallel parsing and cache reads.

- Keep ESM namespaces free of inherited `__esModule` markers and preserve the own marker and live exports for `require(esm)`, fixing Vite/tsx namespace interop. Adapts [oven-sh/bun#33894](https://github.com/oven-sh/bun/pull/33894) and [oven-sh/WebKit#279](https://github.com/oven-sh/WebKit/pull/279). Thanks @robobun!


- Sync oven-sh/bun through `c7b06d94bac19817ba34b6677bb1099fb4f6d2be`, preserving fork fixes and incorporating TLS handshake shutdown, macOS split-DNS failover, file-body cloning, Buffer write validation, mimalloc 3.5.3 and idle-memory release.
- Pin immutable [OpenClaw WebKit `42ab38d705`](https://github.com/openclaw/WebKit/releases/tag/autobuild-42ab38d705d4838748ccee77e7deb0e4e35515ee) by archive checksum, together with the required namespace facade integration from #106; retain fail-closed artifact selection.

- Preserve package-scope CommonJS interop in async imports without replacing the file's parser format. Adapts [oven-sh/bun#40940](https://github.com/oven-sh/bun/pull/40940). Thanks @robobun!

- Sync upstream nightly through `d4928764f23213ecf3cd61fa0b5b4a44369a5096`, configuring fetch TLS once per connection so pooled sockets can be reused during renegotiation without repeating session setup.
- Sync upstream nightly through `9bd19c98eacc01530a4e7609bc427abffa87d77e`, preserving PostgreSQL query ordering through errors and limiting MySQL row-decoding failures to the affected query.
- Support real byte-based `node:inspector` HeapProfiler allocation sampling with allocation-site trees, live profiles, and major/minor GC inclusion flags (requires the OpenClaw WebKit allocation sampler).
- Preserve built-in error constructor syntax and returning arrow frames, and use JSC syntax-selected call and property-read stack positions. Retain runtime callee parentheses and computed access, and map call, bracket, and template delimiters back to their original source. Continues the source-position fixes from [oven-sh/bun#35179](https://github.com/oven-sh/bun/pull/35179), [oven-sh/bun#37396](https://github.com/oven-sh/bun/pull/37396), and [oven-sh/bun#41580](https://github.com/oven-sh/bun/pull/41580). Thanks @robobun!
- Add position-preserving `module.stripTypeScriptTypes()` strip mode for tooling that analyzes TypeScript exports. Adapts [oven-sh/bun#35517](https://github.com/oven-sh/bun/pull/35517); thanks @cirospaciari!
