import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import goalExtension from "../extensions/goal.ts";
import type { GoalCore } from "../extensions/goal-state.ts";
import { createGoal, goalFocusDetails } from "../extensions/goal-record.ts";
import { writeActiveGoalFile } from "../extensions/storage/goal-files.ts";
import { invalidateGoalSettingsCache } from "../extensions/goal-settings.ts";
import { schedulerSummary } from "../extensions/goal-scheduler-state.ts";
import { deriveGoalDashboardModel } from "../extensions/widgets/goal-dashboard-model.ts";
import { renderCompactDashboard } from "../extensions/widgets/goal-dashboard-renderer.ts";
import { applyStableHeightBound } from "../extensions/widgets/goal-widget.ts";
import { BACKGROUND_TASK_WAIT_MS } from "../extensions/goal-scheduler.ts";
import { isPendingTaskPoll, observeBackgroundTask } from "../extensions/goal-background-task.ts";

/**
 * A goal whose loop keeps running while a detached task is in flight can only
 * poll that task. These cases pin the replacement: an observation raised the
 * wait, the producer report wakes the goal, and a lost report is bounded.
 */

async function fixture(t: TestContext, owner = "owner", existing?: string) {
	const cwd = existing ?? mkdtempSync(path.join(tmpdir(), "goal-background-task-"));
	const prior = process.env.PI_GOAL_GLOBAL_SETTINGS_FILE;
	process.env.PI_GOAL_GLOBAL_SETTINGS_FILE = path.join(cwd, "absent-global.json");
	if (!existing) {
		mkdirSync(path.join(cwd, ".pi"), { recursive: true });
		// The reported default: no explicit execution contract.
		writeFileSync(path.join(cwd, ".pi", "pi-goal-x-settings.json"), JSON.stringify({ strictExecutionContract: false }));
	}
	invalidateGoalSettingsCache();
	const goal = createGoal({ objective: "Wait for detached work", autoContinue: true, sisyphus: false });
	goal.id = "background-task-fixture";
	if (!existing) writeActiveGoalFile({ cwd }, goal);
	const handlers: Record<string, Function> = {};
	const tools = new Map<string, any>();
	const sent: any[] = [];
	const notifications: string[] = [];
	const listeners = new Map<string, Function>();
	const pi = {
		registerTool: (tool: any) => tools.set(tool.name, tool),
		registerCommand: () => {},
		on: (event: string, handler: Function) => { handlers[event] = handler; },
		getActiveTools: () => ["read", "write", "pwsh"],
		setActiveTools: () => {},
		appendEntry: () => {},
		registerMessageRenderer: () => {},
		sendMessage: (message: unknown) => { sent.push(message); },
		events: { on: (name: string, fn: Function) => { listeners.set(name, fn); return () => listeners.delete(name); }, emit: (name: string, event: unknown) => listeners.get(name)?.(event) },
	};
	const ctx = {
		cwd,
		hasUI: false,
		isIdle: () => true,
		hasPendingMessages: () => false,
		abort: () => {},
		getSystemPrompt: () => "base",
		sessionManager: { getSessionId: () => owner, getCwd: () => cwd, getRoot: () => cwd, getBranch: () => [{ type: "custom", customType: "pi-goal-focus", data: goalFocusDetails(goal.id, "created") }] },
		ui: { notify: (message: string) => notifications.push(message), setStatus: () => {}, setWidget: () => {} },
	} as unknown as ExtensionContext;
	goalExtension(pi as any);
	const core = (pi as any)._goalCore as GoalCore;
	await core.loadState(ctx);
	core.scheduler.attach(ctx);
	t.after(() => {
		core.scheduler.shutdown();
		core.runtime.clearContinuationState();
		if (!existing) rmSync(cwd, { recursive: true, force: true });
		if (prior === undefined) delete process.env.PI_GOAL_GLOBAL_SETTINGS_FILE; else process.env.PI_GOAL_GLOBAL_SETTINGS_FILE = prior;
		invalidateGoalSettingsCache();
	});
	/** Drive one producer result through the registered hook. */
	const result = (event: Record<string, unknown>) => handlers.tool_result!(event, ctx);
	/** Drive one tool call through the registered gate, shaped like the pinned pi API event. */
	const call = (toolName: string, input: Record<string, unknown>) => handlers.tool_call!({ type: "tool_call", toolCallId: "call-1", toolName, input }, ctx);
	/** A pi-pwsh style result that leaves the task running. */
	const running = (id: string) => ({ toolName: "pwsh", details: { version: 1, taskId: id, status: "running", ready: false }, input: { command: "sleep" }, isError: false, content: [{ type: "text" as const, text: `taskId: ${id}\nstatus: running` }] });
	/** An ordinary work result that is not detached work. */
	const work = (name = "step-1.txt") => ({ toolName: "write", details: undefined, input: { file_path: name }, isError: false, content: [{ type: "text" as const, text: "written" }] });
	/** The host report that a task finished, which opens a turn. */
	const report = () => core.scheduler.message(ctx, { role: "user", content: "Background task updates." });
	return { cwd, ctx, core, handlers, tools, sent, notifications, result, call, running, work, report };
}

