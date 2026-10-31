"""Require actual main-thread probe results and corresponding post-activation syscalls."""
import re

def analyze(text,row,policy,binary):
    if row.get('kind')!='actual-application-plugin-main' or row.get('isMainThread') is not True or row.get('executable')!=binary or row.get('platform')!='linux' or row.get('arch')!='x64':
        raise ValueError('Probe did not execute in the actual application main context')
    if row.get('mdwe')!=policy['requestedBits'] or row.get('rwToRx')!=-13 or row.get('rwx')!=-13 or row.get('filePrivateRx')!=42:
        raise ValueError('Unexpected actual probe result')
    if not policy['getAfter'] or policy['getAfter'][-1]!=policy['requestedBits']:
        raise ValueError('Actual plugin GET_MDWE readback missing')
    lines=text.splitlines()
    positions=[i for i,line in enumerate(lines) if re.match(r'^prctl\(PR_GET_MDWE,',line)]
    if not positions:raise ValueError('No probe readback trace')
    tail=lines[positions[-1]+1:]
    rw=re.compile(r'^mmap\(NULL, 4096, PROT_READ\|PROT_WRITE, MAP_PRIVATE\|MAP_ANONYMOUS, -1, 0\)\s+=\s+(0x[0-9a-f]+)$')
    allocations=[(i,m.group(1)) for i,line in enumerate(tail) if (m:=rw.match(line))]
    pairs=[]
    for i,address in allocations:
        denied=re.compile(r'^mprotect\('+re.escape(address)+r', 4096, PROT_READ\|PROT_EXEC\)\s+=\s+-1 EACCES\b')
        pairs.extend((tail[i],line) for line in tail[i+1:] if denied.match(line))
    rwx=[line for line in tail if re.match(r'^mmap\(NULL, 4096, PROT_READ\|PROT_WRITE\|PROT_EXEC, MAP_PRIVATE\|MAP_ANONYMOUS, -1, 0\)\s+=\s+-1 EACCES\b',line)]
    memfd=[line for line in tail if line.startswith('memfd_create("p6-synthetic-code",') and re.search(r'= \d+</memfd:p6-synthetic-code>\(deleted\)$',line)]
    file_rx=[line for line in tail if re.match(r'^mmap\(NULL, 4096, PROT_READ\|PROT_EXEC, MAP_PRIVATE, \d+</memfd:p6-synthetic-code>\(deleted\), 0\)\s+=\s+0x[0-9a-f]+$',line)]
    if not pairs or not rwx or not memfd or not file_rx:raise ValueError('Missing corresponding memory denial/allowed file-RX syscall evidence')
    return {'pass':True,'scope':'Actual app main-thread anonymous RWX and RW-to-RX denial; file-backed private RX remains allowed','rwToRx':pairs,'rwx':rwx,'memfd':memfd,'filePrivateRx':file_rx,'probe':row}
