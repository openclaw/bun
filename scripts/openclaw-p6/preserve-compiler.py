#!/usr/bin/env python3
"""Preserve one actual successful physical standard or SR-off compiler; no upload."""
import argparse,hashlib,json,platform,tarfile
from pathlib import Path

def sha(p):
 with Path(p).open('rb') as stream:return hashlib.file_digest(stream,'sha256').hexdigest()

def main():
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('--root',type=Path,required=True);p.add_argument('--profile',choices=['cb-standard','cb-compat'],required=True);a=p.parse_args();profile=a.profile;directory='build-standard' if profile=='cb-standard' else 'build-c2'
 assert platform.system()=='Linux' and platform.machine()=='x86_64'
 root=a.root.resolve();assert root==Path.home()/'.cache/oc-ty-ext/P6/rd150c-x64-highmem-deadline-v1'
 compiler=root/directory/'bun';build=root/'receipts'/f'{profile}-build.json';config=root/directory/'configure.json'
 data=json.loads(build.read_text());settings=json.loads(config.read_text())
 assert data['status']=='build-command-finished-not-qualified'
 assert data['exitCode']==0 and data['profile']==profile and data['compiler']==str(compiler)
 assert data['compilerSha256']==sha(compiler)
 assert data['source']['bun']=='150c9620c53710060186b8b0cd50985e035408b0'
 assert data['source']['webkit']=='aaa690bfbf34c9d50775716ac2fc3c7d0573e0b8'
 overrides=settings['overrides'];assert settings['profile']=='release-local'
 assert overrides['shadowRealm'] is (profile=='cb-standard') and overrides.get('hardened',False) is False
 assert overrides['webkitVersion']=='aaa690bfbf34c9d50775716ac2fc3c7d0573e0b8'
 assert overrides['aot'] is True and overrides['trimmable'] is True
 target=root/f'preserved-{profile}';target.mkdir(exist_ok=False)
 entries=[compiler,config,build,root/'receipts'/f'{profile}.sha256']
 with tarfile.open(target/'compiler.tar','w') as archive:
  for file in entries:archive.add(file,arcname=str(file.relative_to(root)),recursive=False)
 receipt={'status':'native-preserved-not-downloaded','profile':profile,'compilerSha256':sha(compiler),'buildReceiptSha256':sha(build),'configureSha256':sha(config),'archive':str(target/'compiler.tar'),'archiveSha256':sha(target/'compiler.tar'),'archiveBytes':(target/'compiler.tar').stat().st_size,'members':{str(file.relative_to(root)):sha(file) for file in entries},'applicationQualified':False}
 (target/'transport.json').write_text(json.dumps(receipt,indent=2)+'\n')
 print(json.dumps(receipt,indent=2))

if __name__=='__main__':main()
