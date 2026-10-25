#!/usr/bin/env python3
"""Exercise the real controller with synthetic facts and small fixture processes."""
import contextlib
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent


def load_owner():
    spec = importlib.util.spec_from_file_location('runtime_owner', HERE / 'packet/payload/runtime-controller.py')
    owner = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(owner)
    return owner


class RuntimeTerminal(unittest.TestCase):
    def run_fixture(self, body, *, phase='core', variant='js', timeout=None):
        owner = load_owner()
        native_root = owner.ROOT
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            owner.ROOT = owner.HERE = root
            for name in ['admissions', 'build-receipts/' + variant, 'artifacts/' + variant,
                         'qualification', 'guest', 'guest-prerequisites/native', 'tmp',
                         'qualification-results/' + variant + '-core/run']:
                (root / name).mkdir(parents=True, exist_ok=True)
            (root / 'opt/node/bin').mkdir(parents=True)
            (root / 'opt/node/bin/node').symlink_to(shutil.which('node'))
            (root / 'qualification/harness').mkdir()
            shutil.copyfile(HERE / 'shared/process-stop.mjs', root / 'qualification/harness/process-stop.mjs')
            (root / 'source').mkdir()
            (root / 'source/gateway-shutdown-budget.mjs').write_text(
                'export const GATEWAY_SHUTDOWN_TIMEOUT_MS=325000;\n'
                'export const GATEWAY_SERVICE_STOP_TIMEOUT_MS=330000;\n')
            (root / 'manifest.json').write_text('{"files":{}}')
            admission = root / 'admissions' / (variant + '.json')
            admission.write_text(json.dumps({'decision': 'build-linux', 'linuxCut': {
                'commit': '4fa442e332745f1f58ccedd27106abdafcf4e019'}}))
            digest = hashlib.sha256(admission.read_bytes()).hexdigest()
            build = {'status': 'built-unsigned', 'phase': 'complete', 'plan': {
                'admissionSha256': digest, 'variant': 'c2' if variant == 'c2-off' else variant,
                'compiler': {'cohort': 'rd-p6-150c'}, 'output': str(root / 'artifacts' / variant)},
                'artifact': {'executable': {'sha256': '0' * 64}, 'manifestSha256': '0' * 64}}
            (root / 'build-receipts' / variant / 'result.json').write_text(json.dumps(build))
            if phase == 'guest-security':
                (root / 'guest-prerequisites/native/result.json').write_text('{}')
                (root / 'qualification-results' / (variant + '-core') / 'run/result.json').write_text('{}')
                (root / 'guest/prepare-guest.py').write_text(body)
            else:
                (root / 'qualification/qualify.py').write_text(body)
            old_cwd = Path.cwd()
            original_run = owner.run_command
            try:
                os.chdir(root)
                with contextlib.ExitStack() as stack:
                    stack.enter_context(patch.object(owner.platform, 'system', return_value='Linux'))
                    stack.enter_context(patch.object(owner.platform, 'machine', return_value='x86_64'))
                    stack.enter_context(patch.object(sys, 'argv', ['runtime-controller.py', '--variant',
                        variant, '--phase', phase, '--admission-sha256', digest]))
                    stack.enter_context(contextlib.redirect_stdout(io.StringIO()))
                    if timeout is not None:
                        stack.enter_context(patch.object(owner, 'run_command',
                            lambda command, cwd, env, directory, _, cleanup_grace=15:
                                original_run(command, cwd, env, directory, timeout, cleanup_grace)))
                    code = owner.main()
                result = json.loads((root / 'runtime-results' / (variant + '-' + phase) / 'result.json').read_text())
                label = (root / 'observed-label').read_text() if (root / 'observed-label').exists() else None
                return code, result, label, native_root
            finally:
                os.chdir(old_cwd)

    def test_signal_is_not_normalized_to_ordinary_failure(self):
        for signal in ['SIGTERM', 'SIGKILL']:
            code, result, _, _ = self.run_fixture('import os,signal\nos.kill(os.getpid(),signal.' + signal + ')\n')
            self.assertEqual(code, 128 - result['commandResult']['exitCode'])
            self.assertGreaterEqual(code, 128)

    def test_timeout_is_terminal(self):
        code, result, _, _ = self.run_fixture('import time\ntime.sleep(30)\n', timeout=0.05)
        self.assertEqual(code, 124)
        self.assertTrue(result['commandResult']['timeout'])

    def test_ordinary_failure_remains_ordinary(self):
        code, _, _, _ = self.run_fixture('raise SystemExit(23)\n')
        self.assertEqual(code, 1)

    def test_c2_guest_qmp_path_fits_linux(self):
        body = "import json,sys\nfrom pathlib import Path\nlabel=sys.argv[sys.argv.index('--label')+1]\nPath('observed-label').write_text(label)\nprint(json.dumps({'status':'prepared-not-authorized-to-execute','guestShell':'true\\n'}))\n"
        code, _, label, root = self.run_fixture(body, phase='guest-security', variant='c2-off')
        self.assertEqual(code, 0)
        self.assertLessEqual(len(os.fsencode(root / 'application-guest-runs' / label / 'qmp.sock')), 107)


if __name__ == '__main__':
    unittest.main()
