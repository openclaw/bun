#!/usr/bin/python3
"""Label resources created by the unchanged E2E owners for exact task cleanup."""
import json
import os
from pathlib import Path
import sys

def image_token(args):
    index = 1
    while index < len(args):
        token = args[index]
        if token == '--':
            return args[index + 1] if index + 1 < len(args) else None
        if not token.startswith('-'):
            return token
        if '=' in token or token in ['--rm', '--init', '--read-only', '--privileged'] or (
                token.startswith('-') and not token.startswith('--') and set(token[1:]) <= set('dit')):
            index += 1
        else:
            index += 2
    return None


identity = json.loads(Path('/p6-execution.json').read_text())['identity']
label = 'openclaw.p6.actions=' + identity['runId'] + '-' + identity['runAttempt']
args = sys.argv[1:]
if args[:1] in [['run'], ['create']]:
    args[1:1] = ['--label', label]
    adapter = os.environ.get('P6_DOCKER_CLAWHUB_ASSERTIONS')
    expected_image = os.environ.get('P6_DOCKER_CLAWHUB_IMAGE')
    if adapter and expected_image and image_token(sys.argv[1:]) == expected_image:
        args[1:1] = ['--mount', 'type=bind,src=' + adapter +
                     ',dst=/app/scripts/e2e/lib/clawhub-artifact-assertions.mjs,readonly']
elif args[:2] == ['network', 'create']:
    args[2:2] = ['--label', label]
os.execv('/p6-host-docker', ['/p6-host-docker', *args])
