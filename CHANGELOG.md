# Changelog

## Unreleased

- Add Bun.build branch and arrival instrumentation options for native AOT coverage, matching the CLI counters.
- Keep removed built-in source text empty when constructing its source provider, so trimmed AOT executables can start.
- Preserve references captured from `process.env` and `Bun.env` when a worker joins a `SHARE_ENV` tree on macOS and Linux.
- Preserve process-owned POSIX file locks when resolving real paths on macOS.
- Support external build directories and source checkouts whose paths contain spaces, and keep generated-code reconfiguration rooted in the source checkout.
- Enable explicitly requested trimmable native macOS builds with a matching `ld64.lld` linker.
