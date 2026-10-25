"""Synthetic process cleanup proof; no OpenClaw process or build is executed."""
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import unittest

HERE = Path(__file__).resolve().parent
CHILD = '''
import os,signal,sys,time
from pathlib import Path
root=Path(sys.argv[1]);mode=sys.argv[2]
def stop(signum,frame):
    if mode=='ignore':return
    time.sleep(.3)
    (root/'finished').write_text('natural cleanup')
    raise SystemExit(0)
signal.signal(signal.SIGTERM,stop)
signal.signal(signal.SIGINT,stop)
(root/'group').write_text(str(os.getpgrp()))
(root/'ready').write_text(str(os.getpid()))
if mode=='done':raise SystemExit(0)
while True:time.sleep(.05)
'''


def await_ready(root, process):
    until = time.monotonic() + 5
    while not (root / 'ready').exists():
        if process.poll() is not None or time.monotonic() >= until:
            raise AssertionError('Synthetic child did not start')
        time.sleep(.01)
    return int((root / 'ready').read_text())


def is_live(pid):
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    if sys.platform == 'linux':
        try:
            return Path(f'/proc/{pid}/stat').read_text().split(') ', 1)[1].split()[0] != 'Z'
        except FileNotFoundError:
            return False
    return True


def reap_fixture(process, root):
    group = root / 'group'
    if group.exists():
        pgid = int(group.read_text())
        if pgid == os.getpgrp():
            raise AssertionError('Synthetic child did not get its own process group')
        try:
            os.killpg(pgid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    if process.poll() is None:
        process.kill()
    process.communicate(timeout=5)


class ControllerCleanup(unittest.TestCase):
    def run_case(self, mode, cancel=False, grace=1, orphan=False):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / 'child.py').write_text(CHILD)
            (root / 'wrapper.py').write_text('''import subprocess,sys,time
from pathlib import Path
root=Path(sys.argv[1])
subprocess.Popen([sys.executable,str(root/'child.py'),str(root),sys.argv[2]])
while True:time.sleep(.05)
''')
            driver = '''
import json,os,runpy,sys
from pathlib import Path
owner=runpy.run_path(sys.argv[1],run_name='controller_test');root=Path(sys.argv[2])
kwargs={} if sys.argv[3]=='default' else {'cleanup_grace':float(sys.argv[3])}
target='wrapper.py' if sys.argv[6]=='orphan' else 'child.py'
row=owner['run_command']([sys.executable,str(root/target),str(root),sys.argv[4]],
    root,dict(os.environ),root,10 if sys.argv[5]=='cancel' else .2,**kwargs)
(root/'receipt.json').write_text(json.dumps(row))
'''
            process = subprocess.Popen([sys.executable, '-c', driver,
                str(HERE / 'packet/payload/runtime-controller.py'), temp, str(grace), mode,
                'cancel' if cancel else 'timeout', 'orphan' if orphan else 'direct'],
                stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            try:
                pid = await_ready(root, process)
                if cancel:
                    process.send_signal(signal.SIGTERM)
                    time.sleep(.1)
                    process.send_signal(signal.SIGTERM)
                stdout, stderr = process.communicate(timeout=5)
                self.assertEqual(process.returncode, 0, (stdout, stderr))
                row = json.loads((root / 'receipt.json').read_text())
                self.assertFalse(is_live(pid), 'Synthetic child survived owner cleanup')
                self.assertEqual((root / 'finished').exists(), mode != 'ignore')
                return row
            finally:
                reap_fixture(process, root)

    def test_timeout_keeps_failure_even_when_child_finishes_naturally(self):
        row = self.run_case('delayed')
        self.assertTrue(row['timeout'])
        self.assertEqual(row['exitCode'], 0)
        self.assertFalse(row['forcedCleanup'])

    def test_cancellation_preserves_first_signal_and_reaps_child(self):
        row = self.run_case('delayed', cancel=True)
        self.assertTrue(row['cancelled'])
        self.assertFalse(row['timeout'])
        self.assertEqual(row['interruptedBySignal'], signal.SIGTERM)
        self.assertFalse(row['forcedCleanup'])

    def test_term_resistant_child_is_forced_and_reaped(self):
        row = self.run_case('ignore', grace=.2)
        self.assertTrue(row['timeout'])
        self.assertTrue(row['forcedCleanup'])
        self.assertEqual(row['exitCode'], -signal.SIGKILL)

    def test_default_caller_retains_short_grace(self):
        row = self.run_case('delayed', grace='default')
        self.assertEqual(row['cleanupGraceSeconds'], 15)
        self.assertFalse(row['forcedCleanup'])

    @unittest.skipUnless(sys.platform == 'linux', 'Linux orphan process-group cleanup')
    def test_finished_orphan_does_not_require_forced_cleanup(self):
        row = self.run_case('delayed', orphan=True)
        self.assertTrue(row['timeout'])
        self.assertEqual(row['exitCode'], -signal.SIGTERM)
        self.assertFalse(row['forcedCleanup'])


@unittest.skipUnless(sys.platform == 'linux', 'Requires real Linux GNU time')
class MeasurementCleanup(unittest.TestCase):
    def run_case(self, mode, cancel=False, grace=None):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / 'child.py').write_text(CHILD)
            output = root / 'measurement'
            command = [sys.executable, str(HERE / 'packet/payload/measure-command.py'),
                '--label', 'synthetic', '--out', str(output), '--timeout', '10' if cancel else '.2']
            if grace is not None:
                command += ['--cleanup-grace-seconds', str(grace)]
            command += ['--', sys.executable, str(root / 'child.py'), temp, mode]
            process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            try:
                pid = await_ready(root, process)
                if cancel:
                    process.send_signal(signal.SIGTERM)
                    time.sleep(.1)
                    process.send_signal(signal.SIGHUP)
                process.communicate(timeout=5)
                row = json.loads((output / 'receipt.json').read_text())
                self.assertFalse(is_live(pid), 'Measured workload survived cleanup')
                self.assertEqual((root / 'finished').exists(), mode == 'delayed')
                return process.returncode, row
            finally:
                reap_fixture(process, root)

    def test_default_completion_needs_no_runtime_opt_in(self):
        code, row = self.run_case('done')
        self.assertEqual(code, 0)
        self.assertEqual(row['exitCode'], 0)
        self.assertNotIn('cleanup', row)

    def test_opt_in_timeout_grants_grace_and_remains_failed(self):
        code, row = self.run_case('delayed', grace=1)
        self.assertEqual(code, 124)
        self.assertTrue(row['timeout'])
        self.assertFalse(row['cleanup']['forced'])

    def test_opt_in_cancellation_retains_receipt_and_natural_cleanup(self):
        code, row = self.run_case('delayed', cancel=True, grace=1)
        self.assertNotEqual(code, 0)
        self.assertTrue(row['cancelled'])
        self.assertEqual(row['interruptedBySignal'], signal.SIGTERM)
        self.assertFalse(row['cleanup']['forced'])

    def test_opt_in_forces_term_resistant_workload_after_grace(self):
        code, row = self.run_case('ignore', grace=.2)
        self.assertEqual(code, 124)
        self.assertTrue(row['cleanup']['forced'])
        self.assertGreaterEqual(row['observedWallSeconds'], .4)


