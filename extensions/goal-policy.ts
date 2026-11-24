import { statusLabel, type GoalDisplayRecordLike } from "./goal-display.ts";
import { t } from "./i18n/index.ts";
import type { GoalTask, GoalTaskList } from "./goal-record.ts";
import { countTaskSubtree } from "./goal-task-count.ts";

type GoalStatusLike = "active" | "paused" | "blocked" | "budget_limited" | "complete";
export interface GoalPolicyRecordLike extends GoalDisplayRecordLike {
	id: string;
	status: GoalStatusLike;
	updatedAt?: string;
	pauseReason?: string;
	pauseSuggestedAction?: string;
	taskList?: GoalTaskList;
}

type PolicyValidation =
	| { ok: true }
	| { ok: false; message: string };

function isRunnableStatus(status: GoalStatusLike): boolean {
	return status === "active";
}

function isCompletableStatus(status: GoalStatusLike): boolean {
	// A budget-limited goal is NOT completed by the transition itself, but the
	// user (or the model on explicit evidence) may still complete it. A blocked
	// goal is the model's terminal surrender — resume or clear it instead.
	return status === "active" || status === "paused" || status === "budget_limited";
}

export function validateGoalCompletion(args: {
	goal: GoalPolicyRecordLike | null;
	runningGoalId?: string | null;
}): PolicyValidation {
	const { goal, runningGoalId } = args;
	if (!goal) return { ok: false, message: "No goal is set." };
	if (runningGoalId && goal.id !== runningGoalId) return { ok: false, message: "The active goal changed during this run; not marking it complete." };
	if (!isCompletableStatus(goal.status)) return { ok: false, message: `Goal is ${statusLabel(goal)}; update_goal(complete) does not apply.` };
	return { ok: true };
}

/** update_goal(blocked) applies only to an ACTIVE goal — paused/complete/blocked/budget-limited reject it. */
export function validateGoalBlock(args: {
	goal: GoalPolicyRecordLike | null;
	runningGoalId?: string | null;
}): PolicyValidation {
	const { goal } = args;
	if (!goal) return { ok: false, message: "No goal is set." };
	if (goal.status !== "active") {
		return { ok: false, message: `Goal is ${statusLabel(goal)}; update_goal(blocked) applies only to an active goal.` };
	}
	return { ok: true };
}

/**
 * update_goal(paused) is the agent-initiated immediate pause (Stage 5.1-C).
 * It applies only to an ACTIVE goal and is distinct from the three-turn
 * blocked gate and from the user-owned pause/resume commands.
 */
export function validateGoalAgentPause(args: {
	goal: GoalPolicyRecordLike | null;
	runningGoalId?: string | null;
}): PolicyValidation {
	const { goal } = args;
	if (!goal) return { ok: false, message: "No goal is set." };
	if (goal.status !== "active") {
		return { ok: false, message: `Goal is ${statusLabel(goal)}; update_goal(paused) applies only to an active goal.` };
	}
	return { ok: true };
}

export function clearGoalCommandMessage(args: { archived: boolean }): string {
	return args.archived ? t("Goal cleared and archived.") : t("No goal is set.");
}

/** Count tasks in subtree recursively */
export function buildTaskSummary(taskList: GoalTaskList): string {
	const { total, complete, skipped } = countTaskSubtree(taskList.tasks);
	if (total === 0) return "No tasks";
	const parts: string[] = [`${complete}/${total} tasks complete`];
	if (skipped > 0) parts.push(`(${skipped} skipped)`);
	return parts.join(" ");
}

export function taskCompletionBlockWarning(taskList: GoalTaskList): string | null {
	if (!taskList.blockCompletion) return null;
	const { pending } = countTaskSubtree(taskList.tasks);
	if (pending === 0) return null;
	return `${pending} task${pending > 1 ? "s" : ""} still pending with blockCompletion enabled. Complete or skip all pending tasks before finishing the goal.`;
}

