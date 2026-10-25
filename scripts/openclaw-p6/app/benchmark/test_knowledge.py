"""Synthetic HTTP contract checks; no OpenClaw application is executed."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = Path(__file__).resolve().parent
PROBE = HERE / 'payload/harness/knowledge-probe.py'
VAULT = '11111111-1111-4111-8111-111111111111'
FINGERPRINT = 'a' * 64


class KnowledgeProbe(unittest.TestCase):
    def test_fixture_opt_in_keeps_normal_cohort_config_unchanged(self):
        module = (HERE / 'payload/harness/fixture-config.mjs').as_uri()
        script = '''
import {coreFixtureConfig} from %s;
const args={workspace:'/synthetic',port:1234,token:'p6-synthetic',mockPort:1235,
 applyMockOpenAiModelConfig:(config)=>{config.models={fixture:true};}};
console.log(JSON.stringify([coreFixtureConfig(args),coreFixtureConfig({...args,knowledgeControl:true})]));
''' % json.dumps(module)
        run = subprocess.run(['node', '--input-type=module', '-e', script],
                             capture_output=True, text=True, check=True, timeout=10)
        normal, control = json.loads(run.stdout)
        self.assertEqual(normal['tools'], {'allow': [], 'deny': ['*']})
        self.assertNotIn('plugins', normal)
        self.assertEqual(control['tools'], {'allow': ['knowledge_status', 'knowledge_ontology']})
        self.assertEqual(control['plugins']['slots'], {'memory': 'knowledge'})
        self.assertEqual(control['models'], normal['models'])

    def exercise(self, change=None, missing_store=False):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            state = root / 'state'
            store = state / 'knowledge/stores' / VAULT
            (store / 'vault').mkdir(parents=True)
            (state / 'knowledge/registry.sqlite').write_bytes(b'synthetic registry')
            if not missing_store:
                (store / 'state.sqlite').write_bytes(b'synthetic store')
            (store / 'vault/vault.json').write_text(json.dumps({'vaultId': VAULT}))
            details = [
                {'agent': 'main', 'store': 'unprovisioned'},
                {'available': True, 'total': 1, 'fingerprint': FINGERPRINT},
                {'agent': 'main', 'store': 'ready', 'ontologyAvailable': True,
                 'definitions': 1, 'ontologyFingerprint': FINGERPRINT, 'vault': VAULT},
            ]
            responses = [(200, {'ok': True, 'result': {'details': value}}) for value in details]
            if change:
                change(responses)
            seen = []

            class Handler(BaseHTTPRequestHandler):
                def log_message(self, *_):
                    pass

                def do_POST(self):
                    body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                    seen.append((self.path, body, self.headers['Authorization']))
                    code, response = responses[len(seen) - 1]
                    self.send_response(code)
                    self.end_headers()
                    self.wfile.write(json.dumps(response).encode())

            server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
            thread = threading.Thread(target=lambda: server.serve_forever(poll_interval=0.01))
            thread.start()
            try:
                env = {**os.environ, 'OPENCLAW_GATEWAY_TOKEN': 'p6-synthetic-test-token'}
                run = subprocess.run([sys.executable, '-B', str(PROBE), '--url',
                    'http://127.0.0.1:' + str(server.server_port), '--state', str(state),
                    '--output', str(root / 'proof')], env=env, capture_output=True, timeout=10)
            finally:
                server.shutdown()
                thread.join(timeout=2)
                server.server_close()
            files = {p.name: p.read_text() for p in (root / 'proof').iterdir()}
            return run.returncode, json.loads(files['result.json']), seen, files

    def test_ordered_public_operations_prove_store_transition(self):
        code, result, seen, _ = self.exercise()
        self.assertEqual(code, 0)
        self.assertEqual(result['status'], 'passed-operations-only')
        self.assertEqual([r[1]['name'] for r in seen],
                         ['knowledge_status', 'knowledge_ontology', 'knowledge_status'])
        self.assertTrue(all(r[0] == '/tools/invoke' for r in seen))
        self.assertTrue(all(r[1]['sessionKey'] == 'agent:main:main' for r in seen))
        self.assertEqual(len(result['files']), 3)

    def test_http_failure_retains_body_and_never_passes(self):
        def deny(rows):
            rows[0] = (403, {'ok': False, 'error': 'synthetic denial'})
        code, result, seen, files = self.exercise(deny)
        self.assertEqual(code, 1)
        self.assertEqual(result['status'], 'failed')
        self.assertEqual(len(seen), 1)
        self.assertEqual(json.loads(files['status-before.json'])['httpStatus'], 403)
        self.assertIn('synthetic denial', files['status-before.response'])

    def test_tool_error_retains_response_and_never_passes(self):
        def fail(rows):
            rows[1][1]['result']['isError'] = True
        code, result, seen, files = self.exercise(fail)
        self.assertEqual(code, 1)
        self.assertEqual(result['status'], 'failed')
        self.assertEqual(len(seen), 2)
        self.assertTrue(json.loads(files['ontology.response'])['result']['isError'])

    def test_changed_fingerprint_never_passes(self):
        def change(rows):
            rows[2][1]['result']['details']['ontologyFingerprint'] = 'b' * 64
        code, result, _, files = self.exercise(change)
        self.assertEqual(code, 1)
        self.assertEqual(result['status'], 'failed')
        self.assertIn('status-after.response', files)

    def test_missing_storage_evidence_never_passes(self):
        code, result, _, _ = self.exercise(missing_store=True)
        self.assertEqual(code, 1)
        self.assertEqual(result['status'], 'failed')


if __name__ == '__main__':
    unittest.main()
