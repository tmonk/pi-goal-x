import test from "node:test";
import assert from "node:assert/strict";
import {stabilizationHarness, deferred} from "./stabilization-utils.ts";
import {latestAuditorResultForGoal} from "../extensions/goal-ledger.ts";
import {buildGoalHistoryBlock} from "../extensions/goal-format.ts";
import {readGoalLedger} from "../extensions/goal-ledger.ts";
import {goalRuntimeEvents, invalidateGoalLedgerCache} from "../extensions/goal-ledger.ts";
import {writeActiveGoalFile, parseGoalFile} from "../extensions/storage/goal-files.ts";
import {mkdirSync, rmSync} from "node:fs";
import path from "node:path";
import {mutateSettingsLayer} from "../extensions/goal-settings.ts";

const approved = {approved: true, output: "Evidence checked. <approved/>", model: "fixture"};
const stale = () => {throw new Error("This extension ctx is stale after session replacement or reload.");};

for (const event of ["session_start", "session_tree", "session_shutdown"]) test(`${event}: stale getters cannot skip cleanup`, async () => {
 const h = stabilizationHarness();
 try {
  let invalidated = false;
  const ctx = new Proxy(h.ctx, {get(target, key) {if (invalidated && (key === "hasUI" || key === "cwd" || key === "sessionManager")) return stale(); return Reflect.get(target, key);}});
  await h.event("session_start", {reason: "start"}, ctx);
  let unsubscribed = 0;
  h.core.terminalInputUnsubscribe = () => {unsubscribed++;};
  invalidated = true;
  await h.event(event, {reason: "start"}, ctx);
  assert.equal(unsubscribed, 1);
  assert.equal(h.core.terminalInputUnsubscribe, null);
  assert.equal(h.core.auditAnimationTimer, null);
  assert.equal(h.core.goalWidgetComponentRef.current, null);
 } finally {await h.cleanup();}
});

test("unexpected teardown errors stay observable after every local cleanup step", async () => {
 const h = stabilizationHarness();
 try {
  await h.start();
  h.core.terminalInputUnsubscribe = () => {throw new Error("unsubscribe failed");};
  h.core.auditAnimationTimer = setInterval(() => {}, 1000);
  await assert.rejects(h.event("session_shutdown"), /unsubscribe failed/);
  assert.equal(h.core.terminalInputUnsubscribe, null);
  assert.equal(h.core.auditAnimationTimer, null);
  assert.equal(h.core.goalWidgetComponentRef.current, null);
 } finally {await h.cleanup();}
});

test("shutdown aborts a real pending audit, records one outcome and ignores late callbacks", async () => {
 const pending = deferred<any>(), started = deferred<any>();
 let args: any;
 const h = stabilizationHarness(async options => {args = options; started.resolve(null); return pending.promise;});
 try {
  await h.start();
  const result = h.call("update_goal", {status: "complete"});
  await started.promise;
  await h.event("session_shutdown");
  assert.equal(args.signal.aborted, true);
  assert.equal(h.ledger().filter(e => e.type === "audit_result" || e.type === "audit_skipped").length, 1);
  args.onProgress({phase: "running", recentOutput: ["late"]});
  pending.resolve(approved);
  await result;
  assert.equal(h.ledger().filter(e => e.type === "audit_result" || e.type === "audit_skipped").length, 1);
  assert.equal(h.core.auditProgress, null);
  assert.equal(h.core.auditAnimationTimer, null);
  assert.equal(h.core.state.goal?.status, "active");
 } finally {pending.resolve(approved); await h.cleanup();}
});

test("a throwing auditor is settled and releases all audit resources", async () => {
 const h = stabilizationHarness(async () => {throw new Error("auditor crashed");});
 try {
  await h.start();
  const result = await h.call("update_goal", {status: "complete"});
  assert.match(result.content[0].text, /auditor crashed/);
  assert.equal(h.core.auditAnimationTimer, null);
  assert.equal(h.core.auditProgress, null);
  assert.equal(h.ledger().filter(e => e.type === "audit_result").length, 1);
 } finally {await h.cleanup();}
});

