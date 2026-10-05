import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys

source = Path(sys.argv[1]).resolve()
output = Path(sys.argv[2]).resolve()
inputs = Path(__file__).resolve().parent.parent / 'tests'
metadata = json.loads((output/'metadata.json').read_text())
expected_source = '0e6a7b354732a887a937f396db1283b8a1bd644e'
# resolveGitSha prefers GITHUB_SHA: these source-pinned artifacts embed their build workflow revision.
expected_build_revision = '5c441bf481e2c3e68be13eb0bffa55ff76b73eca'
assert metadata['source'] == expected_source
assert subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=source, text=True).strip() == expected_source
hash_file = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
guard_hash = '1027834f090c3add4ce4cf6fff0dd571576302337b2f7d50185a8aa6cd0ce161'
assert hash_file(inputs/'guard.test.ts') == guard_hash
assert hash_file(source/'test/js/node/vm/script-leak.test.ts') == metadata['test_sha256']
env = os.environ.copy()
env.update(CI='1', BUN_FEATURE_FLAG_INTERNAL_FOR_TESTING='1', BUN_GARBAGE_COLLECTOR_LEVEL='1', BUN_JSC_randomIntegrityAuditRate='1.0', BUN_RUNTIME_TRANSPILER_CACHE_PATH='0', BUN_ENABLE_CRASH_REPORTING='0', BUN_DEBUG_QUIET_LOGS='1')
results = []
for arm in ['42ab','641c','f1e1']:
    manifest = inputs.parent/'manifests'/f'{arm}.json'
    assert hash_file(manifest) == metadata['arms'][arm]['manifest_sha256']
    assert json.loads(manifest.read_text())['version'] == metadata['arms'][arm]['engine']
    binary = output/f'bun-{arm}'
    assert hash_file(binary) == metadata['arms'][arm]['binary_sha256']
    identity = json.loads(subprocess.check_output([str(binary),'-e','console.log(JSON.stringify({revision:Bun.revision,webkit:process.versions.webkit}))'],cwd=source,env=env,text=True))
    assert identity == {'revision':expected_build_revision,'webkit':metadata['arms'][arm]['engine']}
    for kind in ['guard','guard-observed','guard-held','guard-function-held','guard-native-held']:
        fixture = source/f'test/js/node/vm/w179-{kind}.test.ts'
        assert not fixture.exists()
        fixture.write_bytes((inputs/f'{kind}.test.ts').read_bytes())
        log = output/f'{kind}-{arm}.log'
        try:
            with log.open('w') as stream:
                command = [str(binary),'--expose-internals','test',str(fixture)]
                if kind not in ['guard', 'guard-observed']:
                    command.extend(['--timeout', '90000'])
                result = subprocess.run(command,cwd=source,env=env,stdout=stream,stderr=subprocess.STDOUT)
        finally:
            fixture.unlink()
        row = {'arm':arm,'kind':kind,'exit':result.returncode,'source_checkout':expected_source,'runtime':identity,'fixture_sha256':hash_file(inputs/f'{kind}.test.ts'),'default_test_timeout':kind in ['guard','guard-observed']}
        text = re.sub(r'\x1b\[[0-9;]*m', '', log.read_text())
        normal = kind in ['guard','guard-observed']
        row['verified'] = bool(result.returncode == (0 if normal else 1) and re.search(r'\b1 pass\b' if normal else r'\b1 fail\b',text))
        if kind != 'guard':
            prefix = 'W179_SAMPLE '
            points = [json.loads(line[len(prefix):]) for line in text.splitlines() if line.startswith(prefix)]
            row['measurements'] = points
            row['verified'] = row['verified'] and len(points) == 1
            if row['verified']:
                point = points[0]
                if normal:
                    row['verified'] = point['finalCount'] <= point['initialCount'] + 10 and point['megabytes'] < 200
                else:
                    row['verified'] = point['retainedCount'] == 15000
                    if kind == 'guard-held':
                        row['verified'] = row['verified'] and point['finalCount'] >= 15000 and 'Expected: <=' in text
                    else:
                        row['verified'] = row['verified'] and point['finalCount'] <= point['initialCount'] + 10 and point['megabytes'] >= 200 and 'Expected: < 200' in text
        results.append(row)
        print(json.dumps(row),flush=True)
(output/'guard-results.json').write_text(json.dumps({'guard_commit':'3e067ca205a7e7c130919133e700120e51bca6f4','guard_sha256':guard_hash,'warmup_scripts':5000,'measured_scripts':10000,'results':results},indent=2)+'\n')
assert len(results) == 15 and all(row['verified'] for row in results), 'Guard or deliberate-retention control did not behave as required'
