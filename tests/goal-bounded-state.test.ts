import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createGoal, type GoalTask } from "../extensions/goal-record.ts";
import { goalDetailPage } from "../extensions/goal-detail.ts";
import { goalPrompt, taskListBlock } from "../extensions/prompts/goal-prompts.ts";
import { taskIndex } from "../extensions/goal-task-index.ts";
import { deriveGoalDashboardModel } from "../extensions/widgets/goal-dashboard-model.ts";
import { deriveGoalActivity } from "../extensions/goal-activity.ts";
import { appendGoalEvents, appendGoalEvent, readGoalLedger, goalActivityEvents, goalOracleState, invalidateGoalLedgerCache, loadLedgerState, LEDGER_CHECKPOINT_FILE, type GoalLedgerEvent } from "../extensions/goal-ledger.ts";
import { writeActiveGoalFile, parseGoalFile, serializeGoalFile } from "../extensions/storage/goal-files.ts";
// @ts-expect-error Shared JavaScript benchmark harness has no declaration file.
import { createHarness, startHarness, focusedFixture } from "../experiments/bench/bench-common.mjs";

const tasks: GoalTask[] = [{id: "parent", title: "Parent", status: "pending", subtasks: [{id: "child", title: "Child", status: "pending", verificationContract: "Prove the child"}]}, {id: "next", title: "Next", status: "pending"}];
async function fixture() {
	const f = focusedFixture();
	const goal = writeActiveGoalFile({cwd: f.cwd}, {...f.goal, taskList: {tasks: structuredClone(tasks), blockCompletion: true, proposedAt: "2026-09-07T00:00:00Z"}});
	const h = createHarness({cwd: f.cwd, sessionEntries: f.sessionEntries}); await startHarness(h);
	return {...f, goal, h, update: (input: unknown) => h.tools.get("update_goal_task").execute("test", input, new AbortController().signal, undefined, h.ctx)};
}

test("detail pagination is lossless, Unicode-safe, bounded, and rejects changed-source cursors", () => {
	const goal = createGoal({objective: "a".repeat(3999)+"🧪"+"b".repeat(6200), autoContinue: true, sisyphus: false});
	goal.verificationContract = "C".repeat(4500);
	let cursor: string | undefined; let text = ""; let firstCursor: string | undefined;
	do {
		const page = goalDetailPage(goal, {section: "objective", cursor}); assert.ok(page.ok);
		assert.ok(page.content.length <= 4000); assert.ok(!/[\uD800-\uDBFF]$/.test(page.content));
		text += page.content; cursor = page.nextCursor; firstCursor ??= cursor;
	} while(cursor);
	assert.equal(text, `${goal.objective}\n\nVerification contract:\n${goal.verificationContract}`);
	assert.equal(goalDetailPage({...goal, objective: goal.objective+"changed"}, {section: "objective", cursor: firstCursor}).ok, false);
	assert.equal(goalDetailPage({...goal, id: "another-goal"}, {section: "objective", cursor: firstCursor}).ok, false);
	assert.equal(goalDetailPage(goal, {section: "tasks", cursor: firstCursor}).ok, false);
	assert.equal(goalDetailPage(goal, {section: "objective", cursor: "bad"}).ok, false);
});

test("get_goal exposes full task evidence through bounded sections and keeps legacy forms", async () => {
	const f = await fixture(); try {
		const get = (input: unknown) => f.h.tools.get("get_goal").execute("get", input, undefined, undefined, f.h.ctx);
		const child = await get({section: "tasks", task_id: "child"}); assert.match(child.content[0].text, /Prove the child/);
		assert.match((await get({section: "tasks", task_id: "missing"})).content[0].text, /not found/);
		assert.match((await get({verbose: true})).content[0].text, /Lifecycle:/);
		assert.match((await get({include_history: true})).content[0].text, /Goal/);
	} finally {f.cleanup();}
});

test("ordered batch completes child then parent and starts the next task in one mutation", async () => {
	const f = await fixture(); try {
		const before = parseGoalFile(path.join(f.cwd,f.goal.activePath))!;
		const result = await f.update({updates: [{task_id: "child", status: "complete", evidence: "Verified the artifact"}, {task_id: "parent", status: "complete"}, {task_id: "next", status: "start"}]});
		assert.match(result.content[0].text, /parent complete/);
		const disk = parseGoalFile(path.join(f.cwd,f.goal.activePath))!;
		assert.equal(disk.currentTaskId, "next"); assert.equal(disk.taskList!.tasks[0]!.status, "complete");
		assert.equal(disk.revision, (before.revision ?? 0)+1);
		assert.deepEqual(readGoalLedger(f.h.ctx).events.filter(e=>e.type.startsWith("task_")).map(e=>e.type), ["task_complete","task_complete","task_started"]);
	} finally {f.cleanup();}
});