test("a replacement completion with the auditor disabled retires the running attempt", async () => {
 const pending = deferred<any>(), started = deferred<any>();
 let signal!: AbortSignal;
 const h = stabilizationHarness(async args => {signal = args.signal; started.resolve(null); return pending.promise;});
 let first: Promise<any> | undefined;
 try {
  await h.start(); first = h.call("update_goal", {status: "complete"}); await started.promise;
  h.core.updateFocusedGoal({...h.core.state.goal!, skipAuditor: true}, h.ctx);
  await h.call("update_goal", {status: "complete"});
  assert.equal(signal.aborted, true, "the replaced independent auditor must actually stop");
  assert.equal(h.core.activeAudit, null);
  assert.equal(h.core.auditAnimationTimer, null);
  assert.equal(h.core.state.goal?.status, "complete");
  const settled = h.ledger().filter(e => e.type === "audit_result" || e.type === "audit_skipped");
  assert.equal(settled.length, 2, "each accepted attempt has exactly one outcome");
  pending.resolve(approved); await first;
  assert.deepEqual(h.ledger().filter(e => e.type === "audit_result" || e.type === "audit_skipped"), settled);
 } finally {pending.resolve(approved); await first; await h.cleanup();}
});

test("a newer audit start supersedes an older verdict in every history reader", async () => {
 const h = stabilizationHarness();
 try {
 const events: any = [{type: "audit_result", goalId: h.goal.id, verdict: "approved", report: "old success", at: "2026-10-26T00:00:00Z"}, {type: "audit_started", goalId: h.goal.id, at: "2026-10-27T00:00:00Z"}];
 assert.equal(latestAuditorResultForGoal(events, h.goal.id), undefined);
 const text = buildGoalHistoryBlock(h.goal, events);
 assert.match(text, /no recorded result/i);
 assert.doesNotMatch(text, /Last audit: approved/);
 } finally {await h.cleanup();}
});

test("overlapping sessions cannot attribute an older result to the newest audit", async () => {
 const a = deferred<any>(), b = deferred<any>(), aStarted = deferred<any>(), bStarted = deferred<any>();
 const first = stabilizationHarness(async () => {aStarted.resolve(null); return a.promise;});
 const second = stabilizationHarness(async () => {bStarted.resolve(null); return b.promise;});
 let firstResult: Promise<any> | undefined, secondResult: Promise<any> | undefined;
 try {
  await first.start();
  firstResult = first.call("update_goal", {status: "complete"});
  await aStarted.promise;
  const shared = {...second.ctx, cwd: first.cwd};
  await second.event("session_start", {reason: "start"}, shared);
  secondResult = second.call("update_goal", {status: "complete"}, shared);
  await bStarted.promise;
  a.resolve({...approved, approved: false, output: "older rejection"});
  await firstResult;
  assert.equal(latestAuditorResultForGoal(readGoalLedger({cwd: first.cwd}).events, first.goal.id), undefined, "newest audit still has no outcome");
 } finally {
  a.resolve(approved); b.resolve(approved);
  await Promise.allSettled([firstResult, secondResult]);
  await second.cleanup(); await first.cleanup();
 }
});

