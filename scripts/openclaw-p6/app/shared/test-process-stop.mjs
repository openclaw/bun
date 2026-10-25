import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

const owner = process.env.P6_STOP_MODULE
  ? pathToFileURL(process.env.P6_STOP_MODULE).href : new URL('./process-stop.mjs', import.meta.url).href;
const { readGatewayStopBudget, stopProcess, shutdownFailure } = await import(owner);

async function fixture(t, mode, delayMs = 0) {
  const code = `let stopping=false;
process.on('SIGTERM',()=>{if(stopping)return;stopping=true;
 if(${JSON.stringify(mode)}==='natural')setTimeout(()=>{console.log('natural-exit');process.exit(0)},${delayMs});});
setInterval(()=>{},1000);console.log('ready');`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code],
    { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.done = once(child, 'close');
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      try { process.kill(-child.pid, 'SIGKILL'); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    await child.done;
  });
  await Promise.race([once(child.stdout, 'data', { signal: AbortSignal.timeout(5000) }),
    child.done.then(() => { throw new Error('Synthetic child exited before readiness'); })]);
  assert(output.includes('ready'));
  return { child, output: () => output };
}

test('Gateway exits naturally after the former 10-second cutoff', { timeout: 20_000 }, async t => {
  const source = fs.mkdtempSync(path.join(os.tmpdir(), 'p6-stop-policy-'));
  t.after(() => fs.rmSync(source, { recursive: true, force: true }));
  fs.writeFileSync(path.join(source, 'gateway-shutdown-budget.mjs'),
    'export const GATEWAY_SHUTDOWN_TIMEOUT_MS=325000;export const GATEWAY_SERVICE_STOP_TIMEOUT_MS=330000;');
  const budget = await readGatewayStopBudget(source);
  const { child, output } = await fixture(t, 'natural', 11_000);
  const receipt = await stopProcess(child, { graceMs: budget.serviceStopTimeoutMs });
  assert.equal(child.exitCode, 0, 'cleanup must allow natural exit beyond 10 seconds');
  assert.equal(child.signalCode, null);
  assert(output().includes('natural-exit'));
  assert.equal(receipt.forced, false);
  assert.equal(receipt.exitObserved, true);
  assert.equal(receipt.graceMs, 330_000);
  assert.equal(shutdownFailure([receipt], { code: child.exitCode, signal: child.signalCode }), null);
});

test('non-Gateway children retain the short default grace', async t => {
  const { child } = await fixture(t, 'natural');
  const receipt = await stopProcess(child);
  assert.equal(receipt.graceMs, 10_000);
  assert.equal(receipt.exitCode, 0);
  assert.equal(receipt.forced, false);
});

test('over-budget cleanup is force-stopped and repeated requests share one deadline', async t => {
  const { child } = await fixture(t, 'ignore');
  const first = stopProcess(child, { graceMs: 50 });
  assert.equal(stopProcess(child, { graceMs: 330_000 }), first);
  const receipt = await first;
  assert.equal(receipt.forced, true);
  assert.equal(receipt.exitObserved, true);
  assert.equal(receipt.exitCode, null);
  assert.equal(receipt.exitSignal, 'SIGKILL');
  assert.equal(receipt.graceMs, 50);
  assert.equal(shutdownFailure([receipt], { code: 0, signal: null }), 'Process required forced stop');
});
