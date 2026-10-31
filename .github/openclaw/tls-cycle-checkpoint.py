"""Compare two GC checkpoints with identical retained shipping bytes and assertions."""
import difflib
import hashlib
import json
import os
from pathlib import Path
import re
import runpy
import subprocess
import xml.etree.ElementTree as ET

ROOT = Path(os.environ['RUNNER_TEMP']) / 'tls-darwin-input'
OUT = Path('tls-cycle-checkpoint')
SOURCE = Path('source')
COMMIT = '510fef558b464c58de1209298f638fa476d03eef'
ENGINE = 'b82bc917e99110b61c3a21202d6def7457aa194c'
ARTIFACT = 13057470428
DIGEST = 'a4d8b786d7bb87d166f757e089ac1705f4ac0701504038ebbecd438c9d6e06d6'
FIXTURE = 'test/js/bun/net/socket-retention.test.ts'
FIXTURE_SHA = 'd4c04a72b89bc7d33c292a16a57c38f5da540815dc2e141adfd58c1bd9973af2'
CASE = 'TLS Duplex cycles collect after startup while a retained origin keeps its wrapper alive'
ORIGINAL = '''        const dropped = await makePair(false);
        for (let i = 0; i < 30; i++) { await turn(); Bun.gc(true); }'''
CANDIDATE = '''        const dropped = await makePair(false);
        for (let i = 0; i < 30; i++) {
          await new Promise(resolve => setImmediate(() => { Bun.gc(true); resolve(); }));
        }'''


