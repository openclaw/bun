#!/usr/bin/env python3
"""Record the actual Actions identity and bounded skip results."""
import json
import os
from pathlib import Path
import platform
import re
import resource
import shutil
import sys
import time
from selection import select_variants

work = Path(os.environ['P6_WORK'])
resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
if len(sys.argv) > 1:
    if sys.argv[1] == 'terminal':
        code = int(sys.argv[2])
        assert code == 124 or code >= 128
        (work / 'terminal.json').write_text(json.dumps({'status': 'terminal', 'exitCode': code}) + '\n')
    else:
        assert sys.argv[1] == 'skip' and sys.argv[2] in ['prepare', 'js', 'c2-off', 'ts', 'guest']
        (work / (sys.argv[2] + '-skipped.json')).write_text(json.dumps({
            'status': 'not-run', 'reason': sys.argv[3], 'applicationQualified': False}) + '\n')
else:
    assert platform.system() == 'Linux' and platform.machine() == 'x86_64'
    identity = {'repository': os.environ['GITHUB_REPOSITORY'], 'runId': os.environ['GITHUB_RUN_ID'],
                'runAttempt': os.environ['GITHUB_RUN_ATTEMPT'], 'job': os.environ['GITHUB_JOB']}
    assert identity['repository'] == 'openclaw/bun' and identity['job'] == 'linux-x64-app'
    assert all(re.fullmatch('[1-9][0-9]*', identity[key]) for key in ['runId', 'runAttempt'])
    record = {'schemaVersion': 1, 'identity': identity, 'workflowHead': os.environ['GITHUB_SHA'],
              'sourceCommit': '4fa442e332745f1f58ccedd27106abdafcf4e019', 'startedEpoch': time.time(),
              **select_variants(os.environ.get('P6_APP_VARIANTS', 'all'))}
    with (work / 'execution.json').open('x') as stream:
        json.dump(record, stream, indent=2)
        stream.write('\n')
    memory = int(next(row.split()[1] for row in Path('/proc/meminfo').read_text().splitlines()
                      if row.startswith('MemTotal:'))) * 1024
    facts = {'memTotalBytes': memory, 'cpus': len(os.sched_getaffinity(0)),
             'diskFreeBytes': shutil.disk_usage('/home/runner/.cache/oc-ty-ext/P6').free,
             'kernel': platform.release(), 'applicationFitQualified': False}
    (work / 'resources.json').write_text(json.dumps(facts, indent=2) + '\n')
    assert memory >= 30_000_000_000 and facts['cpus'] >= 2
    assert facts['diskFreeBytes'] >= 121 * 1024**3, '64GiB paging + 25GiB floor + 32GiB headroom required'
