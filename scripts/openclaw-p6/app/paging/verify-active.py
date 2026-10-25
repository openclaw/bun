#!/usr/bin/env python3
"""Query frozen swap ownership; never change resource configuration."""
import argparse,hashlib,importlib.util,json,os,platform,resource,signal
from pathlib import Path

def sha(data):return hashlib.sha256(data).hexdigest()
def need(value,message):
 if not value:raise ValueError(message)

def activation(record,owner,approval_sha,owner_sha):
 need(record.get('operationExitCode')==0 and record.get('action')=='activate' and record.get('interruptedBySignal') is None and record.get('failure') is None,'Completed activation receipt required')
 need(record.get('scriptSha256')==owner_sha and record.get('approvalSha256')==approval_sha,'Activation helper/approval differs')
 metadata=record['metadata']
 expected={'statePresent':True,'phase':'active','identity':owner.IDENTITY,'executionSha256':owner.EXECUTION_SHA256,'sourceCommit':owner.SOURCE,'cipher':owner.CIPHER,'keyBytes':32,'swapBytes':owner.SIZE,'backing':str(owner.BACKING),'mappingName':owner.NAME,'approvalSha256':approval_sha,'errorPresent':False,'cleanupErrorPresent':False}
 need(all(metadata.get(k)==v for k,v in expected.items()),'Activation identity/status differs')
 return metadata

def main():
 p=argparse.ArgumentParser(description=__doc__)
 for flag in ['owner','activation-receipt','approval','identity']:p.add_argument('--'+flag,type=Path,required=True)
 for flag in ['activation-receipt-sha256','approval-sha256','identity-sha256']:p.add_argument('--'+flag,required=True)
 a=p.parse_args()
 result={'schemaVersion':1,'status':'verification-failed','verifierSha256':sha(Path(__file__).read_bytes()),'nativeScript':str(a.owner),'nativeApproval':str(a.approval),'activationReceiptSha256':a.activation_receipt_sha256,'approvalSha256':a.approval_sha256,'resourceMutation':False,'metadataLedgerUpdated':False,'applicationRun':False}
 owner=None;before=None
 try:
  need(platform.system()=='Linux' and platform.machine()=='x86_64' and os.geteuid()==0,'Native privileged x64 verification only')
  need(sha(a.approval.read_bytes())==a.approval_sha256,'Approval hash differs')
  approval=json.loads(a.approval.read_text());owner_sha=approval['scriptSha256']
  need(sha(a.owner.read_bytes())==owner_sha,'Approved owner bytes differ')
  need(a.approval.resolve()==a.owner.resolve().parent/'approval.json','Sibling approval required')
  result['scriptSha256']=owner_sha
  raw=a.activation_receipt.read_bytes();need(sha(raw)==a.activation_receipt_sha256,'Activation receipt hash differs')
  record=json.loads(raw)
  spec=importlib.util.spec_from_file_location('p6_frozen_swap64_owner',a.owner);owner=importlib.util.module_from_spec(spec);spec.loader.exec_module(owner)
  owner.bind_identity(a.identity,a.identity_sha256)
  need(a.owner.resolve()==owner.owner_path(),'Execution-specific owner required')
  owner.approval(a.approval,a.approval_sha256)
  metadata=activation(record,owner,a.approval_sha256,owner_sha)
  resource.setrlimit(resource.RLIMIT_CORE,(0,0))
  def cancel(signum,frame):raise owner.OwnerCancelled('Verification interrupted with signal '+str(signum))
  for sig in [signal.SIGINT,signal.SIGTERM,signal.SIGHUP]:signal.signal(sig,cancel)
  raw=owner.STATE.read_bytes();before=sha(raw);state=json.loads(raw)
  keys=['identity','executionSha256','sourceCommit','approvalSha256','phase','backing','backingIdentity','loop','loopDevice','mapperDevice','mappingName','cipher','keyBytes','swapBytes','baselineSettings','baselineSwapFileId','baselineSwap']
  need(all(state.get(k)==metadata.get(k) for k in keys),'Live owner state differs from activation identity')
  need(state['phase']=='active','Owned swap is not active')
  loop=owner.owned_loop(state)
  owner.need(loop.get('dio') in [True,1,'1','true'],'Owned direct I/O is no longer active')
  dev=owner.mapping(state)
  status=owner.check_status(owner.run(state,['/usr/sbin/cryptsetup','status',owner.NAME]))
  owner.need(status.get('device')==state['loop'],'Live cipher is over a different loop')
  owner.need(owner.file_id(owner.BACKING)['size']==owner.SIZE,'Owned backing is not64GiB')
  owner.need(int((Path('/sys/dev/block')/('%d:%d'%tuple(dev))/'size').read_text())*512==owner.SIZE,'Live mapped size differs')
  current=owner.active_inventory(state)
  identity={k:state[k] for k in ['backing','backingIdentity','loop','loopDevice','mapperDevice','mappingName','cipher','keyBytes','swapBytes','baselineSettings','baselineSwapFileId']}
  identity.update(directIo=True,currentSwap=current,cipherType=status['type'],keysize=status['keysize'])
  result.update(status='verified-active',executionIdentity=owner.IDENTITY,executionSha256=owner.EXECUTION_SHA256,sourceCommit=owner.SOURCE,activationSnapshotMatched=True,identity=identity)
 except Exception as error:result.update(errorType=type(error).__name__,error=str(error)[:1024])
 finally:
  for sig in [signal.SIGINT,signal.SIGTERM,signal.SIGHUP]:signal.signal(sig,signal.SIG_IGN)
  if before is not None:
   result['stateBeforeSha256']=before
   if owner.STATE.is_file():
    result['stateAfterSha256']=sha(owner.STATE.read_bytes());result['metadataLedgerUpdated']=before!=result['stateAfterSha256']
 print(json.dumps(result,indent=2),flush=True)
 return 0 if result['status']=='verified-active' else 1

if __name__=='__main__':raise SystemExit(main())
