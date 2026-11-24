/** Pure payload comparisons and deterministic retention measurements. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {LiveTailRetention} from '../../extensions/goal-live-retention.ts';
import {createGoal} from '../../extensions/goal-record.ts';
import {goalPromptParts} from '../../extensions/prompts/goal-prompts.ts';
import {userMessage, assistantMessage} from './fixtures.mjs';

export const digest = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const textBlock = block => typeof block.content === 'string' ? block.content : undefined;

export function summarize(payload, transients=[]) {
 const blocks=payload.input??payload.messages;
 assert.ok(Array.isArray(blocks) && blocks.length, 'adapter omitted model-visible input');
 const markers=[];
 function visit(value, trail=[]) {
  if(!value || typeof value!=='object') return;
  if(value.cache_control || value.cachePoint) {
   assert.ok(!transients.includes(value.text), 'cache marker on a transient block');
   markers.push({path:trail, value:value.cache_control??value.cachePoint});
  }
  for(const [key, child] of Object.entries(value)) visit(child,[...trail,key]);
 }
 visit(payload);
 return {
  immutable:digest({system:payload.system,instructions:payload.instructions,systemMessages:blocks.filter(b=>b.role==='system'||b.role==='developer'),tools:payload.tools}),
  options:digest(Object.fromEntries(Object.entries(payload).filter(([k])=>!['system','instructions','tools','messages','input'].includes(k)))),
  blocks:blocks.map(block=>({hash:digest(block),bytes:Buffer.byteLength(JSON.stringify(block)),raw:block,...(textBlock(block)===undefined?{}:{text:textBlock(block)})})),
  bytes:Buffer.byteLength(JSON.stringify(payload)), markers,
 };
}

/** No payload normalization: a permitted display delta must match an exact block. */
export function compareReports(baseline, candidate) {
 assert.equal(candidate.version,baseline.version);
 assert.ok(baseline.rows.length>0,'empty baseline');
 assert.deepEqual(candidate.rows.map(r=>r.id),baseline.rows.map(r=>r.id),'missing/reordered scenario');
 if(baseline.corpus) assert.deepEqual(candidate.corpus,baseline.corpus,'retention bounds/reset frequency changed');
 if(baseline.dependencies) assert.equal(candidate.dependencies,baseline.dependencies,'comparison dependencies differ');
 if(baseline.investigation) {
  assert.deepEqual(candidate.investigation.stateChanges.map(({kind,prefixBreak})=>({kind,prefixBreak})),baseline.investigation.stateChanges.map(({kind,prefixBreak})=>({kind,prefixBreak})),'state reset classification changed');
  assert.equal(candidate.investigation.occupancy[1].breaks,0,'hidden occupancy invalidated retention');
  assert.equal(candidate.investigation.occupancy[1].appendedCounters,0,'hidden occupancy added redundant counters');
  for(const [n,step] of candidate.investigation.stateChanges.entries()) assert.ok(step.reusableBlocks>=baseline.investigation.stateChanges[n].reusableBlocks,'unchanged workflow lost reusable history');
 }
 const differences=[];
 for(let i=0;i<baseline.rows.length;i++) {
  const a=baseline.rows[i], b=candidate.rows[i];
  assert.equal(b.immutable,a.immutable,`${b.id}: immutable prefix changed`);
  assert.equal(b.options,a.options,`${b.id}: cache/provider options changed`);
  assert.deepEqual(b.markers,a.markers,`${b.id}: cache markers changed`);
  assert.equal(b.blocks.length,a.blocks.length,`${b.id}: unexpected block count`);
  for(let j=0;j<a.blocks.length;j++) {
   if(a.blocks[j].hash===b.blocks[j].hash) continue;
   assert.ok(!b.id.endsWith('/context-explicit-true'),`${b.id}: explicit opt-in differs from release`);
   let edits=0;
   const expected=value=>{
    if(typeof value==='string' && value.startsWith('Goal snapshot:') && value.includes('\nContext snapshot: unavailable\n')) {edits++;return value.replace('\nContext snapshot: unavailable\n','\n');}
    if(Array.isArray(value))return value.map(expected);
    if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,expected(v)]));
    return value;
   };
   const approved=expected(a.blocks[j].raw);
   assert.ok(edits>0,`${b.id}: unexplained block ${j}`);
   assert.deepEqual(b.blocks[j].raw,approved,`${b.id}: unexpected counter edit`);
   differences.push({scenario:b.id,block:j,reason:'default-context-display-off',removedBytes:a.blocks[j].bytes-b.blocks[j].bytes});
  }
  if(a.reuse) {
   assert.equal(b.reuse?.blocks,a.reuse.blocks,`${b.id}: warm-prefix blocks lost`);
   const removed=a.blocks.slice(0,a.reuse.blocks).reduce((sum,block,j)=>sum+block.bytes-b.blocks[j].bytes,0);
   assert.equal(b.reuse.bytes,a.reuse.bytes-removed,`${b.id}: reusable history lost`);
  }
 }
 return {scenarios:candidate.rows.length,approvedDifferences:differences};
}

