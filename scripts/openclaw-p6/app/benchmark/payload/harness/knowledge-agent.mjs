// Admitted agent and operator RPC proof; the existing core runner owns all processes.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
export const KNOWLEDGE_MODEL='p6-deterministic';
export const KNOWLEDGE_MARKER='P6_KNOWLEDGE_AGENT_PROOF_OK';
const fingerprint=value=>{
  assert(value.available===true&&value.total>0,'Knowledge ontology unavailable');
  assert.match(value.fingerprint,/^[0-9a-f]{64}$/,'Knowledge fingerprint missing');
  return value.fingerprint;
};
function readProvider(file) {
  const provider=JSON.parse(fs.readFileSync(file,'utf8'));
  assert.equal(provider.model,KNOWLEDGE_MODEL);assert.equal(provider.marker,KNOWLEDGE_MARKER);
  assert.equal(provider.requests.length,4);assert.deepEqual(provider.errors,[]);
  assert.deepEqual(provider.requests.map(row=>row.index),[0,1,2,3]);
  assert(provider.requests.every(row=>row.path==='/v1/responses'&&row.stream===true&&row.model===KNOWLEDGE_MODEL));
  assert.deepEqual(provider.outputs.map(row=>row.callId),['call_p6_0','call_p6_1','call_p6_2']);
  fingerprint(provider.ontology);return provider;
}
export function finalizeKnowledgeProvider(result,file) {
  try {
    readProvider(file);result.knowledgeProviderFinal={status:'passed',requests:4};
  } catch(error) {
    result.qualification='failed';
    result.knowledgeProviderFinal={status:'failed',error:error.stack??String(error)};
    result.error??='Knowledge provider final receipt failed';
  }
}
export async function qualifyKnowledgeAgent({command,port,token,stateDir,out,providerReceipt}) {
  const proof=path.join(out,'knowledge');fs.mkdirSync(proof);
  const result={status:'failed',boundary:'admitted-agent-and-operator-rpc',errors:[]};
  const save=(name,value)=>fs.writeFileSync(path.join(proof,name+'.json'),JSON.stringify(value,null,2)+'\n');
  const rpc=async(method,params,label)=>{
    const text=await command('knowledge-'+label,['gateway','call',method,'--url',`ws://127.0.0.1:${port}`,
      '--token',token,'--timeout','120000','--params',JSON.stringify(params),'--json']);
    const value=JSON.parse(text);save(label,value);assert.equal(value.ok,true,method+' rejected');return value;
  };
  const action=async(name,label)=>(await rpc('plugins.sessionAction',{pluginId:'knowledge',actionId:name,payload:{}},label)).result;
  try {
    result.statusBefore=await action('status','status-before');
    assert.equal(result.statusBefore.agent,'main');assert.equal(result.statusBefore.store,'unprovisioned');
    const created=await rpc('sessions.create',{agentId:'main'},'session-create');
    assert.equal(created.entry.chatType,'direct');assert.equal(created.entry.createdVia,'operator');
    assert.equal(created.runStarted,false);assert.equal(typeof created.key,'string');
    result.sessionKey=created.key;
    const turn=JSON.parse(await command('knowledge-turn',['agent','--session-key',created.key,
      '--message',`Inspect Knowledge ontology using its tool, then reply exactly ${KNOWLEDGE_MARKER}`,
      '--json','--timeout','180'],240000));save('turn',turn);
    assert.equal(turn.status,'ok');assert.equal(turn.summary,'completed');
    assert(turn.result?.payloads?.some(item=>item.text===KNOWLEDGE_MARKER),'Agent marker missing');
    const turnStderr=fs.readFileSync(path.join(out,'logs/knowledge-turn.stderr'),'utf8');
    assert(!turnStderr.toLowerCase().includes('falling back'),'Agent fell back from Gateway');
    const provider=readProvider(providerReceipt);save('provider',provider);
    const agentFingerprint=fingerprint(provider.ontology);
    result.statusAfter=await action('status','status-after');
    result.operatorOntology=await action('ontology','ontology-after');
    assert.equal(result.statusAfter.agent,'main');assert.equal(result.statusAfter.store,'ready');
    assert.equal(result.statusAfter.ontologyAvailable,true);assert(result.statusAfter.definitions>0);
    assert.equal(result.statusAfter.ontologyFingerprint,agentFingerprint);
    assert.equal(fingerprint(result.operatorOntology),agentFingerprint);
    const stores=fs.realpathSync(path.join(stateDir,'knowledge/stores'));
    const store=fs.realpathSync(path.join(stores,result.statusAfter.vault));
    assert.equal(path.dirname(store),stores,'Store escaped isolated state');
    result.files=['knowledge/registry.sqlite',path.relative(stateDir,path.join(store,'state.sqlite')),
      path.relative(stateDir,path.join(store,'vault/vault.json'))].map(relative=>{
        const file=path.join(stateDir,relative);assert(fs.statSync(file).isFile());
        const sizeBytes=fs.statSync(file).size;assert(sizeBytes>0);return {path:relative,sizeBytes};
      });
    assert.equal(JSON.parse(fs.readFileSync(path.join(store,'vault/vault.json'),'utf8')).vaultId,result.statusAfter.vault);
    result.providerRequests=4;result.status='passed-operations-only';return result;
  } catch(error) {result.errors.push(error.stack??String(error));throw error;}
  finally {save('result',result);}
}
