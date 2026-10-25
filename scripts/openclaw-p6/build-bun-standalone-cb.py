#!/usr/bin/env python3
"""One native CB compiler profile; caller owns the lease and heavy-work slot."""
import argparse
import datetime
import json
import os
from pathlib import Path
import platform
import shutil
import signal
import subprocess
import sys
import time
sys.dont_write_bytecode = True
from source_files import digest, verify_files
from compiler_resources import CompilerResources
from deadline_process import run_bounded, stop_group

PROFILES = {
    'cb-standard': ('build-standard', 'on', False),
    'cb-compat': ('build-c2', 'off', False),
}


class BuildInterrupted(Exception):
    def __init__(self, signum):
        self.signum = signum


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--root',type=Path,required=True)
    p.add_argument('--profile',choices=PROFILES,required=True)
    p.add_argument('--lease-deadline-epoch',type=float,required=True)
    a=p.parse_args();root=a.root.resolve()
    if platform.system()!='Linux' or platform.machine()!='x86_64': p.error('Native Linux x64 required')
    source=json.loads((root/'source-ready.json').read_text())
    bootstrap=json.loads((root/'receipts/bootstrap.json').read_text())
    if source['bun']!='150c9620c53710060186b8b0cd50985e035408b0' or source['webkit']!='aaa690bfbf34c9d50775716ac2fc3c7d0573e0b8' or bootstrap['source']!=source: p.error('Wrong source/bootstrap pins')
    verify_files(root/'bun',json.loads((root/'bun-inputs.json').read_text())['targetManifest'])
    verify_files(root/'WebKit',json.loads((root/'webkit-inputs.json').read_text())['manifest'])
    if shutil.disk_usage(root).free<25_000_000_000: p.error('Less than25GB free')
    mem=dict(line.split(':',1) for line in Path('/proc/meminfo').read_text().splitlines())
    if int(mem['MemTotal'].split()[0])*1024<30_000_000_000: p.error('Use the preserved >=30GB high-memory native profile')
    build_dir,shadow,hardened=PROFILES[a.profile]
    if (root/build_dir/'bun').exists(): p.error('Existing compiler output; inspect and resume deliberately, do not overwrite')
    receipt_path=root/'receipts'/f'{a.profile}-build.json'
    if receipt_path.exists(): p.error('Existing build attempt receipt; keep it and choose an explicit recovery workflow')
    env={
        'HOME':str(root/'home'),'TMPDIR':str(root/'tmp'),'LANG':'C.UTF-8',
        'PATH':f'{root}/opt/bun-linux-x64-baseline:{root}/opt/llvm/bin:{root}/home/.cargo/bin:/usr/local/bin:/usr/bin:/bin',
        'CARGO_HOME':str(root/'home/.cargo'),'RUSTUP_HOME':str(root/'home/.rustup'),'RUSTUP_TOOLCHAIN':'nightly-2026-09-15',
        'LD_LIBRARY_PATH':str(root/'opt/llvm-runtime/usr/lib/x86_64-linux-gnu'),
        'BUN_WEBKIT_PATH':str(root/'WebKit'),'BUN_ICU_ROOT':str(root/'opt/icu-static'),
        'BUN_ICU_SOURCES':str(root/'downloads/icu4c-78.3-sources.tgz'),
        'LINUX_GLIBC_SYSROOT':str(root/'opt/linux-sysroot-glibc-amd64'),
        'BUN_BUILD_CACHE_DIR':str(root/'build-cache'),'BUN_INSTALL_CACHE_DIR':str(root/'bun-install-cache'),
        'XDG_CACHE_HOME':str(root/'home/.cache'),'GIT_SHA':source['bun'],
    }
    compiler_bootstrap=root/'opt/bun-linux-x64-baseline/bun'
    command=['/usr/bin/time','-v','-o',str(root/'receipts'/f'{a.profile}-time.txt'),'/usr/bin/nice','-n','10',str(compiler_bootstrap),'scripts/build.ts','--profile=release-local',f'--webkit-version={source["webkit"]}',f'--build-dir={root/build_dir}','--relr=off','--aot=on','--trimmable=on',f'--shadow-realm={shadow}','--baseline=on','--target=bun','-j2']
    if hardened: command.append('--hardened=on')
    receipt={'status':'running','profile':a.profile,'source':source,'command':command,'started':datetime.datetime.now(datetime.timezone.utc).isoformat(),'measurementScope':'GNUtime maximum single descendant RSS plus1s sampled descendant/process-group RSS and existing-cgroup raw memory; none is automatically a task peak','experiment':'existing-high-memory-j2-compiler-only-not-application-fit','memoryFitQualified':False}
    receipt_path.write_text(json.dumps(receipt,indent=2)+'\n')
    remaining=a.lease_deadline_epoch-time.time()
    fit={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'leaseDeadlineEpoch':a.lease_deadline_epoch,'remainingSeconds':remaining,'reservedCaptureCleanupSeconds':300,'minimumBuildWindowSeconds':1860,'minimumCompileWindowSeconds':1800,'postBuildWindowSeconds':60,'maximumBuildSeconds':2700,'fits':2160<=remaining<=14400,'memoryFitQualified':False}
    (root/'receipts'/f'{a.profile}-fit.json').write_text(json.dumps(fit,indent=2)+'\n')
    if not fit['fits']:
        receipt.update(status='declined-before-build',exitCode=2,timeBudget=fit)
        receipt_path.write_text(json.dumps(receipt,indent=2)+'\n')
        p.error('Decline before build: need1800s compile+60s postbuild window plus300s capture/cleanup within verified240min job')
    build_deadline_epoch=time.time()+min(2700,remaining-300)
    fit['buildDeadlineEpoch']=build_deadline_epoch
    receipt['timeBudget']=fit
    receipt['resourcesBefore']=CompilerResources(root/'receipts'/f'{a.profile}-unused-before.jsonl',os.getpid()).sample()
    receipt_path.write_text(json.dumps(receipt,indent=2)+'\n')
    start=time.monotonic()
    stop_at=start+max(0,build_deadline_epoch-time.time()-60)
    signals=[signal.SIGINT,signal.SIGTERM,signal.SIGHUP]
    old_handlers={sig:signal.getsignal(sig) for sig in signals}
    def interrupt(signum,frame): raise BuildInterrupted(signum)
    for sig in signals: signal.signal(sig,interrupt)
    code=1
    resources=None
    try:
        with (root/'receipts'/f'{a.profile}-build.log').open('wb') as log:
            child=subprocess.Popen(command,cwd=root/'bun',env=env,stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
            try:
                resources=CompilerResources(root/'receipts'/f'{a.profile}-resources.jsonl',child.pid)
                resources.start()
                while True:
                    try:
                        code=child.wait(timeout=min(30,max(0.001,stop_at-time.monotonic())));break
                    except subprocess.TimeoutExpired:
                        if time.monotonic()>=stop_at:
                            code=124
                            receipt['timedOutBeforeCleanupReserve']=True
                            break
                        print(json.dumps({'profile':a.profile,'elapsedSeconds':round(time.monotonic()-start),'log':str(root/'receipts'/f'{a.profile}-build.log')}),flush=True)
            finally:
                for sig in signals: signal.signal(sig,signal.SIG_IGN)
                stop_group(child)
                if resources is not None:
                    receipt['resources']=resources.finish()
    except BuildInterrupted as interrupted:
        code=128+interrupted.signum
        receipt['interruptedBySignal']=interrupted.signum
    except Exception as error:
        receipt['launcherError']=f'{type(error).__name__}: {error}'
    finally:
        for sig,handler in old_handlers.items(): signal.signal(sig,handler)
    receipt.update(status='build-command-finished-not-qualified',exitCode=code,finished=datetime.datetime.now(datetime.timezone.utc).isoformat())
    if 'interruptedBySignal' in receipt: receipt['status']='interrupted-not-qualified'
    receipt_path.write_text(json.dumps(receipt,indent=2)+'\n')
    if code: raise SystemExit(code)
    compiler=root/build_dir/'bun'
    def probe(name, command, output_file=None):
        with output_file.open('wb') if output_file else open(os.devnull, 'wb') as output:
            measured, timing=run_bounded(command, deadline_epoch=build_deadline_epoch,
                reserve_seconds=0, cleanup_grace=5, env=env,
                stdout=output if output_file else subprocess.PIPE, stderr=subprocess.STDOUT)
        receipt.setdefault('postBuildProbes',[]).append({'name':name,**timing})
        if measured.returncode:
            raise subprocess.CalledProcessError(measured.returncode,command)
        return measured.stdout.decode().strip() if measured.stdout is not None else ''
    try:
        revision=probe('revision',[compiler,'--revision'])
        if '150c9620c' not in revision: raise RuntimeError('Fresh compiler revision mismatch')
        versions=json.loads(probe('versions',[compiler,'-p','JSON.stringify({webkit:process.versions.webkit,arch:process.arch,platform:process.platform})']))
        if versions!={'webkit':source['webkit'],'arch':'x64','platform':'linux'}: raise RuntimeError('Fresh compiler platform/WebKit mismatch')
        receipt.update(compiler=str(compiler),compilerSha256=digest(compiler),revision=revision,versions=versions)
        (root/'receipts'/f'{a.profile}.sha256').write_text(receipt['compilerSha256']+'  '+str(compiler)+'\n')
        for name,cmd in [('ldd',['ldd',str(compiler)]),('elf-versions',['readelf','--version-info',str(compiler)]),('elf-dynamic',['readelf','-d',str(compiler)]),('file',['file',str(compiler)])]:
            probe(name,cmd,root/'receipts'/f'{a.profile}-{name}.txt')
    except Exception as error:
        code=error.returncode if isinstance(error,subprocess.CalledProcessError) else 1
        receipt.update(status='compiled-but-postbuild-failed',exitCode=code,postBuildError=f'{type(error).__name__}: {error}')
    finally:
        receipt['finished']=datetime.datetime.now(datetime.timezone.utc).isoformat()
        receipt_path.write_text(json.dumps(receipt,indent=2)+'\n')
    print(json.dumps(receipt,indent=2))
    if code: raise SystemExit(code)



if __name__=='__main__': main()
