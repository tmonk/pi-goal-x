/** Real run-boundary regression extending iluluyu's replacement-goal scenario in PR #104. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {createAgentSession,DefaultResourceLoader,ModelRuntime,SessionManager,SettingsManager} from '@earendil-works/pi-coding-agent';
import goalExtension from '../../extensions/goal.ts';
import {createGoal,goalFocusDetails} from '../../extensions/goal-record.ts';
import {writeActiveGoalFile,parseGoalFile} from '../../extensions/storage/goal-files.ts';
import {newGoalScheduler} from '../../extensions/goal-scheduler-state.ts';

const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'goal-stale-sdk-'));
const handoff=process.argv.includes('--handoff');
process.env.PI_GOAL_GLOBAL_SETTINGS_FILE=path.join(cwd,'absent-global');
fs.mkdirSync(path.join(cwd,'.pi'));
fs.writeFileSync(path.join(cwd,'.pi/pi-goal-x-settings.json'),JSON.stringify({maxAutonomousRuns:handoff?3:0}));
const calls=[];
const bindings=[];
const charges=[];
let session,core,piApi,rejected=0;
const server=http.createServer(async(req,res)=>{
	let body='';for await(const chunk of req)body+=chunk;calls.push(JSON.parse(body));
	bindings.push(core.runningGoalId);
	charges.push(core.state.goal?.usage.tokensUsed);
	res.writeHead(200,{'content-type':'text/event-stream'});
	const emit=(delta,finish_reason=null)=>res.write(`data: ${JSON.stringify({id:'fixture',object:'chat.completion.chunk',created:1,model:'fixture',choices:[{index:0,delta,finish_reason}],...(finish_reason?{usage:{prompt_tokens:11,completion_tokens:5,total_tokens:16}}:{})})}\n\n`);
	const step=calls.length-(handoff?1:0);
	const tool=step===0?['create_goal',{objective:'Finish the replacement goal'}]:step===1?['write',{path:'replacement.txt',content:'verified replacement\n'}]:['update_goal',{status:'complete',completion_summary:'Verified the replacement goal after rejecting old dispatches.'}];
	emit({role:'assistant',tool_calls:[{index:0,id:`call-${calls.length}`,type:'function',function:{name:tool[0],arguments:JSON.stringify(tool[1])}}]});
	emit({},'tool_calls');res.end('data: [DONE]\n\n');
});
try{
	await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
	const manager=SessionManager.create(cwd,path.join(cwd,'sessions'));
	const old=writeActiveGoalFile({cwd},{...createGoal({objective:'Previous goal',autoContinue:handoff,sisyphus:false}),scheduler:newGoalScheduler(manager.getSessionId())});
	let goal=handoff?undefined:writeActiveGoalFile({cwd},{...createGoal({objective:'Finish the replacement goal',autoContinue:true,sisyphus:false}),scheduler:newGoalScheduler(manager.getSessionId())});
	manager.appendCustomEntry('pi-goal-focus',goalFocusDetails((goal??old).id,'created'));
	const before=goal?fs.readFileSync(path.join(cwd,goal.activePath),'utf8'):undefined;
	const oldBefore=fs.readFileSync(path.join(cwd,old.activePath),'utf8');
	const runtime=await ModelRuntime.create({authPath:path.join(cwd,'auth'),modelsPath:null,allowModelNetwork:false,refreshOnCreate:false});
	runtime.registerProvider('fixture',{baseUrl:`http://127.0.0.1:${server.address().port}/v1`,api:'openai-completions',apiKey:'fixture',models:[{id:'fixture',name:'fixture',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:200000,maxTokens:512}]});
	const loader=new DefaultResourceLoader({cwd,agentDir:cwd,noExtensions:true,noSkills:true,noThemes:true,noPromptTemplates:true,noContextFiles:true,extensionFactories:[pi=>{
		goalExtension(pi,{runCompletionAuditor:async()=>({approved:true,disapproved:false,output:'Approved fixture.'})});core=pi._goalCore;piApi=pi;
		pi.on('message_start',event=>{if(event.message.role==='custom'&&event.message.customType==='pi-goal-event'&&core.scheduler.isDenied())rejected++;});
		if(handoff)pi.on('tool_execution_end',event=>{
			if(event.toolName!=='create_goal')return;
			goal=core.state.goal;
			assert.equal(core.runningGoalId,old.id,'creation does not move the old run to the replacement');
			assert.equal(goal.scheduler.decision?.purpose,'kickoff','replacement creation saves its own kickoff');
			pi.sendMessage({customType:'pi-goal-event',content:'Old checkpoint',display:false,details:{goalId:old.id,version:3,kind:'checkpoint',generation:'old',dispatchId:'old'}},{triggerTurn:true,deliverAs:'followUp'});
		});
	}]});
	await loader.reload();
	({session}=await createAgentSession({cwd,agentDir:cwd,modelRuntime:runtime,model:runtime.getModel('fixture','fixture'),resourceLoader:loader,sessionManager:manager,settingsManager:SettingsManager.inMemory({retry:{enabled:false},compaction:{enabled:false}})}));
	await session.bindExtensions({});
	let settlements=0;
	session.subscribe(event=>{if(event.type==='agent_settled')settlements++;});
	const until=async predicate=>{const end=Date.now()+5000;while(!predicate()&&Date.now()<end)await new Promise(resolve=>setTimeout(resolve,10));assert.ok(predicate(),'SDK did not settle');};
	if(handoff){
		await session.prompt('Create the replacement goal and complete it in a fresh run.');
		await until(()=>!!goal&&session.isIdle&&!core.state.goal&&settlements>=2);
		assert.equal(calls.length,3,'creation, replacement work and completion use exactly three provider requests');
		assert.deepEqual(bindings,[old.id,goal.id,goal.id],'replacement work starts under its own run');
		assert.deepEqual(charges,[0,0,16],'creation tokens never leak into the replacement goal');
		assert.equal(rejected,1,'the queued old dispatch is rejected inside the original logical run');
		assert.equal(settlements,2,'the original run and the fresh replacement run both settle');
	}else{
	const cases=[
		{goalId:old.id,version:3,kind:'checkpoint',generation:'old',dispatchId:'old'},
		{goalId:goal.id,version:3,kind:'checkpoint',generation:'stale-same-goal',dispatchId:'old'},
		{goalId:old.id,version:2,kind:'checkpoint'},
	];
	for(const details of cases){
		const expected=settlements+1;
		piApi.sendMessage({customType:'pi-goal-event',content:'Old checkpoint',display:false,details},{triggerTurn:true,deliverAs:'followUp'});
		await until(()=>settlements>=expected&&session.isIdle);
		assert.equal(core.scheduler.isDenied(),false,'settlement clears rejection for the next run');
		assert.equal(core.runningGoalId,null);
		assert.equal(fs.readFileSync(path.join(cwd,goal.activePath),'utf8'),before,'rejected custom dispatch leaves replacement state unchanged');
	}
	await session.prompt(`<pi_goal_continuation goal_id="${old.id}" kind="checkpoint" v="2"/>`);
	assert.equal(fs.readFileSync(path.join(cwd,goal.activePath),'utf8'),before,'legacy prompt dispatch leaves replacement state unchanged');
	assert.equal(calls.length,0,'no rejected dispatch reached a provider');
	await session.prompt('Complete the current goal after verifying the result.');
	await until(()=>session.isIdle&&!core.state.goal);
	assert.equal(calls.length,2,'legitimate work and completion use two provider requests');
	assert.deepEqual(bindings,[goal.id,goal.id],'work and completion are bound to the new run');
	}
	assert.equal(fs.readFileSync(path.join(cwd,'replacement.txt'),'utf8'),'verified replacement\n');
	const oldAfter=parseGoalFile(path.join(cwd,old.activePath));
	if(!handoff)assert.equal(fs.readFileSync(path.join(cwd,old.activePath),'utf8'),oldBefore,'previous goal remains unchanged');
	else assert.equal(oldAfter.status,'active','the replacement handoff does not pause the previous goal');
	const archived=fs.readdirSync(path.join(cwd,'.pi/goals/archived')).map(name=>parseGoalFile(path.join(cwd,'.pi/goals/archived',name))).find(record=>record?.id===goal.id);
	assert.equal(archived?.status,'complete');
	assert.ok(archived?.usage.tokensUsed>=16&&archived.usage.tokensUsed<=32,'legitimate work is charged to the replacement goal');
	if(handoff)assert.equal(archived.scheduler.used,1,'replacement kickoff claims exactly one autonomous run');
	console.log(JSON.stringify({passed:true,rejected:handoff?1:4,providerRequests:calls.length,completedGoal:goal.id,handoff}));
}finally{
	core?.scheduler.shutdown();core?.runtime.clearContinuationState();
	if(session){await session.abort();session.dispose();}
	server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
	fs.rmSync(cwd,{recursive:true,force:true});
}