test("only structured producer results identify detached work", () => {
	// `status` (pi-pwsh) and `phase` (the shared task catalog) are both read, so
	// any producer that already reports one participates without a new contract.
	const observed = observeBackgroundTask({ toolName: "pwsh", details: { taskId: "t1", status: "running" }, isError: false });
	assert.equal(observed?.kind, "running");
	assert.equal(observed?.kind === "running" ? observed.task.id : "", "t1");
	assert.equal(observeBackgroundTask({ toolName: "pwsh", details: { taskId: "t1", status: "completed" } })?.kind, "settled");
	assert.equal(observeBackgroundTask({ toolName: "subagent", details: { agentId: "a1", phase: "active" } })?.kind, "running");
	assert.equal(observeBackgroundTask({ toolName: "subagent", details: { agentId: "a1", phase: "completed" } })?.kind, "settled");
	// The two values @tintinweb/pi-subagents actually reports: a detached agent is
	// `background`, a foreground one streams `running`.
	assert.equal(observeBackgroundTask({ toolName: "agent", details: { agentId: "a1", status: "background" } })?.kind, "running");
	assert.equal(observeBackgroundTask({ toolName: "agent", details: { agentId: "a1", status: "running" } })?.kind, "running");
	// pi-background-tasks nests the task object: details = { task: snapshot }.
	const nested = observeBackgroundTask({ toolName: "bg_run", details: { task: { id: "b856fa479", name: "cycle3 long sleep", status: "running", pid: 21132 } } });
	assert.equal(nested?.kind, "running");
	assert.equal(nested?.kind === "running" ? nested.task.id : "", "b856fa479");
	assert.match(nested?.kind === "running" ? nested.task.label : "", /cycle3 long sleep/);
	assert.equal(observeBackgroundTask({ toolName: "bg_status", details: { task: { id: "b856fa479", status: "completed" } } })?.kind, "settled");
	assert.equal(observeBackgroundTask({ toolName: "bg_run", details: { task: { id: "x", status: "ok" } } }), null, "an unknown nested value is not a running task");
	// An anonymous running status still pauses the goal: it simply cannot match a poll.
	const anonymous = observeBackgroundTask({ toolName: "pwsh", details: { status: "running" } });
	assert.equal(anonymous?.kind, "running");
	assert.equal(anonymous?.kind === "running" ? anonymous.task.id : "x", "");
	// An ordinary result, an error, and an unknown status must never pause a goal.
	assert.equal(observeBackgroundTask({ toolName: "pwsh", details: { exitCode: 0 }, isError: false }), null);
	assert.equal(observeBackgroundTask({ toolName: "pwsh", details: { taskId: "t1", status: "running" }, isError: true }), null);
	assert.equal(observeBackgroundTask({ toolName: "bash", details: undefined }), null);
	assert.equal(observeBackgroundTask({ toolName: "subagent", details: { agentId: "a1" } }), null, "an id alone is not a running task");
});

test("producer label text is bounded and single-line", () => {
	const observed = observeBackgroundTask({ toolName: "subagent", details: { agentId: "a1", status: "running", summary: `line one\nline two ${"x".repeat(400)}` } });
	assert.equal(observed?.kind, "running");
	const label = observed?.kind === "running" ? observed.task.label : "";
	assert.doesNotMatch(label, /\n/);
	assert.ok(label.length <= 140, label);
});