def sha(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def run(args, **kwargs):
    return subprocess.run(args, stdin=subprocess.DEVNULL, capture_output=True, timeout=120, **kwargs)


def main():
    OUT.mkdir(exist_ok=True)
    assert os.uname().sysname == 'Darwin' and os.uname().machine == 'x86_64'
    assert not any(os.environ.get(k) for k in ('GH_TOKEN', 'GITHUB_TOKEN', 'NODE_OPTIONS', 'BUN_OPTIONS'))
    assert subprocess.check_output(['git', '-C', str(SOURCE), 'rev-parse', 'HEAD'], text=True).strip() == COMMIT
    assert not subprocess.check_output(['git', '-C', str(SOURCE), 'diff', '--name-only', 'HEAD'], text=True)
    fixture = SOURCE / FIXTURE
    original = fixture.read_bytes()
    assert hashlib.sha256(original).hexdigest() == FIXTURE_SHA
    assert original.count(ORIGINAL.encode()) == 1
    candidate = original.replace(ORIGINAL.encode(), CANDIDATE.encode(), 1)
    assert candidate.count(b'Bun.gc(true)') == original.count(b'Bun.gc(true)')
    (OUT / 'fixture.patch').write_text(''.join(difflib.unified_diff(original.decode().splitlines(True),
        candidate.decode().splitlines(True), fromfile=FIXTURE, tofile=FIXTURE)))
    run_meta = json.loads((ROOT / 'run.json').read_text())
    meta = json.loads((ROOT / 'metadata.json').read_text())
    assert run_meta['id'] == 41238111110 and run_meta['head_sha'] == COMMIT
    assert run_meta['path'] == '.github/workflows/openclaw-release.yml'
    assert run_meta['event'] == 'workflow_dispatch' and run_meta['status'] == 'completed'
    assert run_meta['conclusion'] == 'failure'
    assert meta['id'] == ARTIFACT and meta['name'] == 'signed-darwin-x64'
    assert meta['size_in_bytes'] == 232201333 and not meta['expired']
    assert meta['digest'] == 'sha256:' + DIGEST and meta['workflow_run']['id'] == 41238111110
    assert meta['workflow_run']['head_sha'] == COMMIT
    archive = ROOT / 'artifact.zip'
    assert archive.stat().st_size == 232201333 and sha(archive) == DIGEST
    library = runpy.run_path(str(Path(__file__).with_name('tls-darwin-capability.py')), run_name='archive_library')
    product_zip, exe = ROOT / 'product.zip', ROOT / 'bun'
    library['extract'](archive, 'bun-darwin-x64.zip', product_zip, 1024**3)
    library['extract'](product_zip, 'bun-darwin-x64/bun', exe, 1024**3)
    exe.chmod(0o700)
    exe = exe.resolve()
    identity = run([str(exe), '-e', 'console.log(JSON.stringify({revision:Bun.revision,webkit:process.versions.webkit,platform:process.platform,arch:process.arch}))'], check=True, text=True)
    assert not identity.stderr
    facts = json.loads(identity.stdout)
    assert facts == dict(revision=COMMIT, webkit=ENGINE, platform='darwin', arch='x64')
    signature = run(['codesign', '--verify', '--strict', str(exe)])
    assert signature.returncode == 0
    receipt = dict(commit=COMMIT, engine=ENGINE, artifact_id=ARTIFACT, artifact_sha256=DIGEST,
        product_zip_sha256=sha(product_zip), executable_sha256=sha(exe), facts=facts,
        fixture_sha256=FIXTURE_SHA, candidate_sha256=hashlib.sha256(candidate).hexdigest(),
        explicit_collections_first_phase=30, assertions_changed=False, runs=[],
        claim='paired GC frame/job-phase sensitivity only; no retaining owner or runtime fix established')
    try:
        for repetition in (1, 2):
            for arm, contents in (('baseline', original), ('candidate', candidate)):
                fixture.write_bytes(contents)
                name = f'{arm}-{repetition}'
                report = (OUT / (name + '.xml')).resolve()
                assert not report.exists()
                argv = [str(exe), 'test', FIXTURE, '--test-name-pattern', '^' + re.escape(CASE) + '$',
                        '--reporter=junit', '--reporter-outfile=' + str(report)]
                result = run(argv, cwd=SOURCE)
                assert len(result.stdout) + len(result.stderr) <= 4 * 1024**2
                (OUT / (name + '.stdout')).write_bytes(result.stdout)
                (OUT / (name + '.stderr')).write_bytes(result.stderr)
                root = ET.parse(report).getroot()
                cases = list(root.iter('testcase'))
                chosen = [case for case in cases if case.get('name') == CASE]
                assert len(chosen) == 1 and not list(root.iter('error'))
                case = chosen[0]
                assert case.get('file') == FIXTURE and case.find('skipped') is None
                assert all(item.find('skipped') is not None and item.find('failure') is None
                           for item in cases if item is not case)
                failures = case.findall('failure')
                received = None
                if failures:
                    assert len(failures) == 1 and failures[0].get('type') == 'AssertionError'
                    message = failures[0].get('message', '')
                    match = re.search(r'Received: "(\{[^\n]+\})"', message)
                    assert match, message
                    received = json.loads(match[1])
                receipt['runs'].append(dict(arm=arm, repetition=repetition, exit_code=result.returncode,
                    failures=len(failures), received=received, assertions='unchanged'))
                (OUT / 'receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
                assert sha(exe) == receipt['executable_sha256']
        receipt['repeatable_checkpoint_sensitivity'] = all(
            row['exit_code'] == (1 if row['arm'] == 'baseline' else 0) and
            row['failures'] == (1 if row['arm'] == 'baseline' else 0) and
            (row['arm'] == 'candidate' or row['received'] == dict(
                retainedAlive=True, droppedCollected=False, releasedCollected=True))
            for row in receipt['runs'])
    finally:
        fixture.write_bytes(original)
        assert sha(fixture) == FIXTURE_SHA
        assert not subprocess.check_output(['git', '-C', str(SOURCE), 'diff', '--name-only', 'HEAD'], text=True)
        receipt['source_restored'] = True
        (OUT / 'receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
    files = sorted(OUT.iterdir())
    assert len(files) <= 24 and sum(p.stat().st_size for p in files) <= 32 * 1024**2
    (OUT / 'manifest.json').write_text(json.dumps({p.name: dict(bytes=p.stat().st_size, sha256=sha(p))
        for p in files}, indent=2) + '\n')
    print(json.dumps(receipt))
    assert receipt['repeatable_checkpoint_sensitivity'], 'experiment inconclusive: inspect all arms without changing expectations'


if __name__ == '__main__':
    main()
