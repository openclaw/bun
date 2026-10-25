#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { inspectPackageExtensions } from './package-inventory.mjs';

const CUT = '59baf4a051665750eb7055d0cec991d9876526df';
const ROOT = '/home/runner/.cache/oc-ty-ext/P6/app-x64-final-r3-v1';
const here = path.dirname(fileURLToPath(import.meta.url));
const read = filename => JSON.parse(fs.readFileSync(filename, 'utf8'));
const write = (filename, value) => fs.writeFileSync(filename, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
const hash = async filename => {
  const digest = createHash('sha256');
  for await (const bytes of fs.createReadStream(filename)) digest.update(bytes);
  return digest.digest('hex');
};
const inputs = read(path.join(here, 'native-inputs.json'));
const inputsSha256 = await hash(path.join(here, 'native-inputs.json'));
assert.equal(inputs.decision, 'benchmark-linux', 'Template is not admitted; bind actual native facts first');
assert.equal(inputs.schemaVersion, 1);
assert.equal(inputs.sourceCommit, CUT);
assert.equal(inputs.nativeRoot, ROOT);
assert.equal(inputs.nativeSource, ROOT + '/source');
assert.equal(process.platform, 'linux');
assert.equal(process.arch, 'x64');
assert.equal(process.umask(), 0o077, 'Set umask 077 before creating any test state');
assert.equal(fs.realpathSync(here), ROOT + '/benchmark-prep');
const root = ROOT, source = ROOT + '/source', work = here + '/work';
const installed = work + '/installed/node_modules/openclaw';
const entry = installed + '/openclaw.mjs';
const [action] = process.argv.slice(2);
assert(['plan', 'installed', 'cohort', 'verify', 'baseline'].includes(action));
for (const [name, digest] of Object.entries(read(here + '/payload-manifest.json'))) {
  assert.match(digest, /^[a-f0-9]{64}$/);
  assert.equal(await hash(path.join(here, name)), digest, name);
}
const git = (...args) => execFileSync('git', ['-C', source, ...args], { encoding: 'utf8' }).trim();
assert.equal(git('rev-parse', 'HEAD'), CUT);
assert.equal(git('status', '--porcelain', '--untracked-files=no'), '', 'Tracked source changed');
const sourceContract = read(here + '/source-contract.json');
assert.equal(sourceContract.sourceCommit, CUT);
for (const [name, digest] of Object.entries(sourceContract.files)) assert.equal(await hash(source + '/' + name), digest, name);
const npm = inputs.npm;
assert.equal(npm.path, root + '/opt/node/lib/node_modules/npm/bin/npm-cli.js');
assert.equal(npm.version, '11.20.0');
assert.equal(await hash(npm.path), npm.sha256);
assert.equal(await hash(root + '/opt/node/lib/node_modules/npm/package.json'), npm.manifestSha256);
assert.equal(read(root + '/opt/node/lib/node_modules/npm/package.json').version, npm.version);
const policy = read(here + '/project-package.manifest.json');
const policyText = fs.readFileSync(source + '/pnpm-workspace.yaml', 'utf8').split('\nallowBuilds:\n')[1].split('\n\n')[0];
const allowed = Object.fromEntries(policyText.trimEnd().split('\n').map(line => {
  const match = line.match(/^  (?:"([^"]+)"|([^:]+)): (true|false)$/);
  assert(match, 'Unexpected source allowBuilds entry: ' + line);
  return [match[1] ?? match[2], match[3] === 'true'];
}));
assert.equal(allowed.openclaw, true);
assert.deepEqual(policy.allowScripts, { ...allowed, ['file:' + inputs.tarball.path]: true });
const installCommand = [nodePath(), npm.path, 'install', '--prefix', work + '/installed', inputs.tarball.path,
  '--strict-allow-scripts', '--no-audit', '--no-fund', '--foreground-scripts', '--fetch-retries=0'];
function nodePath() { return root + '/opt/node/bin/node'; }

async function receipt(ref, exactPath) {
  assert(ref && typeof ref.path === 'string' && path.isAbsolute(ref.path));
  assert(ref.path.startsWith(root + '/'), 'Receipt must remain inside the isolated native root');
  if (exactPath) assert.equal(ref.path, exactPath);
  assert.match(ref.sha256, /^[a-f0-9]{64}$/);
  assert.equal(await hash(ref.path), ref.sha256, ref.path);
  return read(ref.path);
}
const toolchain = await receipt(inputs.receipts.toolchain, root + '/prep-receipts/toolchain/result.json');
const plugins = await receipt(inputs.receipts.plugins, root + '/prep-receipts/plugins/result.json');
const compilers = await receipt(inputs.receipts.compilerRecords, root + '/admission-inputs/compiler-records.json');
assert.equal(toolchain.status, 'PASS');
assert.equal(plugins.status, 'PASS');
assert.equal(plugins.sourceCommit, CUT);
const node = toolchain.buildNode, bun = compilers['cb-standard'];
assert.equal(node.path, root + '/opt/node/bin/node');
assert.deepEqual(inputs.node, node, 'Node must be copied from actual native toolchain receipt');
assert.equal(await hash(node.path), node.sha256);
assert.equal(node.version, '26.12.1');
assert.equal(bun.path, root + '/compilers/standard/bun');
assert.equal(bun.cohort, 'rd-p6-150c');
assert.equal(bun.bunCommit, '150c9620c53710060186b8b0cd50985e035408b0');
assert.equal(bun.webkitCommit, 'aaa690bfbf34c9d50775716ac2fc3c7d0573e0b8');
assert.deepEqual(bun.engineFeatures, { shadowRealm: true, hardened: false });
assert.equal(await hash(bun.path), bun.sha256);
for (const [file, digest] of [['build.json', bun.buildReceiptSha256], ['transport.json', bun.preservationReceiptSha256]]) {
  assert.equal(await hash(path.join(path.dirname(bun.path), file)), digest);
}
const selected = read(root + '/admission-inputs/plugins/desktop.json');
assert(Array.isArray(selected) && selected.length && new Set(selected).size === selected.length);
assert.equal(await hash(source + '/dist/build-info.json'), plugins.distBuildInfoSha256);
assert.equal(read(source + '/dist/build-info.json').commit, CUT);
assert.equal(inputs.tarball.packagingSourceCommit, CUT);
assert(inputs.tarball.path.startsWith(here + '/package/'), 'Stage the package in the isolated package directory');
assert.match(inputs.tarball.sha256, /^[a-f0-9]{64}$/);
assert(Number.isSafeInteger(inputs.tarball.bytes) && inputs.tarball.bytes > 0);
assert.equal(await hash(inputs.tarball.path), inputs.tarball.sha256);
assert.equal(fs.statSync(inputs.tarball.path).size, inputs.tarball.bytes);
assert(inputs.tarball.producerReceipt.path?.startsWith(root + '/'), 'Package producer receipt must be staged in the isolated native root');
assert.match(inputs.tarball.producerReceipt.sha256, /^[a-f0-9]{64}$/);
assert.equal(await hash(inputs.tarball.producerReceipt.path), inputs.tarball.producerReceipt.sha256);
const packedBuild = JSON.parse(execFileSync('python3', ['-c',
  'import sys,tarfile; t=tarfile.open(sys.argv[1]); print(t.extractfile("package/dist/build-info.json").read().decode())',
  inputs.tarball.path], { encoding: 'utf8', maxBuffer: 1024 * 1024 }));
assert.equal(packedBuild.commit, CUT, 'Tarball is not the current source build');
assert.equal(packedBuild.version, read(source + '/package.json').version);

async function admittedCells() {
  const availability = await receipt(inputs.sourceAppExport, here + '/availability.json');
  assert.equal(availability.status, 'restored');
  assert.deepEqual(inputs.requestedVariants, availability.availableVariants);
  assert.deepEqual(inputs.campaignRequestedVariants, ['js', 'c2-off', 'ts']);
  assert.deepEqual(inputs.unavailableVariants, Object.fromEntries(Object.entries(availability.variants).filter(([, value]) => value.status === 'unavailable')));
  assert(Array.isArray(inputs.requestedVariants) && inputs.requestedVariants.length);
  assert.equal(new Set(inputs.requestedVariants).size, inputs.requestedVariants.length);
  assert(inputs.requestedVariants.includes('js'), 'JS AOT is the declared baseline');
  const cells = [];
  for (const variant of inputs.requestedVariants) {
    assert(['js', 'c2-off', 'ts'].includes(variant));
    const refs = inputs.variants[variant];
    assert.equal(refs.enabled, true, variant + ': optional cell is not admitted');
    const admission = await receipt(refs.admission, root + '/admissions/' + variant + '.json');
    const build = await receipt(refs.build, root + '/build-receipts/' + variant + '/result.json');
    const core = await receipt(refs.core, root + '/qualification-results/' + variant + '-core/run/result.json');
    const controller = await receipt(refs.coreController, root + '/runtime-results/' + variant + '-core/result.json');
    const preserved = await receipt(refs.preservation, root + '/preserved/' + variant + '/transport.json');
    assert.equal(preserved.status, 'preserved-not-downloaded');
    assert.equal(preserved.sourceCommit, CUT);
    assert.equal(preserved.nativeResultSha256, refs.build.sha256);
    assert.equal(admission.decision, 'build-linux');
    assert.equal(admission.linuxCut.commit, CUT);
    assert.equal(build.status, 'built-unsigned');
    assert.equal(build.phase, 'complete');
    assert.equal(build.measurement.exitCode, 0);
    assert.equal(build.plan.admissionSha256, refs.admission.sha256);
    assert.equal(build.plan.sourceProof.commit, CUT);
    assert.equal(build.plan.variant, variant === 'c2-off' ? 'c2' : variant);
    assert.equal(build.plan.compiler.cohort, 'rd-p6-150c');
    assert.equal(build.plan.source, source);
    assert.deepEqual(build.plan.plugins, selected, 'Baseline and AOT selection differ');
    const compiler = compilers[variant === 'c2-off' ? 'cb-compat' : 'cb-standard'];
    assert.equal(compiler.cohort, 'rd-p6-150c');
    assert.equal(compiler.bunCommit, bun.bunCommit);
    assert.equal(compiler.webkitCommit, bun.webkitCommit);
    assert.deepEqual(compiler.engineFeatures, { shadowRealm: variant !== 'c2-off', hardened: false });
    for (const [file, digest] of [['build.json', compiler.buildReceiptSha256], ['transport.json', compiler.preservationReceiptSha256]]) {
      assert.equal(await hash(path.join(path.dirname(compiler.path), file)), digest);
    }
    assert.equal(build.plan.compiler.sha256, compiler.sha256);
    assert.equal(await hash(compiler.path), compiler.sha256);
    const artifact = root + '/artifacts/' + variant;
    assert.equal(build.plan.output, artifact);
    const planFile = root + '/build-receipts/' + variant + '/plan.json';
    assert.equal(await hash(planFile), preserved.nativePlanSha256);
    assert.deepEqual(read(planFile), build.plan);
    const checked = JSON.parse(execFileSync(node.path, [root + '/build-prep/artifact-contract.mjs', planFile], { encoding: 'utf8', maxBuffer: 1024 * 1024 }));
    const binarySha256 = await hash(artifact + '/openclaw');
    const manifestSha256 = await hash(artifact + '/manifest.json');
    assert.equal(checked.executable.sha256, binarySha256);
    assert.equal(checked.manifestSha256, manifestSha256);
    assert.equal(preserved.manifestSha256, manifestSha256);
    assert.equal(preserved.executable.sha256, binarySha256);
    assert.equal(preserved.runtime.sha256, checked.runtime.sha256);
    assert.equal(build.artifact.executable.sha256, binarySha256);
    assert.equal(build.artifact.manifestSha256, manifestSha256);
    assert.equal(core.qualification, 'passed');
    assert.equal(core.source, source);
    assert.equal(core.artifact, artifact);
    assert.equal(core.platform, 'linux');
    assert.equal(core.arch, 'x64');
    assert.equal(core.binarySha256, binarySha256);
    assert.equal(controller.status, 'phase-passed');
    assert.equal(controller.variant, variant);
    assert.equal(controller.phase, 'core');
    assert.equal(controller.sourceCommit, CUT);
    assert.equal(controller.actualBuildReceiptSha256, refs.build.sha256);
    assert.equal(controller.rootBuildAdmissionSha256, refs.admission.sha256);
    assert.equal(controller.binarySha256, binarySha256);
    assert.equal(controller.manifestSha256, manifestSha256);
    cells.push({ id: variant + '-aot', artifact, binarySha256, manifestSha256,
      buildReceiptSha256: refs.build.sha256, coreReceiptSha256: refs.core.sha256,
      policyLabel: build.plan.policyLabel, embeddedPlugins: read(artifact + '/manifest.json').plugins.embedded,
      executableBytes: checked.executable.sizeBytes, runtimeBytes: checked.runtime.sizeBytes });
  }
  return cells;
}

if (action === 'baseline') {
  console.log(JSON.stringify({ status: 'baseline-inputs-verified', sourceCommit: CUT }));
} else if (action === 'plan') {
  write(work + '/package-plan.json', { status: 'planned', sourceCommit: CUT, source, node, bun, inputsSha256,
    sourceBuildInfoSha256: plugins.distBuildInfoSha256, package: inputs.tarball,
    launchUmask: '0077', packagingMeasuredOnX64: false,
    installLabel: 'npm lifecycle with source allowScripts policy', npm,
    policySha256: await hash(here + '/project-package.manifest.json'), command: installCommand });
} else if (action === 'installed') {
  assert.equal(read(work + '/package-plan.json').package.sha256, inputs.tarball.sha256);
  assert.deepEqual(read(work + '/package-plan.json').node, node);
  assert.equal(read(work + '/install-command/result.json').status, 'complete');
  assert.equal(read(work + '/install-command/measurement/receipt.json').exitCode, 0);
  assert.equal(read(installed + '/dist/build-info.json').commit, CUT);
  assert.deepEqual(read(work + '/installed/package.json').allowScripts, policy.allowScripts);
  const lock = read(work + '/installed/package-lock.json');
  const locked = lock.packages['node_modules/openclaw'];
  assert(locked, 'Installed root package absent from npm lock');
  const expectedIntegrity = execFileSync('python3', ['-c', 'import base64,hashlib,sys; print("sha512-"+base64.b64encode(hashlib.file_digest(open(sys.argv[1],"rb"),"sha512").digest()).decode())', inputs.tarball.path], { encoding: 'utf8' }).trim();
  assert.equal(locked.integrity, expectedIntegrity, 'Installed package SRI differs from the exact tarball');
  assert.equal(read(installed + '/dist/build-info.json').version, packedBuild.version);
  assert.deepEqual(read(installed + '/package.json').openclaw.schemaVersions, read(source + '/package.json').openclaw.schemaVersions);
  const inventory = inspectPackageExtensions(installed);
  const ids = inventory.plugins.map(plugin => plugin.id);
  assert.equal(new Set(ids).size, ids.length, 'Duplicate installed plugin IDs');
  const missing = selected.filter(id => !ids.includes(id));
  assert.deepEqual(missing, [], 'Installed package omitted selected plugins');
  const piTui = work + '/installed/node_modules/@earendil-works/pi-tui';
  assert.equal(read(piTui + '/package.json').version, '1.3.0');
  assert.equal(await hash(piTui + '/dist/native-platform.js'), 'bd3deaa60d547941511128f7bcf40083cff0130a836bd3baf168baee370ccdf2');
  const inactivePath = 'node_modules/@earendil-works/pi-tui/native/linux/prebuilds/linux-arm64/linux-platform-x11.node';
  const selectedPath = 'node_modules/@earendil-works/pi-tui/native/linux/prebuilds/linux-x64/linux-platform-x11.node';
  const nativeFiles = [], inactiveArchitectureAssets = [], links = [];
  const installedSize = { regularFiles: 0, logicalBytes: 0, directories: 0 };
  const visit = async directory => {
    for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
      const filename = path.join(directory, item.name);
      if (item.isDirectory()) { installedSize.directories++; await visit(filename); continue; }
      if (item.isFile()) { installedSize.regularFiles++; installedSize.logicalBytes += fs.statSync(filename).size; }
      if (item.isSymbolicLink()) {
        const resolved = fs.realpathSync(filename);
        assert(resolved.startsWith(work + '/installed/'), 'Installed link escapes package tree');
        links.push({ path: path.relative(work + '/installed', filename), target: fs.readlinkSync(filename) });
        if (!fs.statSync(filename).isFile()) continue;
      } else if (!item.isFile()) continue;
      const fd = fs.openSync(filename, 'r'), header = Buffer.alloc(20);
      try { fs.readSync(fd, header, 0, 20, 0); } finally { fs.closeSync(fd); }
      if (!header.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) continue;
      const file = { path: path.relative(work + '/installed', filename), machine: header.readUInt16LE(18),
        bytes: fs.statSync(filename).size, sha256: await hash(filename) };
      if (file.path === inactivePath) {
        assert.equal(file.machine, 183);
        inactiveArchitectureAssets.push({ ...file, selection: 'inactive: verified loader selects process.arch=x64' });
      } else { assert.equal(file.machine, 62, 'Unexpected non-x64 ELF: ' + file.path); nativeFiles.push(file); }
    }
  };
  await visit(work + '/installed');
  assert(nativeFiles.some(file => file.path === selectedPath), 'Selected pi-tui x64 helper missing');
  write(work + '/installed-receipt.json', { status: 'installed-not-core-qualified', sourceCommit: CUT, node, bun, inputsSha256,
    entry, entrySha256: await hash(entry), tarballSha256: inputs.tarball.sha256, tarballIntegrity: expectedIntegrity,
    lockSha256: await hash(work + '/installed/package-lock.json'), policySha256: await hash(here + '/project-package.manifest.json'), npm,
    sourceBuildInfoSha256: await hash(installed + '/dist/build-info.json'),
    plugins: inventory.plugins, nativeFiles, inactiveArchitectureAssets, links, installedSize,
    pluginInventory: { selectedCount: selected.length, extensionDirectoryCount: inventory.directories.length,
      manifestPluginCount: ids.length, missing, extras: ids.filter(id => !selected.includes(id)),
      nonPluginDirectories: inventory.nonPluginDirectories },
    deploymentComparison: 'Unpruned npm deployment; contents may differ from standalone. No compiler-only attribution.',
    launchUmask: '0077', performanceQualified: false });
} else {
  const cells = await admittedCells();
  if (action === 'cohort') {
    const baseline = read(work + '/installed-receipt.json');
    assert.equal(await hash(entry), baseline.entrySha256);
    assert.equal(baseline.tarballSha256, inputs.tarball.sha256);
    assert.deepEqual(baseline.node, node);
    assert.deepEqual(baseline.bun, bun);
    for (const [name, runtime] of [['node-core', node], ['bun-core', bun]]) {
      const result = read(work + '/' + name + '/result.json');
      assert.equal(result.qualification, 'passed');
      assert.equal(result.binarySha256, runtime.sha256);
      assert.equal(result.entrySha256, baseline.entrySha256);
    }
    assert.equal(inputs.sweeps, 6, 'Default campaign is six sweeps plus warmup');
    cells.push(...[['node-npm', node], ['bun-jit-npm', bun]].map(([id, runtime]) => ({ id, runtime: runtime.path,
      entry, binarySha256: runtime.sha256, entrySha256: baseline.entrySha256 })));
    const js = inputs.variants.js;
    write(work + '/cohort-config.json', { source, mainSha: CUT, inputsSha256, admissionReceipt: js.admission.path,
      admissionReceiptSha256: js.admission.sha256, baseline: 'js-aot', sweeps: 6, cells,
      installedReceiptSha256: await hash(work + '/installed-receipt.json'),
      sourceAppExport: inputs.sourceAppExport, unavailableVariants: inputs.unavailableVariants, campaignRequestedVariants: inputs.campaignRequestedVariants,
      executionEnvironment: { PATH: '/usr/bin:/bin', umask: '0077' },
      equivalence: 'Deployment comparison only; actual plugin directory and manifest counts are recorded separately. No pruning or compiler-only attribution.' });
  }
  console.log(JSON.stringify({ status: 'actual-native-facts-verified', sourceCommit: CUT, cells: cells.map(cell => cell.id) }));
}
