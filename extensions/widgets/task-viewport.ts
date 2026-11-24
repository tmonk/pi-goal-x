/**
 * Task-list viewport and scroll maths.
 *
 * The task list is a window over the rendered rows. Pure functions only: the
 * widget owns the mutable offset (task-scroll.ts) and the renderer owns the
 * box drawing. Anchoring means the default viewport is positioned so the most
 * recently completed task is visible, "scrolled down" to recent work instead
 * of always showing the earliest tasks.
 */

/** The part of a task row the scroll maths needs. */
interface ScrollNode {
	status: string;
	completedAt?: string;
}

/**
 * Index of the most recently completed node: the node with status
 * "complete" and the greatest completedAt; ties resolve to the LAST such
 * node in plan order. Returns -1 when nothing qualifies (e.g. legacy tasks
 * without a completion timestamp), in which case the viewport stays at the
 * top.
 */
export function latestCompletedNodeIndex(nodes: readonly ScrollNode[]): number {
	let bestIndex = -1;
	let bestAt = "";
	for (let i = 0; i < nodes.length; i++) {
		const node = nodes[i]!;
		if (node.status !== "complete" || !node.completedAt) continue;
		// `>=` keeps the LAST node among equal timestamps (most recent plan
		// position), matching how a viewer reads "most recently done".
		if (bestIndex === -1 || node.completedAt >= bestAt) {
			bestIndex = i;
			bestAt = node.completedAt;
		}
	}
	return bestIndex;
}

/** Highest valid scroll offset for a list of totalRows shown in rows rows. */
export function maxScrollOffset(totalRows: number, rows: number): number {
	return Math.max(0, totalRows - rows);
}

/** Clamp an offset into [0, maxScrollOffset]. */
export function clampScrollOffset(offset: number, totalRows: number, rows: number): number {
	return Math.min(Math.max(0, Math.floor(offset)), maxScrollOffset(totalRows, rows));
}

/**
 * Default viewport offset, bottom-anchored to the most recently completed
 * task: the anchor is the LAST visible row, so the view shows the recent
 * completions (and whatever follows them in plan order) instead of the
 * earliest tasks. With no completed (or timestamped) tasks the viewport
 * starts at the top.
 */
export function anchoredScrollOffset(nodes: readonly ScrollNode[], rows: number): number {
	const anchor = latestCompletedNodeIndex(nodes);
	if (anchor < 0 || rows <= 0) return 0;
	return clampScrollOffset(anchor - (rows - 1), nodes.length, rows);
}

/**
 * Task-row budget for the compact viewport by terminal width (wide >=100,
 * medium 70-99, narrow 50-69, minimal <50). The expanded view uses
 * expandedTaskViewportRows.
 */
export function compactTaskViewportRows(width: number): number {
	if (width >= 100) return 5;
	if (width >= 70) return 4;
	if (width >= 50) return 3;
	return 2;
}

/**
 * Task-row budget for the expanded dashboard's task-tree window by terminal
 * width. Keeps the expanded panel bounded and scrollable; callers that want
 * the full tree pass rows = totalRows.
 */
export function expandedTaskViewportRows(width: number): number {
	if (width >= 100) return 20;
	if (width >= 70) return 16;
	if (width >= 50) return 12;
	return 8;
}

/** PgUp/PgDn step: one viewport (a page) of rows. */
export function taskViewportPageSize(rows: number): number {
	return Math.max(1, Math.floor(rows));
}

export interface TaskListViewport {
	totalRows: number;
	rows: number;
	offset: number;
	maxOffset: number;
	/** Rows hidden above the window (offset > 0). */
	hiddenAbove: number;
	/** Rows hidden below the window (offset + rows < total). */
	hiddenBelow: number;
}

/**
 * Derive the viewport window for a list of totalRows given a clamped offset
 * and row budget. The renderer uses hiddenAbove/hiddenBelow to draw the
 * `↑ N more` / `… +N more` indicator rows.
 */
export function deriveTaskListViewport(totalRows: number, rows: number, offset: number): TaskListViewport {
	const safeRows = Math.max(0, Math.floor(rows));
	const clamped = clampScrollOffset(offset, totalRows, safeRows);
	const maxOffset = maxScrollOffset(totalRows, safeRows);
	const visible = Math.min(safeRows, Math.max(0, totalRows - clamped));
	return {
		totalRows,
		rows: safeRows,
		offset: clamped,
		maxOffset,
		hiddenAbove: clamped,
		hiddenBelow: Math.max(0, totalRows - (clamped + visible)),
	};
}
