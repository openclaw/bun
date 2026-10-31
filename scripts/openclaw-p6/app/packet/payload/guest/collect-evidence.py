#!/usr/bin/env python3
"""Preserve complete existing guest outputs; never rerun a guest or trim traces."""
import argparse,hashlib,json,re,tarfile
from pathlib import Path

def sha(p):
 with p.open('rb') as f:return hashlib.file_digest(f,'sha256').hexdigest()

def main():
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('--work',type=Path,required=True);p.add_argument('--proof',type=Path,required=True);p.add_argument('--input-proof',type=Path,required=True);a=p.parse_args()
 inputs=json.loads(a.input_proof.read_text());a.proof.mkdir(parents=True,exist_ok=False)
 result={'status':'failed-no-native-result','applicationQualified':False,'scope':inputs['scope'],'sourceCommit':inputs['sourceCommit'],'binarySha256':inputs['binarySha256'],'rootBuildAdmissionSha256':inputs['rootBuildAdmissionSha256'],'inputProofSha256':sha(a.input_proof),'work':str(a.work),'traceCount':0}
 files=[a.input_proof];report_path=a.work/'application-guest-result.json'
 if report_path.is_file():
  report=json.loads(report_path.read_text());guest=report.get('guest',{})
  result.update(status='collected-main-memory-policy-pass' if report.get('pass') is True and guest.get('pass') is True else 'collected-main-memory-policy-failed',guestKernel=guest.get('kernel'),variant=report.get('variant'),nonce=report.get('nonce'))
  traces=guest.get('traces',{})
  if traces:
   directory=a.work/'raw-traces';directory.mkdir(exist_ok=False)
   for name,content in traces.items():
    if not re.fullmatch(r'(?:app|version)\.trace\.\d+',name) or not isinstance(content,str):raise ValueError('Unexpected raw trace entry')
    path=directory/name;path.write_bytes(content.encode());files.append(path)
   result['traceCount']=len(traces)
   policy=guest.get('policy',{});selected=directory/policy.get('trace','absent')
   if result['status']=='collected-main-memory-policy-pass' and (not selected.is_file() or sha(selected)!=policy.get('traceSha256')):raise ValueError('Selected raw trace hash mismatch')
 for extra in sorted((a.work/'control-build').glob('*')):
  if extra.is_file():files.append(extra)
 for name in ['application-guest-result.json','vm-result.json','guest-result-stream.log','guest-boot-console.log','serial.log','boot-console.log','qemu.log','qmp.stdout','qmp.stderr']:
  file=a.work/name
  if file.is_file():files.append(file)
 if a.work.is_dir():
  archive=a.work/'evidence.tar'
  if archive.exists():raise ValueError('Evidence archive already exists')
  index=a.work/'evidence-index.json';index.write_text(json.dumps({str(file):sha(file) for file in files},indent=2)+'\n');files.append(index)
  with tarfile.open(archive,'w') as tar:
   for file in files:tar.add(file,arcname='input-proof.json' if file==a.input_proof else str(file.relative_to(a.work)),recursive=False)
  result.update(archive=str(archive),archiveSha256=sha(archive),archiveBytes=archive.stat().st_size)
 (a.proof/'receipt.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result,indent=2))

if __name__=='__main__':main()
