#!/usr/bin/env python3
"""Exercise the test-only peer-root adapter and exact nested Docker mount."""
import json
import os
from pathlib import Path
import runpy
import sys
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
ADAPTER = HERE / 'packet/payload/qualification/harness/clawhub-artifact-assertions.mjs'


class Adapter(unittest.TestCase):
    def test_explicit_non_cwd_sdk_root_and_wrong_peer(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            host, wrong, install = root/'runtime', root/'wrong', root/'plugin'
            host.mkdir(); wrong.mkdir(); (install/'node_modules').mkdir(parents=True)
            peer = install/'node_modules/openclaw'
            peer.symlink_to(host, target_is_directory=True)
            # Dependency containment remains delegated to the unchanged source helper.
            (root/'openclaw-state-paths.mjs').write_text(
                'export function assertRealPathInside(){throw new Error("dependency isolation invoked")}')
            shutil.copyfile(ADAPTER, root/'adapter.mjs')
            command = [shutil.which('node'), '--input-type=module', '-e',
                'const m=await import(process.argv[1]); m.assertClawHubExternalInstallContract(process.argv[2], "fixture")',
                (root/'adapter.mjs').as_uri(), str(install)]
            def run(explicit):
                env = {k:v for k,v in os.environ.items() if k != 'OPENCLAW_E2E_HOST_ROOT'}
                if explicit:
                    env['OPENCLAW_E2E_HOST_ROOT'] = str(host)
                return subprocess.run(command, cwd=root, env=env, capture_output=True, text=True)
            self.assertEqual(run(True).returncode, 0)
            self.assertIn('to target '+str(root), run(False).stderr)
            peer.unlink(); peer.symlink_to(wrong, target_is_directory=True)
            self.assertIn('to target '+str(host), run(True).stderr)
            peer.unlink(); peer.symlink_to(host, target_is_directory=True)
            dep = install/'node_modules/is-number/package.json'
            dep.parent.mkdir(); dep.write_text('{}')
            self.assertIn('dependency isolation invoked', run(True).stderr)
            peer.unlink(); peer.mkdir()
            self.assertIn('is not a symlink', run(True).stderr)

    def test_reconciliation_removes_only_owned_children_and_preserves_main(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            docker = root/'docker'
            docker.write_text('#!'+sys.executable+'\n'+"""
import json, os, sys
from pathlib import Path
root=Path(os.environ['P6_WORK']); args=sys.argv[1:]
with (root/'calls').open('a') as f: f.write(json.dumps(args)+'\\n')
if args[0]=='inspect':
    print('22-1' if args[-1]=='owned-main' else json.dumps({'id':'child','running':True,'paused':False,'restarting':False}))
elif args[:2]==['ps','-aq']:
    assert args[2:]==['--filter','label=openclaw.p6.actions=22-1']
    if not (root/'removed-child').exists(): print('child')
elif args[:2]==['network','ls']:
    assert args[2:]==['-q','--filter','label=openclaw.p6.actions=22-1']
    if not (root/'removed-network').exists(): print('network')
elif args==['rm','-f','child']: (root/'removed-child').touch()
elif args==['network','rm','network']: (root/'removed-network').touch()
else: raise SystemExit('unexpected Docker mutation '+repr(args))
""")
            docker.chmod(0o755)
            (root/'execution.json').write_text(json.dumps({'identity':{'job':'linux-x64-benchmark','runId':'22','runAttempt':'1'}}))
            env = {**os.environ, 'PATH':str(root)+os.pathsep+os.environ['PATH'],
                   'P6_WORK':str(root), 'P6_CONTAINER':'owned-main', 'P6_EXECUTION_MODE':'benchmark',
                   'GITHUB_RUN_ID':'22','GITHUB_RUN_ATTEMPT':'1'}
            result = subprocess.run(['bash',str(HERE/'host.sh'),'reconcile-children'],
                                    env=env,capture_output=True,text=True)
            self.assertEqual(result.returncode,0,result.stderr)
            calls=[json.loads(line) for line in (root/'calls').read_text().splitlines()]
            self.assertIn(['rm','-f','child'],calls)
            self.assertIn(['network','rm','network'],calls)
            receipt=json.loads((root/'requalification-child-cleanup.json').read_text())
            self.assertEqual(receipt['status'],'children-removed')
            self.assertTrue(receipt['forcedRecovery'])
            self.assertTrue(receipt['childrenBeforeRemoval'][0]['running'])
            self.assertTrue(all('owned-main' not in args or args[0]=='inspect' for args in calls))

    def test_docker_wrapper_adds_readonly_file_mount_and_owned_label(self):
        identity = {'identity':{'runId':'22','runAttempt':'1'}}
        adapter = '/home/runner/.cache/oc-ty-ext/P6/app-x64-final-r4-v1/qualification/harness/clawhub-artifact-assertions.mjs'
        for value in [None, adapter]:
            env = {} if value is None else {'P6_DOCKER_CLAWHUB_ASSERTIONS':value,'P6_DOCKER_CLAWHUB_IMAGE':'image'}
            with self.subTest(adapter=value), patch.dict(os.environ, env, clear=True), \
                 patch('sys.argv', ['docker-client.py','run','-v','source:/app/scripts:ro','image','bash']), \
                 patch.object(Path,'read_text',return_value=json.dumps(identity)), \
                 patch('os.execv') as launch:
                runpy.run_path(str(HERE/'docker-client.py'), run_name='__main__')
                argv = launch.call_args.args[1]
                self.assertIn('openclaw.p6.actions=22-1', argv)
                self.assertEqual('--mount' in argv, value is not None)
                if value:
                    self.assertIn('type=bind,src='+adapter+',dst=/app/scripts/e2e/lib/clawhub-artifact-assertions.mjs,readonly', argv)
                self.assertEqual(argv[-2:], ['image','bash'])


    def test_overlay_leaves_other_image_unchanged_even_with_selected_tag_argument(self):
        identity = {'identity':{'runId':'22','runAttempt':'1'}}
        env={'P6_DOCKER_CLAWHUB_ASSERTIONS':'/trusted/adapter.mjs','P6_DOCKER_CLAWHUB_IMAGE':'selected-aot'}
        for command in ['run','create']:
            with self.subTest(command=command), patch.dict(os.environ,env,clear=True), \
                 patch('sys.argv',['docker-client.py',command,'--rm','-v','source:/app/scripts:ro',
                                   'unrelated-fixture','echo','selected-aot']), \
                 patch.object(Path,'read_text',return_value=json.dumps(identity)), patch('os.execv') as launch:
                runpy.run_path(str(HERE/'docker-client.py'),run_name='__main__')
                self.assertNotIn('--mount',launch.call_args.args[1])


if __name__ == '__main__':
    unittest.main()
