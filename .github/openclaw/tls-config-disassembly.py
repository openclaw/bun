"""Inspect the exact retained shipping profile without executing it."""
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import struct
import subprocess
import zipfile

RUN = 41238111110
COMMIT = '510fef558b464c58de1209298f638fa476d03eef'
ARTIFACT = 13056617461
SIZE = 222623871
DIGEST = 'c54dbe7ea29a336c76db1dd5ba491bbb117a6c211d938892c62f2f5e74251fcd'
INPUT = Path(os.environ['RUNNER_TEMP']) / 'tls-disassembly-input'
OUT = Path('tls-disassembly-proof')
OUT.mkdir(exist_ok=True)


def sha(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def selected(archive, wanted, maximum):
    entries = archive.infolist()
    assert len(entries) <= 32
    names = set()
    for entry in entries:
        path = PurePosixPath(entry.filename)
        assert entry.filename and not path.is_absolute() and '..' not in path.parts
        assert '\\' not in entry.filename and '\x00' not in entry.filename
        assert str(path) == entry.filename.rstrip('/')
        assert str(path) not in names
        names.add(str(path))
        mode = entry.external_attr >> 16
        assert stat.S_IFMT(mode) in (0, stat.S_IFREG, stat.S_IFDIR)
        assert not entry.flag_bits & 1
    matches = [entry for entry in entries if entry.filename == wanted]
    assert len(matches) == 1
    entry = matches[0]
    assert not entry.is_dir() and 0 < entry.file_size <= maximum
    return entry


def extract(archive_path, member, destination, maximum):
    with zipfile.ZipFile(archive_path) as archive:
        entry = selected(archive, member, maximum)
        with archive.open(entry) as source, destination.open('xb') as target:
            count = 0
            while chunk := source.read(1024**2):
                count += len(chunk)
                assert count <= maximum
                target.write(chunk)
        assert count == entry.file_size
    destination.chmod(0o600)


def run(name, arguments):
    result = subprocess.run(arguments, stdin=subprocess.DEVNULL,
                            capture_output=True, timeout=120, check=False)
    assert len(result.stdout) <= 32 * 1024**2 and len(result.stderr) <= 1024**2
    (OUT / (name + '.stderr')).write_bytes(result.stderr)
    assert result.returncode == 0 and not result.stderr, name
    return result.stdout.decode('utf-8')


archive = INPUT / 'artifact.zip'
assert archive.stat().st_size == SIZE and sha(archive) == DIGEST
metadata = json.loads((INPUT / 'metadata.json').read_text())
assert metadata['id'] == ARTIFACT and metadata['name'] == 'build-linux-arm64'
assert metadata['size_in_bytes'] == SIZE and metadata['digest'] == 'sha256:' + DIGEST
assert not metadata['expired']
assert metadata['workflow_run']['id'] == RUN and metadata['workflow_run']['head_sha'] == COMMIT
profile_zip = INPUT / 'profile.zip'
profile = INPUT / 'bun-profile.elf'
extract(archive, 'bun-linux-aarch64-profile.zip', profile_zip, 1024**3)
extract(profile_zip, 'bun-linux-aarch64-profile/bun-profile', profile, 2 * 1024**3)
with profile.open('rb') as stream:
    header = stream.read(64)
assert header[:7] == b'\x7fELF\x02\x01\x01'
assert struct.unpack_from('<H', header, 18)[0] == 183
version = run('llvm-version', ['llvm-objdump-23', '--version'])
assert re.search(r'LLVM version 23\.', version)
symbols = run('nm', ['llvm-nm-23', '--defined-only', '--format=posix',
                     '--print-size', '--radix=x', '--no-demangle', str(profile)])
rows = []
for line in symbols.splitlines():
    fields = line.split()
    if fields and re.fullmatch(
            r'_RNv\w*11bun_runtime6socket11socket_body\w*20DuplexUpgradeContext6deinit', fields[0]):
        assert len(fields) == 4 and fields[1] in ('T', 't')
        rows.append(fields)
assert len(rows) == 1, 'deinit missing or ambiguous'
name, kind, address, size = rows[0]
start, length = int(address, 16), int(size, 16)
assert start > 0 and 0 < length <= 65536
assembly = run('objdump', ['llvm-objdump-23', '--disassemble', '--start-address=' + hex(start),
                          '--stop-address=' + hex(start + length), str(profile)])
assert re.search(r'^0*' + format(start, 'x') + r' <' + re.escape(name) + r'>:$', assembly, re.M)
instructions = []
for line in assembly.splitlines():
    match = re.match(r'^\s*([0-9a-f]+):\s+([0-9a-f]{8})\s+(\S+)', line)
    if match:
        address = int(match[1], 16)
        assert start <= address < start + length
        assert match[3] != '<unknown>'
        instructions.append(address)
assert instructions and instructions[0] == start
assert instructions == sorted(set(instructions))
notes = run('build-id', ['llvm-readelf-23', '--notes', str(profile)])
build_ids = re.findall(r'Build ID: ([0-9a-f]+)', notes)
assert len(build_ids) == 1
assert sha(archive) == DIGEST
receipt = dict(captured=True, control_flow_review_pending=True, producer_run=RUN,
    commit=COMMIT, artifact_id=ARTIFACT, artifact_sha256=DIGEST,
    profile_zip_sha256=sha(profile_zip), profile_sha256=sha(profile),
    elf_machine='AArch64', build_id=build_ids[0], symbol=rows[0],
    instruction_count=len(instructions), llvm_version=version)
(OUT / 'deinit.asm').write_text(assembly.replace(str(profile), 'bun-profile.elf'))
(OUT / 'receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
(OUT / 'symbol.txt').write_text(' '.join(rows[0]) + '\n')
(OUT / 'build-id.txt').write_text(notes)
files = sorted(OUT.iterdir())
assert len(files) <= 12 and sum(path.stat().st_size for path in files) <= 2 * 1024**2
(OUT / 'manifest.json').write_text(json.dumps({
    path.name: dict(bytes=path.stat().st_size, sha256=sha(path)) for path in files
}, indent=2) + '\n')
print(json.dumps(receipt))