test("a poll of the tracked task is blocked; acting on it is not", () => {
	assert.equal(isPendingTaskPoll("pwsh", { taskId: "t1" }, "t1"), true);
	assert.equal(isPendingTaskPoll("pwsh", { taskId: "t1", wait: 30 }, "t1"), true);
	assert.equal(isPendingTaskPoll("pwsh", { taskId: "t1", stop: true }, "t1"), false);
	assert.equal(isPendingTaskPoll("pwsh", { taskId: "t2" }, "t1"), false);
	// The rule is the id, not the tool name, so any producer's polling tool is
	// covered: TaskOutput, a subagent result getter, or a tool never seen here.
	assert.equal(isPendingTaskPoll("TaskOutput", { task_id: "t1", block: true }, "t1"), true);
	assert.equal(isPendingTaskPoll("get_subagent_result", { agent_id: "t1" }, "t1"), true);
	assert.equal(isPendingTaskPoll("some_future_tool", { taskId: "t1" }, "t1"), true);
	assert.equal(isPendingTaskPoll("some_future_tool", { id: "t1" }, "t1"), true);
	// Acting on the task is legitimate and never blocked.
	assert.equal(isPendingTaskPoll("TaskStop", { task_id: "t1" }, "t1"), false);
	assert.equal(isPendingTaskPoll("steer_subagent", { agent_id: "t1", message: "hurry" }, "t1"), false);
	assert.equal(isPendingTaskPoll("some_future_tool", { taskId: "t1", action: "cancel" }, "t1"), false);
	assert.equal(isPendingTaskPoll("some_future_tool", { taskId: "t1", cancel: true }, "t1"), false);
	// Unrelated calls and unidentified tasks never match.
	assert.equal(isPendingTaskPoll("read", { file_path: "t1" }, "t1"), false);
	assert.equal(isPendingTaskPoll("TaskOutput", { task_id: "t2" }, "t1"), false);
	assert.equal(isPendingTaskPoll("TaskOutput", { task_id: "t1" }, ""), false);
});

test("a task wait adds no scheduling rows", async t => {
	const h = await fixture(t);
	h.core.scheduler.begin(h.ctx);
	await h.result(h.running("t1"));
	h.core.scheduler.settled(h.ctx);
	const summary = schedulerSummary(h.core.state.goal?.scheduler);
	// The widget's height latches per regime and a wait is not a regime change,
	// so a row added here is head-sliced away and takes the box footer with it.
	assert.doesNotMatch(summary, /\n/, "a task wait must not add scheduling rows");
	assert.match(summary, /Autonomous runs: 0\/unlimited\./, "the runs line stays the first clause");
	assert.match(summary, /Waiting for pwsh task t1 to finish/);
	assert.match(summary, /Next check \d{4}-/);
});

test("a detected task replaces the implicit continuation with a task wait", async t => {
	const h = await fixture(t);
	h.core.scheduler.begin(h.ctx);
	await h.result(h.running("t1"));
	assert.deepEqual(h.core.scheduler.pendingBackgroundTask()?.id, "t1");
	h.core.scheduler.settled(h.ctx);
	const goal = h.core.state.goal!;
	assert.equal(goal.status, "active", "waiting is not a lifecycle stop");
	assert.equal(goal.scheduler?.phase, "waiting");
	assert.equal(goal.scheduler?.wait?.taskId, "t1");
	assert.equal(goal.scheduler?.wait?.remainingChecks, 1);
	assert.match(goal.scheduler?.wait?.reason ?? "", /pwsh task t1/);
	assert.equal(h.sent.length, 0, "the loop must not continue into a poll");
	// ui.notify renders a transient status row that resizes the editor and clips
	// the goal widget, so a routine wait must not announce itself.
	assert.deepEqual(h.notifications, []);
});

test("the task report wakes the goal and drops the wait", async t => {
	const h = await fixture(t);
	t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
	h.core.scheduler.begin(h.ctx);
	await h.result(h.running("t1"));
	h.core.scheduler.settled(h.ctx);
	assert.equal(h.sent.length, 0);
	// The host reports the result on its own and opens a turn for it.
	h.report();
	h.core.scheduler.settled(h.ctx);
	t.mock.timers.tick(1);
	assert.equal(h.sent.length, 1, "the goal continues on the report");
	assert.equal(h.core.state.goal?.scheduler?.wait, undefined);
});

test("a lost report re-checks once, then the standing deadline parks the goal", async t => {
	const h = await fixture(t);
	t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
	h.core.scheduler.begin(h.ctx);
	await h.result(h.running("t1"));
	h.core.scheduler.settled(h.ctx);
	t.mock.timers.tick(BACKGROUND_TASK_WAIT_MS + 1000);
	assert.equal(h.sent.length, 1, "one scheduled re-check");
	assert.equal(h.core.state.goal?.scheduler?.dispatch?.kind, "check");
	// The re-check finds the task still running and waits again on the same deadline.
	h.core.scheduler.message(h.ctx, { ...h.sent.at(-1), role: "custom" });
	await h.result(h.running("t1"));
	h.core.scheduler.settled(h.ctx);
	assert.equal(h.core.state.goal?.scheduler?.phase, "waiting");
	assert.equal(h.core.state.goal?.scheduler?.wait?.taskId, "t1");
	t.mock.timers.tick(BACKGROUND_TASK_WAIT_MS + 1000);
	assert.equal(h.core.state.goal?.status, "paused", "the deadline ends the wait instead of looping");
	assert.match(h.core.state.goal?.pauseReason ?? "", /deadline/i);
	assert.equal(h.sent.length, 1, "no further run is dispatched");
});

