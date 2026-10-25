// Adapt the frozen P0 census to the maintained selected-dist and worker owners.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [sourceName, selectionName, inventoryName, runtimeName, outputName] = process.argv.slice(2);
assert(sourceName && selectionName && inventoryName && runtimeName && outputName);
const source = fs.realpathSync(sourceName);
assert.equal(fs.realpathSync(process.cwd()), source);
const read = name => JSON.parse(fs.readFileSync(name, 'utf8'));
const load = relative => import(pathToFileURL(path.join(source, relative)).href);
const pluginsOwner = await load('scripts/lib/bun-standalone-plugins.mjs');
const { createStandaloneRuntimeProcessEntrypoints } = await load('src/infra/runtime-process-manifest.ts');
const { discoverStandaloneWorkers } = await load('scripts/lib/bun-standalone-workers.mjs');
const { loadStandaloneSourceEntries } = await load('scripts/lib/bun-standalone-source-entries.mjs');
const { createStandaloneSourceParser } = await load('scripts/lib/bun-standalone-source-parser.mjs');
const { collectSourceCheckoutPluginBuildEntries } = await load('scripts/lib/bundled-plugin-build-entries.mjs');
const { listPackagedStaticExtensionAssetOutputs } = await load('scripts/lib/static-extension-assets.mts');
const { standaloneResourceCategory } = await load('scripts/lib/bun-standalone-sidecar.mjs');
const selection = pluginsOwner.planStandalonePlugins(source, read(selectionName));
const omitted = new Set(selection.omittedDirs);
const declaredAssets = new Set(listPackagedStaticExtensionAssetOutputs({ rootDir: source }));
const inventory = [];
function visit(directory, relative = 'dist') {
  for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
    // Same inventory exclusions as build-bun-standalone.mjs::runtimeJavaScriptEntries.
    if (['node_modules', 'control-ui', 'worker-artifacts'].includes(item.name)) continue;
    const name = path.posix.join(relative, item.name);
    if (relative === 'dist/extensions' && omitted.has(item.name)) continue;
    if (item.isDirectory() && !item.isSymbolicLink()) visit(path.join(directory, item.name), name);
    else if (item.isFile() && /\.[cm]?js$/.test(item.name) && !standaloneResourceCategory(name, declaredAssets)) inventory.push(name);
  }
}
visit(path.join(source, 'dist'));
const selected = await pluginsOwner.selectStandalonePluginModules(source, inventory.toSorted(), selection);
const workers = discoverStandaloneWorkers({ runtimeRoot: source,
  runtimeEntrypoints: createStandaloneRuntimeProcessEntrypoints(import.meta.url, selection.embeddedDirs) });
const entries = await loadStandaloneSourceEntries({ sourceRoot: source, workerEntries: workers,
  parse: createStandaloneSourceParser() });
const unmappedWorkers = entries.unmappedWorkers(workers);
const undeclaredPluginWorkers = [];
for (const plugin of collectSourceCheckoutPluginBuildEntries({ cwd: source })) {
  if (!selection.embeddedDirs.includes(plugin.id)) continue;
  for (const worker of plugin.packageJson?.openclaw?.build?.workerEntries ?? []) {
    const filename = path.resolve(source, 'extensions', plugin.id, worker);
    const outputs = entries.entries.filter(entry => entry.source === filename).map(entry => entry.output);
    if (!outputs.some(output => workers.includes(output))) undeclaredPluginWorkers.push({ plugin: plugin.id, worker, outputs });
  }
}
const nativeDistEntries = new Set([...selected, ...workers].filter(name => name.startsWith('dist/')));
const census = read(inventoryName), runtime = read(runtimeName);
assert.equal(fs.realpathSync(census.root), path.join(source, 'dist'));
assert.equal(process.platform, 'linux');
assert(['x64', 'arm64'].includes(process.arch));
assert.equal(Bun.revision, '150c9620c53710060186b8b0cd50985e035408b0');
assert.equal(process.versions.webkit, 'aaa690bfbf34c9d50775716ac2fc3c7d0573e0b8');
assert.equal(runtime.revision, Bun.revision);
assert.equal(runtime.execPath, process.execPath);
const modules = new Map(runtime.modules.map(module => [module.specifier, module]));
const selectedMissing = [], diagnosticOnlyMissing = [];
for (const record of census.records) {
  const canonical = record.specifier.startsWith('bun:') ? record.specifier : 'node:' + record.specifier.replace(/^node:/, '');
  const queried = modules.get(canonical);
  assert(queried, 'Builtin absent from actual runtime query: ' + canonical);
  const missing = record.names.filter(name => !queried.available?.includes(name));
  if (!queried.error && !missing.length) continue;
  const row = { ...record, canonical, missing, ...(queried.error ? { error: queried.error } : {}) };
  (nativeDistEntries.has('dist/' + record.file) ? selectedMissing : diagnosticOnlyMissing).push(row);
}
const result = { status: selectedMissing.length || unmappedWorkers.length || undeclaredPluginWorkers.length ? 'failed' : 'passed',
  scope: 'Maintained selected emitted-dist/native-worker input projection; no bundling or native compilation',
  source, selectedPlugins: selection.embedded, selectedDistEntries: selected.length, workerTargets: workers.length,
  nativeDistEntries: [...nativeDistEntries].toSorted(), sourceEntries: entries.entries.length,
  unmappedWorkers, undeclaredPluginWorkers, selectedMissing, diagnosticOnlyMissing,
  runtimeRevision: runtime.revision, limitations: ['Full-dist missing sites outside owner-selected inputs are diagnostic only.',
    'Does not replace final transformed-source or native link validation; extra native adapter/dependency inputs are not fully enumerated here.'] };
fs.writeFileSync(outputName, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ status: result.status, selectedMissing, unmappedWorkers, undeclaredPluginWorkers,
  diagnosticOnlyMissingCount: diagnosticOnlyMissing.length }));
if (result.status !== 'passed') process.exitCode = 1;
