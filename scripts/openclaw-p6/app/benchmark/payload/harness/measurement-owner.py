#!/usr/bin/env python3
"""Admitted native P6 standalone build. Default is read-only preflight/dry-run."""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import runpy
import shutil
import signal
import subprocess
import sys
import traceback

BUN_PIN = 'fd40ba44187c721ee023062fa153a6a27560e6b1'
WEBKIT_PIN = 'aaa690bfbf34c9d50775716ac2fc3c7d0573e0b8'
CB_BUN_PIN = 'b838e73072227c2652a41c689299284f1965cdc6'
COHORTS = {
    'baseline-fd40': {'bun': BUN_PIN, 'webkit': WEBKIT_PIN, 'profiles': {
        'standard': {'shadowRealm': True, 'hardened': False},
        'c2': {'shadowRealm': False, 'hardened': False},
        'c2-linux-hardened': {'shadowRealm': False, 'hardened': True},
    }},
    'cb-b838': {'bun': CB_BUN_PIN, 'webkit': WEBKIT_PIN, 'profiles': {
        'cb-standard': {'shadowRealm': True, 'hardened': False},
        'cb-compat': {'shadowRealm': False, 'hardened': False},
        'cb-linux-hardened': {'shadowRealm': False, 'hardened': True},
    }},
}
MEASURE_SHA = '2fa495f4727a351f6cee078b403ac064610ce90ed339311f55c40a567463e4b7'
FLAGS = {
    'js': ['--compile-aot', '--explain=statistics'],
    'c2': ['--compile-aot', '--no-compile-function-source',
           '--disallow-code-generation-from-strings', '--explain=statistics'],
    'ts': ['--aot-source', '--explain=statistics'],
    'strong': ['--compile-aot', '--no-compile-function-source',
               '--disallow-code-generation-from-strings', '--explain=statistics'],
    'jit': [],
}
PROFILES = {'js': 'standard', 'ts': 'standard', 'jit': 'standard',
            'c2': 'c2', 'strong': 'c2-linux-hardened'}


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def require(condition, message):
    if not condition:
        raise ValueError(message)


def sha(filename):
    digest = hashlib.sha256()
    with Path(filename).open('rb') as stream:
        for data in iter(lambda: stream.read(8 << 20), b''):
            digest.update(data)
    return digest.hexdigest()


def load(filename):
    return json.loads(Path(filename).read_text())


def write(filename, value):
    with Path(filename).open('x') as stream:
        json.dump(value, stream, indent=2)
        stream.write('\n')


def beneath(root, value):
    path = Path(value)
    require(path.is_absolute(), f'Absolute path required: {value}')
    path = path.resolve()
    require(path != root and root in path.parents, f'Path must be inside P6 root {root}: {path}')
    return path


def git(source, *args):
    result = subprocess.run(['git', '-c', f'safe.directory={source}', '-C', str(source), *args],
                            env={'PATH': '/usr/local/bin:/usr/bin:/bin', 'HOME': str(source.parent),
                                 'GIT_CONFIG_NOSYSTEM': '1'}, capture_output=True, text=True)
    require(result.returncode == 0, f'git {args[0]} failed: {result.stderr.strip()}')
    return result.stdout.strip()


def native_elf(executable, arch):
    require(os.access(executable, os.X_OK), f'Not executable: {executable}')
    with executable.open('rb') as stream:
        header = stream.read(20)
    machine = 183 if arch == 'arm64' else 62
    require(header[:6] == b'\x7fELF\x02\x01' and int.from_bytes(header[18:20], 'little') == machine,
            f'ELF architecture differs from native Linux target: {executable}')


class BuildInterrupted(Exception):
    pass


def interrupted(signum, _frame):
    # subprocess/select treats InterruptedError as a syscall retry, not cancellation.
    raise BuildInterrupted(f'Build driver interrupted by signal {signum}')


