/** Offline actual-SDK context/latency campaign; no external model or credential use. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {draftInProgress} from '../draft-phase.mjs';
import http from 'node:http';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {createAgentSession,DefaultResourceLoader,ModelRuntime,SessionManager,SettingsManager,defineTool} from '@earendil-works/pi-coding-agent';
import {Type} from '@earendil-works/pi-ai';
import {output,roots,repository,prepare} from './prepare.mjs';
import {piVersion} from '../../scripts/pi-host.mjs';

prepare();
const production=process.argv.includes('--production');
if(production)fs.cpSync(path.join(repository,'extensions'),path.join(roots.candidate,'extensions'),{recursive:true});
const diagnosePrefix=process.argv.includes('--diagnose-prefix');
const evidence=path.join(repository,'specs/2026-10-23-continuation-defaults-validation/evidence');
fs.mkdirSync(evidence,{recursive:true});
const digest=value=>createHash('sha256').update(value).digest('hex');
const percentile=(values,p)=>values.length?[...values].sort((a,b)=>a-b)[Math.min(values.length-1,Math.floor(values.length*p))]:null;
const profiles={};
for(const [policy,root] of Object.entries(diagnosePrefix?{}:roots)){
 fs.cpSync(path.join(repository,'experiments/context'),path.join(root,'experiments/context'),{recursive:true});
 profiles[policy]={};
 for(const mode of ['context','entry'])profiles[policy][mode]=JSON.parse(execFileSync(process.execPath,
  ['--experimental-strip-types',path.join(repository,'experiments/continuation/profile-worker.mjs'),root,mode],
  {cwd:repository,encoding:'utf8',maxBuffer:8*1024*1024}));
}
if(!diagnosePrefix){
 for(const policy of ['current','candidate'])assert.deepEqual(profiles[policy].context.rows,profiles.original.context.rows,'equal-state complete captured requests must match original');
 for(const row of profiles.candidate.entry.rows)assert.equal(row.snapshots,row.optIn?1000:0);
}

const text=value=>({text:value});const tool=(name,args)=>({tool:name,args});
const results=[];
async function run(policy,scenario,{optIn=false,guard,cap}={}){
 const id=[policy,scenario,optIn?'enabled':'default',guard??'',cap?`cap-${cap}`:''].filter(Boolean).join('-');
 const cwd=path.join(output,'efficiency',id);fs.rmSync(cwd,{recursive:true,force:true});fs.mkdirSync(path.join(cwd,'.pi'),{recursive:true});
 fs.writeFileSync(path.join(cwd,'.pi/pi-goal-x-settings.json'),JSON.stringify({...(optIn?{idleContinuationBackoff:true}:{}),...(cap?{maxAutonomousRuns:cap}:{}),...(scenario==='wait'?{strictExecutionContract:true}:{})}));
 process.env.PI_GOAL_GLOBAL_SETTINGS_FILE=path.join(cwd,'global.json');fs.writeFileSync(process.env.PI_GOAL_GLOBAL_SETTINGS_FILE,'{}');
 const finish=[tool('write',{path:'result.txt',content:'verified result\n'}),text('The result is ready for independent verification.'),tool('update_goal',{status:'complete'})];
 const plan=scenario==='reasoning'?Array.from({length:12},(_,i)=>text(`Reasoning step ${i+1}: resolve a distinct assumption before recording the result.`)).concat(finish)
  :scenario==='custom'?Array.from({length:3},(_,i)=>[tool('publish_report',{stage:i+1}),text(`Saved report section ${i+1}.`)]).flat().concat(finish)
  :scenario==='wait'?[tool('update_goal',{continuation:{kind:'wait',reason:'Wait for the explicitly registered fixture producer',deadline:new Date(Date.now()+10000).toISOString()}}),...finish]
  :scenario==='busy-poll'?Array.from({length:32},()=>[tool('bash',{command:'ls .'}),text('Standing by.')]).flat()
  :Array.from({length:32},()=>text('Standing by.'));
 const requests=[],dispatchMs=[],errors=[],choices=[];let session,core,piApi,step=0,done=false,outcome,lastSettled,toolCallsInRun=0,draftRun=false,noToolRuns=0,settlements=0,waitQuiet,waitWakeMs;
 const server=http.createServer(async(req,res)=>{
  let body='';for await(const chunk of req)body+=chunk;
  const payload=JSON.parse(body);const audit=/read-only completion auditor/i.test(JSON.stringify(payload.messages?.[0]));
  const draft=!audit&&draftInProgress(payload.messages);
  const action=audit?text('The result.txt fixture contains exactly the expected result.\n<approved/>'):draft?tool('propose_goal_draft',{objective:'Produce result.txt containing exactly verified result followed by a newline. Verify it and complete the goal.'}):(plan[step++]??text('Standing by.'));
  const at=performance.now();if(!audit&&!draft&&lastSettled!==undefined){dispatchMs.push(at-lastSettled);lastSettled=undefined;}
  // Pi can append a system-role prompt delta inside history. Its role does
  // not make it part of the leading static prefix: preserve its actual position.
  const firstHistoryIndex=payload.messages.findIndex(m=>!['system','developer'].includes(m.role));
  const leading=firstHistoryIndex<0?payload.messages:payload.messages.slice(0,firstHistoryIndex);
  const prefix=JSON.stringify({system:leading,tools:payload.tools});
  const normalizedMessages=JSON.stringify(payload.messages).split(cwd).join('/fixture');
  const prior=requests.at(-1)?.normalizedMessages;
  let commonPrefixChars=0;if(prior)while(commonPrefixChars<Math.min(prior.length,normalizedMessages.length)&&prior[commonPrefixChars]===normalizedMessages[commonPrefixChars])commonPrefixChars++;
  requests.push({audit,draft,goalActive:!!core?.state.goal,action:action.tool??'text',at,payloadBytes:Buffer.byteLength(body),messageBytes:Buffer.byteLength(JSON.stringify(payload.messages)),
   toolSchemaBytes:Buffer.byteLength(JSON.stringify(payload.tools)),toolSchemaSHA256:digest(JSON.stringify(payload.tools)),leadingSystemChars:JSON.stringify(leading).length,
   leading:JSON.stringify(leading),staticPrefixSHA256:digest(prefix),commonMessagePrefixChars:commonPrefixChars,normalizedMessages,
   appendedSystemMessages:payload.messages.slice(Math.max(0,firstHistoryIndex)).filter(m=>['system','developer'].includes(m.role)).length});
  res.writeHead(200,{'content-type':'text/event-stream'});
  const emit=(delta,finish_reason=null)=>res.write(`data: ${JSON.stringify({id:'efficiency',object:'chat.completion.chunk',created:1,model:'fixture',choices:[{index:0,delta,finish_reason}]})}\n\n`);
  if(action.tool){emit({role:'assistant',tool_calls:[{index:0,id:`call_${requests.length}`,type:'function',function:{name:action.tool,arguments:JSON.stringify(action.args)}}]});emit({},'tool_calls');}
  else{emit({role:'assistant',content:action.text});emit({},'stop');}res.end('data: [DONE]\n\n');
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{
  const runtime=await ModelRuntime.create({authPath:path.join(cwd,'auth.json'),modelsPath:null,allowModelNetwork:false,refreshOnCreate:false});
  runtime.registerProvider('fixture',{baseUrl:`http://127.0.0.1:${server.address().port}/v1`,api:'openai-completions',apiKey:'fixture',models:[{id:'fixture',name:'Fixture',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:200000,maxTokens:512}]});
  const {default:extension}=await import(pathToFileURL(path.join(roots[policy],'extensions/goal.ts')));
  const loader=new DefaultResourceLoader({cwd,agentDir:path.join(cwd,'agent'),noExtensions:true,noSkills:true,noThemes:true,noPromptTemplates:true,noContextFiles:true,extensionFactories:[pi=>{
   pi.registerTool(defineTool({name:'publish_report',label:'Publish report',description:'Save a completed report section.',parameters:Type.Object({stage:Type.Number()}),async execute(_id,args){fs.appendFileSync(path.join(cwd,'report.txt'),`section ${args.stage}\n`);return{content:[{type:'text',text:'Saved.'}],details:{saved:true}};}}));
   extension(pi);core=pi._goalCore;piApi=pi;
   pi.on('tool_execution_start',event=>{toolCallsInRun++;if(event.toolName==='propose_goal_draft')draftRun=true;});
   pi.on('agent_settled',()=>{
    if(draftRun){draftRun=false;toolCallsInRun=0;return;}
    lastSettled=performance.now();settlements++;noToolRuns=toolCallsInRun?0:noToolRuns+1;toolCallsInRun=0;
    const goal=core.state.goal;
    if(scenario==='wait'&&goal?.scheduler?.phase==='waiting'&&waitQuiet===undefined){
     waitQuiet=false;const count=requests.length,token=goal.scheduler.wait.token;
     setTimeout(()=>{waitQuiet=requests.length===count;const at=performance.now();piApi.events.emit('pi-goal:wake',{goalId:goal.id,waitToken:token});piApi.events.emit('pi-goal:wake',{goalId:goal.id,waitToken:token});waitWakeMs=at;},250);
     return;
    }
    if(!goal){outcome='completed';done=true;}
    else if(goal.scheduler?.idle?.nextAt>Date.now()){outcome='paced';done=true;}
    else if(goal.status==='paused'){outcome='product-run-cap';done=true;}
    // Counterfactual harness guards only: one initial execution, then 1 or 8
    // additional consecutive tool-free executions. No competing runtime runs.
    else if(guard&&noToolRuns>=(guard==='one-additional'?2:9)){outcome='harness-policy-guard';done=true;}
    else if(settlements>=32){outcome='harness-ceiling';done=true;}
    if(done&&outcome!=='paced'){core.scheduler.shutdown();core.runtime.clearContinuationState();}
   });
  }]});
  await loader.reload();
  ({session}=await createAgentSession({cwd,agentDir:path.join(cwd,'agent'),modelRuntime:runtime,model:runtime.getModel('fixture','fixture'),resourceLoader:loader,sessionManager:SessionManager.create(cwd,path.join(cwd,'sessions')),settingsManager:SettingsManager.inMemory({retry:{enabled:false},compaction:{enabled:false}})}));
  const ui={...session.extensionRunner.createContext().ui,custom:undefined,
   async select(title,options){const answer=options.find(o=>/confirm.*create/i.test(o))??options.find(o=>/^Enabled\b/i.test(o))??options[0];choices.push({title:title.split('\n')[0],answer});return answer;},
   async confirm(){return true;},async input(){return 'Use the stated objective.';}};
  await session.bindExtensions({mode:'rpc',uiContext:ui,onError:event=>errors.push(event.error)});
  await session.prompt('/goal Produce result.txt containing exactly verified result followed by a newline. Verify it and complete the goal.');
  const deadline=Date.now()+12000;while(!done&&Date.now()<deadline)await delay(5);
  assert.ok(done,`timeout: ${id}`);assert.deepEqual(errors,[]);
  const count=requests.length;await delay(100);assert.equal(requests.length,count,'no request while paced/wait complete/harness stopped');
  const artifact=fs.existsSync(path.join(cwd,'result.txt'))?fs.readFileSync(path.join(cwd,'result.txt'),'utf8'):null;
  const expected=guard?'harness-policy-guard':cap?'product-run-cap':(policy==='current'||optIn)&&['idle','reasoning','custom'].includes(scenario)?'paced':['idle','busy-poll'].includes(scenario)?'harness-ceiling':'completed';
  assert.equal(outcome,expected,id);if(outcome==='completed')assert.equal(artifact,'verified result\n');
  const executor=requests.filter(r=>!r.audit&&!r.draft);
  const activeExecutor=executor.filter(r=>r.goalActive);
  const prefixVariants=new Set(activeExecutor.map(r=>r.staticPrefixSHA256)).size;
  const prefixChanges=activeExecutor.flatMap((r,i)=>i===0||r.staticPrefixSHA256!==activeExecutor[i-1].staticPrefixSHA256?[{executorRequest:i+1,action:r.action,leadingSystemChars:r.leadingSystemChars,staticPrefixSHA256:r.staticPrefixSHA256}]:[]);
  const prefixDeltas=activeExecutor.flatMap((r,i)=>{
   if(i===0||r.leading===activeExecutor[i-1].leading)return [];
   const before=activeExecutor[i-1].leading,after=r.leading;let head=0,tail=0;
   while(head<Math.min(before.length,after.length)&&before[head]===after[head])head++;
   while(tail<Math.min(before.length,after.length)-head&&before.at(-1-tail)===after.at(-1-tail))tail++;
   return [{executorRequest:i+1,removed:before.slice(head,before.length-tail),added:after.slice(head,after.length-tail)}];
  });
  assert.equal(new Set(activeExecutor.map(r=>r.toolSchemaSHA256)).size,1,'execution tool schemas remain stable');
  if(scenario==='wait'){assert.equal(waitQuiet,true);waitWakeMs=requests.find(r=>r.action==='write').at-waitWakeMs;}
  const milestones=[1,2,4,8,16,32].filter(n=>n<=executor.length).map(n=>({request:n,messageBytes:executor[n-1].messageBytes,payloadBytes:executor[n-1].payloadBytes,
   cumulativeMessageBytes:executor.slice(0,n).reduce((sum,r)=>sum+r.messageBytes,0),commonMessagePrefixChars:executor[n-1].commonMessagePrefixChars,
   appendedSystemMessages:executor[n-1].appendedSystemMessages}));
  results.push({id,policy,scenario,optIn,guard,cap,outcome,requests:requests.length,draftRequests:requests.filter(r=>r.draft).length,choices,executorRequests:executor.length,auditorRequests:requests.filter(r=>r.audit).length,settlements,artifact,
   dispatch:{samples:dispatchMs.length,p50Ms:percentile(dispatchMs,.5),p95Ms:percentile(dispatchMs,.95),maxMs:dispatchMs.length?Math.max(...dispatchMs):null},
   staticPrefixStable:prefixVariants===1,prefixVariants,prefixChanges,prefixDeltas,prefixScope:'leading system/developer messages + tool schemas; active executor only; host prompt materialization transitions are reported',toolSchemaStable:true,toolSchemaBytes:executor[0].toolSchemaBytes,milestones,waitQuiet,waitWakeMs,errors});
  console.log(JSON.stringify({id,outcome,requests:requests.length,dispatchP95Ms:percentile(dispatchMs,.95)}));
 }finally{
  core?.scheduler.shutdown();core?.runtime.clearContinuationState();if(session){await session.abort();session.dispose();}
  server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
 }
}
if(diagnosePrefix){await run('original','custom');fs.writeFileSync(path.join(output,'prefix-analysis.json'),JSON.stringify(results,null,2)+'\n');process.exit(0);}
for(const scenario of ['reasoning','custom','idle','busy-poll'])for(const policy of ['original','current','candidate'])await run(policy,scenario);
await run('candidate','idle',{optIn:true});await run('candidate','idle',{cap:4});await run('candidate','wait');
for(const guard of ['one-additional','eight-additional'])for(const scenario of ['reasoning','idle'])await run('candidate',scenario,{guard});
const record={environment:{node:process.version,platform:process.platform,arch:process.arch,cpu:os.cpus()[0]?.model,sdk:piVersion},
 candidateSource:production?'working production extensions':'isolated opt-in prototype',
 method:'offline SDK + localhost scripted provider; byte/framing observations, not billed tokens or live cache hits; guard cases are counterfactual harness policies, not Codex or Claude runs',
 profiles,results};
if(production)for(const r of results.filter(r=>r.policy==='candidate'))assert.equal(r.prefixVariants,1,`${r.id}: execution prefix changes`);
const file=production?'production-efficiency-results.json':'efficiency-results.json';
fs.writeFileSync(path.join(output,file),JSON.stringify(record,null,2)+'\n');
const destination=process.env.PI_GOAL_EFFICIENCY_EVIDENCE??(production?path.join(evidence,'production','efficiency.json'):path.join(evidence,file));
fs.mkdirSync(path.dirname(destination),{recursive:true});fs.writeFileSync(destination,JSON.stringify(record,null,2)+'\n');
console.log(JSON.stringify({contexts:Object.keys(profiles).length*profiles.original.context.rows.length,scenarios:results.length,evidence:destination}));
