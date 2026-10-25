#!/usr/bin/env python3
"""Copy actual preserved150c native compilers into this fresh app root; no build."""
import hashlib,json,os,platform,shutil
from pathlib import Path
ROOT=Path('/home/runner/.cache/oc-ty-ext/P6/app-x64-final-r3-v1')
COMPILER_ROOT=Path('/home/runner/.cache/oc-ty-ext/P6/rd150c-x64-v1')
def sha(p):
 with p.open('rb') as f:return hashlib.file_digest(f,'sha256').hexdigest()
def main():
 assert platform.system()=='Linux' and platform.machine()=='x86_64';os.umask(0o077)
 record={'status':'native-compilers-adopted-not-app-admitted'};items=[]
 for profile,directory,label,shadow in [('cb-standard','build-standard','standard',True),('cb-compat','build-c2','sr-off',False)]:
  compiler=COMPILER_ROOT/directory/'bun';config=COMPILER_ROOT/directory/'configure.json';receipt=COMPILER_ROOT/'receipts'/f'{profile}-build.json';transport=COMPILER_ROOT/f'preserved-{profile}'/'transport.json'
  built=json.loads(receipt.read_text());settings=json.loads(config.read_text());preserved=json.loads(transport.read_text())
  assert built['status']=='build-command-finished-not-qualified' and built['exitCode']==0 and built['profile']==profile
  assert built['source']['bun']=='150c9620c53710060186b8b0cd50985e035408b0' and built['source']['webkit']=='aaa690bfbf34c9d50775716ac2fc3c7d0573e0b8'
  assert preserved['status']=='native-preserved-not-downloaded' and preserved['profile']==profile
  assert sha(compiler)==built['compilerSha256']==preserved['compilerSha256'] and sha(receipt)==preserved['buildReceiptSha256'] and sha(config)==preserved['configureSha256']
  assert settings['profile']=='release-local' and settings['overrides']['shadowRealm'] is shadow and settings['overrides'].get('hardened',False) is False
  target=ROOT/'compilers'/label;assert not target.exists();items.append((profile,compiler,config,receipt,transport,target,shadow))
 assert not (ROOT/'admission-inputs/compiler-records.json').exists()
 for profile,compiler,config,receipt,transport,target,shadow in items:
  target.mkdir(parents=True)
  for path,name in [(compiler,'bun'),(config,'configure.json'),(receipt,'build.json'),(transport,'transport.json')]:shutil.copy2(path,target/name)
  assert sha(target/'bun')==sha(compiler)
  record[profile]={'path':str(target/'bun'),'sha256':sha(target/'bun'),'cohort':'rd-p6-150c','bunCommit':'150c9620c53710060186b8b0cd50985e035408b0','webkitCommit':'aaa690bfbf34c9d50775716ac2fc3c7d0573e0b8','engineFeatures':{'shadowRealm':shadow,'hardened':False},'buildReceiptSha256':sha(receipt),'preservationReceiptSha256':sha(transport)}
 with (ROOT/'admission-inputs/compiler-records.json').open('x') as f:json.dump(record,f,indent=2);f.write('\n')
 print(json.dumps(record,indent=2))
if __name__=='__main__':main()
