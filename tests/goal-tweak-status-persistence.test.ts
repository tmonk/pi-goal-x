/**
 * End-to-end regression coverage for /goal-tweak status persistence
 * (specs/2026-08-08-tweak-status-persistence, R1 / success criterion 3):
 * a completed task's status/evidence/completedAt must survive a task-list
 * tweak through the full draft → confirm → apply → disk → reload flow; a
 * tweak without a task list retains the current list unchanged; nested
 * subtask completion survives; currentTaskId survives only while its task
 * stays pending.
 */

import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import goalExtension from "../extensions/goal.ts";
import type { GoalCore } from "../extensions/goal-state.ts";
import { newGoalScheduler } from "../extensions/goal-scheduler-state.ts";
import { writeActiveGoalFile, parseGoalFile } from "../extensions/storage/goal-files.ts";
import { readGoalLedger } from "../extensions/goal-ledger.ts";
import { countTasks } from "../extensions/goal-task-tools.ts";

interface Harness {
	core: GoalCore;
	ctx: ExtensionContext;
	commands: Map<string, any>;
	tools: Map<string, any>;
	dialogResult(result: unknown): void;
	hasDialog: () => boolean;
	sessionStart(): Promise<void>;
}

function createHarness(cwd: string): Harness {
	const handlers = new Map<string, Function>();
	const commands = new Map<string, any>();
	const tools = new Map<string, any>();
	let activeTools = ["read", "bash", "edit", "write"];
	let dialogResolve: ((result: any) => void) | null = null;
	let hasDialogPending = false;
	const pi = {
		registerTool: (def: any) => { tools.set(def.name, def); },
		registerCommand: (name: string, def: any) => { commands.set(name, def); },
		on: (event: string, handler: Function) => { handlers.set(event, handler); },
		appendEntry: () => {},
		registerMessageRenderer: () => {},
		sendUserMessage: () => {},
		sendMessage: () => {},
		getActiveTools: () => [...activeTools],
		setActiveTools: (names: string[]) => { activeTools = [...names]; },
		hasUI: true,
	};
	const ctx = {
		cwd,
		hasUI: true,
		sessionManager: {
			getBranch: () => [],
			getCwd: () => cwd,
			getSessionId: () => "tweak-status-session",
			getRoot: () => cwd,
		},
		ui: {
			notify: () => {},
			setStatus: () => {},
			setWidget: () => {},
			onTerminalInput: () => () => {},
			select: async () => undefined,
			confirm: async () => false,
			custom: async () => new Promise((resolve) => { dialogResolve = resolve; hasDialogPending = true; }),
		},
		getSystemPrompt: () => "base",
		isIdle: () => true,
		hasPendingMessages: () => false,
		abort: () => {},
	} as unknown as ExtensionContext;
	goalExtension(pi as any, {});
	return {
		core: (pi as any)._goalCore,
		ctx,
		commands,
		tools,
		dialogResult: (result: unknown) => { hasDialogPending = false; dialogResolve?.(result); },
		hasDialog: () => hasDialogPending,
		sessionStart: async () => { await handlers.get("session_start")?.({ reason: "start" }, ctx); },
	};
}

const CONFIRM_ANSWER = "Confirm — create this goal now";

function activeGoalFiles(cwd: string): string[] {
	try {
		return readdirSync(path.join(cwd, ".pi", "goals")).filter((n) => n.startsWith("active_goal_"));
	} catch {
		return [];
	}
}

function diskGoal(cwd: string) {
	const files = activeGoalFiles(cwd);
	assert.equal(files.length, 1, "exactly one active goal expected");
	return parseGoalFile(path.join(cwd, ".pi", "goals", files[0]!))!;
}

function proposalParams(objective: string, extra: Record<string, unknown> = {}) {
	return { objective, sisyphus: false, ...extra };
}

async function runProposal(h: Harness, params: Record<string, unknown>): Promise<any> {
	const proposal = h.tools.get("propose_goal_draft");
	assert.ok(proposal, "propose_goal_draft must be registered during a draft");
	return proposal.execute("draft-1", params, new AbortController().signal, undefined, h.ctx);
}

async function confirmDialog(h: Harness, pending: Promise<any>): Promise<void> {
	assert.ok(h.hasDialog(), "confirmation dialog must open");
	h.dialogResult({ questions: [], answers: [{ id: "confirm", question: "Confirm Goal Draft", answer: CONFIRM_ANSWER, wasCustom: false }], cancelled: false });
	await pending;
}

