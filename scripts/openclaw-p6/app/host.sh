#!/usr/bin/env bash
set -euo pipefail
phase=${1:?bootstrap, prepare, variant or cleanup}
: "${P6_WORK:?Missing task directory}"
: "${P6_CONTAINER:?Missing owned container}"
recipe=$(cd "$(dirname "$0")/.." && pwd -P)
mode=${P6_EXECUTION_MODE:-app}
case "$mode" in app|benchmark) ;; *) exit 2;; esac
initializer="$recipe/app/initialize.py"
if [[ "$mode" == benchmark ]]; then initializer="$recipe/app/benchmark/initialize.py"; fi
base=/home/runner/.cache/oc-ty-ext/P6
root=$base/app-x64-final-r3-v1
label="openclaw.p6.actions=$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT"
paging() {
  sudo -n env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin P6_WORK="$P6_WORK" \
    GITHUB_REPOSITORY="$GITHUB_REPOSITORY" GITHUB_RUN_ID="$GITHUB_RUN_ID" \
    GITHUB_RUN_ATTEMPT="$GITHUB_RUN_ATTEMPT" GITHUB_JOB="$GITHUB_JOB" GITHUB_SHA="$GITHUB_SHA" \
    python3 -B "$recipe/app/paging-host.py" "$@"
}
remove_children() {
  local ids
  ids=$(timeout --kill-after=5s 30s docker ps -aq --filter "label=$label")
  if [[ -n "$ids" ]]; then
    while IFS= read -r id; do timeout --kill-after=5s 30s docker rm -f "$id"; done <<< "$ids"
  fi
  ids=$(timeout --kill-after=5s 30s docker network ls -q --filter "label=$label")
  if [[ -n "$ids" ]]; then
    while IFS= read -r id; do timeout --kill-after=5s 30s docker network rm "$id"; done <<< "$ids"
  fi
  [[ -z "$(timeout --kill-after=5s 30s docker ps -aq --filter "label=$label")" ]]
  [[ -z "$(timeout --kill-after=5s 30s docker network ls -q --filter "label=$label")" ]]
}
ensure_running() {
  [[ $(timeout --kill-after=5s 30s docker inspect --format '{{index .Config.Labels "openclaw.p6.owner"}}' "$P6_CONTAINER") == "$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT" ]]
  if [[ $(timeout --kill-after=5s 30s docker inspect --format '{{.State.Running}}' "$P6_CONTAINER") != true ]]; then
    remove_children
    timeout --kill-after=10s 50s docker start "$P6_CONTAINER" >/dev/null
  fi
}
if [[ "$phase" == cleanup ]]; then
  timeout --kill-after=5s 30s docker stop --time 15 "$P6_CONTAINER" >/dev/null 2>&1 || true
  timeout --kill-after=5s 30s docker rm -f "$P6_CONTAINER" >/dev/null 2>&1 || true
  [[ -z "$(timeout --kill-after=5s 30s docker ps -aq --filter "name=^${P6_CONTAINER}$")" ]]
  remove_children
  if [[ "$mode" == app ]]; then
    paging cleanup
  else
    python3 -B "$initializer" cleanup
  fi
  exit
