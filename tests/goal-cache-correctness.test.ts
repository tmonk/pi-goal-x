import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { invalidateGoalSettingsCache } from "../extensions/settings/files.ts";
import { loadGoalSettings, loadSettingsSnapshot } from "../extensions/settings/resolve.ts";
import { mutateSettingsLayer } from "../extensions/settings/mutate.ts";
import { createGoal, type GoalTask } from "../extensions/goal-record.ts";
import { taskIndex } from "../extensions/goal-task-index.ts";
import { goalPrompt } from "../extensions/prompts/goal-prompts.ts";
import { goalDetailPage } from "../extensions/goal-detail.ts";
import { readGoalLedger, appendGoalEvents, invalidateGoalLedgerCache, loadLedgerState, LEDGER_CHECKPOINT_FILE, type GoalLedgerEvent } from "../extensions/goal-ledger.ts";
import { buildPostCompactionGoalDelta } from "../extensions/goal-compaction.ts";
import { recentNonEmptyLines } from "../extensions/goal-auditor.ts";
import { readActiveGoalPool, readActiveGoalPoolAsync, invalidateGoalPoolCache, writeActiveGoalFile, archiveGoalFile } from "../extensions/storage/goal-files.ts";
import { compactGoalCheckpointContext } from "../extensions/goal-events.ts";
import { inspectCheckpointHealth, readSessionCheckpointHealth } from "../extensions/goal-session-health.ts";
import { updateTaskInTree } from "../extensions/goal-policy.ts";
import { truncateToWidth, wrapTextWithAnsi } from "../extensions/widgets/text-cache.ts";
import { truncateToWidth as sdkTruncate, wrapTextWithAnsi as sdkWrap } from "@earendil-works/pi-tui";
import { tempDir } from "./support/fs.ts";

function fixture() {
	const cwd = tempDir("goal-comprehensive-test-");
	fs.mkdirSync(path.join(cwd, ".pi/goals"), {recursive:true});
	const goal = createGoal({objective:"Implement every requirement 🧭", autoContinue:true, sisyphus:false});
	return {cwd, goal, cleanup: () => fs.rmSync(cwd, {recursive:true, force:true})};
}

test("auditor stream tails match complete report processing, including blank lines and CRLF", () => {
	for (const text of ["", "\n", "one\n\n two \r\n\t\nthree\n", "🧭".repeat(10000), "line\n".repeat(10000)]) {
		for (const limit of [1,5,8]) assert.deepEqual(recentNonEmptyLines(text,limit),text.split("\n").filter(line=>line.trim()).slice(-limit));
	}
});

test("resolved settings invalidate on environment, layer mutations and explicit refresh; results remain caller-owned", () => {
	const f = fixture(); try {
		const env = {PI_GOAL_SETTINGS_FILE:path.join(f.cwd,"project.json"), PI_GOAL_GLOBAL_SETTINGS_FILE:path.join(f.cwd,"global.json"), PI_GOAL_DISABLE_TASKS:"false"};
		const first = loadGoalSettings(f.cwd, env); first.disableTasks = true; first.oracle!.enabled = true; first.keybindings!.dashboard.toggleExpand = "escape";
		assert.equal(loadGoalSettings(f.cwd, env).disableTasks, false);
		assert.equal(loadGoalSettings(f.cwd, env).oracle!.enabled, false);
		assert.notEqual(loadGoalSettings(f.cwd, env).keybindings!.dashboard.toggleExpand, "escape");
		env.PI_GOAL_DISABLE_TASKS = "true";
		assert.equal(loadGoalSettings(f.cwd, env).disableTasks, true);
		const snapshot = loadSettingsSnapshot(f.cwd, env); snapshot.provenance.get("disableTasks")!.source = "default"; snapshot.provenance.clear();
		assert.equal(loadSettingsSnapshot(f.cwd, env).provenance.get("disableTasks")!.source, "environment");
		mutateSettingsLayer({cwd:f.cwd, scope:"project", env, mutation:{op:"set",path:["hideUnfocusedBanner"],value:true}});
		assert.equal(loadGoalSettings(f.cwd, env).hideUnfocusedBanner, true);
		fs.writeFileSync(env.PI_GOAL_SETTINGS_FILE, JSON.stringify({hideUnfocusedBanner:false}));
		invalidateGoalSettingsCache(); assert.equal(loadGoalSettings(f.cwd, env).hideUnfocusedBanner, false);
	} finally {f.cleanup(); invalidateGoalSettingsCache();}
});