for (const external of [false, true]) test(`project replacement flushes the original ${external ? "external" : "default"} storage owner`, async () => {
 const h = stabilizationHarness(), incoming = stabilizationHarness();
 try {
  if (external) {
   h.ctx.goalStorageRoot = path.join(h.cwd, "custom-pool");
   mkdirSync(h.ctx.goalStorageRoot, {recursive: true});
   writeActiveGoalFile(h.ctx, h.goal);
   const entries = h.ctx.sessionManager.getBranch();
   h.ctx.sessionManager.getBranch = () => entries.map((entry: any) => ({...entry, data: {...entry.data, storageRoot: h.ctx.goalStorageRoot}}));
  }
  writeActiveGoalFile(incoming.ctx, {...incoming.goal, objective: "Replacement project's independent work"});
  const beforeIncoming = incoming.disk();
  await h.start();
  await h.call("set_goal_tasks", {tasks: [{id: "task", title: "Finish"}], block_completion: true});
  await h.event("turn_end", {message: {role: "assistant", stopReason: "stop"}});
  await h.event("turn_start");
  await h.call("update_goal_task", {task_id: "task", status: "complete", evidence: "verified"});
  await h.event("session_start", {reason: "start"}, incoming.ctx);
  const outgoing = readGoalLedger(external ? {cwd: h.cwd, goalStorageRoot: h.ctx.goalStorageRoot} : {cwd: h.cwd});
  assert.ok(outgoing.events.some(e => e.type === "task_complete"));
  assert.equal(incoming.disk(), beforeIncoming, "incoming file is never the outgoing transaction's destination");
  assert.equal(h.core.state.goal?.objective, "Replacement project's independent work");
  await h.event("session_shutdown", {}, h.ctx);
  assert.equal(h.core.state.goal?.objective, "Replacement project's independent work", "late shutdown cannot retire the replacement");
 } finally {await h.event("session_shutdown", {}, incoming.ctx); await h.cleanup(); await incoming.cleanup();}
});

test("late audit progress and finally cannot touch the replacement audit with equal external IDs", async () => {
 const old = deferred<any>(), next = deferred<any>(), firstStarted = deferred<any>(), nextStarted = deferred<any>();
 const callbacks: any[] = [];
 const h = stabilizationHarness(async args => {
  callbacks.push(args);
  if (callbacks.length === 1) {firstStarted.resolve(null); return old.promise;}
  nextStarted.resolve(null); return next.promise;
 });
 const incoming = stabilizationHarness();
 let first: Promise<any> | undefined, second: Promise<any> | undefined;
 try {
  await h.start(); first = h.call("update_goal", {status: "complete"}); await firstStarted.promise;
  await h.event("session_start", {reason: "start"}, incoming.ctx);
  second = h.call("update_goal", {status: "complete"}, incoming.ctx); await nextStarted.promise;
  const progress = h.core.auditProgress, timer = h.core.auditAnimationTimer;
  callbacks[0].onProgress({phase: "running", recentOutput: ["obsolete"]});
  old.resolve(approved); await first;
  assert.equal(h.core.auditProgress, progress);
  assert.equal(h.core.auditAnimationTimer, timer);
  assert.equal(callbacks[0].signal.aborted, true);
  assert.equal(h.core.state.goal?.status, "active");
  assert.equal(h.ledger().filter(e => e.type === "audit_result").length, 1);
  assert.equal(incoming.ledger().filter(e => e.type === "audit_result").length, 0);
 } finally {
  old.resolve(approved); next.resolve({...approved, approved: false});
  await Promise.allSettled([first, second]);
  await h.event("session_shutdown", {}, incoming.ctx); await h.cleanup(); await incoming.cleanup();
 }
});

test("session replacement while the Escape choice is pending retires exactly one attempt", async () => {
 const pending = deferred<any>(), started = deferred<any>(), choice = deferred<string>(), shown = deferred<any>();
 const h = stabilizationHarness(async () => {started.resolve(null); return pending.promise;}), incoming = stabilizationHarness();
 let result: Promise<any> | undefined;
 try {
  h.ctx.hasUI = true;
  h.ctx.ui.custom = async () => {shown.resolve(null); return choice.promise;};
  await h.start(); result = h.call("update_goal", {status: "complete"}); await started.promise;
  h.core.abortAudit(h.ctx); pending.resolve({...approved, approved: false, error: "Auditor aborted."}); await shown.promise;
  await h.event("session_start", {reason: "start"}, incoming.ctx);
  h.core.goalModalDepth = 1;
  choice.resolve("complete_without_audit"); await result;
  assert.equal(h.core.goalModalDepth, 1, "old dialog cannot consume the new modal lease");
  assert.equal(h.core.state.goal?.status, "active");
  assert.equal(h.ledger().filter(e => e.type === "audit_result" || e.type === "audit_skipped").length, 1);
 } finally {choice.resolve("continue_working"); pending.resolve(approved); await result; await h.event("session_shutdown", {}, incoming.ctx); await h.cleanup(); await incoming.cleanup();}
});

