"""Current Teams job identity and exact originating app input contract."""
import os
from pathlib import Path
import re
import sys

APP = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(APP / 'benchmark'))
sys.path.insert(0, str(APP))
from app_contract import CUT, ROOT, dump, load, pins_ok, sha
from selection import requested_variants, select_variants


def identity(env):
    value = {key: env[name] for key, name in [('repository', 'GITHUB_REPOSITORY'),
        ('runId', 'GITHUB_RUN_ID'), ('runAttempt', 'GITHUB_RUN_ATTEMPT'), ('job', 'GITHUB_JOB')]}
    assert value['repository'] == 'openclaw/bun' and value['job'] == 'linux-x64-teams'
    assert env['GITHUB_REF'] == 'refs/heads/openclaw/aot-rd-P6'
    assert all(re.fullmatch('[1-9][0-9]*', value[k]) for k in ['runId', 'runAttempt'])
    assert re.fullmatch('[a-f0-9]{40}', env['GITHUB_SHA'])
    return value


def app_inputs(env):
    def number(key):
        assert re.fullmatch('[1-9][0-9]*', env[key]), key
        return int(env[key])
    result = {'repository': 'openclaw/bun', 'repositoryId': number('P6_APP_REPOSITORY_ID'),
        'runId': number('P6_APP_RUN_ID'), 'runAttempt': number('P6_APP_RUN_ATTEMPT'),
        'workflowId': number('P6_APP_WORKFLOW_ID'), 'headSha': env['P6_APP_WORKFLOW_HEAD'],
        'artifact': {'id': number('P6_APP_ARTIFACT_ID'), 'name': env['P6_APP_ARTIFACT_NAME'],
                     'zipSha256': env['P6_APP_ZIP_SHA256'], 'zipBytes': number('P6_APP_ZIP_BYTES')},
        'maxUnpackedBytes': 8 * 1024**3}
    pins_ok(result)
    assert result['runId'] != int(identity(env)['runId']), 'Origin must be a completed different app run'
    return result


def current(work):
    value = load(work / 'teams-execution.json')
    assert value['sourceCommit'] == CUT and value['identity']['job'] == 'linux-x64-teams'
    assert value['identity']['repository'] == 'openclaw/bun'
    assert value['appInputsSha256'] == sha(work / 'app-inputs.json')
    assert re.fullmatch('[a-f0-9]{40}', value['workflowHead'])
    assert value['variantSelection'] in ['js-c2', 'ts'], 'Teams mode requires app_variants=js-c2 or ts'
    requested_variants(value)
    return value


def download_dir(work):
    return Path(str(work) + '-download')


def origin(work):
    value = current(work)
    download = download_dir(work)
    verified = load(download / 'verification.json')
    pins = load(work / 'app-inputs.json')
    assert load(download / 'pins.json') == pins
    assert verified['sourceCommit'] == CUT and verified['workflowHead'] == pins['headSha']
    assert verified['runId'] == pins['runId'] and verified['runAttempt'] == pins['runAttempt']
    assert verified['artifactId'] == pins['artifact']['id'] and verified['artifactZipSha256'] == pins['artifact']['zipSha256']
    execution = load(download / 'export/host/execution.json')
    assert execution['sourceCommit'] == CUT and execution['workflowHead'] == pins['headSha']
    assert set(requested_variants(value)) <= set(requested_variants(execution)), 'Selected Teams variant absent from origin'
    return verified
