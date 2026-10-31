#!/usr/bin/env bash
# Run only in the isolated P6 native x64 build container.
set -euo pipefail
root=${1:?absolute staged CB root}
[[ $(uname -s) == Linux && $(uname -m) == x86_64 ]]
[[ "$root" == /*/.cache/oc-ty-ext/P6/* && -f "$root/source-ready.json" ]]
python3 - "$root" <<'PY'
import json,pathlib,sys
root=pathlib.Path(sys.argv[1]);data=json.loads((root/'source-ready.json').read_text())
assert data['bun']=='150c9620c53710060186b8b0cd50985e035408b0'
assert data['webkit']=='aaa690bfbf34c9d50775716ac2fc3c7d0573e0b8'
assert data['root']==str(root.resolve())
assert not (root/'receipts/bootstrap.json').exists()
PY
export P6_WORK="$root" P6_HOME="$root/home" TMPDIR="$root/tmp"
export CARGO_HOME="$P6_HOME/.cargo" RUSTUP_HOME="$P6_HOME/.rustup"
export XDG_CACHE_HOME="$P6_HOME/.cache" BUN_INSTALL_CACHE_DIR="$root/bun-install-cache"
export BUN_BUILD_CACHE_DIR="$root/build-cache"
export DEBIAN_FRONTEND=noninteractive
if (( EUID == 0 )); then elevate=(); else elevate=(sudo -n); fi
apt_options=(-o "Dir::Cache::archives=$root/apt-archives" -o "Dir::State::lists=$root/apt-lists")
"${elevate[@]}" apt-get "${apt_options[@]}" update
"${elevate[@]}" apt-get "${apt_options[@]}" install -y --no-install-recommends \
  ca-certificates curl wget git build-essential cmake ninja-build pkg-config \
  python3 ruby perl automake libtool unzip xz-utils libicu-dev libxml2-dev \
  libssl-dev zlib1g-dev libzstd-dev libncurses-dev libatomic1 golang ccache \
  skopeo jq nasm time file binutils
fetch() {
  local url=$1 destination=$2 expected=$3
  if [[ ! -f "$destination" ]]; then curl -fL --retry 2 --connect-timeout 30 -o "$destination" "$url"; fi
  printf '%s  %s\n' "$expected" "$destination" | sha256sum -c -
}
fetch https://github.com/oven-sh/bun/releases/download/bun-v1.4.4/bun-linux-x64-baseline.zip "$root/downloads/bun.zip" e0446eb55995772eb9894bebae9a6be368d985a8b9271ee124486f9946eedd76
unzip -o "$root/downloads/bun.zip" -d "$root/opt"
fetch https://github.com/llvm/llvm-project/releases/download/llvmorg-23.1.1/LLVM-23.1.1-Linux-X64.tar.xz "$root/downloads/llvm.tar.xz" 832aeb58d105de1cabc7b982dd2c65de0610f7377df48ae8fc2dd8e97420a15c
mkdir -p "$root/opt/llvm"
tar -xJf "$root/downloads/llvm.tar.xz" --strip-components=1 -C "$root/opt/llvm"
export LD_LIBRARY_PATH="$root/opt/llvm-runtime/usr/lib/x86_64-linux-gnu"
bash "$root/ensure-llvm-runtime.sh" "$root"
export PATH="$root/opt/llvm/bin:$root/opt/bun-linux-x64-baseline:$CARGO_HOME/bin:/usr/local/bin:/usr/bin:/bin"
curl -fL --retry 2 -o "$root/downloads/rustup-init" https://static.rust-lang.org/rustup/archive/1.28.2/x86_64-unknown-linux-gnu/rustup-init
curl -fL --retry 2 -o "$root/downloads/rustup-init.sha256" https://static.rust-lang.org/rustup/archive/1.28.2/x86_64-unknown-linux-gnu/rustup-init.sha256
(cd "$root/downloads" && sha256sum -c rustup-init.sha256)
chmod +x "$root/downloads/rustup-init"
"$root/downloads/rustup-init" -y --profile minimal --default-toolchain nightly-2026-09-15
export RUSTUP_TOOLCHAIN=nightly-2026-09-15
[[ $(bun --version) == 1.4.4 ]]
clang --version | tee "$root/receipts/clang-version.txt"
rustc --version | tee "$root/receipts/rust-version.txt"
bash "$root/setup-sysroot.sh"
fetch https://github.com/oven-sh/WebKit/releases/download/autobuild-preview-pr-757-63e317ba/bun-webkit-linux-amd64-lto-aot.tar.gz "$root/downloads/icu-prebuilt.tar.gz" b5f9e8554286eb31196ccd814b8ebd3ea47d042a89cc82d32413b56e6ffb2567
mkdir -p "$root/opt/icu-static"
tar -xzf "$root/downloads/icu-prebuilt.tar.gz" --strip-components=1 -C "$root/opt/icu-static" bun-webkit/include/unicode bun-webkit/lib/libicudata.a bun-webkit/lib/libicuuc.a bun-webkit/lib/libicui18n.a
grep -q '#define U_ICU_VERSION "78.3"' "$root/opt/icu-static/include/unicode/uvernum.h"
fetch https://github.com/unicode-org/icu/releases/download/release-78.3/icu4c-78.3-sources.tgz "$root/downloads/icu4c-78.3-sources.tgz" 3a2e7a47604ba702f345878308e6fefeca612ee895cf4a5f222e7955fabfe0c0
sha256sum "$root/opt/icu-static/lib/"*.a > "$root/receipts/icu-static.sha256"
dpkg-query -W -f='${Package}\t${Version}\n' > "$root/receipts/packages.tsv"
uname -a > "$root/receipts/kernel.txt"
python3 - "$root" <<'PY'
import datetime,json,pathlib,sys
root=pathlib.Path(sys.argv[1]);source=json.loads((root/'source-ready.json').read_text())
(root/'receipts/bootstrap.json').write_text(json.dumps({'status':'bootstrap-complete-not-built','source':source,'at':datetime.datetime.now(datetime.timezone.utc).isoformat()},indent=2)+'\n')
PY
