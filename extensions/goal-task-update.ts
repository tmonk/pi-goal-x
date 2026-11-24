import { nowIso, type GoalRecord, type GoalTask } from "./goal-record.ts";
import type { GoalLedgerEvent } from "./goal-ledger.ts";
import { findTaskInTree, updateTaskInTree } from "./goal-policy.ts";
import type { GoalTaskUpdateSpec } from "./goal-service-types.ts";

/**
 * Task-update logic with no storage: finding and validating the task, applying
 * the update and working out the goal's execution focus. The service wraps these
 * in its locks, writes and ledger appends.
 */

type Failure = { ok: false; message: string };

/** Find the spec's task, validate it and apply its update, without touching the goal. */
export function applyTaskUpdate(tasks: GoalTask[], spec: GoalTaskUpdateSpec): Failure | { ok: true; updatedTask: GoalTask; updatedTasks: GoalTask[] } {
	const task = findTaskInTree(tasks, spec.taskId);
	if (!task) return { ok: false, message: `Task "${spec.taskId}" not found.` };
	if (spec.validate) {
		const gate = spec.validate(task);
		if (!gate.ok) return gate;
	}
	const updated = spec.update(task);
	if (typeof updated === "object" && "ok" in updated && !updated.ok) return updated;
	const updatedTask = updated as GoalTask;
	return { ok: true, updatedTask, updatedTasks: updateTaskInTree(tasks, spec.taskId, () => updatedTask) };
}

export function resolveUpdatedCurrentTaskId(spec: GoalTaskUpdateSpec, current: string | undefined, updatedTask: GoalTask): string | undefined {
	if (spec.setCurrentTaskId !== undefined) return spec.setCurrentTaskId;
	const terminal = updatedTask.status === "complete" || updatedTask.status === "skipped";
	if (terminal && current === spec.taskId) return undefined;
	return current;
}

/** The goal with one task's update applied, stamped with `revision`. */
export function withUpdatedTask(base: GoalRecord, spec: GoalTaskUpdateSpec, updatedTask: GoalTask, updatedTasks: GoalTask[], revision: number): GoalRecord {
	return {
		...base,
		taskList: { ...base.taskList!, tasks: updatedTasks },
		// Execution focus: start sets it explicitly; completing or skipping the
		// current task clears it.
		currentTaskId: resolveUpdatedCurrentTaskId(spec, base.currentTaskId, updatedTask),
		updatedAt: nowIso(),
		revision,
	};
}

/** Where every task of a tree lives, kept current as batch updates replace tasks. */
class TaskLocator {
	private readonly locations = new Map<string, { tasks: GoalTask[]; index: number }>();

	constructor(tasks: GoalTask[]) {
		this.add(tasks);
	}

	find(taskId: string): GoalTask | undefined {
		const location = this.locations.get(taskId);
		return location?.tasks[location.index];
	}

	/** Swap `task` for `updated` in place, following id and subtask changes. */
	replace(task: GoalTask, updated: GoalTask): void {
		const location = this.locations.get(task.id)!;
		location.tasks[location.index] = updated;
		if (updated.id !== task.id) {
			this.locations.delete(task.id);
			this.locations.set(updated.id, location);
		}
		if (updated.subtasks !== task.subtasks) {
			if (task.subtasks) this.remove(task.subtasks);
			if (updated.subtasks) this.add(updated.subtasks);
		}
	}

	private add(tasks: GoalTask[]): void {
		for (let index = 0; index < tasks.length; index++) {
			const task = tasks[index]!;
			this.locations.set(task.id, { tasks, index });
			if (task.subtasks) this.add(task.subtasks);
		}
	}

	private remove(tasks: GoalTask[]): void {
		for (const task of tasks) {
			this.locations.delete(task.id);
			if (task.subtasks) this.remove(task.subtasks);
		}
	}
}

/**
 * Apply an ordered batch to `next`, a clone the caller owns. Each validator sees
 * the earlier changes. Returns the ledger events the batch produced, or the
 * first failure (the clone is then abandoned).
 */
export function applyTaskBatch(
	next: GoalRecord,
	specs: GoalTaskUpdateSpec[],
	isTokenCurrent: (token: { goalId: string; revision: number }) => boolean,
): Failure | { ok: true; events: GoalLedgerEvent[] } {
	const locator = new TaskLocator(next.taskList!.tasks);
	const events: GoalLedgerEvent[] = [];
	for (const spec of specs) {
		if (spec.focusToken && !isTokenCurrent(spec.focusToken)) return { ok: false, message: "The focused goal changed; no updates applied." };
		const task = locator.find(spec.taskId);
		if (!task) return { ok: false, message: `Task "${spec.taskId}" not found.` };
		const valid = spec.validate?.(task);
		if (valid && !valid.ok) return valid;
		const updated = spec.update(task);
		if ("ok" in updated && !updated.ok) return updated;
		const updatedTask = updated as GoalTask;
		locator.replace(task, updatedTask);
		next.currentTaskId = resolveUpdatedCurrentTaskId(spec, next.currentTaskId, updatedTask);
		next.updatedAt = nowIso();
		if (spec.ledger) events.push(...spec.ledger(next, updatedTask));
	}
	return { ok: true, events };
}
