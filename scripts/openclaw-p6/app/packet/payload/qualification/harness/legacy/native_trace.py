"""Native Worker lifecycle proof; no JavaScript observer fields are synthesized."""
from collections import Counter
import hashlib
import json
from pathlib import Path

WORKER_EVENTS = {'thread-spawned', 'thread-start', 'vm-published', 'vm-destroyed', 'thread-end'}
COUNTERS = {'spawned': 'thread-spawned', 'started': 'thread-start', 'published': 'vm-published',
            'destroyed': 'vm-destroyed', 'ended': 'thread-end'}
COMMON = {'version', 'event', 'pid', 'nativeTid'}
DIAGNOSTIC_RUNTIME_OVERRIDE = {'BUN_DESTRUCT_VM_ON_EXIT': '1'}


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def integer(value, minimum=0):
    return type(value) is int and minimum <= value <= (1 << 64) - 1


def read_process(path):
    path = Path(path)
    raw = path.read_bytes()
    assert raw.endswith(b'\n'), 'Native trace is truncated'
    rows = [json.loads(line) for line in raw.decode().splitlines()]
    assert len(rows) >= 2, 'Native trace lacks readiness/footer'
    header, footer = rows[0], rows[-1]
    assert header.get('event') == 'trace-ready' and footer.get('event') == 'trace-end'
    assert set(header) == COMMON | {'parentPid'}, 'Native header schema differs or lacks parentPid'
    assert set(footer) == COMMON | set(COUNTERS) | {'complete'}, 'Native footer schema differs'
    assert integer(header['pid'], 2) and integer(header['parentPid'], 1)
    pid = header['pid']
    assert path.name == f'worker-{pid}.jsonl', 'Trace filename/PID differs'
    contexts = {}
    for row in rows:
        assert row.get('version') == 1 and type(row['version']) is int
        assert row.get('pid') == pid and integer(row.get('nativeTid'), 1)
    for row in rows[1:-1]:
        assert row['event'] in WORKER_EVENTS, 'Unknown native Worker event'
        assert set(row) == COMMON | {'contextId', 'parentContextId'}, 'Worker event schema differs'
        assert integer(row['contextId'], 1) and integer(row['parentContextId'])
        contexts.setdefault(row['contextId'], []).append(row)
    raw_counts = Counter(row['event'] for row in rows[1:-1])
    for key, event in COUNTERS.items():
        assert integer(footer[key]) and footer[key] == raw_counts[event], 'Native footer/raw count differs'
    assert type(footer['complete']) is int and footer['complete'] == 1, 'Native capture incomplete'
    assert footer['spawned'] == footer['started'] == footer['ended']
    assert footer['published'] == footer['destroyed']
    worker_facts = {}
    for context, events in contexts.items():
        spawned = [row for row in events if row['event'] == 'thread-spawned']
        lifecycle = [row for row in events if row['event'] != 'thread-spawned']
        assert len(spawned) == 1, 'Worker lacks exactly one native spawn'
        names = [row['event'] for row in lifecycle]
        assert names in (['thread-start', 'thread-end'],
                         ['thread-start', 'vm-published', 'vm-destroyed', 'thread-end']), 'Worker lifecycle is incomplete or out of order'
        parents = {row['parentContextId'] for row in events}
        assert len(parents) == 1 and context not in parents, 'Worker parent differs or is cyclic'
        tids = {row['nativeTid'] for row in lifecycle}
        assert len(tids) == 1, 'Worker lifecycle moved between native threads'
        worker_facts[context] = {'parentContextId': parents.pop(), 'nativeTid': tids.pop(),
                                 'spawningNativeTid': spawned[0]['nativeTid'], 'published': 'vm-published' in names}
    root_contexts = set()
    for context, worker in worker_facts.items():
        parent = worker_facts.get(worker['parentContextId'])
        if parent is None:
            assert worker['spawningNativeTid'] == header['nativeTid'], 'Worker has unknown parent context'
            root_contexts.add(worker['parentContextId'])
        else:
            assert parent['published'], 'Worker parent has no published VM'
            assert worker['spawningNativeTid'] == parent['nativeTid'], 'Worker spawning thread differs from parent'
        seen = {context}
        ancestor = worker['parentContextId']
        while ancestor in worker_facts:
            assert ancestor not in seen, 'Worker parent cycle'
            seen.add(ancestor)
            ancestor = worker_facts[ancestor]['parentContextId']
    assert len(root_contexts) <= 1, 'Worker roots disagree on main context'
    return {'pid': pid, 'parentPid': header['parentPid'], 'mainNativeTid': header['nativeTid'],
            'workers': worker_facts, 'counts': {key: footer[key] for key in COUNTERS},
            'trace': {'path': str(path), 'sha256': hashlib.sha256(raw).hexdigest()}, 'complete': True}


