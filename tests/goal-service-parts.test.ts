/**
 * Unit tests for the storage-free parts of GoalService: the reconcile plan, the
 * task-update helpers, the usage baseline and the turn buffer. None of these
 * touch the disk or a session.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createGoal, type GoalRecord, type GoalTask } from "../extensions/goal-record.ts";
import { planReconcile } from "../extensions/goal-reconcile.ts";
import { applyTaskBatch, applyTaskUpdate, resolveUpdatedCurrentTaskId, withUpdatedTask } from "../extensions/goal-task-update.ts";
import { UsageBaseline, addUsage, usageSince } from "../extensions/goal-usage-baseline.ts";
import { TurnBuffer } from "../extensions/goal-turn-buffer.ts";
import type { GoalTaskUpdateSpec } from "../extensions/goal-service-types.ts";

const goal = (id: string, extra: Partial<GoalRecord> = {}): GoalRecord => ({ ...createGoal({ objective: `Objective for ${id} with enough words`, autoContinue: false, sisyphus: false }), id, ...extra });
const task = (id: string, status: GoalTask["status"] = "pending", subtasks?: GoalTask[]): GoalTask => ({ id, title: `Task ${id}`, status, ...(subtasks ? { subtasks } : {}) });
const withTasks = (g: GoalRecord, tasks: GoalTask[]): GoalRecord => ({ ...g, taskList: { tasks } } as GoalRecord);
const completing = (taskId: string, extra: Partial<GoalTaskUpdateSpec> = {}): GoalTaskUpdateSpec => ({
	taskId, update: t => ({ ...t, status: "complete" }), ...extra,
});

describe("planReconcile", () => {
	it("reports no change when memory matches the disk", () => {
		const a = goal("a");
		const plan = planReconcile({ current: a, focusedGoalId: "a", view: new Map([["a", a]]), source: new Map([["a", a]]), buffered: null });
		assert.deepEqual(plan, { kind: "unchanged", goal: a });
	});

	it("treats the buffered goal as the memory copy of its disk record", () => {
		const disk = goal("a");
		const buffered = { ...disk, revision: 5 };
		const plan = planReconcile({ current: buffered, focusedGoalId: "a", view: new Map([["a", buffered]]), source: new Map([["a", disk]]), buffered });
		assert.equal(plan.kind, "unchanged");
	});

	it("only takes the pool when nothing is focused", () => {
		const a = goal("a");
		const plan = planReconcile({ current: null, focusedGoalId: null, view: new Map(), source: new Map([["a", a]]), buffered: null });
		assert.equal(plan.kind, "pool-only");
		assert.deepEqual([...(plan as { pool: Map<string, GoalRecord> }).pool.keys()], ["a"]);
	});

	it("adopts the disk record of the focused goal", () => {
		const memory = goal("a", { revision: 1 });
		const disk = goal("a", { revision: 2 });
		const plan = planReconcile({ current: memory, focusedGoalId: "a", view: new Map([["a", memory]]), source: new Map([["a", disk]]), buffered: null });
		assert.equal(plan.kind, "focus");
		assert.equal((plan as { goal: GoalRecord }).goal, disk);
		assert.equal((plan as { fromDisk: boolean }).fromDisk, true);
	});

	it("keeps the memory usage on top of the disk record when asked", () => {
		const memory = goal("a", { revision: 1, usage: { tokensUsed: 500, activeSeconds: 50 } });
		const disk = goal("a", { revision: 2, usage: { tokensUsed: 100, activeSeconds: 10 } });
		const plan = planReconcile({ current: memory, focusedGoalId: "a", view: new Map([["a", memory]]), source: new Map([["a", disk]]), buffered: null, preserveMemoryUsage: true });
		assert.equal(plan.kind, "focus");
		const merged = (plan as { goal: GoalRecord }).goal;
		assert.equal(merged.revision, 2);
		assert.ok(merged.usage.tokensUsed >= 500);
	});

	it("keeps a goal that has no file yet, and reports one whose file vanished as lost", () => {
		const unsaved = goal("a");
		const kept = planReconcile({ current: unsaved, focusedGoalId: "a", view: new Map([["a", unsaved]]), source: new Map(), buffered: null });
		assert.equal(kept.kind, "focus");
		assert.equal((kept as { fromDisk: boolean }).fromDisk, false);
		const saved = goal("a", { activePath: "a.md" });
		const lost = planReconcile({ current: saved, focusedGoalId: "a", view: new Map([["a", saved]]), source: new Map(), buffered: null });
		assert.deepEqual({ kind: lost.kind, lostGoalId: (lost as { lostGoalId: string | null }).lostGoalId }, { kind: "lost", lostGoalId: "a" });
	});

	it("overlays the buffered goal on the disk pool", () => {
		const disk = goal("a", { revision: 1 });
		const buffered = { ...disk, revision: 2, objective: "Buffered objective with enough words" };
		const plan = planReconcile({ current: buffered, focusedGoalId: "a", view: new Map(), source: new Map([["a", disk]]), buffered });
		assert.equal(plan.kind, "focus");
		assert.equal((plan as { goal: GoalRecord }).goal, buffered);
	});
});

describe("task update helpers", () => {
	it("reports a missing task, a failed validation and a failed update", () => {
		const tasks = [task("t1")];
		assert.deepEqual(applyTaskUpdate(tasks, completing("nope")), { ok: false, message: 'Task "nope" not found.' });
		assert.deepEqual(applyTaskUpdate(tasks, completing("t1", { validate: () => ({ ok: false, message: "no" }) })), { ok: false, message: "no" });
		assert.deepEqual(applyTaskUpdate(tasks, { taskId: "t1", update: () => ({ ok: false, message: "bad update" }) }), { ok: false, message: "bad update" });
	});

	it("updates only the named task", () => {
		const applied = applyTaskUpdate([task("t1"), task("t2")], completing("t2"));
		assert.ok(applied.ok);
		assert.deepEqual(applied.updatedTasks.map(t => t.status), ["pending", "complete"]);
	});

	it("clears the current task when it ends, and sets it on start", () => {
		const done = task("t1", "complete");
		assert.equal(resolveUpdatedCurrentTaskId(completing("t1"), "t1", done), undefined);
		assert.equal(resolveUpdatedCurrentTaskId(completing("t1"), "t2", done), "t2");
		assert.equal(resolveUpdatedCurrentTaskId(completing("t1", { setCurrentTaskId: "t3" }), "t1", done), "t3");
	});

	it("stamps the goal with the given revision", () => {
		const base = withTasks(goal("a", { currentTaskId: "t1" }), [task("t1")]);
		const applied = applyTaskUpdate(base.taskList!.tasks, completing("t1"));
		assert.ok(applied.ok);
		const next = withUpdatedTask(base, completing("t1"), applied.updatedTask, applied.updatedTasks, 9);
		assert.equal(next.revision, 9);
		assert.equal(next.currentTaskId, undefined);
		assert.equal(next.taskList!.tasks[0]!.status, "complete");
	});

	it("applies a batch in order so later updates see earlier ones", () => {
		const next = withTasks(goal("a"), [task("t1"), task("t2", "pending", [task("t2a")])]);
		const seen: string[] = [];
		const result = applyTaskBatch(next, [
			completing("t2a"),
			completing("t2", { validate: t => { seen.push(t.subtasks!.map(s => s.status).join()); return { ok: true }; } }),
		], () => true);
		assert.ok(result.ok);
		assert.deepEqual(seen, ["complete"]);
		assert.equal(next.taskList!.tasks[1]!.status, "complete");
	});

	it("stops a batch at the first failure and at a stale focus token", () => {
		const next = withTasks(goal("a"), [task("t1")]);
		assert.deepEqual(applyTaskBatch(next, [completing("missing")], () => true), { ok: false, message: 'Task "missing" not found.' });
		const stale = applyTaskBatch(next, [completing("t1", { focusToken: { goalId: "a", revision: 1 } })], () => false);
		assert.deepEqual(stale, { ok: false, message: "The focused goal changed; no updates applied." });
	});
});

describe("usage baseline", () => {
	it("never reports a negative delta", () => {
		assert.deepEqual(usageSince({ tokensUsed: 5, activeSeconds: 1 }, { tokensUsed: 9, activeSeconds: 0 }), { tokens: 0, seconds: 1 });
	});

	it("adds a delta onto a usage", () => {
		assert.deepEqual(addUsage({ tokensUsed: 10, activeSeconds: 2 }, { tokens: 3, seconds: 4 }), { tokensUsed: 13, activeSeconds: 6 });
	});

	it("measures from the tracked usage, or from the disk when none is tracked for the goal", () => {
		const baseline = new UsageBaseline();
		const current = goal("a", { usage: { tokensUsed: 100, activeSeconds: 10 } });
		const disk = goal("a", { usage: { tokensUsed: 60, activeSeconds: 6 } });
		assert.deepEqual(baseline.deltaFor(current, disk), { tokens: 40, seconds: 4 });
		baseline.track("a", { tokensUsed: 90, activeSeconds: 9 });
		assert.deepEqual(baseline.deltaFor(current, disk), { tokens: 10, seconds: 1 });
		baseline.track("other", { tokensUsed: 0, activeSeconds: 0 });
		assert.deepEqual(baseline.deltaFor(current, disk), { tokens: 40, seconds: 4 });
		baseline.track("a", { tokensUsed: 90, activeSeconds: 9 });
		baseline.clear();
		assert.deepEqual(baseline.deltaFor(current, disk), { tokens: 40, seconds: 4 });
	});
});

describe("turn buffer", () => {
	const ctx = { cwd: "/tmp/goal-turn-buffer-test" } as never;

	it("starts empty and snapshots the focused goal as its base", () => {
		const buffer = new TurnBuffer();
		const focused = goal("a", { usage: { tokensUsed: 1, activeSeconds: 1 } });
		buffer.open(ctx, "a", focused);
		assert.equal(buffer.active, true);
		assert.equal(buffer.goal, null);
		assert.notEqual(buffer.base, focused);
		assert.notEqual(buffer.base!.usage, focused.usage);
		assert.deepEqual(buffer.base!.usage, focused.usage);
	});

	it("keeps the first base when a goal is staged, and starts over on a switch", () => {
		const buffer = new TurnBuffer();
		const a = goal("a");
		buffer.open(ctx, null, a);
		const base = buffer.base;
		buffer.stage({ ...a, revision: 3 });
		assert.equal(buffer.base, base);
		assert.equal(buffer.goalId, "a");
		const b = goal("b");
		buffer.ledger.push({ type: "goal_paused" } as never);
		buffer.switchTo(b);
		assert.deepEqual({ goalId: buffer.goalId, goal: buffer.goal, base: buffer.base, ledger: buffer.ledger }, { goalId: "b", goal: b, base: b, ledger: [] });
	});

	it("drops its record and events on reject, and everything on reset", () => {
		const buffer = new TurnBuffer();
		buffer.open(ctx, "a", goal("a"));
		buffer.stage(goal("a"));
		buffer.ledger.push({ type: "goal_paused" } as never);
		buffer.flushError = "kept";
		buffer.reject();
		assert.deepEqual({ active: buffer.active, goal: buffer.goal, ledger: buffer.ledger, flushError: buffer.flushError }, { active: false, goal: null, ledger: [], flushError: "kept" });
		buffer.reset();
		assert.deepEqual({ goalId: buffer.goalId, base: buffer.base, context: buffer.context }, { goalId: null, base: null, context: null });
	});

	it("only matches the storage root it was opened on", () => {
		const buffer = new TurnBuffer();
		assert.equal(buffer.sameStorage(ctx), false);
		buffer.open(ctx, "a", null);
		assert.equal(buffer.sameStorage(ctx), true);
		assert.equal(buffer.sameStorage({ cwd: "/tmp/somewhere-else" } as never), false);
	});
});
