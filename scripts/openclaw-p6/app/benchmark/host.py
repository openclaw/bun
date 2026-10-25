#!/usr/bin/env python3
"""Run benchmark phases with one absolute deadline and explicit failure ownership."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys

from app_contract import ROOT, dump, load, sha

HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location('p6_deadline', HERE.parents[1] / 'deadline_process.py')
DEADLINE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(DEADLINE)


def normalized(code):
    return code if code >= 0 else 128 - code


def terminal(code):
    return code == 124 or code >= 128


def sequence(phase, reconcile):
    """Only ordinary backup failure may continue, after host reconciliation."""
    before = [('prepare', ['bash', '/p6-recipe/app/prepare.sh']),
              ('stage', ['python3', '-B', '/p6-recipe/app/benchmark/stage.py']),
              ('restore', ['python3', '-B', '/p6-recipe/app/benchmark/restore.py', '--download',
                           os.environ['P6_WORK'] + '/benchmark-download']),
              ('package', ['bash', str(ROOT / 'benchmark-prep/prepare-package.sh')]),
              ('bind', ['python3', '-B', str(ROOT / 'benchmark-prep/bind-inputs.py'), '--root-admit'])]
    for name in ['plan', 'install', 'inventory']:
        before.append((name, ['bash', str(ROOT / 'benchmark-prep/run-phase.sh'), name]))
    for name, command in before:
        code = phase(name, command)
        if code:
            return code
    code = phase('backup-untimed', ['python3', '-B', str(ROOT / 'benchmark-prep/run-backup.py')])
    if terminal(code):
        return code
    # Reconcile even a passing owner; its descendants must be gone before continuing.
    reconciled = reconcile(True)
    if reconciled:
        return reconciled
    after = [('functional', ['python3', '-B', str(ROOT / 'benchmark-prep/run-functional.py')]),
             ('config', ['bash', str(ROOT / 'benchmark-prep/run-phase.sh'), 'config']),
             ('budget', ['python3', '-B', str(ROOT / 'benchmark-prep/prepare-window.py')])]
    for name, command in after:
        code = phase(name, command)
        if code:
            return code
    code = reconcile(False)
    if code:
        return code
    for name, command in [('window', ['python3', '-B', str(ROOT / 'benchmark-prep/check-window.py')]),
                          ('cohort', ['bash', str(ROOT / 'benchmark-prep/run-phase.sh'), 'cohort']),
                          ('summary', ['python3', '-B', str(ROOT / 'benchmark-prep/summarize.py')])]:
        code = phase(name, command)
        if code:
            return code
    return 0


def main():
    os.umask(0o077)
    work = Path(os.environ['P6_WORK'])
    logs = work / 'benchmark-phases'
    logs.mkdir(parents=True, exist_ok=True)
    deadline = int(os.environ['P6_DEADLINE_EPOCH'])
    assert os.environ['P6_EXECUTION_MODE'] == 'benchmark'
    action = sys.argv[1]
    assert action in ['download', 'bootstrap', 'run']

    def bounded(name, command, env=None):
        with (logs / (name + '.stdout')).open('xb') as out, (logs / (name + '.stderr')).open('xb') as err:
            result, facts = DEADLINE.run_bounded(command, deadline_epoch=deadline,
                reserve_seconds=1200, cleanup_grace=30, env=env, stdout=out, stderr=err)
        code = normalized(result.returncode)
        facts['exitCode'] = code
        dump(logs / (name + '.json'), facts)
        print(json.dumps({'phase': name, 'exitCode': code}), flush=True)
        if terminal(code) and (work / 'execution.json').exists():
            subprocess.run([sys.executable, '-B', str(HERE / 'initialize.py'), 'terminal', str(code)], check=True)
        return code

    if action == 'bootstrap':
        return bounded('bootstrap', ['bash', str(HERE.parent / 'host.sh'), 'bootstrap'])
    if action == 'download':
        for name, command in [
            ('download-compilers', [sys.executable, '-B', str(HERE.parent / 'download.py')]),
            ('download-app', [sys.executable, '-B', str(HERE / 'download.py'), '--pins',
                              str(work / 'app-inputs.json'), '--out', str(work / 'benchmark-download')])]:
            code = bounded(name, command)
            if code:
                return code
        return 0
    assert 'GH_TOKEN' not in os.environ and 'GITHUB_TOKEN' not in os.environ
    execution = load(work / 'execution.json')
    assert execution['identity']['job'] == 'linux-x64-benchmark'
    assert execution['workflowHead'] == os.environ['GITHUB_SHA']
    assert not (work / 'terminal.json').exists()
    container = os.environ['P6_CONTAINER']
    inspected = subprocess.check_output(['docker', 'inspect', '--format',
        '{{index .Config.Labels "openclaw.p6.owner"}}', container], text=True, timeout=30).strip()
    assert inspected == os.environ['GITHUB_RUN_ID'] + '-' + os.environ['GITHUB_RUN_ATTEMPT']

    def phase(name, command):
        return bounded(name, ['docker', 'exec', container, 'nice', '-n', '10', 'env', '-i',
            'HOME=/home/runner', 'PATH=/usr/bin:/bin', 'P6_WORK=' + str(work),
            'P6_DEADLINE_EPOCH=' + str(deadline), 'PYTHONDONTWRITEBYTECODE=1',
            'bash', '-c', 'umask 077; exec "$@"', 'p6-benchmark', *command])

    def reconcile(only):
        command = ['sudo', '-n', 'env', '-i', 'PATH=/usr/sbin:/usr/bin:/sbin:/bin',
                   'P6_WORK=' + str(work), 'P6_CONTAINER=' + container,
                   'P6_DEADLINE_EPOCH=' + str(deadline)]
        command += [key + '=' + os.environ[key] for key in
                    ['GITHUB_REPOSITORY', 'GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT', 'GITHUB_JOB', 'GITHUB_SHA']]
        command += ['python3', '-B', str(HERE / 'quiet.py'), '--identity', str(work / 'execution.json'),
                    '--identity-sha256', sha(work / 'execution.json'), '--container', container]
        if only:
            command += ['--reconcile-only']
        return bounded('reconcile-backup' if only else 'quiet-admission', command)

    code = sequence(phase, reconcile)
    dump(work / 'benchmark-run.json', {'status': 'completed' if code == 0 else 'failed', 'exitCode': code,
                                      'applicationQualified': False, 'shipReady': False})
    if code:
        # The deadline owner reaps the Docker client; stop the container to reap its workload.
        subprocess.run(['timeout', '--kill-after=5s', '30s', 'docker', 'stop', '--time', '15', container],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
    return code


if __name__ == '__main__':
    raise SystemExit(main())