def summarize(directory, expected_wrappers, *, require_positive=True):
    """Join process headers to known time wrappers, then join nested Bun children."""
    paths = sorted(Path(directory).glob('worker-*.jsonl'))
    assert paths, 'No native process traces'
    processes = {}
    for path in paths:
        process = read_process(path)
        assert process['pid'] not in processes, 'Duplicate process trace'
        processes[process['pid']] = process
    expected = set(expected_wrappers)
    direct = Counter(process['parentPid'] for process in processes.values() if process['parentPid'] in expected)
    assert set(direct) == expected and all(count == 1 for count in direct.values()), 'Missing or duplicate direct artifact process'
    roots = {pid: process['parentPid'] for pid, process in processes.items() if process['parentPid'] in expected}
    pending = set(processes) - set(roots)
    while pending:
        ready = {pid for pid in pending if processes[pid]['parentPid'] in roots}
        assert ready, 'Native process has unknown or cyclic ancestry'
        for pid in ready:
            roots[pid] = roots[processes[pid]['parentPid']]
        pending -= ready
    totals = {key: sum(process['counts'][key] for process in processes.values()) for key in COUNTERS}
    if require_positive:
        assert totals['published'] > 0, 'No positive native Worker VM publication'
    return {'schemaVersion': 1, 'pass': True, 'method': 'native-worker-lifecycle-v1',
            'processCount': len(processes), 'counts': totals,
            'positivePublishedVM': totals['published'] > 0,
            'processes': [{**process, 'timeWrapperPid': roots[pid]} for pid, process in sorted(processes.items())],
            'identityScope': 'PID/parent-PID ancestry and admitted direct commands; no per-descendant executable UUID claim',
            'processCoverage': 'Every expected direct artifact command and observed native descendants; not an all-process observer',
            'vmScope': 'Published Worker VMs only; no main-VM or GC/compiler-thread census'}


def environment(original, directory, *, interpreter_tripwire=False):
    allowed = {'BUN_AOT_TYPE_MISMATCH_LOG': 'stderr', 'BUN_AOT_TYPE_MISMATCH_LOG_FORMAT': 'json'}
    for key, value in original.items():
        if key.startswith(('BUN_', 'JSC_')):
            assert key in allowed and value == allowed[key], 'Unexpected runtime override: ' + key
    assert not any(key in original for key in ('NODE_OPTIONS', 'OPENCLAW_STANDALONE_TRACE', 'OPENCLAW_STANDALONE_TRACE_PRELOAD'))
    directory = Path(directory)
    assert directory.is_absolute() and directory.resolve() == directory
    directory.mkdir(parents=True, exist_ok=True)
    override = {'BUN_JSC_crashIfInterpreterIsUsed': '1'} if interpreter_tripwire else {}
    return {**original, **DIAGNOSTIC_RUNTIME_OVERRIDE, **override,
            'BUN_WORKER_VM_TRACE': str(directory / 'worker-%p.jsonl')}


def command_records(row):
    records = row['cli'] + [row['doctor']]
    for lifetime in row['gateway']['lifetimes']:
        records += [lifetime, lifetime['health'], lifetime['agent']]
    return records
