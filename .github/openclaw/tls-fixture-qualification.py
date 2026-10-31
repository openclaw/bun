"""Qualify a test-only source delta on the exact retained native runtime artifacts."""
import hashlib
import json
import os
from pathlib import Path
import re
import runpy
import shutil
import stat
import subprocess
import sys
import time
import xml.etree.ElementTree as ET
import zipfile

LIBRARY = runpy.run_path(str(Path(__file__).with_name('tls-cycle-checkpoint.py')), run_name='checkpoint_contract')
COMMIT, ENGINE, FIXTURE = (LIBRARY[key] for key in ('COMMIT', 'ENGINE', 'FIXTURE'))
TEST_SOURCE = '8918ddaed89d97ae1605dbd1e1149121f2433d04'
FIXTURE_SHA = '5cca33c82b9120f350f8c51cfaba49109caaa4697272628b48e97a9221b0ec04'
ROOT = Path(os.environ['RUNNER_TEMP']) / 'tls-fixture-input'
OUT = Path('tls-fixture-qualification')
SOURCE = Path('source')
SPECS = {
    'darwin-x64': (13057470428, 'signed-darwin-x64', 232201333, 'a4d8b786d7bb87d166f757e089ac1705f4ac0701504038ebbecd438c9d6e06d6'),
    'darwin-arm64': (13057590237, 'signed-darwin-arm64', 216129450, 'a93fdf3cf995662876b87348f74c1135a62980910e7423a9750260cdde30080f'),
    'linux-x64': (13056872046, 'build-linux-x64', 222954227, '7ef34a5999d54ec04afd44b8f85041bc33e78a54b8e5dec16c908920a49cb55d'),
    'linux-arm64': (13056617461, 'build-linux-arm64', 222623871, 'c54dbe7ea29a336c76db1dd5ba491bbb117a6c211d938892c62f2f5e74251fcd'),
    'windows-x64': (13056907950, 'test-only-windows', 596111335, '5c81e59c6e6ee0b1a21a9f03b61eda6ff8616d3a1fab631c7e1c1d4899a58bb6'),
    'windows-arm64': (13056907950, 'test-only-windows', 596111335, '5c81e59c6e6ee0b1a21a9f03b61eda6ff8616d3a1fab631c7e1c1d4899a58bb6'),
}


