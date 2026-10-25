#!/usr/bin/env python3
"""Select synthetic benchmark proof without copying installed packages or state."""
import json
import os
from pathlib import Path
import re
import shutil
import stat
import sys

from app_contract import CUT, ROOT, dump, load, sha

VARIANTS = ['js', 'c2-off', 'ts']
CORE_FILES = ['result.json', 'history.json', 'events.jsonl', 'provider-requests.jsonl', 'zero-js.json']


def tree_files(directory):
    if not directory.exists():
        return
    assert directory.is_dir() and not directory.is_symlink(), directory
    for child in sorted(directory.iterdir()):
        assert not child.is_symlink(), child
        if child.is_dir():
            yield from tree_files(child)
        else:
            assert stat.S_ISREG(child.lstat().st_mode), child
            yield child


def core_files(directory):
    for name in CORE_FILES:
        yield directory / name
    for name in ['logs', 'traces']:
        yield from tree_files(directory / name)


def selections(work, root):
    prep = root / 'benchmark-prep'
    for name in ['execution.json', 'resources.json', 'app-inputs.json', 'terminal.json',
                 'benchmark-cleanup.json', 'benchmark-run.json']:
        yield work / name, Path('host') / name
    for path in tree_files(work / 'benchmark-phases'):
        yield path, Path('host/phases') / path.relative_to(work / 'benchmark-phases')
    for name in ['verification.json', 'pins.json', 'run.json', 'artifact.json']:
        yield work / 'benchmark-download' / name, Path('host/download') / name
    for name in ['availability.json', 'native-inputs.json', 'cohort-budget.json',
                 'quiet-admission.json', 'host-reconciliation.json', 'post-backup-reconciliation.json',
                 'comparison-summary.json']:
        yield prep / name, Path(name)
    for name in ['producer-receipt.json', 'producer.stdout', 'producer.stderr', 'pack.json', 'bundles.json']:
        yield prep / 'package' / name, Path('package') / name
    for name in ['package-plan.json', 'installed-receipt.json', 'functional-timings.json', 'cohort-config.json']:
        yield prep / 'work' / name, Path('work') / name
    for name in ['install-command', 'functional-measurements']:
        for path in tree_files(prep / 'work' / name):
            yield path, Path('work') / path.relative_to(prep / 'work')
    for cell in ['node-core', 'bun-core', 'js-core', 'c2-off-core', 'ts-core']:
        for path in core_files(prep / 'work' / cell):
            yield path, Path('work') / path.relative_to(prep / 'work')
    cohort = prep / 'work/cohort'
    yield cohort / 'cohort.json', Path('work/cohort/cohort.json')
    if cohort.exists():
        assert not cohort.is_symlink()
        for path in sorted(cohort.iterdir()):
            if re.fullmatch(r'(warmup|sweep-[0-9]+)-[a-z0-9-]+\.(stdout|stderr)', path.name):
                yield path, Path('work/cohort') / path.name
            elif re.fullmatch(r'(warmup|sweep-[0-9]+)-[a-z0-9-]+', path.name):
                for selected in core_files(path):
                    yield selected, Path('work/cohort') / selected.relative_to(cohort)
    yield root / 'backup-results/summary.json', Path('backup-results/summary.json')
    for variant in VARIANTS:
        yield root / 'restored-app' / variant / 'verification.json', Path('restored-app') / variant / 'verification.json'
    for cell in ['node', 'bun-jit', *VARIANTS]:
        for name in ['result.json', 'create/receipt.json', 'create/stdout.txt', 'create/stderr.txt',
                     'create/time.txt', 'verify/receipt.json', 'verify/stdout.txt', 'verify/stderr.txt', 'verify/time.txt']:
            yield root / 'backup-results' / cell / name, Path('backup-results') / cell / name
        for path in tree_files(root / 'backup-results' / (cell + '-controller')):
            yield path, Path('backup-results') / path.relative_to(root / 'backup-results')


def facts(path):
    try:
        return load(path)
    except (OSError, ValueError):
        return {'status': 'not-run-or-invalid'}


def summary(work, root):
    comparison = facts(root / 'benchmark-prep/comparison-summary.json')
    backup = facts(root / 'backup-results/summary.json')
    cleanup = facts(work / 'benchmark-cleanup.json')
    execution = facts(work / 'execution.json')
    complete = (comparison.get('performanceQualified') is True and
                comparison.get('status') in ['comparison-passed', 'partial-comparison-passed'] and
                facts(work / 'benchmark-run.json').get('status') == 'completed' and
                backup.get('status') == 'passed' and cleanup.get('status') == 'owned-workloads-removed' and
                cleanup.get('identity') == execution.get('identity') and
                cleanup.get('pagingActivated') is False and not (work / 'terminal.json').exists())
    return {'sourceCommit': CUT, 'execution': execution, 'comparison': comparison,
            'untimedBackup': backup, 'cleanup': cleanup, 'scheduledWorkComplete': complete,
            'applicationQualified': False, 'shipReady': False}


def export(work, root):
    out = work / 'benchmark-export'
    out.mkdir(exist_ok=False)
    index = []
    for source, relative in selections(work, root):
        if not source.exists():
            continue
        assert stat.S_ISREG(source.lstat().st_mode), source
        boundary = root if source.is_relative_to(root) else work
        assert source.resolve(strict=True).is_relative_to(boundary.resolve(strict=True)), source
        # Reject symlinked ancestors even when their targets remain within the task root.
        for parent in source.parents:
            assert not parent.is_symlink(), parent
            if parent == boundary:
                break
        target = out / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)
        index.append({'path': str(relative), 'bytes': target.stat().st_size, 'sha256': sha(target)})
    dump(out / 'index.json', index)
    dump(out / 'summary.json', summary(work, root))


def main():
    os.umask(0o022)
    work = Path(os.environ['P6_WORK'])
    if sys.argv[1:] == ['--require-complete']:
        result = load(work / 'benchmark-export/summary.json')
        print(json.dumps(result, indent=2))
        return 0 if result['scheduledWorkComplete'] else 1
    assert not sys.argv[1:]
    export(work, ROOT)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
