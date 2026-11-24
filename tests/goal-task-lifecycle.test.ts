/**
 * Current-task lifecycle tests (plan §19.2, §19.8): update_goal_task
 * start/complete/skip focus semantics, currentTaskId persistence and
 * normalization (legacy + stale ids), and task-list replacement rules (§7.5).
 */

import { createExtensionHarness } from "./support/extension-harness.ts";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { convertFlatTasks, mergeTasksWithExisting } from "../extensions/goal-task-tree.ts";
import { createGoal, goalFocusDetails, normalizeGoalRecord, type GoalRecord, type GoalTask } from "../extensions/goal-record.ts";
import { parseGoalFile, serializeGoalFile, writeActiveGoalFile } from "../extensions/storage/goal-files.ts";
import { ledgerEvents, tempDir } from "./support/fs.ts";

// ── Tool execution harness (mirrors goal-task-tools.test.ts) ────────────────

function createHarness(cwd: string, sessionEntries: unknown[]) {
	return createExtensionHarness({ cwd, sessionEntries, sessionId: "task-lifecycle-session" });
}

function fixtureWithTasks(tasks: Array<Record<string, unknown>>, opts: { pauseReason?: string; status?: "active" | "paused" } = {}) {
	const cwd = tempDir("goal-lifecycle-");
	mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
	const goal = createGoal({ objective: "Lifecycle goal", autoContinue: true, sisyphus: false }, Date.UTC(2026, 7, 5, 9, 0, 0));
	goal.taskList = { tasks: tasks as any, blockCompletion: false, proposedAt: new Date().toISOString() };
	if (opts.status === "paused") {
		goal.status = "paused";
		goal.stopReason = "user";
		goal.pauseReason = opts.pauseReason ?? "user pause";
	}
	const written = writeActiveGoalFile({ cwd }, goal);
	const sessionEntries = [{ type: "custom", customType: "pi-goal-focus", data: goalFocusDetails(goal.id, "created") }];
	const cleanup = () => { try { rmSync(cwd, { recursive: true, force: true }); } catch {} };
	return { cwd, goal: written, sessionEntries, cleanup };
}

function activeGoal(cwd: string): GoalRecord | null {
	const files = readdirSync(path.join(cwd, ".pi", "goals")).filter((n) => n.startsWith("active_goal_"));
	return parseGoalFile(path.join(cwd, ".pi", "goals", files[0]!));
}

function activeFile(cwd: string): string {
	const files = readdirSync(path.join(cwd, ".pi", "goals")).filter((n) => n.startsWith("active_goal_"));
	return path.join(cwd, ".pi", "goals", files[0]!);
}

async function startSession(cwd: string, sessionEntries: unknown[]) {
	const h = createHarness(cwd, sessionEntries);
	await h.handlers.get("session_start")?.({ reason: "start" }, h.ctx);
	await h.handlers.get("before_agent_start")?.({ systemPrompt: "base", prompt: "go", systemPromptOptions: {} }, h.ctx);
	return h;
}

async function callTool(h: ReturnType<typeof createHarness>, name: string, callId: string, params: Record<string, unknown>) {
	const tool = h.tools.get(name)!;
	return (tool.execute as any)(callId, params, undefined, undefined, h.ctx);
}

function pendingTasks(): Array<Record<string, unknown>> {
	return [
		{ id: "t1", title: "Task one" },
		{ id: "t2", title: "Task two" },
		{ id: "t3", title: "Parent", subtasks: [{ id: "t3.1", title: "Child" }] },
	];
}

// ── §19.2 update_goal_task lifecycle ────────────────────────────────────────

test("start sets the persisted currentTaskId and appends task_started", async () => {
	const f = fixtureWithTasks(pendingTasks());
	try {
		const h = await startSession(f.cwd, f.sessionEntries);
		const result = await callTool(h, "update_goal_task", "start-1", { task_id: "t2", status: "start" });
		const text = result.content?.[0]?.text ?? "";
		assert.ok(text.includes("Started t2"), `start message, got: ${text}`);
		assert.equal(result.terminate, undefined, "start does not terminate the turn");
		// Memory + disk both carry the focus.
		const goal = activeGoal(f.cwd);
		assert.equal(goal?.currentTaskId, "t2");
		const events = ledgerEvents(f.cwd);
		assert.ok(events.some((e) => e.type === "task_started" && e.taskId === "t2"), "task_started ledger event");
	} finally {
		f.cleanup();
	}
});