test("task and prompt caches observe nested edits, reparenting, focus and settings without retaining mutable inputs", () => {
	const f = fixture(); try {
		const tasks: GoalTask[] = [{id:"p", title:"Parent", status:"pending", subtasks:[{id:"c", title:"Child", status:"pending", verificationContract:"Original contract"}]}, {id:"n",title:"Next",status:"pending"}];
		const goal = {...f.goal, taskList:{tasks,blockCompletion:true,proposedAt:"today"}, currentTaskId:"c"};
		const old = taskIndex(tasks); const original = goalPrompt(goal);
		const child = tasks[0]!.subtasks![0]!;
		child.verificationContract = "Revised contract"; child.evidence = "Full evidence 🧭";
		assert.notEqual(taskIndex(tasks), old); assert.equal(old.byId.get("c")!.verificationContract, "Original contract");
		assert.match(goalPrompt(goal), /Revised contract/); assert.notEqual(goalPrompt(goal),original);
		child.status = "complete"; tasks[0]!.subtasks = []; tasks[1]!.subtasks = [child];
		assert.equal(taskIndex(tasks).ordered.find(row => row.task.id === "c")!.parentId, "n");
		goal.currentTaskId = "n"; assert.match(goalPrompt(goal), /Current: n/);
		assert.doesNotMatch(goalPrompt(goal,{disableTasks:true}), /TASK LIST/);
		const copy = structuredClone(tasks); assert.equal(taskIndex(copy), taskIndex(tasks));
	} finally {f.cleanup();}
});

test("cached history pages remain lossless and reject stale cursors after append or external refresh", () => {
	const f = fixture(); try {
		const events: GoalLedgerEvent[] = Array.from({length:80}, (_,i) => ({type:"task_complete",goalId:f.goal.id,taskId:`t${i}`,evidence:"🧭".repeat(100),at:"2026-09-07"}));
		appendGoalEvents(f,events);
		const read = readGoalLedger(f); const first = goalDetailPage(f.goal,{section:"history"},read.events,read.revision); assert.ok(first.ok && first.nextCursor);
		let cursor: string | undefined; let content = "";
		do { const page = goalDetailPage(f.goal,{section:"history",cursor},read.events,read.revision); assert.ok(page.ok); content += page.content; cursor = page.nextCursor; } while (cursor);
		assert.equal(content, events.map(e=>JSON.stringify(e)).join("\n"));
		appendGoalEvents(f,[{...events[0]!,taskId:"new"} as GoalLedgerEvent]);
		const appended = readGoalLedger(f); assert.notEqual(appended.revision,read.revision);
		assert.equal(goalDetailPage(f.goal,{section:"history",cursor:first.nextCursor},appended.events,appended.revision).ok,false);
		fs.writeFileSync(path.join(f.cwd,".pi/goals/goal_events.jsonl"),JSON.stringify(events[0])+"\n"); invalidateGoalLedgerCache();
		const refreshed = readGoalLedger(f); assert.equal(goalDetailPage(f.goal,{section:"history",cursor:first.nextCursor},refreshed.events,refreshed.revision).ok,false);
		const ownEvents = structuredClone(events); const ownPage = goalDetailPage(f.goal,{section:"history"},ownEvents); assert.ok(ownPage.ok);
		ownEvents.pop(); assert.equal(goalDetailPage(f.goal,{section:"history",cursor:ownPage.nextCursor},ownEvents).ok,false);
	} finally {f.cleanup();invalidateGoalLedgerCache();}
});

