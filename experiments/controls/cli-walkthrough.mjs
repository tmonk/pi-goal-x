/** Human-style controls walkthrough in the installed Pi CLI, using an isolated local provider. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import xterm from '@xterm/headless';
import {piVersion} from '../../scripts/pi-host.mjs';

const repository=fileURLToPath(new URL('../../',import.meta.url));
const output=path.resolve(repository,process.env.PI_GOAL_CONTROLS_OUTPUT??'experiments/runs/goal-controls');
fs.mkdirSync(output,{recursive:true});
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const until=async(check,label,timeout=15000)=>{
 const deadline=Date.now()+timeout;
 while(Date.now()<deadline){if(await check())return;await delay(70);}
 throw new Error(`Timed out: ${label}`);
};
const ESC='\x1b',ENTER='\r',DOWN='\x1b[B',TAB='\t',F6='\x1b[17~';
async function boot(label,settings={},scenario='normal'){
 const name=`${label}-${process.pid}-${Date.now()}`;
 const cwd=path.join(output,name);
 fs.mkdirSync(path.join(cwd,'.pi'),{recursive:true});
 fs.writeFileSync(path.join(cwd,'.pi/pi-goal-x-settings.json'),JSON.stringify(settings));
 const child=spawn(process.execPath,[path.join(repository,'experiments/continuation/terminal.mjs')],{
  cwd:repository,env:{...process.env,PI_GOAL_COMPARISON_OUTPUT:output,PI_GOAL_TERMINAL_NAME:name,PI_GOAL_TERMINAL_SOURCE:'production',PI_GOAL_TERMINAL_SCENARIO:scenario,PI_GOAL_TERMINAL_READY_FILE:path.join(cwd,'ready')},stdio:['ignore','pipe','pipe'],
 });
 let log='';child.stdout.on('data',data=>{log+=data;});child.stderr.on('data',data=>{log+=data;});
 let rows=32,cols=110;
 const raw=path.join(cwd,'terminal.bin'),actions=path.join(cwd,'actions.jsonl');
 const screen=async()=>{
  if(!fs.existsSync(raw))return '';
  const terminal=new xterm.Terminal({rows,cols,scrollback:5000,allowProposedApi:true});
  await new Promise(resolve=>terminal.write(fs.readFileSync(raw),resolve));
  const b=terminal.buffer.active;const lines=[];
  for(let i=b.viewportY;i<b.viewportY+rows;i++)lines.push((b.getLine(i)?.translateToString(true)??'').trimEnd());
  terminal.dispose();return lines.join('\n').trimEnd()+'\n';
 };
 let sequence=0;
 const action=async value=>{
  const id=++sequence;
  fs.appendFileSync(actions,JSON.stringify({...value,id})+'\n');
  await until(()=>fs.existsSync(path.join(cwd,'actions-ack'))&&Number(fs.readFileSync(path.join(cwd,'actions-ack'),'utf8'))>=id,`PTY delivered action ${id}`);
 };
 // After a key, wait for the screen to react and go quiet instead of sleeping a fixed time.
 // Keys that draw nothing fall back to the old 160ms pause.
 const size=()=>fs.existsSync(raw)?fs.statSync(raw).size:0;
 const settle=async before=>{
  const deadline=Date.now()+160;
  while(size()===before&&Date.now()<deadline)await delay(10);
  let last=size(),quietSince=Date.now();
  while(Date.now()-quietSince<40){await delay(10);const now=size();if(now!==last){last=now;quietSince=Date.now();}}
 };
 const send=async text=>{const before=size();await action({text});await settle(before);};
 const keys=async(...list)=>{for(const text of list)await send(text);};
 const resize=async(r,c)=>{rows=r;cols=c;await action({resize:[r,c]});await delay(200);};
 const settingsFile=path.join(cwd,'.pi/pi-goal-x-settings.json');
 const config=()=>JSON.parse(fs.readFileSync(settingsFile,'utf8'));
 const saved=async(select,expected)=>{
  await until(()=>isDeepStrictEqual(select(config()),expected),`persisted settings equal ${JSON.stringify(expected)}`);
  assert.deepEqual(select(config()),expected);
 };
 const requests=()=>fs.existsSync(path.join(cwd,'requests.json'))?JSON.parse(fs.readFileSync(path.join(cwd,'requests.json'),'utf8')):[];
 const goals=()=>{
  const dir=path.join(cwd,'.pi/goals');if(!fs.existsSync(dir))return [];
  return fs.readdirSync(dir).filter(file=>file.startsWith('active_goal_')).map(file=>{
   const text=fs.readFileSync(path.join(dir,file),'utf8');return JSON.parse(text.slice(0,text.indexOf('\n\n# Goal Prompt')));
  });
 };
 const expect=async text=>until(async()=> (await screen()).includes(text),`screen contains ${text}`);
 const capture=async name=>{const text=await screen();fs.writeFileSync(path.join(cwd,`${name}.txt`),text);return text;};
 const stop=async()=>{
  fs.writeFileSync(path.join(cwd,'last-screen.txt'),await screen());
  fs.writeFileSync(path.join(cwd,'last-settings.json'),JSON.stringify(config(),null,2)+'\n');
  if(child.exitCode===null){fs.appendFileSync(actions,JSON.stringify({stop:true})+'\n');await Promise.race([new Promise(resolve=>child.once('exit',resolve)),delay(2500)]);}
  if(child.exitCode===null)child.kill('SIGTERM');
  fs.writeFileSync(path.join(cwd,'walkthrough.log'),log);
 };
 await until(()=>fs.existsSync(actions)&&fs.existsSync(raw),'PTY ready');
 await until(()=>fs.existsSync(path.join(cwd,'ready')),'Pi session_start');
 await delay(500);
 return {cwd,keys,send,resize,screen,expect,capture,config,saved,requests,goals,stop};
}

async function controlsWalkthrough(){
 const h=await boot('controls-ui');
 try{
  await h.send('/goal-settings\r');await h.keys(DOWN,DOWN,ENTER);await h.expect('Goal controls');
  await h.capture('01-controls-wide');
  await h.keys('Revise',ENTER,DOWN,ENTER,'/goal edit',ENTER);
  await h.saved(c=>c.commands?.['goal-tweak'],['goal-tweak','goal edit']);
  await h.capture('02-alias-saved');
  await h.send('\x12');await h.expect('Reloaded keybindings');
  await h.send('/goal edit Change the greeting\r');await h.expect('No goal is set');
  assert.equal(h.requests().length,0,'the alias reached the command handler without a model request');
  await h.send('/goal-settings controls\r');await h.keys(TAB,'Pause /',ENTER,ENTER,F6,ENTER);
  await h.saved(c=>c.keybindings?.pause,['f6']);
  await h.keys(ENTER,ENTER,'\x1b[65;6u',ENTER);await h.expect('also assigned');
  await h.capture('03-conflict');await h.saved(c=>c.keybindings?.pause,['f6']);
  await h.keys(ESC,ESC,'\x13');await h.expect('All projects');
  await h.keys(ENTER,ENTER,'\x1b[18~',ENTER);
  await h.saved(c=>c.keybindings?.pause,['f6']);
  await h.keys('\x13',ENTER,DOWN,DOWN,DOWN,DOWN,DOWN,ENTER);
  await h.saved(c=>c.keybindings,undefined);
  await h.capture('04-inherited-key');
  await h.keys(ENTER,ENTER,F6,ENTER);
  await h.keys(TAB,ENTER,DOWN,DOWN,ENTER);await h.saved(c=>c.pauseOrder,'turn-first');
  await h.resize(20,72);await h.capture('05-pausing-narrow');
  await h.keys(TAB,'Resume',ENTER,ENTER,'\x15','work continue',ENTER);
  await h.saved(c=>c.commands?.['goal-resume'],['work continue']);
  await h.send('\x12');await h.expect('Reloaded keybindings');
 return {case:'controls-ui',passed:true,sdk:piVersion,directory:path.relative(repository,h.cwd),requests:h.requests().length,checks:['settings-entry','alias','reload','record-key','conflict','scope','inherit','narrow-preview','turn-first','custom-resume-saved']};
 }finally{await h.stop();}
}

// The second half starts from the settings the first half ends with (turn-first pausing, F6 to pause
// and a custom resume command) in the same narrow terminal, so it can run in its own job.
async function controlsRunWalkthrough(){
 const h=await boot('controls-run',{pauseOrder:'turn-first',keybindings:{pause:['f6']},commands:{'goal-tweak':['goal-tweak','goal edit'],'goal-resume':['work continue']}});
 try{
  await h.resize(20,72);
  await h.send('/goal-direct Create greeting.txt containing exactly Hello from goal followed by a newline. Verify it.\r');
  await until(()=>h.requests().length===1,'first running request');await h.send(F6);
  await until(()=>h.goals()[0]?.scheduler?.phase==='interrupted','turn-only hold persisted');
  await h.expect('waiting for you');await h.capture('06-turn-stopped');
  const count=h.requests().length;await delay(6500);
  assert.equal(h.requests().length,count,'stopped turn cannot automatically restart');
  assert.equal(fs.existsSync(path.join(h.cwd,'greeting.txt')),false,'cancelled request cannot execute the write');
  assert.equal(h.goals()[0].status,'active');assert.ok(h.goals()[0].usage.activeSeconds<4,'held time is not charged');
  await h.send(F6);await until(()=>h.goals()[0]?.status==='paused','second press pauses goal');
  await h.capture('07-goal-paused');
  // Escape leaves settings without pausing/resuming the goal or writing cancelled text.
  await h.send('/goal-settings controls\r');await h.keys('Revise',ENTER,ENTER,'\x15','/discard-me');
  const before=JSON.stringify(h.config());await h.keys(ESC,ESC,ESC,ESC);
  assert.equal(JSON.stringify(h.config()),before);assert.equal(h.goals()[0].status,'paused');
  await h.send('/work continue\r');
  await until(()=>fs.existsSync(path.join(h.cwd,'greeting.txt'))&&h.goals().length===0,'custom resume reaches audited completion',20000);
  await h.capture('08-complete');
  assert.equal(fs.readFileSync(path.join(h.cwd,'greeting.txt'),'utf8'),'Hello from goal\n');
  return {case:'controls-run',passed:true,sdk:piVersion,directory:path.relative(repository,h.cwd),requests:h.requests().length,checks:['held-time','cancel-edit','custom-resume','audited-completion']};
 }finally{await h.stop();}
}

async function pauseWalkthrough(order,finish=false){
 const h=await boot(finish?'goal-first-finish':order,{pauseOrder:order});
 try{
  await h.send('/goal-direct Create greeting.txt containing exactly Hello from goal followed by a newline. Verify it.\r');
  await until(()=>h.requests().length===1,'visible work');await h.send(ESC);
  await until(()=>h.goals()[0]?.status==='paused',`${order} first press pauses goal`);
  await h.capture('first-press');
  if(order==='goal-first'){
   assert.ok(!(await h.screen()).includes('Operation aborted'),'first press leaves the current turn running');
   if(finish){await delay(6500);assert.equal(h.requests().length,1,'goal-first finishes one turn without another provider request');await h.capture('turn-finished');}
   else{await h.send(ESC);await h.expect('Operation aborted');await h.capture('second-press');}
  }else await h.expect('Operation aborted');
  if(!finish){await delay(6500);assert.equal(h.requests().length,1);assert.equal(fs.existsSync(path.join(h.cwd,'greeting.txt')),false);}
  assert.equal(h.goals()[0].status,'paused');
  await h.send('/goal-resume\r');await until(()=>fs.existsSync(path.join(h.cwd,'greeting.txt'))&&h.goals().length===0,'resume completes',20000);
  return {case:finish?'goal-first-finish':order,passed:true,sdk:piVersion,directory:path.relative(repository,h.cwd),requests:h.requests().length};
 }finally{await h.stop();}
}

async function editorWalkthrough(){
 const h=await boot('editor-controls',{keybindings:{commands:{'goal-settings':'f10'}}});
 try{
  const draft='Keep this unsent draft while changing goal controls.';
  await h.send(draft);await h.send('\x1b[21~');await h.expect('Goal settings');
  await h.keys(DOWN,DOWN,ENTER);await h.expect('Goal controls');
  await h.keys('Resume',ENTER,ENTER,'\x15','work continue',ENTER);
  await h.expect('/reload applies command changes');
  await h.keys(ESC,ESC,ESC);await h.expect(draft);await h.capture('editor-preserved');
  assert.equal(h.requests().length,0);
  await h.saved(c=>c.commands?.['goal-resume'],['work continue']);
  return {case:'editor-controls',passed:true,sdk:piVersion,directory:path.relative(repository,h.cwd),requests:0,checks:['command-shortcut','settings-recovery','pending-reload','unsent-editor-text']};
 }finally{await h.stop();}
}

async function settingsPathsWalkthrough(){
 const h=await boot('settings-paths');
 try{
  await h.send('/goal-settings controls\r');await h.resize(20,72);await h.expect('Source: Default');
  await h.keys('Pause the goal',ENTER,ENTER,'\x15','/reload',ENTER);await h.expect('belongs to Pi');
  await h.capture('invalid-command');
  await h.keys('\x15','/work stop',ENTER);await h.saved(c=>c.commands?.['goal-pause'],['work stop']);
  await h.keys(ENTER,DOWN,ENTER,'/hold',ENTER);await h.saved(c=>c.commands?.['goal-pause'],['work stop','hold']);
  await h.keys(ENTER,DOWN,DOWN,ENTER);await h.saved(c=>c.commands?.['goal-pause'],[]);
  await h.keys(ENTER,DOWN,DOWN,DOWN,ENTER);await h.saved(c=>c.commands?.['goal-pause'],['goal-pause']);
  await h.keys(ESC,'\x1b[F',ENTER,DOWN,ENTER);assert.ok(h.config().commands,'Back preserves overrides');
  await h.keys(ENTER,ESC);assert.ok(h.config().commands,'Escape preserves overrides');
  await h.keys(ENTER,ENTER);await h.saved(c=>c.commands,undefined);
  await h.keys('Goal settings',ENTER,DOWN,DOWN,ENTER);await h.saved(c=>c.commands?.['goal-settings'],[]);
  await h.expect('recovery only');await h.capture('settings-recovery');
  return {case:'settings-paths',passed:true,sdk:piVersion,directory:path.relative(repository,h.cwd),requests:0,checks:['invalid-command','correct-input','replace','alias','disable','default','reset-back','reset-cancel','reset-commands','settings-recovery']};
 }finally{await h.stop();}
}

// The second half starts where the first ends: the settings command disabled (recovery only) in the
// same narrow terminal. It runs in its own job.
async function settingsKeysWalkthrough(){
 const h=await boot('settings-keys',{commands:{'goal-settings':[]}});
 try{
  await h.resize(20,72);
  await h.send('/goal-settings controls\r');await h.expect('Goal controls');
  await h.keys('\x1b[F',ENTER,ENTER);await h.saved(c=>c.commands,undefined);
  await h.keys(TAB,'Pause /',ENTER,ENTER,ESC);await h.saved(c=>c.keybindings,undefined);
  await h.keys(DOWN,ENTER,F6,ESC);await h.saved(c=>c.keybindings,undefined);
  await h.keys(ENTER,F6,ENTER);await h.saved(c=>c.keybindings?.pause,['escape','f6']);
  await h.keys(ENTER,DOWN,DOWN,ENTER,'\x15','potato',ENTER);await h.expect('Use Pi key names');
  await h.keys('\x15','["ctrl+,", "f6"]',ENTER);await h.saved(c=>c.keybindings?.pause,['ctrl+,','f6']);
  await h.keys(ENTER,DOWN,DOWN,ENTER,ENTER);await h.saved(c=>c.keybindings?.pause,['ctrl+,','f6']);
  await h.keys(ENTER,DOWN,DOWN,DOWN,ENTER);await h.saved(c=>c.keybindings?.pause,[]);
  await h.keys(ENTER,DOWN,DOWN,DOWN,DOWN,ENTER);await h.saved(c=>c.keybindings?.pause,'escape');
  await h.keys('\x13',ENTER,ENTER,'\x1b[18~',ENTER);await h.expect('overrides still apply');
  await h.keys('\x13',ENTER,DOWN,DOWN,DOWN,DOWN,DOWN,ENTER);await h.saved(c=>c.keybindings,undefined);
  await h.expect('Source: All projects');await h.capture('inherited-narrow');
  await h.keys('\x13',ESC,'\x1b[F',ENTER,ENTER);
  await until(()=>JSON.parse(fs.readFileSync(path.join(h.cwd,'global.json'),'utf8')).keybindings===undefined,'global key overrides reset');
  await h.keys('\x13',TAB,ENTER,DOWN,ENTER);await h.saved(c=>c.pauseOrder,'goal-first');
  await h.keys(ENTER);await h.capture('saved-pause-selected');assert.match(await h.screen(),/› Goal first/);
  await h.keys(ENTER);await h.saved(c=>c.pauseOrder,'goal-first');
  await h.keys(ENTER,DOWN,ENTER);await h.saved(c=>c.pauseOrder,'turn-first');
  await h.keys(ENTER,DOWN,ENTER);await h.saved(c=>c.pauseOrder,undefined);
  await h.capture('pause-inherited');
  assert.equal(h.requests().length,0,'configuration never asks the model');
  return {case:'settings-keys',passed:true,sdk:piVersion,directory:path.relative(repository,h.cwd),requests:0,checks:['capture-cancel','preview-cancel','additional-key','invalid-key','comma-roundtrip','disable-key','default-key','scope','inherit-key','reset-global','saved-pause-selection','inherit-pause','narrow-provenance']};
 }finally{await h.stop();}
}

async function commandShortcutWalkthrough(){
 const h=await boot('command-shortcuts',{keybindings:{commands:{'goal-direct':'f8','goal-pause':'f9'}}});
 try{
  await h.send('\x1b[19~');await h.expect('Goal objective');await h.send(ESC);
  assert.equal(h.requests().length,0);assert.equal(h.goals().length,0);
  await h.send('\x1b[19~');await h.expect('Goal objective');
  await h.send('Create greeting.txt containing exactly Hello from goal followed by a newline. Verify it.\r');
  await until(()=>h.requests().length===1,'shortcut starts a real goal');
  await h.send('\x1b[20~');await until(()=>h.goals()[0]?.status==='paused','Pause command shortcut stops both');
  await h.expect('Operation aborted');await h.capture('command-paused');
  assert.equal(fs.existsSync(path.join(h.cwd,'greeting.txt')),false);
  await h.send('/goal-resume\r');await until(()=>fs.existsSync(path.join(h.cwd,'greeting.txt'))&&h.goals().length===0,'shortcut goal completes after resume',20000);
  return {case:'command-shortcuts',passed:true,sdk:piVersion,directory:path.relative(repository,h.cwd),requests:h.requests().length,checks:['argument-dialog-cancel','argument-dialog-submit','pause-command-shortcut','resume','audited-completion']};
 }finally{await h.stop();}
}

async function nativeInterruptWalkthrough(){
 const h=await boot('native-interrupt',{keybindings:{pause:'f6'}});
 try{
  await h.send('/goal-direct Create greeting.txt containing exactly Hello from goal followed by a newline. Verify it.\r');
  await until(()=>h.requests().length===1,'visible work before native interrupt');await h.send(ESC);
  await until(()=>h.goals()[0]?.scheduler?.phase==='interrupted','native interrupt holds the turn');
  assert.equal(h.goals()[0].status,'active');await h.expect('waiting for you');await h.capture('native-held');
  await delay(6500);assert.equal(h.requests().length,1);assert.equal(fs.existsSync(path.join(h.cwd,'greeting.txt')),false);
  await h.send('Continue with the goal now.\r');
  await until(()=>fs.existsSync(path.join(h.cwd,'greeting.txt'))&&h.goals().length===0,'a user message releases the hold',20000);
  return {case:'native-interrupt',passed:true,sdk:piVersion,directory:path.relative(repository,h.cwd),requests:h.requests().length,checks:['native-interrupt','goal-stays-active','no-background-restart','user-message-continues','audited-completion']};
 }finally{await h.stop();}
}

async function dialogKeysWalkthrough(){
 const h=await boot('dialog-keys',{keybindings:{dialog:{confirm:'f6',cancel:'f7',up:'k',down:'j',toggleAuditor:'x'}}});
 try{
  await h.send('/goal Create the greeting file and verify it.\r');await h.expect('Confirm Goal Draft');await h.expect('F6');await h.expect('F7');
  await h.send(ENTER);assert.equal(h.goals().length,0,'the old confirmation key is inactive');
  await h.send('j');await h.capture('custom-navigation');
  await h.send('k');await h.send('x');await h.expect('Auditor disabled');
  await h.send('x');await h.expect('Auditor enabled');
  // Cancel returns to the conversation with the draft preserved for refinement.
  await h.send('\x1b[18~');await h.expect('Tell me what you would like to change.');assert.equal(h.goals().length,0);
  await h.send('/goal-cancel\r');await h.expect('Draft cancelled');
  await h.send('/goal Create the greeting file and verify it.\r');await h.expect('Confirm Goal Draft');
  await h.send(F6);await until(()=>fs.existsSync(path.join(h.cwd,'greeting.txt'))&&h.goals().length===0,'custom confirmation reaches audited completion',20000);
  return {case:'dialog-keys',passed:true,sdk:piVersion,directory:path.relative(repository,h.cwd),requests:h.requests().length,checks:['remapped-hints','old-confirm-inactive','custom-navigation','auditor-toggle','custom-cancel','draft-cancel','custom-confirm','audited-completion']};
 }finally{await h.stop();}
}

async function answerEditingWalkthrough(){
 const h=await boot('answer-editing',{keybindings:{dialog:{next:['n','ctrl+a'],previous:'p',cancel:'q',confirm:'f6'}}},'dialog-text');
 try{
  await h.send('/goal Create the greeting file and verify it.\r');await h.expect('First answer?');
  await h.keys('q','n','p','\x01','a','\x05');await h.expect('aqnp');
  await h.send(ESC);await h.expect('Write your own answer');await h.expect('F6 confirm');
  await h.keys(F6,ENTER);await h.expect('Second answer?');
  await h.send('Second answer.\r');await h.expect('Press F6 to submit');await h.expect('aqnp');
  await h.capture('answers-preserved');await h.send(F6);await h.expect('Confirm Goal Draft');
  await h.send(F6);await until(()=>fs.existsSync(path.join(h.cwd,'greeting.txt'))&&h.goals().length===0,'typed answers and custom confirmation reach completion',20000);
  return {case:'answer-editing',passed:true,sdk:piVersion,directory:path.relative(repository,h.cwd),requests:h.requests().length,checks:['letter-controls-preserve-text','native-cursor-keys','native-escape','preserved-draft','custom-editor-hints','custom-summary-confirm','audited-completion']};
 }finally{await h.stop();}
}

async function foreignFocusWalkthrough(){
 const h=await boot('foreign-focus',{keybindings:{pause:'f6'}},'foreign-focus');
 try{
  await h.send('/goal-direct Create greeting.txt and verify its content.\r');
  await until(()=>h.requests().length===1,'active goal request');
  for(const mode of ['native','overlay']){
   await h.send(`/foreign-focus ${mode}\r`);
   await h.expect(mode==='native'?'Foreign native dialog owns keyboard':'Foreign overlay owns keyboard');
   await h.send(F6);
   assert.equal(h.goals()[0]?.status,'active',`${mode}: foreign F6 cannot pause`);
   assert.notEqual(h.goals()[0]?.scheduler?.phase,'interrupted',`${mode}: foreign key cannot interrupt`);
   await h.send(ESC);
   assert.equal(h.goals()[0]?.status,'active',`${mode}: closing Escape cannot pause`);
   await h.capture(`foreign-${mode}-closed`);
  }
  await h.send(F6);
  await until(()=>h.goals()[0]?.status==='paused','main-editor pause restored');
  return {case:'foreign-focus',passed:true,sdk:piVersion,directory:path.relative(repository,h.cwd),checks:['native-focus','capturing-overlay','foreign-text-accessors','remapped-pause','closing-escape','editor-focus-restored']};
 }finally{await h.stop();}
}

// Each case owns its Pi process, provider, sessions and both settings layers.
// The cases mostly wait on the terminal, so run up to four at once.
const available=[['controls-ui',controlsWalkthrough],['controls-run',controlsRunWalkthrough],['settings-paths',settingsPathsWalkthrough],['settings-keys',settingsKeysWalkthrough],['editor-controls',editorWalkthrough],['command-shortcuts',commandShortcutWalkthrough],['together',()=>pauseWalkthrough('together')],['goal-first',()=>pauseWalkthrough('goal-first')],['goal-first-finish',()=>pauseWalkthrough('goal-first',true)],['native-interrupt',nativeInterruptWalkthrough],['dialog-keys',dialogKeysWalkthrough],['answer-editing',answerEditingWalkthrough]];
available.push(['foreign-focus',foreignFocusWalkthrough]);
const requested=process.argv.slice(2);
assert.ok(requested.every(name=>available.some(([id])=>id===name)),'Unknown walkthrough case');
const cases=available.filter(([name])=>!requested.length||requested.includes(name));
const results=new Array(cases.length);
const started=Date.now();let next=0;
await Promise.all(Array.from({length:Math.min(4,os.availableParallelism())},async()=>{
 while(next<cases.length){
  const index=next++;
  try{results[index]=await cases[index][1]();}
  catch(error){results[index]={case:cases[index][0],passed:false,error:String(error.stack??error)};}
  console.log(JSON.stringify(results[index]));
 }
}));
const report={sdk:piVersion,elapsedMs:Date.now()-started,results};
fs.writeFileSync(path.join(output,'results.json'),JSON.stringify(report,null,2)+'\n');
assert.ok(results.every(result=>result.passed),'All controls walkthroughs must pass; see experiments/runs/goal-controls/results.json');
