"""Capture bounded physical functions from the exact consumed Darwin profile; never run it."""
import json
import os
from pathlib import Path
import re
import runpy
import stat
import struct
import subprocess
import uuid

ROOT = Path(os.environ['RUNNER_TEMP']) / 'tls-darwin-input'
OUT = Path('tls-darwin-disassembly')
LIBRARY = runpy.run_path(str(Path(__file__).with_name('tls-darwin-capability.py')),
                         run_name='archive_library')
COMMIT = LIBRARY['COMMIT']
RUN = LIBRARY['RUN']
ARTIFACT = LIBRARY['ARTIFACT']
SIZE = LIBRARY['SIZE']
DIGEST = LIBRARY['DIGEST']
sha = LIBRARY['sha']
extract = LIBRARY['extract']


def macho(path, filetype):
    with path.open('rb') as stream:
        header = stream.read(32)
        magic, cpu, subtype, kind, count, size, flags, reserved = struct.unpack('<8I', header)
        assert (magic, cpu, kind) == (0xfeedfacf, 0x01000007, filetype), tuple(map(hex, (magic, cpu, subtype, kind)))
        # CPU_SUBTYPE_LIB64 is a capability bit, not a different x86_64 architecture.
        assert subtype in (3, 0x80000003), hex(subtype)
        assert 0 < count <= 1024 and 0 < size <= 1024**2
        data = stream.read(size)
    assert len(data) == size
    offset, identities, sections = 0, [], []
    for _ in range(count):
        assert offset + 8 <= size
        command, length = struct.unpack_from('<II', data, offset)
        assert length >= 8 and length % 8 == 0 and offset + length <= size
        if command == 0x1b:  # LC_UUID
            assert length == 24
            identities.append(str(uuid.UUID(bytes=data[offset + 8:offset + 24])))
        if command == 0x19:  # LC_SEGMENT_64, section_64 records follow its 72-byte header.
            assert length >= 72
            segment = data[offset + 8:offset + 24].rstrip(b'\0')
            nsects = struct.unpack_from('<I', data, offset + 64)[0]
            assert length == 72 + nsects * 80
            for i in range(nsects):
                base = offset + 72 + i * 80
                section = data[base:base + 16].rstrip(b'\0')
                owner = data[base + 16:base + 32].rstrip(b'\0')
                assert owner == segment
                if segment == b'__TEXT' and section == b'__text':
                    address, extent = struct.unpack_from('<QQ', data, base + 32)
                    sections.append((address, address + extent))
        offset += length
    assert offset == size and len(identities) == 1
    return identities[0], sections, subtype


def tool(name, args):
    result = subprocess.run(args, stdin=subprocess.DEVNULL, capture_output=True, timeout=180)
    assert len(result.stdout) <= 32 * 1024**2 and len(result.stderr) <= 1024**2
    (OUT / (name + '.stderr')).write_bytes(result.stderr)
    assert result.returncode == 0 and not result.stderr, (name, result.returncode)
    return result.stdout.decode()


def select_symbols(text):
    result = {}
    for line in text.splitlines():
        fields = line.split()
        if not fields:
            continue
        match = re.fullmatch(r'__?RNv\w*11bun_runtime6socket11socket_body\w*20DuplexUpgradeContext(6deinit|9run_event)', fields[0])
        if match:
            assert len(fields) in (3, 4) and fields[1] in ('T', 't')
            assert re.fullmatch(r'[0-9a-fA-F]+', fields[2])
            key = {'6deinit': 'deinit', '9run_event': 'run_event'}[match[1]]
            assert key not in result, 'ambiguous ' + key
            result[key] = dict(symbol=fields[0], start=int(fields[2], 16), nm=fields)
    return result


