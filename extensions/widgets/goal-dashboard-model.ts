import { schedulerSummary } from "../goal-scheduler-state.ts";
import { taskIndex } from "../goal-task-index.ts";
/**
 * Shared dashboard view model (plan §6) — the single source of truth for the
 * persistent compact dashboard, the expanded dashboard, `/goal-status`, audit
 * transitions, golden tests, and documentation examples.
 *
 * Pure data derivation only: this module must never import TUI rendering
 * components. Width-safe truncation, borders, and color belong to the
 * renderer; everything factual here is derived from persisted goal state and
 * the durable ledger.
 */

import { displayObjectiveTitle, formatDuration, statusLabel } from "../goal-core.ts";
import type { GoalLedgerEvent } from "../goal-ledger.ts";
import type { GoalRecord, GoalTask } from "../goal-record.ts";
import { deriveGoalActivity, type GoalActivityItem } from "../goal-activity.ts";

// ---------------------------------------------------------------------------
// Types (plan §6)
// ---------------------------------------------------------------------------

export type DashboardStatusCode = "running" | "idle" | "paused" | "blocked" | "budget_limited" | "complete";

export interface GoalDashboardModel {
	scheduling: string[];
	goalId: string;
	title: string;

	status: {
		code: DashboardStatusCode;
		label: string;
		/** Footer-status label (goal-core statusLabel), e.g. `running`, `paused (agent)`. */
		footerLabel: string;
		reason?: string;
		suggestedAction?: string;
	};

	focused: boolean;
	/** §auditor-toggle: whether the independent completion auditor is enabled for this goal (derived from the goal's persisted skipAuditor; undefined = on). */
	auditorEnabled: boolean;
	filePath?: string;

	usage: {
		activeSeconds: number;
		tokens: number;
		/** Footer-style usage content, e.g. `49h49m36s 19M` (empty when unused). */
		footerBits: string;
	};

	budget?: {
		used: number;
		total: number;
		percentage: number;
		remaining: number;
	};

	taskProgress?: {
		completed: number;
		total: number;
		percentage: number;
	};

	taskTree: DashboardTaskNode[];

	currentTask?: {
		id: string;
		title: string;
		depth: number;
		completedSubtasks: number;
		totalSubtasks: number;
		subtaskPercentage: number;
		verificationContract?: string;
		evidence?: string;
		/**
		 * True when no valid persisted currentTaskId existed and the current
		 * task was inferred from the first pending task for display only —
		 * never persisted (§7.4).
		 */
		inferred?: boolean;
	};

	goalVerificationContract?: string;
	otherOpenGoals: number;
	recentActivity: GoalActivityItem[];
}

export interface DashboardTaskNode {
	id: string;
	title: string;
	status: "pending" | "complete" | "skipped";
	depth: number;
	isCurrent: boolean;
	verificationContract?: string;
	evidence?: string;
	/** Completion timestamp (when status is complete) — the scroll anchor (§9.6). */
	completedAt?: string;
	/** Direct-child subtask total — 0 for a leaf task (§9.3 rule: direct children only). */
	totalSubtasks: number;
	/** Direct children complete or skipped (same "done" rule as §9.1). */
	completedSubtasks: number;
}

export interface GoalDashboardModelOptions {
	maxAutonomousRuns?: number;
	/** Report the runs line for a finite allowance (default on). */
	showAutonomousRuns?: boolean;
	focused: boolean;
	otherOpenGoals: number;
	ledgerEvents?: readonly GoalLedgerEvent[];
	activityLimit?: number;
	/** §9.5: omit task sections when tasks are disabled by settings. */
	tasksDisabled?: boolean;
}

// ---------------------------------------------------------------------------
// Status derivation
// ---------------------------------------------------------------------------

export interface DashboardGoalStatus {
	code: DashboardStatusCode;
	label: string;
	/** Footer-status label (goal-core statusLabel: running / paused (agent) /
	 * blocked / budget limited / active / complete, with sisyphus prefix) — the
	 * widget status line shows the same terminology as the pi footer. */
	footerLabel: string;
	reason?: string;
	suggestedAction?: string;
}

/**
 * Map the persisted lifecycle status to a display code. Labels are explicit
 * words so the dashboard stays understandable without status symbols (§5.2).
 */
