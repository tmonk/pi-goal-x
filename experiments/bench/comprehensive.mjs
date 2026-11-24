/** CPU/retention campaign complementing the complete filesystem/hook matrix. No model calls. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { focusedFixture, beginFsCount, endFsCount } from './bench-common.mjs';
import { loadGoalSettings } from '../../extensions/settings/resolve.ts';
import { goalPrompt } from '../../extensions/prompts/goal-prompts.ts';
import { taskIndex } from '../../extensions/goal-task-index.ts';
import { goalDetailPage } from '../../extensions/goal-detail.ts';
import { readGoalLedger, invalidateGoalLedgerCache, goalActivityEvents } from '../../extensions/goal-ledger.ts';
import { deriveGoalActivity } from '../../extensions/goal-activity.ts';
import { compactGoalCheckpointContext } from '../../extensions/goal-events.ts';
import { readSessionCheckpointHealth } from '../../extensions/goal-session-health.ts';
import * as auditor from '../../extensions/goal-auditor.ts';
import { deriveGoalDashboardModel } from '../../extensions/widgets/goal-dashboard-model.ts';
import { renderCompactDashboard, renderExpandedDashboard } from '../../extensions/widgets/goal-dashboard-renderer.ts';

const rows = [];
function measure(id, fn, iterations = 100, samples = 21) {
 for (let i = 0; i < 3; i++) fn();
 const times = []; const operations = [];
 global.gc?.(); const heap = process.memoryUsage().heapUsed;
 for (let s = 0; s < samples; s++) {
  beginFsCount(); const start = performance.now();
  for (let i = 0; i < iterations; i++) fn();
  times.push((performance.now() - start) / iterations); operations.push(endFsCount() / iterations);
 }
 global.gc?.(); const retainedBytes = process.memoryUsage().heapUsed - heap;
 times.sort((a,b) => a-b); operations.sort((a,b) => a-b);
 rows.push({id, iterations, samples, p50: times[10], p95: times[19], fsOps: process.env.GOAL_BENCH_SDK === 'real' ? null : operations[10], retainedBytes});
}
const f = focusedFixture();
try {
 const env = {PI_GOAL_SETTINGS_FILE: path.join(f.cwd,'settings.json'), PI_GOAL_GLOBAL_SETTINGS_FILE: path.join(f.cwd,'global.json')};
 measure('settings.warm', () => loadGoalSettings(f.cwd, env), 1000);
 for (const chars of [10000,1000000]) {
  const report = 'A verified result line with detail.\n'.repeat(Math.ceil(chars/35));
  measure(`auditor.stream.tail.${chars}`, () => auditor.recentNonEmptyLines ? auditor.recentNonEmptyLines(report,5) : report.split('\n').filter(line=>line.trim()).slice(-5));
 }
 const goal = {...f.goal, objective: 'Detailed requirement with Unicode 🧭. '.repeat(1000), taskList: {blockCompletion: true, proposedAt: '2026-09-07', tasks: Array.from({length: 50}, (_,i) => ({id: `t${i}`, title: `Task ${i}: ` + 'meaningful detail '.repeat(20), status:'pending', verificationContract: 'Check every requested artifact. '.repeat(50)}))}};
 measure('tasks.index.50', () => taskIndex(goal.taskList.tasks));
 measure('prompt.warm.large', () => goalPrompt(goal));
 measure('detail.tasks.50', () => goalDetailPage(goal, {section:'tasks'}));
 measure('detail.objective.large', () => goalDetailPage(goal, {section:'objective'}));
 const theme = {fg: (_color, text) => text, bg: (_color, text) => text, bold: text => text, strikethrough: text => text};
 const model = deriveGoalDashboardModel(goal, {focused:true, otherOpenGoals:0});
 for (const width of [40,120]) {
  measure(`render.compact.${width}`, () => renderCompactDashboard(model, theme, width));
  measure(`render.expanded.${width}`, () => renderExpandedDashboard(model, theme, width));
 }
 for (const count of [1000,10000,100000]) {
  const events = Array.from({length: count}, (_,i) => ({type:'task_complete', goalId:goal.id, taskId:`t${i}`, evidence:'Verified 🧭', at:new Date(1700000000000+i).toISOString()}));
  fs.writeFileSync(path.join(f.cwd,'.pi/goals/goal_events.jsonl'), events.map(e => JSON.stringify(e)).join('\n')+'\n');
  invalidateGoalLedgerCache();
  // Fourth argument is the candidate's opaque ledger generation. Baseline safely ignores it.
  const history = readGoalLedger({cwd:f.cwd});
  const first = goalDetailPage(goal, {section:'history'}, history.events, history.revision);
  measure(`detail.history.next.${count}`, () => goalDetailPage(goal, {section:'history', cursor:first.nextCursor}, history.events, history.revision), 1);
  const activity = goalActivityEvents({cwd:f.cwd},goal.id);
  measure(`activity.tail.${count}`, () => deriveGoalActivity(activity, goal.id));
  const messages = events.map((e,i) => i%10 ? {role:'assistant', content:'ordinary output'} : {role:'custom', customType:'pi-goal-event', content:'[PI GOAL ACTIVE goalId='+goal.id+']', details:{goalId:goal.id, kind:'checkpoint', version:1}});
  measure(`context.checkpoints.${count}`, () => compactGoalCheckpointContext(messages, goal), 3);
  const session = path.join(f.cwd, 'session.jsonl');
  fs.writeFileSync(session, messages.map(m => JSON.stringify({...m,type:m.customType?'custom_message':'message'})).join('\n'));
  measure(`session.health.${count}`, () => readSessionCheckpointHealth(session), 1);
 }
} finally { f.cleanup(); }
const output = {node:process.version, sdk:process.env.GOAL_BENCH_SDK ?? 'stub', method:'21 repeated samples, per-operation ms, explicit GC retained-heap observation; filesystem counts only in stub adapter mode', rows};
fs.writeFileSync(process.argv[2] ?? path.join(os.tmpdir(),'goal-comprehensive-bench.json'), JSON.stringify(output,null,2)+'\n');
console.log(rows.map(r=>`${r.id}: ${r.p50.toFixed(4)} ms`).join('\n'));