test("invalid batches reject all changes, including mixed forms and missing evidence", async () => {
	const f=await fixture(); try {
		const disk=()=>readFileSync(path.join(f.cwd,f.goal.activePath),"utf8"); const before=disk();
		for(const updates of [
			[{task_id:"next",status:"start"},{task_id:"parent",status:"complete"}],
			[{task_id:"next",status:"start"},{task_id:"child",status:"complete"}],
			[{task_id:"next",status:"start"},{task_id:"missing",status:"complete"}],
			]) { await f.update({updates}); assert.equal(disk(),before); }
		assert.match((await f.update({task_id:"parent",status:"start",updates:[{task_id:"next",status:"start"}]})).content[0].text,/conflict/);
		assert.equal(readGoalLedger(f.h.ctx).events.filter(e=>e.type.startsWith("task_")).length,0);
	} finally {f.cleanup();}
});

test("batch validates a fresh disk tree under the mutation lock", async () => {
	const f = await fixture(); try {
		const external = structuredClone(f.goal);
		external.taskList!.tasks[0]!.subtasks![0]!.verificationContract = "New externally edited contract";
		external.taskList!.tasks[0]!.title = "Externally edited parent title";
		writeFileSync(path.join(f.cwd, external.activePath!), serializeGoalFile(external));
		await f.update({updates: [{task_id: "child", status: "start"}]});
		const disk = parseGoalFile(path.join(f.cwd, external.activePath!))!;
		assert.equal(disk.taskList!.tasks[0]!.title, external.taskList!.tasks[0]!.title);
		assert.equal(disk.taskList!.tasks[0]!.subtasks![0]!.verificationContract, "New externally edited contract");
	} finally {f.cleanup();}
});

test("buffered batch detects a competing writer at flush and cannot overwrite its objective", async () => {
	const f=await fixture(); try {
		await f.h.handlers.get("turn_start")({},f.h.ctx);
		await f.update({updates:[{task_id:"child",status:"complete",evidence:"verified"}]});
		const foreign=writeActiveGoalFile(f.h.ctx,{...f.goal, objective:"External writer wins", revision:(f.goal.revision??0)+1});
		const result=await f.h.tools.get("update_goal").execute("finish",{status:"complete"},undefined,undefined,f.h.ctx);
		assert.match(result.content[0].text,/changed in another process/);
		const disk=parseGoalFile(path.join(f.cwd,foreign.activePath!))!;
		assert.equal(disk.objective,"External writer wins"); assert.equal(disk.taskList!.tasks[0]!.subtasks![0]!.status,"pending");
		assert.equal(readGoalLedger(f.h.ctx).events.some(e=>e.type==="task_complete"),false);
	} finally {f.cleanup();}
});

test("indexed activity matches append-order deduplication with out-of-order and equal timestamps", () => {
	const f=focusedFixture(); try {
		const events: GoalLedgerEvent[]=[
		{type:"goal_resumed",goalId:f.goal.id,reason:"resume",at:"2026-09-03"},
		{type:"goal_paused",goalId:f.goal.id,reason:"wait",at:"2026-09-05"},
		{type:"goal_resumed",goalId:f.goal.id,reason:"resume",at:"2026-09-02"},
		{type:"goal_resumed",goalId:f.goal.id,reason:"resume",at:"2026-09-06"},
		{type:"task_complete",goalId:f.goal.id,taskId:"a",at:"2026-09-05"},
		];
		appendGoalEvents(f,events);
		assert.deepEqual(deriveGoalActivity(goalActivityEvents(f,f.goal.id),f.goal.id),deriveGoalActivity(events,f.goal.id));
		invalidateGoalLedgerCache();
		assert.deepEqual(deriveGoalActivity(goalActivityEvents(f,f.goal.id),f.goal.id),deriveGoalActivity(events,f.goal.id));
	} finally {f.cleanup();}
});

