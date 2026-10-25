#!/usr/bin/env python3
"""Plan or delegate one qualification lane for real accepted final-cut bytes."""
import argparse,hashlib,json,os,platform,re,shutil,subprocess,sys
from pathlib import Path

HERE=Path(__file__).resolve().parent
CUT='4fa442e332745f1f58ccedd27106abdafcf4e019'
LANES=['core','zero-js','node-vm','node-vm-native-workers','pty','plugin','teams-fetched','elf-floor','docker-image','docker-gateway-network','docker-kitchen-sink','docker-cron']

def sha(path):
 h=hashlib.sha256()
 with Path(path).open('rb') as source:
  for block in iter(lambda:source.read(1024*1024),b''):h.update(block)
 return h.hexdigest()

def load(path):return json.loads(Path(path).read_text())

def main():
 os.umask(0o077)
 p=argparse.ArgumentParser(description=__doc__)
 p.add_argument('--artifact',type=Path,required=True);p.add_argument('--binary-sha256',required=True);p.add_argument('--manifest-sha256',required=True)
 p.add_argument('--build-receipt',type=Path,required=True);p.add_argument('--build-receipt-sha256',required=True)
 p.add_argument('--lane',choices=LANES,required=True);p.add_argument('--out',type=Path,required=True)
 p.add_argument('--docker-image-receipt',type=Path);p.add_argument('--run',action='store_true')
 a=p.parse_args()
 if platform.system()!='Linux' or platform.machine()!='x86_64':p.error('Native Linux x64 required; --help is preparation only')
 for value in [a.binary_sha256,a.manifest_sha256,a.build_receipt_sha256]:
  if not re.fullmatch('[0-9a-f]{64}',value):p.error('Actual full SHA256 values required')
 root=Path.home()/'.cache/oc-ty-ext/P6/app-x64-final-r4-v1';source=(root/'source').resolve(strict=True);node=root/'opt/node/bin/node';artifact=a.artifact.resolve(strict=True);out=a.out.resolve()
 if out.parent!=root/'qualification-results' or out.exists():p.error('Fresh root/qualification-results/<label> required')
 if any(out==x or out in x.parents or x in out.parents for x in [source,artifact,HERE]):p.error('Output overlaps an input')
 for name,expected in load(HERE/'manifest.json')['files'].items():
  if sha(HERE/name)!=expected:p.error('Staged harness changed: '+name)
 contract=load(HERE/'source-contract.json')
 if subprocess.check_output(['git','rev-parse','HEAD'],cwd=source,text=True).strip()!=CUT:p.error('Wrong final source HEAD')
 if subprocess.check_output(['git','status','--porcelain','--untracked-files=no'],cwd=source,text=True).strip():p.error('Tracked source is dirty')
 for name,expected in contract['files'].items():
  if sha(source/name)!=expected:p.error('Source helper changed: '+name)
 if sha(a.build_receipt)!=a.build_receipt_sha256:p.error('Accepted build receipt hash differs')
 built=load(a.build_receipt);manifest=load(artifact/'manifest.json')
 if built.get('status')!='built-unsigned' or built.get('phase')!='complete':p.error('Actual successful reviewed build receipt required')
 proof=built['artifact'];plan=built['plan']
 if (proof['sourceCommit']!=CUT or proof['arch']!='x64' or proof['platform']!='linux'
     or proof['manifestSha256']!=a.manifest_sha256 or proof['executable']['sha256']!=a.binary_sha256
     or manifest['openclaw']['commit']!=CUT or manifest['target']!={'platform':'linux','arch':'x64'}
     or sha(artifact/'manifest.json')!=a.manifest_sha256 or sha(artifact/'openclaw')!=a.binary_sha256
     or manifest['executable']['sha256']!=a.binary_sha256):p.error('Artifact/build/source identity mismatch')
 if a.lane.startswith('docker-') and manifest['mode']!='aot':p.error('Docker AOT recipes require an AOT artifact')
 if str(node)!=plan['buildNode']['path'] or sha(node)!=plan['buildNode']['sha256']:p.error('Actual native build Node differs')
 native=not a.lane.startswith('docker-')
 runtime_path='/usr/bin:/bin' if native else f'{node.parent}:/usr/local/bin:/usr/bin:/bin'
 runtime_inventory={name:shutil.which(name,path=runtime_path) for name in ['node','nodejs','bun','bunx','deno','js','qjs','quickjs']}
 if native and any(runtime_inventory.values()):p.error('Native PATH contains an external JS runtime: '+json.dumps(runtime_inventory,sort_keys=True))
 env={'HOME':str(root/'home'),'PATH':runtime_path,'LANG':'C.UTF-8','TZ':'UTC','TMPDIR':str(root/'tmp'),'NO_COLOR':'1','CI':'1','DOCKER_CONFIG':str(root/'cache/docker-qualification')}
 if subprocess.check_output([str(node),'--version'],env=env,text=True).strip()!='v26.12.1':p.error('Node26.12.1 required')
 owner=source/'scripts/lib/bun-standalone-contract.mjs'
 code="import {pathToFileURL} from 'node:url';const {describeStandaloneRuntime}=await import(pathToFileURL(process.argv[1]));console.log(JSON.stringify(await describeStandaloneRuntime(process.argv[2])));"
 runtime=json.loads(subprocess.check_output([str(node),'--input-type=module','-e',code,str(owner),str(artifact/'runtime')],env=env,cwd=source,text=True,timeout=1800))
 for key in ['sha256','sizeBytes','fileCount','symlinkCount']:
  if runtime[key]!=manifest['runtime'][key] or runtime[key]!=proof['runtime'][key]:p.error('Complete runtime tree differs: '+key)
 harness=HERE/'harness';run=out/'run';command=[]
 if a.lane in ['core','zero-js']:
  command=[str(node),str(harness/'core-runner.mjs'),'--artifact',str(artifact),'--source',str(source),'--out',str(run)]
  if a.lane=='zero-js':command+=['--zero-js']
 elif a.lane in ['node-vm','node-vm-native-workers','pty','plugin']:
  scenario='node-vm' if a.lane=='node-vm-native-workers' else a.lane
  command=[str(node),str(harness/'capability-runner.mjs'),'--artifact',str(artifact),'--source',str(source),'--out',str(run),'--scenario',scenario]
  if a.lane=='node-vm-native-workers':command+=['--native-workers']
 elif a.lane=='teams-fetched':
  command=[sys.executable,'-B',str(HERE/'teams-fetched.py'),str(out/'input-proof.json')]
 elif a.lane=='elf-floor':
  external=[str(path.relative_to(artifact)) for path in artifact.rglob('*') if path.is_symlink() and path.resolve()!=artifact and artifact not in path.resolve().parents]
  if external:p.error('External artifact symlinks prevent complete artifact/sidecar floor: '+repr(external))
  command=['python3',str(harness/'elf-floor.py'),str(artifact),'--out',str(out/'elf-floor.json')]
 elif a.lane=='docker-image':command=['python3',str(HERE/'docker-image.py'),str(out/'input-proof.json')]
 else:
  if a.docker_image_receipt is None:p.error('Actual docker-image result.json required')
  image=load(a.docker_image_receipt)
  if (image.get('status')!='PASS' or image['binarySha256']!=a.binary_sha256 or image['manifestSha256']!=a.manifest_sha256 or image['sourceCommit']!=CUT):p.error('Docker image receipt differs')
  actual=subprocess.check_output(['docker','image','inspect','--format','{{.Id}}',image['tag']],env=env,text=True).strip()
  if actual!=image['imageId']:p.error('Docker tag now names different bytes')
  env.update(OPENCLAW_SKIP_DOCKER_BUILD='1',OPENCLAW_DOCKER_E2E_REQUIRE_LOCAL_IMAGE='1',OPENCLAW_DOCKER_E2E_IMAGE=image['tag'],OPENCLAW_DOCKER_E2E_REPO_ROOT=str(source),OPENCLAW_SELECTED_SHA=CUT)
  if a.lane=='docker-gateway-network' and 'admin-http-rpc' not in manifest['plugins']['embedded']:p.error('Existing gateway-network lane requires embedded admin-http-rpc')
  script={'docker-gateway-network':'gateway-network-docker.sh','docker-kitchen-sink':'kitchen-sink-plugin-docker.sh','docker-cron':'cron-cli-docker.sh'}[a.lane]
  if a.lane=='docker-kitchen-sink':env['OPENCLAW_KITCHEN_SINK_NPM_SPEC']='npm:@openclaw/kitchen-sink@0.4.1'
  command=['/bin/bash',str(source/'scripts/e2e'/script)]
 proof={'status':'planned-not-qualified','lane':a.lane,'artifact':str(artifact),'binarySha256':a.binary_sha256,'manifestSha256':a.manifest_sha256,'buildReceiptSha256':a.build_receipt_sha256,'source':str(source),'sourceCommit':CUT,'node':str(node),'nodeSha256':sha(node),'runtime':runtime,'variant':plan['variant'],'mode':manifest['mode'],'policyLabel':plan['policyLabel'],'pluginCount':len(manifest['plugins']['embedded']),'out':str(out),'harness':str(harness),'command':command,'performanceEligible':False,'applicationQualified':False,'runtimePath':runtime_path,'runtimePathInventory':runtime_inventory,'runtimeScope':'native-external-JS-runtime-free-PATH' if native else 'functional-Docker-clients-may-use-Node','rawZeroJsTracePolicy':'preserve run/traces/** plus zero-js.json including successful execve records; never replace raw traces with summaries'}
 print(json.dumps(proof,indent=2),flush=True)
 if not a.run:return 0
 out.mkdir(parents=True)
 (out/'input-proof.json').write_text(json.dumps(proof,indent=2)+'\n')
 if a.lane=='elf-floor':
  libc=subprocess.run(['ldd','--version'],env=env,capture_output=True,text=True,timeout=30)
  (out/'ldd-version.txt').write_text(libc.stdout+libc.stderr)
 # Keep the unchanged lane owner as the actual controller and cleanup owner.
 os.chdir(source);os.execvpe(command[0],command,env)

if __name__=='__main__':raise SystemExit(main())
