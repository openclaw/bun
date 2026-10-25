#!/usr/bin/env python3
"""Prepare final native source/runtime only. This helper cannot launch standalone compilation."""
import argparse,datetime,hashlib,json,os,platform,runpy,shlex,shutil,signal,subprocess,sys,tarfile,urllib.request
from pathlib import Path

CUT='59baf4a051665750eb7055d0cec991d9876526df'
PHASES=['clone','toolchain','install','runtime','boundary','plugins']


def sha(path,kind='sha256'):
 h=hashlib.new(kind)
 with Path(path).open('rb') as f:
  for block in iter(lambda:f.read(1024*1024),b''):h.update(block)
 return h.hexdigest()


def load(path):return json.loads(Path(path).read_text())
class PrepInterrupted(Exception):pass

def interrupted(signum,frame):raise PrepInterrupted(f'Interrupted by signal {signum}')


def main():
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('--root',type=Path,required=True);p.add_argument('--phase',choices=PHASES,required=True);a=p.parse_args()
 root=a.root.resolve()
 if platform.system()!='Linux' or platform.machine()!='x86_64' or sys.version_info<(3,12):p.error('Native Linux x64 with Python>=3.12 required')
 if root!=Path.home()/'.cache/oc-ty-ext/P6/app-x64-final-r3-v1':p.error('Use the fresh owner root app-x64-final-r3-v1')
 manifest=load(root/'manifest.json')
 for name,expected in manifest['files'].items():
  if sha(root/name)!=expected:p.error('Staged input changed: '+name)
 if shutil.disk_usage(root).free<25_000_000_000:p.error('Less than25GB free')
 index=PHASES.index(a.phase)
 if index and load(root/'prep-receipts'/PHASES[index-1]/'result.json')['status']!='PASS':p.error('Previous preparation phase must pass')
 receipt=root/'prep-receipts'/a.phase;receipt.mkdir(parents=True,exist_ok=False)
 source=root/'source';reference=load(root/'admission-inputs/source-preparation.json')
 env={'HOME':str(root/'home'),'TMPDIR':str(root/'tmp'),'PATH':f'{root}/opt/node/bin:{root}/opt/bin:/usr/local/bin:/usr/bin:/bin','LANG':'C.UTF-8','LC_ALL':'C.UTF-8','CI':'1','NO_COLOR':'1','NODE_DISABLE_COMPILE_CACHE':'1','UV_THREADPOOL_SIZE':'2','XDG_CACHE_HOME':str(root/'cache'),'PNPM_HOME':str(root/'opt/bin'),'NPM_CONFIG_CACHE':str(root/'cache/npm'),'NPM_CONFIG_USERCONFIG':'/dev/null','NPM_CONFIG_GLOBALCONFIG':'/dev/null','GIT_CONFIG_GLOBAL':'/dev/null','GIT_CONFIG_SYSTEM':'/dev/null','GIT_TERMINAL_PROMPT':'0','GIT_ASKPASS':'/bin/false','SSH_ASKPASS':'/bin/false','OPENCLAW_STATE_DIR':str(root/'state'),'OPENCLAW_CONFIG_PATH':str(root/'state/openclaw.json'),'OPENCLAW_NO_RESPAWN':'1'}
 for name in ['home','tmp','cache','state','downloads','opt']: (root/name).mkdir(exist_ok=True)
 result={'phase':a.phase,'status':'FAIL','started':datetime.datetime.now(datetime.timezone.utc).isoformat(),'sourceCommit':CUT,'applicationBuildStarted':False,'aotAdmitted':False,'commands':[]}
 node=root/'opt/node/bin/node';pnpm=root/'opt/pnpm/bin/pnpm.mjs'
 def probe(args):return subprocess.check_output(list(map(str,args)),cwd=source,env=env,text=True,timeout=60).strip()
 def source_ok():
  assert probe(['git','rev-parse','HEAD'])==CUT
  assert not probe(['git','status','--porcelain','--untracked-files=no'])
  for name,expected in reference['files'].items():assert sha(source/name)==expected,name
 def run(label,command,cwd,timeout=3600):
  result['commands'].append({'label':label,'command':list(map(str,command))})
  oldargv,oldenv,oldcwd=sys.argv,dict(os.environ),Path.cwd()
  handlers={sig:signal.signal(sig,interrupted) for sig in [signal.SIGINT,signal.SIGTERM,signal.SIGHUP]}
  try:
   sys.argv=[str(root/'measure-command.py'),'--label',label,'--out',str(receipt/label),'--timeout',str(timeout),'--',*map(str,command)]
   os.environ.clear();os.environ.update(env);os.chdir(cwd)
   try:runpy.run_path(root/'measure-command.py',run_name='__main__')
   except SystemExit as done:
    if done.code not in [None,0]:raise RuntimeError(f'{label} failed with exit {done.code}')
  finally:
   os.chdir(oldcwd);os.environ.clear();os.environ.update(oldenv);sys.argv=oldargv
   for sig,handler in handlers.items():signal.signal(sig,handler)
 outer_handlers={sig:signal.signal(sig,interrupted) for sig in [signal.SIGINT,signal.SIGTERM,signal.SIGHUP]}
 try:
  if a.phase=='clone':
   assert not source.exists()
   run('clone',['/usr/bin/nice','-n','10','git','clone','--no-checkout','--depth=512','--single-branch','--branch','main','--no-tags','https://github.com/openclaw/openclaw.git',source],root,1800)
   # Fetch the frozen cut explicitly as well, so main advancement cannot select a different checkout.
   run('fetch-cut',['git','fetch','--depth=512','--no-tags','origin',CUT],source,1800)
   run('checkout',['git','checkout','--detach',CUT],source,1800)
   source_ok()
   assert not (source/'.git/objects/info/alternates').exists()
   assert not any((source/'.git/objects/pack').glob('*.promisor'))
   assert len(reference['linuxCut']['requiredAncestors'])==28
   for ancestor in reference['linuxCut']['requiredAncestors']:
    subprocess.run(['git','merge-base','--is-ancestor',ancestor,CUT],cwd=source,env=env,check=True,timeout=60)
   main_sha=probe(['git','rev-parse','refs/remotes/origin/main'])
   subprocess.run(['git','merge-base','--is-ancestor',CUT,main_sha],cwd=source,env=env,check=True,timeout=60)
   result['nativeSource']={'commit':CUT,'mainRef':'refs/remotes/origin/main','mainRefSha':main_sha,'requiredAncestors':reference['linuxCut']['requiredAncestors'],'externalAlternates':False,'shallow':probe(['git','rev-parse','--is-shallow-repository'])}
  else:
   source_ok()
   if a.phase=='toolchain':
    assert not (root/'opt/node').exists() and not (root/'opt/pnpm').exists()
    name='node-v26.12.1-linux-x64.tar.xz';base='https://nodejs.org/dist/v26.12.1/'
    with urllib.request.urlopen(base+'SHASUMS256.txt',timeout=30) as f:lines=f.read().decode().splitlines()
    expected=[line.split()[0] for line in lines if line.split()[-1]==name];assert len(expected)==1
    archive=root/'downloads'/name
    with urllib.request.urlopen(base+name,timeout=30) as f,archive.open('xb') as target:shutil.copyfileobj(f,target)
    assert sha(archive)==expected[0]
    unpack=root/'downloads/node-unpack';unpack.mkdir()
    with tarfile.open(archive) as t:t.extractall(unpack,filter='data')
    (unpack/'node-v26.12.1-linux-x64').rename(root/'opt/node')
    assert probe([node,'--version'])=='v26.12.1'
    manager=load(source/'package.json')['packageManager'];prefix='pnpm@12.15.0+sha512.';assert manager.startswith(prefix)
    archive=root/'downloads/pnpm-12.15.0.tgz'
    with urllib.request.urlopen('https://registry.npmjs.org/pnpm/-/pnpm-12.15.0.tgz',timeout=30) as f,archive.open('xb') as target:shutil.copyfileobj(f,target)
    assert sha(archive,'sha512')==manager[len(prefix):]
    unpack=root/'downloads/pnpm-unpack';unpack.mkdir()
    with tarfile.open(archive) as t:t.extractall(unpack,filter='data')
    (unpack/'package').rename(root/'opt/pnpm');(root/'opt/bin').mkdir()
    launcher=root/'opt/bin/pnpm'
    launcher.write_text(f'#!/bin/sh\nexec {shlex.quote(str(node))} {shlex.quote(str(pnpm))} "$@"\n')
    launcher.chmod(0o755)
    assert probe([node,pnpm,'--version'])=='12.15.0'
    assert probe(['pnpm','--version'])=='12.15.0'
    native=root/'opt/pnpm/pnpm-native'
    with native.open('rb') as stream:header=stream.read(20)
    assert header[:6]==b'\x7fELF\x02\x01' and int.from_bytes(header[18:20],'little')==62
    result['buildNode']={'path':str(node),'sha256':sha(node),'version':'26.12.1'}
    result['pnpm']={'path':str(pnpm),'sha256':sha(pnpm),'version':'12.15.0','archiveSha512':sha(archive,'sha512'),'nativeSha256':sha(native),'nativeResolution':'official pnpm.mjs + placeholder; signature/integrity checks unchanged'}
   elif a.phase=='install':run('frozen-install',['/usr/bin/nice','-n','10',node,pnpm,'install','--frozen-lockfile'],source,3600)
   elif a.phase=='runtime':
    run('pnpm-build',['/usr/bin/nice','-n','10',node,pnpm,'build'],source,7200)
    assert load(source/'dist/build-info.json')['commit']==CUT
    result['distBuildInfoSha256']=sha(source/'dist/build-info.json')
   elif a.phase=='boundary':run('ts-boundary',['/usr/bin/nice','-n','10',node,'--import','./scripts/tsx.mjs','scripts/prepare-extension-package-boundary-artifacts.mts'],source,3600)
   elif a.phase=='plugins':
    compiler=root/'compilers/standard/bun';records=load(root/'admission-inputs/compiler-records.json')
    assert records['status']=='native-compilers-adopted-not-app-admitted' and sha(compiler)==records['cb-standard']['sha256']
    run('select-plugins',['/usr/bin/nice','-n','10',compiler,'--no-env-file','--no-install',root/'build-prep/select-plugins.mjs',source,root/'admission-inputs/plugins'],source,1800)
    result['plugins']={name:sha(root/'admission-inputs/plugins'/name) for name in ['desktop.json','all.json','plugin-selection.json']}
    result['buildNode']=load(root/'prep-receipts/toolchain/result.json')['buildNode']
    result['nativeSource']=load(root/'prep-receipts/clone/result.json')['nativeSource']
    result['distBuildInfoSha256']=sha(source/'dist/build-info.json')

   source_ok()
  result['status']='PASS'
 except Exception as error:result['error']=f'{type(error).__name__}: {error}'
 finally:
  result['finished']=datetime.datetime.now(datetime.timezone.utc).isoformat()
  (receipt/'result.json').write_text(json.dumps(result,indent=2)+'\n')
  for sig,handler in outer_handlers.items():signal.signal(sig,handler)
 print('P6_FINAL_NATIVE_PREP '+json.dumps(result),flush=True)
 return 0 if result['status']=='PASS' else 1

if __name__=='__main__':raise SystemExit(main())
