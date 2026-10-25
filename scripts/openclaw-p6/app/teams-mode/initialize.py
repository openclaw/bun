#!/usr/bin/env python3
"""Keep the live Teams identity separate from the replay owner's origin file."""
import os
from pathlib import Path
import platform
import resource
import shutil
import sys
import time
from common import CUT, ROOT, app_inputs, current, dump, identity, origin, select_variants, sha


def main():
    work = Path(os.environ['P6_WORK'])
    actual = identity(os.environ)
    action = sys.argv[1] if len(sys.argv) > 1 else 'bootstrap'
    os.umask(0o077)
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    if action == 'inputs':
        assert os.environ['P6_APP_VARIANTS'] in ['js-c2', 'ts'], 'Teams mode requires app_variants=js-c2 or ts'
        work.mkdir(parents=True, exist_ok=True)
        dump(work / 'app-inputs.json', app_inputs(os.environ))
        dump(work / 'teams-execution.json', {'schemaVersion': 1, 'kind': 'teams-follow-on',
            'identity': actual, 'workflowHead': os.environ['GITHUB_SHA'], 'sourceCommit': CUT,
            'appInputsSha256': sha(work / 'app-inputs.json'), 'startedEpoch': time.time(),
            **select_variants(os.environ['P6_APP_VARIANTS'])})
        return
    record = current(work)
    assert record['identity'] == actual and record['workflowHead'] == os.environ['GITHUB_SHA']
    if action == 'terminal':
        code = int(sys.argv[2])
        assert code == 124 or code >= 128
        if not (work / 'teams-terminal.json').exists():
            dump(work / 'teams-terminal.json', {'exitCode': code, 'identity': actual})
    elif action == 'cleanup':
        dump(work / 'teams-cleanup.json', {'status': 'owned-workloads-removed', 'identity': actual,
            'executionSha256': sha(work / 'teams-execution.json'), 'pagingActivated': False,
            'completedEpoch': time.time()})
    else:
        assert action == 'bootstrap'
        assert platform.system() == 'Linux' and platform.machine() == 'x86_64'
        origin(work)
        memory = int(next(line.split()[1] for line in Path('/proc/meminfo').read_text().splitlines()
                          if line.startswith('MemTotal:'))) * 1024
        facts = {'memTotalBytes': memory, 'cpus': len(os.sched_getaffinity(0)),
            'diskFreeBytes': shutil.disk_usage(ROOT.parent).free, 'kernel': platform.release(),
            'pagingActivated': False, 'applicationBuild': False}
        dump(work / 'teams-resources.json', facts)
        assert memory >= 30_000_000_000 and facts['cpus'] >= 2 and facts['diskFreeBytes'] >= 57 * 1024**3


if __name__ == '__main__':
    main()
