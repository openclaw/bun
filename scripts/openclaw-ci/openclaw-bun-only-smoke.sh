#!/bin/bash
set -Eeuo pipefail

source_dir="${1:?source checkout required}"
work="${2:?private work directory required}"
proof="${3:?text proof directory required}"
controller="${4:?controller SHA required}"
candidate=4ea5babab09c338812ae50dbcdaed990f48cd0fc
expected_bun=9debcc4b9db331d8ea8be404754baf1ffd0c7175
test "$(uname -s)/$(uname -m)" = Linux/x86_64
test "$(git -C "$source_dir" rev-parse HEAD)" = "$candidate"
test -z "$(git -C "$source_dir" status --porcelain)"
test "$(git rev-parse HEAD)" = "$controller"
test "${DOCKER_CONFIG:?}" = "$work/docker"
install -d -m 0700 "$proof" "$work/home" "$work/tmp" "$work/cache" "$work/config" "$work/data" "$work/smoke"
node_bin="$(dirname "$(command -v node)")"
clean_env=(env -i PATH="$node_bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
  HOME="$work/home" USERPROFILE="$work/home" TMPDIR="$work/tmp"
  XDG_CONFIG_HOME="$work/config" XDG_CACHE_HOME="$work/cache" XDG_DATA_HOME="$work/data"
  CI=1 LANG=C.UTF-8 NO_COLOR=1)
smoke_exit=not-run
phase=admission

finish() {
  local result=$?
  trap - EXIT
  # Preserve native state for runner teardown; publish only bounded text evidence.
  "${clean_env[@]}" node - "$source_dir" "$work" "$proof" "$candidate" "$controller" "$result" "$smoke_exit" "$phase" <<'JS' || result=1
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const [source, work, proof, candidate, controller, exitCode, smokeExitCode, phase] = process.argv.slice(2);
const redact = text => text.replaceAll(source, '<candidate-source>').replaceAll(work, '<private-fixture>');
const digest = file => {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  const buffer = Buffer.alloc(1024 * 1024);
  try {
    for (let size; (size = fs.readSync(fd, buffer)) > 0;) hash.update(buffer.subarray(0, size));
  } finally { fs.closeSync(fd); }
  return hash.digest('hex');
};
const receipt = {candidate, controller, exitCode: Number(exitCode), smokeExitCode, phase, stateDisposition: 'retained-for-runner-teardown'};
for (const [key, file] of Object.entries({sourceArchive: `${work}/candidate.tar.gz`, package: `${work}/package/candidate.tgz`, bun: `${work}/runtime/bin/bun`})) {
  if (fs.existsSync(file)) receipt[key] = {sha256: digest(file), bytes: fs.statSync(file).size};
}
const smoke = `${work}/smoke`;
for (const name of fs.readdirSync(smoke)) {
  if (name === 'report.json' || name === 'report.md' || name.endsWith('.log')) {
    const file = path.join(smoke, name);
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > 8 * 1024 * 1024) throw Error(`invalid text evidence: ${name}`);
    fs.writeFileSync(path.join(proof, name), redact(fs.readFileSync(file, 'utf8')));
  }
}
for (const name of fs.readdirSync(proof).filter(name => name.endsWith('.log'))) {
  const file = path.join(proof, name);
  if (fs.statSync(file).size > 8 * 1024 * 1024) throw Error(`text log exceeds budget: ${name}`);
  fs.writeFileSync(file, redact(fs.readFileSync(file, 'utf8')));
}
fs.writeFileSync(`${proof}/receipt.json`, JSON.stringify(receipt, null, 2) + '\n');
JS
  exit "$result"
}
trap finish EXIT

"${clean_env[@]}" node - "$source_dir/scripts/lib/openclaw-bun.json" "$expected_bun" <<'JS'
const assert = require('node:assert/strict');
const pin = require(process.argv[2]);
assert.equal(pin.commit, process.argv[3]);
assert.equal(pin.tag, 'openclaw-v1.4.4-20261115-9debcc4b9d-webkit-3357f9d63e');
assert.equal(pin.revision, '1.4.4-canary.1+9debcc4b9');
assert.equal(process.versions.node, '24.22.1');
JS
test -x /usr/bin/google-chrome
"${clean_env[@]}" /bin/bash -c 'command -v unshare setpriv sudo >/dev/null; sudo -n true'

