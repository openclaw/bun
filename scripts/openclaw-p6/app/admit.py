#!/usr/bin/env python3
"""Bind one prepared template to the facts produced by this native CI run."""
import hashlib
import json
import os
from pathlib import Path
import sys
import time
from preflight import verify_completed

ROOT = Path('/home/runner/.cache/oc-ty-ext/P6/app-x64-final-r3-v1')


def read(path):
    return json.loads(path.read_text())


def sha(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def main():
    variant = sys.argv[1]
    assert variant in ['js', 'c2-off', 'ts']
    compatibility = verify_completed(ROOT, Path(os.environ['P6_WORK']))
    template = read(ROOT / 'admission-templates' / (variant + '.json'))
    records = read(ROOT / 'admission-inputs/compiler-records.json')
    assert records['status'] == 'native-compilers-adopted-not-app-admitted'
    prepared = read(ROOT / 'prep-receipts/plugins/result.json')
    assert prepared['status'] == 'PASS'
    execution = read(Path(os.environ['P6_WORK']) / 'execution.json')
    assert execution['identity']['repository'] == 'openclaw/bun' and execution['identity']['job'] == 'linux-x64-app'
    assert execution['sourceCommit'] == template['linuxCut']['commit']
    assert compatibility['sourceCommit'] == template['linuxCut']['commit']
    remaining = int(float(os.environ['P6_DEADLINE_EPOCH']) - time.time() - 1200)
    assert remaining >= 120, 'No bounded build window remains'
    template['decision'] = 'build-linux'
    template['nativeCompatibility'] = compatibility
    template['execution'] = execution
    template['referenceRole'] = 'historical-provenance-only; no current-platform qualification transfer'
    template['linuxCut']['mainRefSha'] = prepared['nativeSource']['mainRefSha']
    template['distBuildInfoSha256'] = prepared['distBuildInfoSha256']
    template['compiler']['sha256'] = records[template['compiler']['profile']]['sha256']
    template['buildNode'] = {key: prepared['buildNode'][key] for key in ['path', 'sha256']}
    template['pluginsSha256'] = sha(Path(template['pluginsFile']))
    template['timeoutSeconds'] = min(7200, remaining)
    directory = ROOT / 'admissions'
    directory.mkdir(exist_ok=True)
    path = directory / (variant + '.json')
    with path.open('x') as stream:
        json.dump(template, stream, indent=2)
        stream.write('\n')
    print(sha(path))


if __name__ == '__main__':
    main()
