#!/usr/bin/env python3
"""Stage only reviewed small app preparation inputs into a fresh root."""
import hashlib,json,os,platform,shutil
from pathlib import Path
HERE=Path(__file__).resolve().parent
ROOT=Path('/home/runner/.cache/oc-ty-ext/P6/app-x64-final-r3-v1')
def sha(p):
 with p.open('rb') as f:return hashlib.file_digest(f,'sha256').hexdigest()
def main():
 assert platform.system()=='Linux' and platform.machine()=='x86_64';os.umask(0o077)
 assert not ROOT.exists() and not ROOT.is_symlink()
 manifest=json.loads((HERE/'manifest.json').read_text())
 for name,expected in manifest['files'].items():assert sha(HERE/name)==expected,name
 assert json.loads((HERE/'admission-inputs/source-preparation.json').read_text())['sourceCommit']=='59baf4a051665750eb7055d0cec991d9876526df'
 shutil.copytree(HERE,ROOT)
 print(json.dumps({'status':'app-preparation-staged-not-built','root':str(ROOT),'sourceCommit':'59baf4a051665750eb7055d0cec991d9876526df','compilerHashes':'pending actual native preserved compilers','applicationBuilt':False},indent=2))
if __name__=='__main__':main()