test("an unrelated result and an untracked goal keep the normal loop", async t => {
	const h = await fixture(t);
	t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
	h.core.scheduler.begin(h.ctx);
	await h.result({ toolName: "pwsh", details: { version: 1, taskId: "t1", status: "completed" }, isError: false, content: [] });
	assert.equal(h.core.scheduler.pendingBackgroundTask(), null);
	h.core.scheduler.settled(h.ctx);
	t.mock.timers.tick(1);
	assert.equal(h.sent.length, 1, "a finished task is not a wait");
	assert.equal(h.core.state.goal?.scheduler?.wait, undefined);
});

test("the hooks teach the model to stop and refuse a second wait", async t => {
	const h = await fixture(t);
	h.core.scheduler.begin(h.ctx);
	const appended = await h.handlers.tool_result!(h.running("t1"), h.ctx);
	const text = (appended?.content ?? []).map((part: any) => part.text).join("\n");
	assert.match(text, /PI GOAL WAITING ON BACKGROUND TASK/);
	assert.match(text, /Do not wait on or poll this task again/);
	// And must not stop *too* early: work that does not depend on the result
	// belongs to this run, and later-turn work must keep the goal running.
	assert.match(text, /does not depend on that result/);
	assert.match(text, /update_goal\(\{ continuation: \{ kind: "ready"/);
	assert.match(text, /taskId: t1/, "the producer result is preserved");
	const blocked = await h.call("pwsh", { taskId: "t1" });
	assert.equal(blocked?.block, true);
	assert.match(blocked?.reason ?? "", /reported automatically/);
	assert.equal(await h.call("pwsh", { taskId: "t1", stop: true }), undefined);
	assert.equal(await h.call("TaskOutput", { task_id: "t2" }), undefined);
	assert.equal(await h.call("read", { file_path: "a.txt" }), undefined);
});

test("a task wait keeps the latched dashboard height and its box footer", () => {
	// The widget's rendered height latches per regime (goal id/status/state kind).
	// A system wait does not change the regime, so rows it adds are head-sliced
	// away and the box footer is the first casualty.
	const theme = { fg: (_color: string, value: string) => value, bold: (value: string) => value } as never;
	const base = createGoal({ objective: "Wait for detached work", autoContinue: true, sisyphus: false });
	const now = Date.now();
	const waiting = {
		...base,
		scheduler: {
			version: 1 as const, owner: "owner", generation: "gen-1", used: 1,
			phase: "waiting" as const, decision: { kind: "wait" as const },
			wait: { id: "wait-1", token: "token-1", taskId: "t1", reason: "Waiting for pwsh task t1 to finish.", deadline: now + 660_000, intervalMs: 600_000, remainingChecks: 1, nextCheckAt: now + 600_000 },
			repairUsed: false,
		},
	};
	const options = { focused: true, otherOpenGoals: 0, ledgerEvents: [] };
	const before = renderCompactDashboard(deriveGoalDashboardModel(base, options)!, theme, 100);
	const after = renderCompactDashboard(deriveGoalDashboardModel(waiting, options)!, theme, 100);
	assert.match(before.at(-1) ?? "", /^╰/, "the plain dashboard ends with the box footer");
	assert.equal(after.length, before.length, "a task wait must not add widget rows");
	const latched = { stickyCap: undefined as number | undefined, stickyRegime: undefined as string | undefined, stickyTerminalRows: undefined as number | undefined };
	const regime = "same-regime-for-both-renders";
	applyStableHeightBound(before, 30, latched, regime);
	const grown = applyStableHeightBound(after, 30, latched, regime);
	assert.equal(grown.length, before.length, "the latched height holds");
	assert.match(grown.at(-1) ?? "", /^╰/, "the box footer stays in frame while the goal waits");
	assert.match(grown.join("\n"), /Waiting for pwsh task t1/);
});

test("a declared ready decision keeps the goal working while a task runs", async t => {
	const h = await fixture(t);
	t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
	h.core.scheduler.begin(h.ctx);
	await h.result(h.running("t1"));
	// Independent work remains, so the agent keeps the goal running rather than
	// sleeping on the task. The declaration must win over the detected task.
	assert.equal(h.core.scheduler.declare(h.ctx, { kind: "ready", next_action: "Write the independent report while the task runs." }).terminate, true);
	h.core.scheduler.settled(h.ctx);
	t.mock.timers.tick(1);
	assert.equal(h.core.state.goal?.scheduler?.wait, undefined, "no task wait may be raised");
	assert.equal(h.sent.length, 1, "the goal continues with the declared next action");
	assert.equal(h.core.state.goal?.scheduler?.dispatch?.kind, "ready");
});

test("a settle after post-detection work defers the task wait", async t => {
	const h = await fixture(t);
	t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
	h.core.scheduler.begin(h.ctx);
	await h.result(h.running("t1"));
	// Work that does not depend on the task's result must not be stranded behind
	// it, so the settle keeps the goal running instead of sleeping on the task.
	await h.result(h.work());
	h.core.scheduler.settled(h.ctx);
	assert.equal(h.core.state.goal?.scheduler?.wait, undefined, "progress defers the wait");
	assert.equal(h.core.state.goal?.scheduler?.phase, "ready");
	t.mock.timers.tick(1);
	assert.equal(h.sent.length, 1, "exactly one continuation is dispatched");
	const decision = h.core.state.goal?.scheduler?.decision;
	assert.equal(decision?.kind, "ready");
	const nextAction = decision?.kind === "ready" ? decision.nextAction : "";
	assert.match(nextAction, /PI GOAL DEFERRING ON BACKGROUND TASK/);
	assert.match(nextAction, /does not depend on that task's result/);
});

test("a following settle without new work raises the task wait", async t => {
	const h = await fixture(t);
	h.core.scheduler.begin(h.ctx);
	await h.result(h.running("t1"));
	await h.result(h.work());
	h.core.scheduler.settled(h.ctx);
	const first = h.core.state.goal?.scheduler;
	assert.equal(first?.wait, undefined, "the first settle defers");
	// The deferred run does nothing new, so the deferral is bounded: the goal
	// sleeps on the task instead of running forever.
	h.core.scheduler.begin(h.ctx);
	h.core.scheduler.settled(h.ctx);
	assert.equal(h.core.state.goal?.scheduler?.phase, "waiting");
	assert.equal(h.core.state.goal?.scheduler?.wait?.taskId, "t1");
	assert.equal(h.sent.length, 0, "no continuation is dispatched for the wait");
});

test("goal bookkeeping after detection does not defer the task wait", async t => {
	const h = await fixture(t);
	h.core.scheduler.begin(h.ctx);
	await h.result(h.running("t1"));
	// update_goal describes the goal; it is not work that justifies staying up.
	await h.result({ toolName: "update_goal", details: undefined, input: { status: "paused" }, isError: false, content: [] });
	h.core.scheduler.settled(h.ctx);
	assert.equal(h.core.state.goal?.scheduler?.phase, "waiting");
	assert.equal(h.core.state.goal?.scheduler?.wait?.taskId, "t1");
});

test("the launch result itself does not defer the task wait", async t => {
	const h = await fixture(t);
	h.core.scheduler.begin(h.ctx);
	// Starting a task and stopping is not progress: the goal sleeps on it.
	await h.result(h.running("t1"));
	h.core.scheduler.settled(h.ctx);
	assert.equal(h.core.state.goal?.scheduler?.phase, "waiting");
	assert.equal(h.core.state.goal?.scheduler?.wait?.taskId, "t1");
	assert.equal(h.sent.length, 0);
});

test("detection stays inert while the focused goal cannot wait", async t => {
	const h = await fixture(t);
	h.core.scheduler.begin(h.ctx);
	h.core.pauseActiveGoal(h.ctx);
	assert.equal(h.core.state.goal?.status, "paused");
	// A paused goal cannot sleep on a task, so nothing may announce a wait and
	// nothing may refuse a poll the user might legitimately ask for.
	assert.equal(await h.handlers.tool_result!(h.running("t1"), h.ctx), undefined);
	assert.equal(h.core.scheduler.pendingBackgroundTask(), null);
	assert.equal(await h.call("pwsh", { taskId: "t1" }), undefined);
	h.core.scheduler.settled(h.ctx);
	assert.equal(h.core.state.goal?.scheduler?.wait, undefined, "no wait is raised for a paused goal");
	assert.equal(h.sent.length, 0);
});
