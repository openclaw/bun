"""Exact completed app-run transport contract; contains no network or app execution."""
import hashlib,json,stat,zipfile
from pathlib import Path,PurePosixPath
CUT='4fa442e332745f1f58ccedd27106abdafcf4e019'
ROOT=Path('/home/runner/.cache/oc-ty-ext/P6/app-x64-final-r4-v1')
VARIANTS=('js','c2-off','ts')
def load(p):return json.loads(Path(p).read_text())
def sha(p):
 with Path(p).open('rb') as f:return hashlib.file_digest(f,'sha256').hexdigest()
def dump(p,x):
 with Path(p).open('x') as f:json.dump(x,f,indent=2);f.write('\n')
def pins_ok(p):
 assert p['repository']=='openclaw/bun'
 for k in ['repositoryId','runId','runAttempt','workflowId']:assert type(p[k]) is int and p[k]>0,k
 assert len(p['headSha'])==40 and all(c in '0123456789abcdef' for c in p['headSha'])
 a=p['artifact'];assert type(a['id']) is int and a['id']>0
 assert a['name']==f"p6-linux-x64-app-{p['headSha']}-attempt{p['runAttempt']}"
 assert type(a['zipBytes']) is int and a['zipBytes']>0
 assert len(a['zipSha256'])==64 and all(c in '0123456789abcdef' for c in a['zipSha256'])
 assert type(p['maxUnpackedBytes']) is int and 0<p['maxUnpackedBytes']<=64*1024**3

def verify_export(pins,run,metadata,archive,out,*,existing=False):
 pins_ok(pins);a=pins['artifact']
 assert run['id']==pins['runId'] and run['run_attempt']==pins['runAttempt'] and run['head_sha']==pins['headSha']
 assert run['workflow_id']==pins['workflowId'] and run['path']=='.github/workflows/openclaw-build-test.yml'
 assert run['repository']['id']==pins['repositoryId'] and run['repository']['full_name']==pins['repository']
 assert run['status']=='completed' and run['conclusion'] in ['success','failure','cancelled','timed_out'],'Only completed success/failure or explicitly reconciled interrupted runs are eligible'
 assert metadata['id']==a['id'] and metadata['name']==a['name'] and not metadata['expired']
 assert metadata['workflow_run']['id']==pins['runId'] and metadata['workflow_run']['head_sha']==pins['headSha']
 assert metadata['workflow_run']['repository_id']==pins['repositoryId']
 assert metadata['size_in_bytes']==a['zipBytes'] and metadata['digest']=='sha256:'+a['zipSha256']
 assert Path(archive).stat().st_size==a['zipBytes'] and sha(archive)==a['zipSha256']
 out=Path(out);assert out.is_dir() if existing else not out.exists()
 with zipfile.ZipFile(archive) as z:
  rows=z.infolist();assert len(rows)<=10000
  names=set();size=0
  for m in rows:
   n=PurePosixPath(m.filename);assert n.parts and not n.is_absolute() and '..' not in n.parts and '\\' not in m.filename
   assert str(n)==m.filename.rstrip('/') and '\x00' not in m.filename
   assert m.filename not in names;names.add(m.filename)
   mode=m.external_attr>>16;assert not stat.S_ISLNK(mode) and (m.is_dir() or stat.S_IFMT(mode) in (0,stat.S_IFREG))
   size+=m.file_size
  assert size<=pins['maxUnpackedBytes']
  files={m.filename for m in rows if not m.is_dir()}
  assert {'index.json','summary.json','host/execution.json'}<=files
  assert z.getinfo('index.json').file_size<=16*1024**2 and z.getinfo('summary.json').file_size<=16*1024**2 and z.getinfo('host/execution.json').file_size<=1024**2
  index=json.loads(z.read('index.json'));assert isinstance(index,list)
  indexed={r['path'] for r in index};assert len(indexed)==len(index)
  assert files==indexed|{'index.json','summary.json'}
  if existing:
   for name in ['index.json','summary.json']:
    target=out/name
    assert target.is_file() and not target.is_symlink() and target.read_bytes()==z.read(name),name
  for row in index:
   with z.open(row['path']) as stream: digest=hashlib.file_digest(stream,'sha256').hexdigest()
   assert z.getinfo(row['path']).file_size==row['bytes'] and digest==row['sha256'],row['path']
   if existing:
    target=out/row['path'];assert target.is_file() and not target.is_symlink() and target.stat().st_size==row['bytes'] and sha(target)==digest,row['path']
  execution=json.loads(z.read('host/execution.json'));identity=execution['identity']
  assert identity=={'repository':pins['repository'],'runId':str(pins['runId']),'runAttempt':str(pins['runAttempt']),'job':'linux-x64-app'}
  assert execution['workflowHead']==pins['headSha'] and execution['sourceCommit']==CUT
  summary=json.loads(z.read('summary.json'));assert summary['sourceCommit']==CUT
  if run['conclusion'] in ['cancelled','timed_out']:
   assert 'host/paging-cleanup.json' in indexed,'Interrupted run requires explicit exported cleanup proof'
   cleanup=json.loads(z.read('host/paging-cleanup.json'))
   assert cleanup==summary['pagingCleanup'],'Interrupted cleanup summary differs from the indexed receipt'
   if cleanup.get('status')=='not-activated':
    assert cleanup.get('resourcesAbsent') is True
   else:
    assert cleanup['action']=='cleanup' and cleanup['operationExitCode']==0 and cleanup.get('interruptedBySignal') is None
    assert cleanup['identity']==identity and cleanup['executionSha256']==hashlib.sha256(z.read('host/execution.json')).hexdigest()
    assert cleanup['metadata']['phase']=='cleaned' and cleanup['metadata']['sourceCommit']==CUT
    assert not cleanup['metadata'].get('cleanupErrorPresent')

  if not existing:out.mkdir(parents=True);z.extractall(out)
 return {'status':'exact-completed-app-export-verified','sourceCommit':CUT,'runId':pins['runId'],'runAttempt':pins['runAttempt'],'workflowHead':pins['headSha'],'artifactId':a['id'],'artifactZipSha256':a['zipSha256'],'fileCount':len(files),'unpackedBytes':size,'runConclusion':run['conclusion'],'interruptedCleanupRequired':run['conclusion'] in ['cancelled','timed_out']}