/**
 * Count the maximum nesting depth of a task's subtask tree.
 * Root level = 0. Returns the deepest nesting depth found.
 */
function measureSubtaskDepth(task: GoalTask): number {
	if (!task.subtasks || task.subtasks.length === 0) return 0;
	let maxChild = 0;
	for (const child of task.subtasks) {
		const childDepth = measureSubtaskDepth(child);
		if (childDepth > maxChild) maxChild = childDepth;
	}
	return maxChild + 1;
}

/**
 * Validate that a task's subtask tree does not exceed the configured max depth.
 * maxDepth is the subtaskDepth setting (default 1) — how many levels of nesting are allowed.
 * Returns the first violation found, or undefined if valid.
 */
export function findSubtaskDepthViolation(tasks: GoalTask[], maxDepth: number): string | undefined {
	for (const task of tasks) {
		const depth = measureSubtaskDepth(task);
		if (depth > maxDepth) {
			return `Task "${task.id}" has subtask nesting depth ${depth}, exceeding the configured maximum of ${maxDepth}`;
		}
		if (task.subtasks) {
			const childViolation = findSubtaskDepthViolation(task.subtasks, maxDepth);
			if (childViolation) return childViolation;
		}
	}
	return undefined;
}

/**
 * Recursively find a task by ID in a task tree.
 */
export function findTaskInTree(tasks: GoalTask[], taskId: string): GoalTask | undefined {
	for (const t of tasks) {
		if (t.id === taskId) return t;
		if (t.subtasks) {
			const found = findTaskInTree(t.subtasks, taskId);
			if (found) return found;
		}
	}
	return undefined;
}

/**
 * Recursively update a task by ID in a task tree using an updater function.
 */
export function updateTaskInTree(tasks: GoalTask[], taskId: string, updater: (task: GoalTask) => GoalTask): GoalTask[] {
	let next: GoalTask[] | undefined;
	for (let i = 0; i < tasks.length; i++) {
		const task = tasks[i]!;
		let updated = task;
		if (task.id === taskId) updated = updater(task);
		else if (task.subtasks) {
			const subtasks = updateTaskInTree(task.subtasks, taskId, updater);
			if (subtasks !== task.subtasks) updated = {...task, subtasks};
		}
		if (updated !== task) { next ??= tasks.slice(); next[i] = updated; }
	}
	return next ?? tasks;
}

/**
 * Check if all subtasks of a task are complete (for full subtasks only).
 * Returns undefined when all are complete/skipped, or an error message.
 */
export function checkSubtasksComplete(task: GoalTask): string | undefined {
	if (!task.subtasks || task.subtasks.length === 0 || task.lightweightSubtasks) return undefined;
	for (const child of task.subtasks) {
		if (child.status === "pending") {
			return `Task "${task.id}" has pending subtask "${child.id}". Complete or skip all subtasks first.`;
		}
		// Check recursively
		const childCheck = checkSubtasksComplete(child);
		if (childCheck) return childCheck;
	}
	return undefined;
}

/**
 * Recursively skip all subtasks of a task.
 * Returns a set of all skipped task IDs.
 */
export function skipAllSubtasks(task: GoalTask, now: string, reason: string): GoalTask {
	if (!task.subtasks || task.subtasks.length === 0) return task;
	return {
		...task,
		subtasks: task.subtasks.map((child) => {
			if (child.status === "complete") return child;
			const skipped = {
				...child,
				status: "skipped" as const,
				skippedAt: now,
				skipReason: reason,
			};
			return skipAllSubtasks(skipped, now, reason);
		}),
	};
}

