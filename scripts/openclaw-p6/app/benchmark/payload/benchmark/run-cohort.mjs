#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveLaunchTarget } from './launch-target.mjs';
import { summarize, sweepOrder } from './cohort-stats.mjs';

const [configName, outName] = process.argv.slice(2);
assert(configName && outName, 'Usage: node run-cohort.mjs config.json fresh-output-directory');
assert.equal(process.platform, 'linux', 'measurements require native Linux');
const config = JSON.parse(fs.readFileSync(configName, 'utf8'));
const source = fs.realpathSync(config.source);
assert(/^[a-f0-9]{40}$/.test(config.mainSha), 'mainSha must be the externally admitted full source SHA');
assert(config.admissionReceipt, 'P0 admission receipt is required');
const hash = async filename => {
  const digest = createHash('sha256');
  for await (const bytes of fs.createReadStream(filename)) digest.update(bytes);
  return digest.digest('hex');
};
const admissionReceipt = fs.realpathSync(config.admissionReceipt);
const admissionReceiptSha256 = await hash(admissionReceipt);
assert(Array.isArray(config.cells) && config.cells.length >= 2);
const ids = config.cells.map(cell => cell.id);
assert.equal(new Set(ids).size, ids.length);
assert(ids.every(id => /^[a-z0-9-]+$/.test(id)), 'cell IDs must be path-safe');
assert(ids.includes(config.baseline), 'baseline must name one cell');
const sweeps = config.sweeps ?? 6;
assert(Number.isInteger(sweeps) && sweeps >= 2 && sweeps <= 20);
const inputs = [];
for (const cell of config.cells) {
  const target = resolveLaunchTarget(cell);
  const binarySha256 = await hash(target.binary);
  assert.equal(binarySha256, cell.binarySha256, `${cell.id}: binary differs from admitted hash`);
  const entrySha256 = target.entry ? await hash(target.entry) : null;
  if (target.entry) assert.equal(entrySha256, cell.entrySha256, `${cell.id}: entry differs from admitted hash`);
  inputs.push({ ...cell, ...target, binarySha256, entrySha256 });
}
const out = path.resolve(outName);
assert(!fs.existsSync(out), 'output must be fresh');
for (const protectedPath of [source, ...inputs.flatMap(cell => [cell.artifact, cell.entry && path.dirname(cell.entry)]).filter(Boolean)]) {
  assert(out !== protectedPath && !out.startsWith(protectedPath + path.sep), 'output must be outside source/artifacts');
}
fs.mkdirSync(out, { recursive: true });
fs.mkdirSync(path.join(out, 'controller-home'));
fs.mkdirSync(path.join(out, 'controller-tmp'));
const runner = path.join(path.dirname(fileURLToPath(import.meta.url)), 'core-runner.proposed.mjs');
const receipt = { schema: 1, started: new Date().toISOString(), mainSha: config.mainSha,
  admissionReceipt, admissionReceiptSha256, source, inputs, baseline: config.baseline, sweeps,
  runnerSha256: await hash(runner), machine: { platform: process.platform, arch: process.arch,
    kernel: os.release(), cpus: os.cpus().length, totalMemoryBytes: os.totalmem() },
  limits: ['Native architecture must also be confirmed by the operator; no emulator detection is claimed.',
    'Source/lock/plugin equivalence is an admission prerequisite recorded by P0, not inferred from this config.',
    'Own CPU/RSS cover the Gateway root; tree fields include current descendants, with reaped-child CPU. Tree RSS sums per-process RSS, not PSS; see raw snapshots for limits.',
    'Fresh isolated state per sample; preceding CLI checks warm shared code pages; not cold-cache measurements.',
    'Synthetic streaming provider; not live-model latency.'], rows: [] };
const save = () => fs.writeFileSync(path.join(out, 'cohort.json'), JSON.stringify(receipt, null, 2) + '\n');
save();
let active;
let interrupted = false;
const stop = () => { interrupted = true; active?.kill('SIGTERM'); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
try {
  // One complete warmup sweep is retained separately, then measured sweeps alternate order.
  for (let sweep = -1; sweep < sweeps; sweep++) {
    for (const id of sweepOrder(ids, sweep < 0 ? 0 : sweep)) {
      assert(!interrupted, 'cohort interrupted');
      const cell = inputs.find(item => item.id === id);
      const label = `${sweep < 0 ? 'warmup' : `sweep-${sweep + 1}`}-${id}`;
      const rowOut = path.join(out, label);
      const args = [runner, '--source', source, '--out', rowOut];
      if (cell.artifact) args.push('--artifact', cell.artifact);
      else args.push('--runtime', cell.binary, '--entry', cell.entry);
      const stdout = fs.openSync(path.join(out, `${label}.stdout`), 'w');
      const stderr = fs.openSync(path.join(out, `${label}.stderr`), 'w');
      const row = { id, sweep, warmup: sweep < 0, out: rowOut, started: new Date().toISOString(),
        loadBefore: os.loadavg(), freeMemoryBefore: os.freemem() };
      receipt.rows.push(row);
      save();
      active = spawn(process.execPath, args, { stdio: ['ignore', stdout, stderr],
        env: { PATH: process.env.PATH, HOME: path.join(out, 'controller-home'),
          TMPDIR: path.join(out, 'controller-tmp'), LANG: 'C.UTF-8', TZ: 'UTC' } });
      fs.closeSync(stdout);
      fs.closeSync(stderr);
      const exit = await new Promise((resolve, reject) => {
        active.once('error', reject);
        active.once('close', (code, signal) => resolve({ code, signal }));
      });
      active = null;
      Object.assign(row, exit, { finished: new Date().toISOString(), loadAfter: os.loadavg(), freeMemoryAfter: os.freemem() });
      const resultName = path.join(rowOut, 'result.json');
      if (fs.existsSync(resultName)) row.result = JSON.parse(fs.readFileSync(resultName, 'utf8'));
      save();
      assert.equal(exit.code, 0, `${label} failed; no selective continuation`);
      assert.equal(row.result?.qualification, 'passed');
      assert.equal(row.result.binarySha256, cell.binarySha256, `${label}: binary changed during cohort`);
      assert.equal(row.result.entrySha256, cell.entrySha256, `${label}: entry changed during cohort`);
    }
  }
  receipt.summary = summarize(receipt.rows, ids, config.baseline);
  receipt.status = 'passed';
} catch (error) {
  receipt.status = 'failed';
  receipt.error = error.stack ?? String(error);
  process.exitCode = 1;
} finally {
  receipt.finished = new Date().toISOString();
  save();
  process.off('SIGINT', stop);
  process.off('SIGTERM', stop);
}
console.log(JSON.stringify({ status: receipt.status, out }));
