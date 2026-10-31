"""Capture the retained production cycle graph, with snapshot GC kept explicit."""
from collections import defaultdict, deque
import difflib
import hashlib
import json
import os
from pathlib import Path
import re
import runpy
import subprocess
import xml.etree.ElementTree as ET
import zipfile

OUT = Path('tls-cycle-heap')
TAGS = tuple('__tls_cycle_' + name for name in
             ('control_origin', 'control_handle', 'dropped_origin', 'dropped_handle'))


def project_graph(graph):
    assert graph['version'] == 3 and graph['type'] == 'GCDebugging'
    assert graph['edgeTypes'] == ['Internal', 'Property', 'Index', 'Variable']
    assert len(graph['nodes']) % 7 == len(graph['edges']) % 4 == len(graph['roots']) % 3 == 0
    classes, labels, names = (graph[key] for key in ('nodeClassNames', 'labels', 'edgeNames'))
    assert all(isinstance(s, str) for table in (classes, labels, names) for s in table)
    nodes = {}
    for i in range(0, len(graph['nodes']), 7):
        ident, size, cls, flags, label, cell, wrapped = graph['nodes'][i:i + 7]
        assert all(type(n) is int and n >= 0 for n in (ident, size, cls, flags, label))
        assert ident not in nodes and cls < len(classes) and label < len(labels)
        assert all(isinstance(a, str) and re.fullmatch(r'0x[0-9a-fA-F]+', a) for a in (cell, wrapped))
        nodes[ident] = dict(id=ident, bytes=size, type=classes[cls], label=labels[label],
                            flags=flags, cell=cell, wrapped=wrapped)
    assert 0 in nodes
    incoming, outgoing, tagged = defaultdict(list), defaultdict(list), defaultdict(set)
    edges = []
    for i in range(0, len(graph['edges']), 4):
        source, dest, kind, data = graph['edges'][i:i + 4]
        assert all(type(n) is int and n >= 0 for n in (source, dest, kind, data))
        assert source in nodes and dest in nodes and kind < 4
        if kind in (1, 3):
            assert data < len(names)
        edge = dict(source=source, dest=dest, type=graph['edgeTypes'][kind],
                    name=names[data] if kind in (1, 3) else data)
        edges.append(edge)
        incoming[dest].append(edge)
        outgoing[source].append(edge)
        if kind == 1 and edge['name'] in TAGS:
            tagged[edge['name']].add(source)
    roots = []
    for i in range(0, len(graph['roots']), 3):
        ident, reason, reachability = graph['roots'][i:i + 3]
        assert all(type(n) is int and n >= 0 for n in (ident, reason, reachability))
        assert ident in nodes and reason < len(labels) and reachability < len(labels)
        roots.append(dict(id=ident, reason=labels[reason], reachability=labels[reachability]))
    assert all(len(tagged[name]) == 1 for name in TAGS[:2]), 'missing or ambiguous live-control tags'
    assert all(len(tagged[name]) <= 1 for name in TAGS), 'ambiguous diagnostic tag'

    def reachable(start, adjacency, field):
        seen, queue, toward = {start}, deque([start]), {}
        while queue:
            node = queue.popleft()
            for edge in adjacency[node]:
                other = edge[field]
                if other not in seen:
                    seen.add(other)
                    toward[other] = edge
                    queue.append(other)
        return seen, toward

    def path(start, target, toward):
        result = []
        while start != target:
            edge = toward[start]
            result.append(edge)
            start = edge['dest']
        return result

    targets = {}
    for tag in TAGS:
        if not tagged[tag]:
            targets[tag] = dict(present=False, interpretation='collected or otherwise absent during this diagnostic')
            continue
        target = next(iter(tagged[tag]))
        ancestors, toward = reachable(target, incoming, 'source')
        descendants, _ = reachable(target, outgoing, 'dest')
        component = ancestors & descendants
        targets[tag] = dict(present=True, node=nodes[target], incoming=incoming[target],
            direct_roots=[root for root in roots if root['id'] == target],
            root_paths=[dict(root=root, path=path(root['id'], target, toward))
                        for root in roots if root['id'] in ancestors],
            synthetic_root_path=path(0, target, toward) if 0 in ancestors else None,
            scc=[nodes[ident] for ident in sorted(component)],
            scc_external_incoming=[edge for ident in sorted(component) for edge in incoming[ident]
                                   if edge['source'] not in component])
    return dict(nodes=len(nodes), edges=len(edges), roots=roots, targets=targets,
                claim='snapshot-GC graph with all recorded roots; no same-process scanner or writer proof')