def sha(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def clean():
    subprocess.run(['git', '-C', str(SOURCE), 'diff-index', '--quiet', 'HEAD', '--'], check=True)


def main(target):
    OUT.mkdir(exist_ok=True)
    artifact, name, size, digest = SPECS[target]
    platform, arch = target.split('-')
    platform = 'win32' if platform == 'windows' else platform
    assert not any(os.environ.get(k) for k in ('GH_TOKEN', 'GITHUB_TOKEN', 'NODE_OPTIONS', 'BUN_OPTIONS'))
    head = subprocess.check_output(['git', '-C', str(SOURCE), 'rev-parse', 'HEAD'], text=True).strip()
    assert head == TEST_SOURCE
    assert subprocess.check_output(['git', '-C', str(SOURCE), 'show', '-s', '--format=%P', 'HEAD'], text=True).strip() == COMMIT
    assert subprocess.check_output(['git', '-C', str(SOURCE), 'diff', '--name-only', COMMIT, 'HEAD'], text=True).splitlines() == [FIXTURE]
    clean()
    original = subprocess.check_output(['git', '-C', str(SOURCE), 'show', COMMIT + ':' + FIXTURE])
    assert hashlib.sha256(original).hexdigest() == LIBRARY['FIXTURE_SHA']
    assert original.count(LIBRARY['ORIGINAL'].encode()) == 1
    candidate = original.replace(LIBRARY['ORIGINAL'].encode(), LIBRARY['CANDIDATE'].encode(), 1)
    assert (SOURCE / FIXTURE).read_bytes() == candidate and sha(SOURCE / FIXTURE) == FIXTURE_SHA
    owner = (SOURCE / 'scripts/openclaw-release/release.ts').read_text()
    block = re.search(r'export const tlsQualificationFiles = \[(.*?)\] as const;', owner, re.S)
    assert block
    files = json.loads('[' + block[1].rstrip().removesuffix(',') + ']')
    assert len(files) == len(set(files)) == 6 and files[0] == FIXTURE
    assert len({Path(file).name for file in files}) == 6
    assert all((SOURCE / file).is_file() and not (SOURCE / file).is_symlink() for file in files)
    run = json.loads((ROOT / 'run.json').read_text())
    meta = json.loads((ROOT / 'metadata.json').read_text())
    assert run['id'] == 41238111110 and run['head_sha'] == COMMIT
    assert run['status'] == 'completed' and run['conclusion'] == 'failure'
    assert run['event'] == 'workflow_dispatch' and run['path'] == '.github/workflows/openclaw-release.yml'
    assert meta['id'] == artifact and meta['name'] == name and not meta['expired']
    assert meta['size_in_bytes'] == size and meta['digest'] == 'sha256:' + digest
    assert meta['workflow_run']['id'] == run['id'] and meta['workflow_run']['head_sha'] == COMMIT
    archive = ROOT / 'artifact.zip'
    assert archive.stat().st_size == size and sha(archive) == digest
    archive_library = runpy.run_path(str(Path(__file__).with_name('tls-darwin-capability.py')), run_name='archive_library')
    triplet = 'bun-' + ('windows' if platform == 'win32' else platform) + '-' + ('aarch64' if arch == 'arm64' else arch)
    product, exe = ROOT / 'product.zip', ROOT / ('bun.exe' if platform == 'win32' else 'bun')
    archive_library['extract'](archive, triplet + '.zip', product, 1024**3)
    archive_library['extract'](product, triplet + '/' + exe.name, exe, 1024**3)
    exe.chmod(0o700)
    exe = exe.resolve()
    identity = subprocess.run([str(exe), '-e', 'console.log(JSON.stringify({revision:Bun.revision,webkit:process.versions.webkit,platform:process.platform,arch:process.arch}))'],
        capture_output=True, check=True, text=True, timeout=120)
    assert not identity.stderr
    facts = json.loads(identity.stdout)
    assert facts == dict(revision=COMMIT, webkit=ENGINE, platform=platform, arch=arch)
    node = shutil.which('node')
    assert node
    reference = subprocess.run([node, '-e', 'console.log(JSON.stringify({name:process.release.name,version:process.versions.node,bun:process.versions.bun??null,platform:process.platform,arch:process.arch,exe:process.execPath}))'],
        capture_output=True, check=True, text=True, timeout=120)
    ref = json.loads(reference.stdout)
    assert ref == dict(name='node', version='26.12.1', bun=None, platform=platform, arch=arch, exe=ref['exe'])
    assert os.path.normcase(os.path.realpath(ref['exe'])) == os.path.normcase(os.path.realpath(node))
    signature = None
    if platform == 'darwin':
        with zipfile.ZipFile(archive) as contents:
            required = arch == 'arm64' or target + '.signing.json' in contents.namelist()
        result = subprocess.run(['codesign', '--verify', '--strict', str(exe)], capture_output=True, timeout=120)
        signature = dict(required_by_release_contract=required, exit_code=result.returncode,
            stderr=result.stderr.decode().replace(str(exe), exe.name))
        assert not required or result.returncode == 0
    receipt = dict(target=target, runtime_source=COMMIT, test_source=TEST_SOURCE, engine=ENGINE,
        artifact_id=artifact, artifact_sha256=digest, product_zip_sha256=sha(product),
        executable_sha256=sha(exe), facts=facts, fixture_sha256=FIXTURE_SHA,
        runtime_diff_from_product_source=[], sole_source_diff=FIXTURE, node_version='26.12.1',
        signature=signature, suites=[], claim='unchanged runtime artifacts, exact test-only source correction; no release publication')
    deadline = time.monotonic() + 20 * 60
    try:
        for file in files:
            basename = Path(file).name
            report = (OUT / (basename + '.xml')).resolve()
            assert not report.exists()
            argv = [str(exe), 'test', file, '--reporter=junit', '--reporter-outfile=' + str(report)]
            result = subprocess.run(argv, cwd=SOURCE, stdin=subprocess.DEVNULL, capture_output=True,
                timeout=max(1, deadline - time.monotonic()))
            assert len(result.stdout) + len(result.stderr) <= 4 * 1024**2
            (OUT / (basename + '.stdout')).write_bytes(result.stdout)
            (OUT / (basename + '.stderr')).write_bytes(result.stderr)
            doc = ET.parse(report).getroot()
            cases = list(doc.iter('testcase'))
            skipped = len(list(doc.iter('skipped')))
            failures, errors = len(list(doc.iter('failure'))), len(list(doc.iter('error')))
            assert doc.tag == 'testsuites' and int(doc.get('tests')) == len(cases)
            assert int(doc.get('skipped')) == skipped and int(doc.get('failures')) == failures
            row = dict(file=file, exit_code=result.returncode, tests=len(cases), skipped=skipped, failures=failures, errors=errors)
            receipt['suites'].append(row)
            assert result.returncode == 0 and failures == errors == 0 and len(cases) > skipped, row
        assert sha(exe) == receipt['executable_sha256']
        receipt['passed'] = True
    finally:
        clean()
        assert sha(SOURCE / FIXTURE) == FIXTURE_SHA
        receipt['source_and_index_unchanged'] = True
        (OUT / 'receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
        paths = sorted(OUT.iterdir())
        assert len(paths) <= 23 and all(stat.S_ISREG(p.lstat().st_mode) for p in paths)
        assert sum(p.stat().st_size for p in paths) <= 32 * 1024**2
        (OUT / 'manifest.json').write_text(json.dumps({p.name: dict(bytes=p.stat().st_size, sha256=sha(p))
            for p in paths}, indent=2) + '\n')
    print(json.dumps(receipt))


if __name__ == '__main__':
    action, target = sys.argv[1:]
    if action == 'plan':
        artifact, name, size, digest = SPECS[target]
        print(f'artifact={artifact}\nsize={size}')
    else:
        assert action == 'qualify'
        main(target)
