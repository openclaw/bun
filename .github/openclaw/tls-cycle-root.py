"""Join one original checkpoint's physical observations to its later heap graph."""
import difflib
import hashlib
import json
import os
from pathlib import Path
import re
import runpy
import shlex
import struct
import subprocess
import sys
import time
import traceback
from xml.etree import ElementTree

OUT = Path('tls-cycle-root')
SOURCE = Path('source')
ROOT = Path(os.environ['RUNNER_TEMP']) / 'tls-darwin-input'
FIXTURE = 'test/js/bun/net/socket-retention.test.ts'
CASE = 'TLS Duplex cycles collect after startup while a retained origin keeps its wrapper alive'
SOURCE_SHA = '510fef558b464c58de1209298f638fa476d03eef'
FIXTURE_SHA = 'd4c04a72b89bc7d33c292a16a57c38f5da540815dc2e141adfd58c1bd9973af2'
PROFILE_SHA = '52f2048920d8b31ef4471e121cc06ad7b4828761a2c3278349f66ed9b4acaf2b'
DSYM_SHA = '45aa427a18e5f97dda7a9fb23641ee066ecc5084de26d121b54530f62c41b0c6'
UUID = '4c4c4432-5555-3144-a125-d2b0a4297913'
EXPECTED = dict(retainedAlive=True, droppedCollected=False, releasedCollected=True)


