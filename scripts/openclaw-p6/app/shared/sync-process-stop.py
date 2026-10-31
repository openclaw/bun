#!/usr/bin/env python3
"""Generate process-stop transport copies and refresh their existing hash seals."""
import hashlib
import json
import re
from pathlib import Path

APP = Path(__file__).resolve().parents[1]
owner = APP / 'shared/process-stop.mjs'
for relative in ['packet/payload/qualification/harness/process-stop.mjs',
                 'benchmark/payload/harness/process-stop.mjs']:
    (APP / relative).write_bytes(owner.read_bytes())


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def load(path):
    return json.loads(path.read_text())


def save(path, value):
    path.write_text(json.dumps(value, indent=2) + '\n')


payload = APP / 'packet/payload'
benchmark = APP / 'benchmark/payload'
measurement = payload / 'measure-command.py'
(benchmark / 'measure-command.reference.py').write_bytes(measurement.read_bytes())
for path in [payload / 'build-prep/build-linux.py', benchmark / 'harness/measurement-owner.py']:
    text, count = re.subn(r"(?m)^MEASURE_SHA = '[0-9a-f]{64}'$",
                          "MEASURE_SHA = '" + sha(measurement) + "'", path.read_text())
    assert count == 1, path
    path.write_text(text)

qualification = payload / 'qualification'
manifest = load(qualification / 'manifest.json')
manifest['files']['harness/process-stop.mjs'] = sha(qualification / 'harness/process-stop.mjs')
for name in manifest['files']:
    manifest['files'][name] = sha(qualification / name)
if 'process-stop.mjs' not in manifest['ownerFiles']:
    manifest['ownerFiles'].append('process-stop.mjs')
save(qualification / 'manifest.json', manifest)

manifest = load(payload / 'manifest.json')
manifest['files']['qualification/harness/process-stop.mjs'] = sha(qualification / 'harness/process-stop.mjs')
for name in manifest['files']:
    manifest['files'][name] = sha(payload / name)
save(payload / 'manifest.json', manifest)

inputs = load(benchmark / 'native-inputs.template.json')
inputs['ownerFiles']['harness/process-stop.mjs'] = sha(benchmark / 'harness/process-stop.mjs')
for name in inputs['ownerFiles']:
    inputs['ownerFiles'][name] = sha(benchmark / name)
save(benchmark / 'native-inputs.template.json', inputs)
manifest = load(benchmark / 'payload-manifest.json')
manifest['harness/process-stop.mjs'] = sha(benchmark / 'harness/process-stop.mjs')
for name in manifest:
    manifest[name] = sha(benchmark / name)
save(benchmark / 'payload-manifest.json', manifest)

projection = load(APP / 'packet/input-projection.json')
for name, record in projection['changedFiles'].items():
    record['projectedSha256'] = sha(payload / name)
projection['manifestSha256'] = sha(payload / 'manifest.json')
projection['gatewayShutdownRepair'] = {
    'baseHead': 'f9634d8a2da46bd990913c7b07b51d40ed11db12',
    'helperOwner': 'shared/process-stop.mjs',
    'helperSha256': sha(owner),
    'sourceBudgetOwner': 'gateway-shutdown-budget.mjs',
    'sourceBudgetSha256': load(qualification / 'source-contract.json')['files']['gateway-shutdown-budget.mjs'],
    'scope': 'Gateway source budget, explicit forced-stop failure and runtime-only outer cleanup grace; operation/default budgets retained',
}
save(APP / 'packet/input-projection.json', projection)
