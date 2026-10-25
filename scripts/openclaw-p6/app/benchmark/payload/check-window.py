#!/usr/bin/env python3
"""Bind a fresh host quiet receipt to the complete same-host measured budget."""
import hashlib,json,os,time
from pathlib import Path
HERE=Path(__file__).resolve().parent
ROOT=Path('/home/runner/.cache/oc-ty-ext/P6/app-x64-final-r2-v1')
budget=json.loads((HERE/'cohort-budget.json').read_text());q=json.loads((HERE/'quiet-admission.json').read_text())
assert q['decision']=='run-complete-selected-cell-cohort' and q['sourceCommit']=='670a7ab33bbd2e3ed4f0a5681e138159d74540a1' and q['nativeRoot']==str(ROOT)
assert q['hostBootId']==Path('/proc/sys/kernel/random/boot_id').read_text().strip()
assert 0<=time.time()-q['observedAtEpoch']<=300
assert all(q[k] is True for k in ['heavyBuildsReconciled','nativeHooksReconciled','dockerAndGuestWorkReconciled','otherBenchmarksStopped','sameNativeMachineAllCells','exclusiveBenchmarkInterval'])
assert q['reservationSeconds']>=budget['requiredSeconds']
assert budget['remainingSecondsAfterCleanupReserve']>=budget['requiredSeconds']
assert int(os.environ['P6_DEADLINE_EPOCH'])-time.time()-1200>=budget['requiredSeconds']
evidence=Path(q['hostReconciliation']['path']);assert ROOT in evidence.resolve().parents
assert hashlib.sha256(evidence.read_bytes()).hexdigest()==q['hostReconciliation']['sha256']
print(json.dumps({'status':'complete-cohort-admitted','requiredSeconds':budget['requiredSeconds'],'cells':budget['cells']}))
