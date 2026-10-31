#!/usr/bin/env python3
"""Run the synthetic x64 compiler suite in an offline, hardware-accelerated guest."""
from pathlib import Path
import hashlib,json,os,platform,secrets,shutil,signal,subprocess,sys,time

QMP_SCRIPT="import json,socket,sys\ns=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);s.settimeout(5);s.connect(sys.argv[1]);f=s.makefile('rwb',buffering=0)\ngreeting=json.loads(f.readline())\ndef command(name,number):\n f.write((json.dumps({'execute':name,'id':number})+'\\n').encode())\n while True:\n  response=json.loads(f.readline())\n  if response.get('id')==number:return response\ncommand('qmp_capabilities',1)\nresult=command('query-kvm',2)\nprint(json.dumps({'greeting':greeting,'queryKvm':result}))\ns.close()"

class GuestInterrupted(Exception):
    def __init__(self, signum):
        self.signum=signum
        super().__init__('Interrupted by '+signal.Signals(signum).name)

def privileged_python(code, *args):
    prefix=[sys.executable] if os.geteuid()==0 else ['sudo','-n','python3']
    return [*prefix,'-c',code,*map(str,args)]

def run_guest_vm(command, work, overlay, report):
    """Own the VM process through interruption, cleanup, and a durable result."""
    work=Path(work)
    serial=work/'serial.log';qmp=work/'qmp.sock';pidfile=work/'qemu.pid'
    state={'signal':None,'cleaning':False}
    previous={}
    child=None
    def interrupted(signum, frame):
        state['signal']=state['signal'] or signum
        if not state['cleaning']: raise GuestInterrupted(signum)
    qmp_script=QMP_SCRIPT
    try:
        for signum in [signal.SIGINT,signal.SIGTERM,signal.SIGHUP]:
            previous[signum]=signal.signal(signum,interrupted)
        with (work/'qemu.log').open('wb') as output:
            child=subprocess.Popen(command,stdin=subprocess.DEVNULL,stdout=output,stderr=subprocess.STDOUT)
            deadline=time.monotonic()+30
            while not qmp.exists() and child.poll() is None and time.monotonic()<deadline: time.sleep(0.1)
            if not qmp.exists(): raise RuntimeError('QMP socket did not appear')
            result=subprocess.run(privileged_python(qmp_script,qmp),capture_output=True,text=True,timeout=10)
            (work/'qmp.stdout').write_text(result.stdout);(work/'qmp.stderr').write_text(result.stderr)
            if result.returncode: raise RuntimeError('QMP query failed')
            report['qmp']=json.loads(result.stdout)
            kvm=report['qmp']['queryKvm'].get('return',{})
            if kvm.get('enabled') is not True or kvm.get('present') is not True: raise RuntimeError('Hardware KVM acceleration not enabled')
            report['qemuExitCode']=child.wait(timeout=615)
            text=serial.read_text(errors='replace') if serial.exists() else ''
            results=[json.loads(line[len('P6_GUEST_RESULT '):]) for line in text.splitlines() if line.startswith('P6_GUEST_RESULT ')]
            if len(results)!=1: raise RuntimeError('Expected exactly one complete guest result')
            report['guest']=results[0]
            report['pass']=report['qemuExitCode']==0 and report['guest'].get('nonce')==report['nonce'] and report['guest'].get('pass') is True
    except Exception as error:
        report['error']=str(error)
        report['pass']=False
    finally:
        state['cleaning']=True
        try:
            if child is not None and child.poll() is None:
                # Root's helper verifies the unique task disk before signaling QEMU.
                cleanup_code="""import os,pathlib,sys
p=pathlib.Path(sys.argv[1])
pid=int(p.read_text()) if p.exists() else int(sys.argv[3])
cmd=pathlib.Path('/proc')/str(pid)/'cmdline'
data=cmd.read_bytes() if cmd.exists() else b''
if data and sys.argv[2].encode() not in data: raise SystemExit('Task QEMU identity mismatch')
if data: os.kill(pid,int(sys.argv[4]))
"""
                def stop_qemu(signum):
                    subprocess.run(privileged_python(cleanup_code,pidfile,overlay,child.pid,signum),check=True,timeout=10)
                stop_qemu(15)
                try: child.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    stop_qemu(9)
                    child.wait(timeout=10)
        except Exception as error:
            report['cleanupError']=str(error)
            report['pass']=False
        if child is not None: report['qemuExitCode']=child.poll()
        if state['signal'] is not None:
            report['interrupted']=signal.Signals(state['signal']).name
            report['pass']=False
        (work/'vm-result.json').write_text(json.dumps(report,indent=2)+'\n')
        for signum,handler in previous.items(): signal.signal(signum,handler)
    return report

