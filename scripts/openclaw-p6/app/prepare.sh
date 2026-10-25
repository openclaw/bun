#!/usr/bin/env bash
set -euo pipefail
root=/home/runner/.cache/oc-ty-ext/P6/app-x64-final-r2-v1
recipe=/p6-recipe/app
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends python3 ca-certificates git curl xz-utils build-essential pkg-config cmake ninja-build libicu-dev libssl-dev zlib1g-dev libatomic1 strace file jq sudo time
[[ ! -e /usr/bin/node && ! -e /usr/bin/nodejs && ! -e /usr/bin/js ]]
cd "$P6_WORK"
python3 -B - "$recipe" <<'PY'
import hashlib,json,sys,subprocess
from pathlib import Path
packet=Path(sys.argv[1])/'packet'
inputs=Path('p6-qualification-inputs/app-x64-final-r2-v1');inputs.mkdir(parents=True)
projection=json.loads((packet/'input-projection.json').read_text())
assert hashlib.sha256((packet/'payload/manifest.json').read_bytes()).hexdigest()==projection['manifestSha256']
subprocess.run([sys.executable,'-B',str(packet/'payload/stage.py')],check=True,env={'HOME':'/home/runner','PATH':'/usr/bin:/bin'})
commands=json.loads((packet/'commands.json').read_text())
for name in ['adopt-compilers','clone','toolchain','install','runtime','boundary','plugins']:
 (inputs/(name+'.sh')).write_text(commands[name])
PY
for phase in adopt-compilers clone toolchain install runtime boundary plugins; do
  python3 -B /p6-recipe/deadline_process.py --deadline-epoch "$P6_DEADLINE_EPOCH" \
    --reserve-seconds 1200 --cleanup-grace-seconds 30 --receipt "$P6_WORK/$phase-deadline.json" \
    -- env -i HOME=/home/runner PATH=/usr/bin:/bin bash "p6-qualification-inputs/app-x64-final-r2-v1/$phase.sh"
done
test -f "$root/prep-receipts/plugins/result.json"