export function deriveGoalStatus(goal: GoalRecord): DashboardGoalStatus {
	switch (goal.status) {
		case "active":
			return goal.autoContinue
				? { code: "running", label: "In progress", footerLabel: statusLabel(goal) }
				: { code: "idle", label: "Idle", footerLabel: statusLabel(goal) };
		case "paused": {
			const who = goal.stopReason === "agent" ? " (agent)" : goal.stopReason === "user" ? " (user)" : "";
			const status: DashboardGoalStatus = { code: "paused", label: `Paused${who}`, footerLabel: statusLabel(goal) };
			if (goal.pauseReason) status.reason = goal.pauseReason;
			if (goal.pauseSuggestedAction) status.suggestedAction = goal.pauseSuggestedAction;
			return status;
		}
		case "blocked": {
			const status: DashboardGoalStatus = { code: "blocked", label: "Blocked", footerLabel: statusLabel(goal) };
			if (goal.pauseReason) status.reason = goal.pauseReason;
			if (goal.pauseSuggestedAction) status.suggestedAction = goal.pauseSuggestedAction;
			return status;
		}
		case "budget_limited":
			return { code: "budget_limited", label: "Budget limited", footerLabel: statusLabel(goal) };
		case "complete":
			return { code: "complete", label: "Complete", footerLabel: statusLabel(goal) };
	}
}

// ---------------------------------------------------------------------------
// Task progress (plan §9)
// ---------------------------------------------------------------------------

export interface TaskProgress {
	completed: number;
	total: number;
	percentage: number;
}

/**
 * Overall progress across TOP-LEVEL tasks only (§9.1): a top-level task
 * counts as done when it is complete or skipped, keeping the main percentage
 * aligned with major milestones.
 */
export function deriveTopLevelTaskProgress(goal: GoalRecord): TaskProgress | undefined {
	const tasks = goal.taskList?.tasks;
	if (!tasks || tasks.length === 0) return undefined;
	const completed = tasks.filter((t) => t.status === "complete" || t.status === "skipped").length;
	return { completed, total: tasks.length, percentage: percentageOf(completed, tasks.length) };
}

function percentageOf(done: number, total: number): number {
	if (total <= 0) return 0;
	return Math.min(100, Math.max(0, Math.round((done / total) * 100)));
}

// ---------------------------------------------------------------------------
// Task tree (plan §9.2)
// ---------------------------------------------------------------------------

/**
 * Flatten the recursive task tree into display rows. `currentTaskId` marks
 * the current node; pass the EFFECTIVE current id (persisted, or inferred)
 * so the tree and the current-task block always agree.
 */
export function flattenTaskTree(tasks: readonly GoalTask[] | undefined, currentTaskId?: string): DashboardTaskNode[] {
 const index = taskIndex(tasks);
 return index.ordered.map(({task: t, depth}) => ({
  id: t.id, title: t.title, status: t.status, depth, isCurrent: t.id === currentTaskId,
  verificationContract: t.verificationContract, evidence: t.evidence, completedAt: t.completedAt,
  totalSubtasks: t.subtasks?.length ?? 0,
  completedSubtasks: t.subtasks?.filter(c => c.status === "complete" || c.status === "skipped").length ?? 0,
 }));
}

// ---------------------------------------------------------------------------
// Current task (plan §7.2, §9.3)
// ---------------------------------------------------------------------------

export interface CurrentTaskSubtaskProgress {
	completedSubtasks: number;
	totalSubtasks: number;
	subtaskPercentage: number;
}

/**
 * Subtask progress for the current task (§9.3 preferred rule): for a parent
 * task, direct-child completion; for a leaf task, all-zero so the renderer
 * can omit the ratio rather than show something confusing.
 */
export function deriveCurrentTaskSubtaskProgress(current: { id: string }, tasks: readonly GoalTask[]): CurrentTaskSubtaskProgress {
	const parent = findTask(tasks, current.id);
	const children = parent?.subtasks;
	if (!children || children.length === 0) {
		return { completedSubtasks: 0, totalSubtasks: 0, subtaskPercentage: 0 };
	}
	const completed = children.filter((c) => c.status === "complete" || c.status === "skipped").length;
	return {
		completedSubtasks: completed,
		totalSubtasks: children.length,
		subtaskPercentage: percentageOf(completed, children.length),
	};
}

export interface DashboardCurrentTask extends CurrentTaskSubtaskProgress {
	id: string;
	title: string;
	depth: number;
	verificationContract?: string;
	evidence?: string;
	inferred?: boolean;
}

