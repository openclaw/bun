import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve('consumer');
const release = path.resolve('release');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const manifestBytes = fs.readFileSync(path.join(release, 'manifest.json'));
assert.equal(digest(manifestBytes), process.env.MANIFEST_SHA256);
const manifest = JSON.parse(manifestBytes);
assert.equal(manifest.bun.commit, process.env.BUN_COMMIT);
assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), process.env.CONSUMER_COMMIT);
assert.equal(process.platform, 'win32');
assert.equal(process.arch, process.env.EXPECTED_ARCH);
const target = `windows-${process.arch}`;
const asset = manifest.assets.find(asset => asset.target === target && !asset.name.includes('profile'));
assert(asset);
assert.equal(asset.executable.authenticodeSigned, false);
assert.equal(asset.executable.testOnly, true);
assert.equal(digest(fs.readFileSync(path.join(release, asset.name))), asset.sha256);
const pinPath = path.join(root, 'scripts/lib/openclaw-bun.json');
const pin = JSON.parse(fs.readFileSync(pinPath));
const prior = structuredClone(pin);
pin.artifacts[target] = {
  tag: manifest.tag, commit: manifest.bun.commit,
  ...(manifest.bun.revision ? { revision: manifest.bun.revision } : {}),
  asset: asset.name, sha256: asset.sha256,
  executable: asset.executable.path, executableSha256: asset.executable.sha256,
  authenticodeSigned: false,
};
fs.writeFileSync(pinPath, JSON.stringify(pin, null, 2) + '\n');
for (const [name, artifact] of Object.entries(prior.artifacts)) {
  if (name !== target) assert.deepEqual(pin.artifacts[name], artifact);
}
execFileSync(process.execPath, ['apps/linux/scripts/stage-runtime.mjs', '--unsigned-windows-artifact', release], { cwd: root, stdio: 'inherit' });
const staged = path.join(root, 'apps/linux/src-tauri/target/desktop-runtime');
const stagedManifest = JSON.parse(fs.readFileSync(path.join(staged, 'manifest.json')));
assert.equal(stagedManifest.arch, process.arch);
assert.equal(stagedManifest.commit, manifest.bun.commit);
assert.equal(stagedManifest.testOnly, true);
assert.equal(stagedManifest.authenticodeSigned, false);
const bytes = fs.readFileSync(path.join(staged, 'bin/bun.exe'));
const marker = Buffer.from('OPENCLAW-BUN-RUNTIME-V1\n');
assert(bytes.subarray(0, marker.length).equals(marker));
const executable = bytes.subarray(marker.length);
assert.equal(digest(executable), asset.executable.sha256);
assert.equal(executable.subarray(0, 2).toString(), 'MZ');
const peOffset = executable.readUInt32LE(0x3c);
assert.equal(executable.readUInt32LE(peOffset), 0x4550);
assert.equal(executable.readUInt16LE(peOffset + 4), process.arch === 'arm64' ? 0xaa64 : 0x8664);
fs.mkdirSync('proof', { recursive: true });
fs.writeFileSync('proof/staging.json', JSON.stringify({
  consumerCommit: process.env.CONSUMER_COMMIT, bunCommit: manifest.bun.commit,
  manifestSha256: digest(manifestBytes), archiveSha256: asset.sha256,
  executableSha256: asset.executable.sha256, target, stagedManifest,
  unrelatedPinsPreserved: true, nativePeArchitectureVerified: true,
}, null, 2) + '\n');
const runtimeSource = path.join(root, 'apps/linux/src-tauri/src/bundled_runtime.rs');
fs.writeFileSync('proof/unchanged-runtime.sha256', digest(fs.readFileSync(runtimeSource)) + '\n');
fs.appendFileSync(runtimeSource, fs.readFileSync('pipeline/scripts/consumer-replay/native-test.rs'));
