#!/bin/bash
# P6 amd64 adaptation of scripts/build/ci-images/spec.ts::glibcSysroot().
# Uses the x64 hashes and library layout from the same pinned build spec.
set -euo pipefail
: "${P6_WORK:?Set P6_WORK}"
if [[ $(uname -s) != Linux || $(uname -m) != x86_64 ]]; then
  echo "Run this on the native P6 x64 Linux Testbox." >&2
  exit 1
fi
for tool in skopeo jq curl sha256sum dpkg-deb tar python3; do
  if ! command -v "$tool" >/dev/null; then
    echo "Missing $tool. Install prerequisites in the task-owned container: apt-get -o Dir::Cache::archives=${P6_WORK}/apt-archives install -y --no-install-recommends skopeo jq" >&2
    exit 1
  fi
done
spec=${P6_WORK}/bun/scripts/build/ci-images/spec.ts
printf '%s  %s\n' c628259fe7f37826a91feee3c2b144b3ee7ccedf461c566723bf458f51171466 "$spec" | sha256sum -c -
inputs=${P6_WORK}/sysroot-inputs
sysroot=${P6_WORK}/opt/linux-sysroot-glibc-amd64
image="$inputs/image-amd64"
gcc_dir="$inputs/gcc-amd64"
mkdir -p "$inputs" "${P6_WORK}/opt" "${P6_WORK}/tmp"
if [[ -e "$sysroot" || -L "$sysroot" ]]; then
  echo "Refusing to overwrite existing sysroot: $sysroot" >&2
  exit 1
fi
mkdir "$sysroot"
export TMPDIR=${P6_WORK}/tmp
printf '%s\n' '{"auths":{}}' > "$inputs/empty-registry-auth.json"
skopeo copy --authfile "$inputs/empty-registry-auth.json" --override-arch amd64   docker://docker.io/library/ubuntu@sha256:8feb4d8ca5354def3d8fce243717141ce31e2c428701f6682bd2fafe15388214   "dir:$image"
while IFS= read -r layer; do
  digest=${layer#sha256:}
  printf '%s  %s\n' "$digest" "$image/$digest" | sha256sum -c -
  # Bun's bake tolerates tar failures because device nodes are not required.
  # Retain each diagnostic log, then verify the libc/headers needed below.
  if ! tar -xzf "$image/$digest" -C "$sysroot" 2>"$inputs/layer-$digest.stderr"; then
    echo "Layer extraction reported errors; inspect $inputs/layer-$digest.stderr (upstream tolerates missing device nodes)." >&2
  fi
done < <(jq -r '.layers[].digest' "$image/manifest.json")
fetch() {
  local url=$1 file=$2 digest=$3
  curl -fL --retry 2 --connect-timeout 30 -o "$file" "$url"
  printf '%s  %s\n' "$digest" "$file" | sha256sum -c -
}
# Exact Ubuntu focal pins and publisher hashes from Bun's image specification.
while IFS='|' read -r directory package version digest; do
  file="$inputs/${package}_${version}_amd64.deb"
  fetch "https://archive.ubuntu.com/ubuntu/pool/main/$directory/${package}_${version}_amd64.deb" "$file" "$digest"
  dpkg-deb -x "$file" "$sysroot"
done <<'DEBS'
g/glibc|libc6|2.31-0ubuntu9.18|1b2281aac4935dfea1f89dfc19e445fdbb45303202af60679ccb8bf035f081a0
g/glibc|libc6-dev|2.31-0ubuntu9.18|11029900f2315b93ce487792ae1bf15f0927e5e50880c091e6a440b14d4e164a
l/linux|linux-libc-dev|5.4.0-216.236|70c9addd36aabd2d031d5ea0fc444f8b193027aef79ff3d8275d25800aed8ede
libx/libxcrypt|libcrypt1|4.4.10-10ubuntu4|231b4dbbe5865775f118cfa61394f1e16fa7102b6953a327e672499a20876d73
libx/libxcrypt|libcrypt-dev|4.4.10-10ubuntu4|f0a41d8e8cf379dbbdfc43169f34851ed452b3581e72c6654f2e290caf4e1b20
DEBS
# Keep absolute image symlinks inside the sysroot, exactly as the bake does.
python3 - "$sysroot" <<'LINKS'
import os,sys
root=sys.argv[1]
for directory, dirs, files in os.walk(root, followlinks=False):
    for name in dirs+files:
        path=os.path.join(directory,name)
        if os.path.islink(path):
            target=os.readlink(path)
            if target.startswith('/'):
                os.unlink(path)
                os.symlink(root+target,path)
LINKS
if [[ ! -e "$sysroot/lib/x86_64-linux-gnu/libc.so.6" ]]; then
  mkdir -p "$sysroot/lib"
  ln -s ../usr/lib/x86_64-linux-gnu "$sysroot/lib/x86_64-linux-gnu"
fi
fetch https://github.com/oven-sh/WebKit/releases/download/gcc-13-focal-debs/gcc-13-focal-amd64.tar.gz   "$inputs/gcc-amd64.tar.gz" a2b3b6e10b175bbaaefeb3e9e703ca26a97ed6c1f19ca842d3e0b0c8f941e65b
mkdir -p "$gcc_dir"
tar -xzf "$inputs/gcc-amd64.tar.gz" -C "$gcc_dir"
shopt -s nullglob
gcc_debs=("$gcc_dir"/*.deb)
if ((${#gcc_debs[@]} == 0)); then
  echo "No gcc-13 debs in the verified upstream archive." >&2
  exit 1
fi
for deb in "${gcc_debs[@]}"; do
  dpkg-deb -x "$deb" "$sysroot"
done
if [[ ! -e "$sysroot/lib64" ]]; then ln -s usr/lib/x86_64-linux-gnu "$sysroot/lib64"; fi
[[ -e "$sysroot/lib/x86_64-linux-gnu/libc.so.6" ]]
[[ -e "$sysroot/usr/include/stdio.h" ]]
[[ -d "$sysroot/usr/include/c++/13" ]]
python3 - "$inputs" "$sysroot" "$spec" <<'RECEIPT'
import datetime,hashlib,json,pathlib,sys
inputs,root,spec=map(pathlib.Path,sys.argv[1:])
files=[p for p in inputs.iterdir() if p.suffix=='.deb']+[inputs/'gcc-amd64.tar.gz']
receipt={'status':'prepared','arch':'x86_64','glibc':'2.31','gcc_headers':'13','sysroot':str(root),'source':str(spec),'source_sha256':hashlib.sha256(spec.read_bytes()).hexdigest(),'ubuntu_image':'sha256:8feb4d8ca5354def3d8fce243717141ce31e2c428701f6682bd2fafe15388214','files':{p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in files},'created_utc':datetime.datetime.now(datetime.timezone.utc).isoformat()}
(root/'P6-sysroot-receipt.json').write_text(json.dumps(receipt,indent=2)+'\n')
print(json.dumps(receipt,indent=2))
RECEIPT
printf '\nUse for the compiler build:\nexport LINUX_GLIBC_SYSROOT=%q\n' "$sysroot"