test("long ledger projections stay bounded, preserve older Oracle state, and recover corrupt checkpoints", () => {
	const f=focusedFixture(); try {
		const events: GoalLedgerEvent[]=[{type:"oracle_failed",goalId:f.goal.id,fingerprint:"same",attempt:1,errorCode:"provider",message:"offline",at:"2026-09-01"}];
		for(let i=0;i<1000;i++)events.push({type:"task_complete",goalId:f.goal.id,taskId:`t${i}`,at:`2026-09-${String(i%28+1).padStart(2,"0")}`});
		appendGoalEvents(f,events);
		assert.ok(goalActivityEvents(f,f.goal.id).length<=64);
		assert.equal(goalOracleState(f,f.goal.id,"same").failedAttempts,1);
		const expected=deriveGoalActivity(events,f.goal.id);
		assert.deepEqual(deriveGoalActivity(goalActivityEvents(f,f.goal.id),f.goal.id),expected);
		writeFileSync(path.join(f.cwd,".pi/goals",LEDGER_CHECKPOINT_FILE),'{"version":2,"runtimeIndex":false}'); invalidateGoalLedgerCache();
		assert.deepEqual(deriveGoalActivity(goalActivityEvents(f,f.goal.id),f.goal.id),expected);
		assert.equal(readGoalLedger(f).events.length,events.length);
	} finally {f.cleanup();}
});

test("Unicode ledger offsets and first warm append are counted exactly once", () => {
	const f=focusedFixture(); try {
		readGoalLedger(f);
		appendGoalEvent(f,{type:"goal_created",goalId:f.goal.id,objective:"日本語 🧪",sisyphus:false,autoContinue:true,at:"2026-09-01"});
		const cp=JSON.parse(readFileSync(path.join(f.cwd,".pi/goals",LEDGER_CHECKPOINT_FILE),"utf8"));
		assert.equal(cp.coveredEvents,1);
		assert.equal(cp.coveredBytes,readFileSync(path.join(f.cwd,".pi/goals/goal_events.jsonl")).length);
		appendGoalEvent(f,{type:"goal_paused",goalId:f.goal.id,reason:"é",at:"2026-09-02"});
		invalidateGoalLedgerCache(); const state=loadLedgerState(f);
		assert.equal(state.coveredEvents,2); assert.equal(state.state.goals.get(f.goal.id)?.latestPauseReason,"é");
	} finally {f.cleanup();}
});

test("compact context preserves critical rules and exposes omitted task descendants", () => {
	const goal=createGoal({objective:"Objective "+"x".repeat(20000),autoContinue:true,sisyphus:true});
	goal.taskList={tasks:structuredClone(tasks),blockCompletion:true,proposedAt:"2026-09-01"};
	goal.currentTaskId="parent"; goal.verificationContract="contract "+"y".repeat(20000);
	const prompt=goalPrompt(goal);
	assert.ok(prompt.length<10_000, "the injected goal prompt stays under 10,000 characters");
	for(const rule of [/three consecutive goal turns/,/status: "paused"/,/independent completion auditor/,/TASK GATE/,/get_goal\(section="objective"\)/,/Follow the user's ordered plan faithfully/])assert.match(prompt,rule);
	assert.match(taskListBlock(goal),/child/); assert.equal((taskListBlock(goal).match(/Current: parent/g)??[]).length,1);
	goal.objective="Updated objective with same id/revision/time";
	assert.match(goalPrompt(goal),/Updated objective/);
});

test("task presentation reuses usage-only work but invalidates in-place content edits", () => {
	const goal=createGoal({objective:"Test",autoContinue:true,sisyphus:false});
	goal.taskList={tasks:structuredClone(tasks),blockCompletion:true,proposedAt:"2026-09-01"};
	const options={focused:true,otherOpenGoals:0};
	const first=deriveGoalDashboardModel(goal,options)!;
	goal.usage.tokensUsed=100;
	const second=deriveGoalDashboardModel(goal,options)!;
	assert.equal(first.taskTree,second.taskTree); assert.equal(second.usage.tokens,100);
	const old=taskIndex(goal.taskList.tasks);
	goal.taskList.tasks[0]!.title="Changed";
	assert.notEqual(taskIndex(goal.taskList.tasks),old); assert.equal(old.byId.get("parent")!.title,"Parent");
	assert.equal(deriveGoalDashboardModel(goal,options)!.taskTree[0]!.title,"Changed");
});
