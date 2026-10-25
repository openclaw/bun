#!/usr/bin/env python3
"""Build only the existing bare E2E base plus unchanged AOT installation adapter."""
import json,signal,subprocess,sys
from pathlib import Path

proof=json.loads(Path(sys.argv[1]).read_text())
assert proof['lane']=='docker-image' and proof['status']=='planned-not-qualified'
out=Path(proof['out']);source=Path(proof['source']);harness=Path(proof['harness'])
base='openclaw-p6-final-x64-e2e-bare:'+proof['sourceCommit'][:12]
tag='openclaw-p6-final-x64-aot:'+proof['binarySha256'][:16]+'-'+proof['manifestSha256'][:8]
report={'status':'FAIL','sourceCommit':proof['sourceCommit'],'binarySha256':proof['binarySha256'],'manifestSha256':proof['manifestSha256'],'tag':tag,'baseTag':base,'applicationQualified':False,'scope':'Docker image construction only; no E2E pass','commands':[]}
class Cancelled(Exception):pass
def interrupted(signum,frame):raise Cancelled(f'Interrupted by signal {signum}')
handlers={sig:signal.signal(sig,interrupted) for sig in [signal.SIGINT,signal.SIGTERM,signal.SIGHUP]}
try:
 host=subprocess.check_output(['docker','info','--format','{{.OSType}} {{.Architecture}}'],text=True).strip()
 assert host in ['linux amd64','linux x86_64'],'Native Linux x64 Docker required'
 report['dockerHost']=host
 commands=[['docker','build','--platform','linux/amd64','--target','bare','-f',str(source/'scripts/e2e/Dockerfile'),'-t',base,str(source)],
           ['docker','build','--platform','linux/amd64','--build-context','aot_artifact='+proof['artifact'],'--build-context','test_source='+str(source),'--build-arg','P6_E2E_BASE='+base,'-f',str(harness/'Dockerfile.aot'),'-t',tag,str(harness)]]
 for i,command in enumerate(commands):
  report['commands'].append(command)
  with (out/f'build-{i}.stdout').open('x') as stdout,(out/f'build-{i}.stderr').open('x') as stderr:
   run=subprocess.run(command,stdout=stdout,stderr=stderr,timeout=3600)
  if run.returncode:raise RuntimeError(f'Docker build {i} failed with {run.returncode}')
 report['baseImageId']=subprocess.check_output(['docker','image','inspect','--format','{{.Id}}',base],text=True).strip()
 report['imageId']=subprocess.check_output(['docker','image','inspect','--format','{{.Id}}',tag],text=True).strip()
 report['status']='PASS'
except Exception as error:report['error']=f'{type(error).__name__}: {error}'
finally:
 (out/'result.json').write_text(json.dumps(report,indent=2)+'\n')
 for sig,handler in handlers.items():signal.signal(sig,handler)
print(json.dumps(report),flush=True)
raise SystemExit(0 if report['status']=='PASS' else 1)
