#!/usr/bin/env python3
"""Synthetic guard tests; no compiler, Docker, paging or network execution."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch
import urllib.request

HERE = Path(__file__).resolve().parent


def module(name):
    spec = importlib.util.spec_from_file_location(name, HERE / (name + '.py'))
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


class CandidateGuards(unittest.TestCase):
    def test_terminal_status_survives_child_cleanup_failure(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            binary = root / 'bin'
            binary.mkdir()
            docker = '''#!/bin/sh
case "$1" in
  inspect) case "$3" in *openclaw.p6.owner*) echo 1-1;; *) echo true;; esac; exit 0;;
  exec) for last; do :; done; if [ "$last" = run ]; then exit 143; fi; exit 0;;
  ps) exit 1;;
  *) exit 0;;
esac
'''
            scripts = {'docker': docker, 'sudo': '#!/bin/sh\nexit 0\n',
                       'timeout': '#!/bin/sh\nwhile [ "$1" != docker ]; do shift; done\nexec "$@"\n',
                       'python3': '#!/bin/sh\nexec "' + sys.executable + '" "$@"\n'}
            for name, text in scripts.items():
                path = binary / name
                path.write_text(text)
                path.chmod(0o755)
            env = {**os.environ, 'PATH': str(binary) + ':/usr/bin:/bin', 'P6_WORK': str(root),
                   'P6_CONTAINER': 'p6-test', 'P6_DEADLINE_EPOCH': str(int(time.time()) + 5000),
                   'GITHUB_REPOSITORY': 'openclaw/bun', 'GITHUB_RUN_ID': '1',
                   'GITHUB_RUN_ATTEMPT': '1', 'GITHUB_JOB': 'linux-x64-app', 'GITHUB_SHA': 'a' * 40}
            result = subprocess.run(['/bin/bash', str(HERE / 'host.sh'), 'variant', 'js'],
                                    env=env, capture_output=True, text=True, timeout=5)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(json.loads((root / 'terminal.json').read_text())['exitCode'], 143)

    def test_guest_terminal_exit_does_not_launch_next_guest(self):
        guest = module('guest')
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            app, work = root / 'app', root / 'work'
            work.mkdir()
            for variant in ['js', 'c2-off']:
                build = app / 'build-receipts' / variant
                core = app / 'qualification-results' / (variant + '-core') / 'run'
                build.mkdir(parents=True)
                core.mkdir(parents=True)
                (build / 'result.json').write_text('{"status":"built-unsigned"}')
                (core / 'result.json').write_text('{}')
                (app / 'admissions').mkdir(exist_ok=True)
                (app / 'admissions' / (variant + '.json')).write_text('{}')
            original_stat = Path.stat
            def info(path, *args, **kwargs):
                if str(path) == '/dev/kvm':
                    return os.stat_result((stat.S_IFCHR, 0, 0, 1, 0, 0, 0, 0, 0, 0))
                return original_stat(path, *args, **kwargs)
            for codes in [[143], [0, 137], [0, 124], [-9], [0, -15]]:
                with patch.object(guest, 'ROOT', app), patch.object(Path, 'stat', info), \
                     patch.dict(os.environ, {'P6_WORK': str(work), 'P6_DEADLINE_EPOCH': str(time.time() + 10000)}), \
                     patch.object(guest.subprocess, 'run', side_effect=[subprocess.CompletedProcess([], code) for code in codes]) as run:
                    self.assertEqual(guest.main(), 128 - codes[-1] if codes[-1] < 0 else codes[-1])
                    self.assertEqual(run.call_count, len(codes))

    def test_terminal_host_receipt_prevents_next_variant(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            binary = root / 'bin'
            binary.mkdir()
            marker = root / 'docker-called'
            for name, text in {'docker': '#!/bin/sh\ntouch "$P6_TEST_MARKER"\nexit 0\n',
                               'python3': '#!/bin/sh\nexec "' + sys.executable + '" "$@"\n'}.items():
                path = binary / name
                path.write_text(text)
                path.chmod(0o755)
            (root / 'terminal.json').write_text('{"status":"terminal","exitCode":143}')
            env = {**os.environ, 'PATH': str(binary) + ':/usr/bin:/bin', 'P6_WORK': str(root),
                   'P6_CONTAINER': 'p6-test', 'P6_DEADLINE_EPOCH': str(int(time.time()) + 3600),
                   'GITHUB_RUN_ID': '1', 'GITHUB_RUN_ATTEMPT': '1', 'P6_TEST_MARKER': str(marker)}
            result = subprocess.run(['/bin/bash', str(HERE / 'host.sh'), 'variant', 'js'],
                                    env=env, capture_output=True, text=True, timeout=5)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads((root / 'js-skipped.json').read_text())['reason'], 'previous-terminal-exit')
            self.assertFalse(marker.exists())

    def test_runtime_failure_continues_but_build_failure_stops(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            binary = root / 'bin'
            binary.mkdir()
            scripts = {
                'sha256sum': '#!/bin/sh\nprintf "synthetic-hash  admission.json\\n"\n',
                'python3': '#!/bin/sh\nfor last; do :; done\nphase=${last##*/}\nprintf "%s\\n" "$phase" >> "$P6_TEST_PHASES"\nif [ "$phase" = "$P6_FAIL_PHASE" ]; then exit "$P6_FAIL_CODE"; fi\nexit 0\n',
            }
            for name, text in scripts.items():
                path = binary / name
                path.write_text(text)
                path.chmod(0o755)
            for failed_phase, code in [('zero-js.sh', 23), ('build.sh', 23),
                                       ('zero-js.sh', 124), ('zero-js.sh', 137), ('zero-js.sh', 143)]:
                log = root / (failed_phase + str(code) + '.log')
                env = {**os.environ, 'PATH': str(binary) + ':/usr/bin:/bin',
                       'P6_WORK': str(root), 'P6_DEADLINE_EPOCH': str(int(time.time()) + 3600),
                       'P6_TEST_PHASES': str(log), 'P6_FAIL_PHASE': failed_phase,
                       'P6_FAIL_CODE': str(code)}
                result = subprocess.run(['/bin/bash', str(HERE / 'variant.sh'), 'js', 'run'],
                                        env=env, capture_output=True, text=True, timeout=5)
                self.assertNotEqual(result.returncode, 0)
                phases = log.read_text().splitlines()
                if failed_phase == 'build.sh':
                    self.assertEqual(phases, ['build.sh'])
                elif code == 124 or code >= 128:
                    self.assertEqual(result.returncode, code)
                    self.assertEqual(phases[-1], 'zero-js.sh')
                    self.assertNotIn('node-vm.sh', phases)
                else:
                    for expected in ['node-vm.sh', 'node-vm-native-workers.sh', 'plugin.sh',
                                     'docker-image.sh', 'docker-gateway-network.sh', 'docker-cron.sh']:
                        self.assertIn(expected, phases)

    def test_missing_kvm_records_gap_without_guest_launch(self):
        guest = module('guest')
        with tempfile.TemporaryDirectory() as temporary:
            real_exists = Path.exists
            def exists(path):
                return False if str(path) == '/dev/kvm' else real_exists(path)
            with patch.dict(os.environ, {'P6_WORK': temporary, 'P6_DEADLINE_EPOCH': str(time.time() + 3600)}), \
                 patch.object(Path, 'exists', exists), patch.object(guest.subprocess, 'run') as run:
                self.assertEqual(guest.main(), 0)
                run.assert_not_called()
            gaps = json.loads((Path(temporary) / 'guest-gaps.json').read_text())
            self.assertEqual(gaps[0]['status'], 'not-run')
            self.assertIn('no emulation fallback', gaps[0]['reason'])

    def test_expired_window_cannot_activate_paging(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            binary = root / 'bin'
            binary.mkdir()
            marker = root / 'python-called'
            scripts = {'docker': '#!/bin/sh\nexit 0\n',
                       'timeout': '#!/bin/sh\nwhile [ "$1" != docker ]; do shift; done\nexec "$@"\n',
                       'sudo': '#!/bin/sh\ntouch "$P6_TEST_MARKER"\nexit 99\n',
                       'python3': '#!/bin/sh\nexit 0\n'}
            for name, text in scripts.items():
                path = binary / name
                path.write_text(text)
                path.chmod(0o755)
            env = {**os.environ, 'PATH': str(binary) + ':/usr/bin:/bin',
                   'P6_TEST_MARKER': str(marker), 'P6_WORK': str(root / 'work'),
                   'P6_CONTAINER': 'p6-test', 'GITHUB_RUN_ID': '1', 'GITHUB_RUN_ATTEMPT': '1',
                   'P6_DEADLINE_EPOCH': str(int(time.time()) - 1)}
            result = subprocess.run(['/bin/bash', str(HERE / 'host.sh'), 'paging'], env=env,
                                    capture_output=True, text=True, timeout=5)
            self.assertEqual(result.returncode, 124, result.stderr)
            self.assertFalse(marker.exists(), 'Paging operation reached after exhausted deadline')

    def test_public_projection_integrity(self):
        root = HERE / 'packet/payload'
        manifest = json.loads((root / 'manifest.json').read_text())
        for name, expected in manifest['files'].items():
            data = (root / name).read_bytes()
            self.assertEqual(hashlib.sha256(data).hexdigest(), expected, name)
            self.assertNotIn(b'/Users/', data, name)
            self.assertNotIn(b'/Volumes/', data, name)
        entries = json.loads((root / 'admission-inputs/P0-artifacts.json').read_text())['artifacts']
        self.assertEqual(len(entries), 1)
        self.assertTrue(entries[0]['signed'] and entries[0]['qualified'])

    def test_artifact_redirect_drops_bearer(self):
        download = module('download')
        request = urllib.request.Request('https://api.github.com/a', headers={'Authorization': 'Bearer synthetic'})
        next_request = download.DownloadRedirect().redirect_request(request, None, 302, 'Found', {}, 'https://artifact.example/a')
        self.assertNotIn('Authorization', next_request.headers)

    def test_export_does_not_select_paging_or_unexpected_state(self):
        export = module('export')
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            selected = list(export.selections(root / 'work', root / 'app'))
            sources = {str(source) for source, _ in selected}
            for private in ['ephemeral-swap64/backing.img', 'ephemeral-swap64/state.json',
                            'paging-tools/approval.json', 'state/credentials.json', 'source/.env']:
                self.assertNotIn(str(root / 'app' / private), sources)
            self.assertEqual(len(selected), len(set(relative for _, relative in selected)))

    def test_missing_runtime_is_not_complete(self):
        export = module('export')
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            build = root / 'app/build-receipts/js'
            build.mkdir(parents=True)
            (build / 'result.json').write_text('{"status":"built-unsigned"}')
            result = export.summary(root / 'work', root / 'app')
            self.assertFalse(result['scheduledPhasesComplete'])
            self.assertFalse(result['applicationQualified'])
            self.assertFalse(result['shipReady'])
            self.assertFalse(result['variants']['js']['complete'])
            self.assertEqual(result['variants']['ts']['build'], 'not-run')


if __name__ == '__main__':
    unittest.main()
