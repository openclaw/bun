#!/usr/bin/env bash
set -euo pipefail
phase=${1:?bootstrap, cb-standard or cb-compat}
: "${P6_DEADLINE_EPOCH:?Missing absolute work deadline}"
root=/root/.cache/oc-ty-ext/P6/rd150c-x64-highmem-deadline-v1
recipe=/p6-recipe
proof=/root/.cache/oc-ty-ext/P6/proof
mkdir -p "$proof"
bounded() {
  python3 "$recipe/deadline_process.py" --deadline-epoch "$P6_DEADLINE_EPOCH" \
    --reserve-seconds 600 --cleanup-grace-seconds 15 --receipt "$proof/$1-deadline.json" -- "${@:2}"
}
if [[ "$phase" == bootstrap ]]; then
  [[ $(uname -m) == x86_64 && $(uname -s) == Linux ]]
  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  apt-get install -y --no-install-recommends python3 ca-certificates git
  python3 - "$proof/resources.json" <<'PY'
import json,os,pathlib,shutil,sys
memory=int(next(x.split()[1] for x in pathlib.Path('/proc/meminfo').read_text().splitlines() if x.startswith('MemTotal:')))*1024
limit=pathlib.Path('/sys/fs/cgroup/memory.max')
cgroup=limit.read_text().strip() if limit.exists() else None
effective=min(memory,int(cgroup)) if cgroup and cgroup!='max' else memory
facts={'memTotalBytes':memory,'cgroupMemoryMax':cgroup,'effectiveMemoryBytes':effective,
       'cpus':len(os.sched_getaffinity(0)),'diskFreeBytes':shutil.disk_usage('/root/.cache/oc-ty-ext/P6').free,
       'kernel':os.uname().release,'memoryFitQualified':False}
pathlib.Path(sys.argv[1]).write_text(json.dumps(facts,indent=2)+'\n')
assert effective>=30_000_000_000 and facts['cpus']>=2 and facts['diskFreeBytes']>=25_000_000_000, facts
PY
  bounded stage python3 "$recipe/stage.py"
  bounded bootstrap bash "$root/bootstrap.sh" "$root"
  cd "$root/bun"
  bounded source-preflight "$root/opt/bun-linux-x64-baseline/bun" scripts/glob-sources.ts --all > "$proof/source-globs-all.txt"
elif [[ "$phase" == cb-standard || "$phase" == cb-compat ]]; then
  bounded "$phase-build" python3 "$root/build-bun-standalone-cb.py" --root "$root" \
    --profile "$phase" --lease-deadline-epoch "$P6_DEADLINE_EPOCH"
  bounded "$phase-preserve" python3 "$root/preserve-compiler.py" --root "$root" --profile "$phase"
  bounded "$phase-raw" python3 "$root/preserve-run-evidence.py" --root "$root" --profile "$phase"
else
  echo "Unknown phase: $phase" >&2
  exit 2
fi
