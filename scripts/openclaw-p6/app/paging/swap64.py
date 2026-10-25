#!/usr/bin/env python3
"""Explicitly admitted task swap only; no app launch or persistent system changes."""
import argparse,hashlib,json,os,platform,re,resource,shutil,signal,stat,subprocess,time
from pathlib import Path
ROOT=Path('/home/runner/.cache/oc-ty-ext/P6/app-x64-final-r3-v1')
AREA=BACKING=STATE=MAPPER=None
NAME=None
IDENTITY=None
EXECUTION_SHA256=None
SOURCE='59baf4a051665750eb7055d0cec991d9876526df'
SIZE=64*1024**3
FLOOR=25*1024**3
BUILD_HEADROOM=32*1024**3
CIPHER='aes-cbc-essiv:sha256'
CORE_ENV=None
TOOLS=['/usr/bin/fallocate','/usr/sbin/losetup','/usr/sbin/cryptsetup','/usr/sbin/mkswap','/usr/sbin/swapon','/usr/sbin/swapoff','/usr/bin/timeout']

class OwnerCancelled(Exception):
 pass

def need(value,message):
 if not value:raise ValueError(message)

def digest(path):
 h=hashlib.sha256()
 with Path(path).open('rb') as f:
  for chunk in iter(lambda:f.read(1024*1024),b''):h.update(chunk)
 return h.hexdigest()

def bind_identity(path,expected):
 global IDENTITY,EXECUTION_SHA256,AREA,BACKING,STATE,NAME,MAPPER,CORE_ENV
 need(re.fullmatch('[0-9a-f]{64}',expected) is not None,'Full execution SHA256 required')
 need(digest(path)==expected,'Execution identity hash differs')
 data=json.loads(Path(path).read_text());identity=data.get('identity')
 need(type(data.get('schemaVersion')) is int and data['schemaVersion']==1 and data.get('sourceCommit')==SOURCE,'Execution source/schema differs')
 need(isinstance(identity,dict) and set(identity)=={'repository','runId','runAttempt','job'},'Complete GitHub execution identity required')
 need(identity['repository']=='openclaw/bun' and identity['job']=='linux-x64-app','Wrong GitHub repository/job')
 for key in ['runId','runAttempt']:
  need(isinstance(identity[key],str) and re.fullmatch('[1-9][0-9]{0,19}',identity[key]) is not None,'Positive decimal GitHub run identity required')
 for key,env in [('repository','GITHUB_REPOSITORY'),('runId','GITHUB_RUN_ID'),('runAttempt','GITHUB_RUN_ATTEMPT'),('job','GITHUB_JOB')]:
  need(os.environ.get(env)==identity[key],'Actual GitHub environment differs: '+env)
 head=data.get('workflowHead');need(isinstance(head,str) and re.fullmatch('[0-9a-f]{40}',head) is not None and os.environ.get('GITHUB_SHA')==head,'Actual GitHub workflow head differs')
 IDENTITY=dict(identity);EXECUTION_SHA256=expected
 suffix='actions-'+identity['runId']+'-'+identity['runAttempt']
 AREA=ROOT/'ephemeral-swap64'/suffix;BACKING=AREA/'backing.img';STATE=AREA/'state.json'
 NAME='p6-aot-swap64-'+identity['runId']+'-'+identity['runAttempt'];MAPPER=Path('/dev/mapper')/NAME
 CORE_ENV={'PATH':'/usr/sbin:/usr/bin:/sbin:/bin','HOME':str(AREA),'LC_ALL':'C','LANG':'C'}
 return data

def owner_path():
 need(IDENTITY is not None,'Execution identity must be bound first')
 return ROOT/'paging-tools'/('actions-'+IDENTITY['runId']+'-'+IDENTITY['runAttempt'])/'swap64.py'

def save(state):
 target=AREA/'state.next';target.write_text(json.dumps(state,indent=2)+'\n');target.chmod(0o600);target.replace(STATE)

