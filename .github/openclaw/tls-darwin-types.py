"""Reconstruct shipping header layouts through the frozen compiler owner; never link or run them."""
import hashlib
import json
import os
from pathlib import Path
import runpy
import struct
import subprocess
import sys

SOURCE = Path('/work/source')
BUILD = SOURCE / 'build/openclaw-darwin-x64'
OUT = Path('/work/tls-darwin-types')
COMMIT = '510fef558b464c58de1209298f638fa476d03eef'
ENGINE = 'b82bc917e99110b61c3a21202d6def7457aa194c'
ENGINE_SHA = 'd59f456e79045c98420a0fc24ca624b33654f7d5fc8133e740b78eaec160b0c5'
REQUIRED = ('JSC::VM', 'JSC::Heap', 'JSC::PreciseAllocation', 'JSC::VerifierSlotVisitor',
            'JSC::ConservativeRoots', 'JSC::CurrentThreadState', 'JSC::RegisterState',
            'JSC::JSGlobalObject', 'JSC::JSWeakObjectRef', 'JSC::ProtoCallFrame')


def sha(path):
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        while chunk := stream.read(1024**2):
            digest.update(chunk)
    return digest.hexdigest()


def write(name, value):
    (OUT / name).write_text(json.dumps(value, indent=2) + '\n')


def run(name, args, cwd=SOURCE, timeout=600):
    with (OUT / (name + '.log')).open('x') as stream:
        subprocess.run(args, cwd=cwd, stdin=subprocess.DEVNULL, stdout=stream,
                       stderr=subprocess.STDOUT, check=True, timeout=timeout)
    assert (OUT / (name + '.log')).stat().st_size <= 8 * 1024**2


