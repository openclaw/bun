#!/usr/bin/env python3
"""Bound a Teams-only restoration and selected untimed proof sequence."""
import importlib.util
import os
from pathlib import Path
import subprocess
import sys
import time
from common import APP, current, download_dir, dump, identity, load, origin, requested_variants, sha

SPEC = importlib.util.spec_from_file_location('p6_deadline', APP.parent / 'deadline_process.py')
DEADLINE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(DEADLINE)
REPLAY_SECONDS = 180
RESERVE = 1200
OUTER_CLEANUP_SECONDS = 30


def selected_window(requested, budget):
    overhead = OUTER_CLEANUP_SECONDS + 1
    return RESERVE + 600 + overhead + len(requested) * (
        REPLAY_SECONDS + budget['phaseSeconds'] + budget['deadlineCleanupSeconds'] + 2 * overhead)


def sequence(phase, requested, helper_head, work, stop, budget):
    commands = [('prepare', ['bash', '/p6-recipe/app/teams-mode/bootstrap.sh'], 600)]
    for variant in requested:
        commands += [('replay-' + variant, ['python3', '-B', '/p6-helper/scripts/openclaw-p6/app/teams-replay.py',
            '--download', str(download_dir(work)), '--variant', variant, '--helper-head', helper_head], REPLAY_SECONDS),
            ('teams-' + variant, ['python3', '-B', '/p6-helper/scripts/openclaw-p6/app/teams.py', '--variant', variant],
             budget['phaseSeconds'] + budget['deadlineCleanupSeconds'])]
    for name, command, ceiling in commands:
        code = phase(name, command, ceiling)
        if code:
            stop()
            return code
    return 0


def main():
    os.umask(0o077)
    work = Path(os.environ['P6_WORK'])
    execution = current(work)
    assert execution['identity'] == identity(os.environ) and execution['workflowHead'] == os.environ['GITHUB_SHA']
    assert os.environ['P6_EXECUTION_MODE'] == 'teams'
    deadline = int(os.environ['P6_DEADLINE_EPOCH'])
    logs = work / 'teams-phases'
    logs.mkdir(exist_ok=True)
    action = sys.argv[1]
    assert action in ['download', 'bootstrap', 'run']

    def bounded(name, command, ceiling):
        with (logs / (name + '.stdout')).open('xb') as out, (logs / (name + '.stderr')).open('xb') as err:
            done, facts = DEADLINE.run_bounded(command,
                deadline_epoch=min(deadline, time.time() + ceiling + RESERVE + OUTER_CLEANUP_SECONDS + 1),
                reserve_seconds=RESERVE, cleanup_grace=OUTER_CLEANUP_SECONDS, stdout=out, stderr=err)
        code = done.returncode if done.returncode >= 0 else 128 - done.returncode
        facts.update(exitCode=code, executionSha256=sha(work / 'teams-execution.json'))
        dump(logs / (name + '.json'), facts)
        if code == 124 or code >= 128:
            subprocess.run([sys.executable, '-B', str(APP / 'teams-mode/initialize.py'), 'terminal', str(code)], check=True)
        return code

    if action == 'download':
        return bounded('download', [sys.executable, '-B', str(APP / 'benchmark/download.py'),
            '--pins', str(work / 'app-inputs.json'), '--out', str(download_dir(work))], 300)
    assert 'GH_TOKEN' not in os.environ and 'GITHUB_TOKEN' not in os.environ
    if action == 'bootstrap':
        return bounded('bootstrap', ['bash', str(APP / 'host.sh'), 'bootstrap'], 300)
    assert not (work / 'teams-terminal.json').exists()
    verified = origin(work)
    requested = requested_variants(execution)
    budget = load(APP / 'packet/payload/qualification/teams-fetched/budget.json')
    if deadline - time.time() < selected_window(requested, budget):
        dump(work / 'teams-run.json', {'status': 'insufficient-window', 'exitCode': 78,
            'executionSha256': sha(work / 'teams-execution.json'), 'originatingAppExport': verified})
        return 78
    container = os.environ['P6_CONTAINER']
    assert subprocess.check_output(['docker', 'inspect', '--format', '{{index .Config.Labels "openclaw.p6.owner"}}',
        container], text=True, timeout=30).strip() == execution['identity']['runId'] + '-' + execution['identity']['runAttempt']

    def phase(name, command, ceiling):
        return bounded(name, ['docker', 'exec', container, 'nice', '-n', '10', 'env', '-i',
            'HOME=/home/runner', 'PATH=/usr/bin:/bin', 'P6_WORK=' + str(work),
            'P6_DEADLINE_EPOCH=' + str(deadline), 'PYTHONDONTWRITEBYTECODE=1',
            'GIT_CONFIG_COUNT=1', 'GIT_CONFIG_KEY_0=safe.directory', 'GIT_CONFIG_VALUE_0=/p6-helper',
            'bash', '-c', 'umask 077; exec "$@"', 'p6-teams', *command], ceiling)

    def stop():
        subprocess.run(['timeout', '--kill-after=5s', '30s', 'docker', 'stop', '--time', '15', container],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)

    code = sequence(phase, requested, execution['workflowHead'], work, stop, budget)
    dump(work / 'teams-run.json', {'status': 'completed' if code == 0 else 'failed', 'exitCode': code,
        'requestedVariants': requested, 'executionSha256': sha(work / 'teams-execution.json'),
        'originatingAppExport': verified, 'applicationQualified': False, 'performanceEligible': False})
    return code


if __name__ == '__main__':
    raise SystemExit(main())
