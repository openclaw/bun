#!/usr/bin/env python3
"""Bind and require the selected builtin/native-worker compatibility preflight."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import platform
import re
import subprocess
import sys
import time

HERE = Path(__file__).resolve().parent
PAYLOAD = HERE / 'compatibility'
ROOT = Path('/home/runner/.cache/oc-ty-ext/P6/app-x64-final-r4-v1')
PROFILES = {'standard': 'cb-standard', 'shadowrealm-off': 'cb-compat'}
STEPS = ['node-identity', 'identity-standard', 'identity-shadowrealm-off', 'full-dist-census',
         'builtin-query-standard', 'selected-standard', 'builtin-query-shadowrealm-off', 'selected-shadowrealm-off']
EXPORT_FILES = ['result.json', 'bound-inputs.json', 'source-before.json', 'source-after.json',
                'full-dist-inventory.json', 'builtin-query-standard.json', 'builtin-query-shadowrealm-off.json',
                'selected-standard.json', 'selected-shadowrealm-off.json'] + [
                    name + suffix for name in STEPS for suffix in ['.stdout', '.stderr', '.deadline.json']]


def load(path):
    return json.loads(Path(path).read_text())


def sha(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def write(path, value):
    with Path(path).open('x') as stream:
        json.dump(value, stream, indent=2)
        stream.write('\n')


def bound_source(payload):
    binding = load(payload / 'source-binding.json')
    assert binding['schemaVersion'] == 1 and binding['status'] == 'bound-reviewed-r4-cut', 'Reviewed R4 source binding required'
    assert all(isinstance(binding[key], str) and re.fullmatch('[a-f0-9]{40}', binding[key])
               for key in ['sourceCommit', 'sourceTree'])
    owners = load(payload / 'inputs.template.json')['sourceOwners']
    assert set(binding['sourceOwners']) == set(owners)
    assert all(isinstance(v, str) and re.fullmatch('[a-f0-9]{64}', v) for v in binding['sourceOwners'].values())
    ts = binding['typescript']
    relative = Path(ts['relativePath'])
    assert not relative.is_absolute() and '..' not in relative.parts and relative.parts[0] == 'node_modules'
    assert ts['version'] == '6.0.3', 'Frozen scanner requires the admitted classic TypeScript parser'
    assert all(isinstance(ts[key], str) and re.fullmatch('[a-f0-9]{64}', ts[key])
               for key in ['manifestSha256', 'entrySha256'])
    return binding


def dist_snapshot(source):
    result = {}
    for base, directories, files in os.walk(source / 'dist', followlinks=False):
        for name in sorted(directories + files):
            path = Path(base) / name
            relative = str(path.relative_to(source))
            if path.is_symlink():
                result[relative] = {'symlink': os.readlink(path)}
            elif path.is_file():
                result[relative] = {'sha256': sha(path), 'bytes': path.stat().st_size}
    assert result, 'Fresh dist required'
    return result


def snapshot(root, work, payload=PAYLOAD):
    binding = bound_source(payload)
    template = load(payload / 'inputs.template.json')
    for name, digest in load(payload / 'payload-manifest.json').items():
        assert sha(payload / name) == digest, name
    source = (root / 'source').resolve(strict=True)
    assert source == root / 'source'
    env = {'PATH': '/usr/bin:/bin', 'GIT_CONFIG_GLOBAL': '/dev/null', 'GIT_CONFIG_SYSTEM': '/dev/null'}
    def git(*args):
        return subprocess.check_output(['git', '-C', str(source), *args], env=env, text=True, timeout=60).strip()
    assert git('rev-parse', 'HEAD') == binding['sourceCommit']
    assert git('rev-parse', 'HEAD^{tree}') == binding['sourceTree']
    assert not git('status', '--porcelain', '--untracked-files=no'), 'Tracked source changed'
    for name, digest in binding['sourceOwners'].items():
        assert sha(source / name) == digest, name
    prepared_path = root / 'prep-receipts/plugins/result.json'
    prepared = load(prepared_path)
    assert prepared['status'] == 'PASS' and prepared['sourceCommit'] == binding['sourceCommit']
    assert prepared['nativeSource']['commit'] == binding['sourceCommit']
    selection = root / 'admission-inputs/plugins/desktop.json'
    assert prepared['plugins']['desktop.json'] == sha(selection)
    assert prepared['distBuildInfoSha256'] == sha(source / 'dist/build-info.json')
    assert load(source / 'dist/build-info.json')['commit'] == binding['sourceCommit']
    node = prepared['buildNode']
    assert node['path'] == str(root / 'opt/node/bin/node') and node['version'] == '26.12.1'
    assert sha(node['path']) == node['sha256']
    records_path = root / 'admission-inputs/compiler-records.json'
    records = load(records_path)
    assert records['status'] == 'native-compilers-adopted-not-app-admitted'
    pins = load(payload.parent / 'compiler-pins.json')['artifacts']
    compilers = {}
    for profile, key in PROFILES.items():
        compiler = records[key]
        assert compiler['bunCommit'] == template['expectedCompilerSources']['bun']
        assert compiler['webkitCommit'] == template['expectedCompilerSources']['webkit']
        assert compiler['engineFeatures'] == {'shadowRealm': profile == 'standard', 'hardened': False}
        path = Path(compiler['path']).resolve(strict=True)
        assert path.is_relative_to(root / 'compilers') and path.name == 'bun'
        assert sha(path) == compiler['sha256'] == pins[key]['compilerSha256']
        compilers[profile] = {'path': str(path), 'sha256': compiler['sha256']}
    parser = (source / binding['typescript']['relativePath']).resolve(strict=True)
    assert parser.is_relative_to(source / 'node_modules')
    assert load(parser / 'package.json')['version'] == binding['typescript']['version']
    assert sha(parser / 'package.json') == binding['typescript']['manifestSha256']
    assert sha(parser / 'lib/typescript.js') == binding['typescript']['entrySha256']
    execution_path = work / 'execution.json'
    execution = load(execution_path)
    assert execution['identity']['repository'] == 'openclaw/bun'
    assert execution['identity']['job'] in ['linux-x64-app', 'linux-x64-benchmark']
    assert execution['sourceCommit'] == binding['sourceCommit']
    refs = {'preparation': prepared_path, 'compilerRecords': records_path, 'sourcePreparation': root / 'admission-inputs/source-preparation.json',
            'selection': selection, 'distBuildInfo': source / 'dist/build-info.json', 'execution': execution_path,
            'sourceBinding': payload / 'source-binding.json', 'payloadManifest': payload / 'payload-manifest.json',
            'driver': Path(__file__), 'compilerPins': payload.parent / 'compiler-pins.json'}
    return {'sourceCommit': binding['sourceCommit'], 'sourceTree': binding['sourceTree'], 'source': str(source),
            'sourceBinding': binding, 'sourceOwners': binding['sourceOwners'],
            'refs': {key: {'path': str(path), 'sha256': sha(path)} for key, path in refs.items()},
            'node': node, 'compilers': compilers, 'typescript': str(parser), 'typescriptVersion': binding['typescript']['version'],
            'distEntries': dist_snapshot(source), 'execution': execution}


def reports_passed(directory):
    for profile in PROFILES:
        result = load(directory / ('selected-' + profile + '.json'))
        assert result['status'] == 'passed', profile + ' selected compatibility failed'
        assert all(result[key] == [] for key in ['selectedMissing', 'unmappedWorkers', 'undeclaredPluginWorkers']), profile


def verify_completed(root=ROOT, work=None, payload=PAYLOAD):
    work = Path(os.environ['P6_WORK']) if work is None else Path(work)
    directory = root / 'prep-receipts/compatibility'
    result = load(directory / 'result.json')
    assert result['status'] == 'PASS' and result['nativeCompile'] is False
    assert set(result['profiles']) == set(PROFILES)
    assert [step['name'] for step in result['steps']] == STEPS
    assert all(step['exitCode'] == 0 for step in result['steps'])
    assert result['inputs'] == snapshot(root, work, payload), 'Compatibility input changed after preflight'
    assert set(result['outputs']) == set(EXPORT_FILES) - {'result.json'}, 'Complete preflight evidence required'
    for name, digest in result['outputs'].items():
        assert name in EXPORT_FILES and sha(directory / name) == digest, name
    reports_passed(directory)
    return {'path': str(directory / 'result.json'), 'sha256': sha(directory / 'result.json'),
            'sourceCommit': result['inputs']['sourceCommit']}


def export_selections(work, root):
    for name in EXPORT_FILES:
        yield root / 'prep-receipts/compatibility' / name, Path('prep-receipts/compatibility') / name
    yield work / 'compatibility-deadline.json', Path('host/compatibility-deadline.json')


def run(root=ROOT, work=None, payload=PAYLOAD):
    os.umask(0o077)
    assert platform.system() == 'Linux' and platform.machine() == 'x86_64'
    deadline = min(time.time() + 600, float(os.environ['P6_DEADLINE_EPOCH']) - 1200)
    work = Path(os.environ['P6_WORK']) if work is None else Path(work)
    directory = root / 'prep-receipts/compatibility'
    directory.mkdir(parents=True, exist_ok=False)
    result = {'status': 'FAIL', 'nativeCompile': False, 'applicationQualified': False,
              'budgetSeconds': 600, 'deadlineEpoch': deadline, 'profiles': [], 'steps': []}
    code = 1
    try:
        before = snapshot(root, work, payload)
        result['inputs'] = before
        write(directory / 'source-before.json', before)
        bound = load(payload / 'inputs.template.json')
        bound.update(status='bound-native-preflight', sourceCommit=before['sourceCommit'], sourceTree=before['sourceTree'],
            source=before['source'], sourceClean=True, preparationReceipt=before['refs']['preparation']['path'],
            preparationReceiptSha256=before['refs']['preparation']['sha256'], distBuildInfo=before['refs']['distBuildInfo']['path'],
            distBuildInfoSha256=before['refs']['distBuildInfo']['sha256'], selection=before['refs']['selection']['path'],
            selectionSha256=before['refs']['selection']['sha256'], typescript=before['typescript'], typescriptVersion=before['typescriptVersion'],
            output=str(directory), helperRoot=str(payload), sourceOwners=before['sourceOwners'], executionAuthorized=True)
        bound['architectures']['x64'].update(node=before['node']['path'], nodeSha256=before['node']['sha256'], compilers=before['compilers'])
        write(directory / 'bound-inputs.json', bound)
        for name in ['home', 'tmp', 'cache']:
            (directory / name).mkdir()
        env = {'PATH': str(Path(before['node']['path']).parent) + ':/usr/bin:/bin', 'HOME': str(directory / 'home'),
               'TMPDIR': str(directory / 'tmp'), 'XDG_CACHE_HOME': str(directory / 'cache'), 'LANG': 'C.UTF-8', 'TZ': 'UTC',
               'GIT_CONFIG_GLOBAL': '/dev/null', 'GIT_CONFIG_SYSTEM': '/dev/null'}
        spec = importlib.util.spec_from_file_location('p6_deadline', HERE.parent / 'deadline_process.py')
        owner = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(owner)
        def step(name, command, ceiling, extra=None):
            with (directory / (name + '.stdout')).open('xb') as stdout, (directory / (name + '.stderr')).open('xb') as stderr:
                done, facts = owner.run_bounded(['/usr/bin/nice', '-n', '10', *map(str, command)],
                    deadline_epoch=min(deadline, time.time() + ceiling + 31), reserve_seconds=0, cleanup_grace=30,
                    cwd=before['source'], env={**env, **(extra or {})}, stdout=stdout, stderr=stderr)
            code = done.returncode if done.returncode >= 0 else 128 - done.returncode
            facts['exitCode'] = code
            write(directory / (name + '.deadline.json'), facts)
            result['steps'].append({'name': name, 'exitCode': code})
            if code == 124 or code >= 128:
                raise SystemExit(code)
            return code
        identity = 'JSON.stringify({platform:process.platform,arch:process.arch,version:process.version,bun:globalThis.Bun?.revision,webkit:process.versions.webkit})'
        assert step('node-identity', [before['node']['path'], '-p', identity], 15) == 0
        node_identity = load(directory / 'node-identity.stdout')
        assert node_identity['platform'] == 'linux' and node_identity['arch'] == 'x64' and node_identity['version'] == 'v26.12.1'
        expected = bound['expectedCompilerSources']
        for profile, compiler in before['compilers'].items():
            assert step('identity-' + profile, [compiler['path'], '--no-env-file', '--no-install', '-p', identity], 15) == 0
            found = load(directory / ('identity-' + profile + '.stdout'))
            assert found['platform'] == 'linux' and found['arch'] == 'x64' and found['bun'] == expected['bun'] and found['webkit'] == expected['webkit']
        inventory = directory / 'full-dist-inventory.json'
        assert step('full-dist-census', [before['node']['path'], payload / 'helpers/scan.cjs'], 180,
                    {'PROBE_TYPESCRIPT': before['typescript'], 'PROBE_MODULES': str(root / 'source/dist'), 'PROBE_OUTPUT': str(inventory)}) == 0
        for profile, compiler in before['compilers'].items():
            query = directory / ('builtin-query-' + profile + '.json')
            selected = directory / ('selected-' + profile + '.json')
            queried = step('builtin-query-' + profile, [compiler['path'], '--no-env-file', '--no-install', payload / 'helpers/runtime.ts', inventory, query], 60)
            if queried == 0:
                step('selected-' + profile, [compiler['path'], '--no-env-file', '--no-install', payload / 'project-selected-builtins.mjs', root / 'source', root / 'admission-inputs/plugins/desktop.json', inventory, query, selected], 180)
            result['profiles'].append(profile)
        after = snapshot(root, work, payload)
        write(directory / 'source-after.json', after)
        assert before == after, 'Inputs changed during compatibility preflight'
        assert [item['name'] for item in result['steps']] == STEPS
        assert all(item['exitCode'] == 0 for item in result['steps']), 'Compatibility command failed'
        reports_passed(directory)
        result['status'] = 'PASS'
        code = 0
    except SystemExit as stopped:
        code = stopped.code if isinstance(stopped.code, int) else 1
        result['error'] = 'Compatibility preflight interrupted or deadline exhausted'
    except Exception as error:
        result['error'] = type(error).__name__ + ': ' + str(error)
    finally:
        result['outputs'] = {name: sha(directory / name) for name in EXPORT_FILES if name != 'result.json' and (directory / name).is_file()}
        write(directory / 'result.json', result)
    print(json.dumps({'status': result['status'], 'receipt': str(directory / 'result.json'), 'nativeCompile': False}), flush=True)
    return code


if __name__ == '__main__':
    assert sys.argv[1:] in [['run'], ['verify']]
    if sys.argv[1] == 'verify':
        print(json.dumps(verify_completed()))
    else:
        raise SystemExit(run())