test("ledger sanitation remains correct beyond the bounded goal-ID intern cache", () => {
	const f=fixture(); try {
		const events=Array.from({length:1100},(_,i)=>({type:"goal_paused",goalId:`goal/${i}`,reason:"Keep full Unicode evidence 🧭",at:"2026-09-07"}));
		events.push({...events[0]!}, {...events[1099]!});
		fs.writeFileSync(path.join(f.cwd,".pi/goals/goal_events.jsonl"),events.map(e=>JSON.stringify(e)).join("\n")); invalidateGoalLedgerCache();
		const result=readGoalLedger(f); assert.equal(result.malformed,0); assert.equal(result.events.length,1102);
		for (let i=0;i<result.events.length;i++) {
			const event=result.events[i]!; assert.ok(event.type==="goal_paused");
			assert.equal(event.goalId,events[i]!.goalId.replace("/","_")); assert.equal(event.reason,events[i]!.reason);
		}
	} finally {f.cleanup();invalidateGoalLedgerCache();}
});

test("text caches preserve SDK ANSI, Unicode, padding and width semantics and return independent wrapped rows", () => {
	for (const text of ["plain words", "á 🧭 中文 👩‍💻", "\x1b[31mred\x1b[0m normal\nnext", "\x1b]8;;https://example.com\x07linked\x1b]8;;\x07", ""]) {
		for (const width of [0,1,4,10,80]) {
			for (const pad of [false,true]) for (const ellipsis of ["...","…",""]) assert.equal(truncateToWidth(text,width,ellipsis,pad),sdkTruncate(text,width,ellipsis,pad));
			const rows = wrapTextWithAnsi(text,width); assert.deepEqual(rows,sdkWrap(text,width)); rows.push("poison"); assert.deepEqual(wrapTextWithAnsi(text,width),sdkWrap(text,width));
		}
	}
});

test("context normalization preserves all marker positions and ignores mutable goal state", () => {
	const f=fixture(); try {
		const marker = {customType:"pi-goal-event",content:"legacy",details:{goalId:f.goal.id,kind:"checkpoint",version:1}};
		const a={role:"user",content:"a"}; const b={role:"assistant",content:"b"}; const c={role:"toolResult",content:"c"};
		const result=compactGoalCheckpointContext([a,marker,b,marker,c],f.goal)!;
		assert.equal(result.length,5); assert.equal(result[0],a); assert.equal(result[2],b); assert.equal(result[4],c);
		assert.equal((result[1] as {details:{kind:string}}).details.kind,"checkpoint");
		assert.equal((compactGoalCheckpointContext([marker],null)![0] as {details:{kind:string}}).details.kind,"checkpoint");
		assert.equal(compactGoalCheckpointContext([a,b,c],null),null);
	} finally {f.cleanup();}
});

test("cold pool results do not expose the cached Map and archive updates remove timestamped paths from snapshots", async () => {
	const f=fixture(); try {
		const goal=writeActiveGoalFile(f,f.goal); invalidateGoalPoolCache();
		readActiveGoalPool(f).clear(); assert.equal(readActiveGoalPool(f).size,1);
		invalidateGoalPoolCache(); (await readActiveGoalPoolAsync(f)).clear(); assert.equal(readActiveGoalPool(f).size,1);
		archiveGoalFile(f,goal);
		const snapshot=JSON.parse(fs.readFileSync(path.join(f.cwd,".pi/.goals-pool-snapshot.json"),"utf8")); assert.deepEqual(snapshot.goals,[]);
	} finally {f.cleanup();invalidateGoalPoolCache();}
});

test("streamed diagnostic accumulation matches parsed entries despite Unicode and malformed lines", () => {
	const f=fixture(); try {
		const entries=[{type:"message",message:{content:"ordinary 🧭"}}, {type:"custom_message",customType:"pi-goal-event",content:"🧭".repeat(4000),details:{version:1}}];
		const file=path.join(f.cwd,"session.jsonl"); fs.writeFileSync(file,entries.map(e=>JSON.stringify(e)).join("\nBAD JSON\n")+"\n\n");
		assert.deepEqual(readSessionCheckpointHealth(file),inspectCheckpointHealth(entries));
	} finally {f.cleanup();}
});

test("task updates copy only changed ancestors and leave unrelated branches and the original intact", () => {
	const tasks: GoalTask[]=[{id:"p",title:"Parent",status:"pending",subtasks:[{id:"c",title:"Child",status:"pending"}]},{id:"n",title:"Next",status:"pending",subtasks:[]}];
	const next=updateTaskInTree(tasks,"c",task=>({...task,status:"complete",evidence:"Verified"}));
	assert.equal(tasks[0]!.subtasks![0]!.status,"pending"); assert.equal(next[0]!.subtasks![0]!.status,"complete"); assert.equal(next[1],tasks[1]);
	assert.equal(updateTaskInTree(next,"missing",task=>task),next);
});

