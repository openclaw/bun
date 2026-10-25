// Run with the qualified Bun from the completed source checkout.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [sourceInput, outputInput] = process.argv.slice(2);
assert(sourceInput && outputInput, 'Usage: bun select-plugins.mjs SOURCE FRESH_OUTPUT');
const source = fs.realpathSync(sourceInput), output = path.resolve(outputInput);
assert(!fs.existsSync(output), 'Fresh selector output required');
const sourceCommit = execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const runtimeBuildInfo = JSON.parse(fs.readFileSync(path.join(source, 'dist/build-info.json'), 'utf8'));
assert.equal(runtimeBuildInfo.commit?.trim().toLowerCase(), sourceCommit, 'Runtime build is from a different source commit; rerun pnpm build');
assert.equal(runtimeBuildInfo.version, JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8')).version, 'Runtime package version is stale');
const owner = path.join(source, 'scripts/lib/bun-standalone-plugins.mjs');
const { classifyStandalonePlugins, planStandalonePlugins } = await import(pathToFileURL(owner).href);
const inventory = classifyStandalonePlugins(source);
const byId = new Map(inventory.map(row => [row.id, row]));
assert(byId.has('codex'), 'Desktop Codex plugin missing from completed build');
const selected = new Set([...inventory.filter(row => !row.hasInstallRoute && !row.devOnly).map(row => row.id), 'codex']);
let size;
do {
  size = selected.size;
  for (const id of selected) for (const dependency of byId.get(id).requiresPlugins) {
    assert(byId.has(dependency), `Missing required plugin ${dependency} for ${id}`);
    selected.add(dependency);
  }
} while (size !== selected.size);
const desktop = planStandalonePlugins(source, [...selected].toSorted());
const all = planStandalonePlugins(source);
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const receipt = { sourceRoot: source, sourceCommit, owner, ownerSha256: hash(owner),
  rule: 'classifyStandalonePlugins: !hasInstallRoute && !devOnly, plus codex, with requiresPlugins closure; validated by planStandalonePlugins',
  inventory, desktop, all, runtimeBuildInfo, buildInfoSha256: hash(path.join(source, 'dist/build-info.json')) };
fs.mkdirSync(output, { recursive: true });
for (const [file, value] of [['plugin-selection.json', receipt], ['desktop.json', desktop.embedded], ['all.json', all.embedded]])
  fs.writeFileSync(path.join(output, file), JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ sourceCommit, desktop: desktop.embedded.length, all: all.embedded.length, output }));
