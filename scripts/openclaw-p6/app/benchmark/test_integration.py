#!/usr/bin/env python3
"""Synthetic contracts for the workflow integration, without native execution."""
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import subprocess
import sys
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent

def module(name):
    spec = importlib.util.spec_from_file_location('benchmark_' + name, HERE / (name + '.py'))
    loaded = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(loaded)
    return loaded

INIT, HOST, EXPORT = module('initialize'), module('host'), module('export')
BASE_ENV = {'GITHUB_REPOSITORY': 'openclaw/bun', 'GITHUB_RUN_ID': '22', 'GITHUB_RUN_ATTEMPT': '1',
            'GITHUB_JOB': 'linux-x64-benchmark', 'GITHUB_SHA': 'b'*40, 'P6_APP_REPOSITORY_ID': '9',
            'P6_APP_RUN_ID': '11', 'P6_APP_RUN_ATTEMPT': '2', 'P6_APP_WORKFLOW_ID': '8',
            'P6_APP_WORKFLOW_HEAD': 'a'*40, 'P6_APP_ARTIFACT_ID': '10',
            'P6_APP_ARTIFACT_NAME': 'p6-linux-x64-app-'+'a'*40+'-attempt2',
            'P6_APP_ZIP_SHA256': 'c'*64, 'P6_APP_ZIP_BYTES': '4096'}

