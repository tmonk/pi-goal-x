/** Isolated runtime/token campaign; real hooks, no model calls. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { Session } from 'node:inspector/promises';
import * as ledger from '../../extensions/goal-ledger.ts';
import { deriveGoalActivity } from '../../extensions/goal-activity.ts';
import { deriveGoalDashboardModel } from '../../extensions/widgets/goal-dashboard-model.ts';
import { createHarness, startHarness, focusedFixture, makeGoalFiles, beginFsCount, endFsCount } from './bench-common.mjs';
import { invalidateGoalPoolCache, writeActiveGoalFile } from '../../extensions/storage/goal-files.ts';
import { invalidateGoalSettingsCache } from '../../extensions/settings/files.ts';
const rows=[];
const growth=[];
async function allocationSample(fn, n=10) {
 const profiler=new Session(); profiler.connect();
 try {
  await profiler.post('HeapProfiler.startSampling',{samplingInterval:1024,includeObjectsCollectedByMajorGC:true,includeObjectsCollectedByMinorGC:true});
  for(let i=0;i<n;i++)await fn();
  const {profile}=await profiler.post('HeapProfiler.stopSampling');
  const sum=node=>node.selfSize+node.children.reduce((s,c)=>s+sum(c),0);
  return sum(profile.head)/n;
 } finally {profiler.disconnect();}
}
async function measure(id, fn, n=30) {
 for(let i=0;i<3;i++) await fn();
 const samples=[];const operations=[]; global.gc?.(); const heap=process.memoryUsage().heapUsed;
 for(let i=0;i<n;i++){beginFsCount();const t=performance.now();await fn();samples.push(performance.now()-t);operations.push(endFsCount());}
 samples.sort((a,b)=>a-b);
 global.gc?.(); operations.sort((a,b)=>a-b);
 const heapDeltaBytes=process.memoryUsage().heapUsed-heap;
 rows.push({id,n,fsOps:operations[Math.floor(n*.5)],p50:samples[Math.floor(n*.5)],p95:samples[Math.min(n-1,Math.floor(n*.95))],heapDeltaBytes,sampledAllocationBytesPerOp:await allocationSample(fn)});
}
for(const count of (process.env.GOAL_BENCH_EVENT_COUNTS?.split(',').map(Number) ?? [1000,10000,100000])) {
 const f=focusedFixture();
 try {
  const events=Array.from({length:count},(_,i)=>({type:'task_complete',goalId:i%2?f.goal.id:'other',taskId:`t${i}`,evidence:'verified',at:new Date(1700000000000+i*1000).toISOString()}));
  fs.writeFileSync(path.join(f.cwd,'.pi/goals/goal_events.jsonl'),events.map(e=>JSON.stringify(e)).join('\n')+'\n');
  ledger.invalidateGoalLedgerCache();
  await measure(`cold_history.${count}`,async()=>{
   ledger.invalidateGoalLedgerCache();invalidateGoalPoolCache();invalidateGoalSettingsCache();
   fs.rmSync(path.join(f.cwd,'.pi/goals',ledger.LEDGER_CHECKPOINT_FILE),{force:true});
   const cold=createHarness({cwd:f.cwd,sessionEntries:f.sessionEntries});await startHarness(cold);await cold.handlers.get('session_shutdown')({},cold.ctx);
  },30);
  const h=createHarness({cwd:f.cwd,sessionEntries:f.sessionEntries});await startHarness(h);
  const checkpointBytes=()=>{try{return fs.statSync(path.join(f.cwd,'.pi/goals',ledger.LEDGER_CHECKPOINT_FILE)).size;}catch{return 0;}};
  const size={events:count,ledgerBytes:fs.statSync(path.join(f.cwd,'.pi/goals/goal_events.jsonl')).size,checkpointBytes:checkpointBytes()};growth.push(size);
  const recent=()=>ledger.goalActivityEvents ? ledger.goalActivityEvents(h.ctx,f.goal.id) : ledger.readGoalLedger(h.ctx).events;
  await measure(`activity.${count}`,()=>deriveGoalActivity(recent(),f.goal.id));
  await measure(`dashboard.${count}`,()=>deriveGoalDashboardModel(f.goal,{focused:true,otherOpenGoals:0,ledgerEvents:recent()}));
  await measure(`before_agent_start.${count}`,()=>h.handlers.get('before_agent_start')({systemPrompt:'base',prompt:'continue'},h.ctx));
  await measure(`append.${count}`,()=>ledger.appendGoalEvent(h.ctx,{type:'task_complete',goalId:f.goal.id,taskId:'new',evidence:'ok',at:'2026-09-07T00:00:00Z'}));
  size.checkpointBytes=checkpointBytes();
  await h.handlers.get('session_shutdown')({},h.ctx);
 } finally {f.cleanup();}
}
for(const count of (process.env.GOAL_BENCH_HISTORY_ONLY ? [] : [10,100])) {
 const f=focusedFixture();
 try {
  writeActiveGoalFile({cwd:f.cwd},{...f.goal,taskList:{tasks:Array.from({length:count},(_,i)=>({id:`t${i}`,title:`Task ${i}`,status:'pending'})),blockCompletion:true,proposedAt:'2026-09-07'}});
  const h=createHarness({cwd:f.cwd,sessionEntries:f.sessionEntries});await startHarness(h);
  const tool=h.tools.get('update_goal_task');
  // Equivalent ordered focus transitions: legacy calls versus the optional batch form.
  const updates=Array.from({length:count},(_,i)=>({task_id:`t${i}`,status:'start'}));
  await measure(`task_batch.${count}`,async()=>{
   await h.handlers.get('turn_start')({},h.ctx);
   if(tool.parameters.properties.updates)await tool.execute('batch',{updates},undefined,undefined,h.ctx);
   else for(const update of updates)await tool.execute('single',update,undefined,undefined,h.ctx);
   await h.handlers.get('turn_end')({},h.ctx);
  });
  await h.handlers.get('session_shutdown')({},h.ctx);
 } finally {f.cleanup();}
}
for(const goals of (process.env.GOAL_BENCH_HISTORY_ONLY ? [] : [1,10,50])) {
 const f=focusedFixture();
 try {
  if(goals>1)makeGoalFiles(f.cwd,goals-1);
  await measure(`startup.${goals}`,async()=>{
   ledger.invalidateGoalLedgerCache();invalidateGoalPoolCache();invalidateGoalSettingsCache();
   const h=createHarness({cwd:f.cwd,sessionEntries:f.sessionEntries});await startHarness(h);await h.handlers.get('session_shutdown')({},h.ctx);
  },30);
 } finally {f.cleanup();}
}
const out=process.argv[2] ?? path.join(os.tmpdir(),'goal-runtime-bench.json');
fs.writeFileSync(out,JSON.stringify({node:process.version,method:'30 timing samples; 1KB V8 allocation sampling in a separate pass; explicit GC before/after retained heap observation',growth,rows},null,2)+'\n');
console.log(rows.map(r=>`${r.id}: p50=${r.p50.toFixed(3)}ms p95=${r.p95.toFixed(3)}ms`).join('\n'));
