#!/usr/bin/env python3
"""Reserve all seven complete sweeps from this host's actual functional probes."""
import json,math,os,time
from pathlib import Path
HERE=Path(__file__).resolve().parent
x=json.loads((HERE/'native-inputs.json').read_text())
rows=json.loads((HERE/'work/functional-timings.json').read_text())
ids=[v+'-aot' for v in x['requestedVariants']]+['node-npm','bun-jit-npm']
accepted=[row for row in rows if row['id'] in ids]
assert len(accepted)==len(ids) and all(row['status']=='passed' for row in accepted)
assert x['sweeps']==6
one=sum(row['wallSeconds'] for row in accepted)
# Functionals are scheduling evidence, not performance samples. Allow twice their
# elapsed time for every row, plus five minutes for controller/cleanup variation.
required=math.ceil(7*one*2+300)
remaining=int(os.environ['P6_DEADLINE_EPOCH'])-int(time.time())-1200
result={'status':'window-available' if remaining>=required else 'insufficient-window','sourceCommit':x['sourceCommit'],'cells':ids,'warmupSweeps':1,'measuredSweeps':6,'probeSecondsPerSweep':one,'jitterMultiplier':2,'controllerAllowanceSeconds':300,'requiredSeconds':required,'remainingSecondsAfterCleanupReserve':remaining,'performanceEligible':False}
(HERE/'cohort-budget.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps(result))
raise SystemExit(0 if remaining>=required else 78)
