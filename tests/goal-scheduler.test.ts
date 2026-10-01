import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import goalExtension from "../extensions/goal.ts";
import type { GoalCore } from "../extensions/goal-state.ts";
import { createGoal, goalFocusDetails, cloneGoal, normalizeGoalRecord } from "../extensions/goal-record.ts";
import { writeActiveGoalFile, parseGoalFile } from "../extensions/storage/goal-files.ts";
import { invalidateGoalSettingsCache, parseGoalSettings, saveGoalSettingsFileConfig, loadGoalSettings } from "../extensions/goal-settings.ts";
import { newGoalScheduler, normalizeGoalScheduler, schedulerSummary } from "../extensions/goal-scheduler-state.ts";

async function fixture(t: TestContext, limit?: number, owner = "owner", existing?: string, strict = true) {
	const cwd = existing ?? mkdtempSync(path.join(tmpdir(), "goal-scheduler-"));
	const prior = process.env.PI_GOAL_GLOBAL_SETTINGS_FILE;
	process.env.PI_GOAL_GLOBAL_SETTINGS_FILE = path.join(cwd, "absent-global.json");
	if (!existing) {
		mkdirSync(path.join(cwd, ".pi"), { recursive: true });
		writeFileSync(path.join(cwd, ".pi", "pi-goal-x-settings.json"), JSON.stringify({ strictExecutionContract: strict, ...(limit !== undefined ? { maxAutonomousRuns: limit } : {}) }));
	}
	invalidateGoalSettingsCache();
	const goal = createGoal({ objective: "Test explicit scheduling", autoContinue: true, sisyphus: false });
	goal.id = "scheduler-fixture";
	if (!existing) writeActiveGoalFile({ cwd }, goal);
	const handlers: Record<string, Function> = {};
	const tools = new Map<string, any>();
	const sent: any[] = [];
	const notifications: string[] = [];
	const listeners = new Map<string, Function>();
	let aborts = 0;
	const pi = { registerTool: (tool: any) => tools.set(tool.name, tool), registerCommand: () => {}, on: (event: string, handler: Function) => { handlers[event] = handler; }, getActiveTools: () => ["read", "write", "bash"], setActiveTools: () => {}, appendEntry: () => {}, registerMessageRenderer: () => {}, sendMessage: (message: unknown) => { sent.push(message); }, events: { on: (name: string, fn: Function) => { listeners.set(name, fn); return () => listeners.delete(name); }, emit: (name: string, event: unknown) => listeners.get(name)?.(event) } };
	const ctx = { cwd, hasUI: false, isIdle: () => true, hasPendingMessages: () => false, abort: () => { aborts++; }, getSystemPrompt: () => "base", sessionManager: { getSessionId: () => owner, getCwd: () => cwd, getRoot: () => cwd, getBranch: () => [{ type: "custom", customType: "pi-goal-focus", data: goalFocusDetails(goal.id, "created") }] }, ui: { notify: (message: string) => notifications.push(message), setStatus: () => {}, setWidget: () => {} } } as unknown as ExtensionContext;
	goalExtension(pi as any);
	const core = (pi as any)._goalCore as GoalCore;
	await core.loadState(ctx);
	core.scheduler.attach(ctx);
	t.after(() => {
		core.scheduler.shutdown(); core.runtime.clearContinuationState();
		if (!existing) rmSync(cwd, { recursive: true, force: true });
		if (prior === undefined) delete process.env.PI_GOAL_GLOBAL_SETTINGS_FILE; else process.env.PI_GOAL_GLOBAL_SETTINGS_FILE = prior;
		invalidateGoalSettingsCache();
	});
	const begin = () => core.scheduler.begin(ctx);
	const admit = () => { begin(); core.scheduler.message(ctx, { ...sent.at(-1), role: "custom" }); };
	const ready = () => core.scheduler.declare(ctx, { kind: "ready" });
	const wait = () => core.scheduler.declare(ctx, { kind: "wait", reason: "Await fixture job", deadline: new Date(Date.now() + 10000).toISOString(), polling: { interval_seconds: 1, max_checks: 2 } });
	return { cwd, ctx, core, handlers, tools, sent, notifications, begin, admit, ready, wait, pi, aborts: () => aborts };
}

test("explicit zero means no automatic model runs, even for missing disposition", async t => {
	const h = await fixture(t, 0);
	t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
	h.begin();
	assert.equal(h.ready().terminate, false);
	h.core.scheduler.settled(h.ctx);
	t.mock.timers.tick(10000);
	assert.equal(h.sent.length, 0);
	assert.equal(h.core.state.goal?.status, "paused");
	assert.match(h.core.state.goal?.pauseReason ?? "", /disabled by maxAutonomousRuns=0/);
});

for (const start of ["creation", "resume"] as const) {
	test(`strict ${start} starts automatically and still allows only one repair`, async t => {
		const h = await fixture(t);
		t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
		if (start === "creation") h.core.replaceGoal({ objective: "Work automatically", autoContinue: true, sisyphus: false }, h.ctx);
		else assert.equal(h.core.scheduler.resume(h.ctx), true);
		t.mock.timers.tick(1);
		assert.equal(h.sent.length, 1);
		h.admit(); h.core.scheduler.settled(h.ctx); t.mock.timers.tick(1);
		assert.equal(h.core.state.goal?.scheduler?.dispatch?.kind, "repair");
		h.admit(); h.core.scheduler.settled(h.ctx); t.mock.timers.tick(10000);
		assert.equal(h.sent.length, 2);
		assert.equal(h.core.state.goal?.status, "paused");
		assert.match(h.core.state.goal?.pauseReason ?? "", /No execution disposition/);
	});
}