def run(state,argv,timeout=30):
 # No key material is supplied to Python, argv or logs; cryptsetup reads urandom.
 row={'argv':list(map(str,argv))};state.setdefault('commands',[]).append(row);save(state)
 child=subprocess.Popen(row['argv'],env=CORE_ENV,stdout=subprocess.PIPE,stderr=subprocess.PIPE,start_new_session=True)
 try:
  try:out,err=child.communicate(timeout=timeout)
  except BaseException:
   try:os.killpg(child.pid,signal.SIGTERM)
   except ProcessLookupError:pass
   try:child.communicate(timeout=5)
   except subprocess.TimeoutExpired:
    try:os.killpg(child.pid,signal.SIGKILL)
    except ProcessLookupError:pass
    child.communicate()
   raise
  row.update(exitCode=child.returncode,stdout=out.decode('utf8','replace'),stderr=err.decode('utf8','replace'));save(state)
  need(child.returncode==0,'Command failed: '+str(argv[0]));return row['stdout']
 finally:
  row['terminal']=child.poll() is not None;save(state)

def settings():
 return {n:Path('/proc/sys/vm',n).read_text().strip() for n in ['swappiness','overcommit_memory','overcommit_ratio']}

def swaps():
 result=[]
 for line in Path('/proc/swaps').read_text().splitlines()[1:]:
  name,kind,size,used,priority=line.split();result.append({'path':name,'type':kind,'sizeKiB':int(size),'usedKiB':int(used),'priority':int(priority)})
 return result

def file_id(path):
 s=path.lstat();need(stat.S_ISREG(s.st_mode),'Owned backing must be a regular file')
 return {'dev':s.st_dev,'ino':s.st_ino,'size':s.st_size}

def unchanged(state,rows=None):
 need(settings()==state['baselineSettings'],'Existing VM settings changed; stop and reconcile')
 old=[x for x in (swaps() if rows is None else rows) if x['path']=='/swapfile'];need(len(old)==1,'Original swapfile missing')
 for key in ['type','sizeKiB','priority']:need(old[0][key]==state['baselineSwap'][key],'Original swapfile identity/settings changed')
 info=Path('/swapfile').stat();need([info.st_dev,info.st_ino]==state['baselineSwapFileId'],'Original swapfile inode changed')

def task_build_args(args):
 names={'native_phase.py','run-admitted-build.sh','build-linux.py','build-bun-standalone.mjs','preserve.py'}
 task=any(str(ROOT.parent)+'/' in arg or arg==str(ROOT.parent) for arg in args)
 script=any(Path(arg).name in names for arg in args)
 compiler=bool(args) and Path(args[0]).name.startswith('bun') and len(args)>1 and args[1]=='build' and any(arg.startswith(('--aot','--compile')) for arg in args[2:])
 return task and (script or compiler)

def idle():
 for item in Path('/proc').iterdir():
  if not item.name.isdigit() or int(item.name)==os.getpid():continue
  try:args=[a.decode('utf8','replace') for a in (item/'cmdline').read_bytes().split(b'\0') if a]
  except OSError:continue
  need(not task_build_args(args),'Task build/compiler/preservation owner remains active: PID '+item.name)

def matching_loops(state):
 data=json.loads(run(state,['/usr/sbin/losetup','--associated',str(BACKING),'--json','--list','--output','NAME,BACK-FILE,DIO']))
 return [x for x in data.get('loopdevices',[]) if x.get('back-file')==str(BACKING)]

def owned_loop(state,allow_missing=False):
 need(file_id(BACKING)==state['backingIdentity'],'Owned backing inode or size changed')
 matches=matching_loops(state)
 if allow_missing and not matches:return None
 need(len(matches)==1,'Expected exactly one owned loop association')
 row=matches[0];need(re.fullmatch('/dev/loop[0-9]+',row['name']),'Unexpected loop device')
 if state.get('loop'):need(row['name']==state['loop'],'Loop identity changed')
 s=Path(row['name']).stat();need(stat.S_ISBLK(s.st_mode),'Loop is not a block device')
 dev=[os.major(s.st_rdev),os.minor(s.st_rdev)]
 if state.get('loopDevice'):need(dev==state['loopDevice'],'Loop major/minor changed')
 state.update(loop=row['name'],loopDevice=dev);save(state)
 return row

