#!/usr/bin/env python3
"""Inspect host quietness and bind sanitized evidence to the full cohort window."""
import argparse,hashlib,json,math,os,platform,re,subprocess,time
from pathlib import Path

ROOT=Path('/home/runner/.cache/oc-ty-ext/P6/app-x64-final-r2-v1')
SOURCE='670a7ab33bbd2e3ed4f0a5681e138159d74540a1'
HERE=Path(__file__).resolve().parent
GH={'repository':'GITHUB_REPOSITORY','runId':'GITHUB_RUN_ID','runAttempt':'GITHUB_RUN_ATTEMPT','job':'GITHUB_JOB'}
FLAGS=['heavyBuildsReconciled','nativeHooksReconciled','dockerAndGuestWorkReconciled','otherBenchmarksStopped','sameNativeMachineAllCells','exclusiveBenchmarkInterval']
BUILDERS={'ninja','make','gmake','cmake','cc','c++','gcc','g++','clang','clang++','rustc','cargo','zig','cc1','cc1plus','ld','ld.lld','lld','ar','as','go'}
RUNTIMES={'node','nodejs','bun','npm','npx','pnpm','ruby','perl'}
SHELLS={'sh','bash','dash','zsh'}
SAMPLE_SECONDS=1.0
NOISE_CPU_SECONDS_PER_SECOND=0.10

def need(ok,message):
 if not ok:raise ValueError(message)
def sha(path):return hashlib.sha256(Path(path).read_bytes()).hexdigest()
def load(path):return json.loads(Path(path).read_text())
def write(path,data):
 temporary=path.with_name(path.name+'.next')
 with temporary.open('w') as stream:json.dump(data,stream,indent=2);stream.write('\n')
 temporary.chmod(0o644);temporary.replace(path)

def execution(path,expected,env):
 need(re.fullmatch('[0-9a-f]{64}',expected) is not None and sha(path)==expected,'Execution hash differs')
 data=load(path);identity=data.get('identity')
 need(data.get('schemaVersion')==1 and data.get('sourceCommit')==SOURCE,'Execution source/schema differs')
 need(isinstance(identity,dict) and set(identity)==set(GH),'Complete actual execution identity required')
 need(identity['repository']=='openclaw/bun' and identity['job']=='linux-x64-benchmark','Wrong benchmark repository/job')
 for key,name in GH.items():
  need(isinstance(identity[key],str) and env.get(name)==identity[key],'Actual GitHub identity differs')
 for key in ['runId','runAttempt']:need(re.fullmatch('[1-9][0-9]*',identity[key]) is not None,'Positive decimal run identity required')
 head=data.get('workflowHead');need(isinstance(head,str) and re.fullmatch('[0-9a-f]{40}',head) is not None and env.get('GITHUB_SHA')==head,'Actual workflow head differs')
 return data

def proc_stat(raw):
 end=raw.rfind(')');need(end>0,'Invalid proc stat');pid=int(raw[:raw.index('(')].strip());fields=raw[end+2:].split()
 return {'pid':pid,'state':fields[0],'ppid':int(fields[1]),'startTicks':int(fields[19]),'cpuTicks':int(fields[11])+int(fields[12]),'comm':raw[raw.index('(')+1:end]}

def read_processes(proc=Path('/proc')):
 rows={};errors=[]
 for directory in proc.iterdir():
  if not directory.name.isdecimal():continue
  pid=int(directory.name)
  try:
   row=proc_stat((directory/'stat').read_text());args=(directory/'cmdline').read_bytes().split(b'\0');row['args']=[v.decode('utf8','replace') for v in args if v]
   try:row['exe']=os.readlink(directory/'exe')
   except FileNotFoundError:row['exe']=''
   try:row['cwd']=os.readlink(directory/'cwd')
   except FileNotFoundError:row['cwd']=''
   after=proc_stat((directory/'stat').read_text());need(row['startTicks']==after['startTicks'] and row['pid']==pid,'Process changed during inspection')
   rows[pid]=row
  except FileNotFoundError:errors.append({'pid':pid,'classification':'process-inspection-race'})
  except (OSError,ValueError,IndexError):errors.append({'pid':pid,'classification':'process-inspection-failed'})
 return rows,errors

def cpu_point(proc=Path('/proc')):
 row=proc_stat((proc/str(os.getpid())/'stat').read_text())
 fields=(proc/'stat').read_text().splitlines()[0].split()
 need(fields[0]=='cpu' and len(fields)>=9,'Host CPU counters unavailable')
 ticks=list(map(int,fields[1:9]));need(all(v>=0 for v in ticks),'Invalid host CPU counters')
 return {'monotonic':time.monotonic(),'hostTicks':ticks,'selfTicks':row['cpuTicks'],'selfStartTicks':row['startTicks']}

