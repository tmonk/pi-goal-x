import type { GoalCommands } from "../goal-controls.ts";
import { schedulerSummaryParts } from "../goal-scheduler-state.ts";
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

import { displayObjectiveTitle, displayStatusLabel, formatDuration } from "../goal-display.ts";
import { t } from "../i18n/index.ts";
import { formatCompactTokens, percentageOf } from "./dashboard-format.ts";
import type { GoalLedgerEvent } from "../goal-ledger.ts";
import type { GoalRecord, GoalTask } from "../goal-record.ts";
import { deriveGoalActivity, type GoalActivityItem } from "../goal-activity.ts";

// ---------------------------------------------------------------------------
// Types (plan §6)
// ---------------------------------------------------------------------------

export type DashboardStatusCode = "running" | "idle" | "paused" | "blocked" | "budget_limited" | "complete";

export interface GoalDashboardModel {
	scheduling: string[];
	idlePacing?: string;
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

interface GoalDashboardModelOptions {
	commands?: GoalCommands;
	maxAutonomousRuns?: number;
	idleContinuationBackoff?: boolean;
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

interface DashboardGoalStatus {
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
				? { code: "running", label: t("In progress"), footerLabel: displayStatusLabel(goal) }
				: { code: "idle", label: t("Idle"), footerLabel: displayStatusLabel(goal) };
		case "paused": {
			const label = goal.stopReason === "agent" ? t("Paused (agent)") : goal.stopReason === "user" ? t("Paused (user)") : t("Paused");
			const status: DashboardGoalStatus = { code: "paused", label, footerLabel: displayStatusLabel(goal) };
			if (goal.pauseReason) status.reason = goal.pauseReason;
			if (goal.pauseSuggestedAction) status.suggestedAction = goal.pauseSuggestedAction;
			return status;
		}
		case "blocked": {
			const status: DashboardGoalStatus = { code: "blocked", label: t("Blocked"), footerLabel: displayStatusLabel(goal) };
			if (goal.pauseReason) status.reason = goal.pauseReason;
			if (goal.pauseSuggestedAction) status.suggestedAction = goal.pauseSuggestedAction;
			return status;
		}
		case "budget_limited":
			return { code: "budget_limited", label: t("Budget limited"), footerLabel: displayStatusLabel(goal) };
		case "complete":
			return { code: "complete", label: t("Complete"), footerLabel: displayStatusLabel(goal) };
	}
}

// ---------------------------------------------------------------------------
// Task progress (plan §9)
// ---------------------------------------------------------------------------

interface TaskProgress {
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

// ---------------------------------------------------------------------------
// Task tree (plan §9.2)
// ---------------------------------------------------------------------------

/**
 * Flatten the recursive task tree into display rows. `currentTaskId` marks
 * the current node; pass the EFFECTIVE current id (persisted, or inferred)
 * so the tree and the current-task block always agree.
 */
export function flattenTaskTree(tasks: readonly GoalTask[] | undefined, currentTaskId?: string): DashboardTaskNode[] {
	return flattenTaskIndex(taskIndex(tasks), currentTaskId);
}

/** flattenTaskTree for a task index the caller already has, so it is not looked up (and compared) twice. */
function flattenTaskIndex(index: ReturnType<typeof taskIndex>, currentTaskId?: string): DashboardTaskNode[] {
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

interface CurrentTaskSubtaskProgress {
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

interface DashboardCurrentTask extends CurrentTaskSubtaskProgress {
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
// Task-list viewport (task-viewport.ts)
// ---------------------------------------------------------------------------

export {
	anchoredScrollOffset,
	clampScrollOffset,
	compactTaskViewportRows,
	deriveTaskListViewport,
	expandedTaskViewportRows,
	latestCompletedNodeIndex,
	maxScrollOffset,
	taskViewportPageSize,
	type TaskListViewport,
} from "./task-viewport.ts";

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
// Formatting helpers (dashboard-format.ts)
// ---------------------------------------------------------------------------

export { formatAuditElapsed, formatBudget, formatCompactTokens, formatDashboardDuration } from "./dashboard-format.ts";

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
	const tree = disabled ? [] : flattenTaskIndex(index);
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
	if (goal.status === "active" && goal.scheduler?.phase === "interrupted") { status.code = "idle"; status.label = t("Waiting for you"); status.footerLabel = t("waiting for you"); }
	if (goal.status === "active" && goal.scheduler?.phase === "waiting") { status.code = "idle"; status.label = t("Waiting"); status.footerLabel = t("waiting"); }
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

	const scheduling = schedulerSummaryParts(goal.scheduler, options.maxAutonomousRuns, options.showAutonomousRuns !== false, options.idleContinuationBackoff === true, options.commands, true);
	return {
		scheduling: [scheduling.runs, ...scheduling.instructions.split("\n")].filter(Boolean),
		idlePacing: scheduling.idlePacing,
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