def instructions(text, symbol, start, end):
    assert re.search(r'^0*' + format(start, 'x') + r' <' + re.escape(symbol) + r'>:$', text, re.M)
    cursor, count = start, 0
    for line in text.splitlines():
        if not re.match(r'^\s*[0-9a-f]+:', line):
            continue
        match = re.fullmatch(r'\s*([0-9a-f]+):\s+((?:[0-9a-f]{2}\s+)+)(\S+)(.*)', line)
        assert match, line
        address = int(match[1], 16)
        width = len(match[2].split())
        assert address == cursor and 0 < width <= 15 and address + width <= end, line
        assert match[3] not in ('<unknown>', '.byte', '.long', '.short'), line
        cursor += width
        count += 1
    assert count and cursor == end
    return count


def main():
    OUT.mkdir(exist_ok=True)
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
    profile, dsym = ROOT / 'bun-profile', ROOT / 'bun-profile.dSYM'
    extract(archive, 'bun-darwin-x64-profile.zip', profile_zip, 1024**3)
    for path in (profile, dsym):
        extract(profile_zip, 'bun-darwin-x64-profile/' + path.name, path, 2 * 1024**3)
    identity, sections, subtype = macho(profile, 2)
    assert identity == macho(dsym, 10)[0] == '4c4c4432-5555-3144-a125-d2b0a4297913'
    assert len(sections) == 1
    version = tool('llvm-version', ['llvm-objdump-23', '--version'])
    assert re.search(r'LLVM version 23\.', version)
    nm_args = ['llvm-nm-23', '--defined-only', '--format=posix', '--radix=x', '--no-demangle']
    symbols = select_symbols(tool('nm-profile', nm_args + [str(profile)]))
    symbol_owner = 'bun-profile'
    if set(symbols) != {'deinit', 'run_event'}:
        symbols = select_symbols(tool('nm-dsym', nm_args + [str(dsym)]))
        symbol_owner = 'bun-profile.dSYM'
    assert set(symbols) == {'deinit', 'run_event'}, 'required physical function missing'
    starts_text = tool('function-starts', ['llvm-objdump-23', '--macho', '--no-leading-headers',
                                         '--function-starts=addrs', str(profile)])
    lines = starts_text.splitlines()
    assert lines and all(re.fullmatch(r'[0-9a-f]{16}', line) for line in lines)
    starts = [int(line, 16) for line in lines]
    assert starts == sorted(set(starts))
    for name, item in symbols.items():
        start = item['start']
        assert start in starts
        index = starts.index(start)
        assert index + 1 < len(starts)
        end = starts[index + 1]
        assert sections[0][0] <= start < end <= sections[0][1] and end - start <= 65536
        # The generic disassembler honors numeric bounds. The --macho disassembler does not.
        assembly = tool(name, ['llvm-objdump-23', '--disassemble', '--disassemble-zeroes', '--show-all-symbols',
            '--start-address=' + hex(start), '--stop-address=' + hex(end), str(profile)])
        item.update(end=end, bytes=end - start,
                    instruction_count=instructions(assembly, item['symbol'], start, end))
        path = OUT / (name + '.asm')
        path.write_text(assembly.replace(str(profile), 'bun-profile'))
        item['assembly_sha256'] = sha(path)
    receipt = dict(commit=COMMIT, producer_run=RUN, artifact_id=ARTIFACT, artifact_sha256=DIGEST,
        identities={p.name: sha(p) for p in (profile_zip, profile, dsym)}, uuid=identity,
        sections=sections, cpu_subtype=hex(subtype), symbol_owner=symbol_owner, functions=symbols, llvm_version=version,
        inferior_launched=False, control_flow_review_pending=True, gc_root_proven=False)
    (OUT / 'receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
    files = sorted(OUT.iterdir())
    assert len(files) <= 24 and all(stat.S_ISREG(p.lstat().st_mode) for p in files)
    assert sum(p.stat().st_size for p in files) <= 32 * 1024**2
    (OUT / 'manifest.json').write_text(json.dumps({p.name: dict(bytes=p.stat().st_size, sha256=sha(p))
        for p in files}, indent=2) + '\n')
    print(json.dumps(receipt))


if __name__ == '__main__':
    main()
