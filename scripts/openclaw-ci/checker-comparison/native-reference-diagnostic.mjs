import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const [source, output] = process.argv.slice(2);
if (!source || !output || process.argv.length !== 4) throw new Error('Expected source and output');
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const manifest = JSON.parse(fs.readFileSync(path.join(source, 'tools/bun-checker-matrix-input/manifest.json'), 'utf8'));
const JSON5 = createRequire(path.join(source, 'package.json'))('json5');
const { resolveRepoToolBinPath } = await import(pathToFileURL(path.join(source, 'scripts/lib/local-check-runtime.mts')));
const { runMeasuredTsgoCommand } = await import(pathToFileURL(path.join(source, 'scripts/lib/tsgo-performance.mts')));
const { ensureKyselyTypes } = await import(pathToFileURL(path.join(source, 'scripts/generate-kysely-types.mts')));
const { withDistArtifactOwnership } = await import(pathToFileURL(path.join(source, 'scripts/lib/dist-artifact-ownership.mts')));
const native = resolveRepoToolBinPath('tsgo', { cwd: source });
if (hash(native) !== manifest.native.binarySha256) throw new Error('Native binary differs');
const version = spawnSync(native, ['--version'], { cwd: source, encoding: 'utf8', timeout: 30_000 });
if (version.error || version.status !== 0 || version.stdout.trim() !== `Version ${manifest.native.version}` || version.stderr) throw new Error('Native version differs');
const graph = manifest.graphs.find(graph => graph.build);
if (!graph || manifest.buildReferences.length !== 2) throw new Error('Expected exact two-reference graph');
const config = path.join(source, graph.config);
if (hash(config) !== graph.configSha256) throw new Error('Reference config differs');
const neutral = path.join(output, 'reference-neutral');
const metrics = path.join(output, 'reference-metrics');
fs.mkdirSync(neutral);
fs.mkdirSync(metrics);
const buildInfos = manifest.buildReferences.map(reference => {
  const file = path.join(source, reference.config);
  if (hash(file) !== reference.configSha256) throw new Error('Referenced config differs');
  const name = JSON5.parse(fs.readFileSync(file, 'utf8')).compilerOptions.tsBuildInfoFile;
  const resolved = path.resolve(path.dirname(file), name);
  if (!resolved.startsWith(path.join(source, '.artifacts/tsgo-cache/'))) throw new Error('Unexpected build-info path');
  return path.relative(source, resolved);
});
const snapshot = () => buildInfos.map(file => {
  const target = path.join(source, file);
  if (!fs.existsSync(target)) return { file, exists: false };
  if (!fs.lstatSync(target).isFile()) throw new Error('Build info is not a regular file');
  return { file, exists: true, sha256: hash(target), bytes: fs.statSync(target).size };
});
const before = snapshot();
if (before.some(file => file.exists)) throw new Error('Diagnostic requires absent initial build info');
const args = ['-b', config, '--singleThreaded', '--checkers', '1', '--pretty', 'false', '--noEmit', '--declaration', 'false', '--verbose', '--extendedDiagnostics'];
const buffers = [[], []];
let bytes = 0, overflow = false, code = null, failure = null;
const startedAt = new Date().toISOString();
const started = Date.now();
try {
  await withDistArtifactOwnership(source, async () => {
    await ensureKyselyTypes(source);
    code = await runMeasuredTsgoCommand({
      bin: native, args, cwd: neutral,
      env: { ...process.env, NODE_OPTIONS: '', GOMAXPROCS: '1', GOGC: '30', GOMEMLIMIT: '4GiB' },
      stdio: ['ignore', 'pipe', 'pipe'], requireProcessTreeExit: true, timeoutMs: 600_000,
      onReady(child) {
        console.log('[native-reference:started] ' + JSON.stringify({ pid: child.pid, startedAt, diagnosticCeilingMs: 600_000 }));
        for (const [index, stream] of [child.stdout, child.stderr].entries()) stream?.on('data', chunk => {
          bytes += chunk.length;
          if (bytes <= 4 * 1024 ** 2) buffers[index].push(chunk); else overflow = true;
          (index === 0 ? process.stdout : process.stderr).write(chunk);
        });
      },
    }, metrics);
  });
} catch (error) {
  failure = { message: error.message, code: error.code ?? null };
}
const metricFiles = fs.readdirSync(metrics).filter(file => file.endsWith('.json'));
const receipt = {
  kind: 'native reference diagnostic, not matrix qualification or performance evidence',
  source: manifest.source, manifestSha256: hash(path.join(source, 'tools/bun-checker-matrix-input/manifest.json')),
  nativeBinarySha256: hash(native), nativeVersion: version.stdout.trim(), nodeVersion: process.version, config: graph,
  args, startedAt, elapsedMs: Date.now() - started, diagnosticCeilingMs: 600_000,
  host: { cpus: os.availableParallelism(), totalMemory: os.totalmem() },
  beforeBuildInfo: before, afterBuildInfo: snapshot(), code, failure, overflow,
  stdout: Buffer.concat(buffers[0]).toString('utf8'), stderr: Buffer.concat(buffers[1]).toString('utf8'),
  metrics: metricFiles.length === 1 ? JSON.parse(fs.readFileSync(path.join(metrics, metricFiles[0]), 'utf8')) : null,
};
// The existing sampler resolves provenance from the neutral cwd; these explicit
// source/config/binary fields are authoritative for this diagnostic instead.
fs.writeFileSync(path.join(output, 'native-reference.json'), JSON.stringify(receipt, null, 2) + '\n');
console.log('[native-reference:done] ' + JSON.stringify({ code, failure, overflow, elapsedMs: receipt.elapsedMs }));
process.exitCode = code === 0 && !failure && !overflow && receipt.metrics ? 0 : 1;