/**
 * Resolve the current task: the persisted currentTaskId when it references an
 * existing pending task; otherwise (missing, invalid, or removed) fall back
 * to the first pending task in tree order, marked `inferred` so the fallback
 * is never persisted (§7.4). `currentTaskId` may point at any tree node —
 * top-level task or subtask (§7.2).
 */
export function deriveCurrentTask(goal: GoalRecord, nodes: DashboardTaskNode[]): DashboardCurrentTask | undefined {
	const tasks = goal.taskList?.tasks;
	if (!tasks || tasks.length === 0 || nodes.length === 0) return undefined;
	let node: DashboardTaskNode | undefined;
	if (goal.currentTaskId) {
		node = nodes.find((n) => n.id === goal.currentTaskId && n.status === "pending");
	}
	const inferred = node === undefined;
	if (inferred) node = nodes.find((n) => n.status === "pending");
	if (!node) return undefined;
	const subtaskProgress = deriveCurrentTaskSubtaskProgress(node, tasks);
	return {
		id: node.id,
		title: node.title,
		depth: node.depth,
		...subtaskProgress,
		verificationContract: node.verificationContract,
		evidence: node.evidence,
		...(inferred ? { inferred: true } : {}),
	};
}

// ---------------------------------------------------------------------------
// Task-list viewport / scroll (plan §9.6)
//
// The task list is a window over the rendered rows. Pure functions only: the
// widget owns the mutable offset and the re-anchor rule; the renderer owns
// the box drawing. Anchoring means the default viewport is positioned so the
// most recently completed task is visible — "scrolled down" to recent work
// instead of always showing the earliest tasks.
// ---------------------------------------------------------------------------

/**
 * Index of the most recently completed node: the node with status
 * "complete" and the greatest completedAt; ties resolve to the LAST such
 * node in plan order. Returns -1 when nothing qualifies (e.g. legacy tasks
 * without a completion timestamp), in which case the viewport stays at the
 * top.
 */
