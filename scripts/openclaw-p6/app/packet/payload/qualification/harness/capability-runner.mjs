#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readGatewayStopBudget, stopProcess, shutdownFailure } from './process-stop.mjs';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath,pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { CAPABILITY_CASES,createCapabilityServer } from './legacy/capability-provider.mjs';
import { capabilityFixtureConfig } from './fixture-config.mjs';
import { hasGatewayReadyLog,isGatewayReadyResponse } from './gateway-readiness.mjs';
const args=process.argv.slice(2),o={};
if(args.includes('--help')){console.log('Usage: node capability-runner.mjs --artifact DIR --source DIR --out FRESH_DIR --scenario node-vm|pty|plugin [--native-workers]');process.exit(0);}
for(let i=0;i<args.length;i++){
 if(args[i]==='--native-workers')o.nativeWorkers=true;
 else if(['--artifact','--source','--out','--scenario'].includes(args[i])&&args[i+1])o[args[i].slice(2)]=args[++i];
 else throw new Error(`Invalid option ${args[i]}`);
}
for(const key of ['artifact','source','out','scenario'])assert(o[key],`Missing --${key}`);
assert.equal(process.platform,'linux','Linux native flow only');
assert(['node-vm','pty','plugin'].includes(o.scenario),'invalid scenario');
assert(!(o.nativeWorkers&&o.scenario==='plugin'),'native Worker trace is a Gateway tool diagnostic; run plugin separately');
const artifact=fs.realpathSync(o.artifact),source=fs.realpathSync(o.source),out=path.resolve(o.out),binary=path.join(artifact,'openclaw');
assert(!fs.existsSync(out),'fresh output required');
assert(![artifact,source,path.join(process.env.HOME??'','.openclaw')].some(p=>out===p||out.startsWith(p+path.sep)),'unsafe output');
fs.accessSync(binary,fs.constants.X_OK);assert(fs.statSync(path.join(artifact,'runtime')).isDirectory());
fs.mkdirSync(out);for(const dir of ['home','tmp','workspace','logs','native-workers'])fs.mkdirSync(path.join(out,dir));
const state=path.join(out,'home','.openclaw');fs.mkdirSync(state);
const cfgfile=path.join(state,'openclaw.json'),token=`p6-capability-${randomUUID()}`;
const env={PATH:process.env.PATH??'/usr/local/bin:/usr/bin:/bin',LANG:'C.UTF-8',TZ:'UTC',
 HOME:path.join(out,'home'),USERPROFILE:path.join(out,'home'),OPENCLAW_HOME:path.join(out,'home'),
 OPENCLAW_STATE_DIR:state,OPENCLAW_CONFIG_PATH:cfgfile,TMPDIR:path.join(out,'tmp'),
 OPENCLAW_TEST_WORKSPACE_DIR:path.join(out,'workspace'),OPENAI_API_KEY:'p6-synthetic-local-only',
 OPENCLAW_GATEWAY_TOKEN:token,OPENCLAW_NO_RESPAWN:'1',OPENCLAW_SUPERVISOR_MODE:'external',OPENCLAW_SERVICE_REPAIR_POLICY:'external',OPENCLAW_DISABLE_BONJOUR:'1',OPENCLAW_NO_AUTO_UPDATE:'1',
 OPENCLAW_SKIP_CHANNELS:'1',OPENCLAW_SKIP_CRON:'1',OPENCLAW_SKIP_GMAIL_WATCHER:'1',OPENCLAW_SKIP_CANVAS_HOST:'1',TERM:'dumb',NO_COLOR:'1'};
