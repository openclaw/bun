"""Admit the consumed Darwin profile and inventory debugger capabilities without launching it."""
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shlex
import stat
import subprocess
import sys
import zipfile

COMMIT = '510fef558b464c58de1209298f638fa476d03eef'
RUN = 41238111110
ARTIFACT = 13057470428
SIZE = 232201333
DIGEST = 'a4d8b786d7bb87d166f757e089ac1705f4ac0701504038ebbecd438c9d6e06d6'
ROOT = Path(os.environ['RUNNER_TEMP']) / 'tls-darwin-input'
OUT = Path('tls-darwin-proof')


def sha(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def extract(source, name, dest, maximum):
    with zipfile.ZipFile(source) as archive:
        entries = archive.infolist()
        assert len(entries) <= 32
        names = set()
        for entry in entries:
            path = PurePosixPath(entry.filename)
            assert entry.filename and not path.is_absolute() and '..' not in path.parts
            assert '\\' not in entry.filename and '\x00' not in entry.filename
            assert str(path) == entry.filename.rstrip('/') and str(path) not in names
            names.add(str(path))
            assert stat.S_IFMT(entry.external_attr >> 16) in (0, stat.S_IFREG, stat.S_IFDIR)
            assert not entry.flag_bits & 1
        matches = [entry for entry in entries if entry.filename == name]
        assert len(matches) == 1 and not matches[0].is_dir()
        entry = matches[0]
        assert 0 < entry.file_size <= maximum
        with archive.open(entry) as incoming, dest.open('xb') as output:
            count = 0
            while chunk := incoming.read(1024**2):
                count += len(chunk)
                assert count <= maximum
                output.write(chunk)
        assert count == entry.file_size
    dest.chmod(0o600)


def tool(name, args):
    result = subprocess.run(args, stdin=subprocess.DEVNULL, capture_output=True, timeout=180)
    assert len(result.stdout) <= 8 * 1024**2 and len(result.stderr) <= 1024**2
    (OUT / (name + '.stderr')).write_bytes(result.stderr)
    assert result.returncode == 0, (name, result.returncode)
    (OUT / (name + '.txt')).write_bytes(result.stdout)
    return result.stdout.decode()


def prepare():
    assert os.uname().sysname == 'Darwin' and os.uname().machine == 'x86_64'
    run = json.loads((ROOT / 'run.json').read_text())
    meta = json.loads((ROOT / 'metadata.json').read_text())
    assert run['id'] == RUN and run['head_sha'] == COMMIT
    assert run['path'] == '.github/workflows/openclaw-release.yml'
    assert run['head_branch'] == 'claude/fix-tls-native-transport-20261019'
    assert run['event'] == 'workflow_dispatch' and run['status'] == 'completed'
    assert run['conclusion'] == 'failure'
    assert meta['id'] == ARTIFACT and meta['name'] == 'signed-darwin-x64'
    assert meta['size_in_bytes'] == SIZE and meta['digest'] == 'sha256:' + DIGEST
    assert not meta['expired'] and meta['workflow_run']['id'] == RUN
    assert meta['workflow_run']['head_sha'] == COMMIT
    archive = ROOT / 'artifact.zip'
    assert archive.stat().st_size == SIZE and sha(archive) == DIGEST
    profile_zip = ROOT / 'profile.zip'
    extract(archive, 'bun-darwin-x64-profile.zip', profile_zip, 1024**3)
    for name in ('bun-profile', 'bun-profile.dSYM'):
        extract(profile_zip, 'bun-darwin-x64-profile/' + name, ROOT / name, 2 * 1024**3)
    identities = {name: sha(ROOT / name) for name in ('profile.zip', 'bun-profile', 'bun-profile.dSYM')}
    uuids = []
    for name in ('bun-profile', 'bun-profile.dSYM'):
        text = tool(name + '-uuid', ['xcrun', 'dwarfdump', '--uuid', str(ROOT / name)])
        rows = re.findall(r'^UUID: ([0-9A-Fa-f-]{36}) \(x86_64\) ', text, re.M)
        assert len(rows) == 1 and len(text.splitlines()) == 1, text
        uuids.append(rows[0].lower())
    assert uuids[0] == uuids[1]
    tool('lldb-version', ['xcrun', 'lldb', '--version'])
    (OUT / 'inputs.json').write_text(json.dumps(dict(commit=COMMIT, run=RUN, artifact=ARTIFACT,
        artifact_sha256=DIGEST, identities=identities, uuid=uuids[0],
        claim='static capability inventory only; no inferior launch or GC-root proof'), indent=2) + '\n')


def type_layouts(target):
    layouts = {}
    for name in ('JSC::VM', 'JSC::Heap', 'JSC::Collector', 'JSC::PreciseAllocation',
                 'JSC::VerifierSlotVisitor', 'JSC::VerifierSlotVisitor::PreciseAllocationData',
                 'JSC::ConservativeRoots', 'JSC::CurrentThreadState', 'JSC::RegisterState',
                 'JSC::JSLexicalEnvironment', 'JSC::JSGenerator',
                 'JSC::JSGlobalObject', 'JSC::JSWeakObjectRef', 'JSC::ProtoCallFrame',
                 'WTF::StackTrace', 'Zig::JSFFIFunction',
                 'bun_runtime::socket::socket_body::DuplexUpgradeContext',
                 'bun_runtime::socket::upgraded_duplex::UpgradedDuplex'):
        found = target.FindTypes(name)
        assert found.GetSize() <= 128, name
        values = []
        for i in range(found.GetSize()):
            value = found.GetTypeAtIndex(i).GetCanonicalType()
            assert value.GetNumberOfFields() <= 512, name
            fields = [value.GetFieldAtIndex(j) for j in range(value.GetNumberOfFields())]
            values.append(dict(name=value.GetName(), complete=value.IsTypeComplete(), bytes=value.GetByteSize(),
                fields=[dict(name=f.GetName(), offset=f.GetOffsetInBytes(), type=f.GetType().GetName(),
                             bytes=f.GetType().GetByteSize()) for f in fields]))
        layouts[name] = values
    return layouts


def inspect(debugger):
    import lldb
    debugger.SetAsync(False)
    debugger.SetUseColor(False)
    command = lldb.SBCommandReturnObject()
    debugger.GetCommandInterpreter().HandleCommand('settings set target.load-script-from-symbol-file false', command)
    assert command.Succeeded()
    target = debugger.CreateTarget(str(ROOT / 'bun-profile'))
    assert target.IsValid() and target.GetTriple().startswith('x86_64-apple-')
    command = lldb.SBCommandReturnObject()
    debugger.GetCommandInterpreter().HandleCommand('target symbols add ' + shlex.quote(str(ROOT / 'bun-profile.dSYM')), command)
    assert command.Succeeded(), command.GetError()
    module = target.FindModule(target.GetExecutable())
    inputs = json.loads((OUT / 'inputs.json').read_text())
    assert module.GetUUIDString().lower() == inputs['uuid']
    layouts = type_layouts(target)
    functions = {}
    for name in ('JSC::constructWeakRef', 'JSC::JSWeakObjectRef::finishCreation',
                 'JSC::JSWeakObjectRef::deref', 'JSC__VM__runGC', 'posix_spawn_bun',
                 'JSC::SlotVisitor::appendConservativeRoots', 'JSC::SlotVisitor::appendJSCellOrAuxiliary',
                 'JSC::Heap::testAndSetMarked', 'JSC::sanitizeStackForVM',
                 'JSC::MachineThreads::gatherConservativeRoots', 'JSC::ConservativeRoots::genericAddSpan',
                 'JSC::ConservativeRoots::genericAddPointer', 'JSC::Interpreter::executeCall',
                 'JSC::Interpreter::executeModuleProgram', 'vmEntryToJavaScript',
                 'Bun__UpgradedDuplex__onWriteComplete',
                 'bun_runtime::socket::socket_body::DuplexUpgradeContext::run_event',
                 'bun_runtime::socket::socket_body::DuplexUpgradeContext::deinit'):
        contexts = module.FindFunctions(name, lldb.eFunctionNameTypeAny)
        assert contexts.GetSize() <= 128, name
        parents = {}
        for i in range(contexts.GetSize()):
            context = contexts.GetContextAtIndex(i)
            function = context.GetFunction()
            address = function.GetStartAddress() if function.IsValid() else context.GetSymbol().GetStartAddress()
            if not address.IsValid():
                continue
            resolved = function.GetName() if function.IsValid() else context.GetSymbol().GetName()
            key = address.GetFileAddress()
            if key in parents:
                continue
            instructions = function.GetInstructions(target) if function.IsValid() else context.GetSymbol().GetInstructions(target)
            assert instructions.GetSize() <= 16384, name
            rows = []
            for j in range(instructions.GetSize()):
                insn = instructions.GetInstructionAtIndex(j)
                entry = insn.GetAddress().GetLineEntry()
                data = bytes(insn.GetData(target).uint8s)
                assert len(data) == insn.GetByteSize()
                rows.append(dict(address=insn.GetAddress().GetFileAddress(), bytes=data.hex(),
                                 mnemonic=insn.GetMnemonic(target), operands=insn.GetOperands(target),
                                 comment=insn.GetComment(target), file=entry.GetFileSpec().GetFilename(),
                                 line=entry.GetLine()))
            parents[key] = dict(name=resolved, address=key, instructions=rows)
        functions[name] = list(parents.values())
    assert not target.GetProcess().IsValid(), 'static inventory launched an inferior'
    (OUT / 'capabilities.json').write_text(json.dumps(dict(layouts=layouts, functions=functions,
        inferior_launched=False, root_capture_ready=False), indent=2) + '\n')


if __name__ == '__lldb__':
    import lldb
    inspect(lldb.debugger)
elif __name__ == '__main__':
    OUT.mkdir(exist_ok=True)
    if sys.argv[1] == 'prepare':
        prepare()
    else:
        assert sys.argv[1] == 'seal' and (OUT / 'capabilities.json').is_file()
        files = sorted(OUT.iterdir())
        assert len(files) <= 24 and sum(p.stat().st_size for p in files) <= 32 * 1024**2
        assert all(stat.S_ISREG(p.lstat().st_mode) for p in files)
        (OUT / 'manifest.json').write_text(json.dumps({p.name: dict(bytes=p.stat().st_size,
            sha256=sha(p)) for p in files}, indent=2) + '\n')