/** Ten state/task transitions from #108. Task progress must not break the prefix. */
export function investigateCache() {
 let goal=createGoal({objective:'Complete three verified tasks',autoContinue:true,sisyphus:false},0);
 goal.id='cache-investigation';
 const history=[userMessage('Begin')], retention=new LiveTailRetention();
 let previous=retention.apply('state-workflow',history,goalPromptParts(goal)).messages;
 const kinds=['work','set-tasks','work','complete-1','work','complete-2','work','complete-3','work','work'];
 const stateChanges=[];
 for(const [n,kind] of kinds.entries()) {
  if(kind==='set-tasks') goal={...goal,taskList:{tasks:[1,2,3].map(i=>({id:`t${i}`,title:`Required task ${i}`,status:'pending'})),blockCompletion:true,proposedAt:'1970-01-01T00:00:00Z'}};
  else if(kind.startsWith('complete')) goal={...goal,taskList:{...goal.taskList,tasks:goal.taskList.tasks.map(task=>task.id===`t${kind.at(-1)}`?{...task,status:'complete',evidence:'verified'}:task)}};
  history.push(assistantMessage(`Work ${n}`),userMessage('Continue'));
  const next=retention.apply('state-workflow',history,goalPromptParts(goal)).messages;
  let shared=0;while(shared<previous.length && JSON.stringify(previous[shared])===JSON.stringify(next[shared]))shared++;
  const prefixBreak=shared!==previous.length;
  // Task progress lives in the snapshot block, so no step resets the prefix (#108).
  assert.equal(prefixBreak,false,`${kind}: unexplained reset`);
  stateChanges.push({kind,prefixBreak,reusableBlocks:shared,reusableBytes:Buffer.byteLength(JSON.stringify(previous.slice(0,shared))),requestBytes:Buffer.byteLength(JSON.stringify(next))});
  previous=next;
 }
 assert.equal(stateChanges.filter(step=>step.prefixBreak).length,0);
 const occupancy=[];
 for(const showContextUsage of [true,false]) {
  const retained=new LiveTailRetention();
  const base=[userMessage('Unchanged history')];
  let prior,breaks=0,appendedCounters=0,totalRequestBytes=0;
  for(let n=0;n<80;n++) {
   const result=retained.apply('occupancy',base,goalPromptParts(goal,{showContextUsage},{tokens:n+1,contextWindow:1000}));
   if(prior && JSON.stringify(result.messages.slice(0,prior.length))!==JSON.stringify(prior))breaks++;
   if(prior && JSON.stringify(result.messages)!==JSON.stringify(prior))appendedCounters++;
   totalRequestBytes+=Buffer.byteLength(JSON.stringify(result.messages));
   prior=result.messages;
  }
  occupancy.push({showContextUsage,requests:80,breaks,appendedCounters,totalRequestBytes});
 }
 return {stateChanges,occupancy,decision:'task progress appends a snapshot; only policy changes reset'};
}

