#!/usr/bin/env python3
"""Run npm through the existing reviewed measurement/cancellation owner."""
import importlib.util
import hashlib
import json
import os
from pathlib import Path
import signal
import sys
import traceback

here = Path(__file__).resolve().parent
inputs = json.loads((here / 'native-inputs.json').read_text())
owner_file = here / 'harness/measurement-owner.py'
assert hashlib.sha256(owner_file.read_bytes()).hexdigest() == inputs['ownerFiles']['harness/measurement-owner.py']
spec = importlib.util.spec_from_file_location('p6_measurement_owner', owner_file)
owner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(owner)
root = Path(inputs['nativeRoot'])
measurement = root / 'measure-command.py'
assert owner.sha(measurement) == owner.MEASURE_SHA
receipt = here / 'work/install-command'
receipt.mkdir(exist_ok=False)
plan = {'measurementUtility': str(measurement), 'variant': 'npm-install-final-r4',
        'source': str(here / 'work'), 'timeoutSeconds': 1200,
        'command': ['/usr/bin/nice', '-n', '10', inputs['node']['path'],
                    str(root / 'opt/node/lib/node_modules/npm/bin/npm-cli.js'), 'install',
                    '--prefix', str(here / 'work/installed'), inputs['tarball']['path'],
                    '--strict-allow-scripts', '--no-audit', '--no-fund', '--foreground-scripts', '--fetch-retries=0']}
result = {'status': 'failed', 'scope': 'native npm installation, not package production or runtime qualification'}
previous_hup = signal.signal(signal.SIGHUP, owner.interrupted)
try:
    owner.measure(plan, dict(os.environ), receipt)
    result['status'] = 'complete'
except BaseException:
    result['error'] = traceback.format_exc()
    raise
finally:
    signal.signal(signal.SIGHUP, previous_hup)
    (receipt / 'result.json').write_text(json.dumps(result, indent=2) + '\n')
