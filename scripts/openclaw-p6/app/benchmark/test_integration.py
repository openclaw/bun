#!/usr/bin/env python3
"""Synthetic contracts for the workflow integration, without native execution."""
import importlib.util
import json
import os
import shutil
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

INIT, HOST, EXPORT, REQUALIFY = module('initialize'), module('host'), module('export'), module('requalify')
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
        def cleanup():
            seen.append('children-cleanup')
            return reconciliation
        with patch.dict(os.environ, {'P6_WORK': '/synthetic/work'}):
            result = HOST.sequence(phase, reconcile, cleanup)
        return result, seen

    def test_complete_sequence(self):
        code, seen = self.run_sequence()
        self.assertEqual(code, 0)
        self.assertLess(seen.index('requalification'), seen.index('children-cleanup'))
        self.assertLess(seen.index('children-cleanup'), seen.index('backup-untimed'))
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
        for fail, code in [('requalification', 124), ('requalification', 143), ('backup-untimed', 124), ('backup-untimed', 143),
                           ('functional', 1), ('budget', 78), ('cohort', 137)]:
            result, seen = self.run_sequence(fail, code)
            self.assertEqual(result, code)
            self.assertEqual(seen[-1], fail)

    def test_failed_requalification_keeps_comparator_after_cleanup(self):
        code, seen = self.run_sequence('requalification', 1)
        self.assertEqual(code, 0)
        self.assertIn('children-cleanup', seen)
        self.assertIn('functional', seen)
        self.assertIn('cohort', seen)

    def test_replay_receipts_and_terminal_failure(self):
        for failure, exit_code in [(None, 0), ('js-only',0), ('js-docker-gateway-network', 1),
                                   ('js-docker-image', 1), ('js-node-vm-native-workers', 143)]:
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as tmp:
                root, work = Path(tmp)/'root', Path(tmp)/'work'
                work.mkdir()
                def put(path, value):
                    path.parent.mkdir(parents=True, exist_ok=True)
                    path.write_text(json.dumps(value))
                put(work/'execution.json', {'sourceCommit':EXPORT.CUT, 'identity':{'job':'linux-x64-benchmark'}})
                put(root/'benchmark-prep/availability.json', {'sourceCommit':EXPORT.CUT,
                    'sourceAppExport':{'runId':11}, 'availableVariants':['js'] if failure == 'js-only' else ['js','c2-off'],
                    'variants':{v:{'status':'artifact-restored-original-core-qualified'} for v in ['js','c2-off']}})
                for variant in ['js','c2-off']:
                    put(root/'admissions'/(variant+'.json'), {'variant':variant})
                    put(root/'build-receipts'/variant/'result.json', {'variant':variant})
                called = []
                def invoke(command):
                    variant, phase = command[command.index('--variant')+1], command[command.index('--phase')+1]
                    label = variant+'-'+phase
                    called.append(label)
                    code = exit_code if label == failure else 0
                    put(root/'runtime-results'/label/'result.json', {'sourceCommit':EXPORT.CUT,
                        'variant':variant, 'phase':phase, 'status':'phase-passed' if code == 0 else 'phase-failed',
                        'rootBuildAdmissionSha256':REQUALIFY.sha(root/'admissions'/(variant+'.json')),
                        'actualBuildReceiptSha256':REQUALIFY.sha(root/'build-receipts'/variant/'result.json')})
                    return code
                code = REQUALIFY.replay(root, work, invoke)
                result = REQUALIFY.load(root/'benchmark-prep/requalification.json')
                self.assertEqual(code, 0 if failure in [None,'js-only'] else exit_code)
                self.assertEqual(result['status'], 'phases-passed-pending-cleanup' if failure in [None,'js-only'] else 'failed')
                self.assertFalse(result['applicationBuildStarted'])
                if failure == 'js-only':
                    self.assertEqual(result['requiredPhaseCount'],4)
                    self.assertEqual(result['unavailableVariants'],['c2-off'])
                    self.assertEqual(result['phases'][-1],{'variant':'c2-off','status':'artifact-unavailable'})
                if failure == 'js-docker-image':
                    self.assertNotIn('js-docker-gateway-network', called)
                    self.assertIn('c2-off-docker-kitchen-sink', called)
                if exit_code == 143:
                    self.assertEqual(called, ['js-node-vm-native-workers'])
                if failure == 'js-docker-gateway-network':
                    self.assertIn('js-docker-kitchen-sink', called)
                    self.assertIn('c2-off-docker-kitchen-sink', called)

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
            put(prep/'work/js-knowledge/knowledge/result.json', '{}')
            for relative in ['work/installed/secret', 'work/home/secret', 'work/cache/secret',
                             'package-source/secret', 'work/js-core/home/secret',
                             'work/js-core/tmp/secret', 'work/cohort/controller-home/secret']:
                put(prep/relative)
            put(root/'backup-results/js/state/secret')
            put(root/'backup-results/js/result.json', '{}')
            put(root/'runtime-results/js-docker-kitchen-sink/raw-evidence.tar.gz', 'synthetic raw archive')
            EXPORT.export(work, root)
            paths = [r['path'] for r in json.loads((work/'benchmark-export/index.json').read_text())]
            self.assertIn('work/js-core/result.json', paths)
            self.assertIn('work/js-core/logs/gateway.stdout', paths)
            self.assertIn('work/js-knowledge/knowledge/result.json', paths)
            self.assertIn('backup-results/js/result.json', paths)
            self.assertIn('requalification/runtime-results/js-docker-kitchen-sink/raw-evidence.tar.gz', paths)
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
            self.assertFalse(EXPORT.summary(work, root)['scheduledWorkComplete'])
            put(root/'benchmark-prep/work/knowledge-controls.json', {'status':'passed','sourceCommit':EXPORT.CUT})
            self.assertFalse(EXPORT.summary(work, root)['scheduledWorkComplete'])
            put(root/'benchmark-prep/requalification.json', {'status':'phases-passed-pending-cleanup'})
            self.assertFalse(EXPORT.summary(work, root)['scheduledWorkComplete'])
            put(work/'requalification-child-cleanup.json', {'status':'children-removed',
                'identity':identity,'executionSha256':EXPORT.sha(work/'execution.json'),'forcedRecovery':True})
            self.assertFalse(EXPORT.summary(work, root)['scheduledWorkComplete'])
            self.assertEqual(EXPORT.summary(work, root)['untimedRequalification']['status'],'failed')
            put(work/'requalification-child-cleanup.json', {'status':'children-removed',
                'identity':identity,'executionSha256':EXPORT.sha(work/'execution.json'),'forcedRecovery':False})
            self.assertTrue(EXPORT.summary(work, root)['scheduledWorkComplete'])
            put(root/'benchmark-prep/work/knowledge-controls.json', {'status':'failed','sourceCommit':EXPORT.CUT})
            self.assertFalse(EXPORT.summary(work, root)['scheduledWorkComplete'])
            put(root/'benchmark-prep/work/knowledge-controls.json', {'status':'passed','sourceCommit':EXPORT.CUT})
            put(root/'backup-results/summary.json', {'status':'failed'})
            self.assertFalse(EXPORT.summary(work, root)['scheduledWorkComplete'])
            put(root/'backup-results/summary.json', {'status':'passed'})
            put(root/'benchmark-prep/requalification.json', {'status':'failed'})
            self.assertFalse(EXPORT.summary(work, root)['scheduledWorkComplete'])
            put(root/'benchmark-prep/requalification.json', {'status':'phases-passed-pending-cleanup'})
            put(work/'terminal.json', {'exitCode':124})
            self.assertFalse(EXPORT.summary(work, root)['scheduledWorkComplete'])