const result={schema:1,scenario:o.scenario,artifact,source,controllerPid:process.pid,arch:process.arch,kernel:spawnSync('uname',['-r'],{encoding:'utf8'}).stdout?.trim(),pass:false,syntheticOnly:true,commands:[],performanceEligible:false};
const hasher=createHash('sha256');for await(const chunk of fs.createReadStream(binary))hasher.update(chunk);result.binarySha256=hasher.digest('hex');
const children=[],observed=new Map(),stopReceipts=new Map();let gateway,client,server,interrupted=false;
function identity(pid){try{const raw=fs.readFileSync(`/proc/${pid}/stat`,'utf8'),v=raw.slice(raw.lastIndexOf(')')+2).split(' ');return{pid,ppid:Number(v[1]),state:v[0],start:v[19]};}catch{return null;}}
function scan(){const all=[];for(const name of fs.readdirSync('/proc'))if(/^\d+$/.test(name)){const p=identity(Number(name));if(p)all.push(p);}
 const ids=new Set(children.map(c=>c.pid));let more=true;while(more){more=false;for(const p of all)if(ids.has(p.ppid)&&!ids.has(p.pid)){ids.add(p.pid);more=true;}}
 for(const p of all)if(ids.has(p.pid))observed.set(`${p.pid}:${p.start}`,p);}
const sampler=setInterval(scan,100);sampler.unref();
function signal(c,sig){if(c?.pid)try{process.kill(-c.pid,sig);}catch(error){if(error.code!=='ESRCH')throw error;}}
const interrupt=()=>{interrupted=true;void stop(gateway).catch(error=>{result.stopError=String(error);});for(const c of children)if(c!==gateway)signal(c,'SIGTERM');};process.on('SIGTERM',interrupt);process.on('SIGINT',interrupt);
function launch(label,cmd,argv,{native=false}={}){
 const stdout=path.join(out,'logs',label+'.stdout'),stderr=path.join(out,'logs',label+'.stderr'),a=fs.openSync(stdout,'w'),b=fs.openSync(stderr,'w');
 const extra=native&&o.nativeWorkers?{BUN_WORKER_VM_TRACE:path.join(out,'native-workers','worker-%p.jsonl')}:{};
 const child=spawn(cmd,argv,{cwd:source,env:{...env,...extra},detached:true,stdio:['ignore',a,b]});fs.closeSync(a);fs.closeSync(b);
 const row={label,command:[cmd,...argv],pid:child.pid,stdout,stderr,runtimeOverride:extra};child.row=row;children.push(child);result.commands.push(row);
 child.done=new Promise(resolve=>{child.once('error',error=>{row.spawnError=String(error);});child.once('close',(code,sig)=>{Object.assign(row,{code,signal:sig});resolve(row);});});return child;
}
async function stop(c){if(!c?.pid)return;
 const shutdown=await stopProcess(c,{graceMs:c===gateway?result.gatewayStopBudget.serviceStopTimeoutMs:10000,killWaitMs:3000});
 stopReceipts.set(c,{label:c.row.label,...shutdown});return shutdown;}
async function command(label,argv,{allowFailure=false,cmd=binary}={}){const c=launch(label,cmd,argv),row=await Promise.race([c.done,delay(180000,undefined,{ref:false}).then(()=>null)]);
 if(!row){await stop(c);throw new Error(`${label} timed out`);}assert(!row.spawnError,`${label} could not launch`);if(!allowFailure)assert.equal(row.code,0,`${label}: see ${row.stderr}`);return{row,text:fs.readFileSync(row.stdout,'utf8')};}
