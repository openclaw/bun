#!/usr/bin/env python3
"""Stage the reviewed paging owner and invoke it for this actual Actions job."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

HERE = Path(__file__).resolve().parent
ROOT = Path('/home/runner/.cache/oc-ty-ext/P6/app-x64-final-r3-v1')


def sha(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def main():
    action = sys.argv[1]
    assert action in ['activate', 'verify', 'cleanup']
    work = Path(os.environ['P6_WORK'])
    identity_path = work / 'execution.json'
    if action == 'cleanup' and not identity_path.exists():
        work.mkdir(parents=True, exist_ok=True)
        (work / 'paging-cleanup.json').write_text('{"status":"not-activated","reason":"initialization-did-not-run"}\n')
        return 0
    execution = json.loads(identity_path.read_text())
    identity = execution['identity']
    suffix = 'actions-' + identity['runId'] + '-' + identity['runAttempt']
    stage = ROOT / 'paging-tools' / suffix
    area = ROOT / 'ephemeral-swap64' / suffix
    owner = stage / 'swap64.py'
    approval = stage / 'approval.json'
    mapper = Path('/dev/mapper') / ('p6-aot-swap64-' + identity['runId'] + '-' + identity['runAttempt'])
    if action == 'activate':
        stage.mkdir(parents=True, mode=0o700, exist_ok=False)
        shutil.copy2(HERE / 'paging/swap64.py', owner)
        approved = {'schemaVersion': 1, 'lane': 'P6', 'decision': 'activate-task-encrypted-swap',
            'identity': identity, 'executionSha256': sha(identity_path),
            'sourceCommit': execution['sourceCommit'], 'nativeRoot': str(ROOT),
            'swapBytes': 64 * 1024**3, 'cipher': 'aes-cbc-essiv:sha256', 'keyBytes': 32,
            'preserveExistingSwap': True, 'preserveVmSettings': True,
            'buildHeadroomBytes': 32 * 1024**3, 'scriptSha256': sha(owner)}
        approval.write_text(json.dumps(approved, indent=2) + '\n')
        approval.chmod(0o600)
    elif action == 'cleanup' and not area.exists() and not os.path.lexists(mapper):
        (work / 'paging-cleanup.json').write_text('{"status":"not-activated","resourcesAbsent":true}\n')
        return 0
    env = ['PATH=/usr/sbin:/usr/bin:/sbin:/bin', 'PYTHONDONTWRITEBYTECODE=1']
    env += [name + '=' + os.environ[name] for name in ['GITHUB_REPOSITORY', 'GITHUB_RUN_ID',
                                                      'GITHUB_RUN_ATTEMPT', 'GITHUB_JOB', 'GITHUB_SHA']]
    command = ['sudo', '-n', 'env', '-i', *env, '/usr/bin/python3', '-B']
    common = ['--owner', str(owner), '--approval', str(approval), '--approval-sha256', sha(approval),
              '--identity', str(identity_path), '--identity-sha256', sha(identity_path)]
    if action == 'verify':
        assert len(sys.argv) == 3 and sys.argv[2] in ['js', 'c2-off', 'ts']
        activation = work / 'paging-activate.json'
        command += [str(HERE / 'paging/verify-active.py'), *common, '--activation-receipt',
                    str(activation), '--activation-receipt-sha256', sha(activation)]
        with (work / (sys.argv[2] + '-paging-live.json')).open('xb') as stream:
            return subprocess.run(['timeout', '--signal=TERM', '--kill-after=30s', '120s', *command], stdout=stream).returncode
    command += [str(HERE / 'paging/operation.py'), action, *common, '--receipt',
                str(work / ('paging-' + action + '.json')), '--execute', '--owner-idle-confirmed']
    if action == 'cleanup':
        command.append('--workload-stopped-confirmed')
    return subprocess.run(['timeout', '--signal=TERM', '--kill-after=30s', '600s', *command]).returncode


if __name__ == '__main__':
    raise SystemExit(main())