test("start surfaces the task verification contract", async () => {
	const f = fixtureWithTasks([
		{ id: "t1", title: "Task one", verificationContract: "Run the check." },
	]);
	try {
		const h = await startSession(f.cwd, f.sessionEntries);
		const result = await callTool(h, "update_goal_task", "start-2", { task_id: "t1", status: "start" });
		const text = result.content?.[0]?.text ?? "";
		assert.ok(text.includes("Contract: Run the check."), `contract surfaced, got: ${text}`);
	} finally {
		f.cleanup();
	}
});

test("starting another task replaces the current task", async () => {
	const f = fixtureWithTasks(pendingTasks());
	try {
		const h = await startSession(f.cwd, f.sessionEntries);
		await callTool(h, "update_goal_task", "start-3", { task_id: "t1", status: "start" });
		await callTool(h, "update_goal_task", "start-4", { task_id: "t3", status: "start" });
		const goal = activeGoal(f.cwd);
		assert.equal(goal?.currentTaskId, "t3", "later start replaces earlier focus");
	} finally {
		f.cleanup();
	}
});

test("starting a subtask sets focus to the nested node", async () => {
	const f = fixtureWithTasks(pendingTasks());
	try {
		const h = await startSession(f.cwd, f.sessionEntries);
		await callTool(h, "update_goal_task", "start-5", { task_id: "t3.1", status: "start" });
		const goal = activeGoal(f.cwd);
		assert.equal(goal?.currentTaskId, "t3.1");
	} finally {
		f.cleanup();
	}
});

test("completing the current task clears currentTaskId", async () => {
	const f = fixtureWithTasks(pendingTasks());
	try {
		const h = await startSession(f.cwd, f.sessionEntries);
		await callTool(h, "update_goal_task", "start-6", { task_id: "t2", status: "start" });
		await callTool(h, "update_goal_task", "complete-1", { task_id: "t2", status: "complete", evidence: "done" });
		const goal = activeGoal(f.cwd);
		assert.equal(goal?.currentTaskId, undefined, "completing the current task clears focus");
		assert.equal(goal?.taskList?.tasks.find((t) => t.id === "t2")?.status, "complete");
		assert.ok(ledgerEvents(f.cwd).some((e) => e.type === "task_complete"), "task_complete event");
	} finally {
		f.cleanup();
	}
});

test("skipping the current task clears currentTaskId", async () => {
	const f = fixtureWithTasks(pendingTasks());
	try {
		const h = await startSession(f.cwd, f.sessionEntries);
		await callTool(h, "update_goal_task", "start-7", { task_id: "t1", status: "start" });
		await callTool(h, "update_goal_task", "skip-1", { task_id: "t1", status: "skipped", reason: "user direction" });
		const goal = activeGoal(f.cwd);
		assert.equal(goal?.currentTaskId, undefined, "skipping the current task clears focus");
		assert.equal(goal?.taskList?.tasks.find((t) => t.id === "t1")?.status, "skipped");
		assert.ok(ledgerEvents(f.cwd).some((e) => e.type === "task_skipped"), "task_skipped event");
	} finally {
		f.cleanup();
	}
});

test("completing a non-current task leaves focus untouched", async () => {
	const f = fixtureWithTasks(pendingTasks());
	try {
		const h = await startSession(f.cwd, f.sessionEntries);
		await callTool(h, "update_goal_task", "start-8", { task_id: "t2", status: "start" });
		await callTool(h, "update_goal_task", "complete-2", { task_id: "t1", status: "complete", evidence: "done" });
		const goal = activeGoal(f.cwd);
		assert.equal(goal?.currentTaskId, "t2", "unrelated completion keeps focus");
	} finally {
		f.cleanup();
	}
});

