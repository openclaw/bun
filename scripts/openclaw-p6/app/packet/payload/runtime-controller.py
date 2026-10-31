#!/usr/bin/env python3
"""One serial qualification of an actual R4 build; never builds OpenClaw or Bun."""
import argparse,datetime,hashlib,json,os,platform,shutil,signal,subprocess,sys,tarfile,time
from pathlib import Path
HERE=Path(__file__).resolve().parent
ROOT=Path('/home/runner/.cache/oc-ty-ext/P6/app-x64-final-r4-v1')
PHASES=['core','elf-floor','zero-js','node-vm','node-vm-native-workers','pty','plugin','teams-fetched','docker-image','docker-gateway-network','docker-kitchen-sink','docker-cron','guest-prerequisites','guest-security']
def require(ok,message):
 if not ok:raise ValueError(message)
def sha(p):
 with Path(p).open('rb') as f:return hashlib.file_digest(f,'sha256').hexdigest()
def read(p):return json.loads(Path(p).read_text())
def write(p,x):Path(p).write_text(json.dumps(x,indent=2)+'\n')
def live_group(child):
 if sys.platform!='linux':
  # The actual controller is Linux-only; local fixtures own a direct child.
  return child.poll() is None
 # A finished orphan may remain Z under a non-reaping container init.
 for process in Path('/proc').iterdir():
  if not process.name.isdigit():continue
  try:fields=(process/'stat').read_text().rsplit(') ',1)[1].split()
  except (FileNotFoundError,ProcessLookupError):continue
  if int(fields[2])==child.pid and fields[0] not in ['Z','X']:return True
 return False
def run_command(command,cwd,env,directory,timeout,cleanup_grace=15):
 cancelled=[];forced=False
 def interrupt(sig,frame):cancelled.append(sig)
 handlers={sig:signal.signal(sig,interrupt) for sig in [signal.SIGTERM,signal.SIGINT,signal.SIGHUP]};child=None;start=time.monotonic()
 try:
  with (directory/'command.stdout').open('wb') as stdout,(directory/'command.stderr').open('wb') as stderr:
   child=subprocess.Popen(list(map(str,command)),cwd=cwd,env=env,stdout=stdout,stderr=stderr,start_new_session=True)
   while child.poll() is None and not cancelled and time.monotonic()-start<timeout:time.sleep(.1)
   timed_out=child.poll() is None and not cancelled
 finally:
  if child is not None:
   try:os.killpg(child.pid,signal.SIGTERM)
   except ProcessLookupError:pass
   deadline=time.monotonic()+cleanup_grace
   while time.monotonic()<deadline:
    child.poll()
    if not live_group(child):break
    time.sleep(.1)
   forced=live_group(child)
   if forced:
    try:os.killpg(child.pid,signal.SIGKILL)
    except ProcessLookupError:pass
   child.wait()
  for sig,handler in handlers.items():signal.signal(sig,handler)
 require(child is not None,'Command did not launch')
 return {'exitCode':child.returncode,'cancelled':bool(cancelled),'interruptedBySignal':cancelled[0] if cancelled else None,'timeout':timed_out,'cleanupGraceSeconds':cleanup_grace,'forcedCleanup':forced,'wallSeconds':time.monotonic()-start}
def preserve_raw(paths,directory):
 files=[]
 for root in paths:
  if not root.exists():continue
  for p in sorted(root.rglob('*')):
   if 'artifact' in p.relative_to(root).parts:continue
   if p.is_file() and not p.is_symlink() and (p.suffix in ['.json','.jsonl','.txt','.log','.stdout','.stderr'] or '.trace.' in p.name or 'traces' in p.parts or p.name=='evidence.tar'):files.append(p)
 index=[]
 for p in sorted(set(files)):
  relative=str(p.relative_to(ROOT.parent)) if p.is_relative_to(ROOT.parent) else p.name
  index.append({'path':relative,'sha256':sha(p),'bytes':p.stat().st_size})
 write(directory/'raw-index.json',index);archive=directory/'raw-evidence.tar.gz'
 with tarfile.open(archive,'w:gz') as t:
  for p,row in zip(sorted(set(files)),index):t.add(p,arcname=row['path'],recursive=False)
  t.add(directory/'raw-index.json',arcname='raw-index.json',recursive=False)
 return {'path':str(archive),'sha256':sha(archive),'bytes':archive.stat().st_size,'files':len(index)}

class RecoveryInterrupted(Exception):pass