test("uncapped ready runs keep counting when limits are added and removed", async t => {
	const h = await fixture(t);
	t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
	h.begin();
	for (let used = 1; used <= 5; used++) {
		assert.equal(h.ready().terminate, true);
		h.core.scheduler.settled(h.ctx); t.mock.timers.tick(1); h.admit();
		assert.equal(h.core.state.goal?.scheduler?.used, used);
	}
	// Uncapped runs still count. The summary reports nothing while the allowance is
	// unlimited, because there is no limit to report.
	assert.equal(h.core.state.goal?.scheduler?.used, 5);
	assert.equal(schedulerSummary(h.core.state.goal?.scheduler), "");
	assert.match(schedulerSummary(h.core.state.goal?.scheduler, 5), /5\/5/);
	saveGoalSettingsFileConfig(h.cwd, { maxAutonomousRuns: 5 });
	assert.equal(h.ready().terminate, false, "adding a cap includes previously uncapped dispatches");
	saveGoalSettingsFileConfig(h.cwd, {});
	assert.equal(h.ready().terminate, true, "removing the cap re-enables continuation");
	h.core.scheduler.settled(h.ctx); t.mock.timers.tick(1); h.admit();
	assert.equal(h.core.state.goal?.scheduler?.used, 6);
	saveGoalSettingsFileConfig(h.cwd, { maxAutonomousRuns: 6 });
	h.core.scheduler.settled(h.ctx); t.mock.timers.tick(1);
	assert.equal(h.sent.length, 6);
	assert.equal(h.core.state.goal?.status, "paused");
	assert.equal(h.core.state.goal?.scheduler?.used, 6);
});

test("every tool category requires the same declaration; one repair then pause", async t => {
	const h = await fixture(t, 10);
	t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
	for (const name of ["read", "write", "bash", "custom_tool", "update_goal_task"]) {
		h.core.scheduler.resume(h.ctx); t.mock.timers.tick(1); h.admit();
		await h.handlers.tool_call!({ toolName: name, args: {} }, h.ctx);
		h.core.scheduler.settled(h.ctx); t.mock.timers.tick(1);
		assert.equal(h.core.state.goal?.scheduler?.dispatch?.kind, "repair", name);
		h.admit(); h.core.scheduler.settled(h.ctx); t.mock.timers.tick(1);
		assert.equal(h.core.state.goal?.status, "paused", name);
		assert.equal(h.core.state.goal?.scheduler?.used, 2, name);
	}
});

test("declarations persist before termination, claim once, and settings changes never reset spent runs", async t => {
	const h = await fixture(t, 2);
	t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
	h.begin(); assert.equal(h.ready().terminate, true);
	const disk = parseGoalFile(path.resolve(h.cwd, h.core.state.goal!.activePath!));
	assert.equal(disk?.scheduler?.phase, "ready");
	assert.equal(h.sent.length, 0);
	h.core.scheduler.settled(h.ctx); t.mock.timers.tick(1);
	assert.equal(h.core.state.goal?.scheduler?.used, 1);
	h.admit(); assert.equal(h.ready().terminate, true); h.core.scheduler.settled(h.ctx); t.mock.timers.tick(1);
	assert.equal(h.core.state.goal?.scheduler?.used, 2);
	h.admit(); assert.equal(h.ready().terminate, false);
	saveGoalSettingsFileConfig(h.cwd, { maxAutonomousRuns: 3 });
	assert.equal(h.ready().terminate, true);
	h.core.scheduler.settled(h.ctx); t.mock.timers.tick(1);
	assert.equal(h.core.state.goal?.scheduler?.used, 3);
	assert.equal(h.sent.length, 3);
	h.core.scheduler.message(h.ctx, { ...h.sent[0], role: "custom" });
	assert.equal(h.aborts(), 1, "duplicate or stale generation is rejected");
});

test("early wake and check timer race produce one claimed run", async t => {
	const h = await fixture(t, 5);
	t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
	h.begin(); assert.equal(h.wait().terminate, true);
	const w = h.core.state.goal!.scheduler!.wait!;
	h.pi.events.emit("pi-goal:wake", { goalId: h.core.state.goal!.id, waitToken: w.token });
	assert.equal(h.sent.length, 0, "signal before settlement must not start a run");
	h.core.scheduler.settled(h.ctx); t.mock.timers.tick(1);
	h.pi.events.emit("pi-goal:wake", { goalId: h.core.state.goal!.id, waitToken: w.token });
	t.mock.timers.tick(1000);
	assert.equal(h.sent.length, 1);
	assert.equal(h.core.state.goal?.scheduler?.dispatch?.kind, "wake");
	assert.equal(h.core.state.goal?.scheduler?.wait?.remainingChecks, 2);
});