def mapping(state,allow_missing=False):
 if not os.path.lexists(MAPPER):
  if allow_missing:return None
  raise ValueError('Expected owned mapping is absent')
 loop=owned_loop(state);s=MAPPER.stat();need(stat.S_ISBLK(s.st_mode),'Mapper is not a block device')
 dev=[os.major(s.st_rdev),os.minor(s.st_rdev)];sys=Path('/sys/dev/block')/('%d:%d'%tuple(dev))
 need((sys/'dm/name').read_text().strip()==NAME,'Mapping name differs')
 need((sys/'dm/uuid').read_text().strip().startswith('CRYPT-PLAIN-'),'Not a plain crypt mapping')
 need([p.name for p in (sys/'slaves').iterdir()]==[Path(loop['name']).name],'Mapping is not over owned loop')
 if state.get('mapperDevice'):need(dev==state['mapperDevice'],'Mapper major/minor changed')
 state['mapperDevice']=dev;save(state);return dev

def mapped_swap(state,rows=None):
 dev=mapping(state,allow_missing=True)
 if dev is None:return None
 found=[]
 for row in (swaps() if rows is None else rows):
  try:s=Path(row['path']).stat()
  except FileNotFoundError:continue
  if stat.S_ISBLK(s.st_mode) and [os.major(s.st_rdev),os.minor(s.st_rdev)]==dev:found.append(row)
 need(len(found)<=1,'Ambiguous mapped swap identity');return found[0] if found else None

