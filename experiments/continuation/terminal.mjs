/** Real interactive CLI with a local provider; a human-style UI walkthrough. */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {output,roots,repository} from './prepare.mjs';
import {piCLI,piVersion} from '../../scripts/pi-host.mjs';
import {draftInProgress} from '../draft-phase.mjs';

const cwd=path.join(output,process.env.PI_GOAL_TERMINAL_NAME??'terminal');
const globalFile=process.env.PI_GOAL_TERMINAL_GLOBAL_FILE??path.join(cwd,'global.json');
const scenario=process.env.PI_GOAL_TERMINAL_SCENARIO??'normal';
const production=process.env.PI_GOAL_TERMINAL_SOURCE==='production';
const agentDir=path.join(cwd,'agent');
fs.mkdirSync(agentDir,{recursive:true});
const requests=[];
let askedQuestions=false;
const objective=`Create greeting.txt containing exactly Hello from goal followed by a newline. Verify it${production?'': ' and finish with the completion auditor'}.`;
const server=http.createServer(async(req,res)=>{
 let body='';for await(const chunk of req)body+=chunk;
 const payload=JSON.parse(body);
 const names=(payload.tools??[]).map(t=>t.function?.name);
 const auditor=/read-only completion auditor/i.test(JSON.stringify(payload.messages?.[0]));
 const draft=!auditor&&draftInProgress(payload.messages);
 let optedIn=false;
 try{optedIn=JSON.parse(fs.readFileSync(globalFile,'utf8')).idleContinuationBackoff===true;}catch{ /* Missing global layer uses the default. */ }
 try{const local=JSON.parse(fs.readFileSync(path.join(cwd,'.pi/pi-goal-x-settings.json'),'utf8'));if(local.idleContinuationBackoff!==undefined)optedIn=local.idleContinuationBackoff===true;}catch{ /* Missing project layer inherits global. */ }
 let action;
 if(auditor){const ok=fs.existsSync(path.join(cwd,'greeting.txt'))&&fs.readFileSync(path.join(cwd,'greeting.txt'),'utf8')==='Hello from goal\n';action={text:ok?'The requested file is correct.\n<approved/>':'The file is missing or incorrect.\n<disapproved/>'};}
 else if(draft&&scenario==='dialog-text'&&!askedQuestions){
  askedQuestions=true;
  action={tool:'goal_questionnaire',args:{questions:[{id:'first',question:'First answer?',options:[]},{id:'second',question:'Second answer?',options:[]}]}};
 }
 else if(draft)action=/Goal draft refinement requested|Draft cancelled/.test(JSON.stringify(payload.messages.at(-1)))
  ? {text:"Tell me what you would like to change."}
  : {tool:'propose_goal_draft',args:{objective,sisyphus:false}};
 else if(scenario==='idle-opt-out'&&optedIn)action={text:'Standing by.'};
 else if(!fs.existsSync(path.join(cwd,'greeting.txt')))action={tool:'write',args:{path:'greeting.txt',content:'Hello from goal\n'}};
 else action={tool:'update_goal',args:{status:'complete'}};
 const first=payload.messages?.[0];
 const system=['system','developer'].includes(first?.role)?JSON.stringify(first.content):'';
 requests.push({at:Date.now(),phase:auditor?'audit':draft?'draft':'execution',action:action.tool??'text',optedIn,
  systemPresent:!!system,executionPromptCorrect:system.includes('create_goal'),systemSHA256:createHash('sha256').update(system).digest('hex')});
 fs.writeFileSync(path.join(cwd,'requests.json'),JSON.stringify(requests,null,2)+'\n');
 // Give the operator time to use ordinary pause controls while work is visible.
 if(action.tool==='write')await new Promise(resolve=>setTimeout(resolve,scenario==='foreign-focus'?15000:6000));
 if(res.destroyed)return;
 res.writeHead(200,{'content-type':'text/event-stream'});
 const emit=(delta,finish_reason=null)=>res.write(`data: ${JSON.stringify({id:'terminal-fixture',object:'chat.completion.chunk',created:1,model:'fixture',choices:[{index:0,delta,finish_reason}]})}\n\n`);
 if(action.tool){emit({role:'assistant',tool_calls:[{index:0,id:`call_${requests.length}`,type:'function',function:{name:action.tool,arguments:JSON.stringify(action.args)}}]});emit({},'tool_calls');}
 else{emit({role:'assistant',content:action.text});emit({},'stop');}
 res.end('data: [DONE]\n\n');
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
fs.writeFileSync(path.join(agentDir,'settings.json'),JSON.stringify({defaultProvider:'fixture',defaultModel:'fixture',compaction:{enabled:false},retry:{enabled:false}}));
fs.writeFileSync(path.join(agentDir,'models.json'),JSON.stringify({providers:{fixture:{baseUrl:`http://127.0.0.1:${server.address().port}/v1`,api:'openai-completions',apiKey:'fixture',models:[{id:'fixture',name:'Fixture',contextWindow:200000,maxTokens:512}]}}}));
fs.writeFileSync(path.join(cwd,'actions.jsonl'),'');
const observerArgs=[];
if(scenario==='foreign-focus')observerArgs.push('-e',path.join(repository,'experiments/controls/foreign-focus.mjs'));
if(process.env.PI_GOAL_TERMINAL_READY_FILE){
 const observer=path.join(cwd,'ready-observer.mjs');
 fs.writeFileSync(observer,`import fs from 'node:fs';\nexport default function(pi){pi.on('session_start',()=>fs.writeFileSync(${JSON.stringify(process.env.PI_GOAL_TERMINAL_READY_FILE)},'ready\\n'));}\n`);
 observerArgs.push('-e',observer);
}
const config={cwd,raw:path.join(cwd,'terminal.bin'),actions:path.join(cwd,'actions.jsonl'),ack:path.join(cwd,'actions-ack'),env:{PI_CODING_AGENT_DIR:agentDir,PI_GOAL_GLOBAL_SETTINGS_FILE:globalFile,PI_OFFLINE:'1',TERM:'xterm-256color'},argv:[process.execPath,piCLI,'--offline','-ne','-ns','-np','-nc','--no-themes','--approve','-e',path.join(production?repository:roots.candidate,'extensions/goal.ts'),...observerArgs,'--session-dir',path.join(cwd,'sessions')]};
fs.writeFileSync(path.join(cwd,'host.json'),JSON.stringify({sdk:piVersion,cli:piCLI})+'\n');
fs.writeFileSync(path.join(cwd,'config.json'),JSON.stringify(config));
console.log(JSON.stringify({cwd,actions:config.actions,raw:config.raw,objective}));
const child=spawn('python3',[new URL('./terminal.py',import.meta.url).pathname,path.join(cwd,'config.json')],{stdio:'inherit'});
await new Promise(resolve=>child.on('exit',resolve));
server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
