#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ $# -eq 1 ]] || { echo 'Usage: run-phase.sh plan|install|inventory|node-core|bun-core|config|cohort' >&2; exit 2; }
phase=$1
case "$phase" in plan|install|inventory|node-core|bun-core|config|cohort) ;; *) exit 2;; esac
root=/home/runner/.cache/oc-ty-ext/P6/app-x64-final-r3-v1
here="$(cd "$(dirname "$0")" && pwd -P)"
[[ "$here" == "$root/benchmark-prep" && $(uname -s) == Linux && $(uname -m) == x86_64 ]]
node="$root/opt/node/bin/node"
bun="$root/compilers/standard/bun"
work="$here/work"
if [[ "$phase" == plan ]]; then
  [[ ! -e "$work" ]]
  mkdir -p "$work/home" "$work/tmp" "$work/cache" "$work/npm-cache" "$work/installed"
  : > "$work/empty.npmrc"
  cp "$here/project-package.manifest.json" "$work/installed/package.json"
else
  [[ -d "$work" ]]
fi
entry="$work/installed/node_modules/openclaw/openclaw.mjs"
clean() { exec env -i HOME="$work/home" TMPDIR="$work/tmp" XDG_CACHE_HOME="$work/cache" NPM_CONFIG_CACHE="$work/npm-cache" NPM_CONFIG_USERCONFIG="$work/empty.npmrc" NPM_CONFIG_GLOBALCONFIG=/dev/null PATH="$root/opt/node/bin:$root/opt/bin:/usr/local/bin:/usr/bin:/bin" LANG=C.UTF-8 TZ=UTC "$@"; }
runtime() { exec env -i HOME="$work/home" TMPDIR="$work/tmp" PATH=/usr/bin:/bin LANG=C.UTF-8 TZ=UTC "$@"; }
case "$phase" in
  install|node-core|bun-core)
    env -i HOME="$work/home" TMPDIR="$work/tmp" PATH=/usr/bin:/bin LANG=C.UTF-8 TZ=UTC "$node" "$here/metadata.mjs" baseline
    ;;
esac
case "$phase" in
  plan) clean "$node" "$here/metadata.mjs" plan ;;
  install) clean python3 "$here/measure-install.py" ;;
  inventory) clean "$node" "$here/metadata.mjs" installed ;;
  node-core) runtime "$node" "$here/benchmark/core-runner.proposed.mjs" --source "$root/source" --runtime "$node" --entry "$entry" --out "$work/node-core" ;;
  bun-core) runtime "$node" "$here/benchmark/core-runner.proposed.mjs" --source "$root/source" --runtime "$bun" --entry "$entry" --out "$work/bun-core" ;;
  config) clean "$node" "$here/metadata.mjs" cohort ;;
  cohort)
    env -i HOME="$work/home" TMPDIR="$work/tmp" PATH=/usr/bin:/bin LANG=C.UTF-8 TZ=UTC "$node" "$here/metadata.mjs" verify
    runtime python3 "$here/stream-cohort.py" "$work/cohort" -- "$node" "$here/benchmark/run-cohort.mjs" "$work/cohort-config.json" "$work/cohort"
    ;;
esac
