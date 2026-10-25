#!/usr/bin/env bash
set -euo pipefail
root=${1:?absolute P6 build root}
export LD_LIBRARY_PATH="$root/opt/llvm-runtime/usr/lib/x86_64-linux-gnu"
# Native Linux compile, archive, strip and binary-check tools selected by build/tools.ts.
tools=(clang clang++ ld.lld llvm-ar llvm-strip llvm-nm llvm-readobj llvm-objdump llvm-cxxfilt)
needs_icu=false
for tool in "${tools[@]}"; do
  receipt="$root/receipts/$tool-ldd-before.txt"
  timeout --signal=TERM --kill-after=5s 30s ldd "$root/opt/llvm/bin/$tool" > "$receipt"
  if grep -Eq 'libicu[^[:space:]]*\.so\.70[[:space:]]+=>[[:space:]]+not found' "$receipt"; then
    needs_icu=true
  fi
done
if [[ "$needs_icu" == true ]]; then
  curl -fL --retry 2 -o "$root/downloads/libicu70.deb" https://archive.ubuntu.com/ubuntu/pool/main/i/icu/libicu70_70.1-2_amd64.deb
  curl -fL --retry 2 -o "$root/downloads/Packages.xz" https://archive.ubuntu.com/ubuntu/dists/jammy/main/binary-amd64/Packages.xz
  python3 - "$root/downloads" <<'PY'
import hashlib,lzma,pathlib,sys
root=pathlib.Path(sys.argv[1]);text=lzma.decompress((root/'Packages.xz').read_bytes()).decode()
blocks=[b for b in text.split('\n\n') if b.startswith('Package: libicu70\n')]
assert len(blocks)==1
fields=dict(line.split(': ',1) for line in blocks[0].splitlines() if ': ' in line and not line.startswith(' '))
assert fields['Version']=='70.1-2' and fields['Architecture']=='amd64'
assert hashlib.sha256((root/'libicu70.deb').read_bytes()).hexdigest()==fields['SHA256']
PY
  dpkg-deb -x "$root/downloads/libicu70.deb" "$root/opt/llvm-runtime"
fi
for tool in "${tools[@]}"; do
  receipt="$root/receipts/$tool-ldd-after.txt"
  timeout --signal=TERM --kill-after=5s 30s ldd "$root/opt/llvm/bin/$tool" > "$receipt"
  if grep -q 'not found' "$receipt"; then
    cat "$receipt" >&2
    exit 1
  fi
  timeout --signal=TERM --kill-after=5s 30s "$root/opt/llvm/bin/$tool" --version > "$root/receipts/$tool-version.txt"
done
