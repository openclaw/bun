#!/usr/bin/env python3
"""Restore only successful individual app cells from one exact exported run."""
import argparse,json,os,platform,shutil,subprocess,sys
from pathlib import Path
from app_contract import CUT,ROOT,VARIANTS,classify,dump,load,sha,verify_export
HERE=Path(__file__).resolve().parent

def main():
 p=argparse.ArgumentParser();p.add_argument('--download',type=Path,required=True);a=p.parse_args()
 assert platform.system()=='Linux' and platform.machine()=='x86_64';os.umask(0o077)
 d=a.download;imported=d/'export'
 verified=verify_export(load(d/'pins.json'),load(d/'run.json'),load(d/'artifact.json'),d/'app.zip',imported,existing=True)
 assert load(d/'verification.json')==verified
 assert load(ROOT/'prep-receipts/plugins/result.json')['status']=='PASS'
 assert load(imported/'admission-inputs/compiler-records.json')==load(ROOT/'admission-inputs/compiler-records.json')
 assert load(imported/'admission-inputs/plugins/desktop.json')==load(ROOT/'admission-inputs/plugins/desktop.json')
 helper=ROOT/'preserve.py';assert sha(helper)==sha(HERE/'preserve.py')
 records={};base=ROOT/'restored-app';base.mkdir()
 for variant in VARIANTS:
  entry=classify(imported,variant);records[variant]=entry
  if entry['status']=='unavailable':continue
  paths={k:Path(v) for k,v in entry['paths'].items()};transport=load(paths['transport'])
  assert transport['sourceCommit']==CUT and transport['nativePlanSha256']==sha(paths['plan']) and transport['nativeResultSha256']==sha(paths['build'])
  output=base/variant
  command=[sys.executable,'-B',str(helper),'verify','--archive',str(paths['archive']),'--archive-sha256',transport['archiveSha256'],'--transport',str(paths['transport']),'--transport-sha256',sha(paths['transport']),'--source',str(ROOT/'source'),'--checker',str(ROOT/'build-prep/artifact-contract.mjs'),'--node',str(ROOT/'opt/node/bin/node'),'--out',str(output)]
  subprocess.run(command,check=True,timeout=1800)
  (ROOT/'artifacts').mkdir(exist_ok=True);assert not (ROOT/'artifacts'/variant).exists()
  (output/'artifact').rename(ROOT/'artifacts'/variant)
  for key,relative in [('admission',f'admissions/{variant}.json'),('plan',f'build-receipts/{variant}/plan.json'),('build',f'build-receipts/{variant}/result.json'),('core',f'qualification-results/{variant}-core/run/result.json'),('controller',f'runtime-results/{variant}-core/result.json'),('transport',f'preserved/{variant}/transport.json')]:
   dest=ROOT/relative;dest.parent.mkdir(parents=True,exist_ok=True);assert not dest.exists();shutil.copyfile(paths[key],dest)
  entry.update(status='artifact-restored-original-core-qualified',restorationReceipt=str(output/'verification.json'),restorationReceiptSha256=sha(output/'verification.json'))
 available=[v for v in VARIANTS if records[v]['status']=='artifact-restored-original-core-qualified']
 result={'status':'restored' if 'js' in available else 'no-js-aot-baseline','sourceCommit':CUT,'sourceAppExport':verified,'sourceQualificationSummary':load(imported/'summary.json'),'requestedVariants':list(VARIANTS),'availableVariants':available,'variants':records,'performanceQualified':False}
 dump(ROOT/'benchmark-prep/availability.json',result)
 print(json.dumps(result))
 if 'js' not in available:raise SystemExit(78)
if __name__=='__main__':main()
