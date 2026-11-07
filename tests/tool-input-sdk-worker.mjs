/** Adapt the #91/#92 regression cases to Pi's real tool-argument validator. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {validateToolArguments} from '@earendil-works/pi-ai';
import goalExtension from '../extensions/goal.ts';
import {createGoal,goalFocusDetails} from '../extensions/goal-record.ts';
import {writeActiveGoalFile,parseGoalFile} from '../extensions/storage/goal-files.ts';

let cases=0;
async function fixture(run){
	const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'goal-input-sdk-'));
	process.env.PI_GOAL_GLOBAL_SETTINGS_FILE=path.join(cwd,'absent-global');
	const goal=writeActiveGoalFile({cwd},{...createGoal({objective:'Validate goal tool inputs',autoContinue:false,sisyphus:false}),taskList:{tasks:[{id:'a',title:'Task A',status:'pending',verificationContract:'Verify A'},{id:'-',title:'Dash task',status:'pending'},{id:'other',title:'Other task',status:'pending'}],blockCompletion:true,proposedAt:new Date().toISOString()}});
	const tools=new Map(),handlers=new Map();
	const pi={registerTool:tool=>tools.set(tool.name,tool),registerCommand:()=>{},registerMessageRenderer:()=>{},on:(name,fn)=>handlers.set(name,fn),appendEntry:()=>{},sendMessage:()=>{},getActiveTools:()=>['read','bash','write','edit'],setActiveTools:()=>{}};
	const ctx={cwd,hasUI:false,isIdle:()=>true,hasPendingMessages:()=>false,abort:()=>{},getSystemPrompt:()=>'',sessionManager:{getSessionId:()=>'tool-input-sdk',getCwd:()=>cwd,getBranch:()=>[{type:'custom',customType:'pi-goal-focus',data:goalFocusDetails(goal.id,'created')}]},ui:{notify:()=>{},setStatus:()=>{},setWidget:()=>{},onTerminalInput:()=>()=>{}}};
	goalExtension(pi);
	await handlers.get('session_start')({reason:'start'},ctx);
	await handlers.get('before_agent_start')({prompt:'Inspect the goal',systemPrompt:'base',systemPromptOptions:{}},ctx);
	const invoke=async(name,input)=>{
		const tool=tools.get(name);
		const call={type:'toolCall',id:'input-check',name,arguments:structuredClone(input)};
		const params=validateToolArguments(tool,call);
		return tool.execute(call.id,params,new AbortController().signal,undefined,ctx);
	};
	const text=result=>result.content.filter(part=>part.type==='text').map(part=>part.text).join('\n');
	try{await run({invoke,text,disk:()=>parseGoalFile(path.join(cwd,goal.activePath)),bytes:()=>fs.readFileSync(path.join(cwd,goal.activePath),'utf8')});cases++;}
	finally{pi._goalCore.scheduler.shutdown();pi._goalCore.runtime.clearContinuationState();fs.rmSync(cwd,{recursive:true,force:true});}
}

await fixture(async({invoke,text})=>{
	assert.match(text(await invoke('get_goal',{section:'objective',task_id:'  '})),/objective for/);
	assert.match(text(await invoke('get_goal',{section:'tasks',task_id:'-'})),/Dash task/);
	assert.match(text(await invoke('get_goal',{section:'objective',task_id:'-'})),/task_id requires/);
});
const update={task_id:'a',status:'complete',evidence:'verified'};
await fixture(async({invoke,disk,text})=>{
	assert.match(text(await invoke('update_goal_task',{...update,reason:'',updates:[update]})),/a complete/);
	assert.equal(disk().taskList.tasks[0].status,'complete');
});
await fixture(async({invoke,disk,text})=>{
	assert.match(text(await invoke('update_goal_task',{updates:[update]})),/a complete/);
	assert.equal(disk().taskList.tasks[0].status,'complete');
});
await fixture(async({invoke,disk})=>{
	await invoke('update_goal_task',{task_id:'-',status:'start',updates:[]});
	assert.equal(disk().currentTaskId,'-');
});
await fixture(async({invoke})=>{
	await assert.rejects(()=>invoke('update_goal_task',{task_id:'',status:'',reason:'',updates:[update]}),/status: must be equal to one of the allowed values/);
});
for(const input of [
	{task_id:'other',status:'start',updates:[update]},
	{...update,evidence:'contradictory evidence',updates:[update]},
	{task_id:'other',status:'start',updates:{}},
	{task_id:'other',status:'start',updates:[update,{task_id:'missing',status:'start'}]},
	{task_id:'other',status:'start',updates:[{task_id:'a',status:'complete'}]},
	{updates:[update,{task_id:'missing',status:'start'}]},
	{updates:[{task_id:'other',status:'start'},{task_id:'a',status:'complete'}]},
	{updates:[]},
])await fixture(async({invoke,bytes})=>{
	const before=bytes();
	try{await invoke('update_goal_task',input);}catch(error){assert.ok(error instanceof Error);}
	assert.equal(bytes(),before,'invalid or contradictory input cannot change any task');
});
console.log(JSON.stringify({passed:true,cases}));
