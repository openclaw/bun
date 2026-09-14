# OpenClaw Bun fork changelog

## Unreleased

- Integrate 19 pending upstream PRs for filesystem, SQLite, worker, async-hook, HTTP/TLS, module-loader, process, and path compatibility, retaining their original histories and required worker/query-cache prerequisites.
- Resolve interactions between worker and timer hooks, pending HTTPS listen configuration, forceful shutdown after graceful close, and literal filename delimiters in module resolution and lookup paths.