fi
: "${P6_DEADLINE_EPOCH:?Missing absolute work deadline}"
remember_terminal() {
  if (( $1 == 124 || $1 >= 128 )); then
    python3 -B "$initializer" terminal "$1" || true
  fi
}
stop_on_failure() {
  code=$?
  if (( code != 0 )); then
    remember_terminal "$code"
    timeout --kill-after=5s 30s docker stop --time 15 "$P6_CONTAINER" >/dev/null 2>&1 || true
    remove_children || true
  fi
  return "$code"
}
trap stop_on_failure EXIT
if [[ "$phase" == bootstrap ]]; then
  [[ $(uname -s) == Linux && $(uname -m) == x86_64 ]]
  [[ ! -e "$root" ]]
  mkdir -p "$P6_WORK" "$base"
  python3 -B "$initializer"
  if [[ "$mode" == app ]]; then
    timeout --kill-after=15s 300s sudo -n apt-get update
    timeout --kill-after=15s 300s sudo -n apt-get install -y --no-install-recommends cryptsetup
  fi
  image=ubuntu:24.04@sha256:a2d43bffc46670d7108bb3c0468c67c5557c4c92e83e1e34cbff1322ad1b94dc
  timeout --kill-after=15s 300s docker pull "$image"
  devices=()
  if [[ -c /dev/kvm ]]; then devices=(--device /dev/kvm:/dev/kvm); fi
  inputs=()
  if [[ "$mode" == benchmark ]]; then
    [[ -d "$P6_WORK/benchmark-download" ]]
    inputs=(--mount "type=bind,src=$P6_WORK/benchmark-download,dst=$P6_WORK/benchmark-download,readonly")
  fi
  buildx=$(timeout --kill-after=5s 30s docker info --format '{{range .ClientInfo.Plugins}}{{if eq .Name "buildx"}}{{.Path}}{{end}}{{end}}')
  [[ -n "$buildx" && -f "$buildx" && -x "$buildx" ]]
  timeout --kill-after=10s 50s docker run --detach --name "$P6_CONTAINER" --init \
    --platform linux/amd64 --ulimit core=0:0 --label "openclaw.p6.owner=$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT" \
    "${devices[@]}" \
    --mount "type=bind,src=$recipe,dst=/p6-recipe,readonly" \
    --mount "type=bind,src=$base,dst=$base" \
    --mount "type=bind,src=$P6_WORK,dst=$P6_WORK" \
    "${inputs[@]}" \
    --mount "type=bind,src=$P6_WORK/execution.json,dst=/p6-execution.json,readonly" \
    --mount "type=bind,src=$(command -v docker),dst=/p6-host-docker,readonly" \
    --mount "type=bind,src=$buildx,dst=/p6-host-buildx,readonly" \
    --mount type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock \
    "$image" sleep infinity >/dev/null
  timeout --kill-after=5s 30s docker exec "$P6_CONTAINER" ln -s /p6-recipe/app/docker-client.py /usr/bin/docker
  timeout --kill-after=5s 30s docker exec "$P6_CONTAINER" mkdir -p /usr/libexec/docker/cli-plugins
  timeout --kill-after=5s 30s docker exec "$P6_CONTAINER" ln -s /p6-host-buildx /usr/libexec/docker/cli-plugins/docker-buildx
  exit
fi
[[ "$mode" == app ]] || { echo 'Benchmark phases use benchmark/host.py' >&2; exit 2; }
if [[ "$phase" == paging ]]; then
  remaining=$((P6_DEADLINE_EPOCH - $(date +%s) - 1200))
  (( remaining > 120 )) || exit 124
  sudo -n python3 -B - "$root/prep-receipts/plugins/result.json" <<'PY'
import json,sys
from pathlib import Path
assert json.loads(Path(sys.argv[1]).read_text())['status']=='PASS', 'Actual completed native preparation required'
PY
  timeout --signal=TERM --kill-after=30s "${remaining}s" docker exec \
    -e HOME=/home/runner -e P6_WORK="$P6_WORK" -e PYTHONDONTWRITEBYTECODE=1 \
    "$P6_CONTAINER" python3 -B /p6-recipe/app/preflight.py verify
  paging activate
  exit
fi
remaining=$((P6_DEADLINE_EPOCH - $(date +%s) - 1200))
if (( remaining <= 120 )); then
  python3 -B "$recipe/app/initialize.py" skip "${2:-$phase}" deadline
  [[ "$phase" != prepare ]] || exit 124
  exit 0
fi
if [[ ( "$phase" == variant || "$phase" == guest ) && -f "$P6_WORK/terminal.json" ]]; then
  python3 -B "$recipe/app/initialize.py" skip "${2:-$phase}" previous-terminal-exit
  exit 0
fi
if [[ "$phase" == variant ]]; then
  ensure_running
  timeout --signal=TERM --kill-after=30s "${remaining}s" docker exec \
    -e HOME=/home/runner -e P6_WORK="$P6_WORK" -e P6_DEADLINE_EPOCH="$P6_DEADLINE_EPOCH" \
    -e PYTHONDONTWRITEBYTECODE=1 "$P6_CONTAINER" bash /p6-recipe/app/variant.sh "$2" prepare
  paging verify "$2"
  script=variant.sh
elif [[ "$phase" == prepare ]]; then
  script=prepare.sh
elif [[ "$phase" == guest ]]; then
  ensure_running
  script=guest.sh
else
  echo "Unknown app phase: $phase" >&2
  exit 2
fi
remaining=$((P6_DEADLINE_EPOCH - $(date +%s) - 1200))
(( remaining > 0 )) || exit 124
code=0
timeout --signal=TERM --kill-after=30s "${remaining}s" docker exec \
  -e HOME=/home/runner -e P6_WORK="$P6_WORK" -e P6_DEADLINE_EPOCH="$P6_DEADLINE_EPOCH" \
  -e PYTHONDONTWRITEBYTECODE=1 "$P6_CONTAINER" bash "/p6-recipe/app/$script" "${2:-}" run || code=$?
remember_terminal "$code"
if (( code != 0 )); then
  timeout --kill-after=5s 30s docker stop --time 15 "$P6_CONTAINER" >/dev/null 2>&1 || true
fi
remove_children
exit "$code"
