#!/usr/bin/env python3
"""Run the exact approved paging owner and publish only allowlisted metadata."""
import argparse,hashlib,importlib.util,json,os,signal,stat,subprocess,sys
from pathlib import Path

def digest(path):return hashlib.sha256(path.read_bytes()).hexdigest()
def need(ok,message):
 if not ok:raise ValueError(message)

def load_owner(path,approval,approval_sha,identity,identity_sha):
 need(digest(approval)==approval_sha,'Approval hash differs')
 approved=json.loads(approval.read_text());need(digest(path)==approved['scriptSha256'],'Approved owner bytes differ')
 need(approval.resolve()==path.resolve().parent/'approval.json','Sibling approval required')
 spec=importlib.util.spec_from_file_location('p6_actions_paging_owner',path);owner=importlib.util.module_from_spec(spec)
 sys.dont_write_bytecode=True;spec.loader.exec_module(owner)
 owner.bind_identity(identity,identity_sha)
 need(path.resolve()==owner.owner_path(),'Execution-specific owner required')
 owner.approval(approval,approval_sha)
 return owner,approved

def collect(owner):
 result={'statePresent':owner.STATE.is_file(),'resourceOperationPerformedByCollector':False}
 if not result['statePresent']:
  result['phase']='pre-state';return result
 data=json.loads(owner.STATE.read_text())
 keys=['schemaVersion','executionSha256','sourceCommit','approvalSha256','phase','backing','mappingName','cipher','keyBytes','swapBytes','loop','loopDevice','mapperDevice','baselineSwapFileId','appRun']
 for key in keys:
  if key in data:result[key]=data[key]
 if 'identity' in data:result['identity']={k:data['identity'][k] for k in ['repository','runId','runAttempt','job']}
 for key,fields in [('backingIdentity',['dev','ino','size']),('baselineSettings',['swappiness','overcommit_memory','overcommit_ratio'])]:
  if key in data:result[key]={f:data[key][f] for f in fields if f in data[key]}
 fields=['path','type','sizeKiB','usedKiB','priority']
 for key in ['baselineSwap','mappedSwap']:
  if key in data:result[key]={f:data[key][f] for f in fields if f in data[key]}
 result['steps']=[{'program':Path(row.get('argv',['unknown'])[0]).name,'exitCode':row.get('exitCode'),'terminal':row.get('terminal')} for row in data.get('commands',[])]
 result['errorPresent']=bool(data.get('error'));result['cleanupErrorPresent']=bool(data.get('cleanupError'))
 for key in ['error','cleanupError']:
  if data.get(key):result[key]=str(data[key])[:1024]
 result['currentSettings']=owner.settings()
 rows=[];other=0
 for row in owner.swaps():
  owned=False
  try:
   info=Path(row['path']).stat();owned=stat.S_ISBLK(info.st_mode) and [os.major(info.st_rdev),os.minor(info.st_rdev)]==data.get('mapperDevice')
  except OSError:pass
  if row['path']=='/swapfile' or owned:rows.append({k:row[k] for k in fields})
  else:other+=1
 result['currentKnownSwaps']=rows;result['otherSwapCount']=other
 return result

def main():
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('action',choices=['activate','cleanup'])
 for name in ['owner','approval','identity','receipt']:p.add_argument('--'+name,type=Path,required=True)
 for name in ['approval-sha256','identity-sha256']:p.add_argument('--'+name,required=True)
 for name in ['execute','owner-idle-confirmed','workload-stopped-confirmed']:p.add_argument('--'+name,action='store_true')
 a=p.parse_args();owner,approved=load_owner(a.owner,a.approval,a.approval_sha256,a.identity,a.identity_sha256)
 if not a.execute:
  print(json.dumps({'status':'plan-only','action':a.action,'identity':owner.IDENTITY,'resourceMutation':False}));return 0
 need(not a.receipt.exists(),'Fresh sanitized receipt required')
 command=[sys.executable,'-B',str(a.owner),a.action,'--execute','--approval',str(a.approval),'--approval-sha256',a.approval_sha256,'--identity',str(a.identity),'--identity-sha256',a.identity_sha256]
 if a.owner_idle_confirmed:command+=['--owner-idle-confirmed']
 if a.workload_stopped_confirmed:command+=['--workload-stopped-confirmed']
 env={'PATH':'/usr/sbin:/usr/bin:/sbin:/bin','LC_ALL':'C','LANG':'C','HOME':str(a.owner.parent)}
 for key in ['GITHUB_REPOSITORY','GITHUB_RUN_ID','GITHUB_RUN_ATTEMPT','GITHUB_JOB','GITHUB_SHA']:env[key]=os.environ[key]
 class Cancelled(Exception):pass
 cancelled=[]
 def interrupt(signum,frame):cancelled.append(signum);raise Cancelled()
 previous={sig:signal.signal(sig,interrupt) for sig in [signal.SIGINT,signal.SIGTERM,signal.SIGHUP]}
 child=None
 try:
  child=subprocess.Popen(command,stdout=subprocess.PIPE,stderr=subprocess.PIPE,env=env)
  try:stdout,stderr=child.communicate()
  except Cancelled:
   for sig in previous:signal.signal(sig,signal.SIG_IGN)
   if child.poll() is None:child.send_signal(cancelled[0])
   # The owner drains its command groups and reconciles resources before exit.
   stdout,stderr=child.communicate()
  for sig in previous:signal.signal(sig,signal.SIG_IGN)
  failures=[json.loads(line[len('P6_SWAP_FAILURE '):]) for line in stdout.decode('utf8','replace').splitlines() if line.startswith('P6_SWAP_FAILURE ')]
  failure=failures[-1] if failures else None
  if failure:failure={k:failure[k] for k in ['stage','errorType','error'] if k in failure}
  record={'failure':failure,'operationExitCode':child.returncode,'action':a.action,'interruptedBySignal':cancelled[0] if cancelled else None,'scriptSha256':approved['scriptSha256'],'approvalSha256':a.approval_sha256,'identity':owner.IDENTITY,'executionSha256':owner.EXECUTION_SHA256,'metadata':collect(owner),'applicationRun':False}
  if child.returncode and not record['metadata'].get('statePresent'):record['failureStage']='pre-state-admission-or-preflight'
  encoded=(json.dumps(record,indent=2)+'\n').encode();need(len(encoded)<=65536,'Sanitized metadata exceeds limit; private state retained')
  a.receipt.parent.mkdir(parents=True,exist_ok=True)
  with a.receipt.open('xb') as f:f.write(encoded)
  a.receipt.chmod(0o644)
  print('P6_ENCRYPTED_SWAP_RECEIPT '+json.dumps({'result':str(a.receipt),'sha256':hashlib.sha256(encoded).hexdigest(),'operationExitCode':child.returncode}),flush=True)
  return child.returncode or (128+cancelled[0] if cancelled else 0)
 finally:
  for sig,handler in previous.items():signal.signal(sig,handler)
if __name__=='__main__':raise SystemExit(main())
