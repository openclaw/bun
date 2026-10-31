"""Synthetic admitted-agent contracts; no OpenClaw process or database is executed."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
import urllib.error
import urllib.request

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('knowledge_provider', HERE/'payload/harness/knowledge-provider.py')
PROVIDER = importlib.util.module_from_spec(spec)
spec.loader.exec_module(PROVIDER)
MODEL = 'p6-deterministic'
MARKER = 'P6_KNOWLEDGE_AGENT_PROOF_OK'
VAULT = '11111111-1111-4111-8111-111111111111'
ONTOLOGY = {'available': True, 'total': 38, 'fingerprint': 'a'*64}


def request(index, value=None):
    body = {'model': MODEL, 'stream': True, 'tools': [{'name': name} for name, _ in PROVIDER.CALLS]}
    body['input'] = MARKER if index == 0 else [{'type': 'function_call_output',
        'call_id': f'call_p6_{index-1}', 'output': json.dumps(value)}]
    return body


def outputs():
    return [[{'name': 'knowledge_ontology'}], {'name': 'knowledge_ontology', 'parameters': {}},
            {'tool': {'name': 'knowledge_ontology'}, 'result': {'content': [
                {'type': 'text', 'text': json.dumps(ONTOLOGY)}]}}]


class KnowledgeControl(unittest.TestCase):
    def test_exact_four_request_script_consumes_actual_tool_outputs(self):
        with tempfile.TemporaryDirectory() as temp:
            provider = PROVIDER.ScriptedProvider(Path(temp)/'provider.json', MODEL, MARKER)
            for index, value in enumerate([None, *outputs()]):
                events = provider.events(request(index, value), '/v1/responses')
                self.assertEqual(events[-1]['type'], 'response.completed')
            self.assertEqual(provider.ontology, ONTOLOGY)
            self.assertEqual([row['callId'] for row in provider.outputs], ['call_p6_0','call_p6_1','call_p6_2'])
            with self.assertRaises(AssertionError):
                provider.events(request(4, {}), '/v1/responses')

    def test_invalid_admitted_tool_output_is_rejected(self):
        for invalid in [{'error': 'denied'}, [], {'name': 'wrong'}, {'isError': True}]:
            with self.subTest(invalid=invalid), tempfile.TemporaryDirectory() as temp:
                provider = PROVIDER.ScriptedProvider(Path(temp)/'provider.json', MODEL, MARKER)
                provider.events(request(0), '/v1/responses')
                with self.assertRaises(AssertionError):
                    provider.events(request(1, invalid), '/v1/responses')

    def test_wrong_request_identity_or_tools_is_rejected(self):
        for patch in [{'model':'wrong'}, {'stream':False}, {'tools':[]}]:
            with self.subTest(patch=patch), tempfile.TemporaryDirectory() as temp:
                provider = PROVIDER.ScriptedProvider(Path(temp)/'provider.json', MODEL, MARKER)
                with self.assertRaises(AssertionError):
                    provider.events({**request(0), **patch}, '/v1/responses')

    def test_http_failure_is_recorded_and_does_not_fallback(self):
        with tempfile.TemporaryDirectory() as temp:
            receipt = Path(temp)/'provider.json'
            provider = PROVIDER.ScriptedProvider(receipt, MODEL, MARKER)
            server, thread = provider.start()
            try:
                req = urllib.request.Request('http://127.0.0.1:'+str(server.server_port)+'/v1/responses',
                    data=json.dumps({**request(0), 'model':'wrong'}).encode(), method='POST')
                with self.assertRaises(urllib.error.HTTPError) as raised:
                    urllib.request.urlopen(req, timeout=5)
                self.assertEqual(raised.exception.code, 400)
                saved = json.loads(receipt.read_text())
                self.assertEqual(len(saved['requests']), 1)
                self.assertEqual(len(saved['errors']), 1)
            finally:
                server.shutdown(); server.server_close(); thread.join(timeout=5)

    def test_operator_and_agent_proof_require_real_admission_and_matching_store(self):
        module = (HERE/'payload/harness/knowledge-agent.mjs').as_uri()
        script = '''
import fs from 'node:fs';import path from 'node:path';
import {qualifyKnowledgeAgent,KNOWLEDGE_MODEL,KNOWLEDGE_MARKER} from MODULE;
const [root,mode]=process.argv.slice(1);const out=path.join(root,'out'),state=path.join(root,'state');
fs.mkdirSync(path.join(out,'logs'),{recursive:true});
fs.writeFileSync(path.join(out,'logs/knowledge-turn.stderr'),mode==='fallback'?'falling back':'');
const vault='11111111-1111-4111-8111-111111111111';const store=path.join(state,'knowledge/stores',vault);
fs.mkdirSync(path.join(store,'vault'),{recursive:true});
for(const file of [path.join(state,'knowledge/registry.sqlite'),path.join(store,'state.sqlite')])fs.writeFileSync(file,'synthetic');
fs.writeFileSync(path.join(store,'vault/vault.json'),JSON.stringify({vaultId:vault}));
const ontology={available:true,total:38,fingerprint:'a'.repeat(64)};
const receipt=path.join(root,'provider.json');fs.writeFileSync(receipt,JSON.stringify({model:KNOWLEDGE_MODEL,marker:KNOWLEDGE_MARKER,
 requests:[0,1,2,3].map(index=>({index,path:'/v1/responses',stream:true,model:KNOWLEDGE_MODEL})),
 outputs:[0,1,2].map(index=>({callId:'call_p6_'+index})),ontology,errors:[]}));
const calls=[];const command=async(label,args)=>{calls.push({label,args});
 if(label==='knowledge-status-before')return JSON.stringify({ok:true,result:{agent:'main',store:'unprovisioned'}});
 if(label==='knowledge-session-create')return JSON.stringify({ok:true,key:'agent:main:admitted',entry:{chatType:mode==='foreign'?'group':'direct',createdVia:'operator'},runStarted:false});
 if(label==='knowledge-turn')return JSON.stringify({status:'ok',summary:'completed',result:{payloads:[{text:KNOWLEDGE_MARKER}]}});
 if(label==='knowledge-status-after')return JSON.stringify({ok:true,result:{agent:'main',store:'ready',ontologyAvailable:true,definitions:38,ontologyFingerprint:'a'.repeat(64),vault}});
 if(label==='knowledge-ontology-after')return JSON.stringify({ok:true,result:{...ontology,fingerprint:(mode==='fingerprint'?'b':'a').repeat(64)}});
 throw new Error(label);};
try{const result=await qualifyKnowledgeAgent({command,port:23456,token:'p6-synthetic',stateDir:state,out,providerReceipt:receipt});console.log(JSON.stringify({result,calls}));}
catch(error){console.log(JSON.stringify({error:String(error),calls}));process.exitCode=1;}
'''.replace('MODULE', json.dumps(module))
        for mode in ['valid','foreign','fingerprint','fallback']:
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as temp:
                run = subprocess.run(['node','--input-type=module','-e',script,temp,mode],capture_output=True,text=True,timeout=10)
                value = json.loads(run.stdout)
                self.assertEqual(run.returncode, 0 if mode=='valid' else 1)
                self.assertTrue(all('/tools/invoke' not in str(call) for call in value['calls']))
                if mode=='valid':
                    self.assertEqual(value['result']['status'], 'passed-operations-only')
                    self.assertEqual(value['result']['providerRequests'], 4)
                    self.assertEqual(value['calls'][1]['args'][2], 'sessions.create')

    def test_late_request_or_missing_final_receipt_cannot_leave_qualification_passed(self):
        module = (HERE/'payload/harness/knowledge-agent.mjs').as_uri()
        script = """