export function buildCompletionReport(args: { detailedSummary: string; auditorReport?: string | null; auditSkippedReason?: string | null; taskSummary?: string | null }): string {
	const auditSkipped = args.auditSkippedReason?.trim();
	const auditorReport = args.auditorReport?.trim();
	const lines = auditSkipped
		? ["Goal audit skipped.", "", "Reason: " + auditSkipped, "", "Goal complete."]
		: auditorReport
			? ["Goal audit approved.", "", "Auditor approval:", auditorReport, "", "Goal complete."]
			: ["Goal complete."];
	const taskSummary = args.taskSummary?.trim();
	if (taskSummary) {
		lines.push("", `Task summary: ${taskSummary}`);
	}
	lines.push("", args.detailedSummary);
	return lines.join("\n");
}

interface GoalCreatedReportArgs {
	objective: string;
	detailedSummary?: string | null;
	/**
	 * Guided-confirmation report (§14): the richer opening line plus expanded
	 * detail (goal id, active file, task count, verification contract, auditor
	 * configuration, token budget). Direct creation keeps the default text.
	 */
	confirmed?: boolean;
	goalId?: string;
	filePath?: string;
	taskCount?: number;
	verificationContract?: string;
	auditorEnabled?: boolean;
	tokenBudget?: number;
}

export function formatGoalBudget(budget: number | undefined): string {
	return `Budget: ${budget === undefined ? "none" : `${budget} tokens`}`;
}

export function buildGoalCreatedReport(args: GoalCreatedReportArgs): string {
	const opening = args.confirmed
		? ["✓ Goal created and focused.", "Continuing automatically with the confirmed plan."]
		: ["Goal confirmed and created."];
	const lines = [...opening, "", "Finalized goal:", "", args.objective.trim()];
	const details: string[] = [];
	if (args.goalId) details.push(`Goal id: ${args.goalId}`);
	if (args.filePath) details.push(`File: ${args.filePath}`);
	if (args.taskCount !== undefined) details.push(`Tasks: ${args.taskCount}`);
	if (args.verificationContract?.trim()) details.push(`Verification: ${args.verificationContract.trim()}`);
	if (args.auditorEnabled !== undefined) details.push(`Auditor: ${args.auditorEnabled ? "enabled" : "disabled"}`);
	details.push(formatGoalBudget(args.tokenBudget));
	const summary = args.detailedSummary?.trim();
	if (summary) details.push(summary);
	if (details.length > 0) {
		lines.push("", "Goal details:", ...details);
	}
	return lines.join("\n");
}

/** Count the ordered steps in a sisyphus objective (numbered items or "Step N"). */
export function countOrderedSteps(objective: string): number {
	const numbered = objective.match(/^\s*\d{1,2}\s*[.):]/gm)?.length ?? 0;
	const stepMarkers = objective.match(/^\s*step\s+\d+/gim)?.length ?? 0;
	return Math.max(numbered, stepMarkers);
}

/**
 * E6/F4: where the goal is in its ordered sisyphus sequence. M = ordered steps
 * in the objective; N = completed top-level tasks + 1 (clamped), falling back
 * to 1 when no task tracking exists. Returns null for non-sisyphus goals or
 * objectives without ordered markers.
 */
export function sisyphusStepProgress(goal: { sisyphus: boolean; objective: string; taskList?: { tasks?: Array<{ status: string }> } | null }): { current: number; total: number } | null {
	if (!goal.sisyphus) return null;
	const total = countOrderedSteps(goal.objective);
	if (total === 0) return null;
	let current = 1;
	const tasks = goal.taskList?.tasks;
	if (tasks && tasks.length > 0) {
		const completedTop = tasks.filter((t) => t.status === "complete").length;
		current = Math.min(total, completedTop + 1);
	}
	return { current, total };
}

export function shouldArmPostCompactReminder(goal: Pick<GoalPolicyRecordLike, "sisyphus" | "status"> | null): boolean {
	return !!goal && isRunnableStatus(goal.status);
}

export function shouldInjectPostCompactReminder(args: { pending: boolean; goal: Pick<GoalPolicyRecordLike, "sisyphus"> | null }): boolean {
	return args.pending && !!args.goal;
}
