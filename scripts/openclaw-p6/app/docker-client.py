#!/usr/bin/python3
"""Label resources created by the unchanged E2E owners for exact task cleanup."""
import json
import os
from pathlib import Path
import sys

identity = json.loads(Path('/p6-execution.json').read_text())['identity']
label = 'openclaw.p6.actions=' + identity['runId'] + '-' + identity['runAttempt']
args = sys.argv[1:]
if args[:1] in [['run'], ['create']]:
    args[1:1] = ['--label', label]
elif args[:2] == ['network', 'create']:
    args[2:2] = ['--label', label]
os.execv('/p6-host-docker', ['/p6-host-docker', *args])
