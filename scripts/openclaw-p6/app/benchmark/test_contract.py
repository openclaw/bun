import hashlib,json,stat,tempfile,unittest,zipfile
from pathlib import Path
from app_contract import CUT,classify,sha,verify_export

class Contract(unittest.TestCase):
 def fixture(self,base,conclusion='failure',cleanup=None,selection=None):
  head='a'*40;runid=12
  execution={'identity':{'repository':'openclaw/bun','runId':str(runid),'runAttempt':'2','job':'linux-x64-app'},'workflowHead':head,'sourceCommit':CUT}
  rows={'host/execution.json':json.dumps(execution).encode()}
  if cleanup is not None:rows['host/paging-cleanup.json']=json.dumps(cleanup).encode()
  index=[{'path':k,'sha256':hashlib.sha256(v).hexdigest(),'bytes':len(v)} for k,v in rows.items()]
  rows['index.json']=json.dumps(index).encode();rows['summary.json']=json.dumps({'sourceCommit':CUT,'pagingCleanup':cleanup,'unrunRequiredProof':['strict-zero-js'],**(selection or {})}).encode()
  archive=base/'app.zip'
  with zipfile.ZipFile(archive,'w') as z:
   for name,data in rows.items():z.writestr(name,data)
  digest=hashlib.sha256(archive.read_bytes()).hexdigest();size=archive.stat().st_size
  pins={'repository':'openclaw/bun','repositoryId':3,'runId':runid,'runAttempt':2,'workflowId':4,'headSha':head,'artifact':{'id':5,'name':f'p6-linux-x64-app-{head}-attempt2','zipSha256':digest,'zipBytes':size},'maxUnpackedBytes':100000}
  run={'id':runid,'run_attempt':2,'head_sha':head,'workflow_id':4,'path':'.github/workflows/openclaw-build-test.yml','repository':{'id':3,'full_name':'openclaw/bun'},'status':'completed','conclusion':conclusion}
  meta={'id':5,'name':pins['artifact']['name'],'expired':False,'workflow_run':{'id':runid,'head_sha':head,'repository_id':3},'size_in_bytes':size,'digest':'sha256:'+digest}
  return pins,run,meta,archive
 def test_partial_origin_keeps_selection_and_ts_unavailability(self):
  with tempfile.TemporaryDirectory() as d:
   base=Path(d);selection={'variantSelection':'js-c2','requestedVariants':['js','c2-off'],'unselectedVariants':['ts'],'fullVariantMatrixComplete':False}
   p,r,m,z=self.fixture(base,selection=selection)
   verify_export(p,r,m,z,base/'out')
   summary=json.loads((base/'out/summary.json').read_text())
   self.assertEqual(summary['requestedVariants'],['js','c2-off'])
   self.assertFalse(summary['fullVariantMatrixComplete'])
   self.assertEqual(classify(base/'out','ts')['status'],'unavailable')

 def test_failed_completed_run_is_allowed_but_exact_attempt_required(self):
  with tempfile.TemporaryDirectory() as d:
   base=Path(d);p,r,m,z=self.fixture(base)
   self.assertEqual(verify_export(p,r,m,z,base/'good')['runConclusion'],'failure')
   r['run_attempt']=3
   with self.assertRaises(AssertionError):verify_export(p,r,m,z,base/'bad')
 def test_changed_export_fails_native_revalidation(self):
  with tempfile.TemporaryDirectory() as d:
   base=Path(d);p,r,m,z=self.fixture(base);verify_export(p,r,m,z,base/'out')
   (base/'out/host/execution.json').write_text('{}')
   with self.assertRaises(AssertionError):verify_export(p,r,m,z,base/'out',existing=True)
 def test_wrong_zip_digest_is_rejected(self):
  with tempfile.TemporaryDirectory() as d:
   base=Path(d);p,r,m,z=self.fixture(base);p['artifact']['zipSha256']='0'*64
   with self.assertRaises(AssertionError):verify_export(p,r,m,z,base/'out')
 def test_missing_ts_is_unavailable(self):
  with tempfile.TemporaryDirectory() as d:
   value=classify(Path(d),'ts');self.assertEqual(value['status'],'unavailable');self.assertFalse(value['performanceQualified'])
 def test_failed_ts_is_unavailable_with_complete_export(self):
  with tempfile.TemporaryDirectory() as d:
   root=Path(d)
   values={'build-receipts/ts/result.json':{'status':'failed'},'build-receipts/ts/plan.json':{},'admissions/ts.json':{},'qualification-results/ts-core/run/result.json':{'qualification':'failed'},'runtime-results/ts-core/result.json':{'status':'failed'},'preserved/ts/transport.json':{},'preserved/ts/artifact.tar':{}}
   for name,value in values.items():
    p=root/name;p.parent.mkdir(parents=True,exist_ok=True);p.write_text(json.dumps(value))
   self.assertEqual(classify(root,'ts')['status'],'unavailable')
 def test_traversal_rejected_before_extraction(self):
  with tempfile.TemporaryDirectory() as d:
   base=Path(d);p,r,m,z=self.fixture(base)
   with zipfile.ZipFile(z,'a') as archive:archive.writestr('../escape',b'x')
   digest=sha(z);size=z.stat().st_size;p['artifact'].update(zipSha256=digest,zipBytes=size);m.update(digest='sha256:'+digest,size_in_bytes=size)
   with self.assertRaises(AssertionError):verify_export(p,r,m,z,base/'out')
   self.assertFalse((base/'out').exists())
 def test_available_js_does_not_require_ts(self):
  with tempfile.TemporaryDirectory() as d:
   root=Path(d);variant='js';plan={'sourceProof':{'commit':CUT},'variant':variant}
   data={'build-receipts/js/result.json':{'status':'built-unsigned','phase':'complete','plan':plan,'measurement':{'exitCode':0}},'build-receipts/js/plan.json':plan,'admissions/js.json':{},'qualification-results/js-core/run/result.json':{'qualification':'passed'},'preserved/js/transport.json':{},'preserved/js/artifact.tar':{}}
   for name,value in data.items():
    p=root/name;p.parent.mkdir(parents=True,exist_ok=True);p.write_text(json.dumps(value))
   p=root/'runtime-results/js-core/result.json';p.parent.mkdir(parents=True);p.write_text(json.dumps({'status':'phase-passed','sourceCommit':CUT,'actualBuildReceiptSha256':sha(root/'build-receipts/js/result.json'),'rootBuildAdmissionSha256':sha(root/'admissions/js.json')}))
   self.assertEqual(classify(root,'js')['status'],'available-pending-native-restoration')
   self.assertEqual(classify(root,'ts')['status'],'unavailable')
   broken=json.loads(p.read_text());broken['actualBuildReceiptSha256']='0'*64;p.write_text(json.dumps(broken))
   with self.assertRaises(AssertionError):classify(root,'js')
 def test_cancelled_without_cleanup_is_rejected(self):
  with tempfile.TemporaryDirectory() as d:
   base=Path(d);p,r,m,z=self.fixture(base,conclusion='cancelled')
   with self.assertRaises(AssertionError):verify_export(p,r,m,z,base/'out')
 def test_cancelled_with_explicit_absent_resources_is_eligible(self):
  with tempfile.TemporaryDirectory() as d:
   base=Path(d);p,r,m,z=self.fixture(base,conclusion='cancelled',cleanup={'status':'not-activated','resourcesAbsent':True})
   self.assertTrue(verify_export(p,r,m,z,base/'out')['interruptedCleanupRequired'])
 def test_unchanged_export_passes_native_revalidation(self):
  with tempfile.TemporaryDirectory() as d:
   base=Path(d);p,r,m,z=self.fixture(base);expected=verify_export(p,r,m,z,base/'out')
   self.assertEqual(verify_export(p,r,m,z,base/'out',existing=True),expected)
 def test_cleared_summary_failures_are_rejected(self):
  with tempfile.TemporaryDirectory() as d:
   base=Path(d);p,r,m,z=self.fixture(base);verify_export(p,r,m,z,base/'out')
   target=base/'out/summary.json';summary=json.loads(target.read_text());summary['unrunRequiredProof']=[];target.write_text(json.dumps(summary))
   with self.assertRaises(AssertionError):verify_export(p,r,m,z,base/'out',existing=True)
 def test_changed_local_index_is_rejected(self):
  with tempfile.TemporaryDirectory() as d:
   base=Path(d);p,r,m,z=self.fixture(base);verify_export(p,r,m,z,base/'out')
   (base/'out/index.json').write_text('[]')
   with self.assertRaises(AssertionError):verify_export(p,r,m,z,base/'out',existing=True)
if __name__=='__main__':unittest.main()
