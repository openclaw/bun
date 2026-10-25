#!/usr/bin/env python3
"""Linux only; collect direct-executable wall/CPU/peak RSS without asserting application correctness."""
import argparse, datetime, hashlib, json, math, os, pathlib, platform, signal, subprocess, time
p=argparse.ArgumentParser()
p.add_argument('--label',required=True)
p.add_argument('--out',required=True)
p.add_argument('--timeout',type=float,default=180)
p.add_argument('--cleanup-grace-seconds',type=float)
p.add_argument('command',nargs=argparse.REMAINDER)
a=p.parse_args()
cmd=a.command[1:] if a.command[:1]==['--'] else a.command
if platform.system()!='Linux' or not cmd: p.error('requires Linux and a command after --')
if a.cleanup_grace_seconds is not None and not (math.isfinite(a.cleanup_grace_seconds) and 0 < a.cleanup_grace_seconds <= 3600):
 p.error('cleanup grace must be finite and between 0 and 3600 seconds')
out=pathlib.Path(a.out).resolve()
out.mkdir(parents=True,exist_ok=False)
timefile=out/'time.txt'
exe=pathlib.Path(cmd[0])
receipt={'label':a.label,'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),
 'arch':platform.machine(),'kernel':platform.release(),'command':cmd,
 'executableSha256':hashlib.file_digest(exe.open('rb'),'sha256').hexdigest() if exe.is_file() else None,
 'scope':'GNU time -v command plus reaped descendants; not exclusive gateway CPU'}
def signal_group(pgid, sig):
 try: os.killpg(pgid,sig)
 except ProcessLookupError: pass

def live_group(pgid):
 # An orphaned zombie can retain the group ID under a non-reaping container
 # init; it has no work left to stop and must not trigger a false forced kill.
 for process in pathlib.Path('/proc').iterdir():
  if not process.name.isdigit():continue
  try: fields=(process/'stat').read_text().rsplit(') ',1)[1].split()
  except (FileNotFoundError,ProcessLookupError):continue
  if int(fields[2])==pgid and fields[0] not in ['Z','X']:return True
 return False

def stop_group(child, grace=5):
 # GNU time may exit on TERM while its workload ignores it. Keep group custody
 # for the full bounded grace, then send KILL independently of wrapper state.
 signal_group(child.pid,signal.SIGTERM)
 deadline=time.monotonic()+grace
 while time.monotonic()<deadline:
  child.poll()
  if not live_group(child.pid):break
  time.sleep(min(0.05,max(0,deadline-time.monotonic())))
 forced=live_group(child.pid)
 if forced:signal_group(child.pid,signal.SIGKILL)
 child.wait()
 return {'graceSeconds':grace,'forced':forced,'wrapperExitCode':child.returncode}

class MeasurementInterrupted(KeyboardInterrupt):
 def __init__(self, signum):
  self.signum=signum
  super().__init__('Runtime measurement interrupted by signal '+str(signum))

handlers={}
if a.cleanup_grace_seconds is not None:
 def interrupted(signum,frame):
  if 'interruptedBySignal' in receipt:return
  receipt['cancelled']=True
  receipt['interruptedBySignal']=signum
  raise MeasurementInterrupted(signum)
 handlers={sig:signal.signal(sig,interrupted) for sig in [signal.SIGINT,signal.SIGTERM,signal.SIGHUP]}

failure=None
def runtime_cleanup(child):
 # A repeated signal must not skip the first signal's bounded cleanup.
 def retain_signal(signum,frame):
  receipt['cancelled']=True
  receipt.setdefault('interruptedBySignal',signum)
 for sig in handlers:signal.signal(sig,retain_signal)
 return stop_group(child,a.cleanup_grace_seconds)

start=time.monotonic()
with (out/'stdout.txt').open('wb') as stdout, (out/'stderr.txt').open('wb') as stderr:
 try:
  child=subprocess.Popen(['/usr/bin/time','-v','-o',str(timefile),*cmd],stdout=stdout,stderr=stderr,start_new_session=True)
  try:
   receipt['exitCode']=child.wait(timeout=a.timeout)
  except subprocess.TimeoutExpired:
   receipt['timeout']=True
   if a.cleanup_grace_seconds is None:stop_group(child)
   else:receipt['cleanup']=runtime_cleanup(child)
   receipt['wrapperExitCode']=child.returncode
  except BaseException as error:
   if a.cleanup_grace_seconds is None:raise
   failure=error
   receipt['cancelled']=True
   receipt['error']=str(error)
   if isinstance(error,MeasurementInterrupted):receipt.setdefault('interruptedBySignal',error.signum)
   receipt['cleanup']=runtime_cleanup(child)
 finally:
  if 'child' in locals() and child.poll() is None:
   signal_group(child.pid,signal.SIGKILL)
   child.wait()
  for sig,handler in handlers.items():signal.signal(sig,handler)
receipt['observedWallSeconds']=time.monotonic()-start
if timefile.exists():
 for line in timefile.read_text().splitlines():
  line=line.strip()
  for key,label in [('User time (seconds):','userSeconds'),('System time (seconds):','systemSeconds'),('Maximum resident set size (kbytes):','peakRssKiB')]:
   if line.startswith(key): receipt[label]=float(line[len(key):].strip())
(out/'receipt.json').write_text(json.dumps(receipt,indent=2)+'\n')
print(json.dumps(receipt))
if failure is not None:raise failure
raise SystemExit(receipt.get('exitCode',124))
