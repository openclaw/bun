#!/usr/bin/env python3
"""Synthetic guard tests; no compiler, Docker, paging or network execution."""
import hashlib
import importlib.util
import io
import json
import os
import runpy
from pathlib import Path
import stat
import subprocess
import sys
import tarfile
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
    def test_toolchain_exposes_pnpm_without_installing_the_placeholder(self):
        spec = importlib.util.spec_from_file_location('native_prep', HERE / 'packet/payload/native-prep.py')
        prep = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(prep)

        def archive(files):
            output = io.BytesIO()
            with tarfile.open(fileobj=output, mode='w:gz') as package:
                for name, (contents, mode) in files.items():
                    entry = tarfile.TarInfo(name)
                    entry.size, entry.mode = len(contents), mode
                    package.addfile(entry, io.BytesIO(contents))
            return output.getvalue()

        node = (f'#!{sys.executable}\n' + '''import json, sys
from pathlib import Path
if sys.argv[1:] == ['--version']:
    print('v26.12.1')
else:
    assert sys.argv[1].endswith('/bin/pnpm.mjs')
    native = Path(sys.argv[1]).parent.parent / 'pnpm-native'
    header = bytearray(20)
    header[:6] = b'\\x7fELF\\x02\\x01'
    header[18:20] = (62).to_bytes(2, 'little')
    native.write_bytes(header)
    print('12.15.0' if sys.argv[2:] == ['--version'] else json.dumps(sys.argv[2:]))
''').encode()
        node_archive = archive({'node-v26.12.1-linux-x64/bin/node': (node, 0o755)})
        pnpm_archive = archive({
            'package/pnpm': (b'# native binary placeholder, no shebang\n', 0o755),
            'package/bin/pnpm.mjs': (b'#!/usr/bin/env node\n', 0o644),
        })
        responses = {
            'https://nodejs.org/dist/v26.12.1/SHASUMS256.txt':
                (hashlib.sha256(node_archive).hexdigest() + '  node-v26.12.1-linux-x64.tar.xz\n').encode(),
            'https://nodejs.org/dist/v26.12.1/node-v26.12.1-linux-x64.tar.xz': node_archive,
            'https://registry.npmjs.org/pnpm/-/pnpm-12.15.0.tgz': pnpm_archive,
        }
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary).resolve()
            root = home / '.cache/oc-ty-ext/P6/app-x64-final-r4-v1'
            (root / 'source').mkdir(parents=True)
            (root / 'admission-inputs').mkdir()
            (root / 'prep-receipts/clone').mkdir(parents=True)
            (root / 'manifest.json').write_text('{"files":{}}')
            (root / 'admission-inputs/source-preparation.json').write_text('{"files":{}}')
            (root / 'prep-receipts/clone/result.json').write_text('{"status":"PASS"}')
            (root / 'source/package.json').write_text(json.dumps({
                'packageManager': 'pnpm@12.15.0+sha512.' + hashlib.sha512(pnpm_archive).hexdigest()}))
            check_output = subprocess.check_output

            def probe(args, **kwargs):
                if args[:3] == ['git', 'rev-parse', 'HEAD']:
                    return prep.CUT + '\n'
                if args[:2] == ['git', 'status']:
                    return ''
                return check_output(args, **kwargs)

            with patch.object(Path, 'home', return_value=home), \
                 patch.object(prep.platform, 'system', return_value='Linux'), \
                 patch.object(prep.platform, 'machine', return_value='x86_64'), \
                 patch.object(prep.shutil, 'disk_usage', return_value=type('Disk', (), {'free': 50_000_000_000})()), \
                 patch.object(prep.urllib.request, 'urlopen', side_effect=lambda url, **_: io.BytesIO(responses[url])), \
                 patch.object(prep.subprocess, 'check_output', side_effect=probe), \
                 patch.object(sys, 'argv', ['native-prep.py', '--root', str(root), '--phase', 'toolchain']), \
                 patch.object(sys, 'stdout', io.StringIO()):
                code = prep.main()
            result = json.loads((root / 'prep-receipts/toolchain/result.json').read_text())
            self.assertEqual(code, 0, result)
            self.assertEqual(result['pnpm']['version'], '12.15.0')
            self.assertTrue((root / 'opt/pnpm/pnpm').read_bytes().startswith(b'# '))
            env = {'PATH': str(root / 'opt/node/bin') + ':/usr/bin:/bin'}
            direct = subprocess.run([str(root / 'opt/bin/pnpm'), 'fixture', 'two words', '--flag'],
                                    env=env, capture_output=True, text=True, timeout=5)
            self.assertEqual(direct.stdout.strip(), '["fixture", "two words", "--flag"]')
            self.assertEqual(direct.returncode, 0, direct.stderr)

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
            (work / 'execution.json').write_text(json.dumps({
                'variantSelection': 'all', 'requestedVariants': ['js', 'c2-off', 'ts']}))
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
            original_exists = Path.exists
            def info(path, *args, **kwargs):
                if str(path) == '/dev/kvm':
                    return os.stat_result((stat.S_IFCHR, 0, 0, 1, 0, 0, 0, 0, 0, 0))
                return original_stat(path, *args, **kwargs)
            for codes in [[143], [0, 137], [0, 124], [-9], [0, -15]]:
                with patch.object(guest, 'ROOT', app), patch.object(Path, 'stat', info), \
                     patch.object(Path, 'exists', lambda path: True if str(path) == '/dev/kvm' else original_exists(path)), \
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
            (Path(temporary) / 'execution.json').write_text(json.dumps({
                'variantSelection': 'all', 'requestedVariants': ['js', 'c2-off', 'ts']}))
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


