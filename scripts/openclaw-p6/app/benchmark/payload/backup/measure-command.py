#!/usr/bin/env python3
"""Linux only; collect direct-executable wall/CPU/peak RSS without asserting application correctness."""
import argparse, datetime, hashlib, json, os, pathlib, platform, signal, subprocess, time
p=argparse.ArgumentParser()
p.add_argument('--label',required=True)
p.add_argument('--out',required=True)
p.add_argument('--timeout',type=float,default=180)
p.add_argument('command',nargs=argparse.REMAINDER)
a=p.parse_args()
cmd=a.command[1:] if a.command[:1]==['--'] else a.command
if platform.system()!='Linux' or not cmd: p.error('requires Linux and a command after --')
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

def stop_group(child, grace=5):
 # GNU time may exit on TERM while its workload ignores it. Keep group custody
 # for the full bounded grace, then send KILL independently of wrapper state.
 signal_group(child.pid,signal.SIGTERM)
 deadline=time.monotonic()+grace
 while time.monotonic()<deadline:
  try: os.killpg(child.pid,0)
  except ProcessLookupError: break
  time.sleep(min(0.05,max(0,deadline-time.monotonic())))
 signal_group(child.pid,signal.SIGKILL)
 child.wait()

start=time.monotonic()
with (out/'stdout.txt').open('wb') as stdout, (out/'stderr.txt').open('wb') as stderr:
 try:
  child=subprocess.Popen(['/usr/bin/time','-v','-o',str(timefile),*cmd],stdout=stdout,stderr=stderr,start_new_session=True)
  try:
   receipt['exitCode']=child.wait(timeout=a.timeout)
  except subprocess.TimeoutExpired:
   receipt['timeout']=True
   stop_group(child)
   receipt['wrapperExitCode']=child.returncode
 finally:
  if 'child' in locals() and child.poll() is None:
   signal_group(child.pid,signal.SIGKILL)
   child.wait()
receipt['observedWallSeconds']=time.monotonic()-start
if timefile.exists():
 for line in timefile.read_text().splitlines():
  line=line.strip()
  for key,label in [('User time (seconds):','userSeconds'),('System time (seconds):','systemSeconds'),('Maximum resident set size (kbytes):','peakRssKiB')]:
   if line.startswith(key): receipt[label]=float(line[len(key):].strip())
(out/'receipt.json').write_text(json.dumps(receipt,indent=2)+'\n')
print(json.dumps(receipt))
raise SystemExit(receipt.get('exitCode',124))
