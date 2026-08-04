export type GoalStatus = "active" | "paused" | "blocked" | "budget_limited" | "complete";
export type StopReason = "user" | "agent";
export type GoalEventKind = "checkpoint" | "stale" | "drafting";
export type DraftingFocus = "goal" | "sisyphus";
export type GoalFocusReason = "created" | "selected" | "unfocused" | "resumed" | "completed" | "cleared" | "aborted" | "migrated";

export type TaskStatus = "pending" | "complete" | "skipped";

export interface GoalTask {
  id: string;
  title: string;
  status: TaskStatus;
  completedAt?: string;
  skippedAt?: string;
  evidence?: string;
  skipReason?: string;
  verificationContract?: string;
  lightweightSubtasks?: boolean;
  subtasks?: GoalTask[];
}

export interface GoalTaskList {
  tasks: GoalTask[];
  blockCompletion: boolean;
  proposedAt: string;
}

export interface GoalUsage {
	tokensUsed: number;
	activeSeconds: number;
}

export interface GoalRecord {
	id: string;
	objective: string;
	status: GoalStatus;
	autoContinue: boolean;
	usage: GoalUsage;
	sisyphus: boolean;
	createdAt: string;
	updatedAt: string;
	activePath?: string;
	archivedPath?: string;
	stopReason?: StopReason;
	// Set when the model reports the goal blocked. Cleared when the goal becomes active again.
	pauseReason?: string;
	pauseSuggestedAction?: string;
	skipAuditor?: boolean;
	/** Optional token budget (whole tokens). When accounted usage reaches it, the runtime marks the goal budget_limited. */
	tokenBudget?: number;
	taskList?: GoalTaskList;
	/** Plain-text description of what verification evidence is required before completing this goal. */
	verificationContract?: string;
}

export interface GoalStateEntry {
	version: 3;
	goal: GoalRecord | null;
}

export interface GoalFocusEntry {
	version: 1;
	focusedGoalId: string | null;
	reason: GoalFocusReason;
}

export interface GoalEventDetails {
	kind: GoalEventKind;
	goalId: string;
	status?: GoalStatus;
	objective?: string;
	timestamp?: number;
	currentGoalId?: string | null;
	currentStatus?: GoalStatus | null;
	focus?: DraftingFocus;
}

export interface GoalCreationConfig {
	objective: string;
	autoContinue: boolean;
	sisyphus: boolean;
}

export interface AssistantUsage {
	input?: number;
	output?: number;
}

export interface AssistantMessageLike {
	role?: string;
	stopReason?: string;
	usage?: AssistantUsage;
}

export function nowIso(now = Date.now()): string {
	return new Date(now).toISOString();
}

export function safeIdPart(value: string): string {
	return value.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80) || "goal";
}