class VariantSelectionContracts(unittest.TestCase):
    def put(self, path, value):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(value))

    def prepared(self, base, mode='js-c2'):
        work, root = base / 'work', base / 'app'
        requested = {'all': ['js', 'c2-off', 'ts'], 'js-c2': ['js', 'c2-off'], 'ts': ['ts']}[mode]
        self.put(work / 'execution.json', {'variantSelection': mode, 'requestedVariants': requested})
        self.put(root / 'prep-receipts/compatibility/result.json', {'status': 'PASS'})
        self.put(work / 'paging-cleanup.json', {'status': 'not-activated'})
        for variant in requested:
            self.put(root / 'build-receipts' / variant / 'result.json', {'status': 'built-unsigned'})
            for phase in module('export').PHASES:
                self.put(root / 'runtime-results' / (variant + '-' + phase) / 'result.json', {'status': 'phase-passed'})
        return work, root

    def test_js_c2_export_is_success_only_for_the_selected_matrix(self):
        export = module('export')
        with tempfile.TemporaryDirectory() as temporary:
            work, root = self.prepared(Path(temporary))
            value = export.summary(work, root)
            self.assertEqual(value['requestedVariants'], ['js', 'c2-off'])
            self.assertEqual(value['unselectedVariants'], ['ts'])
            self.assertTrue(value['scheduledPhasesComplete'])
            self.assertFalse(value['fullVariantMatrixComplete'])
            self.assertEqual(value['variants']['ts'], {'requested': False, 'build': 'not-selected', 'runtime': {}, 'complete': False})
            self.assertFalse(value['applicationQualified'])
            self.assertFalse(value['shipReady'])
            with patch.dict(os.environ, {'P6_WORK': str(work)}), patch.object(export, 'ROOT', root), \
                 patch.object(sys, 'argv', ['export.py']), patch.object(sys, 'stdout', io.StringIO()):
                self.assertEqual(export.main(), 0)
                with patch.object(sys, 'argv', ['export.py', '--require-complete']):
                    self.assertEqual(export.main(), 0)

    def test_selected_failure_or_cleanup_failure_cannot_pass(self):
        export = module('export')
        with tempfile.TemporaryDirectory() as temporary:
            work, root = self.prepared(Path(temporary))
            self.put(root / 'runtime-results/js-core/result.json', {'status': 'failed'})
            self.assertFalse(export.summary(work, root)['scheduledPhasesComplete'])
            self.put(root / 'runtime-results/js-core/result.json', {'status': 'phase-passed'})
            self.put(work / 'paging-cleanup.json', {'operationExitCode': 1})
            self.assertFalse(export.summary(work, root)['scheduledPhasesComplete'])
            self.put(work / 'paging-cleanup.json', {'status': 'not-activated'})
            self.put(work / 'js-skipped.json', {'status': 'not-run', 'reason': 'deadline'})
            self.assertFalse(export.summary(work, root)['scheduledPhasesComplete'])

    def test_all_selection_requires_and_reports_the_full_matrix(self):
        with tempfile.TemporaryDirectory() as temporary:
            work, root = self.prepared(Path(temporary), 'all')
            value = module('export').summary(work, root)
            self.assertTrue(value['scheduledPhasesComplete'])
            self.assertTrue(value['fullVariantMatrixComplete'])
            self.assertEqual(value['unselectedVariants'], [])

    def test_ts_only_export_does_not_require_unselected_js_or_c2(self):
        export = module('export')
        with tempfile.TemporaryDirectory() as temporary:
            work, root = self.prepared(Path(temporary), 'ts')
            value = export.summary(work, root)
            self.assertEqual(value['requestedVariants'], ['ts'])
            self.assertTrue(value['scheduledPhasesComplete'])
            self.assertFalse(value['fullVariantMatrixComplete'])

    def test_invalid_or_missing_selection_does_not_pass_an_empty_matrix(self):
        export = module('export')
        with tempfile.TemporaryDirectory() as temporary:
            work, root = self.prepared(Path(temporary))
            for value in [None, {'variantSelection': 'js-c2', 'requestedVariants': []},
                          {'variantSelection': 'ts', 'requestedVariants': ['js', 'c2-off']}]:
                if value is None:
                    (work / 'execution.json').unlink()
                else:
                    self.put(work / 'execution.json', value)
                result = export.summary(work, root)
                self.assertEqual(result['selectionStatus'], 'missing-or-invalid')
                self.assertFalse(result['scheduledPhasesComplete'])
                self.assertFalse(result['fullVariantMatrixComplete'])
                self.assertIsNone(result['variants']['ts']['requested'])

    def test_unselected_admission_stops_before_preflight_or_output(self):
        admit = module('admit')
        with tempfile.TemporaryDirectory() as temporary:
            work, root = self.prepared(Path(temporary))
            with patch.dict(os.environ, {'P6_WORK': str(work)}), \
                 patch.object(sys, 'argv', ['admit.py', 'ts']), \
                 patch.object(admit, 'verify_completed', side_effect=AssertionError('preflight was reached')):
                with self.assertRaisesRegex(AssertionError, 'not selected'):
                    admit.main()
            self.assertFalse((root / 'admissions').exists())

    def test_ts_only_guest_entry_does_not_probe_or_launch_js_c2(self):
        guest = module('guest')
        with tempfile.TemporaryDirectory() as temporary:
            work, root = self.prepared(Path(temporary), 'ts')
            with patch.dict(os.environ, {'P6_WORK': str(work), 'P6_DEADLINE_EPOCH': str(time.time() + 5000)}), \
                 patch.object(Path, 'exists', side_effect=AssertionError('Unselected guest device was probed')), \
                 patch.object(guest.subprocess, 'run') as run:
                self.assertEqual(guest.main(), 0)
                run.assert_not_called()

    def test_initializer_binds_default_and_explicit_choices_before_resources(self):
        for mode, expected in [(None, ['js', 'c2-off', 'ts']), ('js-c2', ['js', 'c2-off']), ('ts', ['ts'])]:
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as temporary:
                env = {'P6_WORK': temporary, 'GITHUB_REPOSITORY': 'openclaw/bun', 'GITHUB_RUN_ID': '12',
                       'GITHUB_RUN_ATTEMPT': '1', 'GITHUB_JOB': 'linux-x64-app', 'GITHUB_SHA': 'a' * 40}
                if mode is not None:
                    env['P6_APP_VARIANTS'] = mode
                with patch.dict(os.environ, env, clear=True), patch.object(sys, 'argv', ['initialize.py']), \
                     patch('platform.system', return_value='Linux'), patch('platform.machine', return_value='x86_64'), \
                     patch('resource.setrlimit'), patch.object(Path, 'read_text', side_effect=RuntimeError('resource probe reached')):
                    with self.assertRaisesRegex(RuntimeError, 'resource probe reached'):
                        runpy.run_path(str(HERE / 'initialize.py'), run_name='__main__')
                value = json.loads((Path(temporary) / 'execution.json').read_text())
                self.assertEqual(value['requestedVariants'], expected)

    def test_initializer_rejects_invalid_choice_before_execution_record(self):
        for mode in ['', 'js', 'js,c2-off', 'arbitrary']:
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as temporary:
                env = {'P6_WORK': temporary, 'P6_APP_VARIANTS': mode, 'GITHUB_REPOSITORY': 'openclaw/bun',
                       'GITHUB_RUN_ID': '12', 'GITHUB_RUN_ATTEMPT': '1', 'GITHUB_JOB': 'linux-x64-app', 'GITHUB_SHA': 'a' * 40}
                with patch.dict(os.environ, env, clear=True), patch.object(sys, 'argv', ['initialize.py']), \
                     patch('platform.system', return_value='Linux'), patch('platform.machine', return_value='x86_64'), \
                     patch('resource.setrlimit'):
                    with self.assertRaisesRegex(AssertionError, 'variant selection'):
                        runpy.run_path(str(HERE / 'initialize.py'), run_name='__main__')
                self.assertFalse((Path(temporary) / 'execution.json').exists())


if __name__ == '__main__':
    unittest.main()
