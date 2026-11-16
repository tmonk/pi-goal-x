/** Actual user commands, provider payloads and independently verified artifacts. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {createAgentSession,DefaultResourceLoader,ModelRuntime,SessionManager,SettingsManager,defineTool} from '@earendil-works/pi-coding-agent';
import {Type} from '@earendil-works/pi-ai';
import goalExtension from '../extensions/goal.ts';
import {hasActiveDraft} from '../extensions/goal-drafting.ts';

const mode=process.argv[2]??'draft';
const startupAbort=mode==='abort';
const turnFirst=mode==='turn-first';
const lifecycle=mode==='pause'||mode==='reload'||startupAbort||turnFirst;
const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'goal-user-sdk-'));
const originalGlobal=process.env.PI_GOAL_GLOBAL_SETTINGS_FILE;
process.env.PI_GOAL_GLOBAL_SETTINGS_FILE=path.join(cwd,'global.json');
const requests=[],choices=[],errors=[];
let session,core,piApi,step=0,auditStep=0,held=false,releaseHold,paused=false,nativePromptPreparation=false,pausedBeforeAnyRequest,settlementHeld=false,releaseSettlement,resumed=false,heldBeforeResume=false;
if(turnFirst){fs.mkdirSync(path.join(cwd,'.pi'));fs.writeFileSync(path.join(cwd,'.pi/pi-goal-x-settings.json'),JSON.stringify({pauseOrder:'turn-first'}));}
const externalGuard='EXTERNAL_GOAL_GUARD: preserve this instruction across custom tool turns.';
const tool=(name,args)=>({tool:name,args});
const plan=[{text:'Compare the two assumptions before selecting an approach.'},{text:'The second approach satisfies both constraints; record and check it next.'},tool('publish_report',{stage:1}),{text:'The report section is saved.'},tool('write',{path:'result.txt',content:'verified result\n'}),tool('read',{path:'result.txt'}),tool('update_goal',{status:'complete'})];
const server=http.createServer(async(req,res)=>{
 let body='';for await(const chunk of req)body+=chunk;const payload=JSON.parse(body);
 const names=(payload.tools??[]).map(t=>t.function?.name);
 const audit=/read-only completion auditor/i.test(JSON.stringify(payload.messages?.[0]));
 const draft=!audit&&hasActiveDraft(core);
 let action;
 if(audit)action=auditStep++===0?tool('read',{path:'result.txt'}):{text:'The requested artifact contains the exact result and was independently read.\n<approved/>'};
 else if(draft)action=tool('propose_goal_draft',{objective:'Create result.txt containing exactly verified result followed by a newline, verify it and finish.',sisyphus:false});
 else if(lifecycle)action=!fs.existsSync(path.join(cwd,'result.txt'))?tool('write',{path:'result.txt',content:'verified result\n'}):tool('update_goal',{status:'complete'});
 else action=plan[step++]??{text:'Done.'};
 const leading=payload.messages[0];
 const prompt=['system','developer'].includes(leading?.role)?JSON.stringify(leading.content):'';
 requests.push({phase:audit?'audit':draft?'draft':'execution',action:action.tool??'text',system:prompt,
  hash:createHash('sha256').update(prompt).digest('hex'),tools:names});
 if(lifecycle&&!audit&&!draft&&!held){held=true;await new Promise(resolve=>{releaseHold=resolve;});}
 if(res.destroyed)return;
 res.writeHead(200,{'content-type':'text/event-stream'});
 const emit=(delta,finish_reason=null)=>res.write(`data: ${JSON.stringify({id:'user-fixture',object:'chat.completion.chunk',created:1,model:'fixture',choices:[{index:0,delta,finish_reason}]})}\n\n`);
 if(action.tool){emit({role:'assistant',tool_calls:[{index:0,id:`c_${requests.length}`,type:'function',function:{name:action.tool,arguments:JSON.stringify(action.args)}}]});emit({},'tool_calls');}
 else{emit({role:'assistant',content:action.text});emit({},'stop');}res.end('data: [DONE]\n\n');
});
async function until(predicate){const deadline=Date.now()+10000;while(!predicate()&&Date.now()<deadline)await delay(10);assert.ok(predicate(),`Timeout (${mode}), ${requests.length} requests, ${JSON.stringify(core?.state.goal?.scheduler)}, ${errors.join(', ')}`);}
try{
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const runtime=await ModelRuntime.create({authPath:path.join(cwd,'auth.json'),modelsPath:null,allowModelNetwork:false,refreshOnCreate:false});
 runtime.registerProvider('fixture',{baseUrl:`http://127.0.0.1:${server.address().port}/v1`,api:'openai-completions',apiKey:'fixture',models:[{id:'fixture',name:'Fixture',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:200000,maxTokens:512}]});
 const loader=new DefaultResourceLoader({cwd,agentDir:path.join(cwd,'agent'),noExtensions:true,noSkills:true,noThemes:true,noPromptTemplates:true,noContextFiles:true,extensionFactories:[pi=>{
  piApi=pi;goalExtension(pi);core=pi._goalCore;
  pi.on('before_agent_start',async event=>{
   assert.ok(['user','custom'].includes(event.messageType),'Pi 1.4 prepares every trigger');
   nativePromptPreparation=true;
   event.systemPromptOptions.sections.external_goal_guard=externalGuard;
   if(startupAbort&&event.messageType==='custom'&&!held){held=true;await new Promise(resolve=>{releaseHold=resolve;});}
  });
  pi.on('agent_before_settle',async()=>{
   if(turnFirst&&held&&!resumed&&!settlementHeld){settlementHeld=true;await new Promise(resolve=>{releaseSettlement=resolve;});}
  });
  pi.registerTool(defineTool({name:'publish_report',label:'Publish',description:'Save a completed report section.',parameters:Type.Object({stage:Type.Number()}),async execute(_id,args){fs.writeFileSync(path.join(cwd,'report.txt'),`section ${args.stage}\n`);return{content:[{type:'text',text:'Saved; invoice status pending is unrelated.'}],details:{id:'invoice',status:'pending'}};}}));
 }]});
 await loader.reload();
 ({session}=await createAgentSession({cwd,agentDir:path.join(cwd,'agent'),modelRuntime:runtime,model:runtime.getModel('fixture','fixture'),resourceLoader:loader,sessionManager:SessionManager.create(cwd,path.join(cwd,'sessions')),settingsManager:SettingsManager.inMemory({retry:{enabled:false},compaction:{enabled:false}})}));
 const bind=()=>session.bindExtensions({mode:'rpc',uiContext:{...session.extensionRunner.createContext().ui,custom:undefined,
  async select(title,options){const answer=options.find(o=>/confirm.*create/i.test(o))??options.find(o=>/^Enabled\b/.test(o))??options[0];choices.push({title:title.split('\n')[0],answer});return answer;},
  async confirm(){return true;},async input(){return 'Use the stated objective.';}},onError:event=>errors.push(event.error)});
 await bind();
 const command=`/${mode==='direct'||mode==='reload'||startupAbort||turnFirst?'goal-direct':'goal'} Create result.txt containing exactly verified result followed by a newline, verify it and finish.`;
 const start=session.prompt(command);
 if(lifecycle){
  await until(()=>held);
  if(turnFirst){
   core.interruption.pause(session.extensionRunner.createContext());
   await until(()=>settlementHeld||session.isIdle);
   heldBeforeResume=core.interruption.isHeld();assert.equal(heldBeforeResume,true);
   assert.equal(core.state.goal.status,'active');
   await session.prompt('/goal-resume');resumed=true;
   releaseSettlement?.();releaseHold();await start;
  }else{
  if(!startupAbort)await session.prompt('/goal-pause');
  const aborting=session.abort();if(startupAbort)releaseHold();await aborting;
  paused=core.state.goal?.status==='paused';assert.equal(paused,true);
  if(startupAbort){pausedBeforeAnyRequest=requests.length===0;assert.equal(pausedBeforeAnyRequest,true);}
  const count=requests.length;await delay(150);assert.equal(requests.length,count);assert.equal(fs.existsSync(path.join(cwd,'result.txt')),false);
  releaseHold();await start;
  if(mode==='reload'){await session.reload();await bind();core=piApi._goalCore;assert.equal(core.state.goal?.status,'paused');}
  await session.prompt('/goal-resume');
  }
 }else await start;
 await until(()=>fs.existsSync(path.join(cwd,'result.txt'))&&!core.state.goal&&session.isIdle);
 assert.equal(fs.readFileSync(path.join(cwd,'result.txt'),'utf8'),'verified result\n');
 if(!lifecycle)assert.equal(fs.readFileSync(path.join(cwd,'report.txt'),'utf8'),'section 1\n');
 assert.deepEqual(errors,[]);
 const execution=requests.filter(r=>r.phase==='execution');
 for(const request of execution){assert.ok(request.system.includes('expert coding assistant'));assert.ok(request.system.includes('create_goal'));assert.ok(request.system.includes('propose_goal_draft'));assert.ok(request.tools.includes('update_goal'));}
 assert.equal(nativePromptPreparation,true);
 for(const request of execution)assert.ok(request.system.includes(externalGuard),'native prompt preparation preserves another extension instruction');
 assert.equal(new Set(execution.map(r=>r.hash)).size,1,'initial and subsequent executor system prefixes match');
 const foreground=requests.filter(r=>r.phase!=='audit');
 assert.equal(new Set(foreground.map(r=>r.hash)).size,1,'drafting and execution system prefixes match');
 for(const request of foreground)assert.deepEqual(request.tools,foreground[0].tools,'ordered tool declarations stay fixed across drafting and lifecycle changes');
 assert.equal(requests.filter(r=>r.phase==='audit'&&r.action==='read').length,1,'actual auditor reads the artifact');
 const result={passed:true,mode,command,choices,requests:requests.map(({system:_system,...r})=>r),initialExecutionPromptCorrect:true,executorPrefixStable:true,nativePromptPreparation,externalPromptInstructionPreserved:nativePromptPreparation?true:undefined,artifact:'verified result\n',report:!lifecycle?'section 1\n':undefined,paused,pausedBeforeAnyRequest,heldBeforeResume:turnFirst?heldBeforeResume:undefined,reloadedWhilePaused:mode==='reload',errors};
 if(process.env.PI_GOAL_USER_EVIDENCE)fs.writeFileSync(process.env.PI_GOAL_USER_EVIDENCE,JSON.stringify(result,null,2)+'\n');
 console.log(JSON.stringify(result));
}finally{
 releaseSettlement?.();releaseHold?.();core?.scheduler.shutdown();core?.runtime.clearContinuationState();core?.stopAuditAnimation();
 if(session){await session.abort();session.dispose();}server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
 fs.rmSync(cwd,{recursive:true,force:true});if(originalGlobal===undefined)delete process.env.PI_GOAL_GLOBAL_SETTINGS_FILE;else process.env.PI_GOAL_GLOBAL_SETTINGS_FILE=originalGlobal;
}
