#!/usr/bin/env bash
set -euo pipefail
[[ $# -eq 3 ]] || { echo 'Usage: run-native.sh ACTUAL_ARTIFACT APPROVED_DOCKER_IMAGE_RESULT_JSON FRESH_P6_OUTPUT' >&2; exit 2; }
here="$(cd "$(dirname "$0")" && pwd -P)"
root=/home/runner/.cache/oc-ty-ext/P6/app-x64-final-r3-v1
source="$(cd "$root/source" && pwd -P)"
node="$root/opt/node/bin/node"
artifact=$1
image_receipt=$2
output=$3
[[ $(uname -s) == Linux && $(uname -m) == x86_64 ]] || exit 1
image="$("$node" --input-type=module - "$here" "$source" "$artifact" "$image_receipt" "$output" <<'NODE'
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
const [here,source,artifactArg,receiptArg,outArg]=process.argv.slice(2);
const read=p=>JSON.parse(fs.readFileSync(p,'utf8'));
const hash=p=>createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const input=read(path.join(here,'inputs.json'));
const toolchain=read(input.controllerNodeReceipt);
assert.equal(toolchain.status,'PASS');
assert.equal(toolchain.buildNode.path,input.controllerNode);
assert.equal(hash(input.controllerNode),toolchain.buildNode.sha256);
assert.equal(hash(path.join(here,'cron-cli-fixture.sh')),input.fixtureSha256);
assert.equal(execFileSync('git',['-C',source,'rev-parse','HEAD'],{encoding:'utf8'}).trim(),input.sourceCommit);
assert.equal(execFileSync('git',['-C',source,'status','--porcelain','--untracked-files=no'],{encoding:'utf8'}).trim(),'','tracked helper source changed');
for(const [name,digest] of Object.entries(input.helpersSha256))assert.equal(hash(path.join(source,name)),digest,name);
const artifact=fs.realpathSync(artifactArg),out=path.resolve(outArg),p6=path.dirname(input.nativeRoot);
const manifest=read(path.join(artifact,'manifest.json'));
assert.deepEqual(manifest.target,{platform:'linux',arch:'x64'});
assert.equal(manifest.openclaw.commit,input.sourceCommit);
assert.equal(manifest.mode,'aot');
const receiptBytes=fs.readFileSync(receiptArg),receipt=JSON.parse(receiptBytes);
assert.equal(receipt.status,'PASS','successful owner docker-image result.json required');
assert.equal(receipt.sourceCommit,input.sourceCommit);
assert.equal(receipt.manifestSha256,hash(path.join(artifact,'manifest.json')));
assert.equal(receipt.binarySha256,hash(path.join(artifact,'openclaw')));
assert.equal(manifest.executable.sha256,receipt.binarySha256);
assert.match(receipt.imageId,/^sha256:[0-9a-f]{64}$/);
assert(out.startsWith(p6+path.sep)&&out!==artifact&&!out.startsWith(artifact+path.sep)&&out!==source&&!out.startsWith(source+path.sep));
assert(!fs.existsSync(out),'fresh output required');fs.mkdirSync(out,{recursive:true});
fs.writeFileSync(path.join(out,'image-receipt.json'),receiptBytes,{flag:'wx'});
fs.writeFileSync(path.join(out,'image-binding.json'),JSON.stringify({imageId:receipt.imageId,sourceCommit:receipt.sourceCommit,manifestSha256:receipt.manifestSha256,binarySha256:receipt.binarySha256,receiptSha256:createHash('sha256').update(receiptBytes).digest('hex')},null,2)+'\n',{flag:'wx'});
console.log(receipt.imageId);
NODE
)"
output="$(cd "$output" && pwd -P)"
mkdir "$output/tmp"
export TMPDIR="$output/tmp" PATH="$root/opt/node/bin:/usr/local/bin:/usr/bin:/bin"
finish() { code=$?;trap - EXIT;printf '{"exitCode":%s}\n' "$code" >"$output/exit.json";exit "$code"; }
trap finish EXIT
require_equal() { if [[ "$1" != "$2" ]]; then echo "Image identity mismatch: $3" >&2;exit 1;fi; }
require_equal "$(docker image inspect "$image" --format '{{.Id}}')" "$image" immutable-image-id
require_equal "$(docker image inspect "$image" --format '{{.Os}}')" linux operating-system
require_equal "$(docker image inspect "$image" --format '{{.Architecture}}')" amd64 architecture
docker image inspect "$image" >"$output/image.json"
sha256sum "$here/inputs.json" "$here/cron-cli-fixture.sh" "$artifact/manifest.json" "$artifact/openclaw" "$output/image-receipt.json" >"$output/input-sha256.txt"
export OPENCLAW_SKIP_DOCKER_BUILD=1 OPENCLAW_DOCKER_E2E_REQUIRE_LOCAL_IMAGE=1
export OPENCLAW_IMAGE="$image" OPENCLAW_DOCKER_E2E_IMAGE="$image"
export OPENCLAW_DOCKER_E2E_REPO_ROOT="$source" DOCKER_E2E_HARNESS_ROOT_DIR="$source"
export OPENCLAW_SELECTED_SHA=59baf4a051665750eb7055d0cec991d9876526df
export OPENCLAW_DOCKER_E2E_SELECTED_SHA="$OPENCLAW_SELECTED_SHA"
/bin/bash "$here/cron-cli-fixture.sh" >"$output/lane.log" 2>&1 || exit "$?"