class Contracts(unittest.TestCase):
    def test_exact_inputs_and_fresh_execution(self):
        self.assertEqual(INIT.app_inputs(BASE_ENV)['runAttempt'], 2)
        for key, value in [('P6_APP_RUN_ID', ''), ('P6_APP_RUN_ATTEMPT', '0'),
                           ('P6_APP_RUN_ID', '22'), ('P6_APP_ZIP_BYTES', 'NaN'),
                           ('P6_APP_ARTIFACT_NAME', 'wrong'), ('P6_APP_ZIP_SHA256', 'x'*64),
                           ('P6_APP_WORKFLOW_HEAD', 'a'*39), ('GITHUB_JOB', 'linux-x64-app')]:
            with self.subTest(key=key, value=value), self.assertRaises((AssertionError, ValueError)):
                INIT.app_inputs({**BASE_ENV, key: value})

    def test_input_cli_rejects_unbound_or_shell_text(self):
        with tempfile.TemporaryDirectory() as tmp:
            marker = Path(tmp)/'injected'
            env = {**os.environ, **BASE_ENV, 'P6_WORK': str(Path(tmp)/'work'),
                   'P6_APP_RUN_ID': '$(touch '+str(marker)+')'}
            run = subprocess.run([sys.executable, '-B', str(HERE/'initialize.py'), 'inputs'],
                                 env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            self.assertNotEqual(run.returncode, 0)
            self.assertFalse(marker.exists())
            self.assertFalse((Path(tmp)/'work/app-inputs.json').exists())

    def run_sequence(self, failed=None, code=1, reconciliation=0):
        seen = []
        def phase(name, command):
            seen.append(name)
            self.assertNotIn('/p6-recipe/app/variant.sh', command)
            self.assertNotIn('paging', command)
            return code if name == failed else 0
        def reconcile(only):
            seen.append('reconcile' if only else 'quiet')
            return reconciliation
        with patch.dict(os.environ, {'P6_WORK': '/synthetic/work'}):
            result = HOST.sequence(phase, reconcile)
        return result, seen

    def test_complete_sequence(self):
        code, seen = self.run_sequence()
        self.assertEqual(code, 0)
        self.assertLess(seen.index('backup-untimed'), seen.index('reconcile'))
        self.assertLess(seen.index('budget'), seen.index('quiet'))
        self.assertEqual(seen[-3:], ['window', 'cohort', 'summary'])

    def test_backup_failure_continues_only_after_reconciliation(self):
        code, seen = self.run_sequence('backup-untimed', 1)
        self.assertEqual(code, 0)
        self.assertIn('functional', seen)
        code, seen = self.run_sequence('backup-untimed', 1, 1)
        self.assertEqual(code, 1)
        self.assertNotIn('functional', seen)

    def test_terminal_and_insufficient_budget_never_continue(self):
        for fail, code in [('backup-untimed', 124), ('backup-untimed', 143),
                           ('functional', 1), ('budget', 78), ('cohort', 137)]:
            result, seen = self.run_sequence(fail, code)
            self.assertEqual(result, code)
            self.assertEqual(seen[-1], fail)

    def test_signal_normalization(self):
        self.assertEqual(HOST.normalized(-15), 143)
        self.assertTrue(HOST.terminal(HOST.normalized(-9)))
        self.assertFalse(HOST.terminal(78))

    def test_export_excludes_installed_home_cache_and_package_source(self):
        with tempfile.TemporaryDirectory() as tmp:
            root, work = Path(tmp)/'root', Path(tmp)/'work'
            work.mkdir(); root.mkdir()
            prep = root/'benchmark-prep'
            def put(path, value='synthetic'):
                path.parent.mkdir(parents=True, exist_ok=True); path.write_text(value)
            put(prep/'work/js-core/result.json', '{}')
            put(prep/'work/js-core/logs/gateway.stdout')
            for relative in ['work/installed/secret', 'work/home/secret', 'work/cache/secret',
                             'package-source/secret', 'work/js-core/home/secret',
                             'work/js-core/tmp/secret', 'work/cohort/controller-home/secret']:
                put(prep/relative)
            put(root/'backup-results/js/state/secret')
            put(root/'backup-results/js/result.json', '{}')
            EXPORT.export(work, root)
            paths = [r['path'] for r in json.loads((work/'benchmark-export/index.json').read_text())]
            self.assertIn('work/js-core/result.json', paths)
            self.assertIn('work/js-core/logs/gateway.stdout', paths)
            self.assertIn('backup-results/js/result.json', paths)
            self.assertFalse(any('secret' in p for p in paths))

    def test_export_rejects_symlinked_receipt(self):
        with tempfile.TemporaryDirectory() as tmp:
            root, work = Path(tmp)/'root', Path(tmp)/'work'
            work.mkdir(); (root/'benchmark-prep').mkdir(parents=True)
            (work/'payload').write_text('{}')
            (root/'benchmark-prep/availability.json').symlink_to(work/'payload')
            with self.assertRaises(AssertionError):
                EXPORT.export(work, root)

    def test_backup_failure_and_terminal_are_not_passing_job(self):
        with tempfile.TemporaryDirectory() as tmp:
            root, work = Path(tmp)/'root', Path(tmp)/'work'
            work.mkdir(); root.mkdir()
            def put(path, value):
                path.parent.mkdir(parents=True, exist_ok=True); path.write_text(json.dumps(value))
            identity = INIT.identity(BASE_ENV)
            put(work/'execution.json', {'identity': identity})
            put(work/'benchmark-run.json', {'status':'completed'})
            put(work/'benchmark-cleanup.json', {'status':'owned-workloads-removed', 'identity':identity, 'pagingActivated':False})
            put(root/'benchmark-prep/comparison-summary.json', {'status':'partial-comparison-passed','performanceQualified':True})
            put(root/'backup-results/summary.json', {'status':'passed'})
            self.assertFalse(EXPORT.summary(work, root)['scheduledWorkComplete'])
            put(root/'prep-receipts/compatibility/result.json', {'status':'PASS'})
            self.assertTrue(EXPORT.summary(work, root)['scheduledWorkComplete'])
            put(root/'backup-results/summary.json', {'status':'failed'})
            self.assertFalse(EXPORT.summary(work, root)['scheduledWorkComplete'])
            put(root/'backup-results/summary.json', {'status':'passed'})
            put(work/'terminal.json', {'exitCode':124})
            self.assertFalse(EXPORT.summary(work, root)['scheduledWorkComplete'])

if __name__ == '__main__':
    unittest.main()
