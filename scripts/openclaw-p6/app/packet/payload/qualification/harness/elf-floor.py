#!/usr/bin/env python3
"""Report required ELF ABI symbol versions; does not infer execution compatibility."""
import argparse,hashlib,json,pathlib,re,subprocess
p=argparse.ArgumentParser()
p.add_argument('root',type=pathlib.Path)
p.add_argument('--out',type=pathlib.Path,required=True)
a=p.parse_args()
rows=[]
for file in sorted(a.root.rglob('*')):
 if not file.is_file() or file.is_symlink(): continue
 with file.open('rb') as f:
  if f.read(4)!=b'\x7fELF': continue
 v=subprocess.run(['readelf','--version-info','--wide',str(file)],capture_output=True,text=True,check=True).stdout
 needed_section=v.split('Version needs section',1)[1] if 'Version needs section' in v else ''
 nodes=sorted(set(re.findall(r'Name: (\S+)',needed_section)))
 versions=[n[6:] for n in nodes if re.fullmatch(r'GLIBC_\d+(?:\.\d+)+',n)]
 maximum=max(versions,key=lambda s:tuple(map(int,s.split('.'))),default=None)
 dynamic=subprocess.run(['readelf','--dynamic','--wide',str(file)],capture_output=True,text=True,check=True).stdout
 needed=re.findall(r'\(NEEDED\).*?\[(.*?)\]',dynamic)
 rows.append({'path':str(file.relative_to(a.root)),'sha256':hashlib.sha256(file.read_bytes()).hexdigest(),'requiredVersions':nodes,'maxGlibc':maximum,'needed':needed})
all_versions=[r['maxGlibc'] for r in rows if r['maxGlibc']]
report={'root':str(a.root.resolve()),'elfCount':len(rows),'maximumGlibcRequired':max(all_versions,key=lambda s:tuple(map(int,s.split('.'))),default=None),'hasRelrLoaderRequirement':any('GLIBC_ABI_DT_RELR' in r['requiredVersions'] for r in rows),'files':rows,'scope':'ELF import requirements only; not a runtime or oldest-distro pass'}
a.out.write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps({k:v for k,v in report.items() if k!='files'}))
if not rows: raise SystemExit(1)
