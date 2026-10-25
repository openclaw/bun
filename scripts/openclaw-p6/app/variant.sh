#!/usr/bin/env bash
set -euo pipefail
variant=${1:?variant required}
root=/home/runner/.cache/oc-ty-ext/P6/app-x64-final-r3-v1
recipe=/p6-recipe/app
cd "$P6_WORK"
mode=${2:?prepare or run}
if [[ "$mode" == prepare ]]; then
  admission=$(python3 -B "$recipe/admit.py" "$variant")
else
  admission=$(sha256sum "$root/admissions/$variant.json" | cut -d ' ' -f 1)
fi
export P6_ADMISSION_SHA256=$admission
if [[ "$mode" == prepare ]]; then
python3 -B - "$recipe" "$variant" <<'PY'
import json,sys
from pathlib import Path
commands=json.loads((Path(sys.argv[1])/'packet/commands.json').read_text())
variant=sys.argv[2]
out=Path('variant-commands')/variant;out.mkdir(parents=True)
for phase in ['preflight','build','preserve','core','elf-floor','zero-js','node-vm','node-vm-native-workers','pty','plugin','docker-image','docker-gateway-network','docker-kitchen-sink','docker-cron']:
 (out/(phase+'.sh')).write_text(commands[variant+'-'+phase])
PY
  phases=(preflight)
elif [[ "$mode" == run ]]; then
  phases=(build preserve core elf-floor zero-js node-vm node-vm-native-workers pty plugin docker-image docker-gateway-network docker-kitchen-sink docker-cron)
else
  exit 2
fi
failed=0
for phase in "${phases[@]}"; do
  if python3 -B /p6-recipe/deadline_process.py --deadline-epoch "$P6_DEADLINE_EPOCH" \
    --reserve-seconds 1200 --cleanup-grace-seconds 30 --receipt "$P6_WORK/$variant-$phase-deadline.json" \
    -- env -i HOME=/home/runner PATH=/usr/bin:/bin P6_ADMISSION_SHA256="$admission" \
    bash "variant-commands/$variant/$phase.sh"; then
    continue
  else
    code=$?
    if (( code == 124 || code >= 128 )); then exit "$code"; fi
    failed=1
    case "$phase" in preflight|build|preserve) exit "$code";; esac
  fi
done
exit "$failed"
