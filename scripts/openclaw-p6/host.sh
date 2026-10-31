#!/usr/bin/env bash
set -euo pipefail
phase=${1:?bootstrap, cb-standard, cb-compat or cleanup}
: "${P6_WORK:?Missing task directory}"
: "${P6_CONTAINER:?Missing owned container name}"
if [[ "$phase" == cleanup ]]; then
  timeout --kill-after=5s 20s docker stop --time 10 "$P6_CONTAINER" > /dev/null 2>&1 || true
  timeout --kill-after=5s 20s docker inspect "$P6_CONTAINER" > "$P6_WORK/container-final.json" 2>/dev/null || true
  timeout --kill-after=5s 20s docker rm --force "$P6_CONTAINER" > /dev/null 2>&1 || true
  timeout --kill-after=5s 20s docker ps --all --quiet --filter "name=^${P6_CONTAINER}$" > "$P6_WORK/containers-after-cleanup.txt"
  [[ ! -s "$P6_WORK/containers-after-cleanup.txt" ]]
  exit 0
fi
: "${P6_DEADLINE_EPOCH:?Missing absolute work deadline}"
cleanup_on_error() {
  code=$?
  if (( code != 0 )); then
    timeout --kill-after=5s 20s docker stop --time 10 "$P6_CONTAINER" > /dev/null 2>&1 || true
  fi
  exit "$code"
}
trap cleanup_on_error EXIT
trap 'exit 143' TERM
trap 'exit 130' INT
trap 'exit 129' HUP
remaining=$(( P6_DEADLINE_EPOCH - $(date +%s) - 600 ))
(( remaining > 0 )) || exit 124
if [[ "$phase" == bootstrap ]]; then
  [[ $(uname -m) == x86_64 && $(uname -s) == Linux ]]
  image=ubuntu:24.04@sha256:a2d43bffc46670d7108bb3c0468c67c5557c4c92e83e1e34cbff1322ad1b94dc
  timeout --kill-after=15s 300s docker pull "$image"
  recipe=$(cd "$(dirname "$0")" && pwd -P)
  mkdir -p "$P6_WORK/data"
  remaining=$(( P6_DEADLINE_EPOCH - $(date +%s) - 600 ))
  (( remaining > 10 )) || exit 124
  start_seconds=$(( remaining - 10 ))
  (( start_seconds <= 50 )) || start_seconds=50
  timeout --signal=TERM --kill-after=10s "${start_seconds}s" \
    docker run --detach --name "$P6_CONTAINER" --init --platform linux/amd64 \
    --mount "type=bind,src=$recipe,dst=/p6-recipe,readonly" \
    --mount "type=bind,src=$P6_WORK/data,dst=/root/.cache/oc-ty-ext/P6" \
    "$image" sleep infinity > /dev/null
fi
remaining=$(( P6_DEADLINE_EPOCH - $(date +%s) - 600 ))
(( remaining > 0 )) || exit 124
timeout --signal=TERM --kill-after=20s "${remaining}s" \
  docker exec -e P6_DEADLINE_EPOCH="$P6_DEADLINE_EPOCH" -e PYTHONDONTWRITEBYTECODE=1 \
  "$P6_CONTAINER" bash /p6-recipe/container.sh "$phase"
