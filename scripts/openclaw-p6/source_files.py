"""Verify pinned sparse exports without executing repository code."""
import hashlib
import os
from pathlib import Path
import stat
import tarfile


def digest(path):
    result = hashlib.sha256()
    with Path(path).open('rb') as source:
        for block in iter(lambda: source.read(1024 * 1024), b''):
            result.update(block)
    return result.hexdigest()


def blob(data):
    return hashlib.sha1(b'blob ' + str(len(data)).encode() + b'\0' + data).hexdigest()


def verify_archive(archive, entries):
    expected = {row['path']: row for row in entries}
    seen = set()
    with tarfile.open(archive, 'r:gz') as source:
        for member in source:
            if member.isdir():
                continue
            row = expected.get(member.name)
            if row is None or member.name in seen:
                raise ValueError(f'Unexpected or duplicate archive member: {member.name}')
            if member.issym() and row['mode'] == '120000':
                data = os.fsencode(member.linkname)
            elif member.isfile() and row['mode'] in ['100644', '100755']:
                if bool(member.mode & 0o111) != (row['mode'] == '100755'):
                    raise ValueError(f'Executable mode mismatch: {member.name}')
                data = source.extractfile(member).read()
            else:
                raise ValueError(f'Archive member type mismatch: {member.name}')
            if blob(data) != row['blob']:
                raise ValueError(f'Archive Git blob mismatch: {member.name}')
            seen.add(member.name)
    if seen != set(expected):
        raise ValueError(f'Missing archive members: {sorted(set(expected) - seen)[:5]}')
    return len(seen)


def verify_files(root, entries):
    for row in entries:
        path = Path(root) / row['path']
        mode = path.lstat().st_mode
        if row['mode'] == '120000' and stat.S_ISLNK(mode):
            data = os.fsencode(os.readlink(path))
        elif row['mode'] in ['100644', '100755'] and stat.S_ISREG(mode):
            if bool(mode & 0o111) != (row['mode'] == '100755'):
                raise ValueError(f'Executable mode mismatch: {path}')
            data = path.read_bytes()
        else:
            raise ValueError(f'File type mismatch: {path}')
        if blob(data) != row['blob']:
            raise ValueError(f'Git blob mismatch: {path}')


def extract(archive, destination, entries):
    verify_archive(archive, entries)
    Path(destination).mkdir()
    with tarfile.open(archive, 'r:gz') as source:
        source.extractall(destination, filter='data')
    verify_files(destination, entries)
