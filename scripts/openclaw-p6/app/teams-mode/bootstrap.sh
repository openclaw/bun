#!/usr/bin/env bash
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends python3 ca-certificates git curl xz-utils binutils file time libatomic1 strace
[[ ! -e /usr/bin/node && ! -e /usr/bin/nodejs && ! -e /usr/bin/js ]]
python3 -B /p6-recipe/app/packet/payload/stage.py
root=/home/runner/.cache/oc-ty-ext/P6/app-x64-final-r4-v1
python3 -B "$root/native-prep.py" --root "$root" --phase clone
python3 -B /p6-recipe/app/teams-mode/node-only.py
