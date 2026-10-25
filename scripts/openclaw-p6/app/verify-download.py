#!/usr/bin/env python3
"""Verify an authenticated exact-run artifact download before compiler adoption."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import zipfile

p = argparse.ArgumentParser(description=__doc__)
p.add_argument('--metadata', type=Path, required=True)
p.add_argument('--zip', type=Path, required=True)
p.add_argument('--profile', choices=['cb-standard', 'cb-compat'], required=True)
p.add_argument('--out', type=Path, required=True)
a = p.parse_args()
metadata = json.loads(a.metadata.read_text())
assert metadata['workflow_run']['id'] == 40214829538
assert metadata['workflow_run']['head_sha'] == 'f9fa08790bf45b3e995280f6eb249e14fd9191c1'
expected_name = 'p6-linux-x64-' + ('standard' if a.profile == 'cb-standard' else 'shadowrealm-off') + '-f9fa08790bf45b3e995280f6eb249e14fd9191c1-attempt1'
assert metadata['name'] == expected_name and not metadata['expired']
with a.zip.open('rb') as stream:
    zip_sha = hashlib.file_digest(stream, 'sha256').hexdigest()
assert metadata['digest'] == 'sha256:' + zip_sha
assert not a.out.exists()
unpacked = a.out / 'github-artifact'
with zipfile.ZipFile(a.zip) as archive:
    members = archive.infolist()
    assert {member.filename for member in members} == {'compiler.tar', 'transport.json'}
    assert all(not member.is_dir() and not member.filename.startswith('/') and '..' not in Path(member.filename).parts for member in members)
    unpacked.mkdir(parents=True)
    archive.extractall(unpacked)
transport = unpacked / 'transport.json'
with transport.open('rb') as stream:
    transport_sha = hashlib.file_digest(stream, 'sha256').hexdigest()
subprocess.run([sys.executable, str(Path(__file__).with_name('verify-compiler.py')),
                '--profile', a.profile, '--archive', str(unpacked / 'compiler.tar'), '--transport', str(transport),
                '--transport-sha256', transport_sha, '--out', str(a.out / 'compiler')], check=True)
directory = 'build-standard' if a.profile == 'cb-standard' else 'build-c2'
config = json.loads((a.out / 'compiler' / directory / 'configure.json').read_text())
build = json.loads((a.out / 'compiler' / 'receipts' / f'{a.profile}-build.json').read_text())
assert config['overrides']['relr'] is False and config['overrides']['baseline'] is True
assert build['versions'] == {'webkit': 'aaa690bfbf34c9d50775716ac2fc3c7d0573e0b8', 'arch': 'x64', 'platform': 'linux'}
assert '150c9620c' in build['revision']
assert '-j2' in build['command'] and build['command'][4:7] == ['/usr/bin/nice', '-n', '10']
result = {'status': 'authenticated-artifact-and-compiler-verified-not-app-qualified', 'profile': a.profile,
          'workflowRun': 40214829538, 'workflowHead': metadata['workflow_run']['head_sha'],
          'artifactId': metadata['id'], 'artifactName': metadata['name'], 'artifactZipSha256': zip_sha,
          'transportSha256': transport_sha, 'compilerSha256': build['compilerSha256'],
          'compilerPath': str(a.out / 'compiler' / directory / 'bun'), 'sourceBun': build['source']['bun'],
          'sourceWebKit': build['source']['webkit'], 'applicationQualified': False}
(a.out / 'adoption-verification.json').write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps(result, indent=2))
