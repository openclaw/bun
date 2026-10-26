#!/usr/bin/env python3
"""Replay only missing R4 functional proof on restored artifacts, without builds."""
import json
import os
from pathlib import Path
import subprocess
import sys

from app_contract import CUT, ROOT, dump, load, sha

PHASES = ('node-vm-native-workers', 'docker-image', 'docker-gateway-network', 'docker-kitchen-sink')


def replay(root, work, invoke):
    available = load(root / 'benchmark-prep/availability.json')
    assert available['sourceCommit'] == CUT
    execution = load(work / 'execution.json')
    assert execution['sourceCommit'] == CUT and execution['identity']['job'] == 'linux-x64-benchmark'
    result = {'sourceCommit': CUT, 'status': 'failed', 'applicationQualified': False,
              'performanceEligible': False, 'applicationBuildStarted': False, 'compilerBuildStarted': False,
              'execution': execution, 'executionSha256': sha(work / 'execution.json'),
              'origin': available['sourceAppExport'], 'phases': []}
    target = root / 'benchmark-prep/requalification.json'
    dump(target, result)
    variants = [v for v in ('js', 'c2-off') if v in available['availableVariants']]
    result['availableVariants'] = variants
    result['unavailableVariants'] = [v for v in ('js', 'c2-off') if v not in variants]
    result['requiredPhaseCount'] = len(variants) * len(PHASES)
    terminal = 0
    for variant in ('js', 'c2-off'):
        if variant not in available['availableVariants']:
            result['phases'].append({'variant': variant, 'status': 'artifact-unavailable'})
            continue
        assert available['variants'][variant]['status'] == 'artifact-restored-original-core-qualified'
        admission = root / 'admissions' / (variant + '.json')
        image_passed = False
        for phase in PHASES:
            entry = {'variant': variant, 'phase': phase, 'status': 'not-run'}
            result['phases'].append(entry)
            if phase.startswith('docker-') and phase != 'docker-image' and not image_passed:
                entry['status'] = 'image-prerequisite-failed'
                continue
            command = [sys.executable, '-B', str(root / 'runtime-controller.py'), '--variant', variant,
                       '--phase', phase, '--admission-sha256', sha(admission)]
            code = invoke(command)
            code = code if code >= 0 else 128 - code
            entry['exitCode'] = code
            receipt = root / 'runtime-results' / (variant + '-' + phase) / 'result.json'
            if receipt.is_file():
                observed = load(receipt)
                assert observed['sourceCommit'] == CUT and observed['variant'] == variant and observed['phase'] == phase
                assert observed['rootBuildAdmissionSha256'] == sha(admission)
                assert observed['actualBuildReceiptSha256'] == sha(root / 'build-receipts' / variant / 'result.json')
                entry.update(status=observed['status'], receipt=str(receipt), receiptSha256=sha(receipt))
                if code == 0:
                    assert observed['status'] == 'phase-passed'
            else:
                entry['status'] = 'missing-controller-receipt'
            if phase == 'docker-image':
                image_passed = code == 0 and entry['status'] == 'phase-passed'
            if code == 124 or code >= 128:
                terminal = code
                break
        if terminal:
            break
    actual = [entry for entry in result['phases'] if 'phase' in entry]
    passed = bool(variants) and len(actual) == result['requiredPhaseCount'] and all(
        entry['status'] == 'phase-passed' and entry.get('exitCode') == 0 for entry in actual)
    result['status'] = 'phases-passed-pending-cleanup' if passed else 'failed'
    # This task-owned summary evolves while immutable controller receipts remain authoritative.
    target.write_text(json.dumps(result, indent=2) + '\n')
    return terminal or (0 if passed else 1)


def main():
    assert sys.platform == 'linux'
    assert 'GH_TOKEN' not in os.environ and 'GITHUB_TOKEN' not in os.environ
    return replay(ROOT, Path(os.environ['P6_WORK']),
                  lambda command: subprocess.run(command, cwd=ROOT, check=False).returncode)


if __name__ == '__main__':
    raise SystemExit(main())
