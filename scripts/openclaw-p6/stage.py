#!/usr/bin/env python3
"""Fetch and verify the exact sparse source trees reviewed for P6."""
import datetime
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys

from source_files import verify_files

HERE = Path(__file__).resolve().parent
ROOT = Path('/root/.cache/oc-ty-ext/P6/rd150c-x64-highmem-deadline-v1')


def git(directory, *args, **kwargs):
    return subprocess.run(['git', '-c', 'credential.helper=', '-c', 'http.extraHeader=', *args],
                          cwd=directory, check=True, **kwargs)


def source_manifest(directory, pins):
    raw = git(directory, 'ls-tree', '-rz', pins['commit'], stdout=subprocess.PIPE).stdout
    rows = []
    for entry in raw.split(b'\0'):
        if not entry:
            continue
        metadata, name = entry.split(b'\t', 1)
        mode, kind, blob = metadata.decode().split()
        path = name.decode()
        if any(path == root or path.startswith(root + '/') for root in pins['roots']):
            if kind != 'blob':
                raise ValueError(f'Unexpected source kind: {path}: {kind}')
            rows.append({'path': path, 'mode': mode, 'blob': blob})
    rows.sort(key=lambda row: row['path'])
    encoded = json.dumps(rows, sort_keys=True, separators=(',', ':')).encode()
    if len(rows) != pins['files'] or hashlib.sha256(encoded).hexdigest() != pins['manifestSha256']:
        raise ValueError('Source tree differs from the reviewed P6 manifest')
    return rows


def main():
    if platform.system() != 'Linux' or platform.machine() != 'x86_64' or sys.version_info < (3, 12):
        raise SystemExit('Requires native Linux x64 and Python 3.12+')
    if ROOT.exists() or shutil.disk_usage(ROOT.parent).free < 25_000_000_000:
        raise SystemExit('Requires a fresh P6 root and at least 25GB free')
    ROOT.mkdir()
    pins = json.loads((HERE / 'sources.json').read_text())
    os.environ.update(GIT_TERMINAL_PROMPT='0', GIT_CONFIG_GLOBAL='/dev/null', GIT_CONFIG_NOSYSTEM='1')
    for name, key in [('bun', 'targetManifest'), ('webkit', 'manifest')]:
        source = ROOT / ('WebKit' if name == 'webkit' else 'bun')
        source.mkdir()
        spec = pins[name]
        git(source, 'init', '--quiet')
        git(source, 'remote', 'add', 'origin', spec['repository'])
        git(source, 'sparse-checkout', 'init', '--no-cone')
        git(source, 'sparse-checkout', 'set', '--no-cone', '--stdin',
            input=''.join('/' + path + '\n' for path in spec['roots']).encode())
        git(source, 'fetch', '--depth=1', '--filter=blob:none', '--no-tags', 'origin', spec['commit'])
        git(source, 'checkout', '--detach', '--quiet', 'FETCH_HEAD')
        revision = git(source, 'rev-parse', 'HEAD', stdout=subprocess.PIPE).stdout.decode().strip()
        if revision != spec['commit']:
            raise ValueError('Source commit mismatch')
        manifest = source_manifest(source, spec)
        verify_files(source, manifest)
        (ROOT / f'{name}-inputs.json').write_text(json.dumps({key: manifest}, indent=2) + '\n')
    for path in HERE.iterdir():
        if path.is_file():
            shutil.copy2(path, ROOT / path.name)
    for name in ['tmp', 'home', 'downloads', 'opt', 'receipts', 'apt-archives/partial', 'apt-lists/partial']:
        (ROOT / name).mkdir(parents=True, exist_ok=True)
    receipt = {'status': 'source-staged-not-built', 'bun': pins['bun']['commit'],
               'webkit': pins['webkit']['commit'], 'root': str(ROOT),
               'sourceTransport': 'anonymous-git-exact-commit', 'sources': pins,
               'recordedAt': datetime.datetime.now(datetime.timezone.utc).isoformat()}
    (ROOT / 'source-ready.json').write_text(json.dumps(receipt, indent=2) + '\n')


if __name__ == '__main__':
    main()