async function port(){const s=net.createServer();await new Promise((yes,no)=>{s.once('error',no);s.listen(0,'127.0.0.1',yes);});const p=s.address().port;await new Promise(r=>s.close(r));return p;}
const sourceImport=relative=>import(pathToFileURL(path.join(source,relative)).href);
try{
 result.gatewayStopBudget=await readGatewayStopBudget(source);
 const {applyMockOpenAiModelConfig}=await sourceImport('scripts/e2e/lib/fixtures/mock-openai-config.mjs');
 const gatewayPort=await port();
 let cfg;
 if(o.scenario==='plugin'){
  cfg=capabilityFixtureConfig({workspace:env.OPENCLAW_TEST_WORKSPACE_DIR,port:gatewayPort,token,scenario:o.scenario});
  fs.writeFileSync(cfgfile,JSON.stringify(cfg,null,2)+'\n');
  const {writeCliPlugin}=await sourceImport('scripts/e2e/lib/fixtures/plugins.mjs');
  const pluginDir=path.join(out,'plugin-fixture'),id='p6-external-fixture',cli='p6-fixture',marker='P6_EXTERNAL_PLUGIN_OK';
  fs.mkdirSync(pluginDir);writeCliPlugin([pluginDir,id,'0.0.1','p6.fixture','P6 external fixture',cli,marker],null);
  await command('plugin-install',['-c','source "$1/scripts/lib/openclaw-e2e-instance.sh"; p6_fixture_node="$4"; node() { "$p6_fixture_node" "$@"; }; openclaw_e2e_fixture_plugin_command "$2" -- plugins install "$3" --force','p6-plugin',source,binary,pluginDir,process.execPath],{cmd:'/bin/bash'});
  await command('plugin-enable',['plugins','enable',id]);
  const invoked=await command('plugin-command',[cli,'ping']);assert(invoked.text.split(/\r?\n/).some(line=>line.trim()===marker),'external plugin command marker missing');
  const inspected=await command('plugin-inspect',['plugins','inspect',id,'--runtime','--json']);assert(inspected.text.includes(id),'runtime inspection omitted fixture');
  await command('plugin-uninstall',['plugins','uninstall',id,'--force']);
  const removed=await command('plugin-command-after-uninstall',[cli,'ping'],{allowFailure:true});assert.notEqual(removed.row.code,0,'removed external plugin command still works');
  result.plugin={installed:true,enabled:true,commandMarker:marker,runtimeInspected:true,uninstalled:true,removedCommandRejected:true};
 }else{
  const scenario=CAPABILITY_CASES[o.scenario],receipt=path.join(out,'provider.jsonl');
  server=createCapabilityServer({mode:o.scenario,receipt});await new Promise((yes,no)=>{server.once('error',no);server.listen(0,'127.0.0.1',yes);});
  const providerPort=server.address().port;
  cfg=capabilityFixtureConfig({workspace:env.OPENCLAW_TEST_WORKSPACE_DIR,port:gatewayPort,token,scenario:o.scenario,mockPort:providerPort,applyMockOpenAiModelConfig});
  fs.writeFileSync(cfgfile,JSON.stringify(cfg,null,2)+'\n');
  await command('config-validate',['config','validate']);
  gateway=launch('gateway',binary,['gateway','run','--port',String(gatewayPort),'--bind','loopback','--allow-unconfigured'],{native:true});
  const deadline=Date.now()+180000;let ready=false;
  while(Date.now()<deadline){assert(gateway.exitCode===null&&!gateway.row.spawnError,'Gateway exited before ready');
   const text=fs.readFileSync(gateway.row.stdout,'utf8')+fs.readFileSync(gateway.row.stderr,'utf8');
   if(hasGatewayReadyLog(text))try{const r=await fetch(`http://127.0.0.1:${gatewayPort}/readyz`,{signal:AbortSignal.timeout(1000)});if(await isGatewayReadyResponse(r)){ready=true;break;}}catch{}
   await delay(100);}
  assert(ready,'Gateway readiness failed');
  // Preserve family20 capability precondition; these are feature rows, not timing rows.
  result.readySettleSeconds=5;await delay(5000);
  const [{createGatewayWsClient},{resolveGatewaySuccessPayload},{PROTOCOL_VERSION}]=await Promise.all([sourceImport('scripts/lib/gateway-ws-client.ts'),sourceImport('scripts/e2e/lib/gateway-frame-payload.mjs'),sourceImport('packages/gateway-protocol/src/version.ts')]);
  client=createGatewayWsClient({url:`ws://127.0.0.1:${gatewayPort}`,openTimeoutMs:60000,onEvent:event=>fs.appendFileSync(path.join(out,'events.jsonl'),JSON.stringify(event)+'\n')});await client.waitOpen();
  const request=async(method,params={},timeout=180000)=>{const frame=await client.request(method,params,timeout);assert.equal(frame.ok,true,`${method}: ${JSON.stringify(frame.error)}`);return resolveGatewaySuccessPayload(frame);};
  await request('connect',{minProtocol:PROTOCOL_VERSION,maxProtocol:PROTOCOL_VERSION,client:{id:'gateway-client',displayName:'p6-capabilities',version:'1.0.0',platform:process.platform,mode:'backend'},role:'operator',scopes:['operator.read','operator.write','operator.admin'],caps:[],auth:{token}});
  const sessionKey=`agent:main:p6-${o.scenario}-${randomUUID()}`;
  const started=await request('chat.send',{sessionKey,message:`Complete the synthetic capability check and return exactly ${scenario.marker}`,idempotencyKey:randomUUID(),deliver:false});
  assert.equal(started.status,'started');assert.equal(typeof started.runId,'string');
  const waited=await request('agent.wait',{runId:started.runId,timeoutMs:180000},185000);assert.equal(waited.status,'ok');
  const history=await request('chat.history',{sessionKey,limit:20}),assistant=history.messages?.findLast(row=>row.role==='assistant');
  const answer=typeof assistant?.content==='string'?assistant.content:(assistant?.content??[]).filter(p=>p.type==='text').map(p=>p.text).join('\n');
  assert.equal(answer.trim(),scenario.marker,'final assistant marker differs');
  const receipts=fs.readFileSync(receipt,'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(receipts.length,2,'expected exactly one tool request and one continuation');
  assert.deepEqual(receipts.map(row=>row.outcome),['tool-issued','marker-complete']);assert(receipts.every(row=>row.status===200&&row.mode===o.scenario));
  assert.equal(receipts[0].toolCallId,receipts[1].toolCallId);assert.equal(receipts[1].toolOutputMarkerPresent,true);
  result.turn={started,waited,marker:scenario.marker,providerReceipts:receipts};
  result.owningOperation=o.scenario==='node-vm'?'Code Mode Node executor returned marked text through its Worker/VM owner':'exec pty:true returned marker only after stdin and stdout were terminals';
 }
 result.pass=true;
}catch(error){result.error=error.stack??String(error);}
finally{
 try{client?.close();}catch{}await stop(gateway);for(const c of children)await stop(c);
 if(server)await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});
 scan();clearInterval(sampler);
 const deadline=Date.now()+10000;let live=[];
 do{live=[...observed.values()].filter(p=>{const q=identity(p.pid);return q?.start===p.start&&q.state!=='Z';});if(!live.length)break;await delay(100);}while(Date.now()<deadline);
 result.cleanup={observedPids:[...observed.values()],forced:live,stops:[...stopReceipts.values()]};
 const stopFailure=result.stopError??shutdownFailure(result.cleanup.stops,gateway?.row);
 if(stopFailure){result.pass=false;result.cleanup.error=stopFailure;}
 if(live.length){result.pass=false;for(const p of live){const q=identity(p.pid);if(q?.start===p.start)try{process.kill(p.pid,'SIGKILL');}catch(error){if(error.code!=='ESRCH')throw error;}}}
 if(o.nativeWorkers){const analyzer=path.join(path.dirname(fileURLToPath(import.meta.url)),'analyze-workers.py');
  const analyzed=spawnSync('python3',[analyzer,'--directory',path.join(out,'native-workers'),'--controller-pid',String(process.pid),'--out',path.join(out,'native-workers.json')],{encoding:'utf8',env});
  result.nativeWorkers={exitCode:analyzed.status,stdout:analyzed.stdout,stderr:analyzed.stderr};if(analyzed.status!==0)result.pass=false;}
 if(interrupted){result.pass=false;result.interrupted=true;}
 process.off('SIGTERM',interrupt);process.off('SIGINT',interrupt);
 fs.writeFileSync(path.join(out,'result.json'),JSON.stringify(result,null,2)+'\n');
}
console.log(JSON.stringify({pass:result.pass,scenario:o.scenario,result:path.join(out,'result.json'),error:result.error}));process.exitCode=result.pass?0:1;