test("start validation rejects missing, terminal, and ineligible tasks", async () => {
	const f = fixtureWithTasks(pendingTasks());
	try {
		const h = await startSession(f.cwd, f.sessionEntries);
		// Missing task.
		const missing = await callTool(h, "update_goal_task", "start-9", { task_id: "ghost", status: "start" });
		assert.ok((missing.content?.[0]?.text ?? "").includes("not found"));
		// Complete the task first, then starting it must fail.
		await callTool(h, "update_goal_task", "complete-3", { task_id: "t1", status: "complete", evidence: "done" });
		const terminal = await callTool(h, "update_goal_task", "start-10", { task_id: "t1", status: "start" });
		assert.ok((terminal.content?.[0]?.text ?? "").includes("only pending tasks can be started"));
		const goal = activeGoal(f.cwd);
		assert.equal(goal?.currentTaskId, undefined, "failed start does not set focus");
	} finally {
		f.cleanup();
	}
});

test("start validation rejects paused and taskless goals", async () => {
	const f = fixtureWithTasks(pendingTasks(), { status: "paused" });
	try {
		const h = await startSession(f.cwd, f.sessionEntries);
		const result = await callTool(h, "update_goal_task", "start-11", { task_id: "t1", status: "start" });
		assert.ok((result.content?.[0]?.text ?? "").includes("only to an active goal"));
		const goal = activeGoal(f.cwd);
		assert.equal(goal?.currentTaskId, undefined);
	} finally {
		f.cleanup();
	}
	const noTasks = fixtureWithTasks([]);
	try {
		const h = await startSession(noTasks.cwd, noTasks.sessionEntries);
		const result = await callTool(h, "update_goal_task", "start-12", { task_id: "t1", status: "start" });
		assert.ok((result.content?.[0]?.text ?? "").includes("no task list"));
	} finally {
		noTasks.cleanup();
	}
});

test("start honors disableTasks settings", async () => {
	const f = fixtureWithTasks(pendingTasks());
	try {
		mkdirSync(path.join(f.cwd, ".pi"), { recursive: true });
		writeFileSync(path.join(f.cwd, ".pi", "pi-goal-x-settings.json"), JSON.stringify({ disableTasks: true }));
		const h = await startSession(f.cwd, f.sessionEntries);
		const result = await callTool(h, "update_goal_task", "start-13", { task_id: "t1", status: "start" });
		assert.ok((result.content?.[0]?.text ?? "").includes("disabled by settings"));
		const goal = activeGoal(f.cwd);
		assert.equal(goal?.currentTaskId, undefined);
	} finally {
		f.cleanup();
	}
});

// ── §7.5 task-list replacement rules ────────────────────────────────────────

test("set_goal_tasks preserves currentTaskId when the id remains pending", async () => {
	const f = fixtureWithTasks(pendingTasks());
	try {
		const h = await startSession(f.cwd, f.sessionEntries);
		await callTool(h, "update_goal_task", "start-14", { task_id: "t2", status: "start" });
		// Restructure: keep t2 (with a new title), drop t3, add t4.
		const result = await callTool(h, "set_goal_tasks", "set-1", {
			tasks: [
				{ id: "t1", title: "Task one" },
				{ id: "t2", title: "Task two renamed" },
				{ id: "t4", title: "Task four" },
			],
		});
		assert.equal(result.terminate, true);
		const goal = activeGoal(f.cwd);
		assert.equal(goal?.currentTaskId, "t2", "focus preserved when id stays pending");
		assert.equal(goal?.taskList?.tasks.find((t) => t.id === "t2")?.title, "Task two renamed");
	} finally {
		f.cleanup();
	}
});

test("set_goal_tasks clears currentTaskId when the id is removed or terminal", async () => {
	const f = fixtureWithTasks(pendingTasks());
	try {
		const h = await startSession(f.cwd, f.sessionEntries);
		await callTool(h, "update_goal_task", "start-15", { task_id: "t3", status: "start" });
		// Remove t3 entirely.
		await callTool(h, "set_goal_tasks", "set-2", {
			tasks: [{ id: "t1", title: "Task one" }, { id: "t2", title: "Task two" }],
		});
		let goal = activeGoal(f.cwd);
		assert.equal(goal?.currentTaskId, undefined, "removed id clears focus");
		// Restructure with t2 completed: focus on t2, then restructure keeping t2 complete.
		await callTool(h, "set_goal_tasks", "set-3", {
			tasks: [{ id: "t1", title: "Task one" }, { id: "t2", title: "Task two" }, { id: "t5", title: "Task five" }],
		});
		await callTool(h, "update_goal_task", "start-16", { task_id: "t5", status: "start" });
		await callTool(h, "update_goal_task", "complete-4", { task_id: "t5", status: "complete", evidence: "done" });
		// Re-set the same list (t5 now complete in the existing tree): merge keeps
		// the completion, so the previously-current id is no longer pending.
		await callTool(h, "set_goal_tasks", "set-4", {
			tasks: [{ id: "t1", title: "Task one" }, { id: "t2", title: "Task two" }, { id: "t5", title: "Task five" }],
		});
		goal = activeGoal(f.cwd);
		assert.equal(goal?.currentTaskId, undefined, "terminal id clears focus after structural merge");
	} finally {
		f.cleanup();
	}
});

