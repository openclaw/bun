#!/usr/bin/env python3
"""Bind only observed native files; metadata remains the admission verifier."""
import hashlib,json,sys
from pathlib import Path
assert sys.argv[1:]==['--root-admit'], 'Explicit comparator-owner handoff required'
here=Path(__file__).resolve().parent
p=here/'native-inputs.template.json';x=json.loads(p.read_text());root=Path(x['nativeRoot'])
assert here==root/'benchmark-prep'
def load(p): return json.loads(Path(p).read_text())
def sha(p):
 h=hashlib.sha256()
 with Path(p).open('rb') as f:
  for b in iter(lambda:f.read(1024*1024),b''):h.update(b)
 return h.hexdigest()
for ref in x['receipts'].values(): ref['sha256']=sha(ref['path'])
toolchain=load(x['receipts']['toolchain']['path']);assert toolchain['status']=='PASS'
x['node']=toolchain['buildNode']
producer=here/'package/producer-receipt.json';receipt=load(producer)
assert receipt['status']=='package-owner-passed' and receipt['sourceCommit']==x['sourceCommit']
assert receipt['tarball']==x['tarball']['path']
x['tarball'].update(sha256=sha(receipt['tarball']),bytes=Path(receipt['tarball']).stat().st_size,producerReceipt={'path':str(producer),'sha256':sha(producer)})
assert x['tarball']['sha256']==receipt['sha256'] and x['tarball']['bytes']==receipt['bytes']
x['npm'].update(sha256=sha(x['npm']['path']),manifestSha256=sha(root/'opt/node/lib/node_modules/npm/package.json'))
assert load(root/'opt/node/lib/node_modules/npm/package.json')['version']==x['npm']['version']
availability=load(here/'availability.json')
assert availability['status']=='restored'
x['requestedVariants']=availability['availableVariants']
x['campaignRequestedVariants']=availability['requestedVariants']
x['unavailableVariants']={name:value for name,value in availability['variants'].items() if value['status']=='unavailable'}
x['sourceAppExport']={'path':str(here/'availability.json'),'sha256':sha(here/'availability.json')}
for name,refs in x['variants'].items():
 if name not in x['requestedVariants']:continue
 for key,ref in refs.items():
  if isinstance(ref,dict):ref['sha256']=sha(ref['path'])
 assert load(refs['build']['path'])['status']=='built-unsigned',name
 assert load(refs['core']['path'])['qualification']=='passed',name
 assert load(refs['coreController']['path'])['status']=='phase-passed',name
 refs['enabled']=True
x['decision']='benchmark-linux'
(here/'native-inputs.json').write_text(json.dumps(x,indent=2)+'\n')
print(json.dumps({'status':'bound-pending-metadata-verification','nativeInputsSha256':sha(here/'native-inputs.json')}))
