"""Qualify the reviewed empty-config repair without publishing the runtime branch."""
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import time
from xml.etree import ElementTree

SOURCE = Path('/work/source')
OUT = Path('/work/repair-proof')
INPUTS = Path(__file__).resolve().parent
BUN = '454a78a4d3b0202ecdbedf7dd051fc84ffc59e9e'
WEBKIT = 'b82bc917e99110b61c3a21202d6def7457aa194c'
OWNER = 'src/runtime/socket/socket_body.rs'
BEFORE = '66121e98f4e8537520f976ff572ef538cc7baedf3e59c8ab2fdfce5fe4bc2afc'
AFTER = '2a40a7df44cfbc9344eb92ced128da282ade137fe2a08f5319d85b23c297dfb0'
PATCH = 'a0fbcc59fae14006b39c60d5cd71d0b71f80f151c6b0eac7d689db5fcbcfc25b'
FIXTURE = 'test/js/bun/net/socket-retention.test.ts'
FIXTURE_SHA = 'd4c04a72b89bc7d33c292a16a57c38f5da540815dc2e141adfd58c1bd9973af2'
BUILD = SOURCE / 'build/tls-empty-config'
ENV = {k: v for k, v in os.environ.items() if not any(x in k.upper() for x in ('TOKEN', 'SECRET', 'PASSWORD'))}
ENV.update(CI='true', CARGO_BUILD_JOBS='2')
DEADLINE = time.monotonic() + 240 * 60
STEPS = []


def sha(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def git(*args):
    return subprocess.check_output(['git', '-C', str(SOURCE), *args], timeout=120, text=True).strip()


def save(**facts):
    (OUT / 'proof.json').write_text(json.dumps(dict(passed=False, bun=BUN, webkit=WEBKIT,
        patch_sha256=PATCH, source_before=BEFORE, source_after=AFTER, steps=STEPS, **facts), indent=2) + '\n')


def run(name, argv, seconds):
    log = OUT / (name + '.log')
    step = dict(name=name, argv=argv, exit_code=None, timed_out=False)
    STEPS.append(step)
    save()
    with log.open('xb') as stream:
        process = subprocess.Popen(argv, cwd=SOURCE, env=ENV, stdin=subprocess.DEVNULL,
            stdout=stream, stderr=subprocess.STDOUT, start_new_session=True)
        started = time.monotonic()
        try:
            while process.poll() is None:
                if time.monotonic() >= min(DEADLINE, started + seconds):
                    step['timed_out'] = True
                    raise TimeoutError(name)
                assert sum(p.stat().st_size for p in OUT.iterdir() if p.is_file()) <= 64 * 1024**2, 'proof exceeds 64 MiB'
                time.sleep(1)
        finally:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            process.wait()
            stream.flush()
            step['exit_code'] = process.returncode
            save()
    assert process.returncode == 0 and not step['timed_out'], name
    return log.read_text(errors='replace')


def source_state(adapted):
    assert git('rev-parse', 'HEAD') == BUN
    assert git('write-tree') == original_tree
    assert git('diff', '--no-renames', '--name-only', 'HEAD').splitlines() == ([OWNER] if adapted else [])
    assert not git('ls-files', '--others', '--exclude-standard')
    assert sha(SOURCE / OWNER) == (AFTER if adapted else BEFORE)
    assert sha(SOURCE / FIXTURE) == FIXTURE_SHA


OUT.mkdir(exist_ok=True)
original_tree = git('rev-parse', 'HEAD^{tree}')
source_state(False)
assert os.uname().machine == 'aarch64'
assert sha(INPUTS / 'tls-config-repair.patch') == PATCH
save()
run('apply-check', ['git', 'apply', '--check', str(INPUTS / 'tls-config-repair.patch')], 60)
run('apply', ['git', 'apply', str(INPUTS / 'tls-config-repair.patch')], 60)
source_state(True)
run('rustfmt', ['rustup', 'run', 'nightly-2026-09-15', 'rustfmt', '--edition', '2024',
    '--config-path', 'rustfmt.toml', '--config', 'skip_children=true', '--check', OWNER], 120)
source_state(True)
run('build', ['bun', 'scripts/build.ts', '--profile=release', '--ci=on', '--os=linux',
    '--arch=aarch64', '--abi=gnu', '--build-dir=build/tls-empty-config', '-j2'], 13800)
source_state(True)
binary, profile = BUILD / 'bun', BUILD / 'bun-profile'
assert binary.is_file() and profile.is_file()
identity = json.loads(run('identity', [str(binary), '-e',
    'console.log(JSON.stringify({commit:Bun.revision,webkit:process.versions.webkit,platform:process.platform,arch:process.arch}))'], 60))
assert identity == dict(commit=BUN, webkit=WEBKIT, platform='linux', arch='arm64'), identity
node = json.loads(run('node', ['node', '-e',
    'console.log(JSON.stringify({node:process.versions.node,bun:process.versions.bun??null,platform:process.platform,arch:process.arch}))'], 60))
assert node == dict(node='26.12.1', bun=None, platform='linux', arch='arm64'), node
symbols = run('symbols', ['llvm-nm', '--defined-only', '--format=posix', str(profile)], 120)
names = [line.split()[0] for line in symbols.splitlines() if re.fullmatch(
    r'_RNv\w*11bun_runtime6socket11socket_body\w*20DuplexUpgradeContext6deinit', line.split()[0])]
assert len(names) == 1, 'repair deinit symbol missing or ambiguous'
run('deinit-disassembly', ['llvm-objdump', '--disassemble-symbols=' + names[0], '--demangle', str(profile)], 120)
files = json.loads(run('test-files', ['bun', '-e',
    'import {tlsQualificationFiles} from "./scripts/openclaw-release/release.ts";console.log(JSON.stringify(tlsQualificationFiles))'], 60))
assert len(files) == 6 and len(set(files)) == 6 and FIXTURE in files
fixture_hashes = {name: sha(SOURCE / name) for name in files}
cases = []
for index, name in enumerate(files):
    xml = OUT / ('tls-' + str(index) + '.xml')
    run('tls-' + str(index), [str(binary), 'test', name, '--reporter=junit', '--reporter-outfile=' + str(xml)], 600)
    selected = list(ElementTree.parse(xml).iter('testcase'))
    assert selected and all(c.find('failure') is None and c.find('error') is None for c in selected), name
    assert any(c.find('skipped') is None for c in selected), name
    cases += selected
    source_state(True)
for name in ['a TLS Duplex completion retains its owner and is inert after destroy',
             'TLS Duplex cycles collect after startup while a retained origin keeps its wrapper alive']:
    selected = [case for case in cases if case.get('name') == name]
    assert len(selected) == 1 and selected[0].find('skipped') is None, name
assert len(cases) == 291 and sum(c.find('skipped') is not None for c in cases) == 8
assert fixture_hashes == {name: sha(SOURCE / name) for name in files}
identities = dict(binary=sha(binary), profile=sha(profile), build_ninja=sha(BUILD / 'build.ninja'))
run('restore', ['git', 'restore', '--source=' + BUN, '--worktree', '--', OWNER], 60)
source_state(False)
save(completed=True, identity=identity, binary_sha256=identities, fixture_sha256=fixture_hashes,
     passed_cases=283, skipped_cases=8, source_restored=True)
result = json.loads((OUT / 'proof.json').read_text())
result['passed'] = True
(OUT / 'proof.json').write_text(json.dumps(result, indent=2) + '\n')