phase=stage-bun
"${clean_env[@]}" OPENCLAW_BUN_CACHE_ROOT="$work/cache/bun" \
  /bin/bash "$source_dir/scripts/stage-openclaw-bun.sh" "$work/runtime" linux x64 \
  2>&1 | tee "$proof/stage-bun.log"

phase=source-archive
"${clean_env[@]}" curl --fail --location --silent --show-error \
  --proto '=https' --proto-redir '=https' --connect-timeout 15 --max-time 300 --retry 3 \
  --output "$work/candidate.tar.gz" "https://codeload.github.com/openclaw/openclaw/tar.gz/$candidate"
test -s "$work/candidate.tar.gz"

phase=packager-image
"${clean_env[@]}" DOCKER_CONFIG="$work/docker" timeout --kill-after=30s 20m \
  docker buildx build --progress=plain --load -t openclaw-bun-only-packager:local \
  -f "$source_dir/scripts/docker/install-sh-smoke/Dockerfile" "$source_dir/scripts/docker" \
  2>&1 | tee "$proof/packager-image.log"

phase=package
install -d -m 0777 "$work/package"
"${clean_env[@]}" DOCKER_CONFIG="$work/docker" timeout --kill-after=30s 50m \
  docker run --rm --cap-drop ALL --security-opt no-new-privileges --pids-limit 1024 \
  --user node --entrypoint /usr/bin/env \
  -v "$work/candidate.tar.gz:/input/candidate.tar.gz:ro" \
  -v "$work/package:/output" -v "$source_dir:/harness:ro" \
  openclaw-bun-only-packager:local \
  -i HOME=/home/node TMPDIR=/tmp LANG=C.UTF-8 CI=1 \
  PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/bin /bin/bash -c '
    set -euo pipefail
    source_dir="$(mktemp -d)"
    tar -xzf /input/candidate.tar.gz --strip-components=1 --no-same-owner --no-same-permissions -C "$source_dir"
    cd "$source_dir"
    node /harness/scripts/package-source-preflight.mjs --source-dir "$source_dir" --allow-unreleased-changelog
    mkdir -p /tmp/corepack
    corepack enable --install-directory /tmp/corepack
    export PATH="/tmp/corepack:$PATH"
    pnpm install --frozen-lockfile
    node scripts/package-openclaw-for-docker.mjs --source-dir "$source_dir" --output-dir /output \
      --output-name candidate.tgz --allow-unreleased-changelog
  ' 2>&1 | tee "$proof/package.log"
test -s "$work/package/candidate.tgz"

phase=bun-only-smoke
smoke_exit=0
"${clean_env[@]}" BUN_BIN="$work/runtime/bin/bun" \
  OPENCLAW_BUN_ONLY_SMOKE_PACKAGE_TGZ="$work/package/candidate.tgz" \
  OPENCLAW_BUN_ONLY_SMOKE_ARTIFACT_DIR="$work/smoke" OPENCLAW_BUN_ONLY_SMOKE_HIDE_SYSTEM_NODE=1 \
  /bin/bash "$source_dir/scripts/e2e/bun-only-runtime-smoke.sh" \
  2>&1 | tee "$proof/smoke.log" || smoke_exit=$?

phase=validate-smoke
"${clean_env[@]}" node - "$work/smoke/report.json" "$smoke_exit" <<'JS'
const assert = require('node:assert/strict');
const report = require(process.argv[2]);
assert.equal(Number(process.argv[3]), 0, 'canonical smoke process failed');
assert.equal(report.ok, true, 'canonical native blocker classifier rejected smoke');
assert.equal(report.bunRevision, '1.4.4-canary.1+9debcc4b9');
assert.deepEqual(report.steps.map(step => step.name), [
  'preconditions', 'install', 'cli', 'gateway', 'node-host', 'agent', 'doctor', 'terminals', 'browser', 'cleanup',
]);
assert.ok(report.steps.every(step => step.status === 'passed'), 'all ten canonical stages must pass');
JS
test -z "$(git -C "$source_dir" status --porcelain --untracked-files=no)"
phase=complete
