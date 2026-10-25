#!/usr/bin/env python3
"""Run the pinned fetched CJS plugin case after native qualification admission."""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import sys

HERE = Path(__file__).resolve().parent
FIXTURE = HERE / 'teams-fetched'


def read(path):
    return json.loads(Path(path).read_text())


def write(path, value):
    Path(path).write_text(json.dumps(value, indent=2) + '\n')


def sha(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def cjs_boundary(observed):
    plugin = observed['plugin']
    root = Path(plugin['rootDir']).resolve(strict=True)
    source = Path(plugin['source']).resolve(strict=True)
    reference = read(FIXTURE / 'boundary-reference.json')
    package = read(root / 'package.json')
    assert package['openclaw']['build']['runtimeFormat'] == 'cjs'
    assert package['openclaw']['runtimeExtensions'] == ['./dist/index.cjs']
    assert source == (root / reference['entry']['relative']).resolve(strict=True)
    assert sha(source) == reference['entry']['sha256'], 'Installed CJS entry differs from pinned bytes'
    return {'source': str(source), 'sha256': sha(source),
            'sdkRequireEvidence': reference['entry']['sdkRequireEvidence']}


def run(input_proof):
    os.umask(0o077)
    proof = read(input_proof)
    assert proof['lane'] == 'teams-fetched' and proof['performanceEligible'] is False
    artifact = Path(proof['artifact']).resolve(strict=True)
    out = Path(proof['out']) / 'run'
    assert not out.exists()
    assert not any(out == path or out in path.parents or path in out.parents
                   for path in [artifact, HERE, Path(proof['source']).resolve(strict=True)])
    expected = {'openclaw': proof['binarySha256'], 'manifest.json': proof['manifestSha256']}
    for name, digest in expected.items():
        assert sha(artifact / name) == digest, 'Admitted artifact changed: ' + name
    out.mkdir()
    result = {'pass': False, 'phase': 'teams-fetched', 'performanceEligible': False,
              'sourceCommit': proof['sourceCommit'], 'variant': proof['variant'],
              'binarySha256': proof['binarySha256'], 'manifestSha256': proof['manifestSha256'],
              'buildReceiptSha256': proof['buildReceiptSha256'], 'steps': []}
    code = 1
    try:
        clone = out / 'artifact'
        shutil.copytree(artifact, clone, symlinks=True)
        for path in clone.rglob('*'):
            if path.is_symlink():
                assert path.resolve(strict=True).is_relative_to(clone), 'Artifact clone has an external symlink'
        for name, digest in expected.items():
            assert sha(clone / name) == digest
        state = out / 'state'
        for name in ['', 'workspace', 'tmp', 'cache', 'npm-cache', 'bun-cache']:
            (state / name).mkdir()
        for name in ['npmrc', 'global-npmrc']:
            (state / name).touch()
        config = read(FIXTURE / 'config.template.json')
        config['agents']['defaults']['workspace'] = str(state / 'workspace')
        write(state / 'openclaw.json', config)
        env = {'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8', 'LC_ALL': 'C.UTF-8', 'TZ': 'UTC',
               'NO_COLOR': '1', 'HOME': str(state), 'OPENCLAW_HOME': str(state),
               'OPENCLAW_STATE_DIR': str(state), 'OPENCLAW_CONFIG_PATH': str(state / 'openclaw.json'),
               'TMPDIR': str(state / 'tmp'), 'XDG_CACHE_HOME': str(state / 'cache'),
               'OPENCLAW_NO_RESPAWN': '1', 'OPENCLAW_SUPERVISOR_MODE': 'external',
               'OPENCLAW_SERVICE_REPAIR_POLICY': 'external', 'OPENCLAW_DISABLE_BONJOUR': '1',
               'OPENCLAW_NO_AUTO_UPDATE': '1', 'NODE_DISABLE_COMPILE_CACHE': '1',
               'npm_config_cache': str(state / 'npm-cache'),
               'npm_config_userconfig': str(state / 'npmrc'),
               'npm_config_globalconfig': str(state / 'global-npmrc'),
               'BUN_INSTALL_CACHE_DIR': str(state / 'bun-cache')}
        assert not any(shutil.which(name, path=env['PATH']) for name in
                       ['node', 'nodejs', 'bun', 'bunx', 'deno', 'js', 'qjs', 'quickjs']), 'External JS runtime on PATH'
        spec = importlib.util.spec_from_file_location('p6_runtime_owner', HERE.parent / 'runtime-controller.py')
        owner = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(owner)
        budget = read(FIXTURE / 'budget.json')
        pin = read(FIXTURE / 'pin.json')
        steps = [('install', [clone / 'openclaw', 'plugins', 'install', pin['installSpec'], '--accept-capabilities'], budget['installSeconds']),
                 ('inspect', [clone / 'openclaw', 'plugins', 'inspect', 'msteams', '--runtime', '--json'], budget['inspectSeconds']),
                 ('assert', [sys.executable, '-B', FIXTURE / 'assert-teams.py', '--inspect', out / 'inspect/command.stdout',
                             '--state', state, '--pin', FIXTURE / 'pin.json', '--out', out / 'verification.json'], budget['assertSeconds'])]
        for name, argv, timeout in steps:
            directory = out / name
            directory.mkdir()
            receipt = owner.run_command(argv, out, env, directory, timeout, budget['commandCleanupSeconds'])
            write(directory / 'receipt.json', receipt)
            result['steps'].append({'name': name, **receipt})
            code = receipt['exitCode']
            if receipt['interruptedBySignal'] is not None:
                code = 128 + receipt['interruptedBySignal']
            elif receipt['timeout']:
                code = 124
            elif code < 0:
                code = 128 - code
            if code or receipt['cancelled'] or receipt['forcedCleanup']:
                code = code or 1
                raise RuntimeError(name + ' failed; preserve raw command evidence')
        assert read(out / 'verification.json')['status'] == 'passed'
        result['cjsBoundary'] = cjs_boundary(read(out / 'inspect/command.stdout'))
        shutil.copyfile(result['cjsBoundary']['source'], out / 'installed-entry.txt')
        result['pass'] = True
        code = 0
    except Exception as error:
        result['error'] = type(error).__name__ + ': ' + str(error)
        code = code or 1
    finally:
        try:
            for name, digest in expected.items():
                assert sha(artifact / name) == digest, 'Input artifact changed: ' + name
            result['inputArtifactUnchanged'] = True
        except Exception as error:
            result.update(error=str(error), inputArtifactUnchanged=False)
            result['pass'] = False
            code = code or 1
        write(out / 'result.json', result)
    return code


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('input_proof', type=Path)
    raise SystemExit(run(parser.parse_args().input_proof))
