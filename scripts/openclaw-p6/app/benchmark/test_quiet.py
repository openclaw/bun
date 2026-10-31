"""Pure synthetic host snapshots and receipt boundaries; no Docker/proc workload."""
import contextlib,copy,hashlib,importlib.util,io,json,os,sys,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
HERE=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('quiet',HERE/'quiet.py');g=importlib.util.module_from_spec(spec);spec.loader.exec_module(g)
BOOT='11111111-2222-3333-4444-555555555555'
IDENTITY={'repository':'openclaw/bun','runId':'21','runAttempt':'1','job':'linux-x64-benchmark'}
def row(pid,ppid,exe,args=None,cwd='/',state='S'):
 return {'pid':pid,'ppid':ppid,'exe':exe,'args':args or [exe],'cwd':cwd,'state':state,'startTicks':pid*10,'cpuTicks':0,'comm':Path(exe).name}
def fixture():
 return {1:row(1,0,'/sbin/init'),500:row(500,1,'/usr/bin/bash'),600:row(600,500,'/usr/bin/python3',['python3','/recipe/host.py','run']),700:row(700,600,'/usr/bin/python3',['python3',str(HERE/'quiet.py')]),200:row(200,1,'/sbin/docker-init',['/sbin/docker-init','--','sleep','infinity']),201:row(201,200,'/usr/bin/sleep',['sleep','infinity'])}
def container():return {'id':'a'*64,'name':'/p6-benchmark-21-1','pid':200,'running':True,'paused':False,'restarting':False,'owner':'21-1','command':['sleep','infinity'],'entrypoint':None}
def classify(rows=None,containers=None,errors=()):return g.classify(rows or fixture(),containers if containers is not None else [container()],self_pid=700,main_name='p6-benchmark-21-1',identity=IDENTITY,script=HERE/'quiet.py',controller_files=[Path('/recipe/host.py')],errors=errors)

class HostContracts(unittest.TestCase):
 def test_idle_owned_main_and_verified_ancestor_only(self):
  result=classify();self.assertTrue(result['quiet']);self.assertEqual({r['pid'] for r in result['allowed']},{200,201,500,600,700})
  rows=fixture();rows[601]=row(601,1,'/usr/bin/python3',['python3','/recipe/host.py','run'])
  self.assertFalse(classify(rows)['quiet'])
  rows=fixture();rows[600]['args']=['python3','/unreviewed/controller.py'];self.assertFalse(classify(rows)['quiet'])
 def test_build_hook_guest_benchmark_task_and_shell_block(self):
  cases=[('heavy-build','/usr/bin/clang',['clang','input.cc'],'/'),('native-hook-or-runtime','/usr/bin/node',['node','install-hook.js'],'/'),('docker-or-guest-work','/usr/bin/qemu-system-x86_64',['qemu-system-x86_64'],'/'),('other-benchmark','/usr/bin/node',['node','run-cohort.mjs'],'/'),('other-benchmark','/usr/local/bin/openclaw',['openclaw','gateway'],'/'),('task-process','/usr/bin/cat',['cat',str(g.ROOT/'source/input')],'/'),('unreconciled-host-work','/usr/bin/bash',['bash','other-task.sh'],'/')]
  for expected,exe,args,cwd in cases:
   with self.subTest(expected=expected):
    rows=fixture();rows[900]=row(900,1,exe,args+['SYNTHETIC-PRIVATE-ARGV'],cwd);result=classify(rows)
    self.assertFalse(result['quiet']);self.assertIn(expected,[v['classification'] for v in result['blocking']]);self.assertNotIn('SYNTHETIC-PRIVATE',json.dumps(result));self.assertNotIn('args',json.dumps(result))
 def test_other_containers_or_owned_main_descendants_block(self):
  other={**container(),'id':'b'*64,'name':'/other','owner':'other','running':False};self.assertFalse(classify(containers=[container(),other])['quiet'])
  rows=fixture();rows[202]=row(202,200,'/usr/bin/sleep',['sleep','100']);self.assertFalse(classify(rows)['quiet'])
  self.assertFalse(classify(containers=[{**container(),'owner':'different'}])['quiet'])
  self.assertFalse(classify(containers=[{**container(),'command':['bash']}])['quiet'])
 def test_failed_inspection_and_busy_ancestor_do_not_admit(self):
  self.assertFalse(classify(errors=[{'pid':99,'classification':'process-inspection-failed'}])['quiet'])
  rows=fixture();del rows[700];self.assertFalse(classify(rows)['quiet'])
  rows=fixture();rows[600]['state']='R';self.assertFalse(classify(rows)['quiet'])
 def test_relative_orchestrator_path_is_verified_against_cwd(self):
  rows=fixture();rows[600]['args']=['python3','host.py','run'];rows[600]['cwd']='/recipe';self.assertTrue(classify(rows)['quiet'])
 def test_dynamic_budget_threshold_and_complete_cells(self):
  budget={'sourceCommit':g.SOURCE,'status':'window-available','requiredSeconds':500,'remainingSecondsAfterCleanupReserve':600,'warmupSweeps':1,'measuredSweeps':6,'cells':['js-aot','node-npm','bun-jit-npm']}
  self.assertEqual(g.budget_window(budget,2700,1000),(500,True));self.assertEqual(g.budget_window(budget,2699,1000),(500,False))
  with self.assertRaises(ValueError):g.budget_window({**budget,'cells':['node-npm']},2700,1000)

