"""Synthetic identity, approval and safe receipt boundaries; no resource tools."""
import hashlib,importlib.util,json,os,signal,sys,tempfile,types,unittest
from pathlib import Path
from unittest.mock import patch
HERE=Path(__file__).resolve().parent

def load(name,file):
 spec=importlib.util.spec_from_file_location(name,HERE/file);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m
owner=load('paging_owner','swap64.py');operation=load('paging_operation','operation.py');verifier=load('paging_verifier','verify-active.py')
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()

class PagingIdentity(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory(dir=HERE);self.addCleanup(self.tmp.cleanup);self.root=Path(self.tmp.name)
  self.context=patch.object(owner,'ROOT',self.root);self.context.start();self.addCleanup(self.context.stop)
  self.identity={'repository':'openclaw/bun','runId':'12345','runAttempt':'2','job':'linux-x64-app'}
  self.data={'schemaVersion':1,'identity':dict(self.identity),'sourceCommit':'670a7ab33bbd2e3ed4f0a5681e138159d74540a1','workflowHead':'a'*40,'startedEpoch':1}
  self.file=self.root/'execution.json';self.write()
  self.env={'GITHUB_REPOSITORY':'openclaw/bun','GITHUB_RUN_ID':'12345','GITHUB_RUN_ATTEMPT':'2','GITHUB_JOB':'linux-x64-app','GITHUB_SHA':'a'*40}
  context=patch.dict(os.environ,self.env,clear=True);context.start();self.addCleanup(context.stop)
 def write(self):self.file.write_text(json.dumps(self.data));return sha(self.file)
 def bind(self):return owner.bind_identity(self.file,sha(self.file))
 def approval(self):
  data={'schemaVersion':1,'lane':'P6','decision':'activate-task-encrypted-swap','identity':self.identity,'executionSha256':sha(self.file),'sourceCommit':'670a7ab33bbd2e3ed4f0a5681e138159d74540a1','nativeRoot':str(self.root),'swapBytes':68719476736,'cipher':'aes-cbc-essiv:sha256','keyBytes':32,'preserveExistingSwap':True,'preserveVmSettings':True,'buildHeadroomBytes':34359738368,'scriptSha256':sha(HERE/'swap64.py')}
  p=self.root/'approval.json';p.write_text(json.dumps(data));return p,data
 def test_exact_run_binding_is_read_only_and_attempt_scoped(self):
  self.bind();self.assertEqual(owner.AREA,self.root/'ephemeral-swap64/actions-12345-2');self.assertEqual(owner.NAME,'p6-aot-swap64-12345-2');self.assertFalse(owner.AREA.exists())
  self.data['identity']['runAttempt']='3';os.environ['GITHUB_RUN_ATTEMPT']='3';self.write();self.bind();self.assertEqual(owner.NAME,'p6-aot-swap64-12345-3');self.assertNotIn('lease',self.data)
 def test_each_actual_github_identity_field_is_required(self):
  for key in self.env:
   with self.subTest(key=key),patch.dict(os.environ,{key:'other'}),self.assertRaises(ValueError):self.bind()
 def test_wrong_hash_source_schema_or_identity_rejected(self):
  with self.assertRaisesRegex(ValueError,'hash'):owner.bind_identity(self.file,'0'*64)
  for field,value in [('sourceCommit','b'*40),('schemaVersion',True),('identity',{**self.identity,'runAttempt':'0'}),('identity',{**self.identity,'runId':12345}),('identity',{**self.identity,'job':'other'}),('identity',{**self.identity,'repository':'other/repo'}),('identity',{**self.identity,'lease':'fake'})]:
   with self.subTest(field=field,value=value):
    before=self.data[field];self.data[field]=value;self.write()
    with self.assertRaises(ValueError):self.bind()
    self.data[field]=before;self.write()
 def test_approval_binds_exact_identity_document_and_owner_bytes(self):
  self.bind();p,data=self.approval();owner.approval(p,sha(p))
  for key,value in [('identity',{**self.identity,'runAttempt':'1'}),('executionSha256','0'*64),('scriptSha256','0'*64),('cipher','aes-xts-plain64'),('preserveExistingSwap',False)]:
   with self.subTest(key=key):
    changed={**data,key:value};p.write_text(json.dumps(changed))
    with self.assertRaisesRegex(ValueError,'Explicit root approval'):owner.approval(p,sha(p))
 def test_activation_verifier_rejects_receipt_from_another_attempt(self):
  self.bind();record={'operationExitCode':0,'action':'activate','interruptedBySignal':None,'failure':None,'scriptSha256':'s','approvalSha256':'a','metadata':{'statePresent':True,'phase':'active','identity':self.identity,'executionSha256':sha(self.file),'sourceCommit':owner.SOURCE,'cipher':'aes-cbc-essiv:sha256','keyBytes':32,'swapBytes':68719476736,'backing':str(owner.BACKING),'mappingName':owner.NAME,'approvalSha256':'a','errorPresent':False,'cleanupErrorPresent':False}}
  verifier.activation(record,owner,'a','s');record['metadata']['identity']={**self.identity,'runAttempt':'1'}
  with self.assertRaisesRegex(ValueError,'identity/status'):verifier.activation(record,owner,'a','s')
 def test_wrapper_cancellation_waits_for_owner_and_preserves_safe_receipt(self):
  self.bind();proof=self.root/'safe/result.json';calls=[]
  class Child:
   returncode=None
   def communicate(child):
    calls.append('communicate')
    if len(calls)==1:signal.getsignal(signal.SIGTERM)(signal.SIGTERM,None)
    child.returncode=143;return b'raw synthetic output must remain private',b'private stderr'
   def poll(child):return child.returncode
   def send_signal(child,sig):calls.append(('forward',sig))
  argv=['operation.py','activate','--owner',str(self.root/'swap64.py'),'--approval',str(self.root/'approval.json'),'--approval-sha256','a','--identity',str(self.file),'--identity-sha256',sha(self.file),'--receipt',str(proof),'--execute','--owner-idle-confirmed']
  with patch.object(sys,'argv',argv),patch.object(operation,'load_owner',return_value=(owner,{'scriptSha256':'s'})),patch.object(operation.subprocess,'Popen',return_value=Child()),patch.object(operation,'collect',return_value={'statePresent':True,'phase':'cleanup-blocked'}):code=operation.main()
  self.assertEqual(code,143);self.assertEqual(calls,['communicate',('forward',signal.SIGTERM),'communicate'])
  receipt=json.loads(proof.read_text());self.assertEqual(receipt['interruptedBySignal'],signal.SIGTERM);self.assertEqual(receipt['operationExitCode'],143);self.assertNotIn('raw synthetic output',proof.read_text());self.assertNotIn('private stderr',proof.read_text())
 def test_collector_never_exports_commands_stdout_or_unknown_private_fields(self):
  self.bind();owner.AREA.mkdir(parents=True)
  secret='SYNTHETIC-DO-NOT-EXPORT';state={'phase':'active','identity':{**self.identity,'private':secret},'executionSha256':sha(self.file),'sourceCommit':owner.SOURCE,'keyMaterial':secret,'commands':[{'argv':['/usr/sbin/cryptsetup','--key',secret],'stdout':secret,'stderr':secret,'exitCode':0,'terminal':True}]}
  owner.STATE.write_text(json.dumps(state))
  with patch.object(owner,'settings',return_value={'swappiness':'1','overcommit_memory':'0','overcommit_ratio':'50'}),patch.object(owner,'swaps',return_value=[]):result=operation.collect(owner)
  encoded=json.dumps(result);self.assertNotIn(secret,encoded);self.assertEqual(result['identity'],self.identity);self.assertEqual(result['steps'],[{'program':'cryptsetup','exitCode':0,'terminal':True}])

if __name__=='__main__':unittest.main()
