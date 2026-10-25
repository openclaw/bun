#!/usr/bin/env node
// Direct-artifact qualification. Source imports below are test owners, never the app under test.
import assert from 'node:assert/strict';
import { readGatewayStopBudget, stopProcess, shutdownFailure } from '../harness/process-stop.mjs';
import { resolveLaunchTarget, launchArguments } from './launch-target.mjs';
import { readProcStat as procIdentity, snapshotProcessTree } from './process-tree.mjs';
import { qualifyConfigRoundtrip } from '../harness/config-roundtrip.mjs';
import { coreFixtureConfig } from '../harness/fixture-config.mjs';
import { hasGatewayReadyLog,isGatewayReadyResponse } from '../harness/gateway-readiness.mjs';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const argv = process.argv.slice(2);
if (argv.includes('--help')) {
  console.log('Usage: node core-runner.mjs (--artifact <complete-standalone-dir> | --runtime <executable> --entry <package/openclaw.mjs>) --source <matching-source> --out <fresh-run-dir> [--zero-js] [--knowledge-control] [--timeout-seconds 180]');
  process.exit(0);
}
const options = {};
for (let i=0;i<argv.length;i++) {
  const key=argv[i];
  if (key==='--zero-js') options.zeroJs=true;
  else if (key==='--knowledge-control') options.knowledgeControl=true;
  else if (['--artifact','--runtime','--entry','--source','--out','--timeout-seconds'].includes(key) && argv[i+1]) options[key.slice(2)]=argv[++i];
  else throw new Error(`Unknown or incomplete option: ${key}`);
}
for (const key of ['source','out']) assert(options[key], `Missing --${key}`);
assert.equal(process.platform,'linux','P6 core qualification requires native Linux');
const source=fs.realpathSync(options.source), launch=resolveLaunchTarget(options);
const {artifact,binary,entry}=launch;
if(options.knowledgeControl) assert.equal(launch.kind,'standalone','Knowledge control requires an admitted standalone artifact');
const out=path.resolve(options.out);
assert(!fs.existsSync(out),'--out must be a fresh directory');
assert(![artifact,source,entry && path.dirname(entry)].filter(Boolean).some(root=>out===root || out.startsWith(root+path.sep)),'--out must be outside source and artifact');
assert(!out.startsWith(path.join(process.env.HOME??'','.openclaw')),'invalid output');
const timeoutMs=Number(options['timeout-seconds']??180)*1000;
assert(Number.isFinite(timeoutMs)&&timeoutMs>=1000&&timeoutMs<=3600000,'invalid timeout');
if (options.zeroJs) {
  assert.equal(launch.kind,'standalone','--zero-js requires a standalone artifact');
  assert(process.platform==='linux','--zero-js requires native Linux strace');
  assert(spawnSync('strace',['--version'],{stdio:'ignore'}).status===0,'strace is required');
}
fs.mkdirSync(out);
for (const part of ['tmp','home','.xdg','workspace','logs','traces']) fs.mkdirSync(path.join(out,part));
const stateDir=path.join(out,'home','.openclaw');
fs.mkdirSync(stateDir);
const configPath=path.join(stateDir,'openclaw.json');
const token=`p6-synthetic-${randomUUID()}`, marker=`P6_STREAM_${randomUUID().replaceAll('-','')}`;
const env={PATH:process.env.PATH??'/usr/local/bin:/usr/bin:/bin',LANG:'C.UTF-8',TZ:'UTC',
 HOME:path.join(out,'home'),USERPROFILE:path.join(out,'home'),OPENCLAW_HOME:path.join(out,'home'),
 XDG_CONFIG_HOME:path.join(out,'.xdg'),TMPDIR:path.join(out,'tmp'),
 OPENCLAW_STATE_DIR:stateDir,OPENCLAW_CONFIG_PATH:configPath,
 OPENCLAW_TEST_WORKSPACE_DIR:path.join(out,'workspace'),
 OPENAI_API_KEY:'p6-synthetic-local-fixture-only',OPENCLAW_GATEWAY_TOKEN:token,
 OPENCLAW_DISABLE_BONJOUR:'1',OPENCLAW_NO_AUTO_UPDATE:'1',OPENCLAW_SKIP_CHANNELS:'1',
 OPENCLAW_SKIP_GMAIL_WATCHER:'1',OPENCLAW_SKIP_CRON:'1',OPENCLAW_SKIP_CANVAS_HOST:'1',
 NO_COLOR:'1',TERM:'dumb',SUCCESS_MARKER:marker,MOCK_PORT:'0',
 OPENCLAW_MOCK_OPENAI_REQUEST_LOG_BODY_MAX_BYTES:'4194304',MOCK_RESPONSE_CHUNK_DELAY_MS:'100',MOCK_REQUEST_LOG:path.join(out,'provider-requests.jsonl')};
