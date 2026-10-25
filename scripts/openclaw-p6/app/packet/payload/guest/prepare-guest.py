#!/usr/bin/env python3
"""Validate actual app inputs and render the immutable guest owner command only."""
import argparse,base64,hashlib,json,platform,re,shlex,subprocess,sys
from pathlib import Path
HERE=Path(__file__).resolve().parent
CUT='670a7ab33bbd2e3ed4f0a5681e138159d74540a1'
ROOT=Path('/home/runner/.cache/oc-ty-ext/P6/app-x64-final-r2-v1')
QUALIFIER_SHA='62cb7bc09d40be522aa14fcac1b3db1e448032d296909a589bf5ef8b95c47f13'

def sha(p):
 with Path(p).open('rb') as f:return hashlib.file_digest(f,'sha256').hexdigest()
def load(p):return json.loads(Path(p).read_text())
def need(value,message):
 if not value:raise ValueError(message)

def main():
 p=argparse.ArgumentParser(description=__doc__)
 for flag in ['artifact','build-receipt','root-admission','host-core-result']:p.add_argument('--'+flag,type=Path,required=True)
 for flag in ['binary-sha256','manifest-sha256','build-receipt-sha256','root-admission-sha256','host-core-result-sha256']:p.add_argument('--'+flag,required=True)
 p.add_argument('--prerequisites',type=Path,required=True);p.add_argument('--prerequisites-sha256',required=True)
 p.add_argument('--label',required=True);a=p.parse_args()
 need(sys.version_info >= (3,12),'Python3.12 or newer required')
 need(platform.system()=='Linux' and platform.machine()=='x86_64','Native Linux x64 required')
 need(re.fullmatch('[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}',a.label),'Safe fresh label required')
 for value in [a.binary_sha256,a.manifest_sha256,a.build_receipt_sha256,a.root_admission_sha256,a.host_core_result_sha256,a.prerequisites_sha256]:need(re.fullmatch('[0-9a-f]{64}',value),'Actual full SHA256 required')
 for name,expected in load(HERE/'manifest.json')['files'].items():need(sha(HERE/name)==expected,'Staged harness changed: '+name)
 need(sha(a.root_admission)==a.root_admission_sha256,'Root build admission changed')
 admission=load(a.root_admission);built=load(a.build_receipt)
 need(admission.get('schemaVersion')==1 and admission.get('lane')=='P6' and admission.get('decision')=='build-linux','Explicit root P6 build admission required')
 need(admission['linuxCut']['commit']==CUT and admission['linuxCut']['status']=='landed-main' and admission['source']==str(ROOT/'source'),'Wrong root source admission')
 need(sha(a.build_receipt)==a.build_receipt_sha256,'Actual build receipt changed')
 need(built.get('status')=='built-unsigned' and built.get('phase')=='complete','Successful actual build required')
 need(built['plan']['admissionSha256']==a.root_admission_sha256,'Build is not bound to root admission')
 need(str(a.artifact.resolve())==admission['output']==built['plan']['output'],'Different actual admitted artifact')
 variant={'js':'js-aot','c2':'c2','ts':'ts-aot','strong':'c2-linux-hardened'}[admission['variant']]
 qualifier=ROOT/'qualification/qualify.py';need(sha(qualifier)==QUALIFIER_SHA,'Reviewed qualification v3 required')
 work=ROOT/'application-guest-runs'/a.label;need(not work.exists(),'Fresh guest work required')
 # Reuse the actual-artifact/source/runtime validator without running any workload.
 command=[sys.executable,str(qualifier),'--artifact',str(a.artifact),'--binary-sha256',a.binary_sha256,'--manifest-sha256',a.manifest_sha256,'--build-receipt',str(a.build_receipt),'--build-receipt-sha256',a.build_receipt_sha256,'--lane','core','--out',str(ROOT/'qualification-results'/('guest-input-'+a.label))]
 checked=subprocess.run(command,check=True,capture_output=True,text=True,env={'HOME':str(Path.home()),'PATH':'/usr/bin:/bin','LANG':'C.UTF-8'})
 proof=json.loads(checked.stdout);need(proof['mode']=='aot','Actual AOT app required')
 need(sha(a.host_core_result)==a.host_core_result_sha256,'Host version result changed')
 host=load(a.host_core_result)
 need(host['binarySha256']==a.binary_sha256 and host['artifact']==str(a.artifact.resolve()) and host['source']==str(ROOT/'source') and host['platform']=='linux' and host['arch']=='x64','Host version identity differs')
 rows=[r for r in host['commands'] if r['label']=='version'];need(len(rows)==1,'Exactly one actual host version command required');row=rows[0]
 need(row['command']==[str(a.artifact.resolve()/'openclaw'),'--version'] and row['code']==0 and row.get('spawnError') is None,'Host version command did not succeed')
 stdout=a.host_core_result.parent/'logs/version.stdout';need(Path(row['stdout'])==stdout,'Unexpected host version stdout path')
 raw=stdout.read_text();need(0<len(raw.encode())<=4096 and raw.strip()==host['checks']['version'],'Host version stdout missing or inconsistent')
 need(sha(a.prerequisites)==a.prerequisites_sha256,'Guest prerequisite receipt changed')
 prereq=load(a.prerequisites);need(prereq['status']=='guest-prerequisites-present-not-kvm-qualified','Guest prerequisites incomplete')
 guest=[sys.executable,str(HERE/'application/run-application-guest.py'),'--artifact',str(a.artifact.resolve()),'--admission-receipt',str(a.root_admission),'--binary-sha256',a.binary_sha256,'--main-sha',CUT,'--variant',variant,'--expected-stdout',raw.rstrip('\n'),'--image','/home/runner/.cache/oc-ty-ext/P6/cb-x64-final-toolchain-input/ubuntu-24.04-release-20261017-amd64.img','--work-dir',str(work),'--vm-owner',str(HERE/'shared/run-kvm-guest.py'),'--prerequisites',str(a.prerequisites),'--prerequisites-sha256',a.prerequisites_sha256]
 out={'status':'prepared-not-authorized-to-execute','rootGuestPhaseCoordination':'required separately from root build admission','applicationQualified':False,'scope':'Actual app --version and main-thread MDWE memory controls; Gateway, Worker lifecycle and zero-disk-JS not covered','label':a.label,'sourceCommit':CUT,'binarySha256':a.binary_sha256,'manifestSha256':a.manifest_sha256,'rootBuildAdmissionSha256':a.root_admission_sha256,'actualBuildReceiptSha256':a.build_receipt_sha256,'hostCoreResultSha256':a.host_core_result_sha256,'prerequisitesSha256':a.prerequisites_sha256,'hostVersionStdoutSha256':sha(stdout),'expectedStdout':raw.rstrip('\n'),'variant':variant,'guestCommand':guest,'guestWork':str(work),'proofPath':'.artifacts/P6-application-guest-final-r2-v1/'+a.label+'/receipt.json','rawEvidence':str(work/'evidence.tar')}
 # The renderer never executes this recipe; the root owns guest-phase coordination.
 input_file=ROOT/'application-guest-inputs'/(a.label+'.json')
 encoded=base64.b64encode(json.dumps(out,sort_keys=True).encode()).decode()
 proof=Path('.artifacts/P6-application-guest-final-r2-v1')/a.label
 collector=[sys.executable,str(HERE/'collect-evidence.py'),'--work',str(work),'--proof',str(proof),'--input-proof',str(input_file)]
 body='set -euo pipefail\n'
 body+="python3 - <<'P6_GUEST_INPUT'\nimport base64\nfrom pathlib import Path\np=Path("+repr(str(input_file))+");p.parent.mkdir(parents=True,exist_ok=True)\nwith p.open('xb') as f:f.write(base64.b64decode("+repr(encoded)+",validate=True))\nP6_GUEST_INPUT\n"
 body+='collect() { rc=$?; trap - EXIT; '+shlex.join(collector)+' || { echo "Guest evidence collection failed; native originals retained" >&2; exit 1; }; exit "$rc"; }\ntrap collect EXIT\n'+shlex.join(guest)+'\n'
 out['guestShell']=body
 print(json.dumps(out,indent=2))

if __name__=='__main__':main()
