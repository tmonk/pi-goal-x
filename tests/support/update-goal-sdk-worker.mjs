/** Exact #115 arguments through the installed Responses adapter, tools and auditor. */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtempSync,mkdirSync,writeFileSync,readdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createAgentSession,DefaultResourceLoader,ModelRuntime,SessionManager,SettingsManager} from '@earendil-works/pi-coding-agent';
import goalExtension from '../../extensions/goal.ts';
import {createGoal,goalFocusDetails} from '../../extensions/goal-record.ts';
import {writeActiveGoalFile,parseGoalFile} from '../../extensions/storage/goal-files.ts';
import {readGoalLedger} from '../../extensions/goal-ledger.ts';
const cwd=mkdtempSync(path.join(tmpdir(),'goal-filled-responses-'));
const calls=[];
let core,session;
const server=createServer(async(req,res)=>{
 let body='';for await(const chunk of req)body+=chunk;
 const payload=JSON.parse(body);calls.push(payload);
 const auditor=/read-only completion auditor/i.test(JSON.stringify(payload));
 const completion=calls.length===1;
 const text=auditor?'Workspace evidence verified.\n<approved/>':'Goal complete.';
 const args={status:'complete',continuation:{kind:'ready'},reason:'',suggested_action:'',attempted_actions:[],completion_summary:'…'};
 const item=completion?{id:'fc_fixture',type:'function_call',call_id:'call_fixture',name:'update_goal',arguments:JSON.stringify(args),status:'completed'}:{id:'msg_fixture',type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text,annotations:[]}]};
 res.writeHead(200,{'content-type':'text/event-stream'});
 const emit=event=>res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
 emit({type:'response.output_item.added',output_index:0,item:completion?{...item,arguments:''}:{...item,content:[]}});
 if(completion)emit({type:'response.function_call_arguments.delta',output_index:0,item_id:item.id,delta:item.arguments});
 else emit({type:'response.output_text.delta',output_index:0,content_index:0,delta:text});
 emit({type:'response.output_item.done',output_index:0,item});
 emit({type:'response.completed',response:{id:`resp_${calls.length}`,status:'completed',output:[item],usage:{input_tokens:10,output_tokens:3,total_tokens:13}}});
 res.end();
});
try {
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 mkdirSync(path.join(cwd,'.pi'),{recursive:true});
 writeFileSync(path.join(cwd,'.pi/pi-goal-x-settings.json'),JSON.stringify({disabled:false,maxAutonomousRuns:0}));
 process.env.PI_GOAL_GLOBAL_SETTINGS_FILE=path.join(cwd,'no-global');
 const goal=writeActiveGoalFile({cwd},{...createGoal({objective:'Verify and complete the Responses filler regression.',autoContinue:false,sisyphus:false}),taskList:{tasks:[{id:'done',title:'Verified implementation',status:'complete',evidence:'regression assertions pass'},{id:'skip',title:'Excluded feature',status:'skipped',skipReason:'user deferred features'}],blockCompletion:true,proposedAt:'2026-10-27T00:00:00Z'}});
 const manager=SessionManager.create(cwd,path.join(cwd,'sessions'));
 manager.appendCustomEntry('pi-goal-focus',goalFocusDetails(goal.id,'created'));
 const runtime=await ModelRuntime.create({authPath:path.join(cwd,'auth'),modelsPath:null,allowModelNetwork:false,refreshOnCreate:false});
 runtime.registerProvider('fixture',{baseUrl:`http://127.0.0.1:${server.address().port}/v1`,api:'openai-responses',apiKey:'fixture-only',models:[{id:'fixture',name:'fixture',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:200000,maxTokens:512}]});
 const loader=new DefaultResourceLoader({cwd,agentDir:cwd,noExtensions:true,noSkills:true,noThemes:true,noPromptTemplates:true,noContextFiles:true,extensionFactories:[pi=>{goalExtension(pi);core=pi._goalCore;}]});
 await loader.reload();
 ({session}=await createAgentSession({cwd,agentDir:cwd,modelRuntime:runtime,model:runtime.getModel('fixture','fixture'),resourceLoader:loader,sessionManager:manager,settingsManager:SettingsManager.inMemory({retry:{enabled:false},compaction:{enabled:false}})}));
 await session.bindExtensions({});
 await session.prompt('Verify the evidence, then complete this goal.');
 assert.equal(core.state.goal,null,'completion reaches deferred archival');
 const events=readGoalLedger({cwd}).events;
 assert.equal(events.filter(e=>e.type==='audit_started').length,1);
 assert.equal(events.filter(e=>e.type==='audit_result'&&e.verdict==='approved').length,1);
 assert.equal(events.filter(e=>e.type==='goal_completed').length,1);
 assert.equal(readdirSync(path.join(cwd,'.pi/goals/archived')).map(name=>parseGoalFile(path.join(cwd,'.pi/goals/archived',name))).find(g=>g?.id===goal.id)?.status,'complete');
 assert.ok(calls.some(p=>/read-only completion auditor/i.test(JSON.stringify(p))));
 console.log(JSON.stringify({passed:true,requests:calls.length,archived:true}));
} finally {
 core?.scheduler.shutdown();core?.runtime.clearContinuationState();
 if(session){await session.abort();session.dispose();}
 server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
 rmSync(cwd,{recursive:true,force:true});
}
