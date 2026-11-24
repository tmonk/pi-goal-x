/**
 * Scroll state for the widget's two task lists: the compact top-level list
 * and the expanded tree. The viewport maths is in task-viewport.ts;
 * this holds the mutable offsets and the re-anchor rule.
 */

import type { GoalDashboardModel } from "./goal-dashboard-model.ts";
import {
	anchoredScrollOffset,
	clampScrollOffset,
	compactTaskViewportRows,
	expandedTaskViewportRows,
	latestCompletedNodeIndex,
	maxScrollOffset,
	taskViewportPageSize,
} from "./task-viewport.ts";

export type ScrollKey = "up" | "down" | "pageUp" | "pageDown" | "home" | "end";

/** Move a task-list scroll offset by one key press, clamped to the list. */
export function scrollBy(key: ScrollKey, offset: number, length: number, rows: number): number {
	let next = clampScrollOffset(offset, length, rows);
	if (key === "up") next -= 1;
	else if (key === "down") next += 1;
	else if (key === "pageUp") next -= taskViewportPageSize(rows);
	else if (key === "pageDown") next += taskViewportPageSize(rows);
	else if (key === "home") next = 0;
	else if (key === "end") next = maxScrollOffset(length, rows);
	return clampScrollOffset(next, length, rows);
}

export class TaskScroll {
	compactOffset = 0;
	expandedOffset = 0;
	private lastGoalId: string | undefined;
	private lastLatestCompletedAt: string | undefined;

	/**
	 * Re-anchor rule: when the goal changes or a new task completes (the latest
	 * completedAt moves), reset both viewports to the anchored defaults so the
	 * most recently completed work stays visible. Between such events the
	 * user's manual scroll position is kept.
	 */
	reanchor(model: GoalDashboardModel | null, width: number): void {
		const tree = model?.taskTree ?? [];
		const latestIndex = latestCompletedNodeIndex(tree);
		const latestAt = latestIndex >= 0 ? tree[latestIndex]!.completedAt : undefined;
		if (model?.goalId === this.lastGoalId && latestAt === this.lastLatestCompletedAt) return;
		this.lastGoalId = model?.goalId;
		this.lastLatestCompletedAt = latestAt;
		if (!model || tree.length === 0) {
			this.compactOffset = 0;
			this.expandedOffset = 0;
			return;
		}
		const topLevel = tree.filter((n) => n.depth === 0);
		this.compactOffset = anchoredScrollOffset(topLevel, compactTaskViewportRows(width));
		this.expandedOffset = anchoredScrollOffset(tree, expandedTaskViewportRows(width));
	}

	/**
	 * Scroll the compact list. Consumed (true) only when the list overflows its
	 * viewport, so the key is never swallowed for a short list.
	 */
	scrollCompact(key: ScrollKey, model: GoalDashboardModel | null, width: number): boolean {
		const list = model?.taskTree.filter((n) => n.depth === 0) ?? [];
		const rows = compactTaskViewportRows(width);
		if (list.length <= rows) return false;
		this.compactOffset = scrollBy(key, this.compactOffset, list.length, rows);
		return true;
	}

	/**
	 * Scroll the expanded tree. The expanded dashboard is modal, so a key is
	 * consumed whenever there are tasks: "held" means consumed with nothing to
	 * scroll (everything fits), "ignored" means an empty tree.
	 */
	scrollExpanded(key: ScrollKey, model: GoalDashboardModel | null, width: number): "ignored" | "held" | "scrolled" {
		const list = model?.taskTree ?? [];
		if (list.length === 0) return "ignored";
		const rows = expandedTaskViewportRows(width);
		if (maxScrollOffset(list.length, rows) <= 0) return "held";
		this.expandedOffset = scrollBy(key, this.expandedOffset, list.length, rows);
		return "scrolled";
	}
}
