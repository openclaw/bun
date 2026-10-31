#!/usr/bin/env python3
"""Read actual install/inspection evidence; never install or launch anything."""
import argparse
import json
from pathlib import Path
import traceback

p = argparse.ArgumentParser()
p.add_argument('--inspect', type=Path, required=True)
p.add_argument('--state', type=Path, required=True)
p.add_argument('--pin', type=Path, required=True)
p.add_argument('--out', type=Path, required=True)
a = p.parse_args()
if a.out.exists():
    raise SystemExit('Fresh assertion output required')
report = {'status': 'failed', 'runtimeExecutedByAssertion': False}
try:
    pin = json.loads(a.pin.read_text())
    observed = json.loads(a.inspect.read_text())
    plugin = observed['plugin']
    report['observedPlugin'] = {k: plugin.get(k) for k in
        ['id', 'packageName', 'packageVersion', 'version', 'status', 'imported',
         'origin', 'source', 'rootDir', 'channelIds', 'error', 'failurePhase']}
    assert plugin['id'] == 'msteams' and plugin['packageName'] == pin['name']
    assert plugin['packageVersion'] == plugin['version'] == pin['version']
    assert plugin['status'] == 'loaded' and plugin['imported'] is True
    assert plugin['origin'] == 'global'
    assert plugin['channelIds'] == ['msteams']
    projects = (a.state / 'npm/projects').resolve(strict=True)
    source = Path(plugin['source']).resolve(strict=True)
    root = Path(plugin['rootDir']).resolve(strict=True)
    assert source.is_file() and source.is_relative_to(projects)
    assert root.is_relative_to(projects) and source.is_relative_to(root)
    package = json.loads((root / 'package.json').read_text())
    assert package['name'] == pin['name'] and package['version'] == pin['version']
    deps = plugin['dependencyStatus']
    assert deps['installed'] and deps['requiredInstalled']
    assert deps['missing'] == [] and deps['missingOptional'] == []
    assert all(item['installed'] for item in deps['dependencies'])
    assert observed['diagnostics'] == [], observed['diagnostics']
    locks = [f for f in projects.glob('*/package-lock.json')
             if root.is_relative_to(f.parent.resolve())]
    assert len(locks) == 1, 'Expected this installed project lock'
    locked = json.loads(locks[0].read_text())['packages']['node_modules/@openclaw/msteams']
    assert locked['version'] == pin['version']
    assert locked['integrity'] == pin['dist']['integrity']
    assert locked['resolved'] == pin['dist']['tarball']
    report.update(status='passed', plugin=report['observedPlugin'],
                  dependenciesInstalled=True, diagnostics=[],
                  installedDistIntegrityMatchesPublishedPin=True)
except Exception as error:
    report.update(error=str(error), traceback=traceback.format_exc())
a.out.write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps(report, indent=2))
raise SystemExit(0 if report['status'] == 'passed' else 1)