test("checks retain identity, deadline and finite count across redeclaration", async t => {
	const h = await fixture(t, 5);
	t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
	h.begin(); h.wait();
	const first = structuredClone(h.core.state.goal!.scheduler!.wait!);
	h.core.scheduler.settled(h.ctx); t.mock.timers.tick(999); assert.equal(h.sent.length, 0); t.mock.timers.tick(2);
	assert.equal(h.sent.length, 1); h.admit();
	assert.equal(h.wait().terminate, false, "new wait cannot reset an existing check");
	const redeclare = () => h.core.scheduler.declare(h.ctx, { kind: "wait", wait_id: first.id, reason: first.reason, deadline: new Date(first.deadline).toISOString() });
	assert.equal(redeclare().terminate, true);
	assert.equal(h.core.state.goal?.scheduler?.wait?.remainingChecks, 1);
	h.core.scheduler.settled(h.ctx); t.mock.timers.tick(1001); h.admit();
	assert.equal(redeclare().terminate, true);
	h.core.scheduler.settled(h.ctx);
	assert.equal(h.core.state.goal?.status, "paused");
	assert.match(h.core.state.goal?.pauseReason ?? "", /check allowance exhausted/);
	assert.equal(h.sent.length, 2);
});

test("waiting restores with no catch-up; claimed dispatch never replays", async t => {
	const h = await fixture(t, 5);
	t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
	h.begin(); h.wait(); h.core.scheduler.settled(h.ctx); h.core.scheduler.shutdown();
	t.mock.timers.tick(4000);
	const resumed = await fixture(t, undefined, "owner", h.cwd);
	resumed.core.scheduler.restore(resumed.ctx); t.mock.timers.tick(1);
	assert.equal(resumed.sent.length, 1, "missed checks coalesce into one");
	resumed.core.scheduler.shutdown();
	const interrupted = await fixture(t, undefined, "owner", h.cwd);
	interrupted.core.scheduler.restore(interrupted.ctx); t.mock.timers.tick(10000);
	assert.equal(interrupted.sent.length, 0);
	assert.equal(interrupted.core.state.goal?.status, "paused");
});

test("deadline expiration and another session cannot wake a sleeping goal", async t => {
	const h = await fixture(t, 5);
	t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
	h.begin(); h.core.scheduler.declare(h.ctx, { kind: "wait", reason: "External event", deadline: new Date(Date.now() + 2000).toISOString() });
	h.core.scheduler.settled(h.ctx);
	const other = await fixture(t, undefined, "other-owner", h.cwd);
	other.core.scheduler.restore(other.ctx);
	assert.equal(other.ready().terminate, false);
	t.mock.timers.tick(2000);
	assert.equal(h.sent.length + other.sent.length, 0);
	assert.match(h.core.state.goal?.pauseReason ?? "", /deadline/);
});

test("a later model turn invalidates a decision and user takeover cancels delivery", async t => {
	const h = await fixture(t, 5);
	t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
	h.begin(); h.ready(); h.core.scheduler.turn(h.ctx);
	assert.equal(h.core.state.goal?.scheduler?.decision, undefined);
	h.ready(); h.core.scheduler.settled(h.ctx);
	h.core.scheduler.takeover(h.ctx); t.mock.timers.tick(10000);
	assert.equal(h.sent.length, 0);
	assert.equal(h.core.state.goal?.scheduler?.used, 0);
});

test("update_goal rejects mixed forms and scheduler cloning protects rollback", async t => {
	const h = await fixture(t, 5);
	h.begin();
	const tool = h.tools.get("update_goal");
	const mixed = await tool.execute("mixed", { status: "complete", continuation: { kind: "ready" } }, undefined, undefined, h.ctx);
	assert.equal(mixed.terminate, false);
	h.ready();
	const before = structuredClone(h.core.state.goal!.scheduler);
	const clone = cloneGoal(h.core.state.goal!); clone.scheduler!.used = 999;
	assert.deepEqual(h.core.state.goal!.scheduler, before);
	assert.deepEqual(normalizeGoalRecord(h.core.state.goal)?.scheduler, before);
	const invalid = normalizeGoalScheduler({ ...before, used: -1 });
	assert.equal(invalid?.phase, "interrupted");
	assert.equal(invalid?.used, Number.MAX_SAFE_INTEGER);
});

test("maxAutonomousRuns is strictly parsed, layered, and removable", async t => {
	const h = await fixture(t);
	for (const n of [-1, 1.1, "1x", Number.MAX_SAFE_INTEGER + 1]) assert.equal(parseGoalSettings({ maxAutonomousRuns: n }).maxAutonomousRuns, undefined);
	for (const n of [0, "0", 1, "25", Number.MAX_SAFE_INTEGER]) assert.equal(parseGoalSettings({ maxAutonomousRuns: n }).maxAutonomousRuns, Number(n));
	saveGoalSettingsFileConfig(h.cwd, { maxAutonomousRuns: 4 }); assert.equal(loadGoalSettings(h.cwd).maxAutonomousRuns, 4);
	saveGoalSettingsFileConfig(h.cwd, {}); assert.equal(loadGoalSettings(h.cwd).maxAutonomousRuns, undefined);
});

