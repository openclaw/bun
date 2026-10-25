#!/usr/bin/env python3
"""Bind explicit app inputs and a fresh native benchmark execution identity."""
import json
import os
from pathlib import Path
import platform
import re
import resource
import shutil
import sys
import time

from app_contract import CUT, ROOT, dump, load, pins_ok, sha


def identity(env):
    result = {'repository': env['GITHUB_REPOSITORY'], 'runId': env['GITHUB_RUN_ID'],
              'runAttempt': env['GITHUB_RUN_ATTEMPT'], 'job': env['GITHUB_JOB']}
    assert result['repository'] == 'openclaw/bun' and result['job'] == 'linux-x64-benchmark'
    assert all(re.fullmatch('[1-9][0-9]*', result[k]) for k in ['runId', 'runAttempt'])
    assert re.fullmatch('[0-9a-f]{40}', env['GITHUB_SHA'])
    return result


def app_inputs(env):
    def number(key):
        value = env[key]
        assert re.fullmatch('[1-9][0-9]*', value), key
        return int(value)
    result = {'repository': 'openclaw/bun', 'repositoryId': number('P6_APP_REPOSITORY_ID'),
              'runId': number('P6_APP_RUN_ID'), 'runAttempt': number('P6_APP_RUN_ATTEMPT'),
              'workflowId': number('P6_APP_WORKFLOW_ID'), 'headSha': env['P6_APP_WORKFLOW_HEAD'],
              'artifact': {'id': number('P6_APP_ARTIFACT_ID'), 'name': env['P6_APP_ARTIFACT_NAME'],
                           'zipSha256': env['P6_APP_ZIP_SHA256'], 'zipBytes': number('P6_APP_ZIP_BYTES')},
              'maxUnpackedBytes': 8 * 1024**3}
    pins_ok(result)
    assert result['runId'] != int(identity(env)['runId']), 'Origin must be a different completed app run'
    return result


def main():
    os.umask(0o077)
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    work = Path(os.environ['P6_WORK'])
    actual = identity(os.environ)
    action = sys.argv[1] if len(sys.argv) > 1 else 'bootstrap'
    if action == 'inputs':
        work.mkdir(parents=True, exist_ok=True)
        dump(work / 'app-inputs.json', app_inputs(os.environ))
        return
    if action in ['terminal', 'cleanup']:
        record = load(work / 'execution.json')
        assert record['identity'] == actual and record['workflowHead'] == os.environ['GITHUB_SHA']
        if action == 'terminal':
            code = int(sys.argv[2])
            assert code == 124 or code >= 128
            if not (work / 'terminal.json').exists():
                dump(work / 'terminal.json', {'status': 'terminal', 'exitCode': code, 'identity': actual})
        else:
            dump(work / 'benchmark-cleanup.json', {'status': 'owned-workloads-removed',
                 'identity': actual, 'pagingActivated': False, 'completedEpoch': time.time()})
        return
    assert action == 'bootstrap'
    assert platform.system() == 'Linux' and platform.machine() == 'x86_64'
    pins_ok(load(work / 'app-inputs.json'))
    dump(work / 'execution.json', {'schemaVersion': 1, 'identity': actual,
         'workflowHead': os.environ['GITHUB_SHA'], 'sourceCommit': CUT,
         'appInputsSha256': sha(work / 'app-inputs.json'), 'startedEpoch': time.time(),
         'hostBootId': Path('/proc/sys/kernel/random/boot_id').read_text().strip()})
    memory = int(next(row.split()[1] for row in Path('/proc/meminfo').read_text().splitlines()
                      if row.startswith('MemTotal:'))) * 1024
    facts = {'memTotalBytes': memory, 'cpus': len(os.sched_getaffinity(0)),
             'diskFreeBytes': shutil.disk_usage(ROOT.parent).free, 'kernel': platform.release(),
             'applicationFitQualified': False, 'pagingActivated': False}
    dump(work / 'resources.json', facts)
    assert memory >= 30_000_000_000 and facts['cpus'] >= 2
    assert facts['diskFreeBytes'] >= 57 * 1024**3, '25GiB floor + 32GiB work headroom required'


if __name__ == '__main__':
    main()