def cpu_activity(first,last,before,after,self_pid,hz):
 elapsed=last['monotonic']-first['monotonic']
 need(0.5<=elapsed<=5.0 and hz>0,'CPU sampling interval invalid')
 need(first['selfStartTicks']==last['selfStartTicks'],'Inspector identity changed')
 delta=[b-a for a,b in zip(first['hostTicks'],last['hostTicks'])]
 need(len(delta)==8 and all(v>=0 for v in delta) and sum(delta)>0,'Host CPU counters changed or unavailable')
 busy=sum(delta)-delta[3]-delta[4];own=last['selfTicks']-first['selfTicks']
 need(0<=own<=busy+2,'Inspector CPU counters inconsistent')
 added=sorted(set(after)-set(before));removed=sorted(set(before)-set(after));reused=[];errors=[];activity=[]
 for pid in sorted(set(before)&set(after)):
  a,b=before[pid],after[pid]
  if a['startTicks']!=b['startTicks']:
   reused.append(pid);continue
  ticks=b['cpuTicks']-a['cpuTicks']
  if ticks<0:errors.append(pid);continue
  if pid!=self_pid and ticks:
   activity.append({'pid':pid,'cpuTicks':ticks,'classification':category(b,str(ROOT.parent)) or 'unclassified-host-cpu'})
 allowance=max(1,math.ceil(hz*elapsed*NOISE_CPU_SECONDS_PER_SECOND))
 unexplained=max(0,busy-own);process_ticks=sum(v['cpuTicks'] for v in activity)
 clean=not (added or removed or reused or errors) and max(unexplained,process_ticks,delta[4])<=allowance
 return {'pass':clean,'intervalSeconds':elapsed,'clockTicksPerSecond':hz,'noiseAllowanceCpuSeconds':allowance/hz,
  'noiseAllowanceTicks':allowance,'hostBusyTicks':busy,'hostBusyCpuSeconds':busy/hz,
  'inspectorCpuTicksExcluded':own,'inspectorCorrectionCpuSeconds':own/hz,'inspectorCorrectionRoundingBoundTicks':2,
  'unexplainedHostBusyTicks':unexplained,'observedOtherProcessTicks':process_ticks,'iowaitTicks':delta[4],
  'processActivity':activity,'addedPids':added,'removedPids':removed,'reusedPids':reused,'counterErrorPids':errors}

DOCKER_FORMAT='{"id":{{json .Id}},"name":{{json .Name}},"pid":{{json .State.Pid}},"running":{{json .State.Running}},"paused":{{json .State.Paused}},"restarting":{{json .State.Restarting}},"owner":{{json (index .Config.Labels "openclaw.p6.owner")}},"command":{{json .Config.Cmd}},"entrypoint":{{json .Config.Entrypoint}}}'
def read_containers():
 result=subprocess.run(['docker','ps','-aq','--no-trunc'],capture_output=True,text=True,timeout=30,check=True)
 ids=result.stdout.split();need(len(ids)==len(set(ids)) and all(re.fullmatch('[0-9a-f]{64}',v) for v in ids),'Invalid Docker inventory')
 if not ids:return []
 result=subprocess.run(['docker','inspect','--format',DOCKER_FORMAT,*ids],capture_output=True,text=True,timeout=30,check=True)
 rows=[json.loads(v) for v in result.stdout.splitlines() if v.strip()]
 need(len(rows)==len(ids) and {v['id'] for v in rows}==set(ids),'Docker inventory changed')
 return rows

def ancestry(rows,pid):
 result=set();seen=set()
 while pid in rows:
  need(pid not in seen,'Process ancestry cycle');seen.add(pid);result.add(pid);pid=rows[pid]['ppid']
 return result

def descendants(rows,pid):
 found={pid}
 while True:
  expanded=found|{p for p,row in rows.items() if row['ppid'] in found}
  if expanded==found:return found
  found=expanded

def idle_main(rows,container):
 pid=container['pid'];need(type(pid) is int and pid>0 and pid in rows,'Main container host PID absent')
 need(container['running'] is True and not container['paused'] and not container['restarting'],'Main container not running normally')
 need(container['command']==['sleep','infinity'] and container['entrypoint'] in [None,[]],'Main container command differs')
 ids=descendants(rows,pid);root=rows[pid];args=root['args'];name=Path(root['exe'] or (args[0] if args else root['comm'])).name
 if name=='sleep':need(args[1:]==['infinity'] and ids=={pid},'Main sleep has unexpected arguments/children')
 else:
  need(name in ['docker-init','tini'] and args[1:]==['--','sleep','infinity'],'Main init differs')
  children=[row for row in rows.values() if row['ppid']==pid];need(len(children)==1 and ids=={pid,children[0]['pid']},'Main container has task descendants')
  child=children[0];need(child['args'] and Path(child['args'][0]).name=='sleep' and child['args'][1:]==['infinity'],'Main child is not idle sleep')
 need(all(rows[v]['state'] in ['S','I'] for v in ids),'Main container is not idle')
 return ids