test("project zero disables an inherited allowance without renewing consumption", async t => {
	const h = await fixture(t);
	writeFileSync(process.env.PI_GOAL_GLOBAL_SETTINGS_FILE!, JSON.stringify({ maxAutonomousRuns: 20 }));
	invalidateGoalSettingsCache();
	t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
	h.begin(); h.ready(); h.core.scheduler.settled(h.ctx); t.mock.timers.tick(1); h.admit();
	assert.equal(h.core.state.goal?.scheduler?.used, 1);
	h.ready(); h.core.scheduler.settled(h.ctx);
	saveGoalSettingsFileConfig(h.cwd, { maxAutonomousRuns: 0 });
	invalidateGoalSettingsCache();
	assert.equal(loadGoalSettings(h.cwd).maxAutonomousRuns, 0, "zero survives persistence and overrides global 20");
	assert.match(schedulerSummary(h.core.state.goal?.scheduler, 0), /1\/0 \(automatic continuation disabled\)/);
	t.mock.timers.tick(1);
	assert.equal(h.sent.length, 1, "pending delivery is cancelled");
	assert.equal(h.core.state.goal?.status, "paused");
	assert.equal(h.core.scheduler.resume(h.ctx), false);
	saveGoalSettingsFileConfig(h.cwd, {});
	assert.equal(loadGoalSettings(h.cwd).maxAutonomousRuns, 20, "unsetting restores inheritance");
	assert.equal(h.core.state.goal?.scheduler?.used, 1);
	assert.equal(h.sent.length, 1);
});

for (const kind of ["recovery", "repair"] as const) {
	for (const expiry of ["before scheduling", "before delivery"] as const) {
		test(`${kind} respects an outstanding wait deadline expiring ${expiry}`, async t => {
			const h = await fixture(t, 10);
			t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
			h.begin();
			assert.equal(h.core.scheduler.declare(h.ctx, { kind: "wait", reason: "Await job", deadline: new Date(Date.now() + 3000).toISOString(), polling: { interval_seconds: 1, max_checks: 2 } }).terminate, true);
			h.core.scheduler.settled(h.ctx); t.mock.timers.tick(1001); h.admit();
			let busy = true;
			const ctx = { ...h.ctx, isIdle: () => !busy };
			if (expiry === "before scheduling") t.mock.timers.tick(2000);
			h.core.scheduler.settled(ctx, kind === "repair");
			if (kind === "recovery") h.core.scheduler.recover(ctx);
			if (expiry === "before delivery") {
				assert.equal(h.core.state.goal?.scheduler?.phase, "ready");
				assert.equal(h.core.state.goal?.scheduler?.decision?.kind, "ready");
				t.mock.timers.tick(2000);
			}
			busy = false; t.mock.timers.tick(50);
			assert.equal(h.sent.length, 1, "no dispatch after the polling check");
			assert.equal(h.core.state.goal?.scheduler?.used, 1, "denied dispatch spends no allowance");
			assert.equal(h.core.state.goal?.status, "paused");
			assert.match(h.core.state.goal?.pauseReason ?? "", /Wait deadline reached/);
		});
	}
}

test("network backoff crossing a wait deadline cannot dispatch recovery", async t => {
	const h = await fixture(t);
	t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
	h.begin();
	h.core.scheduler.declare(h.ctx, { kind: "wait", reason: "Await job", deadline: new Date(Date.now() + 3000).toISOString(), polling: { interval_seconds: 1, max_checks: 2 } });
	h.core.scheduler.settled(h.ctx); t.mock.timers.tick(1001); h.admit();
	h.core.scheduler.settled(h.ctx, false);
	const plan = h.core.runtime.scheduleNetworkErrorRetry(h.ctx, h.core.state.goal!);
	assert.equal(plan?.delayMs, 5000);
	t.mock.timers.tick(5001);
	assert.equal(h.sent.length, 1);
	assert.equal(h.core.state.goal?.scheduler?.used, 1);
	assert.equal(h.core.state.goal?.status, "paused");
	assert.match(h.core.state.goal?.pauseReason ?? "", /Wait deadline reached/);
});

test("lowering allowance before delivery stops the wake without resetting usage", async t => {
	const h = await fixture(t, 2);
	t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
	h.begin(); h.ready(); h.core.scheduler.settled(h.ctx);
	saveGoalSettingsFileConfig(h.cwd, { maxAutonomousRuns: 0 });
	t.mock.timers.tick(1);
	assert.equal(h.sent.length, 0);
	assert.equal(h.core.state.goal?.scheduler?.used, 0);
	assert.equal(h.core.state.goal?.status, "paused");
});

test("a previous owner's callback cannot dispatch or pause the new owner's goal", async t => {
	const h = await fixture(t, 5);
	t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
	h.begin(); h.ready(); h.core.scheduler.settled(h.ctx);
	const other = await fixture(t, undefined, "new-owner", h.cwd);
	assert.equal(other.core.scheduler.resume(other.ctx), true);
	t.mock.timers.tick(1);
	assert.equal(h.sent.length, 0);
	assert.equal(other.sent.length, 1);
	assert.equal(other.core.state.goal?.status, "active");
	assert.equal(parseGoalFile(path.resolve(h.cwd, other.core.state.goal!.activePath!))?.status, "active");
});

test("persistence rejection cannot report a saved decision or dispatch", async t => {
	const h = await fixture(t, 5);
	h.begin();
	const apply = h.core.goalService.apply.bind(h.core.goalService);
	h.core.goalService.apply = () => ({ ok: false, message: "Injected storage conflict" });
	assert.equal(h.ready().terminate, false);
	assert.equal(h.core.state.goal?.scheduler?.decision, undefined);
	assert.equal(h.sent.length, 0);
	h.core.goalService.apply = apply;
});

