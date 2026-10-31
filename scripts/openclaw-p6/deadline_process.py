"""Own a subprocess group through an absolute deadline and bounded cleanup."""
import argparse
import json
import os
from pathlib import Path
import signal
import subprocess
import time


class CommandInterrupted(Exception):
    def __init__(self, signum):
        self.signum = signum


def stop_group(child, grace=5):
    try:
        os.killpg(child.pid, signal.SIGTERM)
    except ProcessLookupError:
        child.wait()
        return
    until = time.monotonic() + grace
    while time.monotonic() < until:
        child.poll()  # Reap an exited leader while checking for live descendants.
        try:
            os.killpg(child.pid, 0)
        except ProcessLookupError:
            break
        time.sleep(0.05)
    try:
        os.killpg(child.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    child.wait()


def run_bounded(command, *, deadline_epoch, reserve_seconds=60, cleanup_grace=5,
                cwd=None, env=None, stdout=None, stderr=None):
    # Cleanup starts early enough to retain the reserve even for TERM-resistant children.
    start = time.monotonic()
    work_seconds = deadline_epoch - time.time() - reserve_seconds - cleanup_grace - 1
    facts = {'deadlineEpoch': deadline_epoch, 'reserveSeconds': reserve_seconds,
             'cleanupGraceSeconds': cleanup_grace, 'workSecondsAtStart': work_seconds,
             'timedOut': False, 'interruptedBySignal': None, 'launched': False}
    if work_seconds <= 0:
        facts.update(timedOut=True, exitCode=124, wallSeconds=0, finishedEpoch=time.time(),
                     finishedBeforeReserve=time.time() <= deadline_epoch-reserve_seconds)
        return subprocess.CompletedProcess(command, 124, b'', b''), facts
    handlers = {sig: signal.getsignal(sig) for sig in [signal.SIGINT, signal.SIGTERM, signal.SIGHUP]}
    def interrupt(signum, _frame):
        raise CommandInterrupted(signum)
    for sig in handlers:
        signal.signal(sig, interrupt)
    child = None
    output = error = None
    code = 1
    try:
        child = subprocess.Popen(command, cwd=cwd, env=env, stdout=stdout, stderr=stderr,
                                 start_new_session=True)
        facts['launched'] = True
        try:
            output, error = child.communicate(timeout=work_seconds)
            code = child.returncode
        except subprocess.TimeoutExpired:
            facts['timedOut'] = True
            code = 124
        except CommandInterrupted as interrupted:
            facts['interruptedBySignal'] = interrupted.signum
            code = 128 + interrupted.signum
    finally:
        for sig in handlers:
            signal.signal(sig, signal.SIG_IGN)
        try:
            if child is not None:
                stop_group(child, cleanup_grace)
                output, error = child.communicate()
        finally:
            for sig, handler in handlers.items():
                signal.signal(sig, handler)
    finished=time.time()
    if finished > deadline_epoch-reserve_seconds:
        code=124
        facts['timedOut']=True
    facts.update(exitCode=code, wallSeconds=time.monotonic()-start,
                 finishedEpoch=finished, finishedBeforeReserve=finished <= deadline_epoch-reserve_seconds)
    return subprocess.CompletedProcess(command, code, output, error), facts


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--deadline-epoch', type=float, required=True)
    parser.add_argument('--reserve-seconds', type=float, default=60)
    parser.add_argument('--cleanup-grace-seconds', type=float, default=15)
    parser.add_argument('--receipt', type=Path, required=True)
    parser.add_argument('command', nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.command[1:] if args.command[:1] == ['--'] else args.command
    if not command:
        parser.error('Command required')
    args.receipt.parent.mkdir(parents=True, exist_ok=True)
    result, facts = run_bounded(command, deadline_epoch=args.deadline_epoch,
                               reserve_seconds=args.reserve_seconds,
                               cleanup_grace=args.cleanup_grace_seconds)
    args.receipt.write_text(json.dumps(facts, indent=2)+'\n')
    print('P6_PHASE_DEADLINE '+json.dumps(facts), flush=True)
    raise SystemExit(result.returncode if result.returncode >= 0 else 128-result.returncode)


if __name__ == '__main__':
    main()