def active_inventory(state):
 rows=swaps();unchanged(state,rows)
 current=mapped_swap(state,rows)
 need(len(rows)==2 and current is not None,'Expected exactly original swap plus owned mapping')
 need(current['priority']==100,'Owned swap priority differs')
 need(current['sizeKiB']==(SIZE-os.sysconf('SC_PAGE_SIZE'))//1024,'Owned usable swap size differs')
 return current

def check_status(text):
 fields={m.group(1).strip():m.group(2).strip() for m in re.finditer(r'^\s+([^:\n]+):\s*(.*)$',text,re.M)}
 need(fields.get('type')=='PLAIN','Wrong mapping type')
 need(fields.get('cipher')==CIPHER,'Wrong runtime cipher; no fallback permitted')
 need(fields.get('keysize')=='256 bits','Wrong runtime key size')
 return fields

def cleanup(state):
 # Any failure leaves all not-yet-removed resources owned; never force the stack.
 idle();unchanged(state)
 if not BACKING.exists():
  need(state.get('phase')=='cleaned','Backing vanished before successful cleanup');return
 if os.path.lexists(MAPPER):
  current=mapped_swap(state)
  if current:
   mem={k:int(v.split()[0])*1024 for k,v in (line.split(':',1) for line in Path('/proc/meminfo').read_text().splitlines()) if v.split() and v.split()[0].isdigit()}
   existing=[x for x in swaps() if x['path']=='/swapfile'][0]
   available=mem['MemAvailable']+(existing['sizeKiB']-existing['usedKiB'])*1024-2*1024**3
   need(current['usedKiB']*1024<=max(0,available),'Insufficient safe evacuation capacity; keep encrypted swap attached')
   state['phase']='swapoff-started';save(state)
   run(state,['/usr/bin/timeout','--signal=TERM','--kill-after=5s','60s','/usr/sbin/swapoff',str(MAPPER)],timeout=75)
   need(mapped_swap(state) is None,'Owned swap still active; refuse close')
  mapping(state);run(state,['/usr/sbin/cryptsetup','close',NAME])
  need(not os.path.lexists(MAPPER),'Mapping remains after close')
 row=owned_loop(state,allow_missing=True)
 if row:
  run(state,['/usr/sbin/losetup','--detach',row['name']])
  deadline=time.monotonic()+10
  while matching_loops(state) and time.monotonic()<deadline:time.sleep(.1)
  need(not matching_loops(state),'Loop detach is deferred; keep backing file')
 need(not os.path.lexists(MAPPER),'Mapping unexpectedly exists')
 need(file_id(BACKING)==state['backingIdentity'],'Backing identity changed before unlink')
 BACKING.unlink();state['phase']='cleaned';unchanged(state);save(state)

def activate(approval_hash):
 need(not AREA.exists() and not os.path.lexists(MAPPER),'Owned resource name already exists')
 idle();baseline=settings();need(baseline=={'swappiness':'1','overcommit_memory':'0','overcommit_ratio':'50'},'Unexpected VM settings')
 old=swaps();need(len(old)==1 and old[0]['path']=='/swapfile' and old[0]['priority']==-2,'Unexpected existing swap inventory')
 need(shutil.disk_usage(ROOT).free>=SIZE+FLOOR+BUILD_HEADROOM,'Insufficient disk for64GiB swap,25GiB floor and32GiB build headroom')
 for parent in [ROOT,ROOT/'ephemeral-swap64']:
  if parent.exists():need(not parent.is_symlink() and parent.is_dir(),'Unsafe task parent')
 AREA.mkdir(parents=True,mode=0o700);AREA.chmod(0o700)
 original=Path('/swapfile').stat()
 state={'schemaVersion':1,'identity':IDENTITY,'executionSha256':EXECUTION_SHA256,'sourceCommit':SOURCE,'approvalSha256':approval_hash,'phase':'created','baselineSettings':baseline,'baselineSwap':old[0],'baselineSwapFileId':[original.st_dev,original.st_ino],'backing':str(BACKING),'mappingName':NAME,'cipher':CIPHER,'keyBytes':32,'swapBytes':SIZE,'commands':[],'appRun':False}
 save(state)
 try:
  fd=os.open(BACKING,os.O_CREAT|os.O_EXCL|os.O_WRONLY|os.O_NOFOLLOW,0o600);os.close(fd)
  state['backingIdentity']=file_id(BACKING);save(state)
  run(state,['/usr/bin/fallocate','--length',str(SIZE),str(BACKING)],timeout=120)
  state['backingIdentity']=file_id(BACKING);save(state)
  need(state['backingIdentity']['size']==SIZE and BACKING.stat().st_blocks*512>=SIZE,'Backing is not fully allocated64GiB')
  need(shutil.disk_usage(ROOT).free>=FLOOR+BUILD_HEADROOM,'Disk floor/build headroom violated after allocation')
  output=run(state,['/usr/sbin/losetup','--find','--show','--nooverlap','--direct-io=on',str(BACKING)])
  state['loop']=output.strip();save(state);loop=owned_loop(state)
  need(loop.get('dio') in [True,1,'1','true'],'Direct I/O did not activate; no fallback permitted')
  state['phase']='crypt-open-started';save(state)
  run(state,['/usr/sbin/cryptsetup','--batch-mode','--type','plain','--cipher',CIPHER,'--key-size','256','--hash','plain','--key-file','/dev/urandom','--keyfile-size','32','open',state['loop'],NAME])
  mapping(state);status=check_status(run(state,['/usr/sbin/cryptsetup','status',NAME]))
  need(status.get('device')==state['loop'],'Runtime cipher maps a different loop')
  need(int((Path('/sys/dev/block')/('%d:%d'%tuple(state['mapperDevice']))/'size').read_text())*512==SIZE,'Mapped size differs')
  run(state,['/usr/sbin/mkswap',str(MAPPER)])
  state['phase']='swapon-started';save(state)
  run(state,['/usr/sbin/swapon','--priority','100',str(MAPPER)])
  current=active_inventory(state)
  state.update(phase='active',mappedSwap=current);save(state);return state
 except BaseException as error:
  state.update(phase='activation-failed',error=type(error).__name__+': '+str(error));save(state)
  # Reconcile late effects by exact backing/name, never assume a failed command had no effect.
  try:
   if BACKING.exists():
    current=file_id(BACKING)
    old_id=state.get('backingIdentity',{})
    need(all(current.get(k)==old_id.get(k) for k in ['dev','ino']),'Backing inode changed on failed allocation')
    state['backingIdentity']=current;save(state);cleanup(state)
  except BaseException as cleanup_error:
   state.update(phase='cleanup-blocked',cleanupError=type(cleanup_error).__name__+': '+str(cleanup_error));save(state)
  raise

def approval(path,expected):
 need(digest(path)==expected,'Root activation approval hash differs');data=json.loads(path.read_text())
 required={'schemaVersion':1,'lane':'P6','decision':'activate-task-encrypted-swap','identity':IDENTITY,'executionSha256':EXECUTION_SHA256,'sourceCommit':SOURCE,'nativeRoot':str(ROOT),'swapBytes':SIZE,'cipher':CIPHER,'keyBytes':32,'preserveExistingSwap':True,'preserveVmSettings':True,'buildHeadroomBytes':BUILD_HEADROOM,'scriptSha256':digest(Path(__file__))}
 need(all(data.get(k)==v for k,v in required.items()),'Explicit root approval for these exact swap parameters required')
 return data

def main():
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('action',choices=['activate','cleanup']);p.add_argument('--execute',action='store_true');p.add_argument('--owner-idle-confirmed',action='store_true');p.add_argument('--workload-stopped-confirmed',action='store_true');p.add_argument('--approval',type=Path);p.add_argument('--approval-sha256');p.add_argument('--identity',type=Path,required=True);p.add_argument('--identity-sha256',required=True);a=p.parse_args()
 bind_identity(a.identity,a.identity_sha256)
 if not a.execute:
  print(json.dumps({'status':'plan-only','action':a.action,'cipher':CIPHER,'keyBytes':32,'swapBytes':SIZE,'resourceMutation':False,'rootApprovalRequired':True}));return
 need(Path(__file__).resolve()==owner_path(),'Execution-specific owner path required')
 need(platform.system()=='Linux' and platform.machine()=='x86_64' and os.geteuid()==0,'Native x64 privileged owner only')
 need(a.owner_idle_confirmed and a.approval and a.approval_sha256,'Explicit owner idle and actual root approval required')
 approval(a.approval,a.approval_sha256)
 need(all(Path(tool).is_file() and os.access(tool,os.X_OK) for tool in TOOLS),'Required installed tool missing')
 resource.setrlimit(resource.RLIMIT_CORE,(0,0))
 def interrupted(signum,frame):raise OwnerCancelled('Owner interrupted with signal '+str(signum))
 for sig in [signal.SIGINT,signal.SIGTERM,signal.SIGHUP]:signal.signal(sig,interrupted)
 if a.action=='activate':state=activate(a.approval_sha256)
 else:
  need(a.workload_stopped_confirmed,'Confirm workload and workers stopped before swapoff')
  state=json.loads(STATE.read_text());need(state.get('approvalSha256')==a.approval_sha256 and state.get('identity')==IDENTITY and state.get('executionSha256')==EXECUTION_SHA256,'Cleanup ownership differs')
  try:cleanup(state)
  except BaseException as error:
   state.update(phase='cleanup-blocked',cleanupError=type(error).__name__+': '+str(error));save(state);raise
 print('P6_ENCRYPTED_SWAP '+json.dumps({'phase':state['phase'],'state':str(STATE),'cipher':CIPHER,'swapBytes':SIZE,'appRun':False}),flush=True)

if __name__=='__main__':
 try:main()
 except Exception as error:
  print('P6_SWAP_FAILURE '+json.dumps({'stage':'operation' if STATE is not None and STATE.is_file() else 'pre-state','errorType':type(error).__name__,'error':str(error)[:1024]}),flush=True)
  raise SystemExit(1)