test("readiness polling, failure after claim, and active-time waiting", async t => {
	const h = await fixture(t, 5);
	t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
	let busy = true;
	const ctx = { ...h.ctx, hasPendingMessages: () => busy };
	h.core.scheduler.begin(ctx); h.core.scheduler.declare(ctx, { kind: "ready" }); h.core.scheduler.settled(ctx);
	t.mock.timers.tick(200);
	assert.equal(h.sent.length, 0);
	assert.equal(h.core.state.goal?.scheduler?.used, 0);
	busy = false; t.mock.timers.tick(50);
	assert.equal(h.sent.length, 1);
	assert.equal(h.core.state.goal?.scheduler?.used, 1);
	h.core.scheduler.failedDispatch(ctx);
	assert.equal(h.core.state.goal?.status, "paused");
	assert.equal(h.core.state.goal?.scheduler?.used, 1);
	h.core.scheduler.resume(ctx); t.mock.timers.tick(1); h.admit(); h.wait(); h.core.scheduler.settled(ctx);
	const before = h.core.state.goal!.usage.activeSeconds;
	t.mock.timers.tick(500);
	assert.equal(h.core.goalForDisplay()?.usage.activeSeconds, before);
});


test("explicit resume during an execution waits for settlement and dispatches kickoff, not repair", async t => {
	const h = await fixture(t, 2);
	t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
	h.begin();
	assert.equal(h.core.scheduler.resume(h.ctx), true);
	t.mock.timers.tick(100);
	assert.equal(h.sent.length, 0);
	h.core.scheduler.settled(h.ctx);
	t.mock.timers.tick(1);
	assert.equal(h.core.state.goal?.scheduler?.dispatch?.kind, "kickoff");
	assert.equal(h.core.state.goal?.scheduler?.used, 1);
});

// Default policy deliberately does not infer productivity from tool activity.
test("implicit executions continue without tools through task completion and wrap-up", async t => {
 const h = await fixture(t, undefined, "owner", undefined, false);
 t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
 h.core.goalService.apply(h.ctx, {mutate: g => ({...g, taskList: {proposedAt: new Date().toISOString(), tasks: [{id: "one", title: "One", status: "pending"}, {id: "two", title: "Two", status: "pending"}], blockCompletion: false}})});
 h.begin();
 for (const id of [undefined, "one", "two", undefined]) {
  if (id) await h.tools.get("update_goal_task").execute("test", {task_id: id, status: "complete"}, undefined, undefined, h.ctx);
  h.core.scheduler.settled(h.ctx); t.mock.timers.tick(1);
  assert.equal(h.core.state.goal?.scheduler?.dispatch?.kind, "ready");
  assert.equal(h.core.state.goal?.status, "active");
  h.admit();
 }
 assert.equal(h.sent.length, 4);
 assert.equal(h.core.state.goal?.scheduler?.used, 4);
 assert.ok(h.core.state.goal?.taskList?.tasks.every(task => task.status === "complete"));
});

test("default rejects new waits without terminating or mutating; optional ready succeeds", async t => {
 const h = await fixture(t, 4, "owner", undefined, false);
 h.begin();
 const before = structuredClone(h.core.state.goal);
 const result = h.wait();
 assert.equal(result.terminate, false);
 assert.match(JSON.stringify(result.content), /strictExecutionContract=true/);
 assert.deepEqual(h.core.state.goal, before);
 assert.equal(h.ready().terminate, true);
});

for (const stage of ["schedule", "claim"] as const) {
 test(`disabling strict mode converts queued repair at ${stage} without renewing allowance`, async t => {
  const h = await fixture(t, 5);
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  h.begin(); h.core.scheduler.settled(h.ctx);
  assert.equal(h.core.state.goal?.scheduler?.decision?.kind, "ready");
  saveGoalSettingsFileConfig(h.cwd, {maxAutonomousRuns: 5, strictExecutionContract: false});
  if (stage === "schedule") h.core.scheduler.schedule(h.ctx);
  t.mock.timers.tick(1);
  assert.equal(h.core.state.goal?.scheduler?.dispatch?.kind, "ready");
  assert.equal(h.core.state.goal?.scheduler?.used, 1);
  assert.doesNotMatch(JSON.stringify(h.core.state.goal?.scheduler?.decision), /repair prompt/);
  h.admit(); h.core.scheduler.settled(h.ctx); t.mock.timers.tick(1);
  assert.equal(h.core.state.goal?.scheduler?.used, 2);
 });
}

test("existing waits keep identity, deadline and repair bounds after opt-out", async t => {
 const h = await fixture(t, 8);
 t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
 h.begin(); h.wait();
 const wait = structuredClone(h.core.state.goal!.scheduler!.wait!);
 saveGoalSettingsFileConfig(h.cwd, {strictExecutionContract: false, maxAutonomousRuns: 8});
 h.core.scheduler.settled(h.ctx); t.mock.timers.tick(1001); h.admit();
 assert.equal(h.core.scheduler.declare(h.ctx, {kind: "wait", wait_id: wait.id, reason: wait.reason, deadline: new Date(wait.deadline).toISOString()}).terminate, true);
 assert.equal(h.core.state.goal?.scheduler?.wait?.remainingChecks, 1);
 assert.equal(h.core.state.goal?.scheduler?.wait?.deadline, wait.deadline);
 h.core.scheduler.settled(h.ctx); t.mock.timers.tick(1001); h.admit();
 h.core.scheduler.settled(h.ctx); t.mock.timers.tick(1);
 assert.equal(h.core.state.goal?.scheduler?.dispatch?.kind, "repair");
 h.admit(); h.core.scheduler.settled(h.ctx);
 assert.equal(h.core.state.goal?.status, "paused");
 assert.match(h.core.state.goal?.pauseReason ?? "", /No execution disposition/);
});

