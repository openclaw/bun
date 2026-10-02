# OpenClaw Bun fork changelog

## Unreleased

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
