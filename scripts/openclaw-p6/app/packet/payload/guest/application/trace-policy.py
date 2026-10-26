"""Read only the actual application's strace file; no policy is injected."""
import hashlib
import json
import re

BITS = {'PR_MDWE_REFUSE_EXEC_GAIN': 1, 'PR_MDWE_NO_INHERIT': 2}


def value(text):
    token = text.strip().split(' /*', 1)[0].split(' (', 1)[0].strip()
    result = 0
    for part in token.split('|'):
        part = part.strip()
        try:
            result |= BITS[part] if part in BITS else int(part, 0)
        except ValueError:
            raise ValueError('Unrecognized MDWE value: ' + token) from None
    return result


def analyze(traces, binary, expected, argv):
    application = re.compile(r'^execve\(' + re.escape(json.dumps(binary)) + r',.*\)\s+=\s+0$')
    execution = re.compile(r'^execve\(' + re.escape(json.dumps(binary)) + r',\s*' +
                           re.escape(json.dumps([binary, *argv])) + r',.*\)\s+=\s+0$')
    roots = [(name, text) for name, text in traces.items()
             if any(execution.match(line) for line in text.splitlines())]
    if len(roots) != 1:
        raise ValueError('Expected one trace of the admitted application invocation')
    name, text = roots[0]
    other_executions = [other for other, body in traces.items() if other != name and
                        any(application.match(line) for line in body.splitlines())]
    if not re.search(r'^\+\+\+ exited with 0 \+\+\+$', text, re.M):
        raise ValueError('Application trace lacks a successful terminal exit')
    observations = []
    for line in text.splitlines():
        match = re.match(r'^prctl\(PR_(GET|SET)_MDWE(?:,\s*(.*))?\)\s+=\s+(.+)$', line)
        if not match:
            continue
        kind, arguments, returned = match.groups()
        if returned.startswith('-1 '):
            observations.append({'kind': kind, 'success': False, 'line': line})
            continue
        row = {'kind': kind, 'success': True, 'returnValue': value(returned), 'line': line}
        if kind == 'SET':
            row['bits'] = value(arguments.split(',', 1)[0])
        observations.append(row)
    sets = [index for index, row in enumerate(observations)
            if row['kind'] == 'SET' and row['success'] and row['returnValue'] == 0 and row['bits'] == expected]
    if len(sets) != 1:
        raise ValueError('Expected one successful application PR_SET_MDWE for the admitted bits')
    position = sets[0]
    before = [row['returnValue'] for row in observations[:position] if row['kind'] == 'GET' and row['success']]
    after = [row['returnValue'] for row in observations[position + 1:] if row['kind'] == 'GET' and row['success']]
    if not before or before[-1] != 0:
        raise ValueError('Application did not observe an unenforced MDWE baseline before its SET')
    if any(bits != expected for bits in after):
        raise ValueError('A post-SET application PR_GET_MDWE differs from the requested bits')
    return {'trace': name, 'traceSha256': hashlib.sha256(text.encode()).hexdigest(),
            'argv': [binary, *argv], 'otherApplicationExecTraces': other_executions,
            'requestedBits': expected, 'successfulSet': True, 'getBefore': before,
            'getAfter': after, 'observations': observations,
            'scope': 'Direct application CLI requested MDWE and the kernel accepted it; no injected GET or memory-mapping probe.'}
