#!/usr/bin/env python3
"""Download the reviewed compiler pair; credentials never enter the app container."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import urllib.request

HERE = Path(__file__).resolve().parent


class DownloadRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, newurl):
        redirected = super().redirect_request(request, fp, code, message, headers, newurl)
        if redirected is not None:
            redirected.remove_header('Authorization')
        return redirected


def fetch(path, target=None, expected_bytes=None):
    request = urllib.request.Request('https://api.github.com/repos/openclaw/bun/' + path,
        headers={'Authorization': 'Bearer ' + os.environ['GH_TOKEN'],
                 'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28'})
    with urllib.request.build_opener(DownloadRedirect).open(request, timeout=60) as response:
        if target is None:
            return json.load(response)
        with target.open('xb') as stream:
            count = 0
            while block := response.read(1024 * 1024):
                count += len(block)
                assert count <= expected_bytes, 'Artifact exceeds pinned ZIP size'
                stream.write(block)
            assert count == expected_bytes, 'Artifact ZIP size differs'


def main():
    pins = json.loads((HERE / 'compiler-pins.json').read_text())
    assert all(pins['artifacts'].values()), 'Both reviewed compiler artifact identities required'
    work = Path(os.environ['P6_WORK'])
    destination = work / 'downloads'
    destination.mkdir(parents=True, exist_ok=False)
    run = fetch(f"actions/runs/{pins['runId']}/attempts/{pins['runAttempt']}")
    assert run['id'] == pins['runId'] and run['head_sha'] == pins['headSha']
    assert run['run_attempt'] == pins['runAttempt'] and run['status'] == 'completed'
    assert run['conclusion'] == 'success', 'Incomplete/failed compiler run is not app input'
    (destination / 'run.json').write_text(json.dumps(run, indent=2) + '\n')
    root = Path('/home/runner/.cache/oc-ty-ext/P6/rd150c-x64-v1')
    assert not root.exists(), 'Fresh compiler import root required'
    root.mkdir(parents=True)
    for profile, expected in pins['artifacts'].items():
        metadata = fetch(f"actions/artifacts/{expected['id']}")
        assert metadata['id'] == expected['id'] and metadata['name'] == expected['name']
        assert metadata['digest'] == 'sha256:' + expected['zipSha256']
        assert metadata['size_in_bytes'] == expected['zipBytes']
        metadata_file = destination / (profile + '.json')
        metadata_file.write_text(json.dumps(metadata, indent=2) + '\n')
        archive = destination / (profile + '.zip')
        fetch(f"actions/artifacts/{expected['id']}/zip", archive, expected['zipBytes'])
        verified = destination / ('verified-' + profile)
        subprocess.run([sys.executable, str(HERE / 'verify-download.py'), '--metadata',
            str(metadata_file), '--zip', str(archive), '--profile', profile,
            '--out', str(verified)], check=True)
        receipt = json.loads((verified / 'adoption-verification.json').read_text())
        assert receipt['compilerSha256'] == expected['compilerSha256']
        assert receipt['transportSha256'] == expected['transportSha256']
        transport = json.loads((verified / 'github-artifact/transport.json').read_text())
        assert transport['archiveSha256'] == expected['archiveSha256']
        directory = 'build-standard' if profile == 'cb-standard' else 'build-c2'
        shutil.copytree(verified / 'compiler' / directory, root / directory)
        (root / 'receipts').mkdir(exist_ok=True)
        for source in (verified / 'compiler/receipts').iterdir():
            assert not (root / 'receipts' / source.name).exists()
            shutil.copy2(source, root / 'receipts' / source.name)
        preserved = root / ('preserved-' + profile)
        preserved.mkdir()
        shutil.copy2(verified / 'github-artifact/transport.json', preserved / 'transport.json')
    print('P6_COMPILER_PAIR_VERIFIED', flush=True)


if __name__ == '__main__':
    main()