def sha(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def write(name, value):
    (OUT / name).write_text(json.dumps(value, indent=2) + '\n')


def environment():
    return dict(PATH=os.environ['PATH'], HOME=str(ROOT / 'empty-home'),
                TMPDIR=str(ROOT / 'child-tmp'), CI='true', LANG='en_US.UTF-8')


def run(args, name, **kwargs):
    result = subprocess.run(args, stdin=subprocess.DEVNULL, capture_output=True, timeout=120,
                            cwd=SOURCE, env=environment(), **kwargs)
    assert len(result.stdout) + len(result.stderr) <= 4 * 1024**2
    (OUT / (name + '.stdout')).write_bytes(result.stdout)
    (OUT / (name + '.stderr')).write_bytes(result.stderr)
    return result


def prepare():
    assert os.uname().sysname == 'Darwin' and os.uname().machine == 'x86_64'
    assert not any(os.environ.get(k) for k in ('GH_TOKEN', 'GITHUB_TOKEN', 'NODE_OPTIONS', 'BUN_OPTIONS'))
    library = runpy.run_path(str(Path(__file__).with_name('tls-darwin-capability.py')))
    library['prepare']()
    write('inputs.json', json.loads(Path('tls-darwin-proof/inputs.json').read_text()))
    assert sha(ROOT / 'bun-profile') == PROFILE_SHA and sha(ROOT / 'bun-profile.dSYM') == DSYM_SHA
    exe = (ROOT / 'bun-profile').resolve()
    exe.chmod(0o700)
    for name in ('empty-home', 'child-tmp'):
        (ROOT / name).mkdir()
    identity = run([str(exe), '-e', 'console.log(JSON.stringify({revision:Bun.revision,webkit:process.versions.webkit,platform:process.platform,arch:process.arch}))'], 'identity')
    assert identity.returncode == 0 and not identity.stderr
    assert json.loads(identity.stdout) == dict(revision=SOURCE_SHA,
        webkit='b82bc917e99110b61c3a21202d6def7457aa194c', platform='darwin', arch='x64')
    assert subprocess.check_output(['git', '-C', str(SOURCE), 'rev-parse', 'HEAD'], text=True).strip() == SOURCE_SHA
    assert not subprocess.check_output(['git', '-C', str(SOURCE), 'diff', '--name-only', 'HEAD'], text=True)
    fixture = SOURCE / FIXTURE
    original = fixture.read_bytes()
    assert hashlib.sha256(original).hexdigest() == FIXTURE_SHA
    receipt = dict(source=SOURCE_SHA, fixture_sha256=FIXTURE_SHA, profile_sha256=PROFILE_SHA,
        dsym_sha256=DSYM_SHA, uuid=UUID, scanner_cause_proven=False, retaining_writer_proven=False,
        claim='original GC32 observations joined to a later snapshot GC; profile is not the production binary',
        observer_effects=['profile executable', 'outgoing object tags', 'diagnostic imports',
                          'snapshot performs an additional full GC', 'debugger stops', 'circular debugger logging'], runs=[])
    try:
        for name, contents in [('baseline', original), ('materialize', None)]:
            report = (OUT / (name + '.xml')).resolve()
            if contents is None:
                text = original.decode()
                start = text.index('test(' + json.dumps(CASE))
                begin = text.index('      `', start)
                end = text.index('      `,', begin + 7) + 6
                child = (OUT / 'original-child.js').resolve()
                prefix = '      ((value) => { require("node:fs").writeFileSync(' + json.dumps(str(child)) + ', value); return value; })(`'
                contents = (text[:begin] + prefix + text[begin + 7:end] + '`),' + text[end + 2:]).encode()
                (OUT / 'materialize.patch').write_text(''.join(difflib.unified_diff(
                    original.decode().splitlines(True), contents.decode().splitlines(True),
                    fromfile=FIXTURE, tofile=FIXTURE)))
            fixture.write_bytes(contents)
            result = run([str(exe), 'test', FIXTURE, '--test-name-pattern', '^' + re.escape(CASE) + '$',
                          '--reporter=junit', '--reporter-outfile=' + str(report)], name)
            doc = ElementTree.parse(report).getroot()
            selected = [c for c in doc.iter('testcase') if c.get('name') == CASE]
            assert len(selected) == 1 and not list(doc.iter('error'))
            case = selected[0]
            assert case.get('file') == FIXTURE and case.find('skipped') is None
            assert all(c.find('skipped') is not None and c.find('failure') is None
                       for c in doc.iter('testcase') if c is not case)
            failures = case.findall('failure')
            assert result.returncode == 1 and len(failures) == 1
            match = re.search(r'Received: "(\{[^\n]+\})"', failures[0].get('message', ''))
            assert match and json.loads(match[1]) == EXPECTED
            receipt['runs'].append(dict(arm=name, exit_code=1, received=EXPECTED))
        child = (OUT / 'original-child.js').read_text()
        template = original.decode()[begin + 7:end]
        before, after = template.split('${JSON.stringify(tlsCert)}')
        assert child.startswith(before) and child.endswith(after)
        cert = json.loads(child[len(before):len(child) - len(after)])
        harness = (SOURCE / 'test/harness.ts').read_text()
        cert_source = harness.split('export const tls = Object.freeze({', 1)[1].split('\n});', 1)[0]
        pairs = re.findall(r'^  (\w+): ("(?:[^"\\]|\\.)*"),?$', cert_source, re.M)
        assert dict((k, json.loads(v)) for k, v in pairs) == cert and set(cert) == {'cert', 'key'}
        preload = '        const tls = require("node:tls");'
        before_return = '          return { weak: new WeakRef(client._handle), origin: retain ? clientSide : null };'
        checkpoint = '        for (let i = 0; i < 30; i++) { await turn(); Bun.gc(true); }'
        tags = '''          Object.defineProperty(clientSide, retain ? "__tls_cycle_control_origin" : "__tls_cycle_dropped_origin", { value: Object.create(null) });
          Object.defineProperty(client._handle, retain ? "__tls_cycle_control_handle" : "__tls_cycle_dropped_handle", { value: Object.create(null) });
'''
        assert child.count(preload) == child.count(before_return) == 1 and child.count(checkpoint) == 2
        tagged = child.replace(preload, '        const { generateHeapSnapshotForDebugging } = require("bun:jsc");\n        const { writeFileSync } = require("node:fs");\n' + preload)
        tagged = tagged.replace(before_return, tags + before_return)
        for name, code in [('direct-baseline', child), ('tagged-control', tagged)]:
            result = run([str(exe), '-e', code], name)
            assert result.returncode == 0 and json.loads(result.stdout) == EXPECTED
            receipt['runs'].append(dict(arm=name, exit_code=0, received=EXPECTED))
        snapshot = (OUT / 'snapshot.json').resolve()
        insertion = '\n        const snapshotText = JSON.stringify(generateHeapSnapshotForDebugging());\n        if (Buffer.byteLength(snapshotText) > 24 * 1024**2) throw new Error("snapshot too large");\n        writeFileSync(' + json.dumps(str(snapshot)) + ', snapshotText);'
        captured = tagged.replace(checkpoint, checkpoint + insertion, 1)
        assert captured.count('Bun.gc(true)') == child.count('Bun.gc(true)')
        (OUT / 'debugger-child.js').write_text(captured)
        receipt['original_child_sha256'] = hashlib.sha256(child.encode()).hexdigest()
        receipt['debugger_child_sha256'] = hashlib.sha256(captured.encode()).hexdigest()
    finally:
        fixture.write_bytes(original)
        assert sha(fixture) == FIXTURE_SHA
        assert not subprocess.check_output(['git', '-C', str(SOURCE), 'diff', '--name-only', 'HEAD'], text=True)
        receipt['source_restored'] = True
        write('receipt.json', receipt)


def inspect(debugger):
    import lldb
    debugger.SetAsync(False)
    command = lldb.SBCommandReturnObject()
    debugger.GetCommandInterpreter().HandleCommand('settings set target.load-script-from-symbol-file false', command)
    assert command.Succeeded()
    target = debugger.CreateTarget(str((ROOT / 'bun-profile').resolve()))
    assert target.IsValid() and target.GetTriple().startswith('x86_64-apple-')
    debugger.GetCommandInterpreter().HandleCommand('target symbols add ' + shlex.quote(str((ROOT / 'bun-profile.dSYM').resolve())), command)
    assert command.Succeeded(), command.GetError()
    module = target.FindModule(target.GetExecutable())
    assert module.GetUUIDString().lower() == UUID
    report = dict(gc_count=0, gc32_completed=False, spans=[], marks=[], thread_states=[],
                  scanner_cause_proven=False, retaining_writer_proven=False, inferior_launched=False)
    process = None
    pending_spans, pending_marks = {}, {}
    raw = bytearray()
    active = False
    points = {}
    dynamic = {}
    watch = None

    def debugger_command(text):
        result = lldb.SBCommandReturnObject()
        debugger.GetCommandInterpreter().HandleCommand(text, result)
        output, error = result.GetOutput() or '', result.GetError() or ''
        assert len(output.encode()) + len(error.encode()) <= 4 * 1024**2, text
        return dict(command=text, succeeded=result.Succeeded(), output=output, error=error)

    def debugger_state():
        return [debugger_command(text) for text in
                ('thread plan list -i -v all', 'breakpoint list -v', 'watchpoint list -v')]

    def save():
        write('capture.json', report)
        (OUT / 'spans.bin').write_bytes(raw)

    def memory(address, size):
        assert address > 0 and 0 <= size <= 4 * 1024**2
        if size == 0:
            return b''
        error = lldb.SBError()
        data = process.ReadMemory(address, size, error)
        assert error.Success() and len(data) == size, (hex(address), size, str(error))
        return data

    def word(address):
        return struct.unpack('<Q', memory(address, 8))[0]

    def reg(frame, name):
        value = frame.FindRegister(name)
        assert value.IsValid()
        return value.GetValueAsUnsigned()

    def frames(thread):
        assert thread.GetNumFrames() <= 256
        return [dict(pc=f.GetPC(), sp=f.GetSP(), fp=f.GetFP(), function=f.GetDisplayFunctionName(),
                     file=f.GetLineEntry().GetFileSpec().GetFilename(), line=f.GetLineEntry().GetLine())
                for f in [thread.GetFrameAtIndex(i) for i in range(thread.GetNumFrames())]]

    def instructions(rows, begin=0, end=None):
        result = []
        for i in range(begin, rows.GetSize() if end is None else end):
            insn = rows.GetInstructionAtIndex(i)
            address = insn.GetAddress()
            entry = address.GetLineEntry()
            data = bytes(insn.GetData(target).uint8s)
            assert len(data) == insn.GetByteSize()
            result.append(dict(address=address.GetFileAddress(), bytes=data.hex(),
                mnemonic=insn.GetMnemonic(target), operands=insn.GetOperands(target),
                comment=insn.GetComment(target), file=entry.GetFileSpec().GetFilename(), line=entry.GetLine()))
        return result

    module_rows = target.ReadInstructions(target.ResolveFileAddress(0x103cf8280), 244)
    assert module_rows.GetSize() == 244
    report['module_entry_instructions'] = instructions(module_rows)
    call = next(r for r in report['module_entry_instructions'] if r['address'] == 0x103cf8527)
    assert call['bytes'] == 'e8dc8c5d01' and call['mnemonic'] == 'callq'

    def module_frame(thread):
        selected = [f for f in frames(thread) if f['file'] == 'Interpreter.cpp' and f['line'] == 1839
                    and target.ResolveLoadAddress(f['pc']).GetFileAddress() == 0x103cf852c]
        assert len(selected) == 1 and selected[0]['fp'] - selected[0]['sp'] == 224
        return selected[0]

    def point(name, address, mnemonic, operands=None):
        address = target.ResolveFileAddress(address) if isinstance(address, int) else address
        instructions = target.ReadInstructions(address, 1)
        assert instructions.GetSize() == 1
        instruction = instructions.GetInstructionAtIndex(0)
        assert instruction.GetMnemonic(target) == mnemonic, (name, instruction.GetMnemonic(target))
        if operands is not None:
            assert instruction.GetOperands(target) == operands
        bp = target.BreakpointCreateBySBAddress(address)
        assert bp.GetNumLocations() == 1
        points[bp.GetID()] = name
        return bp

    gc = point('gc', 0x10055a780, 'pushq', '%rbp')
    report['physical_points'] = {str(k): v for k, v in points.items()}
    launch = lldb.SBLaunchInfo(['-e', (OUT / 'debugger-child.js').read_text()])
    launch.SetWorkingDirectory(str(SOURCE.resolve()))
    launch.SetEnvironmentEntries([k + '=' + v for k, v in environment().items()], False)
    launch.SetLaunchFlags(0)
    report['launch_flags'] = launch.GetLaunchFlags()
    assert launch.AddOpenFileAction(0, '/dev/null', True, False)
    assert launch.AddOpenFileAction(1, str((OUT / 'debugger.stdout').resolve()), False, True)
    assert launch.AddOpenFileAction(2, str((OUT / 'debugger.stderr').resolve()), False, True)
    launch.SetDetachOnError(False)
    error = lldb.SBError()
    try:
        report['log_setup'] = [debugger_command(text) for text in
            ('log enable -h circular -b 4096 -s -T -p lldb process thread step break watch',
             'log enable -h circular -b 4096 -s -T -p gdb-remote packets')]
        assert all(row['succeeded'] for row in report['log_setup']), 'circular debugger logs unavailable'
        process = target.Launch(launch, error)
        assert error.Success() and process.IsValid(), str(error)
        report['inferior_launched'] = True
        report['pid'] = process.GetProcessID()
        deadline, stops, previous_stop = time.monotonic() + 240, 0, 0
        while process.GetState() not in (lldb.eStateExited, lldb.eStateCrashed, lldb.eStateDetached):
            assert time.monotonic() < deadline, 'debugger capture deadline'
            assert process.GetState() == lldb.eStateStopped, 'synchronous debugger did not stop'
            stop_id = process.GetStopID()
            assert stop_id > previous_stop, 'duplicate debugger stop would corrupt GC numbering'
            previous_stop = stop_id
            stops += 1
            assert stops <= 30000
            report['last_stop'] = dict(id=process.GetStopID(), threads=[dict(
                thread=t.GetThreadID(), reason=t.GetStopReason(),
                data=[t.GetStopReasonDataAtIndex(i) for i in range(min(t.GetStopReasonDataCount(), 32))],
                pc=t.GetFrameAtIndex(0).GetPC(),
                sp=t.GetFrameAtIndex(0).GetSP(), fp=t.GetFrameAtIndex(0).GetFP(),
                ) for t in process])
            unexpected = [t.GetThreadID() for t in process if t.GetStopReason() not in
                          (lldb.eStopReasonInvalid, lldb.eStopReasonNone,
                           lldb.eStopReasonWatchpoint, lldb.eStopReasonBreakpoint)]
            if unexpected:
                if watch is not None:
                    report['last_stop']['watched_value'] = word(report['word_watch']['address'])
                raise AssertionError('unexpected debugger stop on threads ' + str(unexpected))
            handled = False
            for thread in process:
                if thread.GetStopReason() == lldb.eStopReasonWatchpoint:
                    assert watch is not None and watch.IsEnabled()
                    assert thread.GetStopReasonDataCount() == 1
                    assert thread.GetStopReasonDataAtIndex(0) == watch.GetID()
                    row = report['word_watch']
                    assert len(row['writes']) < 12000, 'value-change observation limit'
                    frame = thread.GetFrameAtIndex(0)
                    pc = frame.GetPC()
                    value = word(row['address'])
                    event = dict(thread=thread.GetThreadID(), gc_count=report['gc_count'],
                        before=row['last_value'], after=value, stop_pc=pc,
                        stop_file_pc=target.ResolveLoadAddress(pc).GetFileAddress(),
                        registers={name: reg(frame, name) for name in
                            ('rax', 'rbx', 'rcx', 'rdx', 'rsi', 'rdi', 'rbp', 'rsp', 'r8', 'r9', 'r10', 'r11', 'r12', 'r13', 'r14', 'r15', 'rflags')})
                    row['writes'].append(event)
                    row['last_value'] = value
                    handled = True
                    continue
                if thread.GetStopReason() != lldb.eStopReasonBreakpoint:
                    continue
                frame, tid = thread.GetFrameAtIndex(0), thread.GetThreadID()
                assert thread.GetStopReasonDataCount() > 0 and thread.GetStopReasonDataCount() % 2 == 0
                for i in range(0, thread.GetStopReasonDataCount(), 2):
                    ident = thread.GetStopReasonDataAtIndex(i)
                    name = points[ident]
                    handled = True
                    if name == 'gc':
                        report['gc_count'] += 1
                        if report['gc_count'] == 1:
                            owner = module_frame(thread)
                            address = owner['sp']
                            error = lldb.SBError()
                            options = lldb.SBWatchpointOptions()
                            options.SetWatchpointTypeRead(False)
                            options.SetWatchpointTypeWrite(lldb.eWatchpointWriteTypeOnModify)
                            assert options.GetWatchpointTypeWrite() == lldb.eWatchpointWriteTypeOnModify
                            watch = target.WatchpointCreateByAddress(address, 8, options, error)
                            assert error.Success() and watch.IsValid(), str(error)
                            assert watch.GetWatchAddress() == address and watch.GetWatchSize() == 8
                            initial = word(address)
                            report['word_watch'] = dict(address=address, initial_value=initial, last_value=initial,
                                initial_owner=owner, writes=[], write_mode='on_modify',
                                context='all value changes retain PCs and post-store general registers; decoding and writer-stack capture are separate',
                                claim='value-changing stores only; equal-value stores may be unreported; one address across frame/storage reuse')
                            report['watch_admission'] = debugger_state()
                            assert all(row['succeeded'] for row in report['watch_admission'])
                        if report['gc_count'] == 32:
                            owner = module_frame(thread)
                            report['word_watch']['gc32_owner'] = owner
                            assert owner['sp'] == report['word_watch']['address'], 'GC32 uses a different stack slot'
                            assert word(owner['sp']) == report['word_watch']['last_value']
                            active = True
                            report['gc32_entry_frames'] = frames(thread)
                            ret = target.ResolveLoadAddress(word(frame.GetSP()))
                            bp = target.BreakpointCreateBySBAddress(ret)
                            bp.SetThreadID(tid)
                            assert bp.GetNumLocations() == 1
                            points[bp.GetID()] = 'gc-return'
                            # LLDB1700 stepped through disabled sites before GC32; create them only when needed.
                            scans = [point('span', a, 'pushq', '%rbp') for a in (0x103bcf0a0, 0x103bcf1d0)]
                            gather = point('gather', 0x103c368c0, 'pushq', '%rbp')
                            pre = point('mark-before', 0x103c4b37d, 'lock')
                            post = point('mark-after', 0x103c4b384, 'jb')
                            report['physical_points'] = {str(k): v for k, v in points.items()}
                    elif name == 'gc-return':
                        assert active and not pending_spans and not pending_marks
                        report['gc32_completed'] = True
                        active = False
                        for b in scans + [gather, pre, post, gc]:
                            assert target.BreakpointDelete(b.GetID())
                        assert target.BreakpointDelete(ident)
                        report['word_watch']['gc32_return_value'] = word(report['word_watch']['address'])
                        assert target.DeleteWatchpoint(watch.GetID())
                    elif name == 'gather':
                        assert active
                        state = reg(frame, 'r8')
                        row = dict(thread=tid, state=state)
                        if state:
                            origin, top, registers = struct.unpack('<QQQ', memory(state, 24))
                            row.update(stack_origin=origin, stack_top=top, registers=registers,
                                       register_words=list(struct.unpack('<6Q', memory(registers, 48))))
                        report['thread_states'].append(row)
                    elif name == 'span':
                        assert active and tid not in pending_spans and len(report['spans']) < 64
                        roots, begin, end = (reg(frame, r) for r in ('rdi', 'rsi', 'rdx'))
                        begin, end = sorted((begin, end))
                        assert end - begin <= 1024**2 and len(raw) + end - begin <= 4 * 1024**2
                        assert (end - begin) % 8 == 0
                        # Exact x64 type witness 41247026590: m_roots at 0, m_size at 8.
                        row = dict(thread=tid, begin=begin, end=end, raw_offset=len(raw),
                                   roots=roots, count_before=word(roots + 8),
                                   threads=[dict(id=t.GetThreadID(), frames=frames(t)) for t in process])
                        raw.extend(memory(begin, end - begin))
                        ret = target.ResolveLoadAddress(word(frame.GetSP()))
                        bp = target.BreakpointCreateBySBAddress(ret)
                        bp.SetThreadID(tid)
                        assert bp.GetNumLocations() == 1
                        points[bp.GetID()] = 'span-return'
                        dynamic[bp.GetID()] = row
                        pending_spans[tid] = bp.GetID()
                    elif name == 'span-return':
                        assert active and pending_spans.pop(tid) == ident
                        row = dynamic.pop(ident)
                        count = word(row['roots'] + 8)
                        assert row['count_before'] <= count <= 100000
                        address = word(row['roots']) + row['count_before'] * 8
                        data = memory(address, (count - row['count_before']) * 8)
                        row['accepted_roots'] = list(struct.unpack('<' + 'Q' * (len(data) // 8), data))
                        report['spans'].append(row)
                        target.BreakpointDelete(ident)
                    elif name == 'mark-before':
                        assert active and tid not in pending_marks and len(report['marks']) < 12000
                        cell, block, index, bit = (reg(frame, r) for r in ('rsi', 'rbx', 'rcx', 'rax'))
                        assert block == cell & ~0x3fff and bit < 64
                        address = block + index + 0x28
                        pending_marks[tid] = dict(thread=tid, cell=cell, bitmap_word=address, bit=bit,
                            before=word(address), caller=thread.GetFrameAtIndex(1).GetPC())
                    elif name == 'mark-after':
                        assert active
                        row = pending_marks.pop(tid)
                        assert row['cell'] == reg(frame, 'rsi')
                        row['after'] = word(row['bitmap_word'])
                        row['carry'] = reg(frame, 'rflags') & 1
                        row['new_mark'] = not bool(row['carry'])
                        assert row['after'] & (1 << row['bit'])
                        if row['new_mark']:
                            assert not row['before'] & (1 << row['bit'])
                        report['marks'].append(row)
            if not handled and watch is not None:
                report['last_stop']['watched_value'] = word(report['word_watch']['address'])
            assert handled, 'unexpected debugger stop'
            assert process.Continue().Success()
        report['exit_status'] = process.GetExitStatus()
        report['terminal_state'] = lldb.SBDebugger.StateAsCString(process.GetState())
        assert report['gc32_completed'] and report['exit_status'] == 0
        assert json.loads((OUT / 'debugger.stdout').read_text()) == EXPECTED
        report['original_failure_preserved'] = True
    except BaseException as exc:
        report['error'] = dict(type=type(exc).__name__, message=str(exc)[:2000],
            frames=[dict(file=Path(f.filename).name, line=f.lineno, function=f.name)
                    for f in traceback.extract_tb(exc.__traceback__)])
        try:
            # Dump history before inspection commands overwrite the circular packet buffer.
            report['failure_logs'] = [debugger_command('log dump ' + channel)
                                      for channel in ('lldb', 'gdb-remote')]
            report['failure_debugger_state'] = debugger_state()
            if process is not None and process.IsValid() and process.GetState() == lldb.eStateStopped:
                report['failure_threads'] = [dict(thread=t.GetThreadID(), description=t.GetStopDescription(512), frames=frames(t),
                    stop_instructions=instructions(target.ReadInstructions(t.GetFrameAtIndex(0).GetPCAddress(), 4)))
                    for t in process if t.GetStopReason() not in (lldb.eStopReasonInvalid, lldb.eStopReasonNone)]
        except BaseException as diagnostic_error:
            report['failure_diagnostics_error'] = dict(type=type(diagnostic_error).__name__,
                                                       message=str(diagnostic_error)[:2000])
        raise
    finally:
        if process is not None and process.IsValid() and process.GetState() not in (lldb.eStateExited, lldb.eStateDetached):
            report['task_process_killed'] = process.Kill().Success()
        save()


def seal():
    try:
        receipt = json.loads((OUT / 'receipt.json').read_text())
        capture = json.loads((OUT / 'capture.json').read_text())
        snapshot = OUT / 'snapshot.json'
        assert snapshot.is_file() and snapshot.stat().st_size <= 24 * 1024**2
        library = runpy.run_path(str(Path(__file__).with_name('tls-cycle-heap.py')))
        graph = library['project_graph'](json.loads(snapshot.read_text()))
        write('graph.json', graph)
        target = graph['targets']['__tls_cycle_dropped_handle']
        assert target['present'] and not target['root_paths'] and target['synthetic_root_path'] is None
        external = {edge['source'] for edge in target['scc_external_incoming']}
        assert len(external) == 1, 'external owner changed; inspect raw evidence'
        raw_graph = json.loads(snapshot.read_text())
        nodes = raw_graph['nodes']
        owner = next(nodes[i:i + 7] for i in range(0, len(nodes), 7) if nodes[i] in external)
        assert raw_graph['nodeClassNames'][owner[2]] == 'JSLexicalEnvironment'
        cell = int(owner[5], 16)
        assert cell > 0 and cell % 16 == 0
        edges = raw_graph['edges']
        assert all(edges[i + 1] != owner[0] for i in range(0, len(edges), 4))
        assert owner[0] not in raw_graph['roots'][::3]
        spans = (OUT / 'spans.bin').read_bytes()
        matches = []
        for span in capture['spans']:
            data = spans[span['raw_offset']:span['raw_offset'] + span['end'] - span['begin']]
            for offset in range(0, len(data), 8):
                if struct.unpack_from('<Q', data, offset)[0] != cell:
                    continue
                address = span['begin'] + offset
                owners = []
                for thread in span['threads']:
                    for frame, caller in zip(thread['frames'], thread['frames'][1:]):
                        if 0 < frame['sp'] <= address < caller['sp'] < 2**64 - 1:
                            owners.append(dict(thread=thread['id'], frame=frame, caller=caller))
                matches.append(dict(address=address, span_begin=span['begin'], span_end=span['end'],
                    accepted=cell in span['accepted_roots'], physical_frames=owners))
        marks = [m for m in capture['marks'] if m['cell'] == cell]
        watched = capture['word_watch']
        owner_writes = [row for row in watched['writes'] if row['after'] == cell and row['before'] != cell]
        watch_join = dict(address=watched['address'], initial_value_matches=watched['initial_value'] == cell,
            gc32_return_value_matches=watched['gc32_return_value'] == cell,
            accepted_root_matches=any(m['accepted'] and m['address'] == watched['address'] for m in matches),
            observed_writes_of_owner=owner_writes,
            claim='observed value-changing stores only; equal-value/final writers and intended lifetime need separate proof before a repair')
        write('join.json', dict(owner_id=owner[0], owner_cell=owner[5], gc32_word_matches=matches,
            gc32_mark_events=marks, word_watch=watch_join, scanner_cause_proven=False, retaining_writer_proven=False,
            claim='physical observations; identify the frame writer before proposing a runtime repair'))
        receipt.update(snapshot_sha256=sha(snapshot), gc32_completed=capture['gc32_completed'],
                       word_matches=len(matches), new_marks=sum(m['new_mark'] for m in marks),
                       original_failure_preserved=capture.get('original_failure_preserved', False))
        write('receipt.json', receipt)
        assert capture['gc32_completed'] and capture['original_failure_preserved']
        assert any(m['accepted'] for m in matches) and any(m['new_mark'] for m in marks), 'root not established; no causal claim'
        assert watch_join['accepted_root_matches'] and watch_join['gc32_return_value_matches']
        assert owner_writes, 'owner value was not observed changing; earlier or equal-value writer remains unknown'
    finally:
        files = sorted(OUT.iterdir())
        assert len(files) <= 32 and all(p.is_file() and not p.is_symlink() for p in files)
        assert sum(p.stat().st_size for p in files) <= 32 * 1024**2
        write('manifest.json', {p.name: dict(bytes=p.stat().st_size, sha256=sha(p)) for p in files
                                if p.name != 'manifest.json'})


if __name__ == '__lldb__':
    import lldb
    inspect(lldb.debugger)
elif __name__ == '__main__':
    {'prepare': prepare, 'seal': seal}[sys.argv[1]]()