def main():
    root=Path(os.environ['P6_WORK'])
    proof=Path(os.environ['P6_PROOF'])
    proof.mkdir(parents=True,exist_ok=True)
    if platform.machine()!='x86_64': raise SystemExit('Requires native x64 host')
    preflight=subprocess.run(['sudo','-n','python3',str(root/'kvm-preflight.py')],capture_output=True,text=True,timeout=30)
    (proof/'new-host-kvm-preflight.stdout').write_text(preflight.stdout)
    (proof/'new-host-kvm-preflight.stderr').write_text(preflight.stderr)
    if preflight.returncode: raise SystemExit('New-host privileged KVM preflight failed')
    preflight_result=json.loads(preflight.stdout)
    if not preflight_result.get('pass'): raise SystemExit('KVM preflight did not pass')
    subprocess.run(['sudo','-n','apt-get','update'],check=True)
    subprocess.run(['sudo','-n','apt-get','install','-y','--no-install-recommends','qemu-system-x86','qemu-utils','cloud-image-utils','e2fsprogs'],check=True)
    nonce='p6-'+secrets.token_hex(8)
    work=root/'guests'/nonce
    work.mkdir(parents=True,exist_ok=False)
    downloads=root/'downloads';downloads.mkdir(exist_ok=True)
    image=downloads/'ubuntu-24.04-release-20261017-amd64.img'
    digest='04e8f2461a16a44e78a370284471f29616cdd9baf1893df25807b71f985b6c94'
    url='https://cloud-images.ubuntu.com/releases/noble/release-20261017/ubuntu-24.04-server-cloudimg-amd64.img'
    if not image.exists(): subprocess.run(['curl','-fL','--retry','2','--connect-timeout','30','-o',str(image),url],check=True)
    with image.open('rb') as f: actual=hashlib.file_digest(f,'sha256').hexdigest()
    if actual!=digest: raise SystemExit('Official cloud image hash mismatch')
    payload=work/'payload';(payload/'bin').mkdir(parents=True);(payload/'security').mkdir()
    shutil.copy2(root/'bin/bun',payload/'bin/bun')
    shutil.copy2(root/'guest-run.py',payload/'guest-run.py')
    for name in ['mdwe','libp6mdwe.so','libp6fileexec.so','mdwe.c','file-exec.c','aot-mdwe.js','aot-mdwe.ts','aot-mdwe-worker.js','aot-mdwe-worker.ts','aot-child-policy.js','aot-file-exec.js']:
        shutil.copy2(root/'security'/name,payload/'security'/name)
    with (payload/'bin/bun').open('rb') as f: compiler_sha=hashlib.file_digest(f,'sha256').hexdigest()
    manifest={'nonce':nonce,'variant':'standard','compilerSha256':compiler_sha,'compilerPins':{'bun':'fd40ba44187c721ee023062fa153a6a27560e6b1','webkit':'aaa690bfbf34c9d50775716ac2fc3c7d0573e0b8'}}
    (payload/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
    payload_image=work/'payload.ext4'
    size=sum(f.stat().st_size for f in payload.rglob('*') if f.is_file())
    size=((size+128*1024*1024)//(64*1024*1024)+1)*64*1024*1024
    with payload_image.open('wb') as f: f.truncate(size)
    subprocess.run(['mkfs.ext4','-q','-F','-L','P6PAYLOAD','-d',str(payload),str(payload_image)],check=True)
    config={'datasource_list':['NoCloud'],'ssh_pwauth':False,'disable_root':True,'users':[],
            'ssh_deletekeys':True,'ssh_genkeytypes':[],'ssh_publish_hostkeys':{'enabled':False},
            'bootcmd':[['touch','/etc/ssh/sshd_not_to_be_run']],
            'network':{'config':'disabled'},
            'runcmd':[['bash','-c','exec >/dev/ttyS0 2>&1; set -eu; udevadm settle --timeout=30; mkdir -p /mnt/p6; mount -o ro,nodev,nosuid /dev/disk/by-label/P6PAYLOAD /mnt/p6; python3 /mnt/p6/guest-run.py']],
            'power_state':{'mode':'poweroff','delay':'now','timeout':30,'condition':True}}
    user_data=work/'user-data';user_data.write_text('#cloud-config\n'+json.dumps(config,indent=2)+'\n')
    meta_data=work/'meta-data';meta_data.write_text(json.dumps({'instance-id':nonce,'local-hostname':'p6-aot-synthetic'})+'\n')
    seed=work/'seed.img'
    subprocess.run(['cloud-localds',str(seed),str(user_data),str(meta_data)],check=True)
    overlay=work/'guest.qcow2'
    subprocess.run(['qemu-img','create','-f','qcow2','-F','qcow2','-b',str(image),str(overlay)],check=True)
    subprocess.run(['qemu-img','resize',str(overlay),'8G'],check=True)
    serial=work/'serial.log';serial.touch(mode=0o600,exist_ok=False)
    qmp=work/'qmp.sock';pidfile=work/'qemu.pid'
    command=['sudo','-n','env','-i','PATH=/usr/sbin:/usr/bin:/sbin:/bin','timeout','--signal=TERM','--kill-after=5s','600s','qemu-system-x86_64','-accel','kvm','-cpu','host','-smp','2','-m','4096','-display','none','-monitor','none','-pidfile',str(pidfile),'-serial','file:'+str(serial),'-qmp','unix:'+str(qmp)+',server=on,wait=off','-no-reboot','-nic','none','-drive','file='+str(overlay)+',if=virtio,format=qcow2','-drive','file='+str(seed)+',if=virtio,format=raw,readonly=on','-drive','file='+str(payload_image)+',if=virtio,format=raw,readonly=on']
    report={'nonce':nonce,'command':command,'cloudImage':{'url':url,'sha256':digest},'compilerSha256':compiler_sha,'hostKvmPreflight':preflight_result,'pass':False,'applicationQualification':False}
    report=run_guest_vm(command,work,overlay,report)
    for name in ['serial.log','qemu.log','qmp.stdout','qmp.stderr']:
        if (work/name).exists(): shutil.copy2(work/name,proof/('guest-'+name))
    (proof/'guest-result.json').write_text(json.dumps(report,indent=2)+'\n')
    print('P6_KVM_GUEST_RESULT '+json.dumps(report),flush=True)
    return 0 if report['pass'] else 1

if __name__=='__main__': raise SystemExit(main())
