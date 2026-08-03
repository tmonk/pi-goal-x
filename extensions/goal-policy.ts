import { statusLabel, type GoalDisplayRecordLike } from "./goal-core.ts";
import type { GoalTask, GoalTaskList, TaskStatus } from "./goal-record.ts";

export type GoalStatusLike = "active" | "paused" | "blocked" | "budget_limited" | "complete";
export type StopReasonLike = "user" | "agent";

export interface GoalPolicyRecordLike extends GoalDisplayRecordLike {
	id: string;
	status: GoalStatusLike;
	updatedAt?: string;
	pauseReason?: string;
	pauseSuggestedAction?: string;
	taskList?: GoalTaskList;
}

export type PolicyValidation =
	| { ok: true }
	| { ok: false; message: string };

export function isGoalUnfinished(goal: Pick<GoalPolicyRecordLike, "status"> | null | undefined): boolean {
	return !!goal && goal.status !== "complete";
}

export function isRunnableStatus(status: GoalStatusLike): boolean {
	return status === "active";
}

export function isCompletableStatus(status: GoalStatusLike): boolean {
	// A budget-limited goal is NOT completed by the transition itself, but the
	// user (or the model on explicit evidence) may still complete it. A blocked
	// goal is the model's terminal surrender — resume or clear it instead.
	return status === "active" || status === "paused" || status === "budget_limited";
}

