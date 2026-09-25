# OpenClaw Bun fork changelog

## Unreleased

- Backport upstream [#42767](https://github.com/oven-sh/bun/pull/42767) to preserve keyword spacing after a long-lived process transpiles more than 2 GiB of modules.
- Preserve raw Buffer filename bytes and file types in `fs.readdir` and `fs.opendir` directory entries when `encoding: "buffer"` is requested.
- Integrate 19 pending upstream PRs for filesystem, SQLite, worker, async-hook, HTTP/TLS, module-loader, process, and path compatibility, retaining their original histories and required worker/query-cache prerequisites.
- Resolve interactions between worker and timer hooks, pending HTTPS listen configuration, forceful shutdown after graceful close, and literal filename delimiters in module resolution and lookup paths.
