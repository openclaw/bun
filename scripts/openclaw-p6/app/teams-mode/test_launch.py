#!/usr/bin/env python3
"""Synthetic launch-boundary proof; no Docker, network, app, or compiler."""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import common


def module(name):
    spec = importlib.util.spec_from_file_location('teams_launch_' + name, HERE / (name + '.py'))
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


HOST = module('host')
EXPORT = module('export')
INITIALIZE = module('initialize')
BUDGET = common.load(HERE.parent / 'packet/payload/qualification/teams-fetched/budget.json')


class Launch(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.base = Path(temp.name)
        self.work = self.base / 'work'
        self.root = self.base / 'root'
        self.work.mkdir()
        self.root.mkdir()
        self.env = {'P6_WORK': str(self.work), 'P6_EXECUTION_MODE': 'teams', 'P6_APP_VARIANTS': 'js-c2',
            'GITHUB_REPOSITORY': 'openclaw/bun', 'GITHUB_REF': 'refs/heads/openclaw/aot-rd-P6',
            'GITHUB_RUN_ID': '200', 'GITHUB_RUN_ATTEMPT': '1', 'GITHUB_JOB': 'linux-x64-teams',
            'GITHUB_SHA': 'b' * 40, 'P6_APP_RUN_ID': '100', 'P6_APP_RUN_ATTEMPT': '2',
            'P6_APP_WORKFLOW_HEAD': 'a' * 40, 'P6_APP_WORKFLOW_ID': '12', 'P6_APP_REPOSITORY_ID': '13',
            'P6_APP_ARTIFACT_ID': '14', 'P6_APP_ARTIFACT_NAME': 'p6-linux-x64-app-' + 'a' * 40 + '-attempt2',
            'P6_APP_ZIP_SHA256': 'c' * 64, 'P6_APP_ZIP_BYTES': '1000',
            'P6_CONTAINER': 'synthetic-teams', 'P6_DEADLINE_EPOCH': '10000'}

    def write(self, path, value):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(value))

    def initialize(self):
        with patch.dict(os.environ, self.env, clear=True), patch.object(sys, 'argv', ['initialize.py', 'inputs']):
            INITIALIZE.main()
        return common.current(self.work)

    def origin(self):
        execution = self.initialize()
        pins = common.load(self.work / 'app-inputs.json')
        download = common.download_dir(self.work)
        verified = {'status': 'exact-completed-app-export-verified', 'sourceCommit': common.CUT,
            'workflowHead': pins['headSha'], 'runId': pins['runId'], 'runAttempt': pins['runAttempt'],
            'artifactId': pins['artifact']['id'], 'artifactZipSha256': pins['artifact']['zipSha256']}
        self.write(download / 'pins.json', pins)
        self.write(download / 'verification.json', verified)
        self.write(download / 'export/host/execution.json', {'sourceCommit': common.CUT,
            'workflowHead': pins['headSha'], **common.select_variants('js-c2')})
        return execution, verified

    def complete(self):
        execution, verified = self.origin()
        digest = common.sha(self.work / 'teams-execution.json')
        self.write(self.work / 'execution.json', {'kind': 'untimed-functional-replay', 'sourceCommit': common.CUT,
            'helperHead': execution['workflowHead'], 'originatingAppExport': verified})
        self.write(self.work / 'teams-cleanup.json', {'status': 'owned-workloads-removed',
            'identity': execution['identity'], 'executionSha256': digest, 'pagingActivated': False})
        self.write(self.work / 'teams-run.json', {'status': 'completed', 'exitCode': 0,
            'requestedVariants': execution['requestedVariants'], 'executionSha256': digest,
            'originatingAppExport': verified})
        self.write(self.work / 'teams-node.json', {'status': 'official-node-matched'})
        for name in EXPORT.phase_names(execution['requestedVariants']):
            self.write(self.work / 'teams-phases' / (name + '.json'), {'executionSha256': digest, 'exitCode': 0,
                'timedOut': False, 'interruptedBySignal': None, 'finishedBeforeReserve': True, 'launched': True})
        for variant in execution['requestedVariants']:
            build = self.root / 'build-receipts' / variant / 'result.json'
            self.write(build, {'status': 'built-unsigned', 'phase': 'complete',
                'artifact': {'executable': {'sha256': 'd' * 64}, 'manifestSha256': 'e' * 64}})
            self.write(self.root / 'teams-replay' / variant / 'replay-binding.json', {
                'status': 'restored-for-teams-not-runtime-qualified', 'helperHead': execution['workflowHead'],
                'sourceCommit': common.CUT, 'originatingAppExport': verified, 'originalBuildReceiptSha256': common.sha(build)})
            self.write(self.root / 'runtime-results' / (variant + '-teams-fetched') / 'result.json', {
                'status': 'phase-passed', 'variant': variant, 'sourceCommit': common.CUT,
                'binarySha256': 'd' * 64, 'manifestSha256': 'e' * 64, 'actualBuildReceiptSha256': common.sha(build)})
            self.write(self.work / (variant + '-teams-fetched-deadline.json'), {
                'exitCode': 0, 'timedOut': False, 'interruptedBySignal': None, 'finishedBeforeReserve': True})

    def test_inputs_keep_current_identity_separate_from_replay(self):
        execution = self.initialize()
        self.assertEqual(execution['identity']['runId'], '200')
        self.assertEqual(common.load(self.work / 'app-inputs.json')['runId'], 100)
        self.assertFalse((self.work / 'execution.json').exists())
        with self.assertRaises(FileExistsError):
            self.initialize()

    def test_reject_default_all_same_run_and_mixed_pin(self):
        for key, value in [('P6_APP_VARIANTS', 'all'), ('P6_APP_RUN_ID', '200'),
                           ('P6_APP_ARTIFACT_NAME', 'p6-linux-x64-app-wrong-attempt2')]:
            with self.subTest(key=key), patch.dict(os.environ, {**self.env, key: value}, clear=True), \
                    patch.object(sys, 'argv', ['initialize.py', 'inputs']):
                with self.assertRaises(AssertionError):
                    INITIALIZE.main()
                self.assertFalse((self.work / 'teams-execution.json').exists())

    def test_origin_selection_and_metadata_must_match(self):
        self.origin()
        download = common.download_dir(self.work)
        self.assertEqual(download.parent, self.work.parent)
        self.assertFalse(download.is_relative_to(self.work))
        self.assertFalse(self.work.is_relative_to(download))
        common.origin(self.work)
        original = download / 'export/host/execution.json'
        self.write(original, {'sourceCommit': common.CUT, 'workflowHead': 'a' * 40, **common.select_variants('ts')})
        with self.assertRaisesRegex(AssertionError, 'absent from origin'):
            common.origin(self.work)
        self.write(original, {'sourceCommit': common.CUT, 'workflowHead': 'a' * 40, **common.select_variants('all')})
        verified = common.load(download / 'verification.json')
        self.write(download / 'verification.json', {**verified, 'runAttempt': 9})
        with self.assertRaises(AssertionError):
            common.origin(self.work)

    def test_only_selected_replay_and_teams_run_after_prepare(self):
        calls, stopped = [], []
        def phase(name, command, ceiling):
            calls.append((name, command, ceiling))
            return 0
        for selected in [['js', 'c2-off'], ['ts']]:
            calls.clear()
            self.assertEqual(HOST.sequence(phase, selected, 'b' * 40, self.work, lambda: stopped.append(True), BUDGET), 0)
            self.assertEqual([call[0] for call in calls], ['prepare'] + [name for variant in selected for name in ['replay-' + variant, 'teams-' + variant]])
            for name, command, ceiling in calls[1:]:
                self.assertTrue(command[2].startswith('/p6-helper/scripts/openclaw-p6/app/'))
                if name.startswith('replay-'):
                    self.assertEqual(command[4], str(common.download_dir(self.work)))
                else:
                    self.assertEqual(ceiling, 1410)
        self.assertEqual(stopped, [])

    def test_failed_phase_stops_before_next_variant(self):
        calls, stopped = [], []
        def phase(name, command, ceiling):
            calls.append(name)
            return 23 if name == 'teams-js' else 0
        self.assertEqual(HOST.sequence(phase, ['js', 'c2-off'], 'b' * 40, self.work, lambda: stopped.append(True), BUDGET), 23)
        self.assertEqual(calls, ['prepare', 'replay-js', 'teams-js'])
        self.assertEqual(stopped, [True])

    def test_insufficient_selected_window_starts_no_work(self):
        self.origin()
        with patch.dict(os.environ, self.env, clear=True), patch.object(sys, 'argv', ['host.py', 'run']), \
                patch.object(HOST.time, 'time', return_value=9000), patch.object(HOST.subprocess, 'check_output') as inspect, \
                patch.object(HOST, 'sequence') as sequence:
            self.assertEqual(HOST.main(), 78)
            inspect.assert_not_called()
            sequence.assert_not_called()
        self.assertEqual(common.load(self.work / 'teams-run.json')['status'], 'insufficient-window')
        self.assertEqual(HOST.selected_window(['js', 'c2-off'], BUDGET), 5135)

    def test_nested_signal_is_terminal_and_stops_owned_container(self):
        self.origin()
        calls = []
        def run(command, **kwargs):
            calls.append(command)
            return subprocess.CompletedProcess(command, 0)
        bounded = [subprocess.CompletedProcess([], code) for code in [0, 0, -15]]
        def phase(command, **kwargs):
            calls.append(command)
            return bounded.pop(0), {'timedOut': False, 'interruptedBySignal': None,
                'finishedBeforeReserve': True, 'launched': True}
        with patch.dict(os.environ, self.env, clear=True), patch.object(sys, 'argv', ['host.py', 'run']), \
                patch.object(HOST.time, 'time', return_value=1000), \
                patch.object(HOST.subprocess, 'check_output', return_value='200-1\n'), \
                patch.object(HOST.subprocess, 'run', side_effect=run), \
                patch.object(HOST.DEADLINE, 'run_bounded', side_effect=phase):
            self.assertEqual(HOST.main(), 143)
        self.assertTrue(any(command[-2:] == ['terminal', '143'] for command in calls))
        self.assertTrue(any(command[-4:] == ['stop', '--time', '15', 'synthetic-teams'] for command in calls))
        self.assertFalse(any('replay-c2-off' in str(command) or ('--variant' in command and command[-1] == 'c2-off') for command in calls))
        docker_exec = next(command for command in calls if command[:2] == ['docker', 'exec'])
        self.assertIn('GIT_CONFIG_VALUE_0=/p6-helper', docker_exec)
        self.assertIn('-i', docker_exec)
        self.assertEqual(common.load(self.work / 'teams-run.json')['status'], 'failed')

    def test_cleanup_receipt_binds_current_job_and_never_activates_paging(self):
        execution = self.initialize()
        with patch.dict(os.environ, self.env, clear=True), patch.object(sys, 'argv', ['initialize.py', 'cleanup']):
            INITIALIZE.main()
        cleanup = common.load(self.work / 'teams-cleanup.json')
        self.assertEqual(cleanup['identity'], execution['identity'])
        self.assertEqual(cleanup['executionSha256'], common.sha(self.work / 'teams-execution.json'))
        self.assertIs(cleanup['pagingActivated'], False)

    def test_pass_is_selected_untimed_only_and_failures_cannot_be_cleared(self):
        self.complete()
        result = EXPORT.summary(self.work, self.root)
        self.assertTrue(result['teamsWorkComplete'], result)
        for name in ['scheduledPhasesComplete', 'applicationQualified', 'performanceEligible', 'shipReady']:
            self.assertIs(result[name], False)
        paths = [self.work / 'teams-cleanup.json', self.work / 'teams-phases/teams-js.json',
                 self.root / 'runtime-results/js-teams-fetched/result.json']
        for path in paths:
            before = path.read_bytes()
            path.unlink()
            self.assertFalse(EXPORT.summary(self.work, self.root)['teamsWorkComplete'], str(path))
            path.write_bytes(before)
        self.write(self.work / 'teams-terminal.json', {'exitCode': 124})
        self.assertFalse(EXPORT.summary(self.work, self.root)['teamsWorkComplete'])

    def test_export_selects_evidence_without_state_binaries_or_download_zip(self):
        self.complete()
        self.write(self.root / 'state/private.json', {'synthetic': True})
        (common.download_dir(self.work) / 'app.zip').write_bytes(b'synthetic archive')
        selected = list(EXPORT.selections(self.work, self.root, ['js', 'c2-off']))
        self.assertFalse(any('state' in path.parts or path.name == 'app.zip' or 'artifacts' in path.parts for path, _ in selected))
        with patch.dict(os.environ, {'P6_WORK': str(self.work)}, clear=True), patch.object(EXPORT, 'ROOT', self.root), \
                patch.object(sys, 'argv', ['export.py']):
            self.assertEqual(EXPORT.main(), 0)
        exported = self.work / 'teams-export'
        self.assertTrue(common.load(exported / 'summary.json')['teamsWorkComplete'])
        self.assertTrue((exported / 'host/download/verification.json').is_file())
        self.assertFalse((exported / 'host/download/app.zip').exists())

    def test_failed_second_variant_preserves_first_variant_raw_evidence(self):
        self.complete()
        (self.root / 'build-receipts/c2-off/result.json').unlink()
        raw = self.root / 'runtime-results/js-teams-fetched/raw-evidence.tar.gz'
        raw.write_bytes(b'synthetic raw evidence')
        with patch.dict(os.environ, {'P6_WORK': str(self.work)}, clear=True), patch.object(EXPORT, 'ROOT', self.root), \
                patch.object(sys, 'argv', ['export.py']):
            self.assertEqual(EXPORT.main(), 0)
        exported = self.work / 'teams-export'
        summary = common.load(exported / 'summary.json')
        self.assertFalse(summary['teamsWorkComplete'])
        self.assertEqual(summary['requestedVariants'], ['js', 'c2-off'])
        self.assertEqual((exported / 'runtime-results/js-teams-fetched/raw-evidence.tar.gz').read_bytes(), raw.read_bytes())

    def test_shared_host_passes_readonly_helper_download_and_current_execution(self):
        self.origin()
        commands = self.base / 'commands'
        commands.mkdir()
        log = self.base / 'docker.jsonl'
        docker = commands / 'docker'
        docker.write_text('#!' + sys.executable + '\nimport json, os, sys\n'
            'with open(os.environ["P6_TEST_LOG"], "a") as f: f.write(json.dumps(sys.argv[1:]) + "\\n")\n'
            'if sys.argv[1] == "info": print(os.environ["P6_TEST_BUILDX"])\n')
        docker.chmod(0o755)
        for name, content in {'uname': '#!/bin/bash\nif [[ "$1" == -s ]]; then echo Linux; else echo x86_64; fi\n',
                'timeout': '#!/bin/bash\nshift 2; exec "$@"\n', 'python3': '#!/bin/bash\nexit 0\n',
                'buildx': '#!/bin/bash\nexit 0\n'}.items():
            path = commands / name
            path.write_text(content)
            path.chmod(0o755)
        startup = self.base / 'bash-env'
        startup.write_text('mkdir() { if [[ "$*" == *"/home/runner/.cache/oc-ty-ext/P6"* ]]; then return 0; fi; command mkdir "$@"; }\n')
        helper = self.base / 'helper'
        (helper / '.git').mkdir(parents=True)
        env = {**self.env, 'PATH': str(commands) + ':/usr/bin:/bin', 'BASH_ENV': str(startup),
            'P6_TEST_LOG': str(log), 'P6_TEST_BUILDX': str(commands / 'buildx'), 'GITHUB_WORKSPACE': str(helper)}
        bash = '/opt/homebrew/bin/bash' if Path('/opt/homebrew/bin/bash').is_file() else shutil.which('bash')
        result = subprocess.run([bash, str(HERE.parent / 'host.sh'), 'bootstrap'], env=env,
            capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        calls = [json.loads(line) for line in log.read_text().splitlines()]
        self.assertTrue(any(call[0] == 'run' for call in calls), (calls, result.stderr))
        run = next(call for call in calls if call[0] == 'run')
        for mount in [f'type=bind,src={helper},dst=/p6-helper,readonly',
                f'type=bind,src={common.download_dir(self.work)},dst={common.download_dir(self.work)},readonly',
                f'type=bind,src={self.work}/teams-execution.json,dst=/p6-execution.json,readonly']:
            self.assertIn(mount, run)
        self.assertFalse(any('/execution.json,dst=/p6-execution' in arg for arg in run))
        result = subprocess.run([bash, str(HERE.parent / 'host.sh'), 'cleanup'], env=env,
            capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        calls = [json.loads(line) for line in log.read_text().splitlines()]
        self.assertIn(['rm', '-f', 'synthetic-teams'], calls)
        self.assertIn(['ps', '-aq', '--filter', 'name=^synthetic-teams$'], calls)
        self.assertIn(['ps', '-aq', '--filter', 'label=openclaw.p6.actions=200-1'], calls)


if __name__ == '__main__':
    unittest.main()
