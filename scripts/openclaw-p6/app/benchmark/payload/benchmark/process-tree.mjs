import assert from 'node:assert/strict';
import fs from 'node:fs';

export function readProcStat(pid) {
  try {
    const text = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = text.slice(text.lastIndexOf(')') + 2).split(' ');
    return { pid, ppid: Number(fields[1]), state: fields[0], start: fields[19],
      cpuTicks: Number(fields[11]) + Number(fields[12]),
      reapedChildCpuTicks: Number(fields[13]) + Number(fields[14]), rssPages: Number(fields[21]) };
  } catch {
    return null;
  }
}

export function snapshotProcessTree(rootPid, { clockTicks, pageSize, expectedStart } = {}) {
  assert.equal(process.platform, 'linux');
  assert(Number.isFinite(clockTicks) && clockTicks > 0);
  assert(Number.isFinite(pageSize) && pageSize > 0);
  const started = performance.now();
  const all = [];
  for (const name of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    const row = readProcStat(Number(name));
    if (row) all.push(row);
  }
  const root = all.find(row => row.pid === rootPid);
  assert(root && root.state !== 'Z', 'Gateway root is missing or exited during tree snapshot');
  if (expectedStart !== undefined) assert.equal(root.start, expectedStart, 'Gateway root PID was reused');
  const ids = new Set([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of all) {
      if (ids.has(row.ppid) && !ids.has(row.pid)) {
        ids.add(row.pid);
        changed = true;
      }
    }
  }
  const processes = all.filter(row => ids.has(row.pid));
  const live = processes.filter(row => row.state !== 'Z');
  // Reaped CPU belongs to the waiting ancestor; an unreaped zombie still owns
  // its counters. Each visible node contributes once at this census boundary.
  const cpuTicks = processes.reduce((sum, row) => sum + row.cpuTicks + row.reapedChildCpuTicks, 0);
  return { at: new Date().toISOString(), collectionMilliseconds: performance.now() - started,
    root: { pid: rootPid, start: root.start }, processes,
    liveProcessCount: live.length, zombieProcessCount: processes.length - live.length,
    rssBytes: live.reduce((sum, row) => sum + row.rssPages * pageSize, 0),
    cpuTicks, cpuSeconds: cpuTicks / clockTicks,
    scope: 'Gateway root and current PPID descendants; RSS sums non-zombies; CPU sums own plus reaped-child user/system ticks, including visible zombies',
    limits: ['Non-atomic /proc census: process churn during collection can move CPU between records.',
      'RSS sums process RSS and can count shared pages more than once; it is not PSS or unique physical memory.',
      'Descendants that escape through reparenting are outside this snapshot; no peak or lifetime RSS claim.'] };
}
