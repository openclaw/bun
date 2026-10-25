#!/usr/bin/env python3
"""Exercise real local backup CLI create/verify with synthetic managed SQLite state."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import runpy
import shutil
import signal
import sqlite3
import sys
import tarfile

HERE = Path(__file__).resolve().parent
SOURCE = '59baf4a051665750eb7055d0cec991d9876526df'
LIVE_ROWS = [(7, 'p6-live-alpha'), (11, 'p6-live-beta')]
DELETED = 'P6_SYNTHETIC_DELETED_PAGE_8c3e61'
WORKSPACE = b'P6 synthetic workspace payload\n'


def sha(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def interrupted(number, _frame):
    raise InterruptedError('signal ' + str(number))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--task-root', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--mode', choices=['jit-node', 'jit-bun', 'aot'], required=True)
    parser.add_argument('--runtime', type=Path, required=True)
    parser.add_argument('--runtime-sha256', required=True)
    parser.add_argument('--entry', type=Path)
    parser.add_argument('--entry-sha256')
    args = parser.parse_args()
    assert platform.system() == 'Linux'
    task, out, runtime = args.task_root.resolve(strict=True), args.out.resolve(), args.runtime.resolve(strict=True)
    assert out.is_relative_to(task) and out != task and not out.exists()
    assert sha(runtime) == args.runtime_sha256
    assert not runtime.is_relative_to(out)
    entry = args.entry.resolve(strict=True) if args.entry else None
    assert (entry is None) == (args.mode == 'aot'), 'JIT requires the actual CLI launcher; AOT invokes the admitted binary directly'
    if entry:
        assert sha(entry) == args.entry_sha256 and not entry.is_relative_to(out)
        stamp = json.loads((entry.parent / 'dist/.buildstamp').read_text())
        assert stamp['head'] == SOURCE and stamp['inputsClean'] is True
    helper = HERE / 'measure-command.py'
    assert sha(helper) == '373b56ced3b931233bc15a1d97c634f486602b3c9e5a02d75e0688d2f5552a5a'
    os.umask(0o077)
    out.mkdir(parents=True)
    for name in ['home', 'state', 'workspace', 'plugin', 'tmp', 'cache', 'empty-path', 'empty-plugins']:
        (out / name).mkdir()
    state, workspace, plugin = out / 'state', out / 'workspace', out / 'plugin'
    config = state / 'openclaw.json'
    config.write_text(json.dumps({
        'agents': {'ownership': 'explicit', 'entries': {'main': {'workspace': str(workspace)}}},
        'plugins': {'allow': ['p6-backup'], 'load': {'paths': [str(plugin)]},
                    'entries': {'p6-backup': {'enabled': True}}},
        'skills': {'load': {'watch': False}},
    }, indent=2) + '\n')
    (workspace / 'README.txt').write_bytes(WORKSPACE)
    (state / 'ordinary.txt').write_text('P6 ordinary retained file\n')
    (plugin / 'package.json').write_text(json.dumps({'name': '@example/p6-backup', 'version': '1.0.0',
        'openclaw': {'extensions': ['./index.cjs']}}) + '\n')
    (plugin / 'openclaw.plugin.json').write_text(json.dumps({
        'id': 'p6-backup', 'name': 'P6 synthetic backup metadata', 'configSchema': {'type': 'object'},
        'backupResources': [{'disposition': 'include', 'scope': 'state', 'relativePath': 'p6-backup'}],
    }) + '\n')
    (plugin / 'index.cjs').write_text('throw new Error("P6 backup metadata must not execute plugin runtime");\n')
    database = state / 'p6-backup/records.db'
    database.parent.mkdir()
    connection = sqlite3.connect(database)
    try:
        connection.executescript('PRAGMA secure_delete=OFF; PRAGMA auto_vacuum=NONE; CREATE TABLE p6_records(id INTEGER PRIMARY KEY, value TEXT NOT NULL);')
        connection.executemany('INSERT INTO p6_records VALUES (?,?)', LIVE_ROWS)
        connection.execute('INSERT INTO p6_records VALUES (?,?)', (99, DELETED * 2048))
        connection.commit()
        connection.execute('DELETE FROM p6_records WHERE id=99')
        connection.commit()
    finally:
        connection.close()
    assert DELETED.encode() in database.read_bytes(), 'fixture must retain deleted-page marker before backup'
    inputs = {str(path): sha(path) for path in [database, config, workspace / 'README.txt', state / 'ordinary.txt']}
    env = {'PATH': str(out / 'empty-path'), 'HOME': str(out / 'home'), 'OPENCLAW_HOME': str(out / 'home'),
           'OPENCLAW_STATE_DIR': str(state), 'OPENCLAW_CONFIG_PATH': str(config),
           'OPENCLAW_BUNDLED_PLUGINS_DIR': str(out / 'empty-plugins'), 'TMPDIR': str(out / 'tmp'),
           'TMP': str(out / 'tmp'), 'TEMP': str(out / 'tmp'), 'XDG_CACHE_HOME': str(out / 'cache'),
           'BUN_INSTALL_CACHE_DIR': str(out / 'cache'), 'BUN_CONFIG_REGISTRY': 'http://127.0.0.1:9',
           'NODE_DISABLE_COMPILE_CACHE': '1', 'NO_COLOR': '1', 'LANG': 'C.UTF-8', 'TZ': 'UTC'}
    assert shutil.which('node', path=env['PATH']) is None
    command = [str(runtime), *(['--no-env-file', '--no-install'] if args.mode == 'jit-bun' else []), *([str(entry)] if entry else [])]
    archive = out / 'backup.tar.gz'
    result = {'mode': args.mode, 'runtime': str(runtime), 'runtimeSha256': args.runtime_sha256,
              'entry': str(entry) if entry else None, 'entrySha256': args.entry_sha256,
              'expectedSourceCommit': SOURCE, 'sourceBinding': 'canonical build stamp' if entry else 'lane owner must separately admit actual AOT artifact lineage',
              'noPathNode': True, 'syntheticOnly': True, 'pass': False, 'commands': [],
              'scope': 'real local CLI backup create/verify, managed .db snapshot and payload; no Gateway/model/network or comparative timing'}
    os.environ.clear()
    os.environ.update(env)
    os.chdir(out)
    for number in [signal.SIGINT, signal.SIGTERM, signal.SIGHUP]:
        signal.signal(number, interrupted)
    try:
        for label, arguments in [
            ('create', ['backup', 'create', '--output', str(archive), '--verify', '--json']),
            ('verify', ['backup', 'verify', str(archive), '--json']),
        ]:
            argv = ['/usr/bin/nice', '-n', '10', *command, *arguments]
            sys.argv = [str(helper), '--label', 'backup-' + label, '--out', str(out / label), '--timeout', '120', '--', *argv]
            code = 0
            try:
                runpy.run_path(str(helper), run_name='__main__')
            except SystemExit as error:
                code = error.code
            result['commands'].append({'label': label, 'argv': argv, 'exitCode': code})
            assert code == 0, label + ' CLI failed'
            result[label] = json.loads((out / label / 'stdout.txt').read_text())
        assert result['create']['verified'] is True and result['create']['archivePath'] == str(archive)
        assert result['create']['includeWorkspace'] is True and result['create']['onlyConfig'] is False
        assert result['verify']['ok'] is True and result['verify']['archivePath'] == str(archive)
        assert result['verify']['sqliteInventoryVerified'] is True
        assert not result['create'].get('warnings'), 'managed database must not be reported as opaque'
        with tarfile.open(archive, 'r:gz') as tar:
            members = tar.getmembers()
            assert len(members) < 100 and all(member.size < 2 * 1024 * 1024 for member in members)
            manifests = [m for m in members if m.isfile() and m.name.count('/') == 1 and m.name.endswith('/manifest.json')]
            assert len(manifests) == 1
            manifest = json.loads(tar.extractfile(manifests[0]).read())
            assert manifest['schemaVersion'] == 1
            assert manifest['archiveRoot'] == result['create']['archiveRoot'] == result['verify']['archiveRoot']
            def archived(source):
                owners = [asset for asset in manifest['assets'] if source.is_relative_to(Path(asset['sourcePath']))]
                owner = max(owners, key=lambda asset: len(asset['sourcePath']))
                name = str(Path(owner['archivePath']) / source.relative_to(owner['sourcePath']))
                member = tar.getmember(name)
                assert member.isfile()
                return name, tar.extractfile(member).read()
            assert archived(config)[1] == config.read_bytes()
            assert archived(workspace / 'README.txt')[1] == WORKSPACE
            assert archived(state / 'ordinary.txt')[1] == b'P6 ordinary retained file\n'
            db_name, snapshot = archived(database)
            assert all(member.name not in {db_name + suffix for suffix in ['-wal', '-shm', '-journal']} for member in members)
            assert DELETED.encode() not in snapshot, 'documented ordinary snapshot compaction must omit deleted free-page payload'
            extracted = out / 'archived-records.db'
            with extracted.open('xb') as stream:
                stream.write(snapshot)
        db = sqlite3.connect('file:' + str(extracted) + '?mode=ro', uri=True)
        try:
            assert db.execute('PRAGMA integrity_check').fetchall() == [('ok',)]
            assert db.execute('SELECT id,value FROM p6_records ORDER BY id').fetchall() == LIVE_ROWS
        finally:
            db.close()
        assert all(sha(path) == digest for path, digest in inputs.items()), 'synthetic source payload changed'
        assert sha(runtime) == args.runtime_sha256
        result['archiveSha256'] = sha(archive)
        result['archivedDatabaseSha256'] = sha(extracted)
        result['managedSnapshotPayloadVerified'] = True
        result['sourceInputsUnchanged'] = True
        result['pass'] = True
    except BaseException as error:
        result['error'] = type(error).__name__ + ': ' + str(error)
    finally:
        (out / 'result.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result))
    raise SystemExit(0 if result['pass'] else 1)


if __name__ == '__main__':
    main()
