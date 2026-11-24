/** Real-adapter payload comparison. onPayload always stops before dispatch. */
import assert from 'node:assert/strict';
import {readFileSync, writeFileSync, mkdtempSync, rmSync, realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {ModelRuntime, convertToLlm} from '@earendil-works/pi-coding-agent';
import {cacheGoalHistory} from '../../extensions/goal-prompt-cache.ts';
import {LiveTailRetention, MAX_RETAINED_COUNTER_BYTES} from '../../extensions/goal-live-retention.ts';
import {captureOne} from './capture-context.mjs';
import {FIXTURES, userMessage, assistantMessage} from './fixtures.mjs';
import {digest, summarize, compareReports, investigateCache} from './cache-compare.mjs';

const prefix = (a, b) => { let n=0; while(n<a.length && n<b.length && a[n].hash===b[n].hash) n++; return n; };
const root = fileURLToPath(new URL('../../', import.meta.url));

export async function buildReport() {
 const work=mkdtempSync(path.join(tmpdir(),'goal-cache-report-'));
 const rows=[];
 const samples=[];
 try {
  const runtime=await ModelRuntime.create({authPath:path.join(work,'auth.json'),modelsPath:null,allowModelNetwork:false,refreshOnCreate:false});
  for(const flavor of ['openai-responses','openai-completions','anthropic-messages','anthropic-compatible-completions']) {
   const api=flavor==='anthropic-compatible-completions'?'openai-completions':flavor;
   runtime.registerProvider('cache-report',{baseUrl:'http://127.0.0.1:1/v1',api,apiKey:'fixture-only',models:[{id:'fixture',name:'fixture',reasoning:false,input:['text','image'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:200000,maxTokens:128}]});
   const model=runtime.getModel('cache-report','fixture');
   if(flavor==='anthropic-compatible-completions') model.compat={cacheControlFormat:'anthropic',supportsLongCacheRetention:true};
   for(const tier of ['none','short','long']) {
    const serialize=async (id,captured,messages=captured.messages) => {
     let payload;
     const transients=messages.filter(m=>m.customType==='pi-goal-live-context').map(m=>m.content);
     await runtime.streamSimple(model,{systemPrompt:captured.baseSystem+captured.extensionSystem,messages:convertToLlm(messages),tools:[...captured.hostTools,...captured.tools].map(t=>({name:t.name,description:t.description,parameters:t.schema}))},{sessionId:'cache-report-fixed-session',cacheRetention:tier,onPayload:value=>{
      payload=value;
      cacheGoalHistory(payload,transients);
      throw new Error('Captured before dispatch');
     }}).result();
     assert.ok(payload,`${id}: missing provider payload`);
     // Tool descriptions may contain the known physical SDK/fixture root only.
     const normalized=JSON.parse(JSON.stringify(payload).replaceAll(realpathSync(path.join(root,'node_modules/@earendil-works/pi-coding-agent')),'/sdk'));
     const row={id:`${flavor}/${tier}/${id}`,...summarize(normalized,transients)};
     rows.push(row);
     if(samples.length<2) samples.push({id:row.id,payload:normalized});
     return row;
    };
    for(const id of Object.keys(FIXTURES)) await captureOne(id,{inspect:async captured=>{await serialize(id,captured);}});
    for(const value of [false,true]) await captureOne('active-regular-no-tasks',{settings:{showContextUsage:value},inspect:async captured=>{await serialize(`context-explicit-${value}`,captured);}});
    await captureOne('active-regular-no-tasks',{inspect:async (captured,{capture,baseMessages})=>{
     const base=[...baseMessages];
     let previous;
     for(let n=0;n<4;n++) {
      const messages=await capture.runContext(base);
      const current=await serialize(`advance-${n}`,captured,messages);
      if(previous) {
       const count=prefix(previous.blocks,current.blocks);
       // Explicit marker movement is covered separately; raw bytes stay recorded.
       current.reuse={blocks:count,bytes:previous.blocks.slice(0,count).reduce((s,b)=>s+b.bytes,0)};
       if(flavor.startsWith('openai')) assert.equal(count,previous.blocks.length,'unchanged-policy prefix lost');
      }
      const retry=await serialize(`retry-${n}`,captured,await capture.runContext(base));
      assert.deepEqual(retry.blocks,current.blocks,'identical retry changed');
      previous=current;
      base.push(assistantMessage(`progress ${n}`),userMessage(`continue ${n}`));
     }
    }});
   }
  }
  // Long deterministic corpus: current bounds and reset counts, including image content.
  const retention=new LiveTailRetention();
  const history=[userMessage('bounded history'),{role:'user',timestamp:1,content:[{type:'text',text:'tool output '.repeat(4096)},{type:'image',mimeType:'image/png',data:'a'.repeat(16384)}]}];
  let last, breaks=0;
  for(let n=0;n<1000;n++) {
   const fresh={state:'unchanging policy',counters:`Goal snapshot: ${n}`};
   const result=retention.apply('bounded',history,fresh);
   if(last && JSON.stringify(result.messages.slice(0,last.length))!==JSON.stringify(last)) breaks++;
   assert.ok(result.transientContents.length<=32,'tail bound exceeded');
   assert.ok(result.transientContents.slice(1).reduce((s,t)=>s+Buffer.byteLength(t),0)<=MAX_RETAINED_COUNTER_BYTES,'counter byte bound exceeded');
   assert.deepEqual(retention.apply('bounded',history,fresh),result,'retry changed at capacity');
   last=result.messages;
  }
  assert.ok(breaks>2 && breaks<40,'unexpected reset frequency');
  let source='archived-release';
  try {source=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();} catch { /* Gate assigns the pinned archive SHA. */ }
  const lockfile=readFileSync(path.join(root,'package-lock.json'));
  const locked=JSON.parse(lockfile);delete locked.version;delete locked.packages[''].version;
  return {version:1,source,node:process.version,lockfile:digest(lockfile),dependencies:digest(locked),sdk:JSON.parse(readFileSync(path.join(root,'node_modules/@earendil-works/pi-coding-agent/package.json'),'utf8')).version,corpus:{transitions:1000,breaks},investigation:investigateCache(),rows,samples};
 } finally {rmSync(work,{recursive:true,force:true});}
}

if(process.argv[1]===fileURLToPath(import.meta.url)) {
 const candidate=await buildReport();
 const baselinePath=process.argv.find(a=>a.startsWith('--baseline='))?.slice(11);
 const output=process.argv.find(a=>a.startsWith('--output='))?.slice(9);
 if(output) writeFileSync(output,JSON.stringify(candidate,null,2)+'\n');
 const result=baselinePath?compareReports(JSON.parse(readFileSync(baselinePath,'utf8')),candidate):{scenarios:candidate.rows.length,corpus:candidate.corpus};
 console.log(JSON.stringify(result,null,2));
}