def run_probe(command, *, env, cwd, timeout):
    child = subprocess.Popen(command, env=env, cwd=cwd, stdin=subprocess.DEVNULL,
                             stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                             text=True, start_new_session=True)
    try:
        stdout, stderr = child.communicate(timeout=timeout)
        return subprocess.CompletedProcess(command, child.returncode, stdout, stderr)
    finally:
        if child.poll() is None:
            try:
                os.killpg(child.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            child.communicate()


def admitted(admission):
    require(admission.get('schemaVersion') == 1 and admission.get('lane') == 'P6' and
            admission.get('decision') == 'build-linux', 'Explicit root P6 build admission required')


def cohort(name):
    require(name in COHORTS, 'Explicit supported compiler/reference cohort required')
    return COHORTS[name]


def retained_capabilities(root, admission, compiler_cohort, variant):
    allow = admission.get('compileTrimAllow')
    if compiler_cohort == 'baseline-fd40' or variant == 'jit':
        require(allow is None, 'Baseline and untrimmed JIT use no retained-capability option')
        return None, None
    require(allow in [['run'], ['run', 'jit']], 'CB AOT requires explicit compileTrimAllow:[run] or [run,jit]')
    reason = None
    if 'jit' in allow:
        proof = admission.get('jitRetentionProof', {})
        require(isinstance(proof.get('reason'), str) and proof['reason'].strip(),
                'JIT retention requires a named observed runtime failure')
        filename = beneath(root, proof['failureReceipt'])
        require(sha(filename) == proof['sha256'], 'JIT-retention failure receipt changed')
        reason = {**proof, 'failureReceipt': str(filename)}
    return allow, reason


def source_retention_contract(node, source, root, output, flags, plugins, allow):
    if allow is None:
        return None
    script = ('const owner=await import(process.argv[1]); '
              'console.log(JSON.stringify(owner.parseStandaloneArguments(process.argv.slice(2))));')
    checked = run_probe([str(node), '--no-warnings', '--input-type=module', '--eval', script,
        (source / 'scripts/lib/bun-standalone-contract.mjs').as_uri(), str(output),
        *flags, '--trim-allow', ','.join(allow), '--plugins', ','.join(plugins)],
        cwd=root, env={'PATH': f'{node.parent}:/usr/bin:/bin', 'HOME': str(root),
                      'TMPDIR': str(root), 'LANG': 'C.UTF-8'}, timeout=30)
    require(checked.returncode == 0,
            'Retained-capability build blocked: admitted landed source must implement --trim-allow. '
            + checked.stderr.strip())
    parsed = json.loads(checked.stdout)
    trim = parsed.get('aotCompileOptions', {}).get('trim')
    require(parsed.get('mode') == 'aot' and isinstance(trim, dict) and trim.get('allow') == allow and
            bool(parsed.get('source')) == ('--aot-source' in flags),
            'Retained-capability build blocked: source parser did not preserve the requested allow list')
    return parsed


def execution_paths(root, admission, reserved_receipt=None):
    source = beneath(root, admission['source'])
    output = beneath(root, admission['output'])
    receipt = beneath(root, admission['receiptDirectory'])
    for path in [output, receipt]:
        if path != reserved_receipt:
            require(not path.exists(), f'Fresh path required: {path}')
        require(source not in path.parents and source != path, 'Output/receipt must be outside source')
    require(output != receipt and output not in receipt.parents and receipt not in output.parents,
            'Artifact and receipt directories must be separate')
    return source, output, receipt


def source_proof(source, cut):
    commit = cut['commit']
    require(re.fullmatch('[0-9a-f]{40}', commit), 'Full Linux source commit required')
    require(cut['status'] == 'landed-main', 'Linux cut must explicitly be landed-main')
    require(cut['mainRef'] in ['refs/remotes/origin/main', 'refs/heads/main'], 'Explicit main ref required')
    require(re.fullmatch('[0-9a-f]{40}', cut['mainRefSha']), 'Full observed-main SHA required')
    require(isinstance(cut['frozenAt'], str) and cut['frozenAt'], 'Root campaign freeze timestamp required')
    datetime.datetime.fromisoformat(cut['frozenAt'].replace('Z', '+00:00'))
    require(git(source, 'rev-parse', 'HEAD') == commit, 'Source HEAD differs from admitted Linux cut')
    require(git(source, 'rev-parse', cut['mainRef']) == cut['mainRefSha'], 'Local main ref differs from admission')
    git(source, 'merge-base', '--is-ancestor', commit, cut['mainRefSha'])
    require(not git(source, 'status', '--porcelain', '--untracked-files=no'), 'Tracked source is dirty')
    ancestors = cut['requiredAncestors']
    require(isinstance(ancestors, list), 'requiredAncestors must be explicit')
    for ancestor in ancestors:
        require(re.fullmatch('[0-9a-f]{40}', ancestor), 'Full required-ancestor SHA required')
        git(source, 'merge-base', '--is-ancestor', ancestor, commit)
    info = load(source / 'dist/build-info.json')
    package = load(source / 'package.json')
    require(info.get('commit') == commit, 'dist/build-info.json belongs to another source commit')
    require(info.get('version') == package['version'], 'dist/build-info.json version is stale')
    require((source / 'dist/cli-startup-metadata.json').is_file(), 'Complete pnpm build first')
    return {'commit': commit, 'mainRef': cut['mainRef'], 'mainRefSha': cut['mainRefSha'],
            'frozenAt': cut['frozenAt'], 'requiredAncestors': ancestors,
            'version': package['version'], 'distBuildInfo': info,
            'hashes': {name: sha(source / name) for name in ['dist/build-info.json',
                       'package.json', 'pnpm-lock.yaml', 'scripts/build-bun-standalone.mjs',
                       'scripts/lib/bun-standalone-contract.mjs',
                       'scripts/lib/bun-standalone-source-parser.mjs']}}


def prepare(root, admission_file, measurement, reserved_receipt=None):
    require(platform.system() == 'Linux', 'Driver requires native Linux')
    arch = {'aarch64': 'arm64', 'x86_64': 'x64'}.get(platform.machine())
    require(arch, 'Only Linux arm64/x64 supported')
    admission = load(admission_file)
    admitted(admission)
    variant = admission['variant']
    require(variant in FLAGS, 'Unknown variant')
    source, output, receipt = execution_paths(root, admission, reserved_receipt)
    proof = source_proof(source, admission['linuxCut'])
    require(proof['hashes']['dist/build-info.json'] == admission['distBuildInfoSha256'],
            'Admitted dist/build-info.json bytes differ')
    reference = admission['p0Reference']
    reference_cohort = cohort(reference.get('cohort'))
    index = beneath(root, reference['manifest'])
    require(index.name == 'P0-artifacts.json' and index.is_file(), 'P0 manifest clone is required')
    require(sha(index) == reference['manifestSha256'], 'P0 manifest clone differs from admission')
    state = load(index)
    require(state.get('schemaVersion') == 1 and state.get('lane') == 'P0', 'Invalid P0 manifest')
    entries = [row for row in state['artifacts'] if row['variant'] == reference['variant'] and
               row['sourceCommit'] == reference['sourceCommit'] and
               row['sha256'] == reference['executableSha256']]
    require(len(entries) == 1, 'P0 reference does not identify one immutable artifact')
    p0 = entries[0]
    require(p0.get('signed') is True, 'P0 reference must be an indexed signed artifact')
    require(p0['compilerPins']['bun'] == reference_cohort['bun'] and
            p0['compilerPins']['webkit'] == reference_cohort['webkit'],
            'P0 reference uses different compiler pins')
    if reference['cohort'] == 'cb-b838':
        require(p0['compilerPins']['shadowRealm'] == 'retained' and
                p0['compilerPins']['historicalC2Equivalent'] is False,
                'CB P0 reference must preserve its retained-ShadowRealm distinction')
    require(p0['sourceStatus'] in ['main', 'main-plus-open-pr'], 'Unknown P0 source status')
    if p0['sourceStatus'] == 'main':
        require(p0['mainSha'] == p0['sourceCommit'], 'P0 main artifact has inconsistent identity')
    if p0['sourceCommit'] != proof['commit']:
        require(admission['linuxCut']['requiredAncestors'] and
                admission['linuxCut'].get('p0DifferenceRationale', '').strip(),
                'Different P0/Linux cuts require explicit root rationale and landed-repair ancestry')
    compiler = admission['compiler']
    selected_cohort = cohort(compiler.get('cohort'))
    executable = beneath(root, compiler['path'])
    allowed_profiles = [PROFILES[variant]] if compiler['cohort'] == 'baseline-fd40' else (
        ['cb-linux-hardened'] if variant == 'strong' else
        ['cb-standard', 'cb-compat'] if variant == 'c2' else ['cb-standard'])
    require(compiler['profile'] in allowed_profiles, 'Compiler engine profile differs from cohort/variant')
    expected_features = selected_cohort['profiles'][compiler['profile']]
    require(compiler.get('engineFeatures') == expected_features and
            all(type(value) is bool for value in compiler['engineFeatures'].values()),
            'Compiler engine features differ from the explicit cohort/profile')
    require(compiler['bunCommit'] == selected_cohort['bun'] and
            compiler['webkitCommit'] == selected_cohort['webkit'],
            'Compiler provenance uses different pins')
    require(sha(executable) == compiler['sha256'], 'Compiler bytes differ from admission')
    native_elf(executable, arch)
    node = admission['buildNode']
    node_path = beneath(root, node['path'])
    require(node_path.name == 'node', 'Build Node must be named node for the source parser fallback')
    require(sha(node_path) == node['sha256'], 'Build Node bytes differ from admission')
    native_elf(node_path, arch)
    strip_probe = '''import {stripTypeScriptTypes} from 'node:module';
const input='const f = true ? async (x: number): Promise<number> => x : null;';
const output=stripTypeScriptTypes(input,{mode:'strip'});
console.log(JSON.stringify({platform:process.platform,arch:process.arch,version:process.version,
  offsetsPreserved:output.length===input.length,typesRemoved:!output.includes('number')}));'''
    probed = run_probe([str(node_path), '--no-warnings', '--input-type=module', '--eval', strip_probe],
        cwd=root, env={'PATH': f'{node_path.parent}:/usr/bin:/bin', 'HOME': str(root),
                      'TMPDIR': str(root), 'LANG': 'C.UTF-8'}, timeout=30)
    require(probed.returncode == 0, f'Build Node type-stripper preflight failed: {probed.stderr}')
    node_probe = json.loads(probed.stdout)
    require(node_probe['platform'] == 'linux' and node_probe['arch'] == arch and
            node_probe['offsetsPreserved'] and node_probe['typesRemoved'],
            f'Build Node type-stripper contract failed: {node_probe}')
    plugins_file = beneath(root, admission['pluginsFile'])
    require(sha(plugins_file) == admission['pluginsSha256'], 'Plugin selection differs from admission')
    plugins = load(plugins_file)
    require(isinstance(plugins, list) and plugins and plugins == sorted(set(plugins)) and
            all(isinstance(item, str) and re.fullmatch('[a-z0-9][a-z0-9._-]*', item) for item in plugins),
            'Plugin IDs must be a nonempty sorted unique JSON array')
    allow, retention_proof = retained_capabilities(root, admission, compiler['cohort'], variant)
    source_contract = source_retention_contract(node_path, source, root, output, FLAGS[variant], plugins, allow)
    retention_flags = ['--trim-allow', ','.join(allow)] if allow is not None else []
    measurement = beneath(root, str(measurement))
    require(sha(measurement) == MEASURE_SHA, 'Reviewed measurement utility bytes changed')
    command = ['/usr/bin/nice', '-n', '10', str(executable), '--no-env-file', '--no-install',
               str(source / 'scripts/build-bun-standalone.mjs'), str(output),
               *FLAGS[variant], *retention_flags, '--plugins', ','.join(plugins)]
    timeout = admission.get('timeoutSeconds', 12 * 3600)
    require(type(timeout) is int and 1 <= timeout <= 24 * 3600, 'Invalid build timeout')
    return {'operation': 'build-linux', 'variant': variant, 'platform': 'linux', 'arch': arch,
            'kernel': platform.release(), 'source': str(source), 'sourceProof': proof,
            'linuxCut': admission['linuxCut'], 'p0Reference': p0,
            'p0ReferenceCohort': reference['cohort'],
            'p0ManifestClone': str(index), 'p0ManifestSha256': reference['manifestSha256'],
            'compiler': compiler, 'buildNode': node, 'buildNodeProbe': node_probe,
            'compileTrimAllow': allow, 'jitRetentionProof': retention_proof,
            'sourceRetentionContract': source_contract,
            'policyLabel': '/'.join([compiler['cohort'], compiler['profile'], variant,
                                    '+'.join(allow) if allow is not None else 'default']),
            'c2ApplicationHardening': variant in ['c2', 'strong'],
            'historicalC2Equivalent': variant == 'c2' and compiler['cohort'] == 'baseline-fd40',
            'plugins': plugins, 'pluginsFile': str(plugins_file),
            'pluginsSha256': admission['pluginsSha256'], 'output': str(output),
            'receiptDirectory': str(receipt), 'command': command,
            'measurementUtility': str(measurement), 'measurementUtilitySha256': MEASURE_SHA,
            'admissionFile': str(admission_file), 'admissionSha256': sha(admission_file),
            'driverSha256': sha(__file__),
            'artifactCheckerSha256': sha(Path(__file__).with_name('artifact-contract.mjs')),
            'buildEnvironmentOverrides': {'UV_THREADPOOL_SIZE': '2'},
            'timeoutSeconds': timeout}


def reject_competing_builds():
    active = []
    for item in Path('/proc').iterdir():
        if not item.name.isdigit() or int(item.name) == os.getpid():
            continue
        try:
            argv = (item / 'cmdline').read_bytes().decode(errors='replace').rstrip('\0').split('\0')
        except (FileNotFoundError, ProcessLookupError, PermissionError):
            continue
        builder = any(Path(arg).name == 'build-bun-standalone.mjs' for arg in argv)
        bun_compile = (len(argv) > 1 and Path(argv[0]).name == 'bun' and argv[1] == 'build' and
                       any(arg.startswith(('--compile', '--aot')) for arg in argv[2:]))
        if builder or bun_compile:
            active.append({'pid': int(item.name), 'argv': argv})
    require(not active, f'Competing actual standalone compiler process: {active}')


def environment(receipt, compiler, node):
    state = receipt / 'state'
    for name in ['home', 'tmp', 'cache', 'workspace']:
        (state / name).mkdir(parents=True)
    return {'PATH': f'{Path(node).parent}:{Path(compiler).parent}:/usr/local/bin:/usr/bin:/bin',
            'HOME': str(state / 'home'), 'TMPDIR': str(state / 'tmp'),
            'TMP': str(state / 'tmp'), 'TEMP': str(state / 'tmp'),
            'XDG_CACHE_HOME': str(state / 'cache'), 'LANG': 'C.UTF-8', 'LC_ALL': 'C.UTF-8',
            'SHELL': '/bin/bash', 'USER': 'p6-synthetic', 'NO_COLOR': '1', 'TERM': 'dumb',
            'CI': '1', 'UV_THREADPOOL_SIZE': '2', 'NODE_DISABLE_COMPILE_CACHE': '1',
            'OPENCLAW_STATE_DIR': str(state), 'OPENCLAW_CONFIG_PATH': str(state / 'openclaw.json'),
            'OPENCLAW_NO_RESPAWN': '1', 'OPENCLAW_SUPERVISOR_MODE': 'external',
            'OPENCLAW_SERVICE_REPAIR_POLICY': 'external'}


def measure(plan, env, receipt):
    # Execute the reviewed owner in this process so SIGINT/TERM raises through
    # its existing finally block and kills/reaps its isolated compiler group.
    old_argv, old_env, old_cwd = sys.argv, dict(os.environ), Path.cwd()
    old_signals = {sig: signal.signal(sig, interrupted) for sig in [signal.SIGINT, signal.SIGTERM]}
    try:
        sys.argv = [plan['measurementUtility'], '--label', plan['variant'], '--out',
                    str(receipt / 'measurement'), '--timeout', str(plan['timeoutSeconds']),
                    *(['--cleanup-grace-seconds', str(plan['cleanupGraceSeconds'])]
                      if 'cleanupGraceSeconds' in plan else []), '--', *plan['command']]
        os.environ.clear()
        os.environ.update(env)
        os.chdir(plan['source'])
        try:
            runpy.run_path(plan['measurementUtility'], run_name='__main__')
        except SystemExit as exit_result:
            code = exit_result.code
            if isinstance(code, int) and (code == 124 or code < 0 or code >= 128):
                raise
            require(code in [None, 0], f'Build command exited {code}')
    finally:
        os.chdir(old_cwd)
        os.environ.clear()
        os.environ.update(old_env)
        sys.argv = old_argv
        for sig, handler in old_signals.items():
            signal.signal(sig, handler)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', required=True, help='P6 external-volume root as mounted on Linux')
    parser.add_argument('--admission', required=True)
    parser.add_argument('--measure-command', required=True)
    parser.add_argument('--run', action='store_true')
    args = parser.parse_args()
    root = Path(args.root).resolve(strict=True)
    admission_file = beneath(root, args.admission)
    if not args.run:
        old_signals = {sig: signal.signal(sig, interrupted) for sig in [signal.SIGINT, signal.SIGTERM]}
        try:
            plan = prepare(root, admission_file, Path(args.measure_command))
            print(json.dumps({'status': 'dry-run', **plan}, indent=2))
        finally:
            for sig, handler in old_signals.items():
                signal.signal(sig, handler)
        return
    admission = load(admission_file)
    admitted(admission)
    _, _, receipt = execution_paths(root, admission)
    receipt.mkdir(parents=True)
    result = {'status': 'failed', 'startedAt': now(), 'phase': 'preflight',
              'admissionFile': str(admission_file), 'admissionSha256': sha(admission_file),
              'applicationQualified': False}
    old_signals = {sig: signal.signal(sig, interrupted) for sig in [signal.SIGINT, signal.SIGTERM]}
    try:
        plan = prepare(root, admission_file, Path(args.measure_command), reserved_receipt=receipt)
        result['plan'] = plan
        require(shutil.disk_usage(root).free >= 25 * 1024**3, 'Linux volume below 25 GiB floor')
        reject_competing_builds()
        env = environment(receipt, plan['compiler']['path'], plan['buildNode']['path'])
        result['phase'] = 'compiler-identity'
        identity = run_probe([plan['compiler']['path'], '--no-env-file', '--no-install', '-p',
            'JSON.stringify({platform:process.platform,arch:process.arch,bun:Bun.revision,webkit:process.versions.webkit})'],
            env=env, cwd=receipt / 'state/home', timeout=30)
        result['compilerIdentityProbe'] = {'exitCode': identity.returncode,
                                          'stdout': identity.stdout, 'stderr': identity.stderr}
        require(identity.returncode == 0, f'Compiler identity probe failed: {identity.stderr}')
        identity = json.loads(identity.stdout)
        require(identity == {'platform': 'linux', 'arch': plan['arch'],
                             'bun': plan['compiler']['bunCommit'], 'webkit': plan['compiler']['webkitCommit']},
                f'Compiler runtime provenance mismatch: {identity}')
        result['compilerRuntimeIdentity'] = identity
        write(receipt / 'plan.json', plan)
        reject_competing_builds()
        result['phase'] = 'build'
        measure(plan, env, receipt)
        result['measurement'] = load(receipt / 'measurement/receipt.json')
        result['phase'] = 'post-build-source-check'
        require(source_proof(Path(plan['source']), plan['linuxCut']) == plan['sourceProof'],
                'Source or package build identity changed during compilation')
        require(sha(admission_file) == plan['admissionSha256'] and
                sha(plan['pluginsFile']) == plan['pluginsSha256'] and
                sha(plan['buildNode']['path']) == plan['buildNode']['sha256'] and
                sha(plan['compiler']['path']) == plan['compiler']['sha256'],
                'Admitted inputs changed during build')
        result['phase'] = 'artifact-contract'
        inspector = Path(__file__).with_name('artifact-contract.mjs')
        check = run_probe(['/usr/bin/nice', '-n', '10', plan['compiler']['path'],
                                '--no-env-file', '--no-install', str(inspector),
                                str(receipt / 'plan.json')], env=env,
                                cwd=receipt / 'state/home', timeout=1800)
        (receipt / 'artifact-contract.stdout').write_text(check.stdout)
        (receipt / 'artifact-contract.stderr').write_text(check.stderr)
        require(check.returncode == 0, f'Artifact contract failed: {check.stderr}')
        result['artifact'] = json.loads(check.stdout)
        result['status'] = 'built-unsigned'
        result['phase'] = 'complete'
    except BaseException:
        result['error'] = traceback.format_exc()
        if (receipt / 'measurement/receipt.json').exists():
            result['measurement'] = load(receipt / 'measurement/receipt.json')
        raise
    finally:
        result['finishedAt'] = now()
        write(receipt / 'result.json', result)
        print(json.dumps({'status': result['status'], 'phase': result['phase'], 'receipt': str(receipt)}))
        for sig, handler in old_signals.items():
            signal.signal(sig, handler)


if __name__ == '__main__':
    main()