export function latestCompletedNodeIndex(nodes: readonly DashboardTaskNode[]): number {
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
export function anchoredScrollOffset(nodes: readonly DashboardTaskNode[], rows: number): number {
	const anchor = latestCompletedNodeIndex(nodes);
	if (anchor < 0 || rows <= 0) return 0;
	return clampScrollOffset(anchor - (rows - 1), nodes.length, rows);
}

/**
 * Task-row budget for the compact viewport by terminal width (§5.5 buckets:
 * wide ≥100, medium 70–99, narrow 50–69, minimal <50). The expanded view
 * derives its own rows from the render height.
 */
export function compactTaskViewportRows(width: number): number {
	if (width >= 100) return 5;
	if (width >= 70) return 4;
	if (width >= 50) return 3;
	return 2;
}

/**
 * Task-row budget for the expanded dashboard's task-tree window by terminal
 * width. The widget uses this to keep the expanded panel bounded and
 * scrollable; callers that want the full tree pass rows = totalRows.
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

function findTask(tasks: readonly GoalTask[], id: string): GoalTask | undefined {
	for (const t of tasks) {
		if (t.id === id) return t;
		if (t.subtasks && t.subtasks.length > 0) {
			const found = findTask(t.subtasks, id);
			if (found) return found;
		}
	}
	return undefined;
}

// ---------------------------------------------------------------------------
// Activity (re-exported from the durable-ledger mapping, §12)
// ---------------------------------------------------------------------------

export { deriveGoalActivity };
export type { GoalActivityItem, GoalActivityKind } from "../goal-activity.ts";

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

/** Compact elapsed duration, e.g. `12m47s` (shared formatter from goal-core). */
export function formatDashboardDuration(seconds: number): string {
	return formatDuration(seconds);
}

/** Audit header duration label from milliseconds (§15.3). */
export function formatAuditElapsed(elapsedMs: number): string {
	return formatDuration(Math.floor(Math.max(0, elapsedMs) / 1000));
}

/**
 * Compact token count, e.g. `18.2K`, `2.5M`, `999`. Shared display label for
 * the dashboard header and budget rows.
 */
export function formatCompactTokens(value: number): string {
	const safe = Math.max(0, Math.floor(value));
	if (safe >= 1_000_000) return `${trimZero((safe / 1_000_000).toFixed(1))}M`;
	if (safe >= 1_000) return `${trimZero((safe / 1_000).toFixed(1))}K`;
	return String(safe);
}

function trimZero(value: string): string {
	return value.replace(/\.0$/, "");
}

/** Budget summary, e.g. `18.2K / 50K · 36%`. */
export function formatBudget(used: number, total: number): string {
	const pct = total > 0 ? Math.min(100, Math.max(0, Math.round((used / total) * 100))) : 0;
	return `${formatCompactTokens(used)} / ${formatCompactTokens(total)} · ${pct}%`;
}

// ---------------------------------------------------------------------------
// Whole-model derivation
// ---------------------------------------------------------------------------

const presentationCache = new WeakMap<object, Map<string, {taskProgress: TaskProgress | undefined; taskTree: DashboardTaskNode[]; currentTask: DashboardCurrentTask | undefined; taskTitles: Map<string, string>}>>();
function taskPresentation(goal: GoalRecord, disabled: boolean) {
 const index = taskIndex(disabled ? [] : goal.taskList?.tasks);
 let entries = presentationCache.get(index);
 if (!entries) { entries = new Map(); presentationCache.set(index, entries); }
 const key = `${disabled}:${goal.currentTaskId ?? ""}`;
 const hit = entries.get(key);
 if (hit) return hit;
 const taskProgress = disabled ? undefined : deriveTopLevelTaskProgress(goal);
 const tree = disabled ? [] : flattenTaskTree(index.tasks);
 const currentTask = disabled ? undefined : deriveCurrentTask(goal, tree);
 const taskTree = tree.map(n => n.id === currentTask?.id ? {...n, isCurrent: true} : n);
 const value = {taskProgress, taskTree, currentTask, taskTitles: new Map(taskTree.map(n => [n.id, n.title]))};
 if (entries.size >= 64) entries.delete(entries.keys().next().value!);
 entries.set(key, value);
 return value;
}

/**
 * Derive the unified dashboard model for one goal. Returns null when there is
 * no goal record; surfaces that need the "no goal / focus required" panel
 * (plan §4.3) render that from their own context with `otherOpenGoals`.
 */
export function deriveGoalDashboardModel(
	goal: GoalRecord | null,
	options: GoalDashboardModelOptions,
): GoalDashboardModel | null {
	if (!goal) return null;
	const { focused, otherOpenGoals, ledgerEvents = [], activityLimit, tasksDisabled = false } = options;

	const status = deriveGoalStatus(goal);
	if (goal.status === "active" && goal.scheduler?.phase === "waiting") { status.code = "idle"; status.label = "Waiting"; status.footerLabel = "waiting"; }
	// §9.5: with tasks disabled, omit task sections entirely (status,
	// verification, usage, path, and focus remain).
 const {taskProgress, taskTree, currentTask, taskTitles} = taskPresentation(goal, tasksDisabled);

	const budget =
		goal.tokenBudget !== undefined
			? {
					used: goal.usage.tokensUsed,
					total: goal.tokenBudget,
					percentage: percentageOf(goal.usage.tokensUsed, goal.tokenBudget),
					remaining: Math.max(0, goal.tokenBudget - goal.usage.tokensUsed),
				}
			: undefined;

	const recentActivity = deriveGoalActivity(ledgerEvents, goal.id, { taskTitles, limit: activityLimit });

	// Footer-status usage bits (goal-core footerStatus parity): compact
	// duration + compact token count, e.g. `49h49m36s 19M`. The status line
	// renders them inside brackets; empty when the goal has no usage yet.
	const footerUsageBits: string[] = [];
	if (goal.usage.activeSeconds > 0) footerUsageBits.push(formatDuration(goal.usage.activeSeconds));
	if (goal.usage.tokensUsed > 0) footerUsageBits.push(formatCompactTokens(goal.usage.tokensUsed));

	return {
		scheduling: schedulerSummary(goal.scheduler, options.maxAutonomousRuns, options.showAutonomousRuns !== false).split("\n").filter(Boolean),
		goalId: goal.id,
		title: displayObjectiveTitle(goal.objective),
		status,
		focused,
		auditorEnabled: goal.skipAuditor !== true,
		filePath: goal.activePath ?? goal.archivedPath,
		usage: {
			activeSeconds: goal.usage.activeSeconds,
			tokens: goal.usage.tokensUsed,
			footerBits: footerUsageBits.join(" "),
		},
		budget,
		taskProgress,
		taskTree,
		currentTask,
		goalVerificationContract: goal.verificationContract,
		otherOpenGoals,
		recentActivity,
	};
}
