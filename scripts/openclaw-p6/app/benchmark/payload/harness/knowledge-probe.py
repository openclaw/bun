"""Read-only controller for the established Knowledge HTTP operation proof.
Gateway launch, artifact integrity and process cleanup remain with the caller.
"""
import argparse
import json
import os
from pathlib import Path
import re
import traceback
import urllib.error
import urllib.parse
import urllib.request


def run(args):
    url = urllib.parse.urlparse(args.url)
    assert url.scheme == 'http' and url.hostname == '127.0.0.1' and url.port
    assert not url.username and not url.password and url.path in ('', '/')
    token = os.environ['OPENCLAW_GATEWAY_TOKEN']
    assert token.startswith('p6-'), 'Only task-owned synthetic Gateway token allowed'
    state = Path(args.state).resolve(strict=True)
    output = Path(args.output)
    output.mkdir(parents=False, exist_ok=False)
    result = {'status': 'failed', 'state': str(state), 'url': args.url, 'errors': []}
    try:
        def invoke(name, label):
            body = {'name': name, 'args': {}, 'sessionKey': 'agent:main:main'}
            request = urllib.request.Request(
                args.url.rstrip('/') + '/tools/invoke', data=json.dumps(body).encode(),
                method='POST', headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'})
            receipt = {'request': body}
            try:
                try:
                    response = urllib.request.urlopen(request, timeout=120)
                except urllib.error.HTTPError as error:
                    response = error
                with response:
                    receipt['httpStatus'] = response.code
                    raw = response.read()
                (output / (label + '.response')).write_bytes(raw)
                payload = json.loads(raw)
                receipt['response'] = payload
                assert receipt['httpStatus'] == 200, 'HTTP tool invocation failed'
                assert payload.get('ok') is True, 'Gateway rejected tool invocation'
                value = payload['result']
                assert value.get('isError') is not True, 'Tool returned isError'
                assert isinstance(value.get('details'), dict), 'Missing typed Knowledge result'
                return value['details']
            finally:
                (output / (label + '.json')).write_text(json.dumps(receipt, indent=2) + '\n')

        def evidence(file):
            assert file.is_file() and file.stat().st_size > 0
            return {'path': str(file.relative_to(state)), 'sizeBytes': file.stat().st_size}

        first = invoke('knowledge_status', 'status-before')
        result['statusBefore'] = first
        assert first['agent'] == 'main' and first['store'] == 'unprovisioned'
        result['registryBefore'] = evidence(state / 'knowledge/registry.sqlite')
        ontology = invoke('knowledge_ontology', 'ontology')
        result['ontology'] = ontology
        assert ontology['available'] is True and ontology['total'] > 0
        fingerprint = ontology['fingerprint']
        assert re.fullmatch(r'[0-9a-f]{64}', fingerprint)
        last = invoke('knowledge_status', 'status-after')
        result['statusAfter'] = last
        assert last['agent'] == 'main' and last['store'] == 'ready'
        assert last['ontologyAvailable'] is True and last['definitions'] > 0
        assert last['ontologyFingerprint'] == fingerprint
        stores = (state / 'knowledge/stores').resolve()
        store = (stores / last['vault']).resolve()
        assert store.parent == stores
        result['files'] = [evidence(f) for f in [state / 'knowledge/registry.sqlite', store / 'state.sqlite', store / 'vault/vault.json']]
        assert json.loads((store / 'vault/vault.json').read_text())['vaultId'] == last['vault']
        result['status'] = 'passed-operations-only'
    except BaseException:
        result['errors'].append(traceback.format_exc())
    finally:
        (output / 'result.json').write_text(json.dumps(result, indent=2) + '\n')
    return 0 if result['status'] == 'passed-operations-only' else 1


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--url', required=True)
    parser.add_argument('--state', required=True)
    parser.add_argument('--output', required=True)
    raise SystemExit(run(parser.parse_args()))
