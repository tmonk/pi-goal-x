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
 if(baseline.corpus) {
  assert.equal(candidate.corpus.transitions,baseline.corpus.transitions);
  assert.ok(candidate.corpus.breaks<=baseline.corpus.breaks,'retention reset frequency got worse');
 }
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
  // Goal text is allowed to be laid out differently (see below), which moves the
  // explicit marker with it. Rows with identical goal text must match exactly.
  const liveBlk=blk=>/\[PI GOAL|\[TASK LIST|\[This is the current goal policy|Only the latest goal policy|Goal snapshot:/.test((blk.text??JSON.stringify(blk.raw)).slice(0,120));
  if(!a.blocks.some(liveBlk)&&!b.blocks.some(liveBlk)) assert.deepEqual(b.markers,a.markers,`${b.id}: cache markers changed`);
  else assert.deepEqual(b.markers.filter(x=>x.path[0]!=='messages'&&x.path[0]!=='input'),a.markers.filter(x=>x.path[0]!=='messages'&&x.path[0]!=='input'),`${b.id}: cache markers changed`);
  assert.equal(b.markers.length,a.markers.length,`${b.id}: marker count changed`);
  // Goal text (policy, task list, snapshot) may be split differently now, but
  // everything else must be byte-identical and in the same order.
  const live=blk=>/\[PI GOAL|\[TASK LIST|\[This is the current goal policy|Only the latest goal policy|Goal snapshot:/.test((blk.text??JSON.stringify(blk.raw)).slice(0,120));
  const keep=r=>r.blocks.filter(blk=>!live(blk)).map(blk=>/msg_pi_\d+/.test(JSON.stringify(blk.raw))?digest(JSON.stringify(blk.raw).replace(/msg_pi_\d+/g,'msg_pi')):blk.hash);
  assert.deepEqual(keep(b),keep(a),`${b.id}: non-goal content changed`);
  assert.ok(b.blocks.length>=a.blocks.length && b.blocks.length<=a.blocks.length+1,`${b.id}: unexpected block count`);
  assert.ok(b.bytes<=a.bytes+200,`${b.id}: request got larger`);
  differences.push({scenario:b.id,reason:'policy-counters-snapshot-split',bytes:b.bytes-a.bytes});
  if(a.reuse) {
   assert.ok(b.reuse && b.reuse.blocks>=a.reuse.blocks-1,`${b.id}: warm-prefix blocks lost`);
   assert.ok(b.reuse.bytes>=a.reuse.bytes-Math.max(300,a.reuse.bytes*0.05),`${b.id}: reusable history lost`);
  }
 }
 return {scenarios:candidate.rows.length,approvedDifferences:differences};
}

/** Ten state/task transitions from #108. Task progress must not break the prefix. */
export function investigateCache() {
 let goal=createGoal({objective:'Complete three verified tasks',autoContinue:true,sisyphus:false},0);
 goal.id='cache-investigation';
 const history=[userMessage('Begin')], retention=new LiveTailRetention();
 // Usage and notes ride at the end of each request and are never retained, so
 // the prefix a cache can reuse is everything before them (stableLength).
 const stable=result=>result.messages.slice(0,result.stableLength);
 let previous=stable(retention.apply('state-workflow',history,goalPromptParts(goal)));
 const kinds=['work','set-tasks','work','complete-1','work','complete-2','work','complete-3','work','work'];
 const stateChanges=[];
 for(const [n,kind] of kinds.entries()) {
  if(kind==='set-tasks') goal={...goal,taskList:{tasks:[1,2,3].map(i=>({id:`t${i}`,title:`Required task ${i}`,status:'pending'})),blockCompletion:true,proposedAt:'1970-01-01T00:00:00Z'}};
  else if(kind.startsWith('complete')) goal={...goal,taskList:{...goal.taskList,tasks:goal.taskList.tasks.map(task=>task.id===`t${kind.at(-1)}`?{...task,status:'complete',evidence:'verified'}:task)}};
  history.push(assistantMessage(`Work ${n}`),userMessage('Continue'));
  const next=stable(retention.apply('state-workflow',history,goalPromptParts(goal)));
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
   const kept=stable(result);
   if(prior && JSON.stringify(kept.slice(0,prior.length))!==JSON.stringify(prior))breaks++;
   if(prior && JSON.stringify(kept)!==JSON.stringify(prior))appendedCounters++;
   totalRequestBytes+=Buffer.byteLength(JSON.stringify(result.messages));
   prior=kept;
  }
  occupancy.push({showContextUsage,requests:80,breaks,appendedCounters,totalRequestBytes});
 }
 return {stateChanges,occupancy,decision:'task progress appends a snapshot; only policy changes reset'};
}

