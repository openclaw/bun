# OpenClaw Bun fork changelog

## Unreleased

- Deliver `node:http` write callbacks when uncorking introduces transport backpressure, and retain error callbacks when the peer resets before the buffered write drains.
- Sync upstream through `29d9638da3dd5b498a5b608d3fa02549b0bdddf1`, preserving the fork's compatibility patches and their contributor histories. Reconcile timer hooks, module cache keys, and HTTP/TLS lifecycle behavior with upstream ModuleGraph ownership and builtin type checking.
- Backport upstream [#42767](https://github.com/oven-sh/bun/pull/42767) to preserve keyword spacing after a long-lived process transpiles more than 2 GiB of modules.
- Preserve raw Buffer filename bytes and file types in `fs.readdir` and `fs.opendir` directory entries when `encoding: "buffer"` is requested.
- Integrate 19 pending upstream PRs for filesystem, SQLite, worker, async-hook, HTTP/TLS, module-loader, process, and path compatibility, retaining their original histories and required worker/query-cache prerequisites.
- Resolve interactions between worker and timer hooks, pending HTTPS listen configuration, forceful shutdown after graceful close, and literal filename delimiters in module resolution and lookup paths.
