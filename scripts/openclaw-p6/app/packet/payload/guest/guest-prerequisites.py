#!/usr/bin/env python3
"""Guest tools/image only; no compiler, LLVM, app, VM or carrier action."""
import argparse,hashlib,json,os,platform,shutil,subprocess,tempfile
from pathlib import Path
IMAGE_SHA='04e8f2461a16a44e78a370284471f29616cdd9baf1893df25807b71f985b6c94'
URL='https://cloud-images.ubuntu.com/releases/noble/release-20261017/ubuntu-24.04-server-cloudimg-amd64.img'
TOOLS=['qemu-system-x86_64','qemu-img','cloud-localds','mkfs.ext4','timeout','sudo']
def sha(p):
 with Path(p).open('rb') as f:return hashlib.file_digest(f,'sha256').hexdigest()
def main():
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('--out',type=Path,required=True);p.add_argument('--install-and-download',action='store_true');a=p.parse_args()
 if platform.system()!='Linux' or platform.machine()!='x86_64':p.error('Native Linux x64 required')
 os.umask(0o077);root=Path.home()/'.cache/oc-ty-ext/P6';image=root/'cb-x64-final-toolchain-input/ubuntu-24.04-release-20261017-amd64.img'
 if a.out.exists() or not a.out.resolve().is_relative_to(root.resolve()):p.error('Fresh task-owned prerequisite receipt directory required')
 a.out.mkdir(parents=True)
 result={'status':'inventory-only-not-ready','applicationQualified':False,'performanceEligible':False,'image':str(image),'imageUrl':URL,'expectedImageSha256':IMAGE_SHA,'packages':['qemu-system-x86','qemu-utils','cloud-image-utils','e2fsprogs'],'compilerSetupRequired':False}
 try:
  if a.install_and_download:
   env={'PATH':'/usr/sbin:/usr/bin:/sbin:/bin','HOME':str(Path.home()),'TMPDIR':str(root/'guest-prerequisites-tmp'),'DEBIAN_FRONTEND':'noninteractive','LANG':'C.UTF-8'};Path(env['TMPDIR']).mkdir(parents=True,exist_ok=True)
   with (a.out/'apt.log').open('wb') as log:
    for command in [['sudo','-n','apt-get','update'],['sudo','-n','apt-get','install','-y','--no-install-recommends',*result['packages']]]:subprocess.run(command,env=env,stdout=log,stderr=subprocess.STDOUT,check=True)
   image.parent.mkdir(parents=True,exist_ok=True)
   if image.is_symlink():raise ValueError('Image symlink refused')
   if not image.exists():
    with tempfile.TemporaryDirectory(prefix='guest-image-',dir=image.parent) as directory:
     temporary=Path(directory)/'download.img'
     with (a.out/'download.log').open('wb') as log:subprocess.run(['curl','-fL','--retry','2','--connect-timeout','30','--max-time','1800','-o',str(temporary),URL],stdout=log,stderr=subprocess.STDOUT,check=True)
     if sha(temporary)!=IMAGE_SHA:raise ValueError('Pinned cloud image hash mismatch')
     os.link(temporary,image)
  result['tools']={}
  for name in TOOLS:
   path=shutil.which(name)
   result['tools'][name]={'path':path,'sha256':sha(path) if path else None}
  if image.is_file() and not image.is_symlink():result['imageSha256']=sha(image)
  if not all(x['path'] for x in result['tools'].values()) or result.get('imageSha256')!=IMAGE_SHA:raise ValueError('QEMU/image prerequisites incomplete')
  packages=subprocess.run(['dpkg-query','-W','-f=${Package}\t${Version}\n',*result['packages']],capture_output=True,text=True,check=True);(a.out/'packages.tsv').write_text(packages.stdout)
  result['packageInventorySha256']=sha(a.out/'packages.tsv')
  for name in ['qemu-system-x86_64','qemu-img']:
   version=subprocess.run([result['tools'][name]['path'],'--version'],capture_output=True,text=True,check=True);(a.out/(name+'-version.txt')).write_text(version.stdout+version.stderr)
  result['status']='guest-prerequisites-present-not-kvm-qualified'
 except Exception as error:result['error']=str(error)
 (a.out/'result.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result,indent=2))
 return 0 if result['status']=='guest-prerequisites-present-not-kvm-qualified' else 1
if __name__=='__main__':raise SystemExit(main())
