#!/usr/bin/env python3
"""Untimed synthetic backup qualification using the existing CLI owner."""
import hashlib,importlib.util,json,os,signal,subprocess,sys
from pathlib import Path
HERE=Path(__file__).resolve().parent
ROOT=Path('/home/runner/.cache/oc-ty-ext/P6/app-x64-final-r3-v1')
assert HERE==ROOT/'benchmark-prep';os.umask(0o077)
def load(p):return json.loads(Path(p).read_text())
def sha(p):
 with Path(p).open('rb') as f:return hashlib.file_digest(f,'sha256').hexdigest()
x=load(HERE/'native-inputs.json');contract=load(HERE/'backup/source-contract.json')
assert contract['sourceCommit']==x['sourceCommit']
for name,digest in contract['files'].items():assert sha(ROOT/'source'/name)==digest,name
assert sha(HERE/'harness/measurement-owner.py')==x['ownerFiles']['harness/measurement-owner.py']
spec=importlib.util.spec_from_file_location('p6_measurement_owner',HERE/'harness/measurement-owner.py');owner=importlib.util.module_from_spec(spec);spec.loader.exec_module(owner)
assert sha(ROOT/'measure-command.py')==owner.MEASURE_SHA
subprocess.run([x['node']['path'],str(HERE/'metadata.mjs'),'verify'],check=True)
entry=ROOT/'source/openclaw.mjs';stamp=load(entry.parent/'dist/.buildstamp')
assert stamp['head']==x['sourceCommit'] and stamp['inputsClean'] is True
out=ROOT/'backup-results';out.mkdir()
controls=[('node','jit-node',Path(x['node']['path']),True),('bun-jit','jit-bun',ROOT/'compilers/standard/bun',True)]
cells=controls+[(v,'aot',ROOT/'artifacts'/v/'openclaw',False) for v in x['requestedVariants']]
results=[]
for label,mode,binary,is_control in cells:
 receipt=out/(label+'-controller');receipt.mkdir();cell=out/label
 args=[sys.executable,'-B',str(HERE/'backup/run.py'),'--task-root',str(ROOT),'--out',str(cell),'--mode',mode,'--runtime',str(binary),'--runtime-sha256',sha(binary)]
 if is_control:args+=['--entry',str(entry),'--entry-sha256',sha(entry)]
 error=None;old=signal.signal(signal.SIGHUP,owner.interrupted)
 try:
  owner.measure({'measurementUtility':str(ROOT/'measure-command.py'),'variant':'backup-'+label,'source':str(ROOT/'source'),'timeoutSeconds':300,'command':args},{'PATH':'/usr/bin:/bin','HOME':str(HERE/'work/home'),'TMPDIR':str(HERE/'work/tmp'),'LANG':'C.UTF-8','TZ':'UTC'},receipt)
 except BaseException as e:
  if isinstance(e,(owner.BuildInterrupted,KeyboardInterrupt,SystemExit)):raise
  error=str(e)
 finally:signal.signal(signal.SIGHUP,old)
 proof=load(cell/'result.json') if (cell/'result.json').exists() else None
 passed=error is None and proof is not None and proof.get('pass') is True
 results.append({'cell':label,'mode':mode,'status':'passed' if passed else 'failed','error':error,'resultPath':str(cell/'result.json') if proof else None,'resultSha256':sha(cell/'result.json') if proof else None,'performanceEligible':False})
 summary={'status':'passed' if all(r['status']=='passed' for r in results) else 'failed','sourceCommit':x['sourceCommit'],'cells':results,'unavailableVariants':x['unavailableVariants'],'performanceEligible':False,'applicationQualified':False,'scope':'Untimed real backup create/verify CLI with synthetic plugin-managed SQLite archive'}
 (out/'summary.json').write_text(json.dumps(summary,indent=2)+'\n')
print(json.dumps(summary));raise SystemExit(0 if summary['status']=='passed' else 1)