def build():
    assert os.uname().machine == 'x86_64' and os.uname().sysname == 'Linux'
    assert subprocess.check_output(['git', '-C', str(SOURCE), 'rev-parse', 'HEAD'], text=True).strip() == COMMIT
    assert not subprocess.check_output(['git', '-C', str(SOURCE), 'diff', '--name-only', 'HEAD'], text=True)
    manifest = SOURCE / 'scripts/build/deps/webkit-artifacts.json'
    spec = json.loads(manifest.read_text())
    artifact = spec['artifacts']['bun-webkit-macos-amd64-lto.tar.gz']
    assert spec['version'] == ENGINE and artifact['sha256'] == ENGINE_SHA
    assert artifact['url'] == f'https://github.com/openclaw/WebKit/releases/download/autobuild-{ENGINE}/bun-webkit-macos-amd64-lto.tar.gz'
    compiler = subprocess.check_output(['clang++', '--version'], text=True)
    assert '23.1.1' in compiler
    argv = ['bun', 'scripts/build.ts', '--profile=release', '--ci=on', '--os=darwin',
            '--arch=x64', '--build-dir=' + str(BUILD), '--configure-only']
    run('configure', argv)
    records = json.loads(subprocess.check_output(['ninja', '-C', str(BUILD), '-t', 'compdb', 'pch'], text=True))
    assert len(records) == 1
    pch = records[0]
    assert Path(pch['output']).suffix == '.pch'
    pch_path = (Path(pch['directory']) / pch['output']).resolve()
    assert pch_path.parent == BUILD / 'pch'
    run('prepare-headers', ['ninja', '-C', str(BUILD), '-j2', pch['output']], timeout=1800)
    database = BUILD / 'compile_commands.json'
    records = json.loads(database.read_text())
    chosen = [record for record in records if record['file'] == str(SOURCE / 'src/jsc/bindings/BunObject.cpp')]
    assert len(chosen) == 1
    original = chosen[0]['arguments']
    assert '-g1' in original and '-O3' in original and '-flto=thin' in original
    assert original[-4:-1] == ['-c', chosen[0]['file'], '-o']
    assert original.count('-include-pch') == 1
    pch_index = original.index('-include-pch')
    assert (Path(chosen[0]['directory']) / original[pch_index + 1]).resolve() == pch_path
    flags = original[:pch_index] + original[pch_index + 2:-4]
    assert original.count('-isysroot') == 1
    sdk = Path(original[original.index('-isysroot') + 1])
    sdk_settings = sdk / 'SDKSettings.json'
    assert json.loads(sdk_settings.read_text())['Version'] == '26.5'
    includes = [Path(arg[2:]) for arg in original if arg.startswith('-I')]
    roots = [p for p in includes if p.name == 'include' and ENGINE_SHA in str(p)]
    assert len(roots) == 1
    headers = roots[0]
    config = headers / 'cmakeconfig.h'
    assert ENGINE in config.read_text()
    required_headers = ['VerifierSlotVisitor.h', 'ConservativeRoots.h', 'MachineStackMarker.h',
                        'RegisterState.h', 'PreciseAllocation.h', 'JSWeakObjectRef.h', 'ProtoCallFrame.h', 'VM.h']
    assert all((headers / 'JavaScriptCore' / name).is_file() for name in required_headers)
    witness = OUT / 'types.cpp'
    wrapper = pch_path.with_suffix('')
    assert wrapper.is_file() and 'root-pch.h' in wrapper.name
    witness.write_text('#include "' + str(wrapper) + '"\n' + ''.join(
        '#include <JavaScriptCore/' + name + '>\n' for name in required_headers) +
        '\nstatic_assert(sizeof(JSC::VM) > 0);\nstatic_assert(sizeof(JSC::ConservativeRoots) > 0);\n')
    output = OUT / 'types.o'
    # This object supplies layouts only. No runtime code or shipping profile is replaced.
    replacement = {'-g1': '-g', '-flto=thin': '-fno-lto',
                   '-fwhole-program-vtables': '-fno-whole-program-vtables'}
    adapted = [replacement.get(arg, arg) for arg in flags]
    adapted += ['-fstandalone-debug', '-fno-eliminate-unused-debug-types', '-c', str(witness), '-o', str(output)]
    write('compile-command.json', dict(directory=chosen[0]['directory'], original=original, witness=adapted,
        variance='full standalone type metadata, no LTO or whole-program vtables, original PCH wrapper included as text, synthetic include-only translation unit; never linked or executed'))
    run('compile-types', adapted, cwd=Path(chosen[0]['directory']), timeout=600)
    assert 0 < output.stat().st_size <= 64 * 1024**2
    with output.open('rb') as stream:
        header = stream.read(32)
    assert struct.unpack_from('<IIII', header)[:4] == (0xfeedfacf, 0x01000007, 3, 1), 'not an x64 Mach-O relocatable object'
    snapshot = {}
    for p in sorted(headers.rglob('*')):
        if p.is_file():
            assert not p.is_symlink()
            snapshot[str(p.relative_to(headers))] = sha(p)
    assert snapshot
    write('header-manifest.json', snapshot)
    generated = {str(p.relative_to(BUILD)): sha(p) for p in sorted(BUILD.rglob('*'))
                 if p.is_file() and p.suffix in ('.h', '.hxx', '.hpp')}
    assert generated
    write('generated-headers.json', generated)
    write('receipt.json', dict(bun=COMMIT, engine=ENGINE, engine_archive=artifact,
        compiler=compiler, configure_argv=argv, compile_database_sha256=sha(database),
        sdk_settings_sha256=sha(sdk_settings), sdk_version='26.5',
        cmakeconfig_sha256=sha(config), header_manifest_sha256=sha(OUT / 'header-manifest.json'),
        generated_headers_sha256=sha(OUT / 'generated-headers.json'),
        witness_sha256=sha(output), witness_bytes=output.stat().st_size,
        configured_inputs_reconstructed=True, original_shipping_compile_database_available=False,
        profile_replaced=False, linked=False, executed=False,
        claim='reconstructed matching-header layouts only; no optimized local, instruction or GC-root proof'))
    assert not subprocess.check_output(['git', '-C', str(SOURCE), 'diff', '--name-only', 'HEAD'], text=True)


def inspect(debugger):
    import lldb
    out = Path('tls-darwin-types')
    receipt = json.loads((out / 'receipt.json').read_text())
    assert receipt['bun'] == COMMIT and receipt['engine'] == ENGINE
    assert receipt['witness_sha256'] == sha(out / 'types.o')
    assert receipt['executed'] is False and receipt['linked'] is False
    target = debugger.CreateTarget(str(out / 'types.o'))
    assert target.IsValid() and target.GetTriple().startswith('x86_64-apple-')
    control = runpy.run_path('controls/.github/openclaw/tls-darwin-capability.py', run_name='type_inventory_library')
    layouts = control['type_layouts'](target)
    missing = [name for name in REQUIRED if not any(
        item['complete'] and item['bytes'] > 0 and item['fields'] for item in layouts[name])]
    assert not target.GetProcess().IsValid()
    (out / 'layouts.json').write_text(json.dumps(dict(layouts=layouts, missing=missing,
        inferior_launched=False, root_capture_ready=False), indent=2) + '\n')
    assert not missing, missing


if __name__ == '__lldb__':
    import lldb
    inspect(lldb.debugger)
elif __name__ == '__main__':
    OUT.mkdir(exist_ok=True)
    assert sys.argv[1] == 'build'
    build()
