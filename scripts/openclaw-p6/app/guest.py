#!/usr/bin/env python3
"""Schedule the accepted actual-app KVM/MDWE owners if native capacity remains."""
import hashlib
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import time
from selection import requested_variants

ROOT = Path('/home/runner/.cache/oc-ty-ext/P6/app-x64-final-r4-v1')


def read(path):
    return json.loads(path.read_text())


def sha(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def main():
    work = Path(os.environ['P6_WORK'])
    requested = requested_variants(read(work / 'execution.json'))
    variants = [variant for variant in ['js', 'c2-off'] if variant in requested]
    if not variants:
        return 0
    deadline = float(os.environ['P6_DEADLINE_EPOCH'])
    gaps = []
    def gap(variant, reason):
        gaps.append({'variant': variant, 'status': 'not-run', 'reason': reason})
        (work / 'guest-gaps.json').write_text(json.dumps(gaps, indent=2) + '\n')
    device = Path('/dev/kvm')
    if not device.exists() or not stat.S_ISCHR(device.stat().st_mode):
        gap('all', 'Native /dev/kvm unavailable; no emulation fallback')
        return 0
    ready = []
    for variant in variants:
        build = ROOT / 'build-receipts' / variant / 'result.json'
        core = ROOT / 'qualification-results' / (variant + '-core') / 'run/result.json'
        if not build.is_file() or read(build).get('status') != 'built-unsigned' or not core.is_file():
            gap(variant, 'Actual successful build and host core/version receipt required')
        else:
            ready.append(variant)
    if not ready:
        return 0
    def phase(variant, name):
        admission = ROOT / 'admissions' / (variant + '.json')
        command = [sys.executable, '/p6-recipe/deadline_process.py', '--deadline-epoch', str(deadline),
            '--reserve-seconds', '1200', '--cleanup-grace-seconds', '30', '--receipt',
            str(work / (variant + '-' + name + '-deadline.json')), '--', 'env', '-i',
            'HOME=/home/runner', 'PATH=/usr/bin:/bin:/usr/sbin:/sbin', 'PYTHONDONTWRITEBYTECODE=1',
            'TMPDIR=' + str(ROOT / 'tmp'), sys.executable, '-B', str(ROOT / 'runtime-controller.py'),
            '--variant', variant, '--phase', name, '--admission-sha256', sha(admission)]
        code = subprocess.run(command).returncode
        return 128 - code if code < 0 else code
    if deadline - time.time() - 1200 < 1900:
        gap('all', 'Less than 1900s remain for bounded prerequisite + actual guest owners')
        return 0
    code = phase(ready[0], 'guest-prerequisites')
    if code == 124 or code >= 128:
        return code
    if code:
        gap('all', 'Guest prerequisites failed; preserve actual owner receipt')
        return 0
    for variant in ready:
        if deadline - time.time() - 1200 < 950:
            gap(variant, 'Less than 950s remain for actual guest owner')
            continue
        code = phase(variant, 'guest-security')
        if code == 124 or code >= 128:
            return code
        if code:
            gap(variant, 'Actual guest owner failed; preserve result and raw evidence')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
