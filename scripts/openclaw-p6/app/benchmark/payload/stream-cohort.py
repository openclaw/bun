#!/usr/bin/env python3
"""Read-only progress from the existing cohort owner, on its stdout transport."""
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import time

PREFIX = 'P6_PROGRESS '
MAX_ROW_BYTES = 8 * 1024 * 1024


def emit(value):
    print(PREFIX + json.dumps(value, separators=(',', ':')), flush=True)


if sys.argv[1:] == ['--probe']:
    emit({'event': 'probe', 'stage': 'first'})
    time.sleep(3)
    emit({'event': 'probe', 'stage': 'second'})
    raise SystemExit(0)

out = Path(sys.argv[1]).resolve()
assert sys.argv[2] == '--' and len(sys.argv) > 3
assert not out.exists(), 'fresh cohort output required'
child = subprocess.Popen(sys.argv[3:], start_new_session=True)
cancelled_at = None


def forward(signum, _frame):
    global cancelled_at
    cancelled_at = cancelled_at or time.monotonic()
    if child.poll() is None:
        try:
            child.send_signal(signal.SIGTERM if signum == signal.SIGHUP else signum)
        except ProcessLookupError:
            pass


for sig in [signal.SIGINT, signal.SIGTERM, signal.SIGHUP]:
    signal.signal(sig, forward)

seen = {}
last_status = None
last_signature = None


def collect():
    global last_status, last_signature
    filename = out / 'cohort.json'
    if not filename.exists():
        return
    stat = filename.stat()
    signature = (stat.st_mtime_ns, stat.st_size)
    if signature == last_signature:
        return
    assert stat.st_size <= 16 * 1024 * 1024, 'cohort receipt exceeded progress bound'
    raw = filename.read_bytes()
    try:
        receipt = json.loads(raw)
    except json.JSONDecodeError:
        return  # The owner rewrites this file; the next poll reads the completed save.
    last_signature = signature
    for row in receipt.get('rows', []):
        if 'finished' not in row:
            continue
        label = Path(row['out']).name
        assert re.fullmatch(r'(warmup|sweep-[0-9]+)-[a-z0-9-]+', label), 'unsafe row label'
        row_out = Path(row['out']).resolve()
        assert row_out == out / label, 'row receipt escaped cohort output'
        result = row_out / 'result.json'
        if not result.exists():
            continue
        assert result.stat().st_size <= MAX_ROW_BYTES, 'row receipt exceeded progress bound'
        data = result.read_bytes()
        digest = hashlib.sha256(data).hexdigest()
        if label in seen:
            assert seen[label] == digest, 'completed row changed'
            continue
        emit({'event': 'row', 'label': label, 'sha256': digest,
              'resultBase64': base64.b64encode(data).decode('ascii'),
              'row': {key: value for key, value in row.items() if key != 'result'}})
        seen[label] = digest
    status = (receipt.get('status', 'running'), len(receipt.get('rows', [])), len(seen))
    if status != last_status:
        emit({'event': 'cohort', 'status': status[0], 'rowsStarted': status[1],
              'rowsPreserved': status[2], 'cohortSha256': hashlib.sha256(raw).hexdigest(),
              'machine': receipt.get('machine')})
        last_status = status


try:
    while child.poll() is None:
        collect()
        if cancelled_at and time.monotonic() - cancelled_at > 30:
            try:
                os.killpg(child.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        time.sleep(0.25)
    collect()
    code = child.wait()
    emit({'event': 'owner-exit', 'code': code, 'rowsPreserved': len(seen)})
finally:
    if child.poll() is None:
        child.terminate()
        try:
            child.wait(timeout=30)
        except subprocess.TimeoutExpired:
            os.killpg(child.pid, signal.SIGKILL)
            child.wait()
raise SystemExit(code if code >= 0 else 128 - code)