import fs from 'node:fs';import path from 'node:path';
import {finalizeKnowledgeProvider,KNOWLEDGE_MODEL,KNOWLEDGE_MARKER} from MODULE;
const file=path.join(process.argv[1],'provider.json');
const receipt={model:KNOWLEDGE_MODEL,marker:KNOWLEDGE_MARKER,errors:[],
 requests:[0,1,2,3].map(index=>({index,path:'/v1/responses',stream:true,model:KNOWLEDGE_MODEL})),
 outputs:[0,1,2].map(index=>({callId:'call_p6_'+index})),ontology:{available:true,total:38,fingerprint:'a'.repeat(64)}};
fs.writeFileSync(file,JSON.stringify(receipt));
const before={qualification:'passed'};finalizeKnowledgeProvider(before,file);
receipt.requests.push({index:4});fs.writeFileSync(file,JSON.stringify(receipt));
const late={qualification:'passed'};finalizeKnowledgeProvider(late,file);
fs.writeFileSync(file,'invalid');const invalid={qualification:'passed'};finalizeKnowledgeProvider(invalid,file);
fs.unlinkSync(file);const missing={qualification:'passed'};finalizeKnowledgeProvider(missing,file);
console.log(JSON.stringify({before,late,invalid,missing}));
""".replace('MODULE',json.dumps(module))
        with tempfile.TemporaryDirectory() as temp:
            result=json.loads(subprocess.check_output(['node','--input-type=module','-e',script,temp],text=True))
        self.assertEqual(result['before']['qualification'],'passed')
        for name in ['late','invalid','missing']:
            self.assertEqual(result[name]['qualification'],'failed')
            self.assertEqual(result[name]['knowledgeProviderFinal']['status'],'failed')

    def test_fixture_opt_in_leaves_normal_cohort_configuration_unchanged(self):
        module = (HERE/'payload/harness/fixture-config.mjs').as_uri()
        script = '''import {coreFixtureConfig} from MODULE;
const args={workspace:'/synthetic',port:1234,token:'p6-synthetic',mockPort:1235,applyMockOpenAiModelConfig:()=>{}};
console.log(JSON.stringify([coreFixtureConfig(args),coreFixtureConfig({...args,knowledgeControl:true})]));'''.replace('MODULE',json.dumps(module))
        normal,control=json.loads(subprocess.check_output(['node','--input-type=module','-e',script],text=True))
        self.assertEqual(normal['tools'],{'allow':[],'deny':['*']})
        self.assertEqual(control['tools']['allow'],['knowledge_status','knowledge_ontology','tool_search','tool_describe','dispatch_action'])


if __name__ == '__main__':unittest.main()
