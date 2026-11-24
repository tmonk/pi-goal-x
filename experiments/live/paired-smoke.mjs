/** Opt-in model smoke comparison. Isolated artifacts; shared executor/child budget. */
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {pathToFileURL} from 'node:url';
import {createAgentSession,DefaultResourceLoader,ModelRuntime,SessionManager,SettingsManager} from '@earendil-works/pi-coding-agent';
import {EvaluationBudget} from './budget.mjs';
const beforeRoot=process.argv[2];const output=process.argv[3];
if(!beforeRoot||!output)throw new Error('Usage: paired-smoke.mjs <baseline checkout> <results.json>');
const runtime=await ModelRuntime.create({allowModelNetwork:false});
const provider=process.env.PI_GOAL_EVAL_PROVIDER??'opencode-go';const modelId=process.env.PI_GOAL_EVAL_MODEL??'deepseek-v4-flash';
const model=runtime.getModel(provider,modelId);
if(!model||!runtime.hasConfiguredAuth(provider))throw new Error('Configured evaluation model/auth unavailable; no request sent');
const previous=process.argv.includes('--resume')?JSON.parse(fs.readFileSync(output,'utf8')):undefined;
const budget=new EvaluationBudget({limit:5});
budget.caseLimit=Number(process.env.PI_GOAL_EVAL_CASE_REQUESTS??8);
if(!Number.isInteger(budget.caseLimit)||budget.caseLimit<1)throw new Error('Invalid per-case request ceiling');
budget.spent=previous?.chargedOrReservedUSD??0;
budget.requests=previous?.requests??[];
budget.install(runtime);
const results=(previous?.results??[]).map(r=>({provider:previous.provider,model:previous.model,...r}));const roots={before:path.resolve(beforeRoot),after:path.resolve('.')};
const work=fs.mkdtempSync(path.join(os.tmpdir(),'pi-goal-live-'));
const originalGlobal=process.env.PI_GOAL_GLOBAL_SETTINGS_FILE;
process.env.PI_GOAL_GLOBAL_SETTINGS_FILE=path.join(work,'global-settings.json');fs.writeFileSync(process.env.PI_GOAL_GLOBAL_SETTINGS_FILE,'{}');
function save(){fs.writeFileSync(output,JSON.stringify({provider,model:modelId,thinking:'high',limitUSD:budget.limit,chargedOrReservedUSD:budget.spent,outstandingReservedUSD:budget.reserved,interruptedAttempts:previous?.interruptedAttempts??[],results,requests:budget.requests},null,2)+'\n');}
budget.onChange=save;
async function run(caseId,phase) {
 const requestStart=budget.requests.length;budget.caseRequests=0;
 const cwd=path.join(work,`${caseId}-${phase}`);fs.mkdirSync(path.join(cwd,'.pi/goals'),{recursive:true});
 fs.writeFileSync(path.join(cwd,'.pi/pi-goal-x-settings.json'),JSON.stringify({provider,model:modelId,thinkingLevel:'high',disabled:false,autoSelectSingleGoal:false,oracle:{enabled:false},networkRecovery:{maxAttempts:1,maxDelayMs:1000}}));
 const root=roots[phase];
 const [{default:extension},{createGoal},{serializeGoalFile}]=await Promise.all([import(pathToFileURL(path.join(root,'extensions/goal.ts'))),import(pathToFileURL(path.join(root,'extensions/goal-record.ts'))),import(pathToFileURL(path.join(root,'extensions/storage/goal-files.ts')))]);
 const objective=caseId==='tasks' ? 'Create alpha.txt containing exactly alpha followed by a newline and beta.txt containing exactly beta followed by a newline. Verify both files, record task completion, then request independent audited goal completion.' : caseId==='sisyphus-compaction' ? 'Follow these ordered steps: 1. Create sequence.txt containing first followed by a newline (already completed). 2. Append second and a newline. 3. Append third and a newline. Verify the exact sequence, record completed tasks, and request independent audited completion. Do not repeat or reorder steps.' : 'Create final.txt containing exactly ready-for-review followed by a newline. Verify the contents and request independent audited completion. A missing file is incomplete.';
 const goal=createGoal({objective,autoContinue:false,sisyphus:caseId==='sisyphus-compaction'},Date.UTC(2026,8,7));goal.id='live-fixture';goal.activePath='.pi/goals/active_goal_live-fixture.md';
 if(caseId==='tasks')goal.taskList={tasks:[{id:'a',title:'Create and verify alpha.txt',status:'pending',verificationContract:'Exact alpha newline'},{id:'b',title:'Create and verify beta.txt',status:'pending',verificationContract:'Exact beta newline'}],blockCompletion:true,proposedAt:'2026-09-07'};
 if(caseId==='sisyphus-compaction'){fs.writeFileSync(path.join(cwd,'sequence.txt'),'first\n');goal.taskList={tasks:[{id:'one',title:'Write first',status:'complete',evidence:'first newline exists'},{id:'two',title:'Append second',status:'pending'},{id:'three',title:'Append third',status:'pending'}],blockCompletion:true,proposedAt:'2026-09-07'};}
 fs.writeFileSync(path.join(cwd,goal.activePath),serializeGoalFile(goal));
 const manager=SessionManager.inMemory(cwd);manager.appendCustomEntry('pi-goal-focus',{version:1,focusedGoalId:goal.id,reason:'created'});
 let context;let capturedCore;const tools=new Map();let payloads=0;let errors=[];
 const loader=new DefaultResourceLoader({cwd,agentDir:path.join(cwd,'agent'),noExtensions:true,noSkills:true,noThemes:true,noPromptTemplates:true,noContextFiles:true,extensionFactories:[pi=>{
  const register=pi.registerTool.bind(pi);pi.registerTool=tool=>{tools.set(tool.name,tool);register(tool);};
  extension(pi);capturedCore=pi._goalCore;
  pi.on('session_start',(_event,ctx)=>{context=ctx;});pi.on('before_provider_request',()=>{payloads++;});
 }]});await loader.reload();
 const {session}=await createAgentSession({cwd,agentDir:path.join(cwd,'agent'),modelRuntime:runtime,model,thinkingLevel:'high',resourceLoader:loader,sessionManager:manager,settingsManager:SettingsManager.inMemory({retry:{enabled:false},compaction:{enabled:false}})});
 const controller=new AbortController();let timedOut=false;
 const timer=setTimeout(()=>{timedOut=true;controller.abort();capturedCore?.auditAbortController?.abort();void session.abort();save();},180000);
 const start=Date.now();let rejectionVerified=false;
 try {
  await session.bindExtensions({onError:event=>errors.push(event.error)});
  if(caseId==='audit-rework'){
   const rejected=await tools.get('update_goal').execute('premature',{status:'complete'},controller.signal,undefined,context);
   rejectionVerified=JSON.stringify(rejected.content).includes('rejected')||JSON.stringify(rejected.content).includes('changes')||JSON.stringify(rejected.content).includes('disapproved');
   if(!rejectionVerified)errors.push('Independent auditor did not reject the missing artifact');
   // User resumes after rejection; retain audit history, disable only auto-driving for the bounded harness.
   const current=capturedCore.state.goal;
   if(current){capturedCore.focus.setGoal({...current,status:'active',autoContinue:false},context);}
  }
  if(caseId==='sisyphus-compaction'){
   const id=manager.appendMessage({role:'user',content:'Earlier work completed step 1; sequence.txt contains first newline.',timestamp:0});
   manager.appendCompaction('Step 1 completed; continue steps 2 and 3 in order.',id,10000);
   await session.extensionRunner.emit({type:'session_compact',compactionEntry:manager.getLeafEntry(),fromExtension:false});
  }
  await session.prompt('Continue the existing focused goal to independently audited completion. Use available goal task tools for verified progress. Work only inside this fixture directory; do not access the network.');
 } catch(error){errors.push(error.message);}
 finally {clearTimeout(timer);controller.abort();capturedCore?.clearContinuationState();await session.abort();session.dispose();}
 const file=(name)=>{try{return fs.readFileSync(path.join(cwd,name),'utf8');}catch{return null;}};
 const artifactPass=caseId==='tasks'?file('alpha.txt')==='alpha\n'&&file('beta.txt')==='beta\n':caseId==='sisyphus-compaction'?file('sequence.txt')==='first\nsecond\nthird\n':file('final.txt')==='ready-for-review\n';
 const ledger=(file('.pi/goals/goal_events.jsonl')??'').split('\n').filter(Boolean).map(line=>JSON.parse(line));
 const approved=ledger.some(e=>e.type==='audit_result'&&e.verdict==='approved');
 const archived=ledger.some(e=>e.type==='goal_completed');
 const requests=budget.requests.slice(requestStart);
 const result={provider,model:modelId,caseId,phase,passed:artifactPass&&approved&&archived&&(caseId!=='audit-rework'||rejectionVerified),artifactPass,approved,archived,rejectionVerified,timedOut,elapsedMs:Date.now()-start,payloads,requests:requests.length,costUSD:requests.reduce((s,r)=>s+r.cost,0),input:requests.reduce((s,r)=>s+r.input,0),output:requests.reduce((s,r)=>s+r.output,0),cacheRead:requests.reduce((s,r)=>s+r.cacheRead,0),cacheWrite:requests.reduce((s,r)=>s+r.cacheWrite,0),errors,providerErrors:requests.filter(r=>r.error).map(r=>r.error)};
 results.push(result);save();console.log(JSON.stringify(result));
}
try {
 for(const caseId of ['tasks','sisyphus-compaction','audit-rework']) {
  if(['before','after'].every(phase=>results.some(r=>r.model===modelId&&r.provider===provider&&r.caseId===caseId&&r.phase===phase&&r.passed)))continue;
  if(!budget.canRunPair(model)){results.push({caseId,skipped:'Insufficient remaining allowance for worst-case pair'});save();break;}
  await run(caseId,'before');await run(caseId,'after');
  if(results.slice(-2).every(r=>r.providerErrors?.length && !r.artifactPass)){results.push({remainingCasesSkipped:'Provider failure in both paired runs; no value in repeating identical failures'});save();break;}
 }
}finally{save();if(originalGlobal===undefined)delete process.env.PI_GOAL_GLOBAL_SETTINGS_FILE;else process.env.PI_GOAL_GLOBAL_SETTINGS_FILE=originalGlobal;fs.rmSync(work,{recursive:true,force:true});}