def has_path(row,path):
 for arg in row['args'][1:]:
  if Path(arg).name!=path.name:continue
  actual=Path(arg) if Path(arg).is_absolute() else Path(row.get('cwd','/'))/arg
  if actual.resolve()==path.resolve():return True
 return False

def controller(row,ancestors,self_pid,script,controller_files):
 pid=row['pid'];args=row['args'];name=Path(row['exe'] or (args[0] if args else row['comm'])).name
 if pid==self_pid:return 'quiet-inspector'
 if pid not in ancestors or row['state'] not in ['S','I']:return None
 if name in SHELLS:return 'waiting-ancestor-shell'
 if name in ['sudo','env','timeout'] and has_path(row,script):return 'quiet-wrapper'
 if name.startswith('python'):
  if has_path(row,script):return 'quiet-wrapper'
  if any(has_path(row,path) for path in controller_files):return 'verified-host-controller'
 return None

def category(row,task_root):
 args=row['args'];name=Path(row['exe'] or (args[0] if args else row['comm'])).name;joined=' '.join(args)
 if name in BUILDERS or any(v in joined for v in ['build-bun-standalone','build-linux.py','scripts/build.ts','native_phase.py']):return 'heavy-build'
 if name.startswith(('qemu','firecracker')) or name in ['cloud-localds','mkfs.ext4','docker','docker-buildx']:return 'docker-or-guest-work'
 if name in ['openclaw','openclaw-gateway'] or any(v in joined for v in ['run-cohort','stream-cohort','core-runner','run-functional','run-backup','measure-command','benchmark-prep','quiet.py']):return 'other-benchmark'
 if name in RUNTIMES or name.startswith(('python','pip')) or any(v in joined for v in ['node-gyp','node-pre-gyp','postinstall','prepare-package','npm install','pnpm install']):return 'native-hook-or-runtime'
 if task_root in joined or row.get('cwd','').startswith(task_root+'/') or '/p6-recipe' in joined or 'openclaw-p6' in joined:return 'task-process'
 if name in SHELLS or name in ['stress','stress-ng','sysbench','fio','iperf','iperf3']:return 'unreconciled-host-work'
 return None

def classify(rows,containers,*,self_pid,main_name,identity,script,controller_files=(),errors=()):
 allowed={};blocked=list(errors);container_facts=[]
 if self_pid not in rows:blocked.append({'classification':'quiet-inspector-not-in-census'})
 own=identity['runId']+'-'+identity['runAttempt'];main=[]
 for item in containers:
  expected=item['name'].lstrip('/')==main_name and item['owner']==own
  container_facts.append({'id':item['id'],'ownedMain':expected,'running':item['running']})
  if expected:main.append(item)
  else:blocked.append({'classification':'other-container','containerId':item['id']})
 if len(main)!=1:blocked.append({'classification':'owned-main-container-missing-or-ambiguous'})
 else:
  try:
   for pid in idle_main(rows,main[0]):allowed[pid]='idle-owned-main'
  except (ValueError,KeyError,IndexError):blocked.append({'classification':'owned-main-not-idle','pid':main[0].get('pid')})
 ancestors=ancestry(rows,self_pid)
 for pid,row in rows.items():
  reason=controller(row,ancestors,self_pid,script,controller_files)
  if reason:allowed[pid]=reason
 for pid,row in rows.items():
  if pid in allowed:continue
  label='uninterruptible-host-work' if row['state']=='D' else category(row,str(ROOT.parent))
  if label:blocked.append({'pid':pid,'ppid':row['ppid'],'startTicks':row['startTicks'],'classification':label})
 return {'quiet':not blocked,'blocking':blocked,'allowed':[{'pid':pid,'classification':value} for pid,value in sorted(allowed.items())],'containers':container_facts,'hostProcessCount':len(rows)}

