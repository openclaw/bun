#!/usr/bin/env python3
"""Use the accepted measurement/core owners to size the complete next cohort."""
import importlib.util,json,os,signal,subprocess,sys,time
from pathlib import Path
HERE=Path(__file__).resolve().parent
sys.path.insert(0,str(HERE.parent))
ROOT=Path('/home/runner/.cache/oc-ty-ext/P6/app-x64-final-r3-v1')
assert HERE==ROOT/'benchmark-prep'
os.umask(0o077)
def load(p):return json.loads(Path(p).read_text())
def save(p,x):Path(p).write_text(json.dumps(x,indent=2)+'\n')
def sha(p):
 import hashlib
 with Path(p).open('rb') as f:return hashlib.file_digest(f,'sha256').hexdigest()
x=load(HERE/'native-inputs.json');availability=load(HERE/'availability.json');node=x['node']['path'];work=HERE/'work'
assert sha(HERE/'harness/measurement-owner.py')==x['ownerFiles']['harness/measurement-owner.py']
spec=importlib.util.spec_from_file_location('p6_measurement_owner',HERE/'harness/measurement-owner.py');owner=importlib.util.module_from_spec(spec);spec.loader.exec_module(owner)
assert sha(ROOT/'measure-command.py')==owner.MEASURE_SHA
subprocess.run([node,str(HERE/'metadata.mjs'),'baseline'],check=True)
entry=str(work/'installed/node_modules/openclaw/openclaw.mjs')
cells=[(v+'-aot',['--artifact',str(ROOT/'artifacts'/v)],work/(v+'-core'),v) for v in x['requestedVariants']]
cells += [('node-npm',['--runtime',node,'--entry',entry],work/'node-core',None),('bun-jit-npm',['--runtime',str(ROOT/'compilers/standard/bun'),'--entry',entry],work/'bun-core',None)]
measurements=work/'functional-measurements';measurements.mkdir();timings=[]
knowledge={'sourceCommit':x['sourceCommit'],'status':'incomplete','expectedVariants':list(x['requestedVariants']),
 'variants':{v:{'status':'not-run'} for v in x['requestedVariants']},'performanceEligible':False}
save(work/'knowledge-controls.json',knowledge)
env={'PATH':'/usr/bin:/bin','HOME':str(work/'home'),'TMPDIR':str(work/'tmp'),'LANG':'C.UTF-8','TZ':'UTC'}
shutdown=json.loads(subprocess.check_output([node,str(HERE/'harness/process-stop.mjs'),
 '--gateway-budget',str(ROOT/'source')],env=env,text=True,timeout=30))
# Allow Gateway reap (5s), provider stop/reap (10s+5s), and final census (10s).
cleanup_grace=shutdown['serviceStopTimeoutMs']/1000+30
for cell,args,out,variant in cells:
 receipt=measurements/cell;receipt.mkdir();started=time.monotonic();error=None
 old=signal.signal(signal.SIGHUP,owner.interrupted)
 try:
  owner.measure({'measurementUtility':str(ROOT/'measure-command.py'),'variant':'preflight-'+cell,'source':str(ROOT/'source'),'timeoutSeconds':900,'cleanupGraceSeconds':cleanup_grace,'command':[node,str(HERE/'benchmark/core-runner.proposed.mjs'),'--source',str(ROOT/'source'),'--out',str(out),*args]},env,receipt)
  result=load(out/'result.json');assert result['qualification']=='passed'
 except BaseException as e:
  if isinstance(e,(owner.BuildInterrupted,KeyboardInterrupt,SystemExit)):raise
  error=str(e)
 finally:signal.signal(signal.SIGHUP,old)
 row={'id':cell,'wallSeconds':time.monotonic()-started,'status':'passed' if error is None else 'failed','error':error,'receipt':str(receipt),'output':str(out),'performanceEligible':False};timings.append(row)
 save(work/'functional-timings.json',timings)
 if error is not None:
  if variant not in ['c2-off','ts']:raise RuntimeError(cell+' required baseline functional failed: '+error)
  availability['variants'][variant]={'status':'unavailable','reason':'new-host functional failed','functional':row,'performanceQualified':False}
  availability['availableVariants'].remove(variant)
  save(HERE/'availability.json',availability)
# Knowledge runs in fresh state and never changes ordinary functional/timing availability.
for variant in x['requestedVariants']:
 if variant not in availability['availableVariants']:
  knowledge['variants'][variant]={'status':'not-run','reason':'ordinary functional cell unavailable'}
  save(work/'knowledge-controls.json',knowledge)
  continue
 receipt=measurements/(variant+'-knowledge');receipt.mkdir();out=work/(variant+'-knowledge');error=None
 old=signal.signal(signal.SIGHUP,owner.interrupted)
 try:
  owner.measure({'measurementUtility':str(ROOT/'measure-command.py'),'variant':'knowledge-'+variant,
   'source':str(ROOT/'source'),'timeoutSeconds':900,'cleanupGraceSeconds':cleanup_grace,'command':[node,str(HERE/'benchmark/core-runner.proposed.mjs'),
   '--source',str(ROOT/'source'),'--out',str(out),'--artifact',str(ROOT/'artifacts'/variant),'--knowledge-control']},env,receipt)
  result=load(out/'result.json');assert result['qualification']=='passed'
  assert result['checks']['knowledge']['status']=='passed-operations-only'
 except BaseException as e:
  if isinstance(e,(owner.BuildInterrupted,KeyboardInterrupt,SystemExit)):raise
  error=str(e)
 finally:signal.signal(signal.SIGHUP,old)
 knowledge['variants'][variant]={'status':'passed' if error is None else 'failed','error':error,
  'proof':str(out/'knowledge/result.json'),'coreResult':str(out/'result.json')}
 states=[row['status'] for row in knowledge['variants'].values()]
 knowledge['status']='passed' if all(value=='passed' for value in states) else 'failed' if 'failed' in states else 'incomplete'
 save(work/'knowledge-controls.json',knowledge)
# Refresh the existing fact binder after an optional AOT cell failed on this host.
subprocess.run([sys.executable,'-B',str(HERE/'bind-inputs.py'),'--root-admit'],check=True)
print(json.dumps({'status':'functional-probes-complete','timings':timings,'availableVariants':availability['availableVariants']}))
