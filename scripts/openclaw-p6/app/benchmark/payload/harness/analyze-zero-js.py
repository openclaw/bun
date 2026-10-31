#!/usr/bin/env python3
"""Analyze strace -ff -yy output from a DIRECT AOT subtree, never from Node fixture helpers.

A successful open is inventoried only. Positive-byte read/pread/readv and readable
file mappings are separate evidence. Any readable source mapping fails admission
conservatively; mmap success does not prove that the pages were actually touched.
"""
import argparse, hashlib, json, pathlib, re
p=argparse.ArgumentParser()
p.add_argument('--trace-dir',required=True)
p.add_argument('--out',required=True)
p.add_argument('--binary',required=True)
a=p.parse_args()
root=pathlib.Path(a.trace_dir)
assert root.is_dir(), 'trace directory missing'
source=re.compile(r'\.[cm]?[jt]sx?(?:\s+\(deleted\))?$',re.I)
call=re.compile(r'^([A-Za-z_][A-Za-z_0-9]*)\(')
resumed=re.compile(r'^<\.\.\. ([A-Za-z_][A-Za-z_0-9]*) resumed>')
reads={'read','readv','pread64','preadv','preadv2','sendfile','splice','copy_file_range'}
result={'schema':1,'traceFiles':[],'sourceOpens':[],'positiveSourceReads':[],
 'readableSourceMappings':[],'executions':[],'parseUnfinished':[],'unresolvedIoUring':[],
 'expectedBinary':str(pathlib.Path(a.binary).resolve()),'expectedBinarySeen':False,
 'claim':'No positive-byte disk JS/TS reads and no readable JS/TS mappings in the traced AOT subtree.',
 'limits':['An mmap with read permission is conservatively rejected; it does not prove a page was touched.',
 'A successful open alone is not a successful read.','Only processes actually traced by this invocation are covered.']}
operations=0
for file in sorted(root.iterdir()):
 if not file.is_file(): continue
 digest=hashlib.sha256()
 pending={}
 with file.open('rb') as handle:
  for number, raw in enumerate(handle,1):
   digest.update(raw)
   line=raw.decode('utf8','replace').strip()
   rm=resumed.match(line)
   if rm:
    prefix=pending.pop(rm.group(1),None)
    if prefix is None:
     result['parseUnfinished'].append({'file':file.name,'line':number,'reason':'resume without start'})
     continue
    line=prefix+line[rm.end():]
   cm=call.match(line)
   if not cm: continue
   syscall=cm.group(1)
   if '<unfinished ...>' in line:
    pending[syscall]=line.replace('<unfinished ...>','')
    continue
   rm=re.search(r'\)\s+=\s+(0x[0-9a-fA-F]+|-?\d+)',line)
   if not rm: continue
   operations+=1
   value=int(rm.group(1),16) if rm.group(1).startswith('0x') else int(rm.group(1))
   if syscall=='execve' and value==0:
    result['executions'].append({'file':file.name,'line':number,'record':line})
    executable=re.search(r'^execve\(("(?:\\.|[^"\\])*")',line)
    if executable and json.loads(executable.group(1))==result['expectedBinary']: result['expectedBinarySeen']=True
   if value<0: continue
   if syscall=='io_uring_enter' and value>0:
    result['unresolvedIoUring'].append({'file':file.name,'line':number,'record':line})
   paths=re.findall(r'\d+<([^>]+)>',line)
   sources=[name for name in paths if source.search(name)]
   if syscall in {'open','openat','openat2'} and value>=0:
    quoted=re.findall(r'"((?:\\.|[^"\\])*)"',line)
    names=[name for name in quoted if source.search(name)]
    for name in names: result['sourceOpens'].append({'file':file.name,'line':number,'path':name})
   if syscall in reads and value>0 and sources:
    result['positiveSourceReads'].append({'file':file.name,'line':number,'bytes':value,'paths':sources,'record':line})
   if syscall in {'mmap','mmap2'} and ('PROT_READ' in line or 'PROT_EXEC' in line) and sources and rm.group(1).startswith('0x'):
    result['readableSourceMappings'].append({'file':file.name,'line':number,'paths':sources,'record':line})
 result['traceFiles'].append({'path':str(file),'sha256':digest.hexdigest()})
 for name,line in pending.items():
  # A final blocked read without completion cannot prove a successful source read;
  # keep it explicit and refuse a completeness claim if a source fd was involved.
  if any(source.search(name) for name in re.findall(r'\d+<([^>]+)>',line)):
   result['parseUnfinished'].append({'file':file.name,'syscall':name,'record':line})
result['operations']=operations
result['passed']=bool(result['traceFiles']) and operations>0 and result['expectedBinarySeen'] and not any(result[key] for key in ['positiveSourceReads','readableSourceMappings','parseUnfinished','unresolvedIoUring'])
pathlib.Path(a.out).write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps({'passed':result['passed'],'traceFiles':len(result['traceFiles']),'operations':operations,
 'successfulSourceOpens':len(result['sourceOpens']),'positiveSourceReads':len(result['positiveSourceReads']),
 'readableSourceMappings':len(result['readableSourceMappings']),'incomplete':len(result['parseUnfinished'])}))
raise SystemExit(0 if result['passed'] else 1)