test("a retired resume selector cannot open a dialog for the replacement's paused goal", async () => {
 const h = stabilizationHarness(), incoming = stabilizationHarness();
 const selected = deferred<any>(), shown = deferred<any>();
 let confirms = 0, resuming: Promise<any> | undefined;
 try {
  h.ctx.hasUI = true;
  h.ctx.mode = "tui";
  h.ctx.sessionManager.getBranch = () => [];
  h.ctx.ui.select = async () => {shown.resolve(null); return selected.promise;};
  h.ctx.ui.confirm = async () => {confirms++; return true;};
  writeActiveGoalFile(h.ctx, {...h.goal, id: "second-goal", activePath: undefined});
  writeActiveGoalFile(incoming.ctx, {...incoming.goal, status: "paused"});
  resuming = h.event("session_start", {reason: "resume"});
  await shown.promise;
  await h.event("session_start", {reason: "start"}, incoming.ctx);
  selected.resolve(undefined); await resuming;
  assert.equal(confirms, 0, "an old startup flow must stop before the next UI step");
  assert.equal(h.core.state.goal?.status, "paused");
  assert.equal(h.core.goalModalDepth, 0);
 } finally {selected.resolve(undefined); await resuming; await h.event("session_shutdown", {}, incoming.ctx); await h.cleanup(); await incoming.cleanup();}
});

for (const response of ["answer", "cancel", "error"]) test(`a retired command shortcut ${response} cannot dispatch or release a replacement modal`, async () => {
 const h = stabilizationHarness(), incoming = stabilizationHarness();
 const answer = deferred<any>(), shown = deferred<any>();
 let calls = 0;
 try {
  h.ctx.hasUI = true;
  mutateSettingsLayer({scope: "project", cwd: h.cwd, mutation: {op: "set", path: ["keybindings", "commands", "goal-direct"], value: "f8"}});
  h.ctx.ui.input = async () => {shown.resolve(null); return answer.promise;};
  h.core.invokeGoalCommand = async () => {calls++;};
  await h.start();
  h.input("\x1b[19~"); await shown.promise;
  assert.equal(h.core.goalModalDepth, 1);
  await h.event("session_start", {}, incoming.ctx);
  h.core.goalModalDepth = 1;
  const notices = h.notices.length;
  if (response === "error") answer.reject(new Error("old dialog failed"));
  else answer.resolve(response === "cancel" ? undefined : "Old topic");
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(calls, 0, "an old answer cannot invoke a command against replacement state");
  assert.equal(h.core.goalModalDepth, 1, "an old finally cannot release replacement ownership");
  assert.equal(h.notices.length, notices, "an old rejection cannot notify through the invalidated host");
 } finally {answer.resolve(undefined); await new Promise<void>(resolve => setImmediate(resolve)); await h.event("session_shutdown", {}, incoming.ctx); await h.cleanup(); await incoming.cleanup();}
});

