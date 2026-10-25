#!/usr/bin/env bash
set -euo pipefail
umask 077
root=/home/runner/.cache/oc-ty-ext/P6/app-x64-final-r4-v1
here=$(cd "$(dirname "$0")" && pwd -P)
[[ "$here" == "$root/benchmark-prep" && $(uname -s) == Linux && $(uname -m) == x86_64 ]]
[[ ! -e "$here/package-source" && ! -e "$here/package" ]]
export HOME="$here/package-home" TMPDIR="$here/package-tmp" XDG_CACHE_HOME="$here/package-cache"
export PATH="$root/opt/node/bin:$root/opt/bin:/usr/bin:/bin" LANG=C.UTF-8 TZ=UTC
export NPM_CONFIG_USERCONFIG=/dev/null NPM_CONFIG_GLOBALCONFIG=/dev/null NPM_CONFIG_CACHE="$here/package-cache/npm"
mkdir -p "$HOME" "$TMPDIR" "$XDG_CACHE_HOME"
python3 - "$root" "$here" <<'PY'
import hashlib,json,subprocess,sys
from pathlib import Path
root,here=map(Path,sys.argv[1:]);source=root/'source';contract=json.loads((here/'source-contract.json').read_text())
assert subprocess.check_output(['git','-C',str(source),'rev-parse','HEAD'],text=True).strip()==contract['sourceCommit']
assert not subprocess.check_output(['git','-C',str(source),'status','--porcelain','--untracked-files=no'],text=True).strip()
for name,digest in contract['files'].items(): assert hashlib.sha256((source/name).read_bytes()).hexdigest()==digest,name
for phase in ['clone','toolchain','install','runtime','boundary','plugins']:
 assert json.loads((root/f'prep-receipts/{phase}/result.json').read_text())['status']=='PASS',phase
assert json.loads((source/'dist/build-info.json').read_text())['commit']==contract['sourceCommit']
PY
cp --reflink=auto -a "$root/source" "$here/package-source"
python3 - "$here/package-source" <<'PY'
import os,sys
from pathlib import Path
root=Path(sys.argv[1]).resolve()
for directory,dirs,files in os.walk(root,followlinks=False):
 for name in dirs+files:
  p=Path(directory)/name
  if p.is_symlink():
   target=p.resolve(strict=True)
   assert target==root or root in target.parents, f'Private package clone has external link: {p}'
PY
mkdir "$here/package"
cd "$here/package-source"
"$root/opt/node/bin/node" --input-type=module - "$root/admission-inputs/plugins/desktop.json" "$here/package/bundles.json" <<'JS'
import fs from 'node:fs';
import {collectRootPackageExcludedExtensionDirs} from './scripts/lib/root-package-bundled-plugin-excludes.mjs';
const selected=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
const excluded=collectRootPackageExcludedExtensionDirs();
fs.writeFileSync(process.argv[3],JSON.stringify(selected.filter(id=>excluded.has(id)))+'\n',{flag:'wx'});
JS
mapfile -t bundles < <(python3 - "$here/package/bundles.json" <<'PY'
import json,sys
for value in json.load(open(sys.argv[1])): print(value)
PY
)
args=()
for bundle in "${bundles[@]}"; do args+=(--bundle-plugin "$bundle"); done
/usr/bin/nice -n 10 "$root/opt/node/bin/node" --import ./scripts/tsx.mjs scripts/package-openclaw-for-docker.mts \
 --skip-build --allow-unreleased-changelog --source-dir "$here/package-source" \
 --output-dir "$here/package" --output-name openclaw.tgz --pack-json "$here/package/pack.json" \
 "${args[@]}" > "$here/package/producer.stdout" 2> "$here/package/producer.stderr"
python3 - "$root" "$here" <<'PY'
import hashlib,json,sys,tarfile
from pathlib import Path
root,here=map(Path,sys.argv[1:]);p=here/'package/openclaw.tgz'
with tarfile.open(p) as t: build=json.load(t.extractfile('package/dist/build-info.json'))
assert build['commit']=='4fa442e332745f1f58ccedd27106abdafcf4e019'
receipt={'status':'package-owner-passed','sourceCommit':build['commit'],'tarball':str(p),'sha256':hashlib.sha256(p.read_bytes()).hexdigest(),'bytes':p.stat().st_size,'buildInfo':build,'bundles':json.loads((here/'package/bundles.json').read_text()),'performanceEligible':False}
(here/'package/producer-receipt.json').write_text(json.dumps(receipt,indent=2)+'\n')
PY