def main():
 os.umask(0o077);p=argparse.ArgumentParser(description=__doc__);p.add_argument('--variant',choices=['js','c2-off','ts'],required=True);p.add_argument('--phase',choices=PHASES,required=True);p.add_argument('--admission-sha256',required=True);a=p.parse_args()
 require(platform.system()=='Linux' and platform.machine()=='x86_64' and sys.version_info>=(3,12),'Native Linux x64/Python3.12 required')
 require(HERE==ROOT,'Fixed fresh app root required')
 for name,expected in read(ROOT/'manifest.json')['files'].items():require(sha(ROOT/name)==expected,'Staged preparation changed: '+name)
 admission=ROOT/'admissions'/(a.variant+'.json');require(sha(admission)==a.admission_sha256,'Actual admission changed');approved=read(admission)
 built=ROOT/'build-receipts'/a.variant/'result.json';build=read(built)
 require(approved['decision']=='build-linux' and approved['linuxCut']['commit']=='4fa442e332745f1f58ccedd27106abdafcf4e019','Actual R4 root build admission required')
 require(build['status']=='built-unsigned' and build['phase']=='complete' and build['plan']['admissionSha256']==a.admission_sha256,'Actual successful admitted build required')
 expected_variant='c2' if a.variant=='c2-off' else a.variant;require(build['plan']['variant']==expected_variant and build['plan']['compiler']['cohort']=='rd-p6-150c','Different variant/compiler cohort')
 artifact=Path(build['plan']['output']);require(artifact==ROOT/'artifacts'/a.variant,'Unexpected actual artifact path')
 facts=build['artifact'];binary_sha=facts['executable']['sha256'];manifest_sha=facts['manifestSha256']
 label=a.variant+'-'+a.phase;directory=ROOT/'runtime-results'/label;directory.mkdir(parents=True,exist_ok=False)
 proof=Path.cwd()/'.artifacts/P6-FINAL-R4-x64/runtime'/label;proof.mkdir(parents=True,exist_ok=False)
 record={'status':'started-not-qualified','phase':a.phase,'variant':a.variant,'sourceCommit':'4fa442e332745f1f58ccedd27106abdafcf4e019','binarySha256':binary_sha,'manifestSha256':manifest_sha,'actualBuildReceiptSha256':sha(built),'rootBuildAdmissionSha256':a.admission_sha256,'applicationBuildStarted':False,'compilerBuildStarted':False,'applicationQualified':False,'performanceEligible':False}
 write(directory/'result.json',record);write(proof/'result.json',record);print('P6_FINAL_D754_RUNTIME '+json.dumps(record),flush=True)
 env={'HOME':'/home/runner','PATH':'/usr/bin:/bin','TMPDIR':str(ROOT/'tmp'),'LANG':'C.UTF-8','TZ':'UTC','NO_COLOR':'1','CI':'1'}
 if a.phase in ['guest-prerequisites','guest-security']:env['PATH']+=':/usr/sbin:/sbin'
 raw=[directory];signal_state={'finalizing':False,'signal':None}
 def interrupted(signum,frame):
  signal_state['signal']=signum
  if not signal_state['finalizing']:raise RecoveryInterrupted('Qualification interrupted by signal '+str(signum))
 handlers={sig:signal.signal(sig,interrupted) for sig in [signal.SIGTERM,signal.SIGINT,signal.SIGHUP]}
 def run(command,timeout=600,gateway_owning=False,cleanup_grace=15):
  record['command']=list(map(str,command));write(directory/'result.json',record)
  grace=cleanup_grace
  if gateway_owning:
   budget=json.loads(subprocess.check_output([str(ROOT/'opt/node/bin/node'),str(ROOT/'qualification/harness/process-stop.mjs'),'--gateway-budget',str(ROOT/'source')],env=env,text=True,timeout=30))
   record['gatewayShutdownBudget']=budget
   # Gateway reap (5s), provider stop/reap (10s+5s), and final census (10s).
   grace=budget['serviceStopTimeoutMs']/1000+30
  measured=run_command(command,Path.cwd(),env,directory,timeout,grace);record['commandResult']=measured
  require(measured['exitCode']==0 and not measured['timeout'] and not measured['cancelled'] and not measured['forcedCleanup'],'Phase command failed; preserve raw evidence')
 try:
  guest=ROOT/'guest';image_receipt=ROOT/'qualification-results'/(a.variant+'-docker-image')/'result.json'
  if a.phase=='guest-prerequisites':
   output=ROOT/'guest-prerequisites/native';raw.append(output);run([sys.executable,'-B',guest/'guest-prerequisites.py','--out',output,'--install-and-download'],900)
  elif a.phase=='guest-security':
   guest_label=a.variant+'-mdwe';record['guestLabel']=guest_label
   prereq=ROOT/'guest-prerequisites/native/result.json';core=ROOT/'qualification-results'/(a.variant+'-core')/'run/result.json';raw.append(ROOT/'application-guest-runs'/guest_label)
   command=[sys.executable,'-B',guest/'prepare-guest.py','--artifact',artifact,'--binary-sha256',binary_sha,'--manifest-sha256',manifest_sha,'--build-receipt',built,'--build-receipt-sha256',sha(built),'--root-admission',admission,'--root-admission-sha256',a.admission_sha256,'--host-core-result',core,'--host-core-result-sha256',sha(core),'--prerequisites',prereq,'--prerequisites-sha256',sha(prereq),'--label',guest_label]
   planned=subprocess.run(list(map(str,command)),env=env,capture_output=True,text=True,timeout=300);record['commandResult']={'exitCode':planned.returncode,'timeout':False};(directory/'guest-plan.stdout').write_text(planned.stdout);(directory/'guest-plan.stderr').write_text(planned.stderr);require(planned.returncode==0,'Guest input validation failed')
   plan=json.loads(planned.stdout);require(plan['status']=='prepared-not-authorized-to-execute','Guest renderer did not produce a plan');script=directory/'guest.sh';script.write_text(plan['guestShell']);run(['/bin/bash',script],900)
  elif a.phase=='docker-cron':
   output=ROOT/'qualification-results'/label;raw.append(output);run(['/bin/bash',ROOT/'cron-fixture/run-native.sh',artifact,image_receipt,output],600)
  else:
   output=ROOT/'qualification-results'/label;raw.append(output)
   command=[sys.executable,'-B',ROOT/'qualification/qualify.py','--artifact',artifact,'--binary-sha256',binary_sha,'--manifest-sha256',manifest_sha,'--build-receipt',built,'--build-receipt-sha256',sha(built),'--lane',a.phase,'--out',output,'--run']
   if a.phase.startswith('docker-') and a.phase!='docker-image':command+=['--docker-image-receipt',image_receipt]
   if a.phase=='teams-fetched':
    budget=read(ROOT/'qualification/teams-fetched/budget.json')
    run(command,budget['phaseSeconds'],cleanup_grace=budget['phaseCleanupSeconds'])
   else:
    run(command,1200 if a.phase=='docker-image' else 600,gateway_owning=a.phase in ['core','zero-js','node-vm','node-vm-native-workers','pty'])
   if a.phase=='elf-floor':record['abi']=read(output/'elf-floor.json')
   elif a.phase=='docker-image':require(read(output/'result.json')['status']=='PASS','Docker image failed')
   elif not a.phase.startswith('docker-'):
    result=read(output/'run/result.json');require(result['qualification']=='passed' if a.phase in ['core','zero-js'] else result['pass'] is True,'Owning runtime result failed');record['runtimeOwnerPass']=True
  record['status']='phase-passed'
 except BaseException as error:
  record.update(status='phase-failed',error=type(error).__name__+': '+str(error))
  if isinstance(error,subprocess.TimeoutExpired):record['commandResult']={'exitCode':None,'timeout':True}
 finally:
  signal_state['finalizing']=True;write(directory/'result.json',record)
  try:record['rawEvidence']=preserve_raw(raw,directory)
  except Exception as error:record.update(preservationError=str(error),status='phase-failed')
  if signal_state['signal'] is not None:record.update(status='phase-interrupted',signal=signal_state['signal'])
  write(directory/'result.json',record);write(proof/'result.json',record);print('P6_FINAL_D754_RUNTIME '+json.dumps(record),flush=True)
  for sig,handler in handlers.items():signal.signal(sig,handler)
 if signal_state['signal'] is not None:return 128+signal_state['signal']
 measured=record.get('commandResult',{})
 if measured.get('interruptedBySignal') is not None:return 128+measured['interruptedBySignal']
 if measured.get('timeout'):return 124
 code=measured.get('exitCode')
 if code is not None and code<0:return 128-code
 if code is not None and (code==124 or code>=128):return code
 return 0 if record['status']=='phase-passed' else 1
if __name__=='__main__':raise SystemExit(main())