test("Oracle state survives checkpoint reload and corrupt derived state rebuilds from the ledger", () => {
	const f=fixture(); try {
		appendGoalEvents(f,[{type:"goal_created",goalId:f.goal.id,objective:f.goal.objective,sisyphus:false,autoContinue:true,at:"2026-09-07"}, {type:"oracle_result",goalId:f.goal.id,fingerprint:"fp",adviceId:"advice",disposition:"actionable",summary:"Try the verified alternative 🧭",at:"2026-09-07"}]);
		invalidateGoalLedgerCache(); const full=loadLedgerState(f);
		invalidateGoalLedgerCache(); const cached=loadLedgerState(f);
		assert.equal(cached.source,"checkpoint");
		assert.deepEqual(cached.state.goals.get(f.goal.id)!.latestOracleResult,full.state.goals.get(f.goal.id)!.latestOracleResult);
		const file=path.join(f.cwd,".pi/goals",LEDGER_CHECKPOINT_FILE);
		const valid=JSON.parse(fs.readFileSync(file,"utf8"));
		for (const damage of [(copy: typeof valid) => {copy.acc.goals[0].latestOracleResult.disposition="invalid";}, (copy: typeof valid) => {copy.runtimeIndex[0][1].oracle[0][1].result.summary=null;}, (copy: typeof valid) => {delete copy.acc.goals;}]) {
			const copy=structuredClone(valid); damage(copy); fs.writeFileSync(file,JSON.stringify(copy)); invalidateGoalLedgerCache();
			const rebuilt=loadLedgerState(f); assert.equal(rebuilt.source,"full"); assert.deepEqual(rebuilt.state.goals.get(f.goal.id)!.latestOracleResult,full.state.goals.get(f.goal.id)!.latestOracleResult);
		}
	} finally {f.cleanup();invalidateGoalLedgerCache();}
});

test("compaction resync bounds oversized task text and points to lossless requirements", () => {
	const f=fixture(); try {
		const goal={...f.goal,currentTaskId:"task",taskList:{tasks:[{id:"task",title:"Long title ".repeat(1000),status:"pending" as const,verificationContract:"Verify 🧭 ".repeat(10000)}],proposedAt:"today",blockCompletion:true}};
		const delta=buildPostCompactionGoalDelta({goal,ledgerEvents:[],otherOpenCount:0});
		assert.ok(delta.length<1500); assert.match(delta,/get_goal\(section="tasks"\)/);
		const detail=goalDetailPage(goal,{section:"tasks",task_id:"task"}); assert.ok(detail.ok && detail.nextCursor && detail.totalChars>goal.taskList.tasks[0]!.verificationContract.length);
	} finally {f.cleanup();}
});

test("post-compaction delta carries the evidence of recently completed tasks, newest first and bounded", () => {
	const goal = createGoal({ objective: "Ship it", autoContinue: true, sisyphus: false });
	const tasks = Array.from({ length: 8 }, (_, i) => ({ id: `t${i}`, title: `Task ${i}`, status: "complete" as const, completedAt: `2026-11-26T10:0${i}:00.000Z`, evidence: `Ran suite ${i}: green. ${"x".repeat(i === 7 ? 400 : 0)}` }));
	tasks.push({ id: "pending-one", title: "Later", status: "pending" as never, completedAt: undefined as never, evidence: undefined as never });
	goal.taskList = { tasks, blockCompletion: false, proposedAt: "2026-11-26T09:00:00.000Z" };
	const delta = buildPostCompactionGoalDelta({ goal, ledgerEvents: [], otherOpenCount: 0 });
	assert.match(delta, /Recently completed, with the evidence recorded:/);
	assert.ok(delta.indexOf("t7:") < delta.indexOf("t6:"), "newest first");
	assert.doesNotMatch(delta, /t2:/, "only five");
	assert.doesNotMatch(delta, /pending-one/);
	assert.ok(!delta.includes("x".repeat(250)), "evidence is cut");
});
