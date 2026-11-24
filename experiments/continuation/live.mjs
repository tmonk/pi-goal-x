/** Bounded real-model walkthrough; normal user commands, spontaneous tool choices. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {createAgentSession,DefaultResourceLoader,ModelRuntime,SessionManager,SettingsManager} from '@earendil-works/pi-coding-agent';
import {EvaluationBudget} from '../live/budget.mjs';
import {output,roots,repository} from './prepare.mjs';
import {piVersion} from '../../scripts/pi-host.mjs';

const policy=process.argv[2]??'candidate';
const production=process.env.PI_GOAL_EVAL_PRODUCTION==='1';
const provider=process.env.PI_GOAL_EVAL_PROVIDER??'opencode-go';
const modelId=process.env.PI_GOAL_EVAL_MODEL??'deepseek-v4-flash';
const caseId=`${production?'production-':''}${policy}-${provider}${process.env.PI_GOAL_EVAL_ATTEMPT?`-${process.env.PI_GOAL_EVAL_ATTEMPT}`:''}`;
const ordinaryWording=process.env.PI_GOAL_EVAL_ORDINARY_WORDING==='1';
const cwd=ordinaryWording?fs.mkdtempSync(path.join(os.tmpdir(),'goal-user-project-')):path.join(output,'live',caseId);
fs.mkdirSync(cwd,{recursive:true});
process.env.PI_GOAL_GLOBAL_SETTINGS_FILE=path.join(cwd,'absent-global.json');
const runtime=await ModelRuntime.create({allowModelNetwork:false});
const model=runtime.getModel(provider,modelId);
if(!model||!runtime.hasConfiguredAuth(provider))throw new Error('Configured evaluation model unavailable; no model request sent');
const budget=new EvaluationBudget({limit:2,maxTokens:4096});
budget.caseLimit=40;budget.install(runtime);
const result={evidence:'real model, actual SDK, ordinary /goal confirmation choices; agent-operated RPC walkthrough',sdk:piVersion,production,policy,provider,model:modelId,fixtureCwd:cwd,ordinaryWording,thinking:'medium',dialogs:[],commands:[],tools:[],executions:[],errors:[],requests:budget.requests};
const started=Date.now();
let core,session;
const save=()=>fs.writeFileSync(path.join(output,`live-${caseId}.json`),JSON.stringify({...result,elapsedMs:Date.now()-started,chargedOrReservedUSD:budget.spent,reservedUSD:budget.reserved},null,2)+'\n');
budget.onChange=save;
fs.writeFileSync(path.join(cwd,'normalize-name.js'), 'export function normalizeName(input) { return input; }\n');
fs.writeFileSync(path.join(cwd,'package.json'),'{"type":"module","scripts":{"test":"node --test"}}\n');
fs.writeFileSync(path.join(cwd,'normalize-name.test.js'),"import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport {normalizeName} from './normalize-name.js';\ntest('trims and collapses name whitespace',()=>assert.equal(normalizeName('  Ada   Lovelace  '),'Ada Lovelace'));\ntest('empty or whitespace input is empty',()=>assert.equal(normalizeName('   '),''));\n");
const {default:extension}=await import(pathToFileURL(path.join(production?repository:roots[policy],'extensions/goal.ts')));
const loader=new DefaultResourceLoader({cwd,agentDir:path.join(cwd,'agent'),noExtensions:true,noSkills:true,noThemes:true,noPromptTemplates:true,noContextFiles:true,extensionFactories:[pi=>{
 extension(pi);core=pi._goalCore;
 pi.on('tool_call',event=>{result.tools.push({at:Date.now()-started,name:event.toolName,input:event.input});save();});
 pi.on('agent_settled',()=>{const g=core.state.goal;result.executions.push({at:Date.now()-started,status:g?.status??'archived',scheduler:g?.scheduler});save();});
}]});
await loader.reload();
({session}=await createAgentSession({cwd,agentDir:path.join(cwd,'agent'),modelRuntime:runtime,model,thinkingLevel:'medium',resourceLoader:loader,sessionManager:SessionManager.create(cwd,path.join(cwd,'sessions')),settingsManager:SettingsManager.inMemory({retry:{enabled:false},compaction:{enabled:false}})}));
const ui={...session.extensionRunner.createContext().ui,
 custom:undefined,
 async select(title,options){
  const answer=options.find(option=>/^Confirm\b/i.test(option))??options.find(option=>/^Enabled\b/i.test(option))??options.find(option=>/existing|small|focused/i.test(option))??options[0];
  result.dialogs.push({kind:'select',title,options,answer});save();return answer;
 },
 async confirm(title,message){result.dialogs.push({kind:'confirm',title,message,answer:true});save();return true;},
 async input(title){const answer='Use the existing project conventions, make a focused fix, and add tests without dependencies.';result.dialogs.push({kind:'input',title,answer});save();return answer;},
 notify(message,type){result.dialogs.push({kind:'notice',message,type});save();},
};
const timeout=setTimeout(()=>{result.errors.push('Walkthrough reached the 150-second harness ceiling');core?.auditAbortController?.abort();core?.clearContinuationState();void session.abort();save();},150_000);
try {
 await session.bindExtensions({mode:'rpc',uiContext:ui,onError:event=>result.errors.push(event.error)});
 const command=ordinaryWording?'/goal Fix normalizeName so it trims outer whitespace and collapses internal whitespace to one space. Add tests for tabs/newlines and unchanged ordinary names, and run all tests. Keep the change focused and add no dependencies.':'/goal Fix normalizeName so it trims outer whitespace and collapses internal whitespace to one space. Add tests for tabs/newlines and unchanged ordinary names, run all tests, and finish with the completion auditor. Keep the change focused and add no dependencies.';
 result.commands.push(command);save();
 await session.prompt(command);
 const deadline=Date.now()+140_000;
 while(Date.now()<deadline){
  if(!core.state.goal&&result.tools.some(t=>t.name==='update_goal'&&t.input.status==='complete')&&session.isIdle)break;
  if(result.requests.at(-1)?.error&&session.isIdle){result.errors.push(result.requests.at(-1).error);break;}
  if(session.messages.at(-1)?.stopReason==='error'&&session.isIdle){result.errors.push(session.messages.at(-1).errorMessage??'Provider execution failed');break;}
  if(result.errors.length)break;
  await delay(50);
 }
 const {execFileSync}=await import('node:child_process');
 try{result.testOutput=execFileSync(process.execPath,['--test'],{cwd,encoding:'utf8',timeout:10000});result.artifactTestsPass=true;}catch(error){result.testOutput=String(error.stdout??error.message);result.artifactTestsPass=false;}
 const content=fs.readFileSync(path.join(cwd,'normalize-name.js'),'utf8');
 const {normalizeName}=await import(pathToFileURL(path.join(cwd,'normalize-name.js')));
 result.independentAssertions=normalizeName('  Ada\t\n Lovelace  ')==='Ada Lovelace'&&normalizeName('Grace Hopper')==='Grace Hopper'&&normalizeName('   ')==='';
 result.finalSource=content;
 result.completed=!core.state.goal&&result.executions.some(e=>e.status==='archived');
 result.extraSchedulingDeclarations=result.tools.filter(t=>t.name==='update_goal'&&t.input.continuation).length;
 result.passed=result.artifactTestsPass&&result.independentAssertions&&result.completed&&result.errors.length===0;
 assert.equal(result.passed,true,'Real-model walkthrough did not satisfy all observable criteria');
} catch(error){result.errors.push(error.message);result.passed=false;process.exitCode=1;}
finally{clearTimeout(timeout);core?.scheduler.shutdown();core?.clearContinuationState();core?.view.stopAuditAnimation();core?.view.clearAuditResult();await session.abort();session.dispose();save();console.log(JSON.stringify({policy,passed:result.passed,requests:budget.requests.length,costUSD:budget.spent,dialogs:result.dialogs.filter(d=>d.kind!=='notice').length,tools:result.tools.map(t=>t.name),errors:result.errors,elapsedMs:Date.now()-started}));}
