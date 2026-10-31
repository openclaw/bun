"""Trace the frozen destroyed-completion owner with the saved shipping-debug bytes."""
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import signal
import stat
import subprocess
import sys
import tarfile
import time
import zipfile
from xml.etree import ElementTree

ROOT = Path('/work')
OUT = ROOT / 'capture'
SOURCE = ROOT / 'source'
BUILD = SOURCE / 'build/tls-arm64-shipping-debug'
BINARY = BUILD / 'bun'
PROFILE = BUILD / 'bun-profile'
FIXTURE = 'test/js/bun/net/socket-retention.test.ts'
CASE = 'a TLS Duplex completion retains its owner and is inert after destroy'
UUID = '487687ca47a8a631b87f701a12a351b33dab611a'
BUN = '454a78a4d3b0202ecdbedf7dd051fc84ffc59e9e'
FIXTURE_SHA = 'd4c04a72b89bc7d33c292a16a57c38f5da540815dc2e141adfd58c1bd9973af2'
ARCHIVE_SHA = 'a71acab37ebb674baae960ebe04d554f44f7e69284450855cf90f1d783180f0e'
BINARIES = {
    'bun': '6c1276f536bd52c19aee39ab3eea81b6ddf8c3e0b4e92aa879720a38c4f38cd3',
    'bun-profile': '2be841e8d061ea1a9a7a971a215ca9f1671088717881dded961360ad012d949a',
}


