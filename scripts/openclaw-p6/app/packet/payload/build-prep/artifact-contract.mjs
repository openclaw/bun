// Linux packaging verification only; the runtime tree hash stays with its source owner.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [planFile] = process.argv.slice(2);
assert(planFile, 'Usage: bun artifact-contract.mjs plan.json');
const plan = JSON.parse(fs.readFileSync(planFile, 'utf8'));
const manifestPath = path.join(plan.output, 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const owner = path.join(plan.source, 'scripts/lib/bun-standalone-contract.mjs');
const { describeStandaloneRuntime, sha256File } = await import(pathToFileURL(owner).href);
assert.equal(manifest.schemaVersion, 1);
assert.deepEqual(manifest.target, { platform: 'linux', arch: plan.arch });
assert.equal(manifest.openclaw.commit, plan.sourceProof.commit);
assert.equal(manifest.openclaw.version, plan.sourceProof.version);
assert.equal(manifest.mode, plan.variant === 'jit' ? 'jit' : 'aot');
assert.equal('sourceBuild' in manifest, plan.variant === 'ts');
assert.equal(manifest.bun.executableSha256, plan.compiler.sha256);
assert.equal(manifest.bun.commit, plan.compiler.bunCommit);
assert.deepEqual(manifest.plugins.embedded, plan.plugins);
assert.equal(manifest.build.flavor, 'standard');
for (const name of ['id', 'moduleGraphSha256', 'pluginSetSha256']) {
  assert.match(manifest.build[name], /^[a-f0-9]{64}$/);
}
assert.equal(manifest.build.pluginSetSha256,
  createHash('sha256').update(JSON.stringify(plan.plugins)).digest('hex'));
assert.equal(manifest.executable.path, 'openclaw');
assert.equal(manifest.runtime.path, 'runtime');
const executable = path.join(plan.output, 'openclaw');
assert.equal(fs.statSync(executable).size, manifest.executable.sizeBytes);
assert.equal(await sha256File(executable), manifest.executable.sha256);
const runtime = await describeStandaloneRuntime(path.join(plan.output, 'runtime'));
for (const name of ['sha256', 'sizeBytes', 'fileCount', 'symlinkCount']) {
  assert.equal(runtime[name], manifest.runtime[name], `Runtime ${name} differs`);
}
assert.equal(Object.values(manifest.runtime.categories).reduce((sum, item) => sum + item.bytes, 0), runtime.sizeBytes);
assert.equal(manifest.runtime.sqlite.source, 'bun');
assert.equal(manifest.runtime.sqlite.extensionLoadingSupported, true);
assert.equal('macos' in manifest, false);
console.log(JSON.stringify({ applicationQualified: false, platform: 'linux', arch: plan.arch,
  sourceCommit: manifest.openclaw.commit, version: manifest.openclaw.version,
  mode: manifest.mode, build: manifest.build, compilerSha256: manifest.bun.executableSha256,
  compilerCohort: plan.compiler.cohort, engineProfile: plan.compiler.profile,
  admittedEngineFeatures: plan.compiler.engineFeatures, policyLabel: plan.policyLabel,
  compileTrimAllow: plan.compileTrimAllow, p0ReferenceCohort: plan.p0ReferenceCohort,
  c2ApplicationHardening: plan.c2ApplicationHardening,
  historicalC2Equivalent: plan.historicalC2Equivalent,
  executable: manifest.executable, runtime, sqlite: manifest.runtime.sqlite,
  manifestSha256: await sha256File(manifestPath), contractOwnerSha256: await sha256File(owner) }));