test("a command shortcut releases its own modal when the command changes focus", async () => {
 const h = stabilizationHarness();
 const dispatched = deferred<any>();
 try {
  h.ctx.hasUI = true;
  mutateSettingsLayer({scope: "project", cwd: h.cwd, mutation: {op: "set", path: ["keybindings", "commands", "goal-direct"], value: "f8"}});
  h.ctx.ui.input = async () => "New topic";
  h.core.invokeGoalCommand = async () => {h.core.setFocusedGoalId(null, h.ctx, "selected"); dispatched.resolve(null);};
  await h.start(); h.input("\x1b[19~"); await dispatched.promise;
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(h.core.goalModalDepth, 0, "legitimate command focus changes still release their modal");
 } finally {await h.cleanup();}
});

test("audit approval cannot overwrite tasks changed by another writer", async () => {
 const pending = deferred<any>(), started = deferred<any>();
 const h = stabilizationHarness(async () => {started.resolve(null); return pending.promise;});
 try {
  await h.start(); const result = h.call("update_goal", {status: "complete"}); await started.promise;
  writeActiveGoalFile(h.ctx, {...h.core.state.goal!, revision: (h.core.state.goal?.revision ?? 0) + 1, taskList: {tasks: [{id: "new", title: "Unreviewed requirement", status: "pending"}], blockCompletion: true, proposedAt: new Date().toISOString()}});
  pending.resolve(approved);
  assert.match((await result).content[0].text, /changed during the audit/);
  assert.equal(h.core.state.goal?.status, "active");
  assert.match(h.disk(), /Unreviewed requirement/);
 } finally {pending.resolve(approved); await h.cleanup();}
});

test("failed audit ledger persistence is visible and cannot complete the goal", async () => {
 const pending = deferred<any>(), started = deferred<any>();
 const h = stabilizationHarness(async () => {started.resolve(null); return pending.promise;});
 try {
  await h.start(); const result = h.call("update_goal", {status: "complete"}); await started.promise;
  const ledger = path.join(h.cwd, ".pi/goals/goal_events.jsonl");
  rmSync(ledger); mkdirSync(ledger);
  pending.resolve(approved);
  const response = await result;
  assert.equal(response.isError, true);
  assert.match(response.content[0].text, /could not be persisted/);
  assert.equal(h.core.state.goal?.status, "active");
  assert.equal(h.core.activeAudit, null);
 } finally {pending.resolve(approved); await h.cleanup();}
});

test("late shutdown cannot evict a replacement prefix with the same cache identity", async () => {
 const h = stabilizationHarness(), incoming = stabilizationHarness();
 const base: any[] = [{role: "user", content: "stable history", timestamp: 1}];
 try {
  await h.start();
  await h.event("context_with_system", {messages: base});
  await h.event("session_start", {reason: "start"}, incoming.ctx);
  const first = (await h.event("context_with_system", {messages: base}, incoming.ctx)).messages;
  base.push({role: "assistant", content: [{type: "text", text: "progress"}], timestamp: 2});
  const advanced = (await h.event("context_with_system", {messages: base}, incoming.ctx)).messages;
  assert.deepEqual(advanced.slice(0, first.length), first);
  await h.event("session_shutdown", {}, h.ctx);
  assert.deepEqual((await h.event("context_with_system", {messages: base}, incoming.ctx)).messages, advanced);
  const unseenOldContext = {...h.ctx};
  assert.equal(await h.event("context_with_system", {messages: base}, unseenOldContext), undefined, "an unseen callback from the outgoing manager cannot use replacement state");
  const payload = {messages: [{role: "user", content: "old request"}]};
  assert.equal(await h.event("before_provider_request", {payload}, unseenOldContext), undefined);
  const invalidatedOldContext = new Proxy(unseenOldContext, {get(target, key) {return key === "sessionManager" ? stale() : Reflect.get(target, key);}});
  const replacementWidget = h.core.goalWidgetComponentRef.current;
  await h.event("session_shutdown", {}, invalidatedOldContext);
  assert.equal(h.core.goalWidgetComponentRef.current, replacementWidget);
  const stillLive = await h.event("context_with_system", {messages: base}, incoming.ctx);
  assert.ok(stillLive, "an unseen stale shutdown must leave replacement context live");
  assert.deepEqual(stillLive.messages, advanced);
 } finally {await h.event("session_shutdown", {}, incoming.ctx); await h.cleanup(); await incoming.cleanup();}
});

