# Changelog

## Unreleased

- Preserve references captured from `process.env` and `Bun.env` when a worker joins a `SHARE_ENV` tree on macOS and Linux.
- Preserve process-owned POSIX file locks when resolving real paths on macOS.
- Support external build directories and source checkouts whose paths contain spaces, and keep generated-code reconfiguration rooted in the source checkout.