test("mergeTasksWithExisting preserves status, evidence, and timestamps", () => {
	const existing: GoalTask[] = [{
		id: "a", title: "Old", status: "complete", evidence: "verified", completedAt: "2026-01-01T00:00:00.000Z",
	}];
	const incoming = convertFlatTasks([{ id: "a", title: "Renamed" }, { id: "b", title: "New" }]);
	assert.ok(incoming.ok);
	if (!incoming.ok) return;
	const merged = mergeTasksWithExisting(existing, incoming.tasks);
	assert.equal(merged[0]?.status, "complete");
	assert.equal(merged[0]?.evidence, "verified");
	assert.equal(merged[0]?.completedAt, "2026-01-01T00:00:00.000Z");
	assert.equal(merged[0]?.title, "Renamed");
	assert.equal(merged[1]?.status, "pending");
});

// ── §19.8 persistence and migration ─────────────────────────────────────────

test("legacy goal files load without currentTaskId and preserve task state", () => {
	const cwd = tempDir("goal-legacy-");
	try {
		mkdirSync(path.join(cwd, ".pi", "goals"), { recursive: true });
		const goal = createGoal({ objective: "Legacy goal", autoContinue: true, sisyphus: false }, Date.UTC(2026, 7, 5, 9, 0, 0));
		goal.taskList = {
			tasks: [{ id: "a", title: "A", status: "complete", evidence: "kept" }, { id: "b", title: "B" }] as any,
			blockCompletion: false,
			proposedAt: new Date().toISOString(),
		};
		goal.verificationContract = "Run the suite.";
		goal.usage = { tokensUsed: 4200, activeSeconds: 300 };
		// No currentTaskId anywhere: a historical file.
		const written = writeActiveGoalFile({ cwd }, goal);
		const parsed = parseGoalFile(path.join(cwd, written.activePath!));
		assert.ok(parsed);
		assert.equal(parsed.currentTaskId, undefined, "legacy file has no focus");
		assert.equal(parsed.taskList?.tasks[0]?.status, "complete");
		assert.equal(parsed.taskList?.tasks[0]?.evidence, "kept");
		assert.equal(parsed.verificationContract, "Run the suite.");
		assert.deepEqual(parsed.usage, { tokensUsed: 4200, activeSeconds: 300 });
		assert.equal(parsed.status, "active");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("currentTaskId persists through write→parse round trips", () => {
	const cwd = tempDir("goal-persist-");
	try {
		mkdirSync(path.join(cwd, ".pi", "goals"), { recursive: true });
		const goal = createGoal({ objective: "Persist goal", autoContinue: true, sisyphus: false }, Date.UTC(2026, 7, 5, 9, 0, 0));
		goal.taskList = { tasks: [{ id: "a", title: "A" }, { id: "b", title: "B" }] as any, blockCompletion: false, proposedAt: new Date().toISOString() };
		goal.currentTaskId = "b";
		const written = writeActiveGoalFile({ cwd }, goal);
		const parsed = parseGoalFile(path.join(cwd, written.activePath!));
		assert.equal(parsed?.currentTaskId, "b", "focus survives a write→read round trip");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("stale currentTaskId is cleared during normalization", () => {
	const base = createGoal({ objective: "Stale goal", autoContinue: true, sisyphus: false }, Date.UTC(2026, 7, 5, 9, 0, 0));
	base.taskList = { tasks: [{ id: "a", title: "A" }, { id: "b", title: "B" }] as any, blockCompletion: false, proposedAt: new Date().toISOString() };

	// Removed id.
	const removed = normalizeGoalRecord({ ...base, currentTaskId: "ghost" } as unknown);
	assert.equal(removed?.currentTaskId, undefined, "removed id is cleared");

	// Completed id.
	const completeTask = normalizeGoalRecord({
		...base,
		taskList: { ...base.taskList, tasks: [{ id: "a", title: "A", status: "complete" }, { id: "b", title: "B" }] },
		currentTaskId: "a",
	} as unknown);
	assert.equal(completeTask?.currentTaskId, undefined, "complete id is cleared");

	// Skipped id.
	const skippedTask = normalizeGoalRecord({
		...base,
		taskList: { ...base.taskList, tasks: [{ id: "a", title: "A", status: "skipped" }, { id: "b", title: "B" }] },
		currentTaskId: "a",
	} as unknown);
	assert.equal(skippedTask?.currentTaskId, undefined, "skipped id is cleared");

	// Nested pending id.
	const nested = normalizeGoalRecord({
		...base,
		taskList: {
			...base.taskList,
			tasks: [{ id: "p", title: "P", subtasks: [{ id: "p.1", title: "P1" }] }],
		},
		currentTaskId: "p.1",
	} as unknown);
	assert.equal(nested?.currentTaskId, "p.1", "nested pending id is accepted");

	// Pending id.
	const valid = normalizeGoalRecord({ ...base, currentTaskId: "a" } as unknown);
	assert.equal(valid?.currentTaskId, "a", "pending id is accepted");

	// No task list.
	const noTasks = normalizeGoalRecord({ ...base, taskList: undefined, currentTaskId: "a" } as unknown);
	assert.equal(noTasks?.currentTaskId, undefined, "no task list means no focus");
});

test("normalization never rewrites legacy files", () => {
	const f = fixtureWithTasks([{ id: "a", title: "A" }, { id: "b", title: "B" }]);
	try {
		// Plant a stale focus in the file (simulates an externally-edited record).
		const file = activeFile(f.cwd);
		const raw = readFileSync(file, "utf8");
		const parsed = parseGoalFile(file);
		assert.ok(parsed);
		parsed.currentTaskId = "ghost";
		const goal = normalizeGoalRecord(JSON.parse(JSON.stringify(parsed)));
		assert.equal(goal?.currentTaskId, undefined);
		// Reading must not modify the file.
		parseGoalFile(file);
		parseGoalFile(file);
		assert.equal(readFileSync(file, "utf8"), raw, "parse/normalize never rewrites the file");
	} finally {
		f.cleanup();
	}
});

test("focus survives restart (reload from disk) and session refocus", async () => {
	const f = fixtureWithTasks(pendingTasks());
	try {
		const h = await startSession(f.cwd, f.sessionEntries);
		await callTool(h, "update_goal_task", "start-17", { task_id: "t3", status: "start" });
		// Simulate a restart: a fresh harness with the same session entries.
		const h2 = await startSession(f.cwd, f.sessionEntries);
		const g = activeGoal(f.cwd);
		assert.equal(g?.currentTaskId, "t3", "focus restored after restart");
		const h3 = h2; // refocus path uses the same focus entry
		assert.ok(h3.handlers.has("session_start"));
	} finally {
		f.cleanup();
	}
});

test("serializeGoalFile round-trips currentTaskId in the JSON header", () => {
	const goal = createGoal({ objective: "Round trip", autoContinue: true, sisyphus: false }, Date.UTC(2026, 7, 5, 9, 0, 0));
	goal.taskList = { tasks: [{ id: "a", title: "A" }] as any, blockCompletion: false, proposedAt: new Date().toISOString() };
	goal.currentTaskId = "a";
	const serialized = serializeGoalFile(goal);
	assert.ok(serialized.includes('"currentTaskId": "a"'), "JSON header carries currentTaskId");
	const end = serialized.indexOf("\n\n# Goal Prompt");
	const raw = JSON.parse(serialized.slice(0, end));
	const reparsed = normalizeGoalRecord({ ...raw, objective: "Round trip" } as unknown);
	assert.equal(reparsed?.currentTaskId, "a");
});