test("enabling strict mode at settlement requires a disposition without resetting usage", async t => {
 const h = await fixture(t, 5, "owner", undefined, false);
 t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
 h.begin(); h.core.scheduler.settled(h.ctx); t.mock.timers.tick(1); h.admit();
 saveGoalSettingsFileConfig(h.cwd, {strictExecutionContract: true, maxAutonomousRuns: 5});
 h.core.scheduler.settled(h.ctx); t.mock.timers.tick(1);
 assert.equal(h.core.state.goal?.scheduler?.dispatch?.kind, "repair");
 assert.equal(h.core.state.goal?.scheduler?.used, 2);
 h.admit(); h.core.scheduler.settled(h.ctx);
 assert.equal(h.core.state.goal?.status, "paused");
 saveGoalSettingsFileConfig(h.cwd, {strictExecutionContract: false});
 h.core.scheduler.restore(h.ctx); t.mock.timers.tick(1000);
 assert.equal(h.core.state.goal?.status, "paused");
 assert.equal(h.sent.length, 2);
});

test("default settings inherit strict mode with explicit false overriding global true", async t => {
 const h = await fixture(t, undefined, "owner", undefined, false);
 saveGoalSettingsFileConfig(h.cwd, {});
 assert.equal(loadGoalSettings(h.cwd).strictExecutionContract, false);
 writeFileSync(process.env.PI_GOAL_GLOBAL_SETTINGS_FILE!, JSON.stringify({strictExecutionContract: true}));
 invalidateGoalSettingsCache();
 assert.equal(loadGoalSettings(h.cwd).strictExecutionContract, true);
 saveGoalSettingsFileConfig(h.cwd, {strictExecutionContract: false});
 assert.equal(loadGoalSettings(h.cwd).strictExecutionContract, false);
 saveGoalSettingsFileConfig(h.cwd, {});
 assert.equal(loadGoalSettings(h.cwd).strictExecutionContract, true);
 assert.deepEqual(parseGoalSettings({strictExecutionContract: false}), {strictExecutionContract: false});
 assert.equal(parseGoalSettings({strictExecutionContract: "invalid"}).strictExecutionContract, undefined);
});

test("showAutonomousRuns is a layered boolean that defaults to on", async t => {
	const h = await fixture(t);
	assert.equal(loadGoalSettings(h.cwd).showAutonomousRuns, true);
	saveGoalSettingsFileConfig(h.cwd, { showAutonomousRuns: false });
	invalidateGoalSettingsCache();
	assert.equal(loadGoalSettings(h.cwd).showAutonomousRuns, false);
	writeFileSync(process.env.PI_GOAL_GLOBAL_SETTINGS_FILE!, JSON.stringify({ showAutonomousRuns: true }));
	invalidateGoalSettingsCache();
	assert.equal(loadGoalSettings(h.cwd).showAutonomousRuns, false, "project false beats global true");
	saveGoalSettingsFileConfig(h.cwd, { showAutonomousRuns: true });
	invalidateGoalSettingsCache();
	assert.equal(loadGoalSettings(h.cwd).showAutonomousRuns, true, "project true beats global true");
	saveGoalSettingsFileConfig(h.cwd, {});
	invalidateGoalSettingsCache();
	assert.equal(loadGoalSettings(h.cwd).showAutonomousRuns, true, "global value applies when the project is unset");
	for (const bad of ["yes", 1, null, {}]) assert.equal(parseGoalSettings({ showAutonomousRuns: bad }).showAutonomousRuns, undefined);
	assert.equal(parseGoalSettings({ showAutonomousRuns: false }).showAutonomousRuns, false);
});

test("the runs line is omitted when unlimited and controlled by the setting when finite", async t => {
	const h = await fixture(t);
	const s = { ...normalizeGoalScheduler({ version: 1, owner: "owner", generation: "gen", used: 4, phase: "idle", repairUsed: false })!, used: 4 };

	// Unlimited: no line at all, because there is no limit to report.
	assert.equal(schedulerSummary(s), "");
	assert.equal(schedulerSummary(s, undefined), "");
	assert.equal(schedulerSummary(s, undefined, true), "", "the setting cannot force a line when there is no limit");

	// Finite: reported by default.
	assert.match(schedulerSummary(s, 20), /Autonomous runs: 4\/20\./);
	assert.match(schedulerSummary(h.core.state.goal?.scheduler, 20), /Autonomous runs/);

	// Finite with the setting off.
	assert.equal(schedulerSummary(s, 20, false), "");

	// Zero is a finite allowance, so the disabled suffix still reports.
	assert.match(schedulerSummary(s, 0), /4\/0 \(automatic continuation disabled\)/);
	assert.equal(schedulerSummary(s, 0, false), "");

	assert.match(schedulerSummary(undefined, 20), /Autonomous runs: 0\/20\./);
});