async function callTaskTool(h: Harness, name: string, params: Record<string, unknown>): Promise<any> {
	const tool = h.tools.get(name);
	assert.ok(tool, `${name} must be registered`);
	return (tool.execute as any)(`call-${name}`, params, new AbortController().signal, undefined, h.ctx);
}

async function createGoalWithTasks(h: Harness, objective: string, tasks: Array<Record<string, unknown>>): Promise<void> {
	await h.commands.get("goal")!.handler(objective, h.ctx);
	await confirmDialog(h, runProposal(h, proposalParams(objective + "\nSuccess criteria: tests pass.", { tasks })));
	const goal = diskGoal(h.ctx.cwd);
	assert.ok(goal.taskList && countTasks(goal.taskList.tasks) === tasks.length, "goal created with the proposed task tree");
}

function newTmpDir(name: string): string {
	const cwd = mkdtempSync(path.join(tmpdir(), name));
	mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
	return cwd;
}

// ── R1: status/evidence/timestamps survive a task-list tweak (disk round-trip) ─

test("e2e: completed task status, evidence, and completedAt survive a task-list tweak through disk reload", async () => {
	const cwd = newTmpDir("tweak-status-complete-");
	try {
		const h = createHarness(cwd);
		await h.sessionStart();
		await createGoalWithTasks(h, "Initial objective", [
			{ id: "a", title: "Task A" },
			{ id: "b", title: "Task B" },
		]);

		// Complete task a via the real flow (with evidence), then start b.
		const complete = await callTaskTool(h, "update_goal_task", { task_id: "a", status: "complete", evidence: "verified-e2e" });
		assert.ok(JSON.stringify(complete.content).includes("a"), "complete result mentions the task");
		await callTaskTool(h, "update_goal_task", { task_id: "b", status: "start" });
		assert.equal(diskGoal(cwd).currentTaskId, "b", "currentTaskId set before the tweak");

		// Tweak: same ids + a new task c. The merge must keep a complete.
		await h.commands.get("goal-tweak")!.handler("Revise the plan", h.ctx);
		await confirmDialog(h, runProposal(h, proposalParams("Revised objective", {
			tasks: [
				{ id: "a", title: "Task A (retitled)" },
				{ id: "b", title: "Task B" },
				{ id: "c", title: "Task C" },
			],
		})));

		// Reload the persisted goal from disk.
		const goal = diskGoal(cwd);
		assert.ok(goal.objective.includes("Revised objective"), "objective updated by the tweak");
		const a = goal.taskList!.tasks.find((t) => t.id === "a")!;
		assert.equal(a.status, "complete", "completed status survives the tweak");
		assert.equal(a.evidence, "verified-e2e", "evidence survives the tweak");
		assert.ok(a.completedAt, "completedAt timestamp survives the tweak");
		assert.equal(a.title, "Task A (retitled)", "structural title comes from the incoming proposal");
		assert.equal(goal.taskList!.tasks.find((t) => t.id === "c")!.status, "pending", "new id starts pending");
		assert.equal(goal.taskList!.tasks.find((t) => t.id === "b")!.status, "pending", "pending task stays pending");
		assert.equal(goal.currentTaskId, "b", "currentTaskId survives while its task is still pending");
		assert.ok(readGoalLedger({ cwd }).events.some((e) => e.type === "task_list_set"), "task_list_set ledger event on the tweak");
	} finally {
		try { rmSync(cwd, { recursive: true, force: true }); } catch {}
	}
});

test("e2e: a tweak without a task list retains the current list unchanged (statuses included)", async () => {
	const cwd = newTmpDir("tweak-status-retain-");
	try {
		const h = createHarness(cwd);
		await h.sessionStart();
		await createGoalWithTasks(h, "Initial objective", [
			{ id: "a", title: "Task A" },
			{ id: "b", title: "Task B" },
		]);
		await callTaskTool(h, "update_goal_task", { task_id: "a", status: "complete", evidence: "kept" });
		await callTaskTool(h, "update_goal_task", { task_id: "b", status: "skipped", reason: "user direction" });

		// Tweak WITHOUT tasks in the proposal: the current list must be retained unchanged.
		await h.commands.get("goal-tweak")!.handler("Tighten the wording", h.ctx);
		await confirmDialog(h, runProposal(h, proposalParams("Tightened objective wording")));

		const goal = diskGoal(cwd);
		assert.ok(goal.objective.includes("Tightened"), "objective updated");
		const a = goal.taskList!.tasks.find((t) => t.id === "a")!;
		const b = goal.taskList!.tasks.find((t) => t.id === "b")!;
		assert.equal(a.status, "complete", "completed status retained without a task proposal");
		assert.equal(a.evidence, "kept", "evidence retained");
		assert.ok(a.completedAt, "completedAt retained");
		assert.equal(b.status, "skipped", "skipped status retained");
		assert.equal(b.skipReason, "user direction", "skip reason retained");
		assert.ok(b.skippedAt, "skippedAt retained");
		assert.equal(goal.taskList!.tasks.length, 2, "no tasks added or removed");
	} finally {
		try { rmSync(cwd, { recursive: true, force: true }); } catch {}
	}
});