export function newGoalId(): string {
	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function normalizeRelPath(relPath: string): string {
	return relPath.split(/[\\/]+/).join("/");
}

export function asRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

export function emptyUsage(): GoalUsage {
	return { tokensUsed: 0, activeSeconds: 0 };
}

function cloneGoalTask(task: GoalTask): GoalTask {
	return {
		...task,
		subtasks: task.subtasks ? task.subtasks.map(cloneGoalTask) : undefined,
	};
}

export function cloneGoal(goal: GoalRecord): GoalRecord {
	return {
		...goal,
		usage: { ...goal.usage },
		taskList: goal.taskList
			? { ...goal.taskList, tasks: goal.taskList.tasks.map(cloneGoalTask) }
			: undefined,
	};
}

export function goalFocusDetails(focusedGoalId: string | null, reason: GoalFocusReason): GoalFocusEntry {
	return {
		version: 1,
		focusedGoalId: focusedGoalId ? safeIdPart(focusedGoalId) : null,
		reason,
	};
}

export function normalizeGoalFocusEntry(value: unknown): GoalFocusEntry | null {
	const raw = asRecord(value);
	if (!raw || raw.version !== 1) return null;
	const focusedGoalId = typeof raw.focusedGoalId === "string" && raw.focusedGoalId.trim()
		? safeIdPart(raw.focusedGoalId)
		: null;
	const reason: GoalFocusReason =
		raw.reason === "created" || raw.reason === "selected" || raw.reason === "unfocused" || raw.reason === "resumed" || raw.reason === "completed" || raw.reason === "cleared" || raw.reason === "aborted" || raw.reason === "migrated"
			? raw.reason
			: "selected";
	return { version: 1, focusedGoalId, reason };
}

export function createGoal(config: GoalCreationConfig, now = Date.now()): GoalRecord {
	const timestamp = nowIso(now);
	return {
		id: newGoalId(),
		objective: config.objective,
		status: "active",
		autoContinue: config.autoContinue,
		usage: emptyUsage(),
		sisyphus: config.sisyphus,
		createdAt: timestamp,
		updatedAt: timestamp,
	};
}

export function normalizeUsage(value: unknown): GoalUsage {
	const raw = asRecord(value);
	if (!raw) return emptyUsage();
	const tokensUsed = typeof raw.tokensUsed === "number" && Number.isFinite(raw.tokensUsed) ? Math.max(0, Math.floor(raw.tokensUsed)) : 0;
	const activeSeconds = typeof raw.activeSeconds === "number" && Number.isFinite(raw.activeSeconds) ? Math.max(0, Math.floor(raw.activeSeconds)) : 0;
	return { tokensUsed, activeSeconds };
}

export function normalizeTaskItem(raw: Record<string, unknown>): GoalTask | undefined {
	const id = typeof raw.id === "string" && raw.id.trim() ? raw.id.trim() : "";
	const title = typeof raw.title === "string" ? raw.title.trim() : "";
	if (!id || !title) return undefined;
	const status: TaskStatus = raw.status === "complete" ? "complete" : raw.status === "skipped" ? "skipped" : "pending";
	const subtasksRaw = raw.subtasks;
	let subtasks: GoalTask[] | undefined;
	if (Array.isArray(subtasksRaw)) {
		subtasks = subtasksRaw
			.map((item) => (item && typeof item === "object" ? normalizeTaskItem(item as Record<string, unknown>) : undefined))
			.filter((t): t is GoalTask => !!t);
		if (subtasks.length === 0) subtasks = undefined;
	}
	return {
		id,
		title,
		status,
		completedAt: typeof raw.completedAt === "string" ? raw.completedAt : undefined,
		skippedAt: typeof raw.skippedAt === "string" ? raw.skippedAt : undefined,
		evidence: typeof raw.evidence === "string" ? raw.evidence : undefined,
		skipReason: typeof raw.skipReason === "string" ? raw.skipReason : undefined,
		verificationContract: typeof raw.verificationContract === "string" ? raw.verificationContract : undefined,
		lightweightSubtasks: raw.lightweightSubtasks === true ? true : undefined,
		subtasks,
	};
}

export function normalizeTaskList(value: unknown): GoalTaskList | undefined {
	const raw = asRecord(value);
	if (!raw) return undefined;
	const tasksRaw = raw.tasks;
	if (!Array.isArray(tasksRaw)) return undefined;
	const tasks: GoalTask[] = tasksRaw
		.map((item) => (item && typeof item !== "object" || Array.isArray(item) ? undefined : normalizeTaskItem(item as Record<string, unknown>)))
		.filter((t): t is GoalTask => !!t);
	if (tasks.length === 0) return undefined;
	return {
		tasks,
		blockCompletion: raw.blockCompletion === true,
		proposedAt: typeof raw.proposedAt === "string" ? raw.proposedAt : nowIso(),
	};
}

/**
 * Shared positive-safe-integer normalization for persisted numeric values such
 * as tokenBudget. Non-finite, fractional, zero, negative, and unsafe numbers
 * normalize to absent rather than silently changing meaning. Live tool input
 * is validated separately (rejected with a user-facing message); this handles
 * persisted legacy values.
 */
/**
 * Live-input validation for token_budget (shared by slash-command parsing, tool
 * execution, and record creation). Tool callers are untrusted, so the schema
 * Type.Integer bound is double-checked at runtime with Number.isSafeInteger.
 */
export function validateTokenBudgetInput(value: unknown): { ok: true; value: number } | { ok: false; message: string } {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return { ok: false, message: "token_budget must be a number." };
	}
	if (!Number.isSafeInteger(value)) {
		return { ok: false, message: "token_budget must be a whole safe integer (fractional values are not accepted)." };
	}
	if (value < 1) {
		return { ok: false, message: "token_budget must be at least 1." };
	}
	return { ok: true, value };
}

export function normalizePositiveSafeInteger(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 ? value : undefined;
}

export function normalizeGoalRecord(value: unknown): GoalRecord | null {
	const raw = asRecord(value);
	if (!raw) return null;
	const objective = typeof raw.objective === "string" ? raw.objective.trim() : "";
	if (!objective) return null;

	const timestamp = nowIso();
	// Persisted lifecycle status is authoritative. autoContinue is an execution
	// preference only: it must never rewrite status during reads or migration.
	const rawStatus = raw.status;
	const status: GoalStatus = rawStatus === "complete"
		? "complete"
		: rawStatus === "paused"
			? "paused"
			: rawStatus === "budget_limited"
				? "budget_limited"
				: rawStatus === "blocked"
					? "blocked"
					: "active";
	// autoContinue normalizes independently of status.
	const autoContinue = typeof raw.autoContinue === "boolean" ? raw.autoContinue : true;
	const usage = normalizeUsage(raw.usage);
	const sisyphus = raw.sisyphus === true;

	return {
		id: typeof raw.id === "string" && raw.id ? safeIdPart(raw.id) : newGoalId(),
		objective,
		status,
		autoContinue,
		usage,
		sisyphus,
		createdAt: typeof raw.createdAt === "string" ? raw.createdAt : timestamp,
		updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : timestamp,
		activePath: typeof raw.activePath === "string" ? raw.activePath : undefined,
		archivedPath: typeof raw.archivedPath === "string" ? raw.archivedPath : undefined,
		stopReason: raw.stopReason === "agent" || raw.stopReason === "user" ? raw.stopReason : undefined,
		pauseReason: typeof raw.pauseReason === "string" && raw.pauseReason.trim() ? raw.pauseReason : undefined,
		pauseSuggestedAction: typeof raw.pauseSuggestedAction === "string" && raw.pauseSuggestedAction.trim() ? raw.pauseSuggestedAction : undefined,
		skipAuditor: raw.skipAuditor === true ? true : undefined,
		tokenBudget: normalizePositiveSafeInteger(raw.tokenBudget),
		taskList: normalizeTaskList(raw.taskList),
		verificationContract: typeof raw.verificationContract === "string" ? raw.verificationContract : undefined,
	};
}