class PackageCloneContracts(unittest.TestCase):
    def run_guard(self, clone, script=None):
        script = (HERE/'payload/prepare-package.sh').read_text() if script is None else script
        code = script.split('python3 - "$here/package-source" <<\'PY\'\n',1)[1].split('\nPY\n',1)[0]
        return subprocess.run([sys.executable,'-B','-c',code,str(clone)],capture_output=True,text=True)

    def fixture(self, root):
        source=root/'canonical';boundary=source/'.artifacts/extension-package-boundary'
        (boundary/'plugins/matrix').mkdir(parents=True)
        external=root/'external-dependencies';external.mkdir()
        (external/'sentinel').write_text('unchanged')
        (boundary/'plugins/matrix/node_modules').symlink_to(external,target_is_directory=True)
        (source/'package.json').write_text('{"fixture":true}')
        clone=root/'package-source'
        shutil.copytree(source,clone,symlinks=True)
        return source,clone,external

    def test_preserves_only_private_boundary_and_keeps_canonical_source(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp).resolve();source,clone,external=self.fixture(root)
            result=self.run_guard(clone)
            self.assertEqual(result.returncode,0,result.stderr)
            self.assertFalse((clone/'.artifacts/extension-package-boundary').exists())
            preserved=root/'package-boundary-preserved/plugins/matrix/node_modules'
            self.assertTrue(preserved.is_symlink())
            self.assertEqual(preserved.resolve(),external)
            self.assertTrue((source/'.artifacts/extension-package-boundary/plugins/matrix/node_modules').is_symlink())
            self.assertEqual((source/'package.json').read_bytes(),(clone/'package.json').read_bytes())
            self.assertEqual((external/'sentinel').read_text(),'unchanged')

    def test_other_external_links_still_fail_after_boundary_preservation(self):
        for relative in ['extensions/other/node_modules','dist/other-link']:
            with self.subTest(relative=relative),tempfile.TemporaryDirectory() as tmp:
                root=Path(tmp).resolve();source,clone,external=self.fixture(root)
                link=clone/relative;link.parent.mkdir(parents=True);link.symlink_to(external,target_is_directory=True)
                result=self.run_guard(clone)
                self.assertNotEqual(result.returncode,0)
                self.assertIn('Private package clone has external link: '+str(link),result.stderr)

    def test_symlinked_boundary_ancestor_and_existing_preservation_are_rejected(self):
        for shape in ['ancestor','boundary','destination']:
            with self.subTest(shape=shape),tempfile.TemporaryDirectory() as tmp:
                root=Path(tmp).resolve();source,clone,external=self.fixture(root)
                if shape=='destination':
                    (root/'package-boundary-preserved').mkdir()
                else:
                    path=clone/('.artifacts' if shape=='ancestor' else '.artifacts/extension-package-boundary')
                    shutil.rmtree(path);path.symlink_to(external,target_is_directory=True)
                result=self.run_guard(clone)
                self.assertNotEqual(result.returncode,0)
                self.assertEqual((external/'sentinel').read_text(),'unchanged')
                self.assertTrue((source/'.artifacts/extension-package-boundary/plugins/matrix/node_modules').is_symlink())

    def test_absent_boundary_keeps_internal_links_and_creates_no_preservation(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp).resolve();clone=root/'package-source';(clone/'node_modules').mkdir(parents=True)
            (clone/'internal-link').symlink_to(clone/'node_modules',target_is_directory=True)
            result=self.run_guard(clone)
            self.assertEqual(result.returncode,0,result.stderr)
            self.assertTrue((clone/'internal-link').is_symlink())
            self.assertFalse((root/'package-boundary-preserved').exists())


if __name__ == '__main__':
    unittest.main()