test("e2e: subtask completion status survives a task-list tweak", async () => {
	const cwd = newTmpDir("tweak-status-subtask-");
	try {
		const h = createHarness(cwd);
		await h.sessionStart();
		await createGoalWithTasks(h, "Initial objective", [
			{ id: "p", title: "Parent" },
			{ id: "p1", title: "Child one", parent_id: "p" },
		]);
		await callTaskTool(h, "update_goal_task", { task_id: "p1", status: "complete", evidence: "child-done" });

		// Tweak proposing the same parent/subtask structure.
		await h.commands.get("goal-tweak")!.handler("Revise", h.ctx);
		await confirmDialog(h, runProposal(h, proposalParams("Revised objective", {
			tasks: [
				{ id: "p", title: "Parent" },
				{ id: "p1", title: "Child one (renamed)", parent_id: "p" },
			],
		})));

		const goal = diskGoal(cwd);
		const p1 = goal.taskList!.tasks.find((t) => t.id === "p")!.subtasks!.find((t) => t.id === "p1")!;
		assert.equal(p1.status, "complete", "subtask completion survives the tweak");
		assert.equal(p1.evidence, "child-done", "subtask evidence survives");
		assert.ok(p1.completedAt, "subtask completedAt survives");
		assert.equal(p1.title, "Child one (renamed)", "structural subtask title comes from the proposal");
	} finally {
		try { rmSync(cwd, { recursive: true, force: true }); } catch {}
	}
});

test("e2e: currentTaskId survives while its task stays pending and clears when removed", async () => {
	const cwd = newTmpDir("tweak-status-focus-");
	try {
		const h = createHarness(cwd);
		await h.sessionStart();
		await createGoalWithTasks(h, "Initial objective", [
			{ id: "x", title: "Task X" },
			{ id: "y", title: "Task Y" },
		]);
		await callTaskTool(h, "update_goal_task", { task_id: "x", status: "start" });
		assert.equal(diskGoal(cwd).currentTaskId, "x");

		// Tweak keeping x: focus survives.
		await h.commands.get("goal-tweak")!.handler("Keep the plan", h.ctx);
		await confirmDialog(h, runProposal(h, proposalParams("Kept objective", {
			tasks: [
				{ id: "x", title: "Task X" },
				{ id: "y", title: "Task Y" },
			],
		})));
		assert.equal(diskGoal(cwd).currentTaskId, "x", "currentTaskId survives when its task stays pending");

		// Tweak removing x: focus clears.
		await h.commands.get("goal-tweak")!.handler("Drop task X", h.ctx);
		await confirmDialog(h, runProposal(h, proposalParams("Dropped objective", {
			tasks: [
				{ id: "y", title: "Task Y" },
			],
		})));
		const goal = diskGoal(cwd);
		assert.equal(goal.currentTaskId, undefined, "currentTaskId clears when its task is removed by the tweak");
		assert.equal(goal.taskList!.tasks.find((t) => t.id === "x"), undefined, "removed task dropped");
	} finally {
		try { rmSync(cwd, { recursive: true, force: true }); } catch {}
	}
});

for(const answer of ["Cancel", "Continue chatting"]){
 test(`unconfirmed budget proposal (${answer}) preserves disk state`,async t=>{
  const cwd=newTmpDir("tweak-budget-cancel-");const h=createHarness(cwd);
  t.after(()=>{h.core.scheduler.shutdown();h.core.clearContinuationState();rmSync(cwd,{recursive:true,force:true});});
  await createGoalWithTasks(h,"Objective",[{id:"one",title:"One"}]);
  await h.commands.get("goal-tweak")!.handler("Set budget to 100",h.ctx);
  const before=diskGoal(cwd);
  const pending=runProposal(h,proposalParams(before.objective,{token_budget:100}));
  assert.ok(h.hasDialog());
  h.dialogResult({questions:[],answers:[{id:"confirm",question:"Confirm Goal Draft",answer,wasCustom:false}],cancelled:answer==="Cancel"});
  await pending;
  assert.deepEqual(diskGoal(cwd),before);
 });
}

