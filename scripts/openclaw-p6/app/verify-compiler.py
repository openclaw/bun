#!/usr/bin/env python3
"""Verify an exact-file download of the native standard or SR-off preservation archive."""
import argparse,hashlib,json,sys,tarfile
from pathlib import Path

def sha(p):
 with Path(p).open('rb') as stream:return hashlib.file_digest(stream,'sha256').hexdigest()

def main():
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('--profile',choices=['cb-standard','cb-compat'],required=True);p.add_argument('--archive',type=Path,required=True);p.add_argument('--transport',type=Path,required=True);p.add_argument('--transport-sha256',required=True);p.add_argument('--out',type=Path,required=True);a=p.parse_args();profile=a.profile;directory='build-standard' if profile=='cb-standard' else 'build-c2'
 assert sys.version_info >= (3,12), 'Use Python3.12 or newer for archive verification'
 assert sha(a.transport)==a.transport_sha256
 data=json.loads(a.transport.read_text());assert data['status']=='native-preserved-not-downloaded' and data['profile']==profile
 assert sha(a.archive)==data['archiveSha256'] and a.archive.stat().st_size==data['archiveBytes']
 expected={f'{directory}/bun',f'{directory}/configure.json',f'receipts/{profile}-build.json',f'receipts/{profile}.sha256'}
 assert set(data['members'])==expected and not a.out.exists()
 with tarfile.open(a.archive) as tar:
  entries=tar.getmembers();assert len(entries)==len(expected) and {x.name for x in entries}==expected
  for entry in entries:
   assert entry.isfile();assert hashlib.sha256(tar.extractfile(entry).read()).hexdigest()==data['members'][entry.name]
  a.out.mkdir(parents=True);tar.extractall(a.out,filter='data')
 config=json.loads((a.out/directory/'configure.json').read_text());build=json.loads((a.out/'receipts'/f'{profile}-build.json').read_text());overrides=config['overrides']
 assert config['profile']=='release-local' and overrides['shadowRealm'] is (profile=='cb-standard') and overrides.get('hardened',False) is False
 assert overrides['webkitVersion']=='aaa690bfbf34c9d50775716ac2fc3c7d0573e0b8'
 assert build['source']['bun']=='150c9620c53710060186b8b0cd50985e035408b0' and build['source']['webkit']=='aaa690bfbf34c9d50775716ac2fc3c7d0573e0b8'
 assert build['status']=='build-command-finished-not-qualified'
 assert overrides['aot'] is True and overrides['trimmable'] is True
 assert build['exitCode']==0 and build['profile']==profile and build['compilerSha256']==data['compilerSha256']==sha(a.out/directory/'bun')
 result={'status':'downloaded-and-verified','profile':profile,'compilerSha256':data['compilerSha256'],'archiveSha256':data['archiveSha256'],'transportSha256':a.transport_sha256,'sourcePins':build['source'],'applicationQualified':False}
 (a.out/'verification.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result,indent=2))

if __name__=='__main__':main()