test("a long-running audit stays authoritative beyond the bounded recent-event window and cache reload", async () => {
 const h = stabilizationHarness();
 try {
  await h.start();
  const events: any[] = [
   {type: "audit_started", goalId: h.goal.id, auditId: "old", at: "2026-10-26T00:00:00Z"},
   {type: "audit_result", goalId: h.goal.id, auditId: "old", verdict: "approved", report: "old result", at: "2026-10-26T00:00:01Z"},
   {type: "audit_started", goalId: h.goal.id, auditId: "other-session", at: "2026-10-26T00:00:02Z"},
   {type: "audit_started", goalId: h.goal.id, auditId: "current", at: "2026-10-27T00:00:00Z"},
   ...Array.from({length: 20}, (_, n) => ({type: "task_complete", goalId: h.goal.id, taskId: `task-${n}`, at: "2026-10-27T00:00:01Z"})),
  ];
  h.core.goalService.appendEvents(h.ctx, events, {immediate: true});
  for (const reload of [false, true]) {
   if (reload) invalidateGoalLedgerCache();
   const bounded = goalRuntimeEvents(h.ctx, h.goal.id);
   assert.equal(latestAuditorResultForGoal(bounded, h.goal.id), undefined);
   assert.match(buildGoalHistoryBlock(h.goal, bounded), /no recorded result/i);
   assert.ok(bounded.length <= 16);
  }
  h.core.goalService.appendEvents(h.ctx, [{type: "audit_result", goalId: h.goal.id, auditId: "current", verdict: "approved", report: "current result", at: "2026-10-27T00:00:02Z"}, ...events.slice(-20)], {immediate: true});
  h.core.goalService.appendEvents(h.ctx, [{type: "audit_result", goalId: h.goal.id, auditId: "other-session", verdict: "error", report: "obsolete late failure", at: "2026-10-27T00:00:03Z"}], {immediate: true});
  invalidateGoalLedgerCache();
  assert.equal(latestAuditorResultForGoal(goalRuntimeEvents(h.ctx, h.goal.id), h.goal.id)?.report, "current result");
 } finally {await h.cleanup();}
});