test("budget-only confirmation displays current and proposed limits",async()=>{
 const {proposalText}=await import("../extensions/goal-drafting.ts");
 const {createGoal}=await import("../extensions/goal-record.ts");
 const goal=createGoal({objective:"Keep objective",autoContinue:true,sisyphus:false});goal.tokenBudget=10;
 const text=proposalText({mode:"tweak",originalTopic:"Remove the budget",startedAt:"now",auditorEnabled:true},goal.objective,true,undefined,goal,null);
 assert.match(text,/Current Budget: 10 tokens/);assert.match(text,/Proposed Budget: none/);
});

for (const budget of [undefined, null, 1, 50000]) {
 test(`guided creation reports and persists budget ${budget}`, async t => {
  const cwd = newTmpDir("create-budget-"); const h = createHarness(cwd);
  t.after(() => {h.core.scheduler.shutdown(); h.core.clearContinuationState(); rmSync(cwd, {recursive:true,force:true});});
  await h.commands.get("goal")!.handler("Keep objective", h.ctx);
  const pending = runProposal(h, proposalParams("Keep objective", budget === undefined ? {} : {token_budget: budget}));
  await confirmDialog(h, pending);
  assert.equal(diskGoal(cwd).tokenBudget, budget ?? undefined);
  assert.match(JSON.stringify((await pending).content), new RegExp(`Budget: ${budget == null ? "none" : budget + " tokens"}`));
 });
}

for (const budget of [undefined, null, 5, 50000]) {
 test(`budget-only tweak ${budget} preserves progress and recovers only with remaining budget`, async t => {
  const cwd = newTmpDir("tweak-budget-"); const h = createHarness(cwd);
  t.after(() => {h.core.scheduler.shutdown();h.core.clearContinuationState();rmSync(cwd,{recursive:true,force:true});});
  await createGoalWithTasks(h,"Keep objective",[{id:"done",title:"Finished work"}]);
  await callTaskTool(h,"update_goal_task",{task_id:"done",status:"complete",evidence:"verified"});
  const original = diskGoal(cwd);
  original.tokenBudget=10; original.usage.tokensUsed=20; original.status="budget_limited";
  original.scheduler={...newGoalScheduler("tweak-status-session"),used:3};
  writeActiveGoalFile(h.ctx,original); h.core.reconcileFocusedGoalFromDisk(h.ctx);
  h.core.runtime.armPostBudgetReminder();
  await h.commands.get("goal-tweak")!.handler("Change only the budget",h.ctx);
  const pending=runProposal(h,proposalParams(original.objective,budget === undefined ? {} : {token_budget:budget}));
  await confirmDialog(h,pending);
  const saved=diskGoal(cwd);
  assert.equal(saved.id,original.id);assert.equal(saved.objective,original.objective);
  assert.deepEqual(saved.taskList,original.taskList);assert.equal(saved.skipAuditor,original.skipAuditor);
  assert.equal(saved.tokenBudget,budget === undefined ? 10 : budget ?? undefined);
  assert.equal(saved.usage.tokensUsed,20);assert.equal(saved.scheduler?.used,3);
  const exhausted=budget === undefined || budget === 5;
  assert.equal(saved.status,exhausted ? "budget_limited":"active");
  assert.equal(h.core.runtime.consumePostBudgetReminder(),exhausted);
  assert.match(JSON.stringify((await pending).content),exhausted ? /remains budget-limited/ : /Budget: (none|50000 tokens)/);
  assert.equal(readGoalLedger(h.ctx).events.filter(e=>e.type==="goal_budget_changed").length,budget === undefined ? 0 : 1);
 });
}

for (const barrier of ["foreign", "interrupted", "claimed", "allowance"]) {
 test(`budget recovery respects ${barrier} scheduling barrier`,async t=>{
  const cwd=newTmpDir("tweak-budget-barrier-");const h=createHarness(cwd);
  t.after(()=>{h.core.scheduler.shutdown();h.core.clearContinuationState();rmSync(cwd,{recursive:true,force:true});});
  await createGoalWithTasks(h,"Objective",[{id:"one",title:"One"}]);
  const goal=diskGoal(cwd);goal.tokenBudget=1;goal.usage.tokensUsed=2;goal.status="budget_limited";
  goal.scheduler={...newGoalScheduler(barrier === "foreign" ? "other" : "tweak-status-session"),used:3};
  if(barrier === "interrupted")goal.scheduler.phase="interrupted";
  if(barrier === "claimed"){goal.scheduler.phase="claimed";goal.scheduler.dispatch={id:"old",kind:"ready",claimedAt:Date.now()};}
  if(barrier === "allowance") { const {saveGoalSettingsFileConfig}=await import("../extensions/goal-settings.ts");saveGoalSettingsFileConfig(cwd,{maxAutonomousRuns:3}); }
  writeActiveGoalFile(h.ctx,goal);h.core.reconcileFocusedGoalFromDisk(h.ctx);
  await h.commands.get("goal-tweak")!.handler("Remove budget",h.ctx);
  await confirmDialog(h,runProposal(h,proposalParams(goal.objective,{token_budget:null})));
  const saved=diskGoal(cwd);assert.equal(saved.status,"paused");assert.equal(saved.tokenBudget,undefined);assert.equal(saved.scheduler?.used,3);
 });
}

