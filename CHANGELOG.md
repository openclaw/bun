# OpenClaw Bun fork changelog

## Unreleased

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