const binaryHasher=createHash('sha256');
for await (const chunk of fs.createReadStream(binary)) binaryHasher.update(chunk);
const result={schema:1,at:new Date().toISOString(),artifact,source,binary,platform:process.platform,arch:process.arch,
 binarySha256:binaryHasher.digest('hex'),launchKind:launch.kind,entry,
 entrySha256:entry?createHash('sha256').update(fs.readFileSync(entry)).digest('hex'):null,
 qualification:'incomplete',syntheticOnly:true,checks:{},commands:[],processes:[],cleanup:{},
 limits:['Worker pool census is not proof of every worker lifecycle.','No live provider credentials or live-model proof.','Timing with --zero-js includes tracing overhead; own process counters then refer to strace, not the app.']};
if (artifact && fs.existsSync(path.join(artifact,'manifest.json'))) result.manifest=JSON.parse(fs.readFileSync(path.join(artifact,'manifest.json'),'utf8'));
if(options.knowledgeControl) result.performanceEligible=false;
const children=[],observed=new Map(),stopReceipts=new Map();
const clk=Number(spawnSync('getconf',['CLK_TCK'],{encoding:'utf8'}).stdout?.trim());
const pageSize=Number(spawnSync('getconf',['PAGESIZE'],{encoding:'utf8'}).stdout?.trim());
result.processCounters={clockTicksPerSecond:clk,pageSizeBytes:pageSize};
const log=(name,value)=>fs.writeFileSync(path.join(out,name),JSON.stringify(value,null,2)+'\n');
function census() {
  if (process.platform!=='linux') return;
  const all=[];
  for (const name of fs.readdirSync('/proc')) if (/^\d+$/.test(name)) { const value=procIdentity(Number(name)); if(value) all.push(value); }
  const ids=new Set(children.map(child=>child.pid));
  let changed=true;
  while(changed) { changed=false; for(const item of all) if(ids.has(item.ppid)&&!ids.has(item.pid)){ids.add(item.pid);changed=true;} }
  for(const item of all) if(ids.has(item.pid)) observed.set(`${item.pid}:${item.start}`,item);
}
const sampler=setInterval(census,100);
sampler.unref();
function start(label,command,args,{trace=false,extraEnv={}}={}) {
  const stdout=path.join(out,'logs',label+'.stdout'),stderr=path.join(out,'logs',label+'.stderr');
  const outfd=fs.openSync(stdout,'w'),errfd=fs.openSync(stderr,'w');
  const actual=trace&&options.zeroJs?['strace','-ff','-yy','-s','256','-o',path.join(out,'traces',label),'-e','trace=openat,openat2,read,readv,pread64,preadv,preadv2,mmap,execve,sendfile,splice,copy_file_range,io_uring_setup,io_uring_enter,io_uring_register',command,...args]:[command,...args];
  const child=spawn(actual[0],actual.slice(1),{cwd:source,env:{...env,...extraEnv},detached:true,stdio:['ignore',outfd,errfd]});
  fs.closeSync(outfd);fs.closeSync(errfd);
  child.receipt={label,command:[command,...args],actual,pid:child.pid,stdout,stderr,started:performance.now(),spawnError:null};
  child.once('error',error=>{child.receipt.spawnError=String(error);});
  children.push(child);result.commands.push(child.receipt);
  child.done=new Promise(resolve=>child.once('close',(code,signal)=>{Object.assign(child.receipt,{code,signal,elapsedSeconds:(performance.now()-child.receipt.started)/1000});resolve(child.receipt);}));
  return child;
}
function signalGroup(child,signal) { if(child.pid) try {process.kill(-child.pid,signal);} catch(error){if(error.code!=='ESRCH') throw error;} }
async function stop(child) {
  if (!child?.pid) return;
  const shutdown=await stopProcess(child,{graceMs:child===gateway?result.gatewayStopBudget.serviceStopTimeoutMs:10000});
  stopReceipts.set(child,{label:child.receipt.label,...shutdown});
  return shutdown;
}
async function command(label,args,limit=timeoutMs) {
  const child=start(label,binary,launchArguments(launch,args),{trace:true});
  const complete=await Promise.race([child.done,delay(limit,undefined,{ref:false}).then(()=>null)]);
  if(!complete){await stop(child);throw new Error(`${label} timed out`);}
  assert.equal(complete.spawnError,null,`${label} could not start`);
  assert.equal(complete.code,0,`${label} failed; see ${complete.stderr}`);
  return fs.readFileSync(complete.stdout,'utf8');
}
async function freePort() {
  const server=net.createServer();await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port;
}
let client,mock,gateway;
let interrupted=false;
const interrupt=()=>{interrupted=true;void stop(gateway).catch(error=>{result.stopError=String(error);});for(const child of children) if(child!==gateway) signalGroup(child,'SIGTERM');};
process.on('SIGINT',interrupt);process.on('SIGTERM',interrupt);
const sourceImport=relative=>import(pathToFileURL(path.join(source,relative)).href);
const knowledgeOwner=options.knowledgeControl?await import('../harness/knowledge-agent.mjs'):null;
try {
  result.gatewayStopBudget=await readGatewayStopBudget(source);
  const [{applyMockOpenAiModelConfig},{createGatewayWsClient},{resolveGatewaySuccessPayload},{PROTOCOL_VERSION},{assertOpenAiRequestLogUsed}]=await Promise.all([
    sourceImport('scripts/e2e/lib/fixtures/mock-openai-config.mjs'),sourceImport('scripts/lib/gateway-ws-client.ts'),
    sourceImport('scripts/e2e/lib/gateway-frame-payload.mjs'),sourceImport('packages/gateway-protocol/src/version.ts'),
    sourceImport('scripts/e2e/lib/agent-turn-output.mjs')]);
  mock=options.knowledgeControl
    ?start('knowledge-provider','/usr/bin/python3',[fileURLToPath(new URL('../harness/knowledge-provider.py',import.meta.url)),
      '--receipt',path.join(out,'provider.json'),'--model',knowledgeOwner.KNOWLEDGE_MODEL,'--marker',knowledgeOwner.KNOWLEDGE_MARKER])
    :start('mock-provider',process.execPath,[path.join(source,'scripts/e2e/mock-openai-server.mjs')]);
  let mockPort;
  const mockDeadline=Date.now()+timeoutMs;
  while(Date.now()<mockDeadline) {
    assert(mock.exitCode===null&&!mock.receipt.spawnError,'mock server exited before listener');
    const match=fs.readFileSync(mock.receipt.stdout,'utf8').match(/^mock-openai listening on (\d+)$/m);
    if(match){mockPort=Number(match[1]);break;} await delay(50);
  }
  assert(mockPort,'mock did not publish its allocated listener');
  assert.equal((await fetch(`http://127.0.0.1:${mockPort}/health`,{signal:AbortSignal.timeout(2000)})).status,200);
  const port=await freePort();
  const cfg=coreFixtureConfig({workspace:env.OPENCLAW_TEST_WORKSPACE_DIR,port,token,mockPort,applyMockOpenAiModelConfig,knowledgeControl:options.knowledgeControl});
  fs.writeFileSync(configPath,JSON.stringify(cfg,null,2)+'\n');
  result.checks.version=(await command('version',['--version'])).trim();
  await command('config-validate',['config','validate']);
  if(!options.knowledgeControl) {
    result.checks.configRoundtrip=await qualifyConfigRoundtrip(command);
    await command('doctor',['doctor','--non-interactive']);result.checks.doctor=true;
  }
  gateway=start('gateway',binary,launchArguments(launch,['gateway','run','--port',String(port),'--bind','loopback','--allow-unconfigured']),{trace:true});
  const readyStart=performance.now(),readyDeadline=Date.now()+timeoutMs;
  let ready=false;
  while(Date.now()<readyDeadline) {
    assert(gateway.exitCode===null&&!gateway.receipt.spawnError,'Gateway exited before readiness');
    const text=fs.readFileSync(gateway.receipt.stdout,'utf8')+fs.readFileSync(gateway.receipt.stderr,'utf8');
    if(hasGatewayReadyLog(text)) {
      try { const response=await fetch(`http://127.0.0.1:${port}/readyz`,{signal:AbortSignal.timeout(1000)});
        if(await isGatewayReadyResponse(response)) {ready=true;break;}
      } catch {}
    } await delay(100);
  }
  assert(ready,'Gateway ready log plus /readyz never succeeded');
  result.gatewayReadySeconds=(performance.now()-readyStart)/1000;
  result.readyProcessSnapshot=procIdentity(gateway.pid);
  if(result.readyProcessSnapshot && Number.isFinite(clk)) result.readyOwnCpuSeconds=result.readyProcessSnapshot.cpuTicks/clk;
  if(result.readyProcessSnapshot && Number.isFinite(pageSize)) result.readyOwnRssBytes=result.readyProcessSnapshot.rssPages*pageSize;
  result.readyTree=snapshotProcessTree(gateway.pid,{clockTicks:clk,pageSize});
  result.readyTreeRssBytes=result.readyTree.rssBytes;
  result.readyTreeCpuSeconds=result.readyTree.cpuSeconds;
  if(options.knowledgeControl) {
    result.checks.knowledge=await knowledgeOwner.qualifyKnowledgeAgent({command,port,token,stateDir,out,providerReceipt:path.join(out,'provider.json')});
  } else {
  const events=[];
  client=createGatewayWsClient({url:`ws://127.0.0.1:${port}`,openTimeoutMs:timeoutMs,handshakeTimeoutMs:timeoutMs,onEvent:event=>{
    const observed={at:performance.now(),...event};events.push(observed);
    fs.appendFileSync(path.join(out,'events.jsonl'),JSON.stringify(observed)+'\n');
  }});
  const request=async(method,params={},limit=timeoutMs)=>{const frame=await client.request(method,params,limit);
    assert.equal(frame.ok,true,`${method}: ${JSON.stringify(frame.error)}`);return resolveGatewaySuccessPayload(frame);};
  await client.waitOpen();
  result.hello=await request('connect',{minProtocol:PROTOCOL_VERSION,maxProtocol:PROTOCOL_VERSION,
    client:{id:'gateway-client',displayName:'p6-direct-aot',version:'1.0.0',platform:process.platform,mode:'backend'},
    role:'operator',scopes:['operator.read','operator.write','operator.admin'],caps:[],auth:{token}});
  result.lanesBefore=await request('diagnostics.lanes');
  const sessionKey=`agent:main:p6-${randomUUID()}`;
  const turnBefore=procIdentity(gateway.pid);
  result.beforeTurnTree=snapshotProcessTree(gateway.pid,{clockTicks:clk,pageSize,expectedStart:result.readyTree.root.start});
  const turnStart=performance.now();
  const started=await request('chat.send',{sessionKey,message:`Return marker ${marker}.`,idempotencyKey:randomUUID(),deliver:false});
  assert.equal(started.status,'started','chat.send status');assert.equal(typeof started.runId,'string','chat.send runId');
  result.started=started;
  const waited=await request('agent.wait',{runId:started.runId,timeoutMs},timeoutMs+5000);
  assert.equal(waited.status,'ok','agent.wait status');result.waited=waited;
  const history=await request('chat.history',{sessionKey,limit:20});log('history.json',history);
  const assistant=history.messages?.findLast(item=>item.role==='assistant');
  const answer=typeof assistant?.content==='string'?assistant.content:(assistant?.content??[]).filter(part=>part.type==='text').map(part=>part.text).join('\n');
  assert(answer.includes(marker),'chat.history assistant marker missing');
  const deadline=Date.now()+5000;
  const matching=()=>events.filter(event=>event.payload?.runId===started.runId);
  const isDelta=event=>(event.event==='chat'&&event.payload?.state==='delta')||(event.event==='agent'&&event.payload?.stream==='assistant'&&typeof event.payload?.data?.delta==='string'&&event.payload.data.delta.length>0);
  const isFinal=event=>event.event==='chat'&&event.payload?.state==='final';
  while(Date.now()<deadline && !(matching().some(isDelta)&&matching().some(isFinal))) await delay(50);
  const runEvents=matching();
  assert(runEvents.some(isDelta),'no actual streamed delta observed for returned runId');
  assert(runEvents.some(isFinal),'no terminal chat final event observed for returned runId');
  const firstDelta=runEvents.find(isDelta),final=runEvents.find(isFinal);
  assert(firstDelta.at<=final.at,'terminal event preceded every observed delta');
  result.turn={runId:started.runId,seconds:(performance.now()-turnStart)/1000,firstDeltaSeconds:(firstDelta.at-turnStart)/1000,deltaEvents:runEvents.filter(isDelta).length,terminalEvents:runEvents.filter(isFinal).length,marker};
  assertOpenAiRequestLogUsed(env.MOCK_REQUEST_LOG,'P6 synthetic provider');
  const requests=fs.readFileSync(env.MOCK_REQUEST_LOG,'utf8').trim().split('\n').map(line=>JSON.parse(line));
  assert(requests.some(row=>{try {const body=typeof row.body==='string'?JSON.parse(row.body):row.body;return /\/v1\/(responses|chat\/completions)/.test(row.path)&&body?.stream===true&&JSON.stringify(body).includes(marker);}catch{return false;}}),'provider log lacks actual streaming inference request with this turn marker');
  result.turnProcessSnapshot=procIdentity(gateway.pid);
  if(turnBefore && result.turnProcessSnapshot && Number.isFinite(clk)) result.turnOwnCpuSeconds=(result.turnProcessSnapshot.cpuTicks-turnBefore.cpuTicks)/clk;
  if(result.turnProcessSnapshot && Number.isFinite(pageSize)) result.turnOwnRssBytes=result.turnProcessSnapshot.rssPages*pageSize;
  result.afterTurnTree=snapshotProcessTree(gateway.pid,{clockTicks:clk,pageSize,expectedStart:result.readyTree.root.start});
  result.turnTreeRssBytes=result.afterTurnTree.rssBytes;
  result.turnTreeCpuSeconds=(result.afterTurnTree.cpuTicks-result.beforeTurnTree.cpuTicks)/clk;
  assert(result.turnTreeCpuSeconds>=0,'tree CPU counter decreased across non-atomic snapshots; cohort metric invalid');
  result.checks.streamedTurn=true;
  result.sessionDescription=await request('sessions.describe',{key:sessionKey,includeLastMessage:true});
  assert(result.sessionDescription.session,'sessions.describe omitted completed session');
  result.lanesAfter=await request('diagnostics.lanes');
  result.workerObservation={kind:'public-pool-census-plus-returned-session-read',before:result.lanesBefore.workerCount,after:result.lanesAfter.workerCount,perWorkerCompletion:'not-exposed-by-this-RPC'};
  }
  result.qualification='passed';
} catch(error) {result.error=error?.stack??String(error);result.qualification='failed';}
finally {
  try{client?.close();}catch{}
  await stop(gateway);await stop(mock);
  for(const child of children) await stop(child);
  if(options.knowledgeControl) knowledgeOwner.finalizeKnowledgeProvider(result,path.join(out,'provider.json'));
  census();clearInterval(sampler);
  let live=[];
  const cleanupDeadline=Date.now()+10000;
  do {
    live=[];
    for(const item of observed.values()) {const current=procIdentity(item.pid);if(current?.start===item.start&&current.state!=='Z') live.push(current);}
    if(!live.length) break;
    await delay(100);
  } while(Date.now()<cleanupDeadline);
  for(const item of live) {const current=procIdentity(item.pid);if(current?.start===item.start) try{process.kill(item.pid,'SIGKILL');}catch(error){if(error.code!=='ESRCH')throw error;}}
  await delay(50);
  const survivors=live.filter(item=>{const current=procIdentity(item.pid);return current?.start===item.start&&current.state!=='Z';});
  result.processes=[...observed.values()];result.cleanup={observedPids:observed.size,requiredForcedCleanup:live.map(item=>item.pid),survivors,stops:[...stopReceipts.values()]};
  const stopFailure=result.stopError??shutdownFailure(result.cleanup.stops,gateway?.receipt);
  if(stopFailure){result.qualification='failed';result.cleanup.error=stopFailure;}
  if(survivors.length||live.length){result.qualification='failed';result.cleanup.error='Task process survived normal shutdown';}
  if(options.zeroJs) {
    const analyzer=path.join(path.dirname(fileURLToPath(import.meta.url)),'../harness/analyze-zero-js.py');
    const traceResult=spawnSync('python3',[analyzer,'--trace-dir',path.join(out,'traces'),'--binary',binary,'--out',path.join(out,'zero-js.json')],{encoding:'utf8',env});
    result.zeroJs={exitCode:traceResult.status,stdout:traceResult.stdout,stderr:traceResult.stderr};
    if(traceResult.status!==0)result.qualification='failed';
  }
  if(interrupted){result.qualification='failed';result.interrupted=true;}
  process.off('SIGINT',interrupt);process.off('SIGTERM',interrupt);
  log('result.json',result);
}
console.log(JSON.stringify({qualification:result.qualification,result:path.join(out,'result.json'),error:result.error??result.cleanup.error}));
process.exitCode=result.qualification==='passed'?0:1;
