#!/usr/bin/env python3
"""Actual app CLI and native memory probes in its main JS context; no policy injection."""
from pathlib import Path
import hashlib,importlib.util,json,os,platform,re,shutil,signal,stat,subprocess,traceback

def module(path,name):
 spec=importlib.util.spec_from_file_location(name,path);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m

def main():
 os.umask(0o077)
 payload=Path('/mnt/p6');manifest=json.loads((payload/'manifest.json').read_text());work=Path('/var/tmp/p6-application-security');work.mkdir(exist_ok=False);binary=payload/'artifact/openclaw'
 report={**manifest,'kernel':platform.release(),'arch':platform.machine(),'pass':False,'applicationQualification':False,'qualificationKind':'application-main-memory-policy','performanceEligible':False,'scope':'Actual app main-thread anonymous RWX/RW-to-RX denial, allowed file-backed RX; no universal executable-memory claim','commands':[],'traces':{}}
 try:
  version=re.match(r'^(\d+)\.(\d+)',platform.release())
  if platform.machine()!='x86_64' or not version or tuple(map(int,version.groups()))<(6,7):raise RuntimeError('Requires Linux x64 kernel >=6.7')
  if hashlib.file_digest(binary.open('rb'),'sha256').hexdigest()!=manifest['binarySha256']:raise RuntimeError('Application binary differs')
  fixture_bytes={}
  for name,expected in manifest['controlFiles'].items():
   raw=(payload/'security'/name).read_bytes()
   if hashlib.sha256(raw).hexdigest()!=expected:raise RuntimeError('Control file differs: '+name)
   if name.startswith('fixture/'):fixture_bytes[name]=raw
  strace=shutil.which('strace')
  if not strace:raise RuntimeError('Pinned guest strace absent')
  report['straceVersion']=subprocess.run([strace,'--version'],capture_output=True,text=True,check=True).stdout.splitlines()[0]
  for name in ['home','tmp','xdg','state','workspace']:(work/name).mkdir()
  # mkfs -d preserves host ownership; the guest owns its verified fixture copy.
  fixture=work/'fixture';fixture.mkdir(mode=0o700)
  for name in ['package.json','openclaw.plugin.json','index.js']:
   (fixture/name).write_bytes(fixture_bytes['fixture/'+name])
  def path_identity(path):
   info=path.stat()
   return {'path':str(path),'uid':info.st_uid,'gid':info.st_gid,'mode':oct(stat.S_IMODE(info.st_mode))}
  report['fixtureAdmission']={'effectiveUid':os.geteuid(),'umask':'0077',
   'payload':[path_identity(payload/'security/fixture'),path_identity(payload/'security/fixture/index.js')],
   'owned':[path_identity(fixture),path_identity(fixture/'index.js')],
   'copiedFileSha256':{name:manifest['controlFiles']['fixture/'+name] for name in ['package.json','openclaw.plugin.json','index.js']}}
  cfg={'gateway':{'mode':'local','bind':'loopback','port':33189,'auth':{'mode':'token','token':'p6-synthetic-mdwe'},'controlUi':{'enabled':False}},'agents':{'defaults':{'workspace':str(work/'workspace'),'skipBootstrap':True,'utilityModel':''},'entries':{'main':{}}},'browser':{'enabled':False},'update':{'checkOnStart':False},'plugins':{'enabled':True,'allow':['p6-mdwe-fixture'],'load':{'paths':[str(fixture)]},'entries':{'p6-mdwe-fixture':{'enabled':True}}}}
  (work/'state/openclaw.json').write_text(json.dumps(cfg,indent=2)+'\n')
  env={'PATH':'/usr/bin:/bin','HOME':str(work/'home'),'USERPROFILE':str(work/'home'),'OPENCLAW_HOME':str(work/'home'),'OPENCLAW_STATE_DIR':str(work/'state'),'OPENCLAW_CONFIG_PATH':str(work/'state/openclaw.json'),'OPENCLAW_TEST_WORKSPACE_DIR':str(work/'workspace'),'TMPDIR':str(work/'tmp'),'XDG_CONFIG_HOME':str(work/'xdg'),'OPENCLAW_NO_RESPAWN':'1','OPENCLAW_DISABLE_BONJOUR':'1','OPENCLAW_NO_AUTO_UPDATE':'1','LANG':'C.UTF-8','TZ':'UTC','NO_COLOR':'1','P6_EXPECT_MDWE':str(manifest['expectedMdwe'])}
  def run(label,argv,prefix):
   command=[strace,'-ff','-yy','-s','256','-e','trace=execve,prctl,mmap,mprotect,pkey_mprotect,memfd_create,ftruncate,write,munmap,exit_group','-o',str(work/prefix),str(binary),*argv]
   row={'label':label,'command':command};report['commands'].append(row)
   with (work/(label+'.stdout')).open('wb') as stdout,(work/(label+'.stderr')).open('wb') as stderr:
    child=subprocess.Popen(command,cwd=work,env=env,stdout=stdout,stderr=stderr,start_new_session=True)
    try:row['exitCode']=child.wait(timeout=180)
    except subprocess.TimeoutExpired:
     os.killpg(child.pid,signal.SIGTERM)
     try:child.wait(timeout=5)
     except subprocess.TimeoutExpired:os.killpg(child.pid,signal.SIGKILL);child.wait(timeout=5)
     raise RuntimeError('Actual application command timed out: '+label)
   row['stdout']=(work/(label+'.stdout')).read_text();row['stderr']=(work/(label+'.stderr')).read_text()
   traces={f.name:f.read_text() for f in sorted(work.glob(prefix+'.*'))};report['traces'].update(traces)
   if row['exitCode']!=0:raise RuntimeError('Actual application command failed: '+label)
   return row,traces
  analyzer=module(payload/'trace-policy.py','trace_policy')
  row,traces=run('version',['--version'],'version.trace')
  if row['stdout'].strip()!=manifest['expectedStdout'].strip():raise RuntimeError('Version differs from actual host result')
  report['versionPolicy']=analyzer.analyze(traces,str(binary),manifest['expectedMdwe'])
  row,traces=run('memory',['p6-mdwe'],'app.trace')
  report['policy']=analyzer.analyze(traces,str(binary),manifest['expectedMdwe'])
  rows=[json.loads(line[len('P6_MDWE_RESULT '):]) for line in row['stdout'].splitlines() if line.startswith('P6_MDWE_RESULT ')]
  if len(rows)!=1:raise RuntimeError('Expected exactly one actual main-context probe row')
  trace=report['policy']['trace']
  if trace!='app.trace.'+str(rows[0]['pid']):raise RuntimeError('Probe PID differs from direct application trace')
  report['memoryPolicy']=module(payload/'memory-policy.py','memory_policy').analyze(traces[trace],rows[0],report['policy'],str(binary))
  report['pass']=True
 except Exception as error:report['error']=str(error);report['traceback']=traceback.format_exc()
 finally:
  report['traces']={f.name:f.read_text() for f in sorted(work.glob('*.trace.*'))}
  (work/'result.json').write_text(json.dumps(report,indent=2)+'\n');print('P6_GUEST_RESULT '+json.dumps(report),flush=True)
 return 0 if report['pass'] else 1
if __name__=='__main__':raise SystemExit(main())
