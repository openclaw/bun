#!/usr/bin/env python3
"""Export only named synthetic results and preserved app archives, never paging state."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import stat
import sys
from preflight import export_selections
from selection import VARIANTS, requested_variants

ROOT = Path('/home/runner/.cache/oc-ty-ext/P6/app-x64-final-r4-v1')
PHASES = ['core', 'elf-floor', 'zero-js', 'node-vm', 'node-vm-native-workers', 'pty',
          'plugin', 'docker-image', 'docker-gateway-network', 'docker-kitchen-sink', 'docker-cron']


def load(path):
    return json.loads(path.read_text())


def facts(path):
    if not path.is_file():
        return {'status': 'not-run'}
    try:
        return load(path)
    except (OSError, ValueError):
        return {'status': 'invalid-receipt'}


def selections(work, root):
    yield from export_selections(work, root)
    for name in ['execution.json', 'resources.json', 'paging-activate.json', 'paging-cleanup.json',
                 'guest-gaps.json', 'guest-skipped.json', 'terminal.json']:
        yield work / name, Path('host') / name
    for variant in VARIANTS:
        yield root / 'admissions' / (variant + '.json'), Path('admissions') / (variant + '.json')
        for name in [variant + '-skipped.json', variant + '-paging-live.json']:
            yield work / name, Path('host') / name
        for phase in ['preflight', 'build', 'preserve', *PHASES, 'guest-prerequisites', 'guest-security']:
            name = f'{variant}-{phase}-deadline.json'
            yield work / name, Path('host') / name
        for name in ['plan.json', 'result.json', 'artifact-contract.stdout', 'artifact-contract.stderr',
                     'measurement/receipt.json', 'measurement/stdout.txt', 'measurement/stderr.txt',
                     'measurement/time.txt']:
            yield root / 'build-receipts' / variant / name, Path('build-receipts') / variant / name
        for phase in [*PHASES, 'guest-prerequisites', 'guest-security']:
            for name in ['result.json', 'raw-index.json', 'raw-evidence.tar.gz']:
                yield root / 'runtime-results' / (variant + '-' + phase) / name, Path('runtime-results') / (variant + '-' + phase) / name
        yield root / 'qualification-results' / (variant + '-core') / 'run/result.json', Path('qualification-results') / (variant + '-core') / 'run/result.json'
        for name in ['artifact.tar', 'transport.json']:
            yield root / 'preserved' / variant / name, Path('preserved') / variant / name
    labels = {'clone': ['clone', 'fetch-cut', 'checkout'], 'toolchain': [],
              'install': ['frozen-install'], 'runtime': ['pnpm-build'],
              'boundary': ['ts-boundary'], 'plugins': ['select-plugins']}
    for phase, commands in labels.items():
        yield root / 'prep-receipts' / phase / 'result.json', Path('prep-receipts') / phase / 'result.json'
        yield work / (phase + '-deadline.json'), Path('host') / (phase + '-deadline.json')
        for command in commands:
            for name in ['receipt.json', 'stdout.txt', 'stderr.txt', 'time.txt']:
                relative = Path(phase) / command / name
                yield root / 'prep-receipts' / relative, Path('prep-receipts') / relative
    for name in ['compiler-records.json', 'plugins/desktop.json', 'plugins/plugin-selection.json',
                 'source-preparation.json', 'p0-reference.json', 'P0-artifacts.json']:
        yield root / 'admission-inputs' / name, Path('admission-inputs') / name


def summary(work, root):
    try:
        execution = load(work / 'execution.json')
        requested = requested_variants(execution)
        selection = execution['variantSelection']
        selection_status = 'bound'
    except (OSError, ValueError, KeyError, TypeError, AssertionError):
        requested, selection, selection_status = [], None, 'missing-or-invalid'
    result = {'sourceCommit': '4fa442e332745f1f58ccedd27106abdafcf4e019',
              'referenceRole': 'historical CB11 provenance only', 'variants': {},
              'variantSelection': selection, 'requestedVariants': requested,
              'unselectedVariants': [variant for variant in VARIANTS if variant not in requested] if selection_status == 'bound' else [],
              'selectionStatus': selection_status, 'fullVariantMatrixComplete': False,
              'scheduledPhasesComplete': True, 'applicationQualified': False, 'shipReady': False,
              'unrunRequiredProof': ['same-machine Node/JIT npm baseline and balanced six-sweep ready/first-turn/RSS/CPU comparison',
                                    'full raw-trace strict zero-disk-JS and Worker boundary assessment',
                                    'live provider streamed-turn proof',
                                    'fetched CJS plugin load through the compiled SDK (PR183822); current plugin/Docker lanes do not establish this boundary']}
    result['nativeCompatibility'] = {'status': facts(root / 'prep-receipts/compatibility/result.json').get('status', 'not-run')}
    result['scheduledPhasesComplete'] = selection_status == 'bound' and result['nativeCompatibility']['status'] == 'PASS'
    for variant in VARIANTS:
        if selection_status == 'bound' and variant not in requested:
            result['variants'][variant] = {'requested': False, 'build': 'not-selected', 'runtime': {}, 'complete': False}
            continue
        build = root / 'build-receipts' / variant / 'result.json'
        skipped = work / (variant + '-skipped.json')
        row = {'requested': True if selection_status == 'bound' else None,
               'build': facts(build).get('status', 'invalid-receipt'), 'runtime': {}}
        if skipped.is_file():
            row['skip'] = facts(skipped)
        for phase in PHASES:
            path = root / 'runtime-results' / (variant + '-' + phase) / 'result.json'
            row['runtime'][phase] = facts(path).get('status', 'invalid-receipt')
        row['complete'] = not skipped.is_file() and row['build'] == 'built-unsigned' and all(value == 'phase-passed' for value in row['runtime'].values())
        result['scheduledPhasesComplete'] = result['scheduledPhasesComplete'] and row['complete']
        result['variants'][variant] = row
    result['guestSecurity'] = {variant: ('not-selected' if selection_status == 'bound' and variant not in requested else
        facts(root / 'runtime-results' / (variant + '-guest-security') / 'result.json').get('status', 'invalid-receipt'))
        for variant in ['js', 'c2-off']}
    result['guestGaps'] = facts(work / 'guest-gaps.json')
    if any(value != 'phase-passed' for value in result['guestSecurity'].values()):
        result['unrunRequiredProof'].append('actual application PR_SET_MDWE on Linux >=6.7 guest for JS and C2')
    cleanup = work / 'paging-cleanup.json'
    result['pagingCleanup'] = facts(cleanup)
    clean = result['pagingCleanup']
    cleanup_ok = clean.get('status') == 'not-activated' or (
        clean.get('operationExitCode') == 0 and clean.get('metadata', {}).get('phase') == 'cleaned')
    result['scheduledPhasesComplete'] = result['scheduledPhasesComplete'] and cleanup_ok
    result['fullVariantMatrixComplete'] = requested == list(VARIANTS) and result['scheduledPhasesComplete']
    return result


def main():
    os.umask(0o022)
    work = Path(os.environ['P6_WORK'])
    if sys.argv[1:] == ['--require-complete']:
        result = load(work / 'export/summary.json')
        print(json.dumps(result, indent=2))
        return 0 if result['scheduledPhasesComplete'] else 1
    assert not sys.argv[1:]
    out = work / 'export'
    out.mkdir(exist_ok=False)
    index = []
    for source, relative in selections(work, ROOT):
        if not source.exists():
            continue
        assert stat.S_ISREG(source.lstat().st_mode), f'Only regular selected files: {source}'
        resolved = source.resolve(strict=True)
        boundary = ROOT if source.is_relative_to(ROOT) else work
        assert resolved.is_relative_to(boundary.resolve(strict=True)), 'Selected export escapes its task boundary'
        assert not any(part in ['ephemeral-swap64', 'paging-tools'] for part in resolved.parts)
        target = out / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)
        with target.open('rb') as stream:
            digest = hashlib.file_digest(stream, 'sha256').hexdigest()
        index.append({'path': str(relative), 'sha256': digest, 'bytes': target.stat().st_size})
    (out / 'index.json').write_text(json.dumps(index, indent=2) + '\n')
    (out / 'summary.json').write_text(json.dumps(summary(work, ROOT), indent=2) + '\n')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