test("a ready disposition needs no next action and the schema no longer accepts one", async t => {
	const h = await fixture(t);
	const schema = JSON.stringify(h.tools.get("update_goal")?.parameters ?? {});
	assert.ok(!/next_action/.test(schema), `update_goal schema must not expose next_action: ${schema.slice(0, 400)}`);

	const result = h.core.scheduler.declare(h.ctx, { kind: "ready" });
	assert.equal(result.terminate, true, "ready with no next action succeeds");
	const declaredText = (result.content ?? []).map((part) => (part && "text" in part ? String(part.text) : "")).join(" ");
	assert.match(declaredText, /Scheduling decision saved/);
	assert.deepEqual(h.core.state.goal?.scheduler?.decision, { kind: "ready", purpose: "ready" }, "purpose is kept and no nextAction is stored");
	assert.ok(!/Next action/.test(declaredText), "the declaration result renders no next-action line");
	assert.doesNotMatch(schedulerSummary(h.core.state.goal?.scheduler, 20), /Next action/);
});

test("a goal saved with decision.nextAction loads and strips the field", () => {
	const legacy = {
		version: 1,
		owner: "legacy-owner",
		generation: "legacy-gen",
		used: 3,
		phase: "ready",
		decision: { kind: "ready", nextAction: "Continue pursuing the goal, then verify and complete it when satisfied.", purpose: "repair" },
		repairUsed: false,
	};
	const normalized = normalizeGoalScheduler(legacy);
	assert.ok(normalized, "a legacy scheduler state must still normalize");
	assert.equal(normalized!.phase, "ready");
	assert.equal(normalized!.used, 3, "spent allowance is preserved");
	assert.deepEqual(normalized!.decision, { kind: "ready", purpose: "repair" }, "purpose is preserved and nextAction is stripped");
	assert.ok(!("nextAction" in (normalized!.decision as object)));
	assert.equal(JSON.stringify(normalized).includes("nextAction"), false, "the stripped field is never written back");
	for (const purpose of ["ready", "repair", "kickoff", "recovery"] as const) {
		const s = normalizeGoalScheduler({ ...legacy, decision: { kind: "ready", nextAction: "x", purpose } });
		assert.equal((s?.decision as { purpose?: string } | undefined)?.purpose, purpose);
	}
	assert.equal(normalizeGoalScheduler({ ...legacy, decision: { kind: "ready", purpose: "bogus" } })?.phase, "interrupted", "an invalid decision is still rejected");
});

test("prompt cache: normal and custom runs preserve history while refreshing all live goal state", async t => {
 const h = await fixture(t);
 const history: any[] = [{role: "user", content: "Work on the goal", timestamp: 1}];
 const original = structuredClone(history);
 const request = async () => (await h.handlers.context!({messages: history}, h.ctx)).messages;
 const preflight = await h.handlers.before_agent_start!({prompt: "continue", systemPrompt: "host policy"}, h.ctx);
 assert.equal(preflight, undefined, "goal state never rewrites the system prefix");
 const first = await request();
 assert.deepEqual(first.slice(0, -2), original, "stable policy and volatile counters ride as two request-only tails");
 assert.equal(first.filter((m: any) => m.customType === "pi-goal-live-context").length, 2);
 assert.match(first.at(-2).content, /PI GOAL ACTIVE/);
 assert.match(first.at(-1).content, /Goal snapshot:/);
 const wire: any = {messages: [{role: "user", content: "Work on the goal"}, {role: "user", content: [{type: "text", text: first.at(-2).content}]}, {role: "user", content: [{type: "text", text: first.at(-1).content, cache_control: {type: "ephemeral"}}]}]};
 await h.handlers.before_provider_request!({payload: wire}, h.ctx);
 assert.equal(wire.messages[0].content[0].cache_control.type, "ephemeral", "registered provider hook places the breakpoint on history");
 assert.equal(wire.messages[1].content[0].cache_control, undefined, "stable tail is transient");
 assert.equal(wire.messages[2].content[0].cache_control, undefined, "volatile tail is transient");
 h.core.state.goal!.usage.tokensUsed = 12345;
 h.core.state.goal!.scheduler = { ...newGoalScheduler("owner"), used: 7 };
 const toolCall = {role: "assistant", content: [{type: "toolCall", id: "call-1", name: "read", arguments: {path: "README.md"}}], timestamp: 2};
 const toolResult = {role: "toolResult", toolCallId: "call-1", toolName: "read", content: [{type: "text", text: "file contents"}], isError: false, timestamp: 3};
 history.push(toolCall, toolResult);
 const second = await request();
 assert.deepEqual(second.slice(0, first.length), first, "the advanced request literally extends the previous one");
 assert.deepEqual(second.slice(3, 5), [toolCall, toolResult], "tool call and result stay adjacent");
 assert.match(second[1].content, /PI GOAL ACTIVE/);
 assert.equal(second.filter((m: any) => m.customType === "pi-goal-live-context").length, 3, "changed counters append one small tail; the policy block is retained, not resent");
 assert.match(second.at(-1).content, /12345 tokens/);
 assert.doesNotMatch(second.at(-1).content, /Autonomous runs/, "an unlimited allowance reports no runs line");
 // An objective edit changes the stable policy block: retention resets once so no
 // stale objective lingers mid-history, and the fresh pair anchors the new prefix.
 h.core.state.goal!.objective = "Changed objective";
 const third = await request();
 assert.equal(third.filter((m: any) => m.customType === "pi-goal-live-context").length, 2);
 assert.deepEqual(third.slice(0, 3), history);
 assert.match(third.at(-2).content, /Changed objective/);
 assert.match(third.at(-1).content, /Goal snapshot:/);
 h.core.scheduler.begin(h.ctx); // Custom-message run bypassing preflight.
 for (let i = 0; i < 4; i++) {
  history.push({role: "custom", customType: "pi-goal-event", content: "legacy full prompt", details: {goalId: h.core.state.goal!.id, kind: "checkpoint"}, timestamp: i + 4});
  const current = await request();
  assert.deepEqual(current.slice(0, third.length - 1), third.slice(0, -1));
  assert.equal(current.filter((m: any) => m.customType === "pi-goal-live-context").length, 2, "retained tails are re-sent in place, never duplicated per request");
  const before = current.slice(0, -1);
  const again = await request();
  assert.deepEqual(again.slice(0, -1), before);
 }
 assert.deepEqual(history[0], original[0], "request transforms never mutate stored history");
 for (const status of ["paused", "blocked", "budget_limited"] as const) {
  h.core.state.goal!.status = status;
  const stopped = await request();
  assert.match(stopped.at(-1).content, new RegExp(status.replace("_", " ").toUpperCase()));
  assert.doesNotMatch(stopped.at(-1).content, /PI GOAL ACTIVE/);
 }
});