@unittest.skipUnless(shutil.which('node'), 'Source budget helper requires Node')
class StreamCancellation(unittest.TestCase):
    def test_cancelled_cohort_cannot_pass_after_natural_owner_exit(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            prep = root / 'benchmark-prep'
            (prep / 'harness').mkdir(parents=True)
            (root / 'source').mkdir()
            (root / 'source/gateway-shutdown-budget.mjs').write_text(
                'export const GATEWAY_SHUTDOWN_TIMEOUT_MS=200;\n'
                'export const GATEWAY_SERVICE_STOP_TIMEOUT_MS=400;\n')
            shutil.copyfile(HERE / 'benchmark/payload/stream-cohort.py', prep / 'stream-cohort.py')
            shutil.copyfile(HERE / 'shared/process-stop.mjs', prep / 'harness/process-stop.mjs')
            (prep / 'native-inputs.json').write_text(json.dumps({'node': {'path': shutil.which('node')}}))
            (root / 'child.py').write_text(CHILD)
            process = subprocess.Popen([sys.executable, str(prep / 'stream-cohort.py'),
                str(root / 'cohort'), '--', sys.executable, str(root / 'child.py'), temp, 'delayed'],
                stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            try:
                pid = await_ready(root, process)
                process.send_signal(signal.SIGTERM)
                stdout, stderr = process.communicate(timeout=5)
                self.assertEqual(process.returncode, 128 + signal.SIGTERM, stderr)
                events = [json.loads(line.removeprefix('P6_PROGRESS ')) for line in stdout.decode().splitlines()]
                self.assertEqual(events[-1]['event'], 'owner-exit')
                self.assertEqual(events[-1]['code'], 0)
                self.assertFalse(events[-1]['forcedCleanup'])
                self.assertTrue((root / 'finished').exists())
                self.assertFalse(is_live(pid))
            finally:
                reap_fixture(process, root)


if __name__ == '__main__':
    unittest.main()
