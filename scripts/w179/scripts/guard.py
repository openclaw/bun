import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys

source = Path(sys.argv[1]).resolve()
output = Path(sys.argv[2]).resolve()
inputs = Path(__file__).resolve().parent.parent / 'tests'
metadata = json.loads((output/'metadata.json').read_text())
expected_source = '0e6a7b354732a887a937f396db1283b8a1bd644e'
assert metadata['source'] == expected_source
hash_file = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
assert hash_file(inputs/'guard.test.ts') == 'f9b2dc28a43da5c86f8d7a6b2e753ddbee9a1932831b8fa15fc32afc536681f9'
env = os.environ.copy()
env.update(CI='1', BUN_FEATURE_FLAG_INTERNAL_FOR_TESTING='1', BUN_GARBAGE_COLLECTOR_LEVEL='1', BUN_JSC_randomIntegrityAuditRate='1.0', BUN_RUNTIME_TRANSPILER_CACHE_PATH='0', BUN_ENABLE_CRASH_REPORTING='0', BUN_DEBUG_QUIET_LOGS='1')
results = []
for arm in ['42ab','641c','f1e1']:
    binary = output/f'bun-{arm}'
    assert hash_file(binary) == metadata['arms'][arm]['binary_sha256']
    identity = json.loads(subprocess.check_output([str(binary),'-e','console.log(JSON.stringify({revision:Bun.revision,webkit:process.versions.webkit}))'],cwd=source,env=env,text=True))
    assert identity == {'revision':expected_source,'webkit':metadata['arms'][arm]['engine']}
    for kind in ['guard','guard-held','guard-function-held']:
        fixture = source/f'test/js/node/vm/w179-{kind}.test.ts'
        assert not fixture.exists()
        fixture.write_bytes((inputs/f'{kind}.test.ts').read_bytes())
        log = output/f'{kind}-{arm}.log'
        try:
            with log.open('w') as stream:
                result = subprocess.run([str(binary),'--expose-internals','test',str(fixture),'--timeout','90000'],cwd=source,env=env,stdout=stream,stderr=subprocess.STDOUT)
        finally:
            fixture.unlink()
        row = {'arm':arm,'kind':kind,'exit':result.returncode,'source':identity,'fixture_sha256':hash_file(inputs/f'{kind}.test.ts')}
        if kind == 'guard':
            row['verified'] = result.returncode == 0
        else:
            prefix = 'W179_HELD_CONTROL ' if kind == 'guard-held' else 'W179_FUNCTION_CONTROL '
            points = [json.loads(line[len(prefix):]) for line in log.read_text().splitlines() if line.startswith(prefix)]
            row['measurements'] = points
            row['verified'] = result.returncode == 1 and len(points) == 1
            if row['verified']:
                point = points[0]
                if kind == 'guard-held':
                    row['verified'] = point['finalCount'] >= point['initialCount'] + 10000
                else:
                    row['verified'] = point['retainedFunctions'] == 10000 and point['finalCount'] <= point['initialCount'] + 10 and point['megabytes'] >= 200
        results.append(row)
        print(json.dumps(row),flush=True)
(output/'guard-results.json').write_text(json.dumps({'guard_commit':'43b87ed442e55d4e053b252504ae8ebd981e8d16','results':results},indent=2)+'\n')
assert len(results) == 9 and all(row['verified'] for row in results), 'Guard or deliberate-retention control did not behave as required'