class ReceiptContracts(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory(dir=HERE);self.addCleanup(self.tmp.cleanup);self.root=Path(self.tmp.name)/'root';self.target=self.root/'benchmark-prep';self.target.mkdir(parents=True)
  self.recipe=Path(self.tmp.name)/'recipe/app/benchmark';self.recipe.mkdir(parents=True);(self.recipe/'host.py').write_text('# synthetic host controller\n');(self.recipe.parents[1]/'deadline_process.py').write_text('# synthetic deadline controller\n')
  self.execution={'schemaVersion':1,'identity':dict(IDENTITY),'sourceCommit':g.SOURCE,'workflowHead':'a'*40,'hostBootId':BOOT}
  self.path=self.root/'execution.json';self.path.write_text(json.dumps(self.execution));self.env={v:IDENTITY[k] for k,v in g.GH.items()};self.env.update(GITHUB_SHA='a'*40,P6_DEADLINE_EPOCH='2700')
  self.budget={'sourceCommit':g.SOURCE,'status':'window-available','requiredSeconds':500,'remainingSecondsAfterCleanupReserve':600,'warmupSweeps':1,'measuredSweeps':6,'cells':['js-aot','node-npm','bun-jit-npm']};(self.target/'cohort-budget.json').write_text(json.dumps(self.budget))
 def run_main(self,reconcile=False,second_busy=False,cpu_busy=0):
  args=['quiet.py','--identity',str(self.path),'--identity-sha256',hashlib.sha256(self.path.read_bytes()).hexdigest(),'--container','p6-benchmark-21-1']+(['--reconcile-only'] if reconcile else [])
  rows=fixture();rows[600]['args']=['python3',str(self.recipe/'host.py'),'run'];second=copy.deepcopy(rows)
  if second_busy:second[900]=row(900,1,'/usr/bin/node',['node','run-cohort.mjs','SYNTHETIC-PRIVATE'])
  if cpu_busy:
   rows[901]=row(901,1,'/opt/custom-native');second[901]=row(901,1,'/opt/custom-native');second[901]['cpuTicks']=cpu_busy
  original=Path.read_text
  def read(path,*a,**k):return BOOT if str(path)=='/proc/sys/kernel/random/boot_id' else original(path,*a,**k)
  with contextlib.ExitStack() as stack:
   for obj,key,value in [(g,'ROOT',self.root),(g,'HERE',self.recipe),(g.platform,'system',lambda:'Linux'),(g.platform,'machine',lambda:'x86_64'),(g.os,'geteuid',lambda:0),(g.os,'getpid',lambda:700),(g.time,'time',lambda:1000),(sys,'argv',args)]:stack.enter_context(patch.object(obj,key,value))
   stack.enter_context(patch.dict(os.environ,self.env,clear=True));stack.enter_context(patch.object(Path,'read_text',read));stack.enter_context(patch.object(g,'read_containers',return_value=[container()]));stack.enter_context(patch.object(g,'read_processes',side_effect=[(rows,[]),(second,[])]));stack.enter_context(patch.object(g,'cpu_point',side_effect=[{'monotonic':0.0,'hostTicks':[0,0,0,1000,0,0,0,0],'selfTicks':0,'selfStartTicks':7000},{'monotonic':1.0,'hostTicks':[cpu_busy,0,0,1100-cpu_busy,0,0,0,0],'selfTicks':0,'selfStartTicks':7000}]));stack.enter_context(patch.object(g.time,'sleep'));stack.enter_context(patch.object(g.os,'sysconf',return_value=100));stack.enter_context(contextlib.redirect_stdout(io.StringIO()));return g.main()
 def test_actual_identity_hash_and_environment_match(self):
  self.assertEqual(g.execution(self.path,hashlib.sha256(self.path.read_bytes()).hexdigest(),self.env)['identity'],IDENTITY)
  for field in list(self.env)[:-1]:
   with self.subTest(field=field),self.assertRaises(ValueError):g.execution(self.path,hashlib.sha256(self.path.read_bytes()).hexdigest(),{**self.env,field:'changed'})
  with self.assertRaises(ValueError):g.execution(self.path,'0'*64,self.env)
 def test_admission_matches_check_window_and_second_snapshot_is_binding(self):
  self.assertEqual(self.run_main(),0);q=json.loads((self.target/'quiet-admission.json').read_text());e=Path(q['hostReconciliation']['path'])
  self.assertEqual(q['decision'],'run-complete-selected-cell-cohort');self.assertEqual(q['hostBootId'],BOOT);self.assertEqual(q['observedAtEpoch'],1000);self.assertEqual(q['reservationSeconds'],500);self.assertTrue(all(q[k] for k in g.FLAGS));self.assertEqual(hashlib.sha256(e.read_bytes()).hexdigest(),q['hostReconciliation']['sha256'])
  self.assertEqual(self.run_main(second_busy=True),1);q=json.loads((self.target/'quiet-admission.json').read_text());self.assertEqual(q['decision'],'pending-host-reconciliation');self.assertFalse(any(q[k] for k in g.FLAGS));self.assertNotIn('SYNTHETIC-PRIVATE', (self.target/'host-reconciliation.json').read_text())
 def test_reconcile_only_requires_no_budget_and_never_admits(self):
  (self.target/'cohort-budget.json').unlink();self.assertEqual(self.run_main(reconcile=True),0);self.assertTrue((self.target/'post-backup-reconciliation.json').is_file());self.assertFalse((self.target/'quiet-admission.json').exists())
 def test_unknown_cpu_prevents_admission_despite_idle_names(self):
  self.assertEqual(self.run_main(cpu_busy=50),1);self.assertEqual(json.loads((self.target/'host-reconciliation.json').read_text())['status'],'not-quiet');self.assertEqual(json.loads((self.target/'quiet-admission.json').read_text())['decision'],'pending-host-reconciliation')
 def test_other_boot_or_insufficient_window_cannot_admit(self):
  self.execution['hostBootId']='different';self.path.write_text(json.dumps(self.execution))
  with self.assertRaisesRegex(ValueError,'different host boot'):self.run_main()
  self.execution['hostBootId']=BOOT;self.path.write_text(json.dumps(self.execution));self.env['P6_DEADLINE_EPOCH']='2699';self.assertEqual(self.run_main(),78);self.assertEqual(json.loads((self.target/'host-reconciliation.json').read_text())['status'],'insufficient-window')

class CpuContracts(unittest.TestCase):
 def points(self,busy=0,own=0,iowait=0):
  return ({'monotonic':0.0,'hostTicks':[0,0,0,1000,0,0,0,0],'selfTicks':0,'selfStartTicks':7000},
          {'monotonic':1.0,'hostTicks':[busy,0,0,4200-busy-iowait,iowait,0,0,0],'selfTicks':own,'selfStartTicks':7000})
 def test_unknown_java_zstd_and_custom_native_cpu_are_rejected(self):
  for executable in ['/usr/bin/java','/usr/bin/zstd','/opt/private-native-benchmark']:
   with self.subTest(executable=executable):
    before=fixture();before[900]=row(900,1,executable);after=copy.deepcopy(before);after[900]['cpuTicks']=100
    self.assertTrue(classify(before)['quiet'])
    result=g.cpu_activity(*self.points(busy=102,own=2),before,after,700,100)
    self.assertFalse(result['pass']);self.assertEqual(result['observedOtherProcessTicks'],100);self.assertEqual(result['processActivity'][0]['classification'],'unclassified-host-cpu');self.assertNotIn(executable,json.dumps(result))
 def test_idle_unknown_and_only_inspector_overhead_are_allowed(self):
  before=fixture();before[900]=row(900,1,'/opt/custom-native');after=copy.deepcopy(before);after[700]['cpuTicks']=50
  result=g.cpu_activity(*self.points(busy=52,own=50),before,after,700,100)
  self.assertTrue(result['pass']);self.assertEqual(result['inspectorCpuTicksExcluded'],50);self.assertEqual(result['unexplainedHostBusyTicks'],2);self.assertEqual(result['noiseAllowanceCpuSeconds'],0.1)
 def test_allowed_host_controller_cpu_is_not_excluded(self):
  before=fixture();after=copy.deepcopy(before);after[600]['cpuTicks']=50
  result=g.cpu_activity(*self.points(busy=50),before,after,700,100);self.assertFalse(result['pass']);self.assertEqual(result['observedOtherProcessTicks'],50)
 def test_unattributed_short_lived_cpu_and_iowait_are_rejected(self):
  for points in [self.points(busy=100),self.points(iowait=100)]:
   self.assertFalse(g.cpu_activity(*points,fixture(),fixture(),700,100)['pass'])
  rows=fixture();rows[900]=row(900,1,'/opt/unknown',state='D');self.assertFalse(classify(rows)['quiet'])
 def test_process_churn_reuse_and_counter_rollback_fail_closed(self):
  for mutation in ['added','removed','reused','rollback']:
   before=fixture();before[900]=row(900,1,'/opt/unknown');after=copy.deepcopy(before)
   if mutation=='added':after[901]=row(901,1,'/opt/unknown')
   elif mutation=='removed':del after[900]
   elif mutation=='reused':after[900]['startTicks']+=1
   else:before[900]['cpuTicks']=10
   with self.subTest(mutation=mutation):self.assertFalse(g.cpu_activity(*self.points(),before,after,700,100)['pass'])
  first,last=self.points();last['hostTicks'][0]=-1
  with self.assertRaises(ValueError):g.cpu_activity(first,last,fixture(),fixture(),700,100)
  first,last=self.points();last['selfTicks']=100
  with self.assertRaises(ValueError):g.cpu_activity(first,last,fixture(),fixture(),700,100)
 def test_disappearing_process_during_inspection_is_recorded(self):
  with tempfile.TemporaryDirectory(dir=HERE) as directory:
   proc=Path(directory);entry=proc/'99';entry.mkdir();fields=['S','1']+['0']*18;fields[19]='900';(entry/'stat').write_text('99 (unknown) '+' '.join(fields))
   rows,errors=g.read_processes(proc);self.assertEqual(rows,{});self.assertEqual(errors,[{'pid':99,'classification':'process-inspection-race'}])

if __name__=='__main__':unittest.main()