def sha(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def write(name, value):
    (OUT / name).write_text(json.dumps(value, indent=2) + '\n')


def admit_zip():
    root = Path.cwd()
    run = json.loads((root / 'producer-run.json').read_text())
    artifact = json.loads((root / 'producer-artifact.json').read_text())
    assert run['id'] == 41212340227 and run['conclusion'] == 'failure'
    assert run['head_sha'] == '0a1544a4b4c6a4bdfbda96983e0734fc66e0320f'
    assert artifact['id'] == 13048432420 and not artifact['expired']
    assert artifact['name'] == 'tls-linux-arm64-shipping-debug'
    assert artifact['workflow_run']['id'] == run['id']
    assert artifact['workflow_run']['head_sha'] == run['head_sha']
    expected = '073a481c6576f8bf640be3e4da37aa1eb869ee037bdebd6f3eebfbdc6b01cb43'
    assert artifact['digest'] == 'sha256:' + expected
    assert (root / 'producer.zip').stat().st_size == artifact['size_in_bytes'] == 717328810
    assert sha(root / 'producer.zip') == expected
    with zipfile.ZipFile(root / 'producer.zip') as archive:
        entries = archive.infolist()
        assert len(entries) == 2 and sum(e.file_size for e in entries) < 1024**3
        assert {e.filename for e in entries} == {'matched-shipping-debug.tar.zst', 'shipping-debug-SHA256SUMS'}
        dest = root / 'producer'
        dest.mkdir()
        for entry in entries:
            assert not entry.is_dir() and not stat.S_ISLNK(entry.external_attr >> 16)
            with (dest / entry.filename).open('xb') as output, archive.open(entry) as content:
                shutil.copyfileobj(content, output)
    assert sha(dest / 'matched-shipping-debug.tar.zst') == ARCHIVE_SHA
    assert (dest / 'shipping-debug-SHA256SUMS').read_text() == ARCHIVE_SHA + '  matched-shipping-debug.tar.zst\n'


def restore():
    assert os.uname().machine == 'aarch64'
    assert subprocess.check_output(['git', '-c', 'safe.directory=' + str(SOURCE), '-C', str(SOURCE),
                                    'rev-parse', 'HEAD'], text=True).strip() == BUN
    assert sha(SOURCE / FIXTURE) == FIXTURE_SHA
    archive = ROOT / 'producer/matched-shipping-debug.tar.zst'
    assert sha(archive) == ARCHIVE_SHA
    entries = {}
    manifest = None
    total = 0
    child = subprocess.Popen(['zstd', '-d', '-c', str(archive)], stdout=subprocess.PIPE)
    try:
        with tarfile.open(fileobj=child.stdout, mode='r|') as stream:
            for member in stream:
                name = PurePosixPath(member.name)
                assert member.isfile() and not name.is_absolute() and '..' not in name.parts
                assert str(name) not in entries and len(entries) < 64
                total += member.size
                assert total <= 8 * 1024**3
                if str(name).startswith('diagnostics/'):
                    target = ROOT / 'producer-evidence' / str(name)
                else:
                    assert str(name) in {'source/build/tls-arm64-shipping-debug/' + n for n in BINARIES}
                    target = ROOT / str(name)
                target.parent.mkdir(parents=True, exist_ok=True)
                with target.open('xb') as output, stream.extractfile(member) as content:
                    shutil.copyfileobj(content, output)
                target.chmod(0o755 if name.name in BINARIES else 0o644)
                entries[str(name)] = {'bytes': target.stat().st_size, 'sha256': sha(target)}
                if str(name) == 'diagnostics/archive-manifest.json':
                    manifest = json.loads(target.read_text())
        assert child.wait(timeout=30) == 0
    finally:
        child.stdout.close()
        if child.poll() is None:
            child.kill()
            child.wait()
    assert len(entries) == 55 and len(manifest) == 54
    del entries['diagnostics/archive-manifest.json']
    assert entries == manifest
    assert all(sha(BUILD / name) == digest for name, digest in BINARIES.items())
    assert OUT.is_dir() and not any(OUT.iterdir())
    write('inputs.json', {'producer_run': 41212340227, 'artifact': 13048432420,
                         'archive_sha256': ARCHIVE_SHA, 'manifest_entries': len(manifest),
                         'bun': BUN, 'fixture_sha256': FIXTURE_SHA, 'binaries': BINARIES,
                         'claim': 'diagnostic child replay; no runtime fix or retainer classification'})


def admit_failure(cases, producer):
    selected = [case for case in cases if case.get('name') == CASE]
    expected = [case for case in producer if case.get('name') == CASE]
    assert len(selected) == len(expected) == 1
    assert all(case.find('skipped') is not None and case.find('failure') is None and
               case.find('error') is None for case in cases if case is not selected[0])
    actual, baseline = selected[0], expected[0]
    assert actual.get('file') == baseline.get('file') == FIXTURE
    assert actual.get('line') == baseline.get('line')
    assert actual.find('skipped') is None and actual.find('error') is None
    failures, baseline_failures = actual.findall('failure'), baseline.findall('failure')
    assert len(failures) == len(baseline_failures) == 1
    assert failures[0].get('type') == baseline_failures[0].get('type') == 'AssertionError'
    normalize = lambda text: text.replace('\r\n', '\n').strip()
    assert normalize(failures[0].get('message', '')) == normalize(baseline_failures[0].get('message', ''))


def debugger_stage():
    import lldb
    debugger = lldb.debugger
    debugger.SetAsync(False)
    target = debugger.GetSelectedTarget()
    module = target.FindModule(target.GetExecutable())
    assert re.sub('[^0-9a-fA-F]', '', module.GetUUIDString() or '').lower() == UUID
    stage = os.environ['TLS_CAPTURE_STAGE']
    report = {'stage': stage, 'passed': False, 'events': [], 'entries': [], 'resolutions': {}, 'breakpoint_hits': {}}
    process = None
    entry_addresses = {}
    weak = []
    weak_creation = None
    owner = None
    returned = False
    gc_count = 0
    mark_watch = None
    mark_observation = None
    root_collections = []
    root_collection = None
    scan_returns = {}
    vm_roots_return = None

    def event(kind, **values):
        report['events'].append({'kind': kind, **values})
        write(stage + '.json', report)

    def entry(name, signature=None):
        contexts = module.FindFunctions(name, lldb.eFunctionNameTypeAny)
        assert contexts.GetSize() <= 64, name
        addresses = {}
        report['resolutions'][name] = []
        for i in range(contexts.GetSize()):
            context = contexts.GetContextAtIndex(i)
            function = context.GetFunction()
            resolved = function.GetName() if function.IsValid() else context.GetSymbol().GetName()
            address = function.GetStartAddress() if function.IsValid() else context.GetSymbol().GetStartAddress()
            report['resolutions'][name].append({'function': resolved, 'file_address': address.GetFileAddress()})
            # FindFunctions includes inline scopes whose GetFunction is the enclosing physical function.
            if not resolved or resolved.split('(', 1)[0].strip().removeprefix('::') != name:
                continue
            if signature is not None and resolved.removeprefix('::') != signature:
                continue
            if address.IsValid():
                addresses[address.GetFileAddress()] = address
        assert len(addresses) == 1, 'missing/ambiguous function entry: ' + name
        address = next(iter(addresses.values()))
        bp = target.BreakpointCreateBySBAddress(address)
        assert bp.GetNumLocations() == 1, name
        entry_addresses[bp.GetID()] = address
        report['entries'].append({'name': name, 'breakpoint': bp.GetID(),
                                  'file_address': address.GetFileAddress()})
        return bp, address

    def reg(frame, name):
        value = frame.FindRegister(name)
        assert value.IsValid() and value.GetError().Success(), name
        return value.GetValueAsUnsigned()

    def word(address, size=8):
        error = lldb.SBError()
        value = process.ReadUnsignedFromMemory(address, size, error)
        assert error.Success(), str(error)
        return value

    def text(address, limit=1024**2):
        error = lldb.SBError()
        value = process.ReadCStringFromMemory(address, limit, error)
        assert error.Success() and value is not None and len(value.encode()) < limit - 1
        return value

    def concrete_type(name):
        values = target.FindTypes(name)
        types = [values.GetTypeAtIndex(i).GetCanonicalType() for i in range(values.GetSize())]
        types = [t for t in types if t.IsTypeComplete() and t.GetNumberOfFields() > 0]
        assert types and len({t.GetByteSize() for t in types}) == 1, name
        return types[0]

    def typed(address, name):
        return target.CreateValueFromAddress(name, target.ResolveLoadAddress(address), concrete_type(name)).GetNonSyntheticValue()

    def field(value, name):
        value = value.GetNonSyntheticValue().GetChildMemberWithName(name, lldb.eNoDynamicValues)
        assert value.IsValid() and value.GetError().Success(), name
        return value.GetNonSyntheticValue()

    def number(value):
        error = lldb.SBError()
        result = value.GetValueAsUnsigned(error)
        assert error.Success(), str(error)
        return result

    def pointer(value, pointee, depth=0):
        assert depth <= 8
        value = value.GetNonSyntheticValue()
        t = value.GetType().GetCanonicalType()
        if t.IsPointerType() and t.GetPointeeType().GetCanonicalType().GetName() == pointee:
            return [number(value)]
        assert value.GetNumChildren() < 32
        result = []
        for i in range(value.GetNumChildren()):
            child = value.GetChildAtIndex(i, lldb.eNoDynamicValues, False)
            if not child.GetType().IsPointerType() or child.GetType().GetPointeeType().GetCanonicalType().GetName() == pointee:
                result += pointer(child, pointee, depth + 1)
        return result

    def precise_allocation(cell):
        assert target.GetAddressByteSize() == 8 and target.GetByteOrder() == lldb.eByteOrderLittle
        assert cell & 8, 'owner is not the observed precise-allocation kind'
        header = concrete_type('JSC::PreciseAllocation').GetByteSize()
        allocation = cell - ((header + 15) & ~15)
        return header, allocation

    def precise_marker(visitor, cell):
        # Use frozen HashTable metadata and DWARF field offsets, without inferior find/get calls.
        header, allocation = precise_allocation(cell)
        table_value = field(field(field(visitor, 'm_preciseAllocationMap'), 'm_impl'), 'm_table')
        table = number(table_value)
        if not table:
            return header, allocation, None
        capacity = word(table - 4, 4)
        bucket_type = table_value.GetType().GetCanonicalType().GetPointeeType().GetCanonicalType()
        stride = bucket_type.GetByteSize()
        members = {bucket_type.GetFieldAtIndex(i).GetName(): bucket_type.GetFieldAtIndex(i)
                   for i in range(bucket_type.GetNumberOfFields())}
        assert {'key', 'value'} <= members.keys()
        key = members['key']
        assert key.GetType().GetCanonicalType().IsPointerType() and key.GetType().GetByteSize() == 8
        offset = key.GetOffsetInBytes()
        assert 0 < capacity <= 2**20 and capacity & (capacity - 1) == 0
        assert 8 <= stride <= 256 and offset + 8 <= stride and capacity * stride <= 16 * 1024**2
        error = lldb.SBError()
        buckets = process.ReadMemory(table, capacity * stride, error)
        assert error.Success() and len(buckets) == capacity * stride
        matches = [i for i in range(capacity)
                   if int.from_bytes(buckets[i * stride + offset:i * stride + offset + 8], 'little') == allocation]
        assert len(matches) <= 1, 'actual precise allocation duplicated in verifier map'
        if not matches:
            return header, allocation, None
        bucket = target.CreateValueFromAddress('owner-marker-bucket',
                    target.ResolveLoadAddress(table + matches[0] * stride), bucket_type).GetNonSyntheticValue()
        data = pointer(field(bucket, 'value'), 'JSC::VerifierSlotVisitor::PreciseAllocationData')
        assert len(data) == 1 and data[0]
        record = typed(data[0], 'JSC::VerifierSlotVisitor::PreciseAllocationData')
        assert number(field(record, 'm_allocation')) == allocation
        return header, allocation, field(record, 'm_marker')

    def symbolize(pc, is_return=False):
        address = target.ResolveLoadAddress(pc - 1 if is_return else pc)
        function, symbol = address.GetFunction(), address.GetSymbol()
        name = function.GetName() if function.IsValid() else symbol.GetName() if symbol.IsValid() else None
        line = address.GetLineEntry()
        return {'pc': pc, 'function': name, 'file_address': address.GetFileAddress(),
                'source_file': line.GetFileSpec().GetFilename() if line.IsValid() else None,
                'line': line.GetLine() if line.IsValid() else None}

    def frame_pointer_snapshot(frame, thread):
        # Shipping keeps frame pointers but removes CFI tables; libc backtrace stored an empty marker stack.
        pc, lr, sp, fp = frame.GetPC(), reg(frame, 'x30'), reg(frame, 'sp'), reg(frame, 'x29')
        region = lldb.SBMemoryRegionInfo()
        assert process.GetMemoryRegionInfo(sp, region).Success() and region.IsReadable()
        ceiling = min(region.GetRegionEnd(), sp + 16 * 1024**2)
        # A watchpoint may stop after the store; x30 can be a nested call's return, not this frame's caller.
        frames = [symbolize(pc)]
        links = []
        current = fp
        for _ in range(128):
            if not current:
                termination = 'null-frame-pointer'
                break
            if current % 16 or not sp <= current or current + 16 > ceiling:
                termination = 'outside-readable-stack'
                break
            previous, saved_lr = word(current), word(current + 8)
            links.append({'fp': current, 'previous_fp': previous, 'saved_lr': saved_lr})
            if saved_lr:
                frames.append(symbolize(saved_lr, True))
            if previous and previous <= current:
                termination = 'non-increasing-frame-pointer'
                break
            current = previous
        else:
            termination = 'frame-limit'
        assert len(links) >= 2 and sum(bool(f['function']) for f in frames) >= 3, 'live frame-pointer path unavailable'
        return {'thread': thread.GetThreadID(), 'pc': pc, 'lr': lr, 'sp': sp, 'fp': fp,
                'links': links, 'frames': frames, 'termination': termination}

    def roots_snapshot(address):
        roots = typed(address, 'JSC::ConservativeRoots')
        count = number(field(roots, 'm_size'))
        capacity = number(field(roots, 'm_capacity'))
        data = number(field(roots, 'm_roots'))
        assert 0 <= count <= capacity <= 1024**2 and data
        error = lldb.SBError()
        raw = process.ReadMemory(data, count * 8, error) if count else b''
        assert not count or (error.Success() and len(raw) == count * 8)
        indices = [i for i in range(count) if int.from_bytes(raw[i * 8:i * 8 + 8], 'little') == owner['owner']]
        assert len(indices) <= 64, 'accepted-root duplicate bound exceeded'
        return dict(roots=address, data=data, count=count, capacity=capacity,
                    owner_indices=indices, sha256=hashlib.sha256(raw).hexdigest())

    def accepted_span(scan, after):
        assert after['roots'] == scan['roots'] and after['count'] >= scan['before_count']
        accepted = [i for i in after['owner_indices'] if i >= scan['before_count']]
        if not accepted:
            return
        begin, end = sorted((scan['begin'], scan['end']))
        assert begin % 8 == end % 8 == 0 and 0 <= end - begin <= 16 * 1024**2
        error = lldb.SBError()
        raw = process.ReadMemory(begin, end - begin, error) if begin != end else b''
        assert begin == end or (error.Success() and len(raw) == end - begin)
        _, allocation = precise_allocation(owner['owner'])
        cell_size = number(field(typed(allocation, 'JSC::PreciseAllocation'), 'm_cellSize'))
        assert 0 < cell_size <= 16 * 1024**2
        candidates = []
        for offset in range(0, len(raw), 8):
            value = int.from_bytes(raw[offset:offset + 8], 'little')
            if owner['owner'] <= value <= owner['owner'] + cell_size:
                candidates.append(dict(address=begin + offset, value=value,
                                       offset_into_cell=value - owner['owner']))
                assert len(candidates) <= 64, 'candidate-word bound exceeded'
        receipt = dict(collection=scan['collection'], phase=scan['phase'], roots=scan['roots'],
                       thread=scan['thread'], begin=begin, end=end, before_count=scan['before_count'],
                       after_count=after['count'], accepted_owner_indices=accepted,
                       cell_size=cell_size, candidate_words=candidates,
                       candidate_interpretation='unmodified exact/interior/one-past pointer candidates; accepted scanner iteration not yet identified',
                       span_sha256=hashlib.sha256(raw).hexdigest())
        root_collections[scan['collection']]['accepted_spans'].append(receipt)
        event('accepted-owner-span', **receipt)

    def marker_snapshot(visitor, cell):
        header, allocation, marker = precise_marker(visitor, cell)
        assert marker is not None, 'actual precise allocation missing in completed verifier map'
        marked = field(field(typed(allocation, 'JSC::PreciseAllocation'), 'm_isMarked'), 'value')
        assert marked.GetByteSize() == 1 and word(marked.GetLoadAddress(), 1) == 1, 'owner was not marked by the real GC'
        referrer = number(field(field(marker, 'm_referrer'), 'm_bits'))
        assert referrer == 6, 'marker is not the observed direct ConservativeScan root'
        stacks = pointer(field(marker, 'm_stack'), 'WTF::StackTrace')
        assert len(stacks) == 1 and stacks[0]
        stack = typed(stacks[0], 'WTF::StackTrace')
        count, initial = number(field(stack, 'm_size')), number(field(stack, 'm_initialFrame'))
        layout = stack.GetType().GetCanonicalType()
        event('passive-marker-layout', owner=cell, allocation=allocation, allocation_header_bytes=header,
              marker=marker.GetLoadAddress(), referrer_bits=referrer, stack=stacks[0], count=count, initial=initial,
              raw_header_words=[word(stacks[0]), word(stacks[0] + 8)], type_bytes=layout.GetByteSize(),
              fields={layout.GetFieldAtIndex(i).GetName(): layout.GetFieldAtIndex(i).GetOffsetInBytes()
                      for i in range(layout.GetNumberOfFields())})
        contexts = {}
        for name in ['WTF::StackTrace::captureStackTrace', 'JSC::VerifierSlotVisitor::testAndSetMarked']:
            found = module.FindFunctions(name, lldb.eFunctionNameTypeAny)
            assert found.GetSize() <= 64
            contexts[name] = []
            for i in range(found.GetSize()):
                context = found.GetContextAtIndex(i)
                function, block = context.GetFunction(), context.GetBlock()
                start = function.GetStartAddress().GetLineEntry()
                contexts[name].append({'function': function.GetName(),
                    'compile_unit': str(context.GetCompileUnit().GetFileSpec()),
                    'source': str(start.GetFileSpec()), 'line': start.GetLine(),
                    'inline': block.IsInlined(), 'inline_name': block.GetInlinedName()})
        event('marker-source-contexts', contexts=contexts)
        assert (count == 0 and initial == 0) or (0 < count <= 100 and initial == 2)
        start = field(stack, 'm_stack').GetLoadAddress() + initial * 8
        frames = []
        for i in range(count):
            pc = word(start + i * 8)
            assert pc
            frames.append(symbolize(pc, True))
        event('passive-marker-snapshot', owner=cell, allocation=allocation, real_gc_marked=True, referrer_bits=referrer,
              root_reason='ConservativeScan', stack=stacks[0], frames=frames,
              unresolved_frames=sum(frame['function'] is None for frame in frames))

    try:
        environment = {'PATH': '/usr/bin:/bin', 'CI': '1', 'BUN_GARBAGE_COLLECTOR_LEVEL': '0'}
        if stage == 'capture':
            spawn, _ = entry('posix_spawn_bun')
            args = ['test', FIXTURE, '--test-name-pattern', '^' + CASE + '$',
                    '--reporter=junit', '--reporter-outfile=' + str(OUT / 'fixture.xml')]
        else:
            child = json.loads((OUT / 'child.json').read_text())
            args = child['argv'][1:]
            assert child['argv'][0] == str(BINARY) and len(args) == 2 and args[0] == '-e'
            assert hashlib.sha256(args[1].encode()).hexdigest() == child['script_sha256']
            # These are the frozen harness's effective bunEnv additions; no host environment is inherited.
            environment.update(GITHUB_ACTIONS='false', BUN_DEBUG_QUIET_LOGS='1', NO_COLOR='1', TZ='Etc/UTC',
                               BUN_RUNTIME_TRANSPILER_CACHE_PATH='0', BUN_FEATURE_FLAG_INTERNAL_FOR_TESTING='1',
                               BUN_DISABLE_SLOW_FILESYSTEM_WARNING='1', BUN_CONFIG_HTTP_RETRY_BACKOFF='1',
                               BUN_INTERNAL_INTERACTIVE_ASSUME_TTY='1', BUN_FEATURE_FLAG_EXPERIMENTAL_BAKE='1',
                               WANTS_LOUD='0', AGENT='false', BUN_JSC_verboseVerifyGC='1')
            weak_bp, _ = entry('JSC::constructWeakRef')
            weak_return_bp = None
            completion_bp, completion_address = entry('Bun__UpgradedDuplex__onWriteComplete')
            gc_bp, _ = entry('JSC__VM__runGC')
            mark_bp = target.BreakpointCreateByLocation('Collector.cpp', 1068)
            assert mark_bp.GetNumLocations() > 0, 'missing post-mark verifier boundary'
            mark_bp.SetEnabled(False)
            return_bp = None
            stack_roots_bp, _ = entry('JSC::Heap::gatherStackRoots')
            vm_roots_bp, _ = entry('JSC::Heap::gatherVMRoots')
            scan_bps = []
            for signature in [
                    'JSC::ConservativeRoots::add(void*, void*)',
                    'JSC::ConservativeRoots::add(void*, void*, JSC::JITStubRoutineSet&, JSC::CodeBlockSet&)']:
                bp, _ = entry('JSC::ConservativeRoots::add', signature)
                scan_bps.append(bp)
            root_bps = [stack_roots_bp, vm_roots_bp, *scan_bps]
            for bp in root_bps:
                bp.SetEnabled(False)
        info = lldb.SBLaunchInfo(args)
        info.SetWorkingDirectory(str(SOURCE))
        info.SetEnvironmentEntries([key + '=' + value for key, value in environment.items()], False)
        info.SetLaunchFlags(0)
        assert info.AddOpenFileAction(0, '/dev/null', True, False)
        assert info.AddOpenFileAction(1, str(OUT / (stage + '.stdout')), False, True)
        assert info.AddOpenFileAction(2, str(OUT / (stage + '.stderr')), False, True)
        error = lldb.SBError()
        process = target.Launch(info, error)
        assert error.Success(), str(error)
        for _ in range(256):
            if process.GetState() == lldb.eStateExited:
                break
            assert process.GetState() == lldb.eStateStopped, str(process.GetState())
            threads = [t for t in process if t.GetStopReason() in
                       (lldb.eStopReasonBreakpoint, lldb.eStopReasonWatchpoint)]
            assert len(threads) == 1, 'unexpected stop or concurrent debugger event'
            thread = threads[0]
            frame = thread.GetFrameAtIndex(0)
            if thread.GetStopReason() == lldb.eStopReasonWatchpoint:
                assert stage == 'trace' and mark_watch is not None and mark_watch.IsEnabled()
                assert thread.GetStopReasonDataCount() == 1
                assert thread.GetStopReasonDataAtIndex(0) == mark_watch.GetID()
                value = word(mark_observation['address'], 1)
                event('real-mark-write', watchpoint=mark_watch.GetID(), value=value,
                      stopped_pc=frame.GetPC(), thread=thread.GetThreadID())
                assert value in (0, 1) and value != mark_observation['last_value']
                mark_observation['last_value'] = value
                if value == 0:
                    mark_observation['observed_zero'] = True
                else:
                    assert mark_observation['observed_zero'] and 'frame_pointer_path' not in mark_observation
                    mark_watch.SetEnabled(False)
                    assert not mark_watch.IsEnabled()
                    mark_observation['frame_pointer_path'] = frame_pointer_snapshot(frame, thread)
                    assert root_collection is not None and root_collection['phase'] == 'complete'
                    current_roots = roots_snapshot(root_collection['roots'])
                    assert current_roots == root_collection['after_vm'], 'accepted roots changed before the owner mark'
                    assert current_roots['owner_indices'] and root_collection['accepted_spans']
                    mark_observation['root_collection'] = root_collection['index']
                    event('accepted-root-list-at-owner-mark', **current_roots,
                          collection=root_collection['index'])
                    for bp in root_bps:
                        bp.SetEnabled(False)
                    assert not scan_returns and vm_roots_return is None
                    event('live-real-mark-writer', **mark_observation)
                assert process.Continue().Success()
                continue
            ids = {thread.GetStopReasonDataAtIndex(i) for i in range(0, thread.GetStopReasonDataCount(), 2)}
            report['last_stop'] = {'pc': frame.GetPC(), 'function': frame.GetFunctionName(),
                                   'breakpoints': sorted(ids), 'expected_entry_pcs': {
                                       str(i): entry_addresses[i].GetLoadAddress(target) for i in ids if i in entry_addresses}}
            for bp_id in ids:
                key = str(bp_id)
                report['breakpoint_hits'][key] = report['breakpoint_hits'].get(key, 0) + 1
                if bp_id in entry_addresses:
                    assert frame.GetPC() == entry_addresses[bp_id].GetLoadAddress(target), 'stop is not at function entry'
            if stage == 'capture':
                assert ids == {spawn.GetID()}
                argv = reg(frame, 'x3')
                values = []
                for i in range(64):
                    address = word(argv + i * 8)
                    if not address:
                        break
                    values.append(text(address))
                else:
                    raise RuntimeError('unterminated child argv')
                if len(values) == 3 and values[:2] == [str(BINARY), '-e']:
                    assert not (OUT / 'child.json').exists(), 'multiple selected children'
                    write('child.json', {'argv': values, 'script_sha256': hashlib.sha256(values[2].encode()).hexdigest()})
                    event('captured-actual-fixture-child')
            elif stack_roots_bp.GetID() in ids:
                assert returned and gc_count == 31 and owner is not None
                vm_heap = field(typed(owner['vm'], 'JSC::VM'), 'heap').GetLoadAddress()
                assert reg(frame, 'x0') == vm_heap
                assert root_collection is None or root_collection['phase'] == 'complete'
                assert len(root_collections) < 8 and not scan_returns
                roots = reg(frame, 'x1')
                initial_roots = roots_snapshot(roots)
                assert initial_roots['count'] == 0
                root_collection = dict(index=len(root_collections), roots=roots, phase='stack',
                                       accepted_spans=[], initial=initial_roots)
                root_collections.append(root_collection)
                event('stack-root-gather-entry', collection=root_collection['index'], **initial_roots)
            elif vm_roots_bp.GetID() in ids:
                assert root_collection is not None and root_collection['phase'] == 'stack'
                assert not scan_returns and reg(frame, 'x1') == root_collection['roots']
                vm_heap = field(typed(owner['vm'], 'JSC::VM'), 'heap').GetLoadAddress()
                assert reg(frame, 'x0') == vm_heap and vm_roots_return is None
                root_collection['after_stack'] = roots_snapshot(root_collection['roots'])
                event('stack-root-gather-complete', collection=root_collection['index'],
                      **root_collection['after_stack'])
                root_collection['phase'] = 'vm'
                vm_roots_return = target.BreakpointCreateByAddress(reg(frame, 'x30'))
                assert vm_roots_return.GetNumLocations() == 1
                vm_roots_return.SetThreadID(thread.GetThreadID())
                vm_roots_return.SetOneShot(True)
            elif vm_roots_return is not None and vm_roots_return.GetID() in ids:
                assert root_collection is not None and root_collection['phase'] == 'vm' and not scan_returns
                after = roots_snapshot(root_collection['roots'])
                assert after['count'] >= root_collection['after_stack']['count']
                root_collection.update(phase='complete', after_vm=after)
                event('vm-root-gather-complete', collection=root_collection['index'], **after)
                vm_roots_return = None
            elif any(bp.GetID() in ids for bp in scan_bps):
                assert root_collection is not None and root_collection['phase'] in ('stack', 'vm')
                roots = reg(frame, 'x0')
                assert roots == root_collection['roots'] and not scan_returns
                before = roots_snapshot(roots)
                bp = target.BreakpointCreateByAddress(reg(frame, 'x30'))
                assert bp.GetNumLocations() == 1
                bp.SetThreadID(thread.GetThreadID())
                bp.SetOneShot(True)
                scan_returns[bp.GetID()] = dict(collection=root_collection['index'],
                    phase=root_collection['phase'], roots=roots, before_count=before['count'],
                    begin=reg(frame, 'x1'), end=reg(frame, 'x2'), thread=thread.GetThreadID())
            elif ids.intersection(scan_returns):
                assert len(ids.intersection(scan_returns)) == 1
                scan = scan_returns.pop(next(iter(ids.intersection(scan_returns))))
                assert scan['thread'] == thread.GetThreadID()
                accepted_span(scan, roots_snapshot(scan['roots']))
            elif weak_bp.GetID() in ids:
                assert weak_creation is None
                global_object, call = reg(frame, 'x0'), reg(frame, 'x1')
                assert word(call + 32, 4) == 2, 'fixture WeakRef constructor arguments changed'
                weak_creation = {'global': global_object,
                                 'vm': number(field(typed(global_object, 'JSC::JSGlobalObject'), 'm_vm')),
                                 'owner': word(call + 48)}
                weak_return_bp = target.BreakpointCreateByAddress(reg(frame, 'x30'))
                weak_return_bp.SetThreadID(thread.GetThreadID())
                weak_return_bp.SetOneShot(True)
                event('weak-ref-constructor-entry', **weak_creation)
            elif weak_return_bp is not None and weak_return_bp.GetID() in ids:
                assert weak_creation is not None
                created = reg(frame, 'x0')
                actual_target = pointer(field(typed(created, 'JSC::JSWeakObjectRef'), 'm_value'), 'JSC::JSCell')
                assert actual_target == [weak_creation['owner']], 'constructed weak target does not match'
                weak.append(dict(weak_creation, weak=created))
                assert len(weak) <= 16
                weak_creation = None
                event('weak-ref-created', **weak[-1])
            elif completion_bp.GetID() in ids:
                call = reg(frame, 'x1')
                # Frozen CallFrame.h: callee, argumentCountIncludingThis, then this, in 8-byte registers.
                callee, count, this = word(call + 24), word(call + 32, 4), word(call + 40)
                candidates = [w for w in weak if w['owner'] == this]
                event('completion-entry', callee=callee, this=this, argument_count_including_this=count,
                      matching_weak_targets=len(candidates))
                if candidates:
                    function = typed(callee, 'Zig::JSFFIFunction')
                    native = number(field(function, 'm_function'))
                    assert native == completion_address.GetLoadAddress(target)
                    if number(field(function, 'dataPtr')) == 0:
                        assert owner is None and len(candidates) == 1
                        owner = dict(candidates[0], callee=callee, argument_count_including_this=count)
                        assert count == 1, 'fixture late callback unexpectedly has arguments'
                        return_bp = target.BreakpointCreateByAddress(reg(frame, 'x30'))
                        return_bp.SetThreadID(thread.GetThreadID())
                        return_bp.SetOneShot(True)
                        event('destroyed-late-callback', **owner)
            elif return_bp is not None and return_bp.GetID() in ids:
                returned = True
                event('late-callback-returned')
            elif gc_bp.GetID() in ids:
                event('explicit-gc-entry', vm=reg(frame, 'x0'), sync=reg(frame, 'w1'),
                      after_late_callback=returned)
                if returned and reg(frame, 'x0') == owner['vm']:
                    assert reg(frame, 'w1') == 1
                    gc_count += 1
                    assert gc_count <= 31
                    # The fixture collects once for queuedRoot, then thirty times before its final deref.
                    if gc_count == 31:
                        _, allocation = precise_allocation(owner['owner'])
                        marked = field(field(typed(allocation, 'JSC::PreciseAllocation'), 'm_isMarked'), 'value')
                        assert marked.GetByteSize() == 1 and mark_watch is None
                        address = marked.GetLoadAddress()
                        initial = word(address, 1)
                        assert initial in (0, 1)
                        error = lldb.SBError()
                        mark_watch = target.WatchAddress(address, 1, False, True, error)
                        event('real-mark-watchpoint-admission', address=address, initial=initial, error=str(error),
                              valid=mark_watch.IsValid())
                        assert error.Success() and mark_watch.IsValid() and mark_watch.IsEnabled()
                        assert mark_watch.GetWatchAddress() == address and mark_watch.GetWatchSize() == 1
                        assert mark_watch.GetID() > 0
                        mark_observation = dict(allocation=allocation, address=address, initial_value=initial,
                                                last_value=initial, observed_zero=initial == 0,
                                                watchpoint=mark_watch.GetID())
                        mark_bp.SetEnabled(True)
                        for bp in root_bps:
                            bp.SetEnabled(True)
            elif mark_bp.GetID() in ids:
                assert returned and gc_count == 31 and 'Collector::verifyGC' in (frame.GetFunctionName() or '')
                collector = frame.FindVariable('this', lldb.eNoDynamicValues)
                vm = typed(owner['vm'], 'JSC::VM')
                assert number(collector) == number(field(field(vm, 'heap'), 'm_collector'))
                visitor_ptrs = pointer(field(collector.Dereference(), 'm_verifierSlotVisitor'), 'JSC::VerifierSlotVisitor')
                assert len(set(visitor_ptrs)) == 1 and visitor_ptrs[0]
                assert mark_observation is not None and 'frame_pointer_path' in mark_observation
                assert mark_observation['last_value'] == 1 and not mark_watch.IsEnabled()
                _, allocation = precise_allocation(owner['owner'])
                assert allocation == mark_observation['allocation'] and word(mark_observation['address'], 1) == 1
                visitor = typed(visitor_ptrs[0], 'JSC::VerifierSlotVisitor')
                assert number(field(visitor, 'm_doneMarking')) == 1
                w = typed(owner['weak'], 'JSC::JSWeakObjectRef')
                targets = pointer(field(w, 'm_value'), 'JSC::JSCell')
                assert targets == [owner['owner']], 'the observed weak target no longer matches'
                event('post-mark-owner', gc_count=gc_count, verifier=visitor_ptrs[0],
                      weak_last_access=number(field(w, 'm_lastAccessVersion')),
                      vm_weak_version=number(field(vm, 'm_currentWeakRefVersion')))
                target.DisableAllBreakpoints()
                marker_snapshot(visitor, owner['owner'])
            else:
                raise RuntimeError('unrecognized breakpoint')
            assert process.Continue().Success()
        assert process.GetState() == lldb.eStateExited, 'stop budget exhausted'
        report['exit_code'] = process.GetExitStatus()
        if stage == 'capture':
            assert report['exit_code'] == 1 and (OUT / 'child.json').is_file()
            cases = list(ElementTree.parse(OUT / 'fixture.xml').iter('testcase'))
            producer = list(ElementTree.parse(ROOT / 'producer-evidence/diagnostics/fixture.xml').iter('testcase'))
            admit_failure(cases, producer)
        else:
            assert report['exit_code'] == 0 and gc_count == 31, '31 post-callback explicit collections not observed'
            facts = json.loads((OUT / 'trace.stdout').read_text().strip())
            assert facts['callbackRoot'] is True and facts['collected'] is False and facts['settled'] == ['ECANCELED']
            snapshots = [e for e in report['events'] if e['kind'] == 'passive-marker-snapshot']
            assert len(snapshots) == 1 and snapshots[0]['owner'] == owner['owner']
            assert len([e for e in report['events'] if e['kind'] == 'live-real-mark-writer']) == 1
            report['outcome'] = facts
            assert root_collections and any(c['accepted_spans'] for c in root_collections)
            report['root_collections'] = root_collections
            report['classification'] = 'accepted stack/VM scan spans and real-mark writer captured; exact originating scanner word and source frame remain unproven'
        report['passed'] = True
    except BaseException as error:
        report['gap'] = str(error)
        raise
    finally:
        if stage == 'trace':
            report['observation'] = {'weak_targets': weak, 'owner': owner, 'returned': returned,
                                      'gc_count': gc_count, 'pending_weak_constructor': weak_creation,
                                      'root_collections': root_collections, 'pending_scan_returns': scan_returns}
        if process is not None and process.IsValid() and process.GetState() != lldb.eStateExited:
            process.Kill()
        write(stage + '.json', report)


def capture():
    assert all(sha(BUILD / name) == digest for name, digest in BINARIES.items())
    assert sha(SOURCE / FIXTURE) == FIXTURE_SHA
    for stage in ['capture', 'trace']:
        env = {'PATH': '/usr/bin:/bin', 'TLS_CAPTURE_STAGE': stage}
        command = ['lldb-23', '--no-lldbinit', '--batch',
                   '-o', 'settings set target.load-script-from-symbol-file false',
                   '-o', 'settings set target.inherit-env false',
                   '-o', 'target create ' + str(BINARY), '-o', 'target symbols add ' + str(PROFILE),
                   '-o', 'script import runpy; runpy.run_path(' + repr(str(Path(__file__).resolve())) + ', run_name="__lldb__")']
        with (OUT / (stage + '-debugger.log')).open('xb') as log:
            proc = subprocess.Popen(command, cwd=SOURCE, env=env, stdin=subprocess.DEVNULL,
                                    stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
            started = time.monotonic()
            try:
                while proc.poll() is None:
                    assert time.monotonic() - started < 240, stage + ' debugger timeout'
                    assert sum(p.stat().st_size for p in OUT.iterdir() if p.is_file()) <= 32 * 1024**2
                    time.sleep(0.25)
                assert proc.returncode == 0
            finally:
                if proc.poll() is None:
                    os.killpg(proc.pid, signal.SIGKILL)
                    proc.wait()
        assert json.loads((OUT / (stage + '.json')).read_text())['passed'], stage + ' diagnostic gap'
    assert all(sha(BUILD / name) == digest for name, digest in BINARIES.items())
    assert sha(SOURCE / FIXTURE) == FIXTURE_SHA


if __name__ == '__lldb__':
    debugger_stage()
elif __name__ == '__main__':
    {'admit-zip': admit_zip, 'restore': restore, 'capture': capture}[sys.argv[1]]()