test("prompt cache: interleaved sessions keep per-session transient sets", async t => {
	const h = await fixture(t);
	const history: any[] = [{role: "user", content: "Work on the goal", timestamp: 1}];
	const ctxB = {...h.ctx, sessionManager: {...h.ctx.sessionManager, getSessionId: () => "owner-B"}} as unknown as ExtensionContext;
	const first: any[] = (await h.handlers.context!({messages: history}, h.ctx)).messages;
	// Session B advances the same goal so its transient set differs from A's.
	h.core.state.goal!.usage.tokensUsed = 12345;
	h.core.state.goal!.scheduler = {...newGoalScheduler("owner"), used: 7};
	await h.handlers.context!({messages: history}, ctxB);
	const wire: any = {messages: [{role: "user", content: "Work on the goal"}, {role: "user", content: [{type: "text", text: first.at(-2).content}]}, {role: "user", content: [{type: "text", text: first.at(-1).content, cache_control: {type: "ephemeral"}}]}]};
	await h.handlers.before_provider_request!({payload: wire}, h.ctx);
	assert.equal(wire.messages[0].content[0].cache_control?.type, "ephemeral", "session A's request relocates with A's set even after B overwrote its own");
	assert.equal(wire.messages[2].content[0].cache_control, undefined, "A's live tail stays transient");
});

test("prompt cache: cleared scheduling instructions vanish from retained history", async t => {
	const h = await fixture(t);
	const history: any[] = [{role: "user", content: "Work on the goal", timestamp: 1}];
	// The standing instruction is a saved wait reason. A ready decision no longer
	// carries text: next actions were removed.
	h.core.state.goal!.scheduler = {...newGoalScheduler("owner"), phase: "waiting", decision: {kind: "wait"}, wait: {id: "w1", token: "t1", reason: "Publish release v1", deadline: Date.now() + 60_000}};
	const first: any[] = (await h.handlers.context!({messages: history}, h.ctx)).messages;
	assert.ok(first.some((m: any) => typeof m.content === "string" && m.content.includes("Publish release v1")), "standing instruction rides the live state");
	// Cleared by omission: a plain scheduler with no decision must not re-issue the order.
	h.core.state.goal!.scheduler = {...newGoalScheduler("owner"), used: 1};
	const advanced = [...history, {role: "assistant", content: "ack", timestamp: 2}];
	const second: any[] = (await h.handlers.context!({messages: advanced}, h.ctx)).messages;
	assert.ok(!second.some((m: any) => typeof m.content === "string" && m.content.includes("Publish release v1")), "no retained tail re-issues the cancelled order");
});


test("prompt cache: model changes and missing identities cannot replay another request's counters", async t => {
 const h = await fixture(t);
 const history = [{role: "user", content: "inspect", timestamp: 1}];
 const request = async (ctx: ExtensionContext) => (await h.handlers.context!({messages: history}, ctx)).messages as any[];
 const initial = {...h.ctx, model: {provider: "provider-a", id: "model-a"}} as ExtensionContext;
 await request(initial);
 h.core.state.goal!.usage.tokensUsed = 123456;
 for (const model of [{provider: "provider-a", id: "model-b"}, {provider: "provider-b", id: "model-b"}]) {
  const out = await request({...h.ctx, model} as ExtensionContext);
  assert.equal(out.filter(m => m.customType === "pi-goal-live-context").length, 2);
  assert.match(out.at(-1).content, /123456 tokens/);
 }
 const unknown = {...h.ctx, sessionManager: {...h.ctx.sessionManager, getSessionId: () => undefined}} as unknown as ExtensionContext;
 await request(unknown);
 h.core.state.goal!.usage.tokensUsed = 234567;
 const next = await request(unknown);
 assert.equal(next.filter(m => m.customType === "pi-goal-live-context").length, 2);
 assert.ok(!JSON.stringify(next).includes("123456 tokens"));
 await h.handlers.session_shutdown!({}, initial);
 const restarted = await request(initial);
 assert.equal(restarted.filter(m => m.customType === "pi-goal-live-context").length, 2);
 assert.match(restarted.at(-1).content, /234567 tokens/);
});