export function validateGoalCreationSlot(goal: Pick<GoalPolicyRecordLike, "status"> | null): PolicyValidation {
	void goal;
	return { ok: true };
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

export function validateGoalUpdate(args: {
	goal: GoalPolicyRecordLike | null;
}): PolicyValidation {
	if (!args.goal) return { ok: false, message: "No goal is set; cannot update objective." };
	if (args.goal.status === "complete") return { ok: false, message: "Goal is already complete; cannot update objective." };
	return { ok: true };
}

export function validateGoalAbort(args: {
	goal: GoalPolicyRecordLike | null;
	runningGoalId?: string | null;
	reason: string;
}): PolicyValidation {
	const { goal, runningGoalId } = args;
	if (!goal) return { ok: false, message: "No goal is set; goal abandonment is a no-op." };
	if (runningGoalId && goal.id !== runningGoalId) return { ok: false, message: "The active goal changed during this run; not aborting." };
	if (goal.status === "complete") return { ok: false, message: "Goal is complete; abandonment does not apply." };
	if (!args.reason.trim()) return { ok: false, message: "Abandonment requires a non-empty reason." };
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

export function validatePauseGoal(args: {
	goal: GoalPolicyRecordLike | null;
	runningGoalId?: string | null;
	reason: string;
}): PolicyValidation {
	const { goal, runningGoalId } = args;
	if (!goal) return { ok: false, message: "No goal is set; pausing is a no-op." };
	if (runningGoalId && goal.id !== runningGoalId) return { ok: false, message: "The active goal changed during this run; not pausing." };
	if (!isRunnableStatus(goal.status)) return { ok: false, message: `Goal is ${statusLabel(goal)}; pausing does not apply.` };
	if (!args.reason.trim()) return { ok: false, message: "Pausing requires a non-empty reason." };
	return { ok: true };
}

export function buildPausedByAgentGoal<T extends GoalPolicyRecordLike>(goal: T, args: {
	reason: string;
	suggestedAction?: string;
	updatedAt: string;
}): T {
	const suggested = args.suggestedAction?.trim() || undefined;
	return {
		...goal,
		status: "paused",
		autoContinue: false,
		stopReason: "agent",
		pauseReason: args.reason.trim(),
		pauseSuggestedAction: suggested,
		updatedAt: args.updatedAt,
	};
}

export function buildAbortedByAgentGoal<T extends GoalPolicyRecordLike>(goal: T, args: {
	reason: string;
	updatedAt: string;
}): T {
	return {
		...goal,
		status: "paused",
		autoContinue: false,
		stopReason: "agent",
		pauseReason: `Aborted: ${args.reason.trim()}`,
		pauseSuggestedAction: undefined,
		updatedAt: args.updatedAt,
	};
}

export function validateResumeGoal(goal: GoalPolicyRecordLike | null): PolicyValidation {
	if (!goal) return { ok: false, message: "No goal is set. Use /goal <objective> or /sisyphus <objective> to start immediately." };
	if (goal.status === "complete") return { ok: false, message: "Goal is complete. Use /goal <objective> or /sisyphus <objective> to start a new one." };
	if (goal.status === "active" && goal.autoContinue) return { ok: false, message: "Goal is already running." };
	return { ok: true };
}

export function clearGoalCommandMessage(args: { archived: boolean; wasDrafting: boolean }): string {
	return args.archived ? "Goal cleared and archived." : args.wasDrafting ? "Drafting cancelled." : "No goal is set.";
}

export function abortGoalCommandMessage(args: { archived: boolean; wasDrafting: boolean }): string {
	return args.archived ? "Goal aborted and archived." : args.wasDrafting ? "Drafting cancelled." : "No goal is set.";
}

/** Count tasks in subtree recursively */
function countSubtreeTasks(tasks: GoalTask[]): { total: number; complete: number; skipped: number; pending: number } {
	let total = 0;
	let complete = 0;
	let skipped = 0;
	for (const t of tasks) {
		total++;
		if (t.status === "complete") complete++;
		else if (t.status === "skipped") skipped++;
		if (t.subtasks && t.subtasks.length > 0) {
			const child = countSubtreeTasks(t.subtasks);
			total += child.total;
			complete += child.complete;
			skipped += child.skipped;
		}
	}
	return { total, complete, skipped, pending: total - complete - skipped };
}

export function buildTaskSummary(taskList: GoalTaskList): string {
	const { total, complete, skipped } = countSubtreeTasks(taskList.tasks);
	if (total === 0) return "No tasks";
	const parts: string[] = [`${complete}/${total} tasks complete`];
	if (skipped > 0) parts.push(`(${skipped} skipped)`);
	return parts.join(" ");
}

export function taskCompletionBlockWarning(taskList: GoalTaskList): string | null {
	if (!taskList.blockCompletion) return null;
	const { pending } = countSubtreeTasks(taskList.tasks);
	if (pending === 0) return null;
	return `${pending} task${pending > 1 ? "s" : ""} still pending with blockCompletion enabled. Complete or skip all pending tasks before finishing the goal.`;
}

/**
 * Validate that a verificationSummary satisfies a verificationContract.
 * If a contract exists, the summary must be non-empty.
 */
export function validateVerificationSummary(args: {
	verificationContract?: string | null;
	verificationSummary?: string | null;
}): PolicyValidation {
	const contract = args.verificationContract?.trim();
	const summary = args.verificationSummary?.trim();
	if (contract && !summary) {
		return {
			ok: false,
			message: `This goal has a verification contract but no verificationSummary was provided. Provide a verificationSummary that addresses the contract requirements.`,
		};
	}
	return { ok: true };
}

export function validateTaskCompletion(args: {
	goal: GoalPolicyRecordLike | null;
	taskId: string;
}): PolicyValidation {
	if (!args.goal) return { ok: false, message: "No goal is set." };
	if (!args.goal.taskList) return { ok: false, message: "Goal has no task list." };
	const task = findTaskInTree(args.goal.taskList.tasks, args.taskId);
	if (!task) return { ok: false, message: `Task "${args.taskId}" not found.` };
	if (task.status === "complete") return { ok: false, message: `Task "${args.taskId}" is already complete.` };
	if (task.status === "skipped") return { ok: false, message: `Task "${args.taskId}" was already skipped.` };
	return { ok: true };
}

export function validateTaskSkip(args: {
	goal: GoalPolicyRecordLike | null;
	taskId: string;
	reason: string;
}): PolicyValidation {
	if (!args.goal) return { ok: false, message: "No goal is set." };
	if (!args.goal.taskList) return { ok: false, message: "Goal has no task list." };
	const task = findTaskInTree(args.goal.taskList.tasks, args.taskId);
	if (!task) return { ok: false, message: `Task "${args.taskId}" not found.` };
	if (task.status === "complete") return { ok: false, message: `Task "${args.taskId}" is already complete.` };
	// Skipped tasks toggle via the executor; reason is only required for first-time skips.
	if (task.status === "skipped") return { ok: true };
	if (!args.reason.trim()) return { ok: false, message: "Skipping requires a non-empty reason." };
	return { ok: true };
}

/**
 * Count the maximum nesting depth of a task's subtask tree.
 * Root level = 0. Returns the deepest nesting depth found.
 */
export function measureSubtaskDepth(task: GoalTask): number {
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

function checkDuplicateTaskIds(tasks: GoalTask[], ids: Set<string>): string | undefined {
	for (const t of tasks) {
		const id = t.id.trim();
		if (!id) return "All tasks must have a non-empty id.";
		if (ids.has(id)) return `Duplicate task id: "${id}".`;
		ids.add(id);
		if (t.subtasks) {
			const childErr = checkDuplicateTaskIds(t.subtasks, ids);
			if (childErr) return childErr;
		}
	}
	return undefined;
}

export function validateTaskListProposal(args: {
	goal: GoalPolicyRecordLike | null;
	tasks: GoalTask[];
	maxSubtaskDepth?: number;
}): PolicyValidation {
	if (!args.goal) return { ok: false, message: "No goal is set." };
	if (args.tasks.length > 50) return { ok: false, message: "Task list cannot exceed 50 tasks." };
	const ids = new Set<string>();
	for (const t of args.tasks) {
		if (!t.id.trim()) return { ok: false, message: "All tasks must have a non-empty id." };
		if (!t.title.trim()) return { ok: false, message: `Task "${t.id}" must have a non-empty title.` };
		if (ids.has(t.id)) return { ok: false, message: `Duplicate task id: "${t.id}".` };
		ids.add(t.id);
		// Recursively check subtask ids against the same global set
		if (t.subtasks && t.subtasks.length > 0) {
			const childErr = checkDuplicateTaskIds(t.subtasks, ids);
			if (childErr) return { ok: false, message: childErr };
		}
	}
	// Check subtask depth limit
	const maxDepth = args.maxSubtaskDepth ?? 1;
	const depthViolation = findSubtaskDepthViolation(args.tasks, maxDepth);
	if (depthViolation) return { ok: false, message: depthViolation };
	return { ok: true };
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
	return tasks.map((t) => {
		if (t.id === taskId) return updater(t);
		if (t.subtasks) {
			return { ...t, subtasks: updateTaskInTree(t.subtasks, taskId, updater) };
		}
		return t;
	});
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

export function buildCompletionReport(args: { detailedSummary: string; completionSummary?: string | null; auditorReport?: string | null; auditSkippedReason?: string | null; taskSummary?: string | null }): string {
	const auditSkipped = args.auditSkippedReason?.trim();
	const auditorReport = args.auditorReport?.trim();
	const lines = auditSkipped
		? ["Goal audit skipped.", "", "Reason: " + auditSkipped, "", "Goal complete."]
		: auditorReport
			? ["Goal audit approved.", "", "Auditor approval:", auditorReport, "", "Goal complete."]
			: ["Goal complete."];
	const summary = args.completionSummary?.trim();
	if (summary) {
		lines.push("", "Completion summary:", summary);
	}
	const taskSummary = args.taskSummary?.trim();
	if (taskSummary) {
		lines.push("", `Task summary: ${taskSummary}`);
	}
	lines.push("", args.detailedSummary);
	return lines.join("\n");
}

export function buildGoalCreatedReport(args: { objective: string; detailedSummary?: string | null }): string {
	const lines = ["Goal confirmed and created.", "", "Finalized goal:", "", args.objective.trim()];
	const summary = args.detailedSummary?.trim();
	if (summary) {
		lines.push("", "Goal details:", summary);
	}
	return lines.join("\n");
}

export function shouldQueueContinuation(goal: Pick<GoalPolicyRecordLike, "status" | "autoContinue"> | null): boolean {
	return !!goal && goal.status === "active" && goal.autoContinue;
}


export function shouldArmPostCompactReminder(goal: Pick<GoalPolicyRecordLike, "sisyphus" | "status"> | null): boolean {
	return !!goal && isRunnableStatus(goal.status);
}

export function shouldInjectPostCompactReminder(args: { pending: boolean; goal: Pick<GoalPolicyRecordLike, "sisyphus"> | null }): boolean {
	return args.pending && !!args.goal;
}