def budget_window(budget,deadline,now):
 need(budget.get('sourceCommit')==SOURCE and budget.get('status')=='window-available','Complete measured cohort budget required')
 required=budget.get('requiredSeconds');need(type(required) is int and required>0,'Positive required cohort seconds required')
 need(budget.get('warmupSweeps')==1 and budget.get('measuredSweeps')==6,'Complete seven-sweep cohort required')
 cells=budget.get('cells');need(isinstance(cells,list) and all(isinstance(v,str) for v in cells) and len(cells)==len(set(cells)) and set(cells)>={'js-aot','node-npm','bun-jit-npm'} and set(cells)<={'js-aot','c2-off-aot','ts-aot','node-npm','bun-jit-npm'},'Selected complete cohort cells differ')
 need(budget['remainingSecondsAfterCleanupReserve']>=required,'Recorded cohort window insufficient')
 return required,deadline-now-1200>=required

def main():
 parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--identity',type=Path,required=True);parser.add_argument('--identity-sha256',required=True);parser.add_argument('--container',required=True);parser.add_argument('--reconcile-only',action='store_true');args=parser.parse_args()
 need(platform.system()=='Linux' and platform.machine()=='x86_64' and os.geteuid()==0,'Host native x64 privileged inspection required')
 current=execution(args.identity,args.identity_sha256,os.environ);identity=current['identity'];deadline=int(os.environ['P6_DEADLINE_EPOCH'])
 target=ROOT/'benchmark-prep';need(target.is_dir() and not target.is_symlink(),'Existing task benchmark-prep required')
 boot=Path('/proc/sys/kernel/random/boot_id').read_text().strip();need(re.fullmatch('[0-9a-f-]{36}',boot) is not None,'Host boot identity unavailable')
 need(current.get('hostBootId')==boot,'Execution belongs to a different host boot')
 template={'decision':'pending-host-reconciliation','sourceCommit':SOURCE,'nativeRoot':str(ROOT),'hostBootId':boot,'observedAtEpoch':time.time(),'reservationSeconds':None,'hostReconciliation':{'path':None,'sha256':None},**{v:False for v in FLAGS}}
 if not args.reconcile_only or (target/'quiet-admission.json').exists():write(target/'quiet-admission.json',template)
 evidence=target/('post-backup-reconciliation.json' if args.reconcile_only else 'host-reconciliation.json')
 record={'schemaVersion':1,'status':'inspection-failed','identity':identity,'executionSha256':args.identity_sha256,'sourceCommit':SOURCE,'nativeRoot':str(ROOT),'hostBootId':boot,'resourceMutation':False,'rawArgvOrEnvironmentStored':False,'observations':[]}
 code=1
 try:
  controller_files=[v for v in [HERE/'host.py',HERE.parents[1]/'deadline_process.py'] if v.is_file()]
  record['controllerSources']=[{'role':v.name,'sha256':sha(v)} for v in controller_files]
  containers_before=read_containers();before,errors_before=read_processes()
  first=cpu_point();time.sleep(SAMPLE_SECONDS);last=cpu_point()
  after,errors_after=read_processes();containers_after=read_containers()
  for rows,errors,containers in [(before,errors_before,containers_before),(after,errors_after,containers_after)]:
   record['observations'].append(classify(rows,containers,self_pid=os.getpid(),main_name=args.container,identity=identity,script=Path(__file__).resolve(),controller_files=controller_files,errors=errors))
  record['cpuSampling']=cpu_activity(first,last,before,after,os.getpid(),os.sysconf('SC_CLK_TCK'))
  quiet=all(v['quiet'] for v in record['observations']) and record['cpuSampling']['pass'];record['status']='quiet' if quiet else 'not-quiet'
  if quiet:
   now=time.time()
   if args.reconcile_only:
    code=0 if deadline-now-1200>0 else 78
   else:
    budget=load(target/'cohort-budget.json');required,fits=budget_window(budget,deadline,now);record['cohortBudget']={'requiredSeconds':required,'cells':budget['cells'],'remainingSecondsAfterCleanupReserve':deadline-now-1200};code=0 if fits else 78
   if code==78:record['status']='insufficient-window'
 except (OSError,ValueError,KeyError,subprocess.SubprocessError) as error:
  record['status']='inspection-failed';record['inspectionErrorType']=type(error).__name__
 record['observedAtEpoch']=time.time();write(evidence,record)
 if not args.reconcile_only and code==0:
  template.update(decision='run-complete-selected-cell-cohort',observedAtEpoch=record['observedAtEpoch'],reservationSeconds=record['cohortBudget']['requiredSeconds'],hostReconciliation={'path':str(evidence),'sha256':sha(evidence)},executionIdentity=identity,executionSha256=args.identity_sha256)
  template.update({v:True for v in FLAGS});write(target/'quiet-admission.json',template)
 print(json.dumps({'status':record['status'],'reconciliation':str(evidence),'sha256':sha(evidence),'admitted':not args.reconcile_only and code==0}),flush=True)
 return code
if __name__=='__main__':raise SystemExit(main())
