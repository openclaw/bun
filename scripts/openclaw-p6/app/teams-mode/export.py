#!/usr/bin/env python3
"""Export selected Teams evidence without claiming app or performance qualification."""
import importlib.util
import os
from pathlib import Path
import stat
import sys
from common import APP, CUT, ROOT, current, download_dir, dump, load, origin, requested_variants, sha

SPEC = importlib.util.spec_from_file_location('p6_app_export', APP / 'export.py')
APP_EXPORT = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(APP_EXPORT)


def facts(path):
    try:
        return load(path)
    except (OSError, ValueError):
        return {}


def phase_names(requested):
    return ['download', 'bootstrap', 'prepare', *[name for variant in requested for name in ['replay-' + variant, 'teams-' + variant]]]


def summary(work, root):
    result = {'sourceCommit': CUT, 'kind': 'teams-follow-on', 'teamsWorkComplete': False,
              'scheduledPhasesComplete': False, 'applicationQualified': False,
              'performanceEligible': False, 'shipReady': False, 'variants': {}}
    try:
        execution = current(work)
        requested = requested_variants(execution)
        result.update(execution=execution, requestedVariants=requested)
        expected = origin(work)
        digest = sha(work / 'teams-execution.json')
        replay = load(work / 'execution.json')
        assert replay['kind'] == 'untimed-functional-replay' and replay['sourceCommit'] == CUT
        assert replay['helperHead'] == execution['workflowHead'] and replay['originatingAppExport'] == expected
        cleanup = facts(work / 'teams-cleanup.json')
        run = facts(work / 'teams-run.json')
        complete = (cleanup.get('status') == 'owned-workloads-removed' and
            cleanup.get('identity') == execution['identity'] and cleanup.get('executionSha256') == digest and
            cleanup.get('pagingActivated') is False and run.get('status') == 'completed' and run.get('exitCode') == 0 and
            run.get('executionSha256') == digest and run.get('originatingAppExport') == expected and
            run.get('requestedVariants') == requested and not (work / 'teams-terminal.json').exists())
        phases = {name: facts(work / 'teams-phases' / (name + '.json')) for name in phase_names(requested)}
        complete = complete and all(row.get('executionSha256') == digest and row.get('exitCode') == 0 and
            row.get('timedOut') is False and row.get('interruptedBySignal') is None and
            row.get('finishedBeforeReserve') is True and row.get('launched') is True for row in phases.values())
        complete = complete and facts(work / 'teams-node.json').get('status') == 'official-node-matched'
        for variant in requested:
            binding = facts(root / 'teams-replay' / variant / 'replay-binding.json')
            build = root / 'build-receipts' / variant / 'result.json'
            proof = APP_EXPORT.follow_on_status(work, root, variant, 'teams-fetched', build)
            bound = (binding.get('status') == 'restored-for-teams-not-runtime-qualified' and
                binding.get('helperHead') == execution['workflowHead'] and binding.get('sourceCommit') == CUT and
                binding.get('originatingAppExport') == expected and binding.get('originalBuildReceiptSha256') == sha(build))
            result['variants'][variant] = {'followOnProof': {'teams-fetched': proof}, 'replayBound': bound}
            complete = complete and bound and proof == 'phase-passed'
        result.update(execution=execution, originatingAppExport=expected, requestedVariants=requested,
                      cleanup=cleanup, outerPhases=phases, teamsWorkComplete=bool(complete))
    except (OSError, ValueError, KeyError, TypeError, AssertionError) as error:
        result['error'] = type(error).__name__ + ': ' + str(error)
    return result


def selections(work, root, requested):
    for name in ['teams-execution.json', 'execution.json', 'app-inputs.json', 'teams-resources.json',
                 'teams-node.json', 'teams-run.json', 'teams-cleanup.json', 'teams-terminal.json']:
        yield work / name, Path('host') / name
    for name in phase_names(requested):
        for suffix in ['.json', '.stdout', '.stderr']:
            yield work / 'teams-phases' / (name + suffix), Path('host/phases') / (name + suffix)
    for name in ['pins.json', 'run.json', 'artifact.json', 'verification.json']:
        yield download_dir(work) / name, Path('host/download') / name
    for name in ['source-preparation.json']:
        yield root / 'admission-inputs' / name, Path('admission-inputs') / name
    for variant in requested:
        for name in ['verification.json', 'replay-binding.json']:
            yield root / 'teams-replay' / variant / name, Path('teams-replay') / variant / name
        for name in ['plan.json', 'result.json']:
            yield root / 'build-receipts' / variant / name, Path('build-receipts') / variant / name
        yield root / 'admissions' / (variant + '.json'), Path('admissions') / (variant + '.json')
        for name in ['result.json', 'raw-index.json', 'raw-evidence.tar.gz']:
            yield root / 'runtime-results' / (variant + '-teams-fetched') / name, Path('runtime-results') / (variant + '-teams-fetched') / name
        for suffix in ['-teams-fetched-deadline.json', '-teams-fetched-skipped.json']:
            yield work / (variant + suffix), Path('host') / (variant + suffix)


def main():
    work = Path(os.environ['P6_WORK'])
    if sys.argv[1:] == ['--require-complete']:
        return 0 if load(work / 'teams-export/summary.json')['teamsWorkComplete'] else 1
    assert not sys.argv[1:]
    os.umask(0o022)
    result = summary(work, ROOT)
    out = work / 'teams-export'
    out.mkdir(exist_ok=False)
    index = []
    for source, relative in selections(work, ROOT, result.get('requestedVariants', [])):
        if not source.exists():
            continue
        boundary = ROOT if source.is_relative_to(ROOT) else (download_dir(work) if source.is_relative_to(download_dir(work)) else work)
        assert stat.S_ISREG(source.lstat().st_mode) and source.resolve(strict=True).is_relative_to(boundary.resolve(strict=True))
        for parent in source.parents:
            assert not parent.is_symlink()
            if parent == boundary:
                break
        target = out / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(source.read_bytes())
        index.append({'path': str(relative), 'sha256': sha(target), 'bytes': target.stat().st_size})
    dump(out / 'index.json', index)
    dump(out / 'summary.json', result)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