test("fixed-seed lifecycle traces preserve project ownership, settlement and retry identity", async () => {
 const seed = 0x113115, trace: string[] = [], attempts: any[] = [];
 let random = seed;
 const choose = (size: number) => {random = (Math.imul(random, 1664525) + 1013904223) >>> 0; return random % size;};
 const h = stabilizationHarness(async args => {
  const pending = deferred<any>();
  const auditId = readGoalLedger(args.ctx).events.filter(e => e.type === "audit_started").at(-1)?.auditId;
  attempts.push({args, pending, auditId, done: false});
  return pending.promise;
 });
 const other = stabilizationHarness(), projects = [h, other];
 const history: any[][] = projects.map(() => [{role: "user", content: "trace history", timestamp: 1}]);
 let owner = 0;
 const check = () => {
  for (const project of projects) {
   assert.notEqual(parseGoalFile(path.join(project.cwd, project.goal.activePath!))?.status, "complete");
   for (const start of project.ledger().filter(e => e.type === "audit_started")) {
    const outcomes = project.ledger().filter(e => (e.type === "audit_result" || e.type === "audit_skipped") && e.auditId === start.auditId);
    assert.ok(outcomes.length <= 1, `duplicate outcome ${start.auditId}`);
    const running = attempts.find(a => !a.done && a.auditId === start.auditId && a.args.signal === h.core.activeAudit?.controller.signal && a.args.ctx === project.ctx);
    if (!running) assert.equal(outcomes.length, 1, "retired attempts settle before the next transition");
   }
  }
  if (!h.core.activeAudit) {
   assert.equal(h.core.auditAnimationTimer, null);
   assert.equal(h.core.auditProgress, null);
  }
  assert.equal(h.core.goalModalDepth, 0);
 };
 try {
  for (const [i, project] of projects.entries()) writeActiveGoalFile(project.ctx, {...project.goal, objective: `Independent project ${i}`});
  await h.start();
  for (let step = 0; step < 120; step++) {
   const action = choose(11), ctx = projects[owner]!.ctx;
   trace.push(`${step}:${owner}:${action}`);
   if (action === 0 || action === 1) {
    if (action === 0) owner = 1 - owner;
    await h.event(action === 0 ? "session_start" : "session_tree", {}, projects[owner]!.ctx);
   } else if (action === 2 && !h.core.activeAudit && h.core.state.goal?.status === "active") {
    const before = attempts.length;
    const promise = h.call("update_goal", {status: "complete"}, ctx);
    assert.equal(attempts.length, before + 1);
    attempts.at(-1).promise = promise;
   } else if (action === 3 || action === 4 || action === 5) {
    const pending = attempts.filter(a => !a.done);
    const attempt = pending[choose(pending.length)];
    if (attempt) {
     if (action === 4) attempt.pending.reject(new Error("trace auditor failure"));
     else {
      if (action === 5 && attempt.args.signal === h.core.activeAudit?.controller.signal) h.core.abortAudit(ctx);
      attempt.pending.resolve(attempt.args.signal.aborted ? {...approved, error: "Auditor aborted."} : {approved: false, output: "More verification needed."});
     }
     await attempt.promise; attempt.done = true;
    }
   } else if (action === 6) {
    h.core.setFocusedGoalId(null, ctx, "selected");
    h.core.setFocusedGoalId(projects[owner]!.goal.id, ctx, "selected");
   } else if (action === 7 && !h.core.activeAudit) {
    if (h.core.state.goal?.status === "active") h.core.pauseActiveGoal(ctx);
    else h.core.scheduler.resume(ctx);
   } else if (action === 8) {
    history[owner]!.push({role: "assistant", content: `Work ${step}`, timestamp: step + 2});
    const first = await h.event("context_with_system", {messages: history[owner]}, ctx);
    assert.deepEqual(await h.event("context_with_system", {messages: history[owner]}, ctx), first);
   } else if (action === 9 && h.core.state.goal) {
    const disk = projects[owner]!.disk(), state = structuredClone(h.core.state.goal);
    const rejected = await h.call("update_goal", {status: "complete", reason: "a real blocker"}, ctx);
    assert.equal(rejected.isError, true);
    assert.equal(projects[owner]!.disk(), disk);
    assert.deepEqual(h.core.state.goal, state);
   } else if (action === 10 && !h.core.activeAudit && h.core.state.goal?.status === "active") {
    await h.event("turn_start", {}, ctx);
    await h.call("set_goal_tasks", {tasks: [{id: "trace-task", title: "Verify trace work"}], block_completion: false}, ctx);
    await h.call("update_goal_task", {task_id: "trace-task", status: "complete", evidence: "trace verification"}, ctx);
    await h.event("turn_end", {message: {role: "assistant", stopReason: "stop"}}, ctx);
   }
   assert.equal(h.core.state.goal?.objective, `Independent project ${owner}`);
   check();
  }
  assert.ok(attempts.length >= 3, "the fixed seed must exercise multiple audits");
 } catch (error) {throw new Error(`Lifecycle seed ${seed}; trace ${trace.join(",")}`, {cause: error});}
 finally {
  await h.event("session_shutdown", {}, projects[owner]!.ctx);
  for (const attempt of attempts.filter(a => !a.done)) {attempt.pending.resolve(approved); await attempt.promise; attempt.done = true;}
  try {check();} finally {await h.cleanup(); await other.cleanup();}
 }
});
