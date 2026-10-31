#!/usr/bin/env python3
"""Synthetic fetched-package and CLI evidence; no app, registry or compiler."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
QUALIFICATION = HERE / 'packet/payload/qualification'

FAKE_CLI = '''import json, os, sys
from pathlib import Path
base = Path(__file__).parent
mode = (base / 'mode').read_text()
state = Path(os.environ['OPENCLAW_STATE_DIR'])
assert os.environ['HOME'] == str(state)
assert os.environ['PATH'] == '/usr/bin:/bin'
assert not os.environ.get('P6_TEST_SECRET')
pin = json.loads((base / 'pin.json').read_text())
root = state / 'npm/projects/project/node_modules/@openclaw/msteams'
if sys.argv[1:3] == ['plugins', 'install']:
    assert sys.argv[3:] == [pin['installSpec'], '--accept-capabilities']
    if mode == 'install-failure': sys.exit(23)
    root.mkdir(parents=True)
    (root / 'dist').mkdir()
    (root / 'package.json').write_text(json.dumps({'name':pin['name'],'version':pin['version'],
        'openclaw':{'build':{'runtimeFormat':'cjs'},'runtimeExtensions':['./dist/index.cjs']}}))
    body = (base / 'entry.cjs').read_bytes()
    if mode == 'changed-entry': body += b'// changed\\n'
    (root / 'dist/index.cjs').write_bytes(body)
    if mode == 'different-entry': (root / 'dist/alternate.cjs').write_bytes(body)
    locked = {'version':pin['version'],'integrity':pin['dist']['integrity'],'resolved':pin['dist']['tarball']}
    if mode == 'wrong-integrity': locked['integrity'] = 'sha512-wrong'
    (state / 'npm/projects/project/package-lock.json').write_text(json.dumps({'packages':{'node_modules/@openclaw/msteams':locked}}))
elif sys.argv[1:] == ['plugins','inspect','msteams','--runtime','--json']:
    source = root / ('dist/alternate.cjs' if mode == 'different-entry' else 'dist/index.cjs')
    print(json.dumps({'plugin':{'id':'msteams','packageName':pin['name'],
        'packageVersion':pin['version'],'version':pin['version'],'status':'loaded','imported':True,
        'origin':'global','channelIds':['msteams'],'source':str(source),'rootDir':str(root),
        'dependencyStatus':{'installed':True,'requiredInstalled':True,'missing':[],
        'missingOptional':[],'dependencies':[{'installed':True}]}},'diagnostics':[]}))
else: sys.exit(24)
'''


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


class TeamsAdapter(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.qualification = self.root / 'qualification'
        self.qualification.mkdir()
        shutil.copy2(QUALIFICATION / 'teams-fetched.py', self.qualification)
        shutil.copytree(QUALIFICATION / 'teams-fetched', self.qualification / 'teams-fetched')
        shutil.copy2(HERE / 'packet/payload/runtime-controller.py', self.root)
        self.artifact = self.root / 'admitted-artifact'
        self.artifact.mkdir()
        (self.artifact / 'openclaw').write_text('#!' + sys.executable + '\n' + FAKE_CLI)
        (self.artifact / 'openclaw').chmod(0o755)
        (self.artifact / 'manifest.json').write_text('{}')
        (self.artifact / 'mode').write_text('pass')
        shutil.copy2(QUALIFICATION / 'teams-fetched/pin.json', self.artifact)
        shutil.copy2(HERE / 'test-fixtures/teams-entry.cjs.fixture', self.artifact / 'entry.cjs')
        self.output = self.root / 'qualification-results/js-teams-fetched'
        self.output.mkdir(parents=True)
        (self.root / 'source').mkdir()
        self.proof = self.output / 'input-proof.json'
        self.proof.write_text(json.dumps({'lane':'teams-fetched','performanceEligible':False,
            'source':str(self.root / 'source'),'sourceCommit':'4fa442e332745f1f58ccedd27106abdafcf4e019',
            'variant':'js','artifact':str(self.artifact),'out':str(self.output),
            'binarySha256':sha(self.artifact / 'openclaw'),
            'manifestSha256':sha(self.artifact / 'manifest.json'),'buildReceiptSha256':'0'*64}))

    def execute(self, mode='pass'):
        (self.artifact / 'mode').write_text(mode)
        result = subprocess.run([sys.executable, '-B', str(self.qualification / 'teams-fetched.py'), str(self.proof)],
            env={**os.environ, 'P6_TEST_SECRET':'must-not-reach-child'}, capture_output=True, text=True, timeout=15)
        report = self.output / 'run/result.json'
        return result, json.loads(report.read_text()) if report.exists() else None

    def test_fetched_cjs_requires_install_inspect_original_assertion_and_exact_entry(self):
        before = {path.name:sha(path) for path in self.artifact.iterdir() if path.is_file()}
        result, report = self.execute()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(report['pass'])
        self.assertFalse(report['performanceEligible'])
        self.assertEqual([step['name'] for step in report['steps']], ['install','inspect','assert'])
        self.assertTrue(report['cjsBoundary']['source'].endswith('/dist/index.cjs'))
        self.assertEqual(report['cjsBoundary']['sha256'], '7b5ba63fb0abc15c606c95b165e50e09bb31c37036489781cfcca685ae1d79dd')
        self.assertEqual({path.name:sha(path) for path in self.artifact.iterdir() if path.is_file()}, before)

    def test_nonzero_install_does_not_run_inspection(self):
        result, report = self.execute('install-failure')
        self.assertEqual(result.returncode, 23, result.stderr)
        self.assertFalse(report['pass'])
        self.assertEqual([step['name'] for step in report['steps']], ['install'])
        self.assertFalse((self.output / 'run/inspect').exists())

    def test_loaded_global_report_does_not_hide_wrong_cjs_source_or_bytes(self):
        for mode in ['different-entry','changed-entry']:
            with self.subTest(mode=mode):
                if (self.output / 'run').exists(): shutil.rmtree(self.output / 'run')
                result, report = self.execute(mode)
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse(report['pass'])
                self.assertEqual(json.loads((self.output / 'run/verification.json').read_text())['status'], 'passed')
                self.assertNotIn('cjsBoundary', report)

    def test_original_assertion_rejects_wrong_registry_integrity(self):
        result, report = self.execute('wrong-integrity')
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(report['pass'])
        self.assertEqual(json.loads((self.output / 'run/verification.json').read_text())['status'], 'failed')

    def test_changed_admitted_binary_rejected_before_effect(self):
        with (self.artifact / 'openclaw').open('a') as stream: stream.write('\n# changed\n')
        result, report = self.execute()
        self.assertNotEqual(result.returncode, 0)
        self.assertIsNone(report)
        self.assertFalse((self.output / 'run').exists())

    def test_existing_output_is_never_overwritten(self):
        (self.output / 'run').mkdir()
        sentinel = self.output / 'run/sentinel'
        sentinel.write_text('retain')
        result, report = self.execute()
        self.assertNotEqual(result.returncode, 0)
        self.assertIsNone(report)
        self.assertEqual(sentinel.read_text(), 'retain')


class FollowOnScheduling(unittest.TestCase):
    def load(self, name):
        spec = importlib.util.spec_from_file_location('teams_test_' + name, HERE / (name + '.py'))
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    def test_public_pin_is_the_recorded_path_only_projection(self):
        fixture = QUALIFICATION / 'teams-fetched'
        projection = json.loads((fixture / 'provenance.json').read_text())['pinProjection']
        pin = json.loads((fixture / 'pin.json').read_text())
        self.assertEqual(projection['originalSha256'], 'f7225212c61579fe184ec455d733474ceee0734d17cf4e2c4516225c49fb182f')
        self.assertEqual(projection['omittedFields'], ['historicalP0Lock.path'])
        self.assertEqual(projection['projectedSha256'], sha(fixture / 'pin.json'))
        self.assertNotIn('path', pin['historicalP0Lock'])
        self.assertEqual(pin['installSpec'], 'npm:@openclaw/msteams@2026.10.7')
        self.assertEqual(pin['dist']['shasum'], '344b7d91a9406c93f3472f6ae9d7154ab101aa7d')

    def test_replay_requires_the_original_qualified_compiler_pin(self):
        module = self.load('teams-replay')
        compiler = {'profile':'cb-standard', 'sha256':'a'*64, 'cohort':'rd-p6-150c',
            'bunCommit':'150c9620c53710060186b8b0cd50985e035408b0',
            'webkitCommit':'aaa690bfbf34c9d50775716ac2fc3c7d0573e0b8',
            'engineFeatures':{'shadowRealm':True,'hardened':False}}
        plan = {'variant':'js','compiler':compiler}
        records = {'status':'native-compilers-adopted-not-app-admitted', 'cb-standard':dict(compiler)}
        pins = {'artifacts':{'cb-standard':{'compilerSha256':'a'*64}}}
        self.assertEqual(module.compiler_binding(plan, records, pins), compiler)
        records['cb-standard']['sha256'] = 'b'*64
        with self.assertRaisesRegex(AssertionError, 'differs'): module.compiler_binding(plan, records, pins)
        records['cb-standard'] = dict(compiler)
        pins['artifacts']['cb-standard']['compilerSha256'] = 'c'*64
        with self.assertRaises(AssertionError): module.compiler_binding(plan, records, pins)

    def test_replay_origin_is_checked_before_any_artifact_adoption(self):
        module = self.load('teams-replay')
        # Transport verification has separate tests; this exercises the adapter's effect ordering.
        for run_id in [200, 100]:
            with self.subTest(run_id=run_id), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                app, helper, download, work = [root / name for name in ['app','helper','download','work']]
                for path in [app, helper, download / 'export/admission-inputs', work, app / 'source', app / 'opt/node/bin']:
                    path.mkdir(parents=True, exist_ok=True)
                (app / 'manifest.json').write_text('{"files":{}}')
                (app / 'admission-inputs').mkdir()
                (app / 'admission-inputs/source-preparation.json').write_text(json.dumps({'sourceTree':'b'*40}))
                node = app / 'opt/node/bin/node'
                node.write_bytes(b'synthetic node identity')
                helper_head = 'a'*40
                original = {'variantSelection':'js-c2','requestedVariants':['js','c2-off']}
                verified = {'status':'exact-completed-app-export-verified','runId':run_id,'sourceCommit':module.CUT}
                stored = {'kind':'untimed-functional-replay','sourceCommit':module.CUT,
                    'originatingAppExport':{**verified,'runId':100}, **original,
                    'helperHead':helper_head,'performanceEligible':False}
                execution_bytes = json.dumps(stored)
                (work / 'execution.json').write_text(execution_bytes)
                (download / 'verification.json').write_text(json.dumps(verified))
                for name in ['pins.json','run.json','artifact.json']:
                    (download / name).write_text('{}')
                (download / 'export/host').mkdir()
                (download / 'export/host/execution.json').write_text(json.dumps(original))
                pins = json.loads((HERE / 'compiler-pins.json').read_text())
                (helper / 'compiler-pins.json').write_text(json.dumps(pins))
                compiler = {'profile':'cb-compat','sha256':pins['artifacts']['cb-compat']['compilerSha256'],
                    'cohort':'rd-p6-150c','bunCommit':'150c9620c53710060186b8b0cd50985e035408b0',
                    'webkitCommit':'aaa690bfbf34c9d50775716ac2fc3c7d0573e0b8',
                    'engineFeatures':{'shadowRealm':False,'hardened':False}}
                (download / 'export/admission-inputs/compiler-records.json').write_text(json.dumps({
                    'status':'native-compilers-adopted-not-app-admitted','cb-compat':compiler}))
                plan = {'variant':'c2','compiler':compiler,'source':str(app / 'source'),
                    'output':str(app / 'artifacts/c2-off'),'buildNode':{'path':str(node),'sha256':sha(node)}}
                paths = {key:download / (key + '.json') for key in ['plan','build','admission','transport','archive']}
                paths['plan'].write_text(json.dumps(plan))
                paths['build'].write_text(json.dumps({'plan':plan}))
                paths['admission'].write_text('{"original":"admission"}')
                paths['transport'].write_text(json.dumps({'nativePlanSha256':sha(paths['plan']),
                    'nativeResultSha256':sha(paths['build']),'archiveSha256':'c'*64}))
                def dump(path, value):
                    with Path(path).open('x') as stream: json.dump(value, stream)
                contract = SimpleNamespace(load=lambda path:json.loads(Path(path).read_text()), sha=sha,
                    dump=dump, verify_export=lambda *_args, **_kwargs:verified,
                    classify=lambda *_args:{'status':'available-pending-native-restoration','paths':paths})
                def restore(args):
                    out = Path(args.out)
                    (out / 'artifact').mkdir(parents=True)
                    (out / 'artifact/identity').write_text('run-' + str(run_id))
                    dump(out / 'verification.json', {'status':'downloaded-and-verified'})
                    return {'status':'downloaded-and-verified'}
                preserve = SimpleNamespace(verify=restore)
                def probe(argv, **_kwargs):
                    if argv[0] != 'git': return 'v26.12.1\n'
                    if argv[-1] == 'HEAD^{tree}': return 'b'*40
                    if argv[-1] == 'HEAD': return module.CUT if argv[2] == str(app / 'source') else helper_head
                    return ''
                with patch.object(module, 'ROOT', app), patch.object(module, 'HERE', helper), \
                     patch.object(module.platform, 'system', return_value='Linux'), \
                     patch.object(module.platform, 'machine', return_value='x86_64'), \
                     patch.object(module, 'module', side_effect=lambda name, _path:contract if name == 'p6_app_transport' else preserve), \
                     patch.object(module.subprocess, 'check_output', side_effect=probe), \
                     patch.object(preserve, 'verify', wraps=restore) as effect, \
                     patch.dict(os.environ, {'P6_WORK':str(work)}), \
                     patch.object(sys, 'argv', ['teams-replay.py','--download',str(download),'--variant','c2-off','--helper-head',helper_head]):
                    if run_id == 200:
                        with self.assertRaisesRegex(AssertionError, 'Replay origin differs'): module.main()
                        effect.assert_not_called()
                        for name in ['artifacts','admissions','build-receipts','teams-replay']:
                            self.assertFalse((app / name).exists(), name)
                    else:
                        self.assertEqual(module.main(), 0)
                        self.assertEqual((app / 'artifacts/c2-off/identity').read_text(), 'run-100')
                        self.assertEqual((app / 'admissions/c2-off.json').read_bytes(), paths['admission'].read_bytes())
                        self.assertEqual((app / 'build-receipts/c2-off/result.json').read_bytes(), paths['build'].read_bytes())
                self.assertEqual((work / 'execution.json').read_text(), execution_bytes)

    def test_selected_variant_short_budget_is_recorded_without_execution(self):
        module = self.load('teams')
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            work = root / 'work'
            work.mkdir()
            (root / 'qualification/teams-fetched').mkdir(parents=True)
            shutil.copy2(QUALIFICATION / 'teams-fetched/budget.json', root / 'qualification/teams-fetched')
            (work / 'execution.json').write_text(json.dumps({'variantSelection':'js-c2', 'requestedVariants':['js','c2-off']}))
            with patch.object(module, 'ROOT', root), patch.dict(os.environ, {'P6_WORK':str(work), 'P6_DEADLINE_EPOCH':'1'}), \
                 patch.object(sys, 'argv', ['teams.py','--variant','js']), patch.object(module.subprocess, 'run') as run:
                self.assertEqual(module.main(), 0)
                run.assert_not_called()
            self.assertEqual(json.loads((work / 'js-teams-fetched-skipped.json').read_text())['status'], 'not-run')
            with patch.object(module, 'ROOT', root), patch.dict(os.environ, {'P6_WORK':str(work)}), \
                 patch.object(sys, 'argv', ['teams.py','--variant','ts']), patch.object(module.subprocess, 'run') as run:
                with self.assertRaisesRegex(AssertionError, 'not selected'): module.main()
                run.assert_not_called()

    def test_export_rejects_a_pass_from_a_different_artifact(self):
        module = self.load('export')
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            build = root / 'build.json'
            build.write_text(json.dumps({'status':'built-unsigned','phase':'complete',
                'artifact':{'executable':{'sha256':'a'*64},'manifestSha256':'b'*64}}))
            output = root / 'runtime-results/js-teams-fetched'
            output.mkdir(parents=True)
            (root / 'js-teams-fetched-deadline.json').write_text(json.dumps({'exitCode':0, 'timedOut':False, 'interruptedBySignal':None, 'finishedBeforeReserve':True}))
            receipt = {'status':'phase-passed','variant':'js','sourceCommit':'4fa442e332745f1f58ccedd27106abdafcf4e019',
                'binarySha256':'c'*64,'manifestSha256':'b'*64,'actualBuildReceiptSha256':sha(build)}
            (output / 'result.json').write_text(json.dumps(receipt))
            self.assertEqual(module.follow_on_status(root, root, 'js', 'teams-fetched', build), 'invalid-build-binding')
            receipt['binarySha256'] = 'a'*64
            (output / 'result.json').write_text(json.dumps(receipt))
            self.assertEqual(module.follow_on_status(root, root, 'js', 'teams-fetched', build), 'phase-passed')
            for outer in [None, {'exitCode':124, 'timedOut':True, 'interruptedBySignal':None, 'finishedBeforeReserve':False}, {'exitCode':143, 'timedOut':False, 'interruptedBySignal':15, 'finishedBeforeReserve':True}]:
                deadline = root / 'js-teams-fetched-deadline.json'
                if outer is None: deadline.unlink()
                else: deadline.write_text(json.dumps(outer))
                self.assertEqual(module.follow_on_status(root, root, 'js', 'teams-fetched', build), 'failed-or-missing-outer-receipt')
            (root / 'js-teams-fetched-deadline.json').write_text(json.dumps({'exitCode':0, 'timedOut':False, 'interruptedBySignal':None, 'finishedBeforeReserve':True}))
            skipped = root / 'js-teams-fetched-skipped.json'
            skipped.write_text('{"status":"not-run"}')
            self.assertEqual(module.follow_on_status(root, root, 'js', 'teams-fetched', build), 'failed-or-missing-outer-receipt')
            skipped.unlink()
            receipt['actualBuildReceiptSha256'] = 'd'*64
            (output / 'result.json').write_text(json.dumps(receipt))
            self.assertEqual(module.follow_on_status(root, root, 'js', 'teams-fetched', build), 'invalid-build-binding')


if __name__ == '__main__':
    unittest.main()
