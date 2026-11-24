/**
 * Single task-counting implementation (P1-10).
 *
 * Previously ~5 copies of the same subtree walker lived in goal-policy,
 * goal-auditor, widgets/goal-widget, and
 * prompts/goal-prompts, with subtly different shapes. All call sites now use
 * this one walker. `doneIncludesSkipped` is explicit so "skipped counts as
 * done" semantics can never drift silently again: today every call site uses
 * false (skipped is tracked separately, matching prior behavior); the flag
 * exists for surfaces that deliberately want skipped folded into done.
 */

import type { GoalTask } from "./goal-record.ts";

interface TaskSubtreeCounts {
	total: number;
	/** Done count: complete, or complete+skipped when doneIncludesSkipped. */
	complete: number;
	skipped: number;
	pending: number;
	/** Present only when collectPending is requested (prompts' "next pending"). */
	pendingTasks?: GoalTask[];
}

export function countTaskSubtree(
	tasks: readonly GoalTask[],
	opts: { doneIncludesSkipped?: boolean; collectPending?: boolean } = {},
): TaskSubtreeCounts {
	let total = 0;
	let rawComplete = 0;
	let rawSkipped = 0;
	const pendingTasks: GoalTask[] | undefined = opts.collectPending ? [] : undefined;

	function walk(list: readonly GoalTask[]): void {
		for (const t of list) {
			total++;
			if (t.status === "complete") rawComplete++;
			else if (t.status === "skipped") rawSkipped++;
			else if (pendingTasks) pendingTasks.push(t);
			if (t.subtasks && t.subtasks.length > 0) walk(t.subtasks);
		}
	}
	walk(tasks);

	const done = opts.doneIncludesSkipped ? rawComplete + rawSkipped : rawComplete;
	return {
		total,
		complete: done,
		skipped: rawSkipped,
		pending: total - rawComplete - rawSkipped,
		...(opts.collectPending ? { pendingTasks } : {}),
	};
}