test("lowering active budget stops immediately and invalidates queued dispatch",async t=>{
 const cwd=newTmpDir("tweak-budget-lower-");const h=createHarness(cwd);
 t.after(()=>{h.core.scheduler.shutdown();h.core.clearContinuationState();rmSync(cwd,{recursive:true,force:true});});
 await createGoalWithTasks(h,"Objective",[{id:"one",title:"One"}]);
 const goal=diskGoal(cwd);goal.usage.tokensUsed=20;
 // A goal saved before next actions were removed still carries decision.nextAction
 // on disk. Seeding it here shows that such a goal loads and tweaks normally.
 goal.scheduler={...newGoalScheduler("tweak-status-session"),phase:"ready",decision:{kind:"ready",purpose:"ready",nextAction:"Old action"} as unknown as {kind:"ready";purpose:"ready"},used:2};
 writeActiveGoalFile(h.ctx,goal);h.core.reconcileFocusedGoalFromDisk(h.ctx);
 await h.commands.get("goal-tweak")!.handler("Set budget to 1",h.ctx);
 await confirmDialog(h,runProposal(h,proposalParams(goal.objective,{token_budget:1})));
 const saved=diskGoal(cwd);assert.equal(saved.status,"budget_limited");assert.equal(saved.scheduler?.decision,undefined);assert.notEqual(saved.scheduler?.generation,goal.scheduler?.generation);assert.equal(saved.scheduler?.used,2);
});

test("budget confirmation rejects a changed revision",async t=>{
 const cwd=newTmpDir("tweak-budget-stale-");const h=createHarness(cwd);
 t.after(()=>{h.core.scheduler.shutdown();h.core.clearContinuationState();rmSync(cwd,{recursive:true,force:true});});
 await createGoalWithTasks(h,"Objective",[{id:"one",title:"One"}]);
 await h.commands.get("goal-tweak")!.handler("Remove budget",h.ctx);
 const goal=diskGoal(cwd);const pending=runProposal(h,proposalParams(goal.objective,{token_budget:null}));
 writeActiveGoalFile(h.ctx,{...goal,tokenBudget:123,revision:(goal.revision??0)+1});
 await confirmDialog(h,pending);
 assert.match(JSON.stringify((await pending).content),/changed during confirmation/);assert.equal(diskGoal(cwd).tokenBudget,123);
});

for(const value of [0,-1,1.5,Number.MAX_SAFE_INTEGER+1,"50"]){
 test(`invalid draft budget ${value} is rejected before confirmation`,async t=>{
  const cwd=newTmpDir("tweak-budget-invalid-");const h=createHarness(cwd);t.after(()=>rmSync(cwd,{recursive:true,force:true}));
  await h.commands.get("goal")!.handler("Objective",h.ctx);
  const result=await runProposal(h,proposalParams("Objective",{token_budget:value}));
  assert.equal(h.hasDialog(),false);assert.match(JSON.stringify(result.content),/token_budget/);assert.equal(activeGoalFiles(cwd).length,0);
 });
}

test("failed budget mutation never reports success or changes the saved goal",async t=>{
 const cwd=newTmpDir("tweak-budget-fail-");const h=createHarness(cwd);
 t.after(()=>{h.core.scheduler.shutdown();h.core.clearContinuationState();rmSync(cwd,{recursive:true,force:true});});
 await createGoalWithTasks(h,"Objective",[{id:"one",title:"One"}]);
 await h.commands.get("goal-tweak")!.handler("Set budget",h.ctx);
 const before=diskGoal(cwd);const pending=runProposal(h,proposalParams(before.objective,{token_budget:123}));
 t.mock.method(h.core.goalService,"apply",()=>({ok:false,message:"injected storage failure"}));
 await confirmDialog(h,pending);
 assert.match(JSON.stringify((await pending).content),/not applied: injected storage failure/);
 assert.deepEqual(diskGoal(cwd),before);
});
