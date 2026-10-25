#!/usr/bin/env python3
"""Explicit, untimed fetched-Teams follow-on for one selected native artifact."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time
from selection import requested_variants

HERE = Path(__file__).resolve().parent
ROOT = Path('/home/runner/.cache/oc-ty-ext/P6/app-x64-final-r4-v1')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--variant', choices=['js', 'c2-off', 'ts'], required=True)
    args = parser.parse_args()
    work = Path(os.environ['P6_WORK'])
    execution = json.loads((work / 'execution.json').read_text())
    assert args.variant in requested_variants(execution), 'Variant was not selected for this run'
    budget = json.loads((ROOT / 'qualification/teams-fetched/budget.json').read_text())
    deadline = float(os.environ['P6_DEADLINE_EPOCH'])
    reserve = 1200
    if deadline - time.time() < budget['phaseSeconds'] + reserve + budget['deadlineCleanupSeconds'] + 1:
        path = work / (args.variant + '-teams-fetched-skipped.json')
        with path.open('x') as stream:
            json.dump({'status': 'not-run', 'reason': 'Insufficient bounded follow-on window',
                       'variant': args.variant, 'performanceEligible': False}, stream)
            stream.write('\n')
        return 0
    admission = ROOT / 'admissions' / (args.variant + '.json')
    with admission.open('rb') as stream:
        digest = hashlib.file_digest(stream, 'sha256').hexdigest()
    command = [sys.executable, '-B', str(HERE.parent / 'deadline_process.py'),
               '--deadline-epoch', str(deadline), '--reserve-seconds', str(reserve),
               '--cleanup-grace-seconds', str(budget['deadlineCleanupSeconds']),
               '--receipt', str(work / (args.variant + '-teams-fetched-deadline.json')),
               '--', 'env', '-i', 'HOME=/home/runner', 'PATH=/usr/bin:/bin',
               'PYTHONDONTWRITEBYTECODE=1', 'TMPDIR=' + str(ROOT / 'tmp'),
               sys.executable, '-B', str(ROOT / 'runtime-controller.py'),
               '--variant', args.variant, '--phase', 'teams-fetched', '--admission-sha256', digest]
    code = subprocess.run(command, cwd=work).returncode
    return 128 - code if code < 0 else code


if __name__ == '__main__':
    raise SystemExit(main())