def classify(export,variant):
 export=Path(export)
 paths={'build':export/f'build-receipts/{variant}/result.json','plan':export/f'build-receipts/{variant}/plan.json','admission':export/f'admissions/{variant}.json','core':export/f'qualification-results/{variant}-core/run/result.json','controller':export/f'runtime-results/{variant}-core/result.json','transport':export/f'preserved/{variant}/transport.json','archive':export/f'preserved/{variant}/artifact.tar'}
 missing=[k for k,p in paths.items() if not p.is_file()]
 if missing:return {'status':'unavailable','reason':'missing exported '+','.join(missing),'performanceQualified':False}
 b=load(paths['build']);c=load(paths['core']);controller=load(paths['controller'])
 if b.get('status')!='built-unsigned' or b.get('phase')!='complete':return {'status':'unavailable','reason':'app build did not complete successfully','buildStatus':b.get('status'),'performanceQualified':False}
 if c.get('qualification')!='passed' or controller.get('status')!='phase-passed':return {'status':'unavailable','reason':'original core qualification did not pass','coreStatus':c.get('qualification'),'controllerStatus':controller.get('status'),'performanceQualified':False}
 assert load(paths['plan'])==b['plan'] and b['plan']['sourceProof']['commit']==CUT
 assert b['plan']['variant']==('c2' if variant=='c2-off' else variant)
 assert b['measurement']['exitCode']==0 and controller['sourceCommit']==CUT
 assert controller['actualBuildReceiptSha256']==sha(paths['build'])
 assert controller['rootBuildAdmissionSha256']==sha(paths['admission'])
 return {'status':'available-pending-native-restoration','paths':{k:str(p) for k,p in paths.items()},'performanceQualified':False}
