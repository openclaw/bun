#!/usr/bin/env python3
"""Install only the official Node bytes required by the originating build."""
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import urllib.request
from common import ROOT, current, download_dir, dump, load, requested_variants, sha


def main():
    work = Path(os.environ['P6_WORK'])
    name = 'node-v26.12.1-linux-x64.tar.xz'
    base = 'https://nodejs.org/dist/v26.12.1/'
    archive = ROOT / 'downloads' / name
    with urllib.request.urlopen(base + 'SHASUMS256.txt', timeout=30) as stream:
        hashes = [line.split()[0] for line in stream.read().decode().splitlines() if line.split()[-1] == name]
    assert len(hashes) == 1
    with urllib.request.urlopen(base + name, timeout=30) as stream, archive.open('xb') as target:
        shutil.copyfileobj(stream, target)
    assert sha(archive) == hashes[0]
    unpack = ROOT / 'downloads/node-only-unpack'
    unpack.mkdir()
    with tarfile.open(archive) as package:
        package.extractall(unpack, filter='data')
    (unpack / 'node-v26.12.1-linux-x64').rename(ROOT / 'opt/node')
    node = ROOT / 'opt/node/bin/node'
    digest = sha(node)
    for variant in requested_variants(current(work)):
        plan = load(download_dir(work) / 'export/build-receipts' / variant / 'plan.json')
        assert plan['buildNode'] == {'path': str(node), 'sha256': digest}, 'Official Node differs from originating build'
    assert subprocess.check_output([str(node), '--version'], text=True).strip() == 'v26.12.1'
    dump(work / 'teams-node.json', {'status': 'official-node-matched', 'path': str(node), 'sha256': digest,
                                  'archiveSha256': hashes[0], 'pnpmInstalled': False})


if __name__ == '__main__':
    main()