def main():
    library = runpy.run_path(str(Path(__file__).with_name('tls-cycle-checkpoint.py')), run_name='checkpoint_contract')
    source, root, commit, engine, fixture_name, case_name = (
        library[name] for name in ('SOURCE', 'ROOT', 'COMMIT', 'ENGINE', 'FIXTURE', 'CASE'))
    sha, run = library['sha'], library['run']
    assert os.uname().sysname == 'Darwin' and os.uname().machine == 'x86_64'
    assert not any(os.environ.get(key) for key in ('GH_TOKEN', 'GITHUB_TOKEN', 'NODE_OPTIONS', 'BUN_OPTIONS'))
    assert subprocess.check_output(['git', '-C', str(source), 'rev-parse', 'HEAD'], text=True).strip() == commit
    assert not subprocess.check_output(['git', '-C', str(source), 'diff', '--name-only', 'HEAD'], text=True)
    fixture = source / fixture_name
    original = fixture.read_bytes()
    assert hashlib.sha256(original).hexdigest() == library['FIXTURE_SHA']
    producer, artifact = (json.loads((root / name).read_text()) for name in ('run.json', 'metadata.json'))
    assert producer['id'] == 41238111110 and producer['head_sha'] == commit
    assert producer['path'] == '.github/workflows/openclaw-release.yml' and producer['event'] == 'workflow_dispatch'
    assert producer['status'] == 'completed' and producer['conclusion'] == 'failure'
    assert artifact['id'] == library['ARTIFACT'] and artifact['name'] == 'signed-darwin-x64' and not artifact['expired']
    assert artifact['size_in_bytes'] == 232201333 and artifact['digest'] == 'sha256:' + library['DIGEST']
    assert artifact['workflow_run']['id'] == producer['id'] and artifact['workflow_run']['head_sha'] == commit
    archive = root / 'artifact.zip'
    assert archive.stat().st_size == artifact['size_in_bytes'] and sha(archive) == library['DIGEST']
    extractor = runpy.run_path(str(Path(__file__).with_name('tls-darwin-capability.py')), run_name='archive_library')['extract']
    product, exe = root / 'product.zip', root / 'bun'
    extractor(archive, 'bun-darwin-x64.zip', product, 1024**3)
    extractor(product, 'bun-darwin-x64/bun', exe, 1024**3)
    exe.chmod(0o700)
    exe = exe.resolve()
    executable_sha = '3b8fd7a18caf0dd8365b1672483d6651f4cb2b6d02bb6b5f704fb6888f886310'
    assert sha(exe) == executable_sha
    for name in ('home', 'tmp'):
        (root / name).mkdir()
    execution_env = dict(PATH=os.environ['PATH'], HOME=str(root / 'home'),
                         TMPDIR=str(root / 'tmp') + '/', CI='true', LANG='en_US.UTF-8')
    identity = run([str(exe), '-e', 'console.log(JSON.stringify({revision:Bun.revision,webkit:process.versions.webkit,platform:process.platform,arch:process.arch}))'], check=True, text=True, env=execution_env)
    assert not identity.stderr
    facts = json.loads(identity.stdout)
    assert facts == dict(revision=commit, webkit=engine, platform='darwin', arch='x64')
    signature = run(['codesign', '--verify', '--strict', str(exe)])
    with zipfile.ZipFile(archive) as files:
        required = 'darwin-x64.signing.json' in files.namelist()
    assert not required or signature.returncode == 0
    signature_record = dict(required_by_release_contract=required, exit_code=signature.returncode,
                            stderr=signature.stderr.decode().replace(str(exe), 'bun'))
    (OUT / 'signature.json').write_text(json.dumps(signature_record, indent=2) + '\n')
    start = original.index(('test("' + case_name + '"').encode())
    end = original.index(b'\nfor (const destroyBeforeCompletion', start)
    chunk = original[start:end].decode()
    preload = '        const tls = require("node:tls");'
    imports = '        const { writeFileSync } = require("node:fs");\n        const { generateHeapSnapshotForDebugging } = require("bun:jsc");\n'
    tags = '''          Object.defineProperty(clientSide, retain ? "__tls_cycle_control_origin" : "__tls_cycle_dropped_origin", { value: Object.create(null) });
          Object.defineProperty(client._handle, retain ? "__tls_cycle_control_handle" : "__tls_cycle_dropped_handle", { value: Object.create(null) });
'''
    before_return = '          return { weak: new WeakRef(client._handle), origin: retain ? clientSide : null };'
    checkpoint = '        for (let i = 0; i < 30; i++) { await turn(); Bun.gc(true); }'
    assert chunk.count(preload) == chunk.count(before_return) == 1 and chunk.count(checkpoint) == 2
    tagged = chunk.replace(preload, imports + preload).replace(before_return, tags + before_return)
    snapshot = (OUT / 'snapshot.json').resolve()
    capture = ('\n        const snapshotText = JSON.stringify(generateHeapSnapshotForDebugging());\n'
               '        if (Buffer.byteLength(snapshotText) > 24 * 1024**2) throw new Error("snapshot evidence exceeds 24 MiB");\n'
               '        writeFileSync(' + json.dumps(os.path.relpath(snapshot, source.resolve())) + ', snapshotText);')
    captured = tagged.replace(checkpoint, checkpoint + capture, 1)
    arms = [('baseline', original), ('tagged-control', original[:start] + tagged.encode() + original[end:]),
            ('snapshot', original[:start] + captured.encode() + original[end:])]
    receipt = dict(runtime_source=commit, engine=engine, executable_sha256=executable_sha,
        artifact_id=artifact['id'], artifact_sha256=library['DIGEST'], product_zip_sha256=sha(product),
        facts=facts, fixture_sha256=library['FIXTURE_SHA'], signature=signature_record, runs=[],
        observer_effects=['tags change allocation and object shapes', 'snapshot API performs an additional full GC',
                          'diagnostic imports and snapshot serialization add work'],
        execution_environment_keys=sorted(execution_env), execution_home='empty task-owned directory',
        unchanged_checkpoint_claim=False, scanner_cause_proven=False)
    try:
        for arm, contents in arms:
            fixture.write_bytes(contents)
            if arm != 'baseline':
                (OUT / (arm + '.patch')).write_text(''.join(difflib.unified_diff(
                    original.decode().splitlines(True), contents.decode().splitlines(True),
                    fromfile=fixture_name, tofile=fixture_name)))
            report = (OUT / (arm + '.xml')).resolve()
            assert not report.exists()
            result = run([str(exe), 'test', fixture_name, '--test-name-pattern', '^' + re.escape(case_name) + '$',
                          '--reporter=junit', '--reporter-outfile=' + str(report)], cwd=source, env=execution_env)
            assert len(result.stdout) + len(result.stderr) <= 4 * 1024**2
            (OUT / (arm + '.stdout')).write_bytes(result.stdout)
            (OUT / (arm + '.stderr')).write_bytes(result.stderr)
            doc = ET.parse(report).getroot()
            cases = list(doc.iter('testcase'))
            assert doc.tag == 'testsuites' and int(doc.get('tests')) == len(cases)
            assert int(doc.get('failures')) == len(list(doc.iter('failure')))
            assert int(doc.get('skipped')) == len(list(doc.iter('skipped')))
            selected = [case for case in cases if case.get('name') == case_name]
            assert len(selected) == 1 and not list(doc.iter('error'))
            selected = selected[0]
            assert selected.get('file') == fixture_name and selected.find('skipped') is None
            assert all(case.find('skipped') is not None and case.find('failure') is None
                       for case in cases if case is not selected)
            failures = selected.findall('failure')
            received = None
            if failures:
                assert len(failures) == 1 and failures[0].get('type') == 'AssertionError'
                match = re.search(r'Received: "(\{[^\n]+\})"', failures[0].get('message', ''))
                assert match
                received = json.loads(match[1])
            row = dict(arm=arm, exit_code=result.returncode, failures=len(failures), received=received,
                       fixture_sha256=hashlib.sha256(contents).hexdigest(), assertions='unchanged')
            receipt['runs'].append(row)
            assert sha(exe) == executable_sha
            if arm != 'snapshot':
                assert result.returncode == 1 and len(failures) == 1 and received == dict(
                    retainedAlive=True, droppedCollected=False, releasedCollected=True), row
            else:
                assert result.returncode == (1 if failures else 0)
                assert snapshot.is_file() and snapshot.stat().st_size <= 24 * 1024**2
                graph = project_graph(json.loads(snapshot.read_text()))
                (OUT / 'graph.json').write_text(json.dumps(graph, indent=2) + '\n')
                receipt['snapshot_sha256'] = sha(snapshot)
                receipt['graph_captured'] = True
    finally:
        fixture.write_bytes(original)
        assert sha(fixture) == library['FIXTURE_SHA']
        assert not subprocess.check_output(['git', '-C', str(source), 'diff', '--name-only', 'HEAD'], text=True)
        receipt['source_restored'] = True
        (OUT / 'receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
        files = sorted(OUT.iterdir())
        assert len(files) <= 24 and all(p.is_file() and not p.is_symlink() for p in files)
        assert sum(p.stat().st_size for p in files) <= 32 * 1024**2
        (OUT / 'manifest.json').write_text(json.dumps({p.name: dict(bytes=p.stat().st_size, sha256=sha(p))
            for p in files}, indent=2) + '\n')
    print(json.dumps(receipt))


if __name__ == '__main__':
    main()
