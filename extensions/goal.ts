import { StringEnum, Type } from "@earendil-works/pi-ai";
import { defineTool, type AgentToolResult, type ExtensionAPI, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, Text, visibleWidth } from "@earendil-works/pi-tui";
import {
	footerStatus,
	formatDuration,
	formatTokenValue,
	statusLabel,
	truncateText,
} from "./goal-core.ts";
import {
	buildDraftConfirmationText,
	buildTweakConfirmationText,
	extractVerificationContract,
	goalDraftingPrompt,
	renderConfirmationTasks,
	validateGoalDraftProposal,
	type GoalDraftingFocus,
} from "./goal-draft.ts";
import {
	runGoalCompletionAuditor,
} from "./goal-auditor.ts";
import {
	goalSettingsPath,
	isAuditorEnabledByDefault,
	loadGoalSettings,
	loadGoalSettingsFileConfig,
	saveGoalSettingsFileConfig,
	type GoalSettings,
} from "./goal-settings.ts";
import {
	proposalDialogFailureMessage,
	registerQuestionnaireTools,
	shouldAutoConfirmProposal,
	showProposalDialog,
} from "./goal-questionnaire.ts";
import {
	ABORT_GOAL_TOOL_NAME,
	COMPLETE_TASK_TOOL_NAME,
	CREATE_GOAL_TOOL_NAME,
	GET_GOAL_TOOL_NAME,
	LEGACY_TASK_TOOL_NAMES,
	PROPOSE_DRAFT_TOOL_NAME,
	PROPOSE_TASK_LIST_TOOL_NAME,
	PROPOSE_TWEAK_TOOL_NAME,
	QUESTIONNAIRE_TOOL_NAME,
	QUESTION_TOOL_NAME,
	SET_GOAL_TASKS_TOOL_NAME,
	SISYPHUS_STEP_TOOL_NAME,
	TASK_TOOL_NAMES,
	UPDATE_GOAL_TASK_TOOL_NAME,
	UPDATE_GOAL_TOOL_NAME,
	GOAL_PROGRESS_TOOL_NAMES,
	SKIP_TASK_TOOL_NAME,
} from "./goal-tool-names.ts";
import {
	asRecord,
	cloneGoal,
	createGoal,
	goalFocusDetails,
	normalizeGoalRecord,
	normalizeGoalFocusEntry,
	normalizeTaskItem,
	nowIso,
	type AssistantMessageLike,
	type DraftingFocus,
	type GoalFocusEntry,
	type GoalFocusReason,
	type GoalCreationConfig,
	type GoalEventDetails,
	type GoalEventKind,
	type GoalRecord,
	type GoalStateEntry,
	type GoalStatus,
	type StopReason,
	type GoalTask,
	type GoalTaskList,
} from "./goal-record.ts";
import {
	latestAuditorResultForGoal,
	readGoalLedger,
	type GoalLedgerEvent,
} from "./goal-ledger.ts";
import { buildCompactionSummary } from "./goal-compaction.ts";
import {
	mergeGoalPromptFromDisk,
	readActiveGoalPool,
	sanitizeGoalPaths,
	serializeGoalFile,
} from "./storage/goal-files.ts";
import { GoalService } from "./goal-service.ts";
import { convertFlatTasks, mergeTasksWithExisting, type FlatTaskInput } from "./goal-task-tools.ts";
import { GoalAccounting, budgetLine, budgetReached } from "./goal-accounting.ts";
import { GoalRuntime } from "./goal-runtime.ts";
import {
	buildGoalListText,
	buildUnfocusedOpenGoalsSummary,
	focusedGoalFromPool,
	goalSelectorLabel,
	openGoalsFromPool,
	otherOpenGoalCount,
	resolveSessionFocus,
} from "./goal-pool.ts";
import {
	goalPrompt,
	goalTweakDraftingPrompt,
	staleContinuationPrompt,
	unfocusedOpenGoalsPrompt,
	untrustedObjectiveBlock,
} from "./prompts/goal-prompts.ts";
import { buildGoalRunningNotification } from "./widgets/goal-notifications.ts";
import { GoalWidgetComponent, type AuditorWidgetProgress } from "./widgets/goal-widget.ts";
import { showEscapeDialog, type EscapeDialogResult } from "./widgets/goal-escape-dialog.ts";
import { showTaskListOverlay } from "./widgets/task-list-overlay.ts";

import {
	abortGoalCommandMessage,
	buildAbortedByAgentGoal,
	buildCompletionReport,
	buildGoalCreatedReport,
	buildPausedByAgentGoal,
	buildTaskSummary,
	clearGoalCommandMessage,
	shouldArmPostCompactReminder,
	shouldInjectPostCompactReminder,
	taskCompletionBlockWarning,
	validateGoalAbort,
	validateGoalBlock,
	validateGoalCompletion,
	validatePauseGoal,
	checkSubtasksComplete,
	findSubtaskDepthViolation,
	findTaskInTree,
	skipAllSubtasks,
	updateTaskInTree,
	validateResumeGoal,
	validateTaskCompletion,
	validateTaskListProposal,
	validateTaskSkip,
	validateVerificationSummary,
} from "./goal-policy.ts";

const STATE_ENTRY = "pi-goal-state";
const FOCUS_ENTRY = "pi-goal-focus";
const GOAL_EVENT_ENTRY = "pi-goal-event";
const GOAL_AUDIT_ENTRY = "pi-goal-audit-event";
const COMPLETE_STATUS = "complete";
/**
 * Tools that count as "real work" toward the active goal. If a non-tool-use
 * turn ends without any of these having been called, we DO NOT queue the next
 * autoContinue — the agent was just chatting. This stops infinite chat loops.
 */
const GOAL_PROGRESS_TOOL_SET = new Set<string>(GOAL_PROGRESS_TOOL_NAMES);

/**
 * When non-null, /goal-tweak drafting is in progress for this goal id and the
 * agent is allowed to call propose_goal_tweak. Cleared after the tweak is applied
 * or when a user-driven turn arrives without a tweak follow-through. This is
 * the schema-level affordance gate that prevents the agent from "tweaking" via
 * arbitrary write/edit calls.
 */
let tweakDraftingFor: string | null = null;

/**
 * Thin session-local confirmation intent for /goals and /sisyphus.
 * It protects mode consistency and user confirmation without turning drafting
 * into a separate long-running runtime state machine.
 */
interface GoalConfirmationIntent {
	focus: GoalDraftingFocus;
	originalTopic: string;
	startedAt: number;
}
let confirmationIntent: GoalConfirmationIntent | null = null;


// ---------- summaries ----------

function usageLines(goal: GoalRecord): string[] {
	return [
		`Time spent: ${formatDuration(goal.usage.activeSeconds)}`,
		`Tokens used: ${formatTokenValue(goal.usage.tokensUsed)}`,
	];
}

function detailedSummary(goal: GoalRecord | null): string {
	if (!goal) return "No goal is set. Use /goals <topic> or /sisyphus <topic> to discuss, or /goals-set <objective> / /sisyphus-set <objective> to start immediately.";
	const lines = [
		`Goal: ${goal.objective}`,
		`Status: ${statusLabel(goal)}`,
		`Auto-continue: ${goal.autoContinue ? "on" : "off"}`,
		...usageLines(goal),
	];
	if (goal.sisyphus) {
		lines.push("Mode: Sisyphus (prompt/criteria variant; shared goal lifecycle)");
	}
	if (goal.taskList) {
		const taskSummary = buildTaskSummary(goal.taskList);
		lines.push(`Tasks: ${taskSummary}`);
		// Find first pending task at any depth (BFS)
		const queue = [...(goal.taskList.tasks ?? [])];
		let firstPending: { id: string; title: string } | undefined;
		while (queue.length > 0 && !firstPending) {
			const t = queue.shift()!;
			if (t.status === "pending") firstPending = t;
			else if (t.subtasks) queue.push(...t.subtasks);
		}
		if (firstPending) {
			lines.push(`Next pending task: ${firstPending.id} — ${firstPending.title}`);
		}
	}
	if (goal.activePath) lines.push(`File: ${goal.activePath}`);
	if (goal.archivedPath) lines.push(`Archive: ${goal.archivedPath}`);
	if (goal.stopReason) lines.push(`Stop reason: ${goal.stopReason}`);
	if (goal.pauseReason) lines.push(`Agent pause reason: ${goal.pauseReason}`);
	if (goal.pauseSuggestedAction) lines.push(`Agent suggests: ${goal.pauseSuggestedAction}`);
	return lines.join("\n");
}

function oneLineSummary(goal: GoalRecord | null): string {
	if (!goal) return "No goal is set.";
	const tail = goal.usage.tokensUsed > 0 ? ` [${formatTokenValue(goal.usage.tokensUsed).split(" ")[0]}]` : "";
	return `${statusLabel(goal)}${tail} - ${truncateText(goal.objective)}`;
}

// ---------- entry / render helpers ----------

function goalDetails(goal: GoalRecord | null): GoalStateEntry {
	return { version: 3, goal: goal ? cloneGoal(goal) : null };
}

function renderGoalResult(result: { details?: unknown; content: Array<{ type: string; text?: string }> }, theme: Theme): Text {
	const first = result.content.find((item) => item.type === "text" && typeof item.text === "string");
	const firstText = first?.text ?? "";
	const details = result.details as GoalStateEntry | undefined;
	if (!details || typeof details !== "object" || !("goal" in details)) {
		return new Text(firstText, 0, 0);
	}
	if (
		firstText.startsWith("Goal audit ")
		|| firstText.startsWith("Goal completion rejected")
		|| firstText.startsWith("Goal complete.")
		|| firstText.startsWith("Goal paused.")
		|| firstText.startsWith("Goal aborted.")
		|| firstText.startsWith("Goal confirmed and created.")
	) {
		return new Text(firstText, 0, 0);
	}
	return new Text(theme.fg("accent", "Goal ") + theme.fg("muted", oneLineSummary(details.goal)), 0, 0);
}

function normalizeGoalEventDetails(value: unknown): GoalEventDetails {
	const raw = asRecord(value);
	const kind: GoalEventKind = raw?.kind === "stale" ? "stale" : raw?.kind === "drafting" ? "drafting" : "checkpoint";
	const goalId = typeof raw?.goalId === "string" ? raw.goalId : "unknown";
	const focus: DraftingFocus | undefined = raw?.focus === "sisyphus" ? "sisyphus" : raw?.focus === "goal" ? "goal" : undefined;
	const status = raw?.status === "active" || raw?.status === "paused" || raw?.status === "complete" ? (raw.status as GoalStatus) : undefined;
	const currentStatus =
		raw?.currentStatus === "active" || raw?.currentStatus === "paused" || raw?.currentStatus === "complete"
			? (raw.currentStatus as GoalStatus)
			: raw?.currentStatus === null
				? null
				: undefined;
	return {
		kind,
		goalId,
		status,
		objective: typeof raw?.objective === "string" ? raw.objective : undefined,
		timestamp: typeof raw?.timestamp === "number" ? raw.timestamp : undefined,
		currentGoalId: typeof raw?.currentGoalId === "string" || raw?.currentGoalId === null ? raw.currentGoalId : undefined,
		currentStatus,
		focus,
	};
}

interface GoalAuditEventDetails {
	phase: "started" | "approved" | "rejected" | "skipped";
	goalId: string;
	auditor?: string;
}

function renderGoalEvent(message: { details?: GoalEventDetails }, options: { expanded: boolean }, theme: Theme): Text {
	const details = normalizeGoalEventDetails(message.details);
	const label =
		details.kind === "stale" ? "stale checkpoint"
			: details.kind === "drafting" ? (details.focus === "sisyphus" ? "sisyphus drafting" : "goal drafting")
				: "checkpoint";
	if (!options.expanded) {
		return new Text(theme.fg("customMessageLabel", "Goal ") + theme.fg("customMessageText", label), 0, 0);
	}
	const lines = [`Status: ${details.status === "active" ? "running" : details.status ?? "unknown"}`];
	if (details.objective) lines.push(`Objective: ${details.objective}`);
	lines.push(`Goal id: ${details.goalId}`);
	if (details.currentGoalId || details.currentStatus) {
		lines.push(`Current: ${details.currentGoalId ?? "none"}${details.currentStatus ? ` (${details.currentStatus})` : ""}`);
	}
	return new Text(
		theme.fg("customMessageLabel", `Goal ${label}`) + "\n" + theme.fg("customMessageText", lines.join("\n")),
		0,
		0,
	);
}

function renderGoalAuditEvent(message: { content?: unknown; details?: GoalAuditEventDetails }, _options: { expanded: boolean }, theme: Theme): Text {
	const phase = message.details?.phase ?? "started";
	const label = phase === "approved" ? "approved" : phase === "rejected" ? "rejected" : phase === "skipped" ? "skipped" : "started";
	const content = typeof message.content === "string" ? message.content : `Goal audit ${label}.`;
	return new Text(
		theme.fg("customMessageLabel", `Goal audit ${label}`) + "\n" + theme.fg("customMessageText", content),
		0,
		0,
	);
}

function extractGoalIdFromInjectedMessage(text: string): string | null {
	// Drafting messages (new goal, sisyphus, or tweak) have no continuation goalId and
	// must never be treated as stale-continuation triggers.
	if (/^\[GOAL (?:DRAFTING|TWEAK DRAFTING)\b/.test(text)) return null;
	// Phase 5 C1: structured outer marker `<pi_goal_continuation goal_id="..." kind="...">`.
	// Borrowed from pi-codex-goal. More robust than bare bracket text because
	// the angle brackets + attributes are nearly impossible for users to type
	// by accident, and the structure is grep-able / parse-able by external tooling.
	const xmlMatch = text.match(/^<pi_goal_continuation\s+goal_id=\"([^\"]+)\"/);
	if (xmlMatch) return xmlMatch[1] ?? null;
	const match = text.match(/^\[(?:GOAL CHECKPOINT|GOAL CONTINUATION|GOAL STALE) goalId=([^\]\s]+)\]/);
	return match?.[1] ?? null;
}

function goalEventMessageId(message: { customType?: string; details?: unknown; content?: unknown }): string | null {
	if (message.customType !== GOAL_EVENT_ENTRY) return null;
	const details = asRecord(message.details);
	// Drafting messages never correspond to a real goal id; they must not be staleness-checked.
	if (details?.kind === "drafting") return null;
	const goalId = details && typeof details.goalId === "string" ? details.goalId : null;
	if (goalId) return goalId;
	return typeof message.content === "string" ? extractGoalIdFromInjectedMessage(message.content) : null;
}

function isAbortedAssistantMessage(message: unknown): boolean {
	const raw = asRecord(message);
	return raw?.role === "assistant" && raw.stopReason === "aborted";
}

function isToolUseAssistantMessage(message: unknown): boolean {
	const raw = asRecord(message);
	return raw?.role === "assistant" && raw.stopReason === "toolUse";
}

function hasAbortedAssistantMessage(messages: unknown[]): boolean {
	return messages.some(isAbortedAssistantMessage);
}

function usageChannelTokens(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return 0;
	return Math.max(0, Math.trunc(value));
}

function assistantTurnTokens(message: unknown): number {
	const raw = asRecord(message);
	if (!raw || raw.role !== "assistant") return 0;
	const usage = asRecord(raw.usage);
	if (!usage) return 0;
	return usageChannelTokens(usage.input) + usageChannelTokens(usage.output);
}

function isMeaningfulProgressToolCall(toolName: string, args: unknown): boolean {
	if (!GOAL_PROGRESS_TOOL_SET.has(toolName)) return false;
		if (toolName === "read") {
			const path = asRecord(args)?.path;
			if (typeof path === "string" && (path === ".pi/goals" || path.startsWith(".pi/goals/"))) return false;
		}
		if (toolName === "bash") {
			const command = asRecord(args)?.command;
			if (typeof command === "string" && /^\s*echo\b/.test(command)) return false;
		}
	return true;
}

// ---------- extension entry point ----------

export default function goalExtension(
	pi: ExtensionAPI,
	dependencies: { runCompletionAuditor?: typeof runGoalCompletionAuditor } = {},
): void {
	let goalsById = new Map<string, GoalRecord>();
	let focusedGoalId: string | null = null;
	let focusRevision = 0;
	let hasExplicitSessionFocus = false;

	function assignFocusedGoalId(next: string | null): void {
		if (focusedGoalId !== next) focusRevision += 1;
		focusedGoalId = next;
	}

	function focusedOperationToken(goalId: string): { goalId: string; revision: number } {
		return { goalId, revision: focusRevision };
	}

	function isFocusedOperationCurrent(token: { goalId: string; revision: number }): boolean {
		return focusedGoalId === token.goalId && focusRevision === token.revision;
	}

	function focusedOperationCancelledResult(action: string, token: { goalId: string; revision: number }) {
		return {
			content: [{
				type: "text" as const,
				text: `${action} cancelled because goal ${token.goalId} is no longer focused in this session. The shared goal was not modified.`,
			}],
			details: goalDetails(state.goal),
			terminate: true,
		};
	}

	const state = {
		get goal(): GoalRecord | null {
			return focusedGoalFromPool(goalsById, focusedGoalId);
		},
		set goal(next: GoalRecord | null) {
			if (next) {
				goalsById.set(next.id, next);
				assignFocusedGoalId(next.id);
				return;
			}
			if (focusedGoalId) goalsById.delete(focusedGoalId);
			assignFocusedGoalId(null);
		},
	};

	/**
	 * Sole mutation boundary for goal records. All goal-file writes, ledger
	 * appends, and ordered write→ledger→memory commits route through this
	 * service; goal.ts handlers keep validation and runtime/UI effects.
	 */
	const goalService = new GoalService({
		getFocused: () => state.goal,
		setFocused: (goal) => {
			state.goal = goal;
		},
		getPool: () => goalsById,
		replacePool: (pool) => {
			goalsById = pool;
		},
		getFocusedGoalId: () => focusedGoalId,
		assignFocusedGoalId: (goalId) => assignFocusedGoalId(goalId),
		focusToken: (goalId) => focusedOperationToken(goalId),
		isTokenCurrent: (token) => isFocusedOperationCurrent(token),
		appendFocusEntry: (goalId, reason) => appendFocusEntry(goalId, reason),
		onFocusedGoalLost: (lostGoalId, ctx) => {
			clearStoppedRuntimeState();
			if (tweakDraftingFor !== null) tweakDraftingFor = null;
			syncGoalTools();
			updateUI(ctx as unknown as ExtensionContext);
		},
		onReconciled: (goal) => {
			if (goal.status !== "active" || !goal.autoContinue) clearContinuationState();
			if (goal.status !== "active") clearActiveAccounting();
		},
		onFocusChanged: () => {
			clearContinuationState();
			clearActiveAccounting();
		},
	});
	let runningGoalId: string | null = null;
	let terminalInputUnsubscribe: (() => void) | null = null;
	let auditProgress: AuditorWidgetProgress | null = null;
	let auditAnimationTimer: ReturnType<typeof setInterval> | null = null;
	let auditAbortController: AbortController | null = null;
	let showingEscapeDialog = false;
	let debugMode = false;
	let debugGoalCounter = 0;
	let debugMockAuditTimer: ReturnType<typeof setInterval> | null = null;
	const DEBUG_GOALS_DIR = ".pi/goals/debug";

	// Per-turn flags reset in turn_start (#4, C9 fix).
	// goalWorkToolCalledThisTurn: tracks whether a real goal-work tool was called.
	//   If false at turn_end, we don't queue another autoContinue (empty chat turn).
	// turn-stop guard, stale checkpoint, continuation scheduling, and one-time
	// steering reminders live in `runtime` (extensions/goal-runtime.ts);
	// token/time accounting lives in `accounting` (extensions/goal-accounting.ts).
	let goalWorkToolCalledThisTurn = false;

	const runtime = new GoalRuntime({
		sendFollowUp: (content, details) => {
			pi.sendMessage<GoalEventDetails>(
				{
					customType: GOAL_EVENT_ENTRY,
					content,
					display: false,
					details: details as unknown as GoalEventDetails,
				},
				{ triggerTurn: true, deliverAs: "followUp" },
			);
		},
		getGoal: () => state.goal,
		isActionable: (goalId) => isActionableContinuationGoal(goalId),
		syncTools: () => syncGoalTools(),
	});
	const accounting = new GoalAccounting();

	const goalExecutionWorkTools = ["read", "bash", "edit", "write"] as const;

	// Whether the task tools are advertised, decided once at session start from
	// settings (disableTasks). Stage 4 replaces them with the two task tools.
	let tasksEnabled = true;

	function syncGoalTools(): void {
		try {
			const initialTools = pi.getActiveTools();
			if (!Array.isArray(initialTools)) {
				console.error("[pi-goal] syncGoalTools: pi.getActiveTools() did not return an array, got", typeof initialTools);
				return;
			}
			const active = new Set(initialTools);
			for (const name of goalExecutionWorkTools) active.add(name);
			// Remove every goal tool that must not be visible; the stable core set
			// and phase-conditional shims are then added back explicitly.
			for (const name of [
				QUESTION_TOOL_NAME,
				QUESTIONNAIRE_TOOL_NAME,
				"complete_goal",
				"pause_goal",
				ABORT_GOAL_TOOL_NAME,
				UPDATE_GOAL_TOOL_NAME,
				PROPOSE_TWEAK_TOOL_NAME,
				PROPOSE_DRAFT_TOOL_NAME,
				...LEGACY_TASK_TOOL_NAMES,
				...TASK_TOOL_NAMES,
				SISYPHUS_STEP_TOOL_NAME,
			]) {
				active.delete(name);
			}
			// Stable core: get_goal and create_goal are always advertised; update_goal
			// appears whenever a (non-complete) goal is focused — with no
			// phase-dependent synchronization (Stage 3).
			active.add(GET_GOAL_TOOL_NAME);
			active.add(CREATE_GOAL_TOOL_NAME);
			if (state.goal && state.goal.status !== "complete") {
				active.add(UPDATE_GOAL_TOOL_NAME);
			}
			// The two consolidated task tools are advertised only when tasks are
			// enabled and a goal is focused: both for active goals, set_goal_tasks
			// for paused (Stage 4).
			if (tasksEnabled && state.goal) {
				if (state.goal.status === "active") {
					for (const name of TASK_TOOL_NAMES) active.add(name);
				} else if (state.goal.status === "paused") {
					active.add(SET_GOAL_TASKS_TOOL_NAME);
				}
			}
			// Drafting/tweak/question flows keep their existing shim visibility
			// until Stage 6 removes them; they never leak into normal execution.
			if (confirmationIntent !== null) {
				active.add(PROPOSE_DRAFT_TOOL_NAME);
				active.add(QUESTION_TOOL_NAME);
				active.add(QUESTIONNAIRE_TOOL_NAME);
			}
			if (state.goal && tweakDraftingFor === state.goal.id) {
				active.add(PROPOSE_TWEAK_TOOL_NAME);
				active.add(QUESTION_TOOL_NAME);
				active.add(QUESTIONNAIRE_TOOL_NAME);
			}
			if (confirmationIntent === null && tweakDraftingFor === null && state.goal?.status === "active") {
				active.add(QUESTION_TOOL_NAME);
				active.add(QUESTIONNAIRE_TOOL_NAME);
			}
			pi.setActiveTools(Array.from(active));
		} catch (err) {
			console.error("[pi-goal] syncGoalTools error:", err instanceof Error ? err.message : String(err));
		}
	}

	function stopAuditAnimation(): void {
		if (auditAnimationTimer) {
			clearInterval(auditAnimationTimer);
			auditAnimationTimer = null;
		}
	}

	function abortAudit(ctx: ExtensionContext): void {
		if (!auditAbortController || !auditProgress) return;
		const settings = loadGoalSettingsFileConfig(ctx.cwd);
		auditAbortController.abort();
		auditAbortController = null;
		stopAuditAnimation();
		auditProgress = null;
		goalWidgetComponent?.invalidate();
		if (state.goal) {
			try {
				goalService.appendEvents(ctx, [{
					type: "audit_skipped",
					goalId: state.goal.id,
					reason: "user_aborted",
					provider: settings.provider,
					model: settings.model,
					thinkingLevel: settings.thinkingLevel,
					at: nowIso(),
				}]);
			} catch {
				// Ledger append failure should not block skip
			}
		}
	}

	function clearContinuationTimer(): void {
		runtime.clearContinuationTimer();
	}

	function clearContinuationState(): void {
		runtime.clearContinuationState();
	}

	function clearActiveAccounting(): void {
		accounting.clear();
	}

	function advanceTurnSeq(): void {
		runtime.advanceTurn();
	}

	function currentTurnStoppedGoalId(): string | null {
		return runtime.currentTurnStoppedGoalId();
	}

	function isActionableContinuationGoal(goalId: string | null | undefined): goalId is string {
		return !!goalId && state.goal?.id === goalId && state.goal.status === "active" && state.goal.autoContinue;
	}

	function isStaleCheckpointBlockedToolCall(toolName: string): boolean {
		return runtime.isStaleCheckpointBlocked(toolName);
	}

	function clearStoppedRuntimeState(): void {
		clearContinuationState();
		clearActiveAccounting();
	}



	function openGoals(): GoalRecord[] {
		return openGoalsFromPool(goalsById);
	}

	function reconcileFocusedGoalFromDisk(ctx: ExtensionContext, opts: { preserveMemoryUsage?: boolean } = {}): boolean {
		return goalService.reconcileFocused(ctx, opts);
	}

	function appendFocusEntry(goalId: string | null, reason: GoalFocusReason): void {
		hasExplicitSessionFocus = true;
		pi.appendEntry(FOCUS_ENTRY, goalFocusDetails(goalId, reason));
	}

	function setFocusedGoalId(
		goalId: string | null,
		ctx: ExtensionContext,
		reason: GoalFocusReason,
		opts: { recordLedger?: boolean } = {},
	): void {
		const previousGoalId = focusedGoalId;
		assignFocusedGoalId(goalId && goalsById.has(goalId) ? goalId : null);
		if (previousGoalId !== focusedGoalId) {
			clearContinuationState();
			clearActiveAccounting();
			if (tweakDraftingFor !== null && tweakDraftingFor !== focusedGoalId) tweakDraftingFor = null;
		}
		appendFocusEntry(focusedGoalId, reason);
		// Append ledger event for focus changes
		try {
			if (opts.recordLedger !== false && focusedGoalId) {
				goalService.appendEvents(ctx, [{ type: "goal_focused", goalId: focusedGoalId, reason, at: nowIso() }]);
			} else if (opts.recordLedger !== false && previousGoalId) {
				goalService.appendEvents(ctx, [{ type: "goal_unfocused", reason, at: nowIso() }]);
			}
		} catch {
			// Ledger append failure should not crash focus change
		}
		syncGoalTools();
		updateUI(ctx);
	}

	function updateFocusedGoal(next: GoalRecord, ctx: ExtensionContext, shouldPersist = true): void {
		const previousGoalId = focusedGoalId;
		goalsById.set(next.id, next);
		assignFocusedGoalId(next.id);
		if (previousGoalId !== focusedGoalId) {
		}
		if (shouldPersist) persist(ctx);
		else syncGoalTools();
		updateUI(ctx);
	}

	function armFocusedContinuation(ctx: ExtensionContext): void {
		beginAccounting();
		if (state.goal?.status === "active" && state.goal.autoContinue) queueContinuation(ctx, true);
	}

	function removeFocusedGoal(ctx: ExtensionContext, reason: GoalFocusReason): void {
		const previousGoalId = focusedGoalId;
		if (focusedGoalId) goalsById.delete(focusedGoalId);
		assignFocusedGoalId(null);
		clearStoppedRuntimeState();
		appendFocusEntry(null, reason);
		syncGoalTools();
		updateUI(ctx);
	}

	function beginAccounting(): void {
		if (confirmationIntent !== null || tweakDraftingFor !== null) {
			clearActiveAccounting();
			return;
		}
		if (!state.goal || (state.goal.status !== "active")) {
			clearActiveAccounting();
			return;
		}
		accounting.begin(state.goal.id);
	}

	function goalForDisplay(): GoalRecord | null {
		if (!state.goal || state.goal.status !== "active" || !accounting.isActiveFor(state.goal.id)) {
			return state.goal;
		}
		const liveSeconds = accounting.liveSeconds();
		if (liveSeconds === 0) return state.goal;
		const live = cloneGoal(state.goal);
		live.usage.activeSeconds += liveSeconds;
		return live;
	}

	function accountProgress(ctx: ExtensionContext, opts: { completedTurnTokens?: number } = {}): void {
		if (confirmationIntent !== null || tweakDraftingFor !== null) {
			clearActiveAccounting();
			return;
		}
		// Skip disk reconciliation for complete goals — they are pending archival at turn_end.
		if (state.goal?.activePath && state.goal?.status !== "complete" && !reconcileFocusedGoalFromDisk(ctx, { preserveMemoryUsage: true })) return;
		if (!state.goal || state.goal.status !== "active" || !accounting.isActiveFor(state.goal.id)) {
			beginAccounting();
			return;
		}

		// Serialized idempotent charge: never double-charges the same interval.
		const { tokens, seconds } = accounting.charge({ completedTurnTokens: opts.completedTurnTokens });
		if (tokens === 0 && seconds === 0) return;

		const next = cloneGoal(state.goal);
		next.usage.tokensUsed += tokens;
		next.usage.activeSeconds += seconds;
		next.updatedAt = nowIso();
		state.goal = next;
		persist(ctx);

		// Token-budget transition: when accounted usage reaches the budget, mark the
		// goal budget_limited exactly once (status no longer active, so accounting
		// stops and the transition cannot re-fire), emit the ledger event, arm the
		// one-time wrap-up steering, and cancel pending continuations.
		const budgetGoal = state.goal;
		if (budgetGoal && budgetGoal.status === "active" && typeof budgetGoal.tokenBudget === "number" && budgetReached(budgetGoal)) {
			const transition = goalService.apply(ctx, {
				reconcile: false,
				mutate: (g) => ({ ...g, status: "budget_limited" as const, updatedAt: nowIso() }),
				ledger: (written) => [{
					type: "goal_budget_limited",
					goalId: written.id,
					budget: budgetGoal.tokenBudget ?? 0,
					tokensUsed: written.usage.tokensUsed,
					at: written.updatedAt,
				}],
			});
			if (transition.ok) {
				runtime.armPostBudgetReminder();
				runtime.clearContinuationState();
				accounting.clear();
				syncGoalTools();
				updateUI(ctx);
			}
		}
	}

	function syncGoalPromptFromDisk(ctx: ExtensionContext): boolean {
		if (!state.goal || state.goal.status === "complete") return false;
		const previousObjective = state.goal.objective;
		state.goal = mergeGoalPromptFromDisk(ctx, state.goal);
		return state.goal.objective !== previousObjective;
	}

	function persist(ctx?: ExtensionContext): void {
		if (ctx) {
			goalService.persist(ctx);
		} else {
			const current = state.goal;
			if (current) state.goal = { ...current, updatedAt: nowIso() };
		}
		syncGoalTools();
		if (ctx) updateUI(ctx);
	}

	function refreshGoalDisplayFromDisk(ctx: ExtensionContext): void {
		if (!state.goal || state.goal.status === "complete") return;
		if (syncGoalPromptFromDisk(ctx)) {
			state.goal = { ...state.goal, updatedAt: nowIso() };
		}
		syncGoalTools();
		updateUI(ctx);
	}

	/**
	 * Live above-editor widget for the active goal. Inspired by rpiv-todo's
	 * TodoOverlay: register the widget once with a factory, read live state
	 * via the closure at render time, and call `tui.requestRender()` on every
	 * state change so the overlay refreshes without re-registration. Normal pi
	 * renders still read current values through the closure; do not request
	 * periodic renders just to tick elapsed time because terminal redraws pull
	 * users out of scrollback while they review long goals and earlier context.
	 *
	 * Layout (sisyphus, running):
	 *   ◆ Sisyphus  [▰▰▰▱▱] 3/5
	 *   ├─ ⟡ extract validator … wire it … update tests.
	 *   ├─ Status: sisyphus running · auto-continue · 14m 21s · 24.3k tokens
	 *   └─ .pi/goals/active_goal_xxx.md
	 *
	 * Layout (paused with blocker):
	 *   ⊘ Goal paused
	 *   ├─ ⟡ improve benchmark coverage for the parser
	 *   ├─ Status: paused (agent) · 2m 14s · 12.4k tokens
	 *   ├─ Blocker: cannot find the tests directory
	 *   └─ Suggested: ask the user for the test location
	 */
	const GOAL_WIDGET_KEY = "goal";
	let widgetRegistered = false;
	let goalWidgetComponent: GoalWidgetComponent | null = null;

	function clearGoalWidget(ctx: ExtensionContext): void {
		ctx.ui.setStatus("goal", undefined);
		ctx.ui.setWidget(GOAL_WIDGET_KEY, undefined);
		widgetRegistered = false;
		goalWidgetComponent = null;
	}

	function updateUI(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		const totalOpen = openGoals().length;
		if (!state.goal && totalOpen === 0) {
			clearGoalWidget(ctx);
			return;
		}
		if (!state.goal) {
			ctx.ui.setStatus("goal", `goal: unfocused [${totalOpen} open] - /goal-focus`);
			if (!widgetRegistered) {
				ctx.ui.setWidget(
					GOAL_WIDGET_KEY,
					(tui, theme) => {
						goalWidgetComponent = new GoalWidgetComponent({
							tui,
							theme,
							getGoal: () => goalForDisplay() ?? state.goal,
							getOpenGoalCount: () => openGoals().length,
							getAuditorProgress: () => auditProgress,
							getSettings: () => loadGoalSettings(ctx.cwd),
							getDebugMode: () => debugMode,
						});
						return goalWidgetComponent;
					},
					{ placement: "aboveEditor" },
				);
				widgetRegistered = true;
			} else {
				goalWidgetComponent?.update();
			}
			return;
		}

		const displayGoal = goalForDisplay() ?? state.goal;
		const otherCount = otherOpenGoalCount(goalsById, focusedGoalId);
		ctx.ui.setStatus("goal", `${footerStatus(displayGoal)}${otherCount > 0 ? ` (+${otherCount} open)` : ""}`);

		if (!widgetRegistered) {
			ctx.ui.setWidget(
				GOAL_WIDGET_KEY,
				(tui, theme) => {
					goalWidgetComponent = new GoalWidgetComponent({
						tui,
						theme,
						getGoal: () => goalForDisplay() ?? state.goal,
						getOpenGoalCount: () => openGoals().length,
						getAuditorProgress: () => auditProgress,
						getSettings: () => loadGoalSettings(ctx.cwd),
						getDebugMode: () => debugMode,
					});
					return goalWidgetComponent;
				},
				{ placement: "aboveEditor" },
			);
			widgetRegistered = true;
		} else {
			goalWidgetComponent?.update();
		}
	}

	function loadState(ctx: ExtensionContext): void {
		goalsById = readActiveGoalPool(ctx);
		tasksEnabled = !loadGoalSettings(ctx.cwd).disableTasks;
		focusRevision += 1; // Session reload/tree navigation invalidates pending async focus operations.
		assignFocusedGoalId(null);
		hasExplicitSessionFocus = false;
		let focusEntry: GoalFocusEntry | null = null;
		let legacyGoal: GoalRecord | null = null;
		let legacyStateSeen = false;
		const entries = ctx.sessionManager.getBranch();
		for (let i = entries.length - 1; i >= 0; i--) {
			const entry = entries[i] as { type?: string; customType?: string; data?: unknown };
			if (entry.type !== "custom") continue;
			if (!focusEntry && entry.customType === FOCUS_ENTRY) {
				focusEntry = normalizeGoalFocusEntry(entry.data);
			}
			if (!legacyStateSeen && entry.customType === STATE_ENTRY) {
				legacyGoal = normalizeGoalRecord(asRecord(entry.data)?.goal);
				legacyStateSeen = true;
			}
			if (focusEntry && legacyStateSeen) break;
		}
		if (legacyGoal && legacyGoal.status !== "complete") {
			legacyGoal = sanitizeGoalPaths(ctx, mergeGoalPromptFromDisk(ctx, legacyGoal));
		}
		const settings = loadGoalSettings(ctx.cwd);
		hasExplicitSessionFocus = focusEntry !== null;
		assignFocusedGoalId(resolveSessionFocus({ pool: goalsById, focusEntry, legacyGoal, autoSelectSingleGoal: settings.autoSelectSingleGoal }));
		if (!focusEntry && focusedGoalId) {
			try {
				appendFocusEntry(focusedGoalId, legacyGoal?.id === focusedGoalId ? "migrated" : "selected");
			} catch {}
		}
		for (const [id, current] of goalsById) {
			if (current.status === "complete") {
				goalsById.delete(id);
			}
		}
		clearStoppedRuntimeState();
		runningGoalId = null;
		updateUI(ctx);
	}

	function setGoal(next: GoalRecord | null, ctx: ExtensionContext, shouldPersist = true, focusReason?: GoalFocusReason): void {
		const previousGoalId = state.goal?.id ?? null;
		state.goal = next;
		const focusChanged = previousGoalId !== focusedGoalId;
		if (focusChanged) {
			clearContinuationState();
			clearActiveAccounting();
		}
		if (focusReason && focusChanged) appendFocusEntry(focusedGoalId, focusReason);
		if (!state.goal || (state.goal.status !== "active") || !state.goal.autoContinue) {
			clearContinuationState();
		}
		if (!state.goal || state.goal.status === "paused" || state.goal.status === "complete") {
			clearActiveAccounting();
		}
		if (!state.goal || state.goal.id !== previousGoalId) {
			// Drop any stale tweak-edit-gate that didn't belong to this goal.
			if (tweakDraftingFor !== null && tweakDraftingFor !== state.goal?.id) tweakDraftingFor = null;
		}
		if (shouldPersist) persist(ctx);
		else syncGoalTools();
		updateUI(ctx);
	}

	function archiveCurrentGoal(ctx: ExtensionContext, reason: StopReason | undefined): GoalRecord | null {
		if (!state.goal) return null;
		const result = goalService.apply(ctx, {
			reconcile: false,
			refreshFromDisk: true,
			archive: true,
			commitFocused: false,
			mutate: (g) => {
				const status = g.status === "complete" ? "complete" : "paused";
				return { ...g, status, stopReason: reason };
			},
		});
		return result.ok ? result.goal : null;
	}

	function stopActiveGoal(status: Exclude<GoalStatus, "active">, reason: StopReason | undefined, ctx: ExtensionContext): void {
		if (!state.goal) return;
		const result = goalService.apply(ctx, {
			reconcile: false,
			refreshFromDisk: true,
			mutate: (g) => ({ ...g, status, stopReason: reason, updatedAt: nowIso() }),
			ledger: (written) => status === "paused"
				? [{
					type: "goal_paused",
					goalId: written.id,
					reason: reason ?? "unknown",
					suggestedAction: written.pauseSuggestedAction,
					status,
					at: written.updatedAt,
				}]
				: [],
		});
		if (result.ok) {
			// setGoal() glue: a stopped goal can no longer queue continuations or
			// accrue time, and the UI must reflect the new status immediately.
			clearContinuationState();
			clearActiveAccounting();
			syncGoalTools();
			updateUI(ctx);
		}
	}

	function pauseActiveGoal(ctx: ExtensionContext): void {
		if (!state.goal || state.goal.status !== "active") return;
		const pausedGoalId = state.goal.id;
		// User-initiated pause (Esc / aborted turn). Clear any stale agent pause reason.
		state.goal = { ...state.goal, autoContinue: false, pauseReason: undefined, pauseSuggestedAction: undefined };
		stopActiveGoal("paused", "user", ctx);
		ctx.ui.notify("Goal paused.", "info");
	}

	function syncTerminalInputPause(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		terminalInputUnsubscribe?.();
		terminalInputUnsubscribe = ctx.ui.onTerminalInput((data) => {
			// If an audit is running, Escape aborts the audit instead of pausing.
			// Must return { consume: true } so the TUI doesn't also process the key
			// and abort the running tool execution, which would cascade into pausing
			// the entire goal (agent_end sees ctx.signal?.aborted and calls pauseActiveGoal).
			if (showingEscapeDialog) return undefined;
			if (matchesKey(data, "escape") && auditProgress) {
				abortAudit(ctx);
				return { consume: true };
			}
			if (matchesKey(data, "escape") && state.goal?.status === "active" && state.goal.autoContinue) {
				pauseActiveGoal(ctx);
				return { consume: true };
			}

			// Ctrl+Shift+T — show task list overlay for all open goals
			if (matchesKey(data, "ctrl+shift+t")) {
				showTaskListOverlay(ctx, goalsById, focusedGoalId);
				return { consume: true };
			}

			// ── Debug mode keybindings (hidden from normal view) ────────────────

			// Ctrl+Shift+X — toggle debug mode on/off
			if (matchesKey(data, "ctrl+shift+x")) {
				debugMode = !debugMode;
				ctx.ui.notify(debugMode ? "Debug mode ON" : "Debug mode OFF", "info");
				goalWidgetComponent?.invalidate();
				return { consume: true };
			}

			// Only process the following debug keybindings when debug mode is active
			if (!debugMode) return undefined;

			// Ctrl+Shift+N — create a test goal
			if (matchesKey(data, "ctrl+shift+n")) {
				createDebugGoal(ctx);
				return { consume: true };
			}

			// Ctrl+Shift+T — inject sample tasks into current goal
			if (matchesKey(data, "ctrl+shift+t")) {
				injectDebugTasks(ctx);
				return { consume: true };
			}

			// Ctrl+Shift+R — start mock completion audit
			if (matchesKey(data, "ctrl+shift+r")) {
				startMockAudit(ctx);
				return { consume: true };
			}

			// Ctrl+Shift+O — open proposal dialog with sample data
			if (matchesKey(data, "ctrl+shift+o")) {
				openDebugProposal(ctx);
				return { consume: true };
			}

			return undefined;
		});

		/** Toggle a test goal: create (first press) or remove (second press) */
		function createDebugGoal(ctx: ExtensionContext): void {
			const prev = state.goal;
			if (prev && prev.id.startsWith("debug-")) {
				// Toggle off — remove debug goal entirely (no archive, full delete)
				const filePath = `${DEBUG_GOALS_DIR}/debug_goal.md`;
				goalService.removeDebugFile(ctx, filePath);
				const prevId = prev.id;
				state.goal = null;
				if (focusedGoalId === prevId) {
					goalsById.delete(prevId);
					assignFocusedGoalId(null);
				}
				clearStoppedRuntimeState();
				syncGoalTools();
				updateUI(ctx);
				ctx.ui.notify("Debug goal removed", "info");
				return;
			}

			// Toggle on — create a new debug goal, write to temp dir
			debugGoalCounter++;
			const goal = createGoal({
				objective: "=== Goal ===\nObjective: Debug test goal",
				autoContinue: true,
				sisyphus: false,
			});
			goal.id = `debug-${nowIso().replace(/[:.]/g, "-")}-${debugGoalCounter}`;
			goal.createdAt = nowIso();
			goal.updatedAt = nowIso();
			goal.activePath = `${DEBUG_GOALS_DIR}/debug_goal.md`;
			goalService.writeDebugFile(ctx, goal.activePath, serializeGoalFile(goal));
			setGoal(goal, ctx, false, "created"); // no persist (we already wrote the file)
			ctx.ui.notify(`Debug goal created: ${goal.id}`, "info");
		}

		/** Inject 3-4 sample tasks into the current goal */
		function injectDebugTasks(ctx: ExtensionContext): void {
			if (!state.goal) {
				ctx.ui.notify("No goal to inject tasks into; create one first (Ctrl+Shift+N)", "warning");
				return;
			}
			const now = nowIso();
			const tasks: GoalTask[] = [
				{
					id: "t1",
					title: "Set up project structure",
					status: "complete",
					completedAt: now,
					subtasks: [
						{ id: "t1a", title: "Initialize repo", status: "complete", completedAt: now },
						{ id: "t1b", title: "Add build config", status: "pending" },
					],
				},
				{
					id: "t2",
					title: "Implement core feature",
					status: "pending",
				},
				{
					id: "t3",
					title: "Write tests",
					status: "pending",
				},
			];
			const next = cloneGoal(state.goal);
			next.taskList = { tasks, blockCompletion: false, proposedAt: now };
			next.updatedAt = now;
			setGoal(next, ctx);
			ctx.ui.notify("Sample tasks injected (3 tasks, 1 completed)", "info");
		}

		/** Stop mock audit timer if running */
		function stopMockAuditTimer(): void {
			if (debugMockAuditTimer) {
				clearInterval(debugMockAuditTimer);
				debugMockAuditTimer = null;
			}
		}

		/** Start a mock completion audit that transitions through phases */
		function startMockAudit(ctx: ExtensionContext): void {
			stopMockAuditTimer();
			const startedAt = Date.now();
			const phases: { phase: AuditorWidgetProgress["phase"]; atMs: number; label: string; percentage: number }[] = [
				{ phase: "tool_executing", atMs: 0, label: "Checking test results...", percentage: 10 },
				{ phase: "tool_executing", atMs: 800, label: "Verifying requirements...", percentage: 30 },
				{ phase: "thinking", atMs: 1800, label: "Evaluating completion criteria...", percentage: 60 },
				{ phase: "producing_report", atMs: 3200, label: "Writing audit report...", percentage: 85 },
				{ phase: "done", atMs: 4800, label: "Audit complete", percentage: 100 },
			];
			auditProgress = {
				recentOutput: [],
				phase: "running",
				elapsedMs: 0,
			};
			goalWidgetComponent?.invalidate();

			debugMockAuditTimer = setInterval(() => {
				const elapsed = Date.now() - startedAt;
				let currentPhase: AuditorWidgetProgress["phase"] = "done";
				let currentLabel = "Audit complete";
				let currentPct = 100;
				for (let i = phases.length - 1; i >= 0; i--) {
					if (elapsed >= phases[i].atMs) {
						currentPhase = phases[i].phase;
						currentLabel = phases[i].label;
						currentPct = phases[i].percentage;
						break;
					}
				}
				auditProgress = {
					phase: currentPhase,
					label: currentLabel,
					percentage: currentPct,
					elapsedMs: elapsed,
					recentOutput: auditProgress?.recentOutput ?? [],
				};
				if (currentPhase === "done") {
					if (auditProgress) auditProgress.recentOutput = [
						"✓ All requirements verified",
						"✓ Tests pass: 310/310",
						"✓ No truncation cap remaining",
					];
					stopMockAuditTimer();
					// Auto-clear audit after 3 more seconds
					setTimeout(() => {
						auditProgress = null;
						goalWidgetComponent?.invalidate();
					}, 3000);
				}
				goalWidgetComponent?.invalidate();
			}, 100);
			debugMockAuditTimer.unref?.();
		}

		/** Render task lines exactly like propose_task_list does */
		function renderDebugTaskLines(tasks: GoalTask[], indent = 0): string[] {
			const prefix = "  ".repeat(indent);
			const lines: string[] = [];
			for (const t of tasks) {
				const marker = t.status === "complete" ? "[x]" : t.status === "skipped" ? "[~]" : "[ ]";
				const lw = t.lightweightSubtasks ? " (lightweight)" : "";
				lines.push(`${prefix}${marker} ${t.id}: ${t.title}${lw}`);
				if (t.subtasks && t.subtasks.length > 0) {
					lines.push(...renderDebugTaskLines(t.subtasks, indent + 1));
				}
			}
			return lines;
		}

		/** Show the proposal dialog using real goal state — no hardcoded text */
		function openDebugProposal(ctx: ExtensionContext): void {
			// Build a fresh debug goal + tasks in memory for the dialog
			debugGoalCounter++;
			const goal = createGoal({
				objective: `=== Goal ===
Objective: Add collapsible task sections to the goal widget so large task lists are navigable

Success criteria:
- Tasks are grouped into sections by status (pending, active, complete) with visible section headers
- Each section header is toggleable — clicking it expands or collapses that section
- When collapsed, the section shows a header line only with a task count badge
- When expanded, tasks render with normal indentation and per-line styling
- Default state: pending section expanded, active and complete sections collapsed
- Section state is tracked per-render (no persistence needed)
- All 310 existing tests still pass

Boundaries:
- In scope: GoalWidgetComponent.render() grouping logic, section header toggling, expand/collapse state per render cycle
- Out of scope: task reordering, drag-and-drop, keyboard navigation for sections, persistence of section state across pi restarts
- Out of scope: modifying GoalTask or GoalRecord types

Constraints:
- Render width must respect the existing width parameter — no hardcoded widths
- Section collapse state is a render-only map, not stored in goal record
- Collapse toggle must be keyboard-accessible via existing widget interaction model
- Do not change the GoalWidgetComponent public API (constructor options, render signature)
- Section headers must use theme.fg("accent", ...) consistent with existing render patterns

Verification contract:
- Run npm test and confirm 310/310 pass (0 failures)
- Read render method and confirm task grouping logic exists
- Read expand/collapse toggle handler and confirm it inverts section state
- Confirm collapsed sections only render the header line with task count
- Confirm expanded sections render tasks with correct indentation and styling`,
				autoContinue: true,
				sisyphus: false,
			});
			goal.id = `debug-${nowIso().replace(/[:.]/g, "-")}-${debugGoalCounter}`;
			goal.createdAt = nowIso();
			goal.updatedAt = nowIso();

			const now = nowIso();
			const tasks: GoalTask[] = [
				{
					id: "t1",
					title: "Set up project structure",
					status: "complete",
					completedAt: now,
					subtasks: [
						{ id: "t1a", title: "Initialize repo", status: "complete", completedAt: now },
						{ id: "t1b", title: "Add build config", status: "pending" },
					],
				},
				{
					id: "t2",
					title: "Implement core feature",
					status: "pending",
					subtasks: [
						{ id: "t2a", title: "Status grouping logic", status: "pending" },
						{ id: "t2b", title: "Section header component", status: "pending" },
						{ id: "t2c", title: "Expand/collapse state", status: "pending" },
						{ id: "t2d", title: "Task count badge", status: "pending" },
					],
				},
				{ id: "t3", title: "Update tests", status: "pending" },
				{ id: "t4", title: "Manual TUI verification", status: "pending" },
			];
			goal.taskList = { tasks, blockCompletion: false, proposedAt: now };

			// Build proposal from goal state — exactly like the real flow
			const confirmationText = buildDraftConfirmationText({
				focus: "goal",
				originalTopic: "Refactor the goal widget component to support collapsible task sections",
				objective: goal.objective,
				autoContinue: goal.autoContinue,
			});

			// Append task proposal — exactly like propose_task_list would
			const taskLines = renderDebugTaskLines(tasks).map((l) => `│   ${l}`);
			const taskProposal = [
				"",
				"│ Proposed task list:",
				"",
				...taskLines,
			].join("\n");

			showProposalDialog(ctx, confirmationText + taskProposal, "goal", true);
		}
	}

	function queueContinuation(ctx: ExtensionContext, force = false): void {
		if (confirmationIntent !== null || tweakDraftingFor !== null) return;
		if (!state.goal) return;
		runtime.queueContinuation(ctx, state.goal, force);
	}

	function replaceGoal(config: GoalCreationConfig, ctx: ExtensionContext, startNow = true, verificationContract?: string, tokenBudget?: number): void {
		const goal = createGoal(config);
		if (verificationContract) goal.verificationContract = verificationContract;
		if (typeof tokenBudget === "number" && tokenBudget > 0) goal.tokenBudget = Math.floor(tokenBudget);
		const result = goalService.create(ctx, {
			goal,
			ledger: [{
				type: "goal_created",
				goalId: goal.id,
				objective: goal.objective,
				sisyphus: goal.sisyphus,
				autoContinue: goal.autoContinue,
				at: goal.createdAt,
			}],
		});
		if (result.focusChanged) appendFocusEntry(result.goalId, "created");
		beginAccounting();
		// Reset continuation nudge state — this is a fresh goal.
		// A goal was committed — clear pending confirmation intent if any.
		confirmationIntent = null;
		ctx.ui.notify(buildGoalRunningNotification(config), "info");
		if (startNow && state.goal?.autoContinue) queueContinuation(ctx, true);
	}

	async function startGoalTweakDrafting(hint: string, ctx: ExtensionContext): Promise<void> {
		reconcileFocusedGoalFromDisk(ctx);
		clearContinuationState();
		clearActiveAccounting();
		if (!state.goal) {
			if (openGoals().length > 0) {
				const selected = await chooseOpenGoal(ctx, "Tweak which open goal?");
				if (!selected) return;
			} else {
				ctx.ui.notify("No goal is set. Use /goals or /sisyphus to discuss, or /goals-set / /sisyphus-set to start immediately.", "warning");
				return;
			}
		}
		const currentGoal = state.goal;
		if (!currentGoal) return;
		if (currentGoal.status === "complete") {
			ctx.ui.notify("Goal is complete. Use /goals to discuss a new one or /goals-set to start immediately.", "warning");
			return;
		}
		syncGoalPromptFromDisk(ctx);
		persist(ctx);
		const trimmed = hint.trim();
		const focused = state.goal;
		if (!focused) return;
		const sisyphusOn = focused.sisyphus;
		const label = sisyphusOn ? "Sisyphus tweak drafting" : "Goal tweak drafting";
		// Activate the tweak edit-gate so propose_goal_tweak is callable.
		tweakDraftingFor = focused.id;
		syncGoalTools();
		ctx.ui.notify(
			`${label} started${trimmed ? `: ${truncateText(trimmed, 60)}` : ""}. The agent will interview you and then propose the revision for you to Confirm.`,
			"info",
		);
		const draftId = `tweak-${focused.id}-${Date.now().toString(36)}`;
		try {
			pi.sendMessage<GoalEventDetails>(
				{
					customType: GOAL_EVENT_ENTRY,
					content: goalTweakDraftingPrompt(focused, trimmed),
					display: false,
					details: {
						kind: "drafting",
						goalId: draftId,
						objective: trimmed,
						focus: sisyphusOn ? "sisyphus" : "goal",
						timestamp: Date.now(),
					},
				},
				{ triggerTurn: true, deliverAs: ctx.isIdle() ? "followUp" : "steer" },
			);
		} catch (err) {
			tweakDraftingFor = null;
			syncGoalTools();
			ctx.ui.notify(`Could not start goal tweak: ${(err as Error).message}`, "error");
		}
	}

	function startGoalDrafting(topic: string, focus: DraftingFocus, ctx: ExtensionContext): void {
		clearContinuationState();
		clearActiveAccounting();
		const trimmed = topic.trim();
		const label = focus === "sisyphus" ? "Sisyphus intent discussion" : "Goal intent discussion";
		const hint = focus === "sisyphus"
			? "The agent will research or grill the ordered plan as needed, then propose a draft for you to Confirm. No skipping, no rushing."
			: "The agent will clarify, research, or grill assumptions as needed, then propose a draft for you to Confirm.";
		ctx.ui.notify(
			`${label} started${trimmed ? `: ${truncateText(trimmed, 60)}` : ""}. ${hint}`,
			"info",
		);

		confirmationIntent = {
			focus,
			originalTopic: trimmed,
			startedAt: Date.now(),
		};
		syncGoalTools();
		try {
			pi.sendUserMessage(goalDraftingPrompt(trimmed, focus), { deliverAs: ctx.isIdle() ? "followUp" : "steer" });
		} catch (err) {
			ctx.ui.notify(`Could not start ${label.toLowerCase()}: ${(err as Error).message}`, "error");
		}
	}

	async function chooseOpenGoal(ctx: ExtensionContext, title: string): Promise<GoalRecord | null> {
		reconcileFocusedGoalFromDisk(ctx);
		if (state.goal && state.goal.status !== "complete") return state.goal;
		const open = openGoals();
		if (open.length === 0) return null;
		if (open.length === 1) {
			const only = open[0];
			if (!only) return null;
			setFocusedGoalId(only.id, ctx, "selected");
			return state.goal;
		}
		if (!ctx.hasUI) {
			ctx.ui.notify(buildUnfocusedOpenGoalsSummary(open.length), "warning");
			return null;
		}
		const labels = open.map((item) => goalSelectorLabel(item, focusedGoalId));
		const byLabel = new Map(labels.map((label, index) => [label, open[index]?.id]));
		const selected = await ctx.ui.select(title, labels);
		const selectedId = selected ? byLabel.get(selected) : undefined;
		if (!selectedId) {
			ctx.ui.notify("Goal focus unchanged.", "info");
			return null;
		}
		setFocusedGoalId(selectedId, ctx, "selected");
		return state.goal;
	}

	async function focusGoalCommand(ctx: ExtensionContext): Promise<void> {
		const open = openGoals();
		if (open.length === 0) {
			ctx.ui.notify("No open goals. Use /goals or /sisyphus to discuss, or /goals-set / /sisyphus-set to start immediately.", "warning");
			return;
		}
		if (open.length === 1) {
			const only = open[0];
			if (!only) return;
			setFocusedGoalId(only.id, ctx, "selected");
			armFocusedContinuation(ctx);
			ctx.ui.notify(`Focused goal: ${oneLineSummary(only)}`, "info");
			return;
		}
		if (!ctx.hasUI) {
			ctx.ui.notify(buildGoalListText(goalsById, focusedGoalId), "info");
			return;
		}
		const labels = open.map((item) => goalSelectorLabel(item, focusedGoalId));
		const byLabel = new Map(labels.map((label, index) => [label, open[index]?.id]));
		const selected = await ctx.ui.select("Focus open goal", labels);
		const selectedId = selected ? byLabel.get(selected) : undefined;
		if (!selectedId) {
			ctx.ui.notify("Goal focus unchanged.", "info");
			return;
		}
		setFocusedGoalId(selectedId, ctx, "selected");
		armFocusedContinuation(ctx);
		ctx.ui.notify(`Focused goal: ${oneLineSummary(state.goal)}`, "info");
	}

	function unfocusGoalCommand(ctx: ExtensionContext): void {
		const runtimeGoalId = state.goal?.id ?? runningGoalId ?? runtime.getCheckpointGoalId();
		reconcileFocusedGoalFromDisk(ctx);
		const current = state.goal;
		const detachedGoalId = current?.id ?? runtimeGoalId;
		let wasBusy = false;
		try {
			wasBusy = !ctx.isIdle();
		} catch {}
		if (detachedGoalId && wasBusy) runtime.markTurnStopped(detachedGoalId);
		setFocusedGoalId(null, ctx, "unfocused", { recordLedger: false });
		runningGoalId = null;
		runtime.setCheckpoint(null);
		runtime.clearPostCompactReminder();
		if (auditAbortController) auditAbortController.abort();
		if (detachedGoalId && wasBusy) {
			try {
				ctx.abort?.();
			} catch {}
		}
		if (!current) {
			const openCount = openGoals().length;
			ctx.ui.notify(openCount > 0 ? buildUnfocusedOpenGoalsSummary(openCount) : detailedSummary(null), "info");
			return;
		}
		ctx.ui.notify(`Goal unfocused for this session. It remains open in .pi/goals: ${current.id}`, "info");
	}

	async function handleGoalCommandTopic(rawTopic: string, ctx: ExtensionContext, focus: DraftingFocus, opts: { replace: boolean }): Promise<void> {
		const topic = rawTopic.trim();
		if (opts.replace) {
			const replacementTarget = await chooseOpenGoal(ctx, "Replace which open goal?");
			if (openGoals().length > 0 && !replacementTarget) return;
			archiveCurrentGoal(ctx, "user");
			setGoal(null, ctx, true, "cleared");
		}
		startGoalDrafting(topic, focus, ctx);
	}

	function handleDirectGoalSet(rawObjective: string, ctx: ExtensionContext, focus: DraftingFocus): void {
		const raw = rawObjective.trim();
		if (!raw) {
			const command = focus === "sisyphus" ? "/sisyphus <objective>" : "/goal <objective>";
			ctx.ui.notify(`No objective provided. Use ${command}.`, "warning");
			return;
		}
		const { objective, verificationContract } = extractVerificationContract(raw);
		clearContinuationState();
		clearActiveAccounting();
		confirmationIntent = null;
		syncGoalTools();
		replaceGoal({ objective, autoContinue: true, sisyphus: focus === "sisyphus" }, ctx, true, verificationContract);
	}

	async function showGoalStatus(ctx: ExtensionContext): Promise<void> {
		reconcileFocusedGoalFromDisk(ctx);
		if (state.goal) syncGoalPromptFromDisk(ctx);
		const view = goalForDisplay() ?? state.goal;
		const otherCount = otherOpenGoalCount(goalsById, focusedGoalId);
		const extra = view && otherCount > 0 ? `\nOther open goals: ${otherCount} (run /goal-list or /goal-focus)` : "";
		const text = view ? `${detailedSummary(view)}${extra}` : openGoals().length > 0 ? buildUnfocusedOpenGoalsSummary(openGoals().length) : detailedSummary(null);
		ctx.ui.notify(text, "info");
		updateUI(ctx);
	}

	async function handleGoalPause(ctx: ExtensionContext): Promise<void> {
		reconcileFocusedGoalFromDisk(ctx);
		if (!state.goal) {
			if (openGoals().length > 0) {
				const selected = await chooseOpenGoal(ctx, "Pause which open goal?");
				if (!selected) return;
			} else {
				ctx.ui.notify("No goal is set.", "warning");
				return;
			}
		}
		const currentGoal = state.goal;
		if (!currentGoal) return;
		if (currentGoal.status === "complete") {
			ctx.ui.notify("Goal is complete.", "warning");
			return;
		}
		if (currentGoal.status === "paused") {
			ctx.ui.notify("Goal is already paused. Use /goal-resume to continue.", "info");
			return;
		}
		pauseActiveGoal(ctx);
	}

	async function handleGoalResume(ctx: ExtensionContext): Promise<void> {
		reconcileFocusedGoalFromDisk(ctx);
		if (!state.goal && openGoals().length > 0) {
			const selected = await chooseOpenGoal(ctx, "Resume or focus open goal");
			if (!selected) return;
			if (selected.status === "active") {
				armFocusedContinuation(ctx);
				ctx.ui.notify(`Goal focused: ${oneLineSummary(selected)}`, "info");
				return;
			}
		}
		const resumeGate = validateResumeGoal(state.goal);
		if (!resumeGate.ok) {
			const level = resumeGate.message.includes("already running") ? "info" : "warning";
			ctx.ui.notify(resumeGate.message, level);
			return;
		}
		if (!state.goal) throw new Error("Goal disappeared during resume validation.");
		setGoal(
			{
				...mergeGoalPromptFromDisk(ctx, state.goal),
				status: "active",
				autoContinue: true,
				stopReason: undefined,
				pauseReason: undefined,
				pauseSuggestedAction: undefined,
			},
			ctx,
		);
		beginAccounting();
		ctx.ui.notify("Goal resumed.", "info");
		queueContinuation(ctx, true);
		// Append ledger event for resumption
		try {
			goalService.appendEvents(ctx, [{
				type: "goal_resumed",
				goalId: state.goal.id,
				reason: "user",
				at: nowIso(),
			}]);
		} catch {
			// Ledger append failure should not crash resume
		}
	}

	function settingsValue(config: GoalSettings, key: keyof GoalSettings): string {
		if (key === "disabled") return config.disabled === true ? "true" : "false";
		if (key === "disableTasks") return config.disableTasks === true ? "true" : "false";
		if (key === "disableContracts") return config.disableContracts === true ? "true" : "false";
		if (key === "autoSelectSingleGoal") return config.autoSelectSingleGoal === true ? "true" : "false";
		if (key === "subtaskDepth") return config.subtaskDepth !== undefined ? String(config.subtaskDepth) : "1";
		return config[key] ?? "(default)";
	}

	function settingsLines(config: GoalSettings): string[] {
		return [
			`disabled: ${settingsValue(config, "disabled")}`,
			`provider: ${settingsValue(config, "provider")}`,
			`model: ${settingsValue(config, "model")}`,
			`thinking_level: ${settingsValue(config, "thinkingLevel")}`,
			`disableTasks: ${settingsValue(config, "disableTasks")}`,
			`disableContracts: ${settingsValue(config, "disableContracts")}`,
			`subtaskDepth: ${settingsValue(config, "subtaskDepth")}`,
		];
	}

	async function handleSettingsMenu(ctx: ExtensionContext): Promise<void> {
		if (!ctx.hasUI) {
			ctx.ui.notify(`Settings file: ${goalSettingsPath(ctx.cwd)}`, "info");
			return;
		}
		const editorKeys = ["disabled", "provider", "model", "thinking_level", "subtaskDepth", "autoSelectSingleGoal"] as const;
		while (true) {
			const config = loadGoalSettingsFileConfig(ctx.cwd);
			const options = settingsLines(config).map((line) => `  ${line}`);
			options.unshift("─── Settings ───");
			options.push("Done");
			const selected = await ctx.ui.select("Goal settings", options);
			if (!selected || selected === "Done" || selected === "─── Settings ───") return;
			// Strip leading spaces from selection
			const selectedTrimmed = selected.trim();
			const colon = selectedTrimmed.indexOf(":");
			if (colon === -1) continue;
			const field = selectedTrimmed.slice(0, colon).trim();
			const editorKey = field === "thinking_level" ? "thinkingLevel" : field;
			if (!(editorKeys as readonly string[]).includes(editorKey)) continue;
			const key = editorKey as keyof GoalSettings;
			if (key === "disabled") {
				const next = { ...config, disabled: !config.disabled };
				saveGoalSettingsFileConfig(ctx.cwd, next);
				ctx.ui.notify(`Settings saved:\n${settingsLines(loadGoalSettingsFileConfig(ctx.cwd)).join("\n")}`, "info");
				continue;
			}
			if (key === "autoSelectSingleGoal") {
				const next = { ...config, autoSelectSingleGoal: config.autoSelectSingleGoal !== true };
				saveGoalSettingsFileConfig(ctx.cwd, next);
				ctx.ui.notify(`Settings saved:\n${settingsLines(loadGoalSettingsFileConfig(ctx.cwd)).join("\n")}`, "info");
				continue;
			}
			if (key === "subtaskDepth") {
				const input = await ctx.ui.input("Set subtaskDepth", String(config.subtaskDepth ?? 1));
				if (input === undefined) continue;
				const n = parseInt(input.trim(), 10);
				if (isNaN(n) || n < 1) {
					ctx.ui.notify("subtaskDepth must be a positive integer", "warning");
					continue;
				}
				const next = { ...config, subtaskDepth: n };
				saveGoalSettingsFileConfig(ctx.cwd, next);
				ctx.ui.notify(`Settings saved:\n${settingsLines(loadGoalSettingsFileConfig(ctx.cwd)).join("\n")}`, "info");
				continue;
			}
			const currentValue = settingsValue(config, key);
			const input = await ctx.ui.input(`Set ${field}`, currentValue === "(default)" ? "Leave empty for default" : currentValue);
			if (input === undefined) continue;
			const next: GoalSettings = { ...config };
			const inputTrimmed = input.trim();
			if (!inputTrimmed) {
				delete next[key];
			} else if (key === "thinkingLevel") {
				if (!["off", "minimal", "low", "medium", "high", "xhigh"].includes(inputTrimmed)) {
					ctx.ui.notify("thinking_level must be one of: off, minimal, low, medium, high, xhigh", "warning");
					continue;
				}
				next.thinkingLevel = inputTrimmed as GoalSettings["thinkingLevel"];
			} else if (key === "provider" || key === "model") {
				next[key] = inputTrimmed;
			}
			saveGoalSettingsFileConfig(ctx.cwd, next);
			ctx.ui.notify(`Settings saved:\n${settingsLines(loadGoalSettingsFileConfig(ctx.cwd)).join("\n")}`, "info");
		}
	}

	async function handleGoalClear(ctx: ExtensionContext): Promise<void> {
		if (confirmationIntent !== null || tweakDraftingFor !== null) {
			confirmationIntent = null;
			tweakDraftingFor = null;
			syncGoalTools();
			updateUI(ctx);
			ctx.ui.notify(clearGoalCommandMessage({ archived: false, wasDrafting: true }), "info");
			return;
		}
		reconcileFocusedGoalFromDisk(ctx);
		if (!state.goal && openGoals().length > 0) {
			const selected = await chooseOpenGoal(ctx, "Clear which open goal?");
			if (!selected) return;
		}
		const archived = archiveCurrentGoal(ctx, "user");
		const didArchive = !!archived;
		setGoal(null, ctx, true, "cleared");
		// Phase 5 D: also abort any in-flight drafting so the agent's next turn
		// doesn't try to propose into a cleared slot.
		const wasDrafting = confirmationIntent !== null;
		confirmationIntent = null;
		syncGoalTools();
		const msg = clearGoalCommandMessage({ archived: didArchive, wasDrafting });
		ctx.ui.notify(msg, didArchive || wasDrafting ? "info" : "warning");
	}

	async function handleGoalAbort(ctx: ExtensionContext): Promise<void> {
		if (confirmationIntent !== null || tweakDraftingFor !== null) {
			confirmationIntent = null;
			tweakDraftingFor = null;
			syncGoalTools();
			updateUI(ctx);
			ctx.ui.notify(abortGoalCommandMessage({ archived: false, wasDrafting: true }), "info");
			return;
		}
		reconcileFocusedGoalFromDisk(ctx);
		if (!state.goal && openGoals().length > 0) {
			const selected = await chooseOpenGoal(ctx, "Abort which open goal?");
			if (!selected) return;
		}
		const archived = archiveCurrentGoal(ctx, "user");
		const didArchive = !!archived;
		setGoal(null, ctx, true, "aborted");
		const wasDrafting = confirmationIntent !== null;
		confirmationIntent = null;
		syncGoalTools();
		const msg = abortGoalCommandMessage({ archived: didArchive, wasDrafting });
		ctx.ui.notify(msg, didArchive || wasDrafting ? "info" : "warning");
	}

	pi.registerMessageRenderer<GoalEventDetails>(GOAL_EVENT_ENTRY, renderGoalEvent);
	pi.registerMessageRenderer<GoalAuditEventDetails>(GOAL_AUDIT_ENTRY, renderGoalAuditEvent);

	// /goal and /goal-status: read-only status display.
	const statusCommand = {
		description: "Show the current goal: objective, status, sisyphus mode, usage.",
		handler: async (_rawArgs: string, ctx: ExtensionContext) => {
			await showGoalStatus(ctx);
		},
	};

	// Curated ten-command palette (Stage 5). /goal and /sisyphus are the two
	// direct creation paths; every frequent lifecycle action is independently
	// registered so it appears in slash-command tab completion. No aliases.
	pi.registerCommand("goal", {
		description: "Create a regular goal from the objective, or show status when empty.",
		handler: async (rawArgs, ctx) => {
			if (rawArgs.trim()) {
				handleDirectGoalSet(rawArgs, ctx, "goal");
				return;
			}
			await showGoalStatus(ctx);
		},
	});
	pi.registerCommand("sisyphus", {
		description: "Create a Sisyphus goal (strict ordered steps) from the objective.",
		handler: async (rawArgs, ctx) => {
			if (rawArgs.trim()) {
				handleDirectGoalSet(rawArgs, ctx, "sisyphus");
				return;
			}
			ctx.ui.notify("Provide an objective: /sisyphus <ordered-steps objective>", "info");
		},
	});
	pi.registerCommand("goal-list", {
		description: "List all open goals and the current focus.",
		handler: async (_rawArgs, ctx) => {
			reconcileFocusedGoalFromDisk(ctx);
			ctx.ui.notify(buildGoalListText(goalsById, focusedGoalId), "info");
			updateUI(ctx);
		},
	});
	pi.registerCommand("goal-focus", {
		description: "Choose which open goal this session focuses on.",
		handler: async (_rawArgs, ctx) => {
			await focusGoalCommand(ctx);
		},
	});
	pi.registerCommand("goal-unfocus", {
		description: "Stop focusing the current goal (session only; goal stays open).",
		handler: async (_rawArgs, ctx) => {
			unfocusGoalCommand(ctx);
		},
	});
	pi.registerCommand("goal-settings", {
		description: "Open pi-goal settings (auditor provider/model/thinking level).",
		handler: async (_rawArgs, ctx) => {
			await handleSettingsMenu(ctx);
		},
	});
	pi.registerCommand("goal-tweak", {
		description: "Refine the current goal's objective with the user.",
		handler: async (rawArgs, ctx) => {
			await startGoalTweakDrafting(rawArgs, ctx);
		},
	});
	pi.registerCommand("goal-clear", {
		description: "Archive the current goal after confirmation (user-owned abandonment).",
		handler: async (_rawArgs, ctx) => {
			await handleGoalClear(ctx);
		},
	});
	pi.registerCommand("goal-pause", {
		description: "Pause the currently running goal. Esc also pauses while running.",
		handler: async (_rawArgs, ctx) => {
			await handleGoalPause(ctx);
		},
	});
	pi.registerCommand("goal-resume", {
		description: "Resume a paused or blocked goal.",
		handler: async (_rawArgs, ctx) => {
			await handleGoalResume(ctx);
		},
	});


	registerQuestionnaireTools(pi);

	pi.registerTool(defineTool({
		name: "get_goal",
		label: "Get Goal",
		description: "Get the current pi goal for this session: objective, status, auto-continue, usage, and local file paths.",
		promptSnippet: "Read the active pi goal state for the current session.",
		promptGuidelines: [
			"Use get_goal when you need the current goal before deciding whether to continue or mark it complete.",
			"Before marking a goal complete, compare every explicit requirement with concrete evidence from the workspace/session.",
			"If the returned goal has sisyphus mode on, you must execute strictly step-by-step in the order written in the objective; do not skip, combine, or rush steps, and stop to ask the user when blocked or unclear.",
		],
		parameters: Type.Object({}, { additionalProperties: false }),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			reconcileFocusedGoalFromDisk(ctx);
			if (state.goal) syncGoalPromptFromDisk(ctx);
			syncGoalTools();
			const view = goalForDisplay() ?? state.goal;
			const otherCount = otherOpenGoalCount(goalsById, focusedGoalId);
			if (!view) {
				const text = openGoals().length > 0
					? `${buildUnfocusedOpenGoalsSummary(openGoals().length)}\n\nCall create_goal with the objective to create and focus a new goal, or ask the user to run /goal-focus to choose an open goal.`
					: "No goal is set in this session. Call create_goal with the objective when the user explicitly asks to start a persistent goal.";
				return {
					content: [{ type: "text", text }],
					details: goalDetails(view),
				};
			}
			const lines: string[] = [view.objective, ""];
			lines.push(`Status: ${statusLabel(view)}`);
			lines.push(`Mode: ${view.sisyphus ? "sisyphus" : "regular"}`);
			const usageBits: string[] = [];
			if (view.usage.activeSeconds > 0) usageBits.push(formatDuration(view.usage.activeSeconds));
			if (view.usage.tokensUsed > 0) usageBits.push(formatTokenValue(view.usage.tokensUsed));
			lines.push(`Usage: ${usageBits.length > 0 ? usageBits.join(" · ") : "none"}`);
			const budget = budgetLine(view);
			if (budget) lines.push(`Budget: ${budget}`);
			if (view.taskList) lines.push(`Tasks: ${buildTaskSummary(view.taskList)}`);
			if (view.verificationContract?.trim()) lines.push(`Verification contract: ${view.verificationContract.trim()}`);
			if (view.status === "paused" || view.status === "blocked") {
				if (view.pauseReason) lines.push(`Blocker: ${view.pauseReason}`);
				if (view.pauseSuggestedAction) lines.push(`Suggested action: ${view.pauseSuggestedAction}`);
			}
			if (view.activePath) lines.push(`Path: ${view.activePath}`);
			if (view.archivedPath) lines.push(`Archive: ${view.archivedPath}`);
			if (otherCount > 0) lines.push(`Other open goals: ${otherCount} (user can run /goal-list or /goal-focus)`);
			lines.push("");
			lines.push("Lifecycle: call update_goal({status: \"complete\"}) only when every requirement is satisfied — the independent auditor verifies from actual evidence. Call update_goal({status: \"blocked\"}) only after the same blocker recurs on three consecutive goal turns. User commands handle pause/resume/clear/focus.");
			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: goalDetails(view),
			};
		},
		renderCall(_args, theme) {
			return new Text(theme.fg("toolTitle", "get_goal"), 0, 0);
		},
		renderResult(result, _options, theme) {
			return renderGoalResult(result, theme);
		},
	}));

	pi.registerTool(defineTool({
		name: "create_goal",
		label: "Create Goal",
		description: "Create and focus a new pi goal after an explicit user request. Only call this when the user has explicitly asked to make something a persistent goal (directly, or via /goal or /sisyphus); do NOT infer a goal from an ordinary task. Creating a goal focuses it and leaves other open goals untouched.",
		promptSnippet: "Create a persistent pi goal only when the user explicitly asks for one.",
		promptGuidelines: [
			"Call create_goal only when the user explicitly asks to start a long-running goal or hands you a concrete objective to pursue. Never infer a goal from an ordinary one-off task.",
			"Creating a new goal focuses it and leaves other open goals untouched. Do not archive or replace existing goals unless the user explicitly asks through a user command.",
			"Pass mode=\"sisyphus\" only when the user explicitly invoked Sisyphus mode.",
		],
		parameters: Type.Object({
			objective: Type.String({ description: "Full goal text. For Sisyphus goals this MUST include the user's numbered steps + per-step done criteria, taken faithfully from the user's input. 1-4000 characters." }),
			mode: Type.Optional(StringEnum(["regular", "sisyphus"] as const, { description: "Goal mode. Defaults to regular. Use sisyphus only when the user explicitly invoked Sisyphus mode." })),
			token_budget: Type.Optional(Type.Number({ minimum: 1, description: "Optional token budget in whole tokens. Accept it only when the user explicitly supplied a budget; never invent one." })),
		}, { additionalProperties: false }),
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			reconcileFocusedGoalFromDisk(ctx);
			const objective = params.objective.trim();
			if (!objective) throw new Error("create_goal requires a non-empty objective.");
			if (objective.length > 4000) {
				return {
					content: [{ type: "text", text: `create_goal objective exceeds 4000 characters (${objective.length}). Shorten the objective and retry.` }],
					details: goalDetails(state.goal),
				};
			}
			const sisyphusFlag = params.mode === "sisyphus";
			const { objective: cleanedObjective, verificationContract } = extractVerificationContract(objective);
			confirmationIntent = null;
			replaceGoal(
				{ objective: cleanedObjective, autoContinue: true, sisyphus: sisyphusFlag },
				ctx,
				true,
				verificationContract,
				params.token_budget,
			);
			const created = state.goal;
			const otherCount = otherOpenGoalCount(goalsById, focusedGoalId);
			const otherLine = otherCount > 0
				? `\n${otherCount} other open goal${otherCount === 1 ? "" : "s"} remain in .pi/goals — this goal is now the session focus.`
				: "";
			return {
				content: [{ type: "text", text: `${buildGoalCreatedReport({ objective: created?.objective ?? objective, detailedSummary: detailedSummary(created) })}${otherLine}` }],
				details: goalDetails(created),
				terminate: true,
			};
		},
		renderCall(args, theme) {
			const prefix = args?.mode === "sisyphus" ? "create_goal sisyphus " : "create_goal ";
			return new Text(theme.fg("toolTitle", prefix) + theme.fg("muted", args?.objective ?? ""), 0, 0);
		},
		renderResult(result, _options, theme) {
			return renderGoalResult(result, theme);
		},
	}));

	// Agent's goal-confirmation entry point. Shows the user a full plain-text
	// draft report with two choices: [Confirm] (creates the goal) or
	// [Continue Chatting] (returns control to the agent for more clarification).
	// Schema gates enforce focus-vs-sisyphus consistency; draftId is ignored for
	// one-release compatibility with older prompt residue.
	// In headless mode (no UI), auto-confirms — harness-friendly.
	pi.registerTool(defineTool({
		name: PROPOSE_DRAFT_TOOL_NAME,
		label: "Propose Goal Draft",
		description: "During /goals or /sisyphus intent discussion, propose the goal draft to the user. The user sees a full plain-text confirmation report and chooses Confirm (creates the goal) or Continue Chatting (returns control to you to refine). REPLACES create_goal during discussion-based creation.",
		promptSnippet: "Propose the drafted goal to the user with a full plain-text Confirm / Continue Chatting dialog.",
		promptGuidelines: [
			"Call propose_goal_draft when a /goals or /sisyphus intent discussion has enough information to write a concrete goal. Ask a focused question only when the request is still ambiguous.",
			"If an answer exposes ambiguity, keep interviewing the user — do not propose prematurely.",
			"The user will see a full plain-text draft report plus a [Confirm] / [Continue Chatting] choice. Confirm creates the goal; Continue Chatting returns control to you to ask follow-up questions.",
			"If the tool returns 'continue chatting', ask the user what they want changed. Do NOT propose again immediately with the same content; iterate based on their feedback first.",
			"The sisyphus field must match the user's confirmation focus: /sisyphus -> sisyphus=true, /goals -> sisyphus=false. The schema enforces this; mismatched proposals are REJECTED.",
			"For sisyphus goals, preserve the user's requested ordered style and completion standard. Do not add reconnaissance/preflight steps, merge steps, reorder steps, or change the mode without explicit user confirmation.",
			"create_goal is rejected; propose_goal_draft is the confirmation path. This is intentional — the user wants explicit say in goal creation.",
			"You may include a Verification contract: section in the objective to specify what verification evidence is required before the goal can be completed. This is optional — if omitted, no per-goal contract enforcement applies.",
		],
		parameters: Type.Object({
			objective: Type.String({ description: "Full goal text. For Sisyphus goals this MUST include the user's numbered steps + per-step done criteria, taken faithfully from the user's input." }),
			autoContinue: Type.Optional(Type.Boolean({ description: "Whether pi should keep sending continuation prompts until complete. Default true." })),
			sisyphus: Type.Optional(Type.Boolean({ description: "Must equal true for /sisyphus discussion, false for /goals discussion. Schema-enforced via B1 gate." })),
			tasks: Type.Optional(Type.Array(Type.Object({
				id: Type.String({ description: "Short stable slug e.g. 'task-1'" }),
				title: Type.String({ description: "Human-readable task title" }),
				verificationContract: Type.Optional(Type.String({ description: "Optional verification contract for this task." })),
				lightweightSubtasks: Type.Optional(Type.Boolean({ description: "If true, subtasks are lightweight (no completion enforcement). Default false." })),
				subtasks: Type.Optional(Type.Any({ description: "Optional recursive array of sub-tasks (same shape as parent)." })),
			}), { description: "Optional task list to confirm together with the goal in a single step. Each task supports recursive subtasks." })),
			draftId: Type.Optional(Type.String({ description: "Deprecated compatibility field. It is accepted but ignored; current goal confirmation no longer depends on hidden draft ids." })),
		}),
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const validation = validateGoalDraftProposal({
				intent: confirmationIntent,
				hasUnfinishedGoal: !!state.goal && state.goal.status !== "complete",
				objective: params.objective,
				sisyphus: params.sisyphus,
				draftId: params.draftId,
			});
			if (!validation.ok) {
				if (validation.clearDrafting) {
					confirmationIntent = null;
					syncGoalTools();
				}
				return {
					content: [{ type: "text", text: validation.message }],
					details: goalDetails(state.goal),
				};
			}
			const activeIntent = confirmationIntent;
			if (!activeIntent) throw new Error("Goal confirmation intent disappeared during proposal validation.");

			// All schema gates passed. Decide how to confirm.
			const objective = validation.objective;
			const autoContinueFlag = params.autoContinue ?? true;
			const sisyphusFlag = validation.expectedSisyphus;
			// Build confirmation text: goal + optional task list
			let taskSummarySection = "";
			let tasksToCreate: GoalTask[] | undefined;
			if (params.tasks && params.tasks.length > 0) {
				tasksToCreate = params.tasks.map((t) => {
					const task: GoalTask = {
						id: (t as Record<string, unknown>).id as string,
						title: (t as Record<string, unknown>).title as string,
						status: "pending",
						verificationContract: (t as Record<string, unknown>).verificationContract as string | undefined,
						lightweightSubtasks: (t as Record<string, unknown>).lightweightSubtasks === true ? true : undefined,
					};
					const rawSubtasks = (t as Record<string, unknown>).subtasks;
					if (Array.isArray(rawSubtasks) && rawSubtasks.length > 0) {
						task.subtasks = rawSubtasks.map((s) => normalizeTaskItem(s as Record<string, unknown>)).filter((s): s is GoalTask => !!s);
					}
					return task;
				});
				// Validate subtask depth BEFORE showing dialog (consistent with propose_task_list)
				const settings = loadGoalSettings(ctx.cwd);
				const depthViolation = findSubtaskDepthViolation(tasksToCreate, settings.subtaskDepth ?? 1);
				if (depthViolation) {
					return {
						content: [{ type: "text", text: depthViolation }],
						details: goalDetails(state.goal),
					};
				}
				const taskLines = renderConfirmationTasks(tasksToCreate, 0);
				taskSummarySection = `\n\n┌─ TASKS ─────────────────────────────────────┐\n${taskLines.join("\n")}\n└──────────────────────────────────────────────┘`;
			}

			const draftSummary = buildDraftConfirmationText({
				focus: activeIntent.focus,
				originalTopic: activeIntent.originalTopic,
				// Tasks section appears FIRST in the context so it stays visible
				// even when the dialog caps long context lines.
				objective: taskSummarySection ? `${taskSummarySection}

${objective}` : objective,
				autoContinue: autoContinueFlag,
			});

			const headless = shouldAutoConfirmProposal({ hasUI: ctx.hasUI, autoConfirmEnv: process.env.PI_GOAL_AUTO_CONFIRM });

			let decision: { decision: "confirm" | "continue"; auditorEnabled: boolean };
			const auditorDefault = isAuditorEnabledByDefault(loadGoalSettings(ctx.cwd));
			if (headless) {
				// Headless: auto-confirm (tests and non-TUI sessions).
				decision = { decision: "confirm", auditorEnabled: auditorDefault };
			} else {
				// TUI: show overlay dialog.
				try {
					decision = await showProposalDialog(ctx, draftSummary, activeIntent.focus, auditorDefault);
				} catch (err) {
					const message = proposalDialogFailureMessage(err);
					ctx.ui.notify(message, "error");
					return {
						content: [{ type: "text", text: message }],
						details: goalDetails(state.goal),
					};
				}
			}

			if (decision.decision === "confirm") {
				// Extract verification contract from objective before creation
				const { objective: cleanedObjective, verificationContract } = extractVerificationContract(objective);
				const config: GoalCreationConfig = {
					objective: cleanedObjective,
					autoContinue: autoContinueFlag,
					sisyphus: sisyphusFlag,
				};
				confirmationIntent = null;
				replaceGoal(config, ctx, false, verificationContract);

				// Set skipAuditor on the goal if user toggled auditor off
				if (!decision.auditorEnabled && state.goal) {
					state.goal = { ...state.goal, skipAuditor: true };
					setGoal(state.goal, ctx);
				}

				// Set task list if provided
				if (tasksToCreate && tasksToCreate.length > 0 && state.goal) {
					const now = nowIso();
					state.goal = {
						...state.goal,
						taskList: {
							tasks: tasksToCreate,
							blockCompletion: false,
							proposedAt: now,
						},
						updatedAt: now,
					};
					setGoal(state.goal, ctx);
					// Append ledger event for task list
					try {
						goalService.appendEvents(ctx, [{
							type: "task_list_set",
							goalId: state.goal.id,
							taskCount: tasksToCreate.length,
							blockCompletion: false,
							at: now,
						}]);
					} catch {
						// Ledger failure should not block creation
					}
					syncGoalTools();
					updateUI(ctx);
				}

				syncGoalTools();
				return {
					content: [{ type: "text", text: buildGoalCreatedReport({ objective, detailedSummary: detailedSummary(state.goal) }) }],
					details: goalDetails(state.goal),
					terminate: true,
				};
			}
			// "continue" — user wants to keep chatting. Drafting state stays armed.
			return {
				content: [{
					type: "text",
					text: "Goal draft refinement requested (Continue Chatting). The goal was not created — drafting remains active. Ask the user what they want changed about the draft (objective, scope, criteria, steps), then revise and call propose_goal_draft again. Do not re-propose the same content — wait for the user's input first.",
				}],
				details: goalDetails(state.goal),
			};
		},
		renderCall(args, theme) {
			const prefix = args?.sisyphus ? "propose_goal_draft sisyphus " : "propose_goal_draft ";
			return new Text(theme.fg("toolTitle", prefix) + theme.fg("muted", truncateText(args?.objective ?? "", 80)), 0, 0);
		},
		renderResult(result, _options, theme) {
			return renderGoalResult(result, theme);
		},
	}));

	pi.registerTool(defineTool({
		name: PROPOSE_TWEAK_TOOL_NAME,
		label: "Propose Goal Tweak",
		description: "Propose a goal tweak or auto-start the /goal-tweak drafting flow. When a goal is active or paused and no /goal-tweak flow is active, calling this auto-starts the drafting interview; inside an active flow it presents the revised goal for confirmation.",
		promptSnippet: "Propose the revised goal to the user with a Confirm / Continue Chatting dialog.",
		promptGuidelines: [
			"Always callable when a goal is active or paused. Calling outside a /goal-tweak flow automatically starts one — the tool enters a drafting interview so you can clarify the change before proposing.",
			"newObjective must be the FULL revised objective text, formatted the same way as the original (=== Goal === or === Sisyphus Goal === block). Do NOT pass a diff or partial patch; pass the whole new objective.",
			"For Sisyphus goals: preserve the Sisyphus style and ordered-plan wording unless the user explicitly asks to remove it.",
			"changeSummary is a one-sentence description of WHAT changed (for the confirmation dialog, activity log, and tweak log). When auto-starting a tweak flow, this is used as the hint for the drafting interview.",
			"The user will see a full plain-text report plus a [Confirm] / [Continue Chatting] choice. Confirm applies the tweak; Continue Chatting returns control to you to ask follow-up questions.",
			"If the tool returns 'continue chatting', ask the user what they want changed. Do NOT re-propose the same content immediately; iterate based on their feedback first.",
			"Do NOT use write/edit/bash to modify the active goal file directly. propose_goal_tweak is the only sanctioned channel.",
			"tasks (optional): an array of task objects to REPLACE the current goal's task list. When omitted,",
			"  the existing task list is inherited as-is. When provided, the full task list is replaced with",
			"  the new tasks — add/remove/change tasks by passing the complete updated list.",
			"  Each task has: {id, title, verificationContract?, lightweightSubtasks?, subtasks?}.",
			"  Subtasks use the same shape recursively. The task list is displayed in the confirmation",
			"  dialog alongside the objective diff, matching propose_goal_draft's rendering format.",
			"Start from the current goal's objective text and task list (the inheritance defaults), then",
			"  edit/rewrite them directly rather than composing a goal from scratch.",
		],
		parameters: Type.Object({
			newObjective: Type.String({ description: "The complete revised objective text. For Sisyphus goals, preserve the Sisyphus style unless the user explicitly changes it." }),
			changeSummary: Type.String({ description: "One-sentence description of what was changed (used in confirmation dialog, activity log, and tweak log)." }),
			tasks: Type.Optional(Type.Array(Type.Object({
				id: Type.String({ description: "Short stable slug e.g. 'task-1'" }),
				title: Type.String({ description: "Human-readable task title" }),
				verificationContract: Type.Optional(Type.String({ description: "Optional verification contract for this task." })),
				lightweightSubtasks: Type.Optional(Type.Boolean({ description: "If true, subtasks are lightweight (no completion enforcement). Default false." })),
				subtasks: Type.Optional(Type.Any({ description: "Optional recursive array of sub-tasks (same shape as parent)." })),
			}), { description: "Optional task list to replace the current goal's tasks. When omitted the existing task list is inherited. Each task supports recursive subtasks." })),
		}),
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			reconcileFocusedGoalFromDisk(ctx);
			if (!state.goal) {
				return {
					content: [{ type: "text", text: "No goal is set; propose_goal_tweak is a no-op." }],
					details: goalDetails(state.goal),
				};
			}
			if (state.goal.status !== "active" && state.goal.status !== "paused") {
				return {
					content: [{ type: "text", text: `Goal is ${statusLabel(state.goal)}; cannot apply a tweak.` }],
					details: goalDetails(state.goal),
				};
			}
			const newObjective = params.newObjective.trim();
			if (!newObjective) throw new Error("propose_goal_tweak requires a non-empty newObjective.");
			const changeSummary = params.changeSummary.trim();
			if (!changeSummary) throw new Error("propose_goal_tweak requires a non-empty changeSummary.");

			// Resolve tasks: inherit from current goal if not provided, or normalize/validate the passed tasks.
			let tweakTasks: GoalTask[] | undefined;
			if (params.tasks && Array.isArray(params.tasks) && params.tasks.length > 0) {
				tweakTasks = params.tasks.map((t: Record<string, unknown>) => {
					const task: GoalTask = {
						id: t.id as string,
						title: t.title as string,
						status: "pending",
						verificationContract: t.verificationContract as string | undefined,
						lightweightSubtasks: t.lightweightSubtasks === true ? true : undefined,
					};
					const rawSubtasks = t.subtasks;
					if (Array.isArray(rawSubtasks) && rawSubtasks.length > 0) {
						task.subtasks = rawSubtasks
							.map((s: Record<string, unknown>) => normalizeTaskItem(s))
							.filter((s: GoalTask | undefined): s is GoalTask => !!s);
					}
					return task;
				});
				// Validate task list
				if (tweakTasks.length > 50) {
					return { content: [{ type: "text", text: "Task list cannot exceed 50 tasks." }], details: goalDetails(state.goal) };
				}
				const settings = loadGoalSettings(ctx.cwd);
				const depthViolation = findSubtaskDepthViolation(tweakTasks, settings.subtaskDepth ?? 1);
				if (depthViolation) {
					return { content: [{ type: "text", text: depthViolation }], details: goalDetails(state.goal) };
				}
			} else {
				// Inherit current task list when no tasks parameter provided
				if (state.goal.taskList && state.goal.taskList.tasks.length > 0) {
					tweakTasks = state.goal.taskList.tasks;
				}
			}

			// Auto-start the tweak drafting flow if not already active.
			if (tweakDraftingFor !== state.goal.id) {
				await startGoalTweakDrafting(changeSummary, ctx);
				return {
					content: [{
						type: "text",
						text: "Tweak drafting flow auto-started. The drafting interview prompt will arrive in a new turn. " +
							"Ask the user clarifying questions as needed, refine the proposal, then call propose_goal_tweak again with the complete revision.",
					}],
					details: goalDetails(state.goal),
				};
			}

			// Build the confirmation dialog text.
			const draftSummary = buildTweakConfirmationText({
				currentObjective: state.goal.objective,
				newObjective,
				changeSummary,
				sisyphus: !!state.goal.sisyphus,
				tasks: tweakTasks,
			});

			const headless = shouldAutoConfirmProposal({ hasUI: ctx.hasUI, autoConfirmEnv: process.env.PI_GOAL_AUTO_CONFIRM });
			const tweakFocus = focusedOperationToken(state.goal.id);

			let decision: { decision: "confirm" | "continue"; auditorEnabled: boolean };
			if (headless) {
				decision = { decision: "confirm", auditorEnabled: !state.goal.skipAuditor };
			} else {
				try {
					decision = await showProposalDialog(ctx, draftSummary, state.goal.sisyphus ? "sisyphus" : "goal", !state.goal.skipAuditor);
				} catch (err) {
					const message = proposalDialogFailureMessage(err);
					ctx.ui.notify(message, "error");
					return {
						content: [{ type: "text", text: message }],
						details: goalDetails(state.goal),
					};
				}
			}
			if (!isFocusedOperationCurrent(tweakFocus)) {
				return focusedOperationCancelledResult("Goal tweak", tweakFocus);
			}

			if (decision.decision === "confirm") {
				// Persist any auditor toggle change
				if (state.goal) {
					state.goal = { ...state.goal, skipAuditor: !decision.auditorEnabled };
				}
				// Extract verification contract from revised objective
				const { objective: cleanedObjective, verificationContract } = extractVerificationContract(newObjective);
				// Apply the tweak: write the new objective to disk authoritatively.
				const next: GoalRecord = {
					...state.goal,
					objective: cleanedObjective,
					verificationContract: verificationContract,
					updatedAt: nowIso(),
					// Clear any prior agent pause reason — the user has redefined the work.
					pauseReason: undefined,
					pauseSuggestedAction: undefined,
					taskList: tweakTasks && tweakTasks.length > 0
						? { tasks: tweakTasks, blockCompletion: false, proposedAt: nowIso() }
						: undefined,
				};
				// IMPORTANT: bypass setGoal() / persist() here. persist() calls
				// syncGoalPromptFromDisk() which would RE-READ the stale objective
				// from the still-old goal file on disk and clobber our new objective
				// before writing. propose_goal_tweak is the authoritative source for
				// objective changes — the disk is downstream, not upstream. Route the
				// write through the service WITHOUT reconciliation so the new
				// objective is never clobbered, and append the tweak/task ledger
				// events in the same ordered write.
				const tweakResult = goalService.apply(ctx, {
					reconcile: false,
					focusToken: tweakFocus,
					mutate: () => next,
					ledger: (written) => {
						const events: GoalLedgerEvent[] = [{
							type: "goal_tweaked",
							goalId: written.id,
							changeSummary,
							at: written.updatedAt,
						}];
						if (params.tasks && Array.isArray(params.tasks) && params.tasks.length > 0) {
							events.push({
								type: "task_list_set",
								goalId: written.id,
								taskCount: params.tasks.length,
								blockCompletion: false,
								at: written.updatedAt,
							});
						}
						return events;
					},
				});
				if (!tweakResult.ok) {
					return focusedOperationCancelledResult("Goal tweak", tweakFocus);
				}
				tweakDraftingFor = null;
				// Reset autoContinue counter — plan changed, agent gets a fresh chain.
				// Mark turn-stopped so subsequent in-turn tool calls are blocked.
				runtime.markTurnStopped(state.goal.id);
				syncGoalTools();
				updateUI(ctx);
				ctx.ui.notify(`Goal tweaked: ${truncateText(changeSummary, 160)}`, "info");
				return {
					content: [{
						type: "text",
						text: `Goal tweak applied. ${changeSummary}\nStop now; the next continuation will arrive automatically if the goal is active.`,
					}],
					details: goalDetails(state.goal),
					terminate: true,
				};
			}

			// "continue" — user wants to keep chatting. Drafting state stays armed.
			return {
				content: [{
					type: "text",
					text: "Goal tweak refinement requested (Continue Chatting). The tweak was not applied — drafting remains active. Ask the user what they want changed about the revision, then revise and call propose_goal_tweak again. Do not re-propose the same content — wait for the user's input first.",
				}],
				details: goalDetails(state.goal),
			};
		},
		renderCall(args, theme) {
			const summary = typeof args?.changeSummary === "string" ? truncateText(args.changeSummary, 80) : "";
			return new Text(theme.fg("toolTitle", "propose_goal_tweak ") + theme.fg("muted", summary), 0, 0);
		},
		renderResult(result, _options, theme) {
			return renderGoalResult(result, theme);
		},
	}));

	async function runGoalCompletionFlow(ctx: ExtensionContext, opts: { completionSummary?: string; verificationSummary?: string; confirmBypassAuditor?: boolean; status?: string }): Promise<AgentToolResult<unknown>> {
		reconcileFocusedGoalFromDisk(ctx);

		// -- Phase 2: Status validation --
		const effectiveStatus = opts.status ?? COMPLETE_STATUS;
		if (effectiveStatus !== COMPLETE_STATUS) {
			throw new Error("complete_goal requires status=complete when marking a goal complete.");
		}

		// -- Phase 3: Completion --
		const completionGate = validateGoalCompletion({ goal: state.goal, runningGoalId });
		if (!completionGate.ok) {
			return {
				content: [{ type: "text", text: completionGate.message }],
				details: goalDetails(state.goal),
			};
		}
		if (!state.goal) throw new Error("Goal disappeared during completion validation.");

		// Task gate: warn if blockCompletion is enabled and tasks remain pending
		const disableTasksSettings = loadGoalSettings(ctx.cwd).disableTasks;
		if (!disableTasksSettings) {
			const taskWarning = state.goal.taskList ? taskCompletionBlockWarning(state.goal.taskList) : null;
			if (taskWarning) {
				return {
					content: [{ type: "text", text: taskWarning }],
					details: goalDetails(state.goal),
				};
			}
		}

		// Verification contract gate: enforced only when the model supplied a
		// verification summary. The new update_goal surface has no paperwork field
		// — the independent auditor derives the requirements from the objective and
		// contract and inspects actual state instead.
		const disableContractsSettings = loadGoalSettings(ctx.cwd).disableContracts;
		if (!disableContractsSettings && opts.verificationSummary !== undefined) {
			const contractGate = validateVerificationSummary({
				verificationContract: state.goal.verificationContract,
				verificationSummary: opts.verificationSummary,
			});
			if (!contractGate.ok) {
				return {
					content: [{ type: "text", text: contractGate.message }],
					details: goalDetails(state.goal),
				};
			}
		}

		const auditTarget = mergeGoalPromptFromDisk(ctx, state.goal);
		const completionFocus = focusedOperationToken(auditTarget.id);
		// Append ledger: completion requested
		try {
			goalService.appendEvents(ctx, [{
				type: "completion_requested",
				goalId: auditTarget.id,
				summary: opts.completionSummary,
				at: nowIso(),
			}]);
		} catch {
			// Ledger append failure should not block completion
		}
		const settings = loadGoalSettingsFileConfig(ctx.cwd);
		const auditorLabel = settings.provider || settings.model || settings.thinkingLevel
			? `${settings.provider ?? "default"}/${settings.model ?? "default"}${settings.thinkingLevel ? `:${settings.thinkingLevel}` : ""}`
			: "default";

		// Check if auditor is disabled per-goal (user toggled it off during goal confirmation)
		if (auditTarget.skipAuditor) {
			pi.sendMessage<GoalAuditEventDetails>({
				customType: GOAL_AUDIT_ENTRY,
				content: `Goal completed — per-goal auditor disabled.`,
				display: true,
				details: { phase: "skipped", goalId: auditTarget.id, auditor: auditorLabel },
			});
			try {
				goalService.appendEvents(ctx, [{
					type: "audit_skipped",
					goalId: auditTarget.id,
					reason: "disabled",
					provider: settings.provider,
					model: settings.model,
					thinkingLevel: settings.thinkingLevel,
					at: nowIso(),
				}]);
			} catch {
				// Ledger append failure should not block completion
			}
			accountProgress(ctx);
			auditProgress = null;
			goalWidgetComponent?.invalidate();
			const completeResult = goalService.apply(ctx, {
				reconcile: false,
				focusToken: completionFocus,
				mutate: () => ({ ...auditTarget, status: "complete" as const, stopReason: "agent" as const, updatedAt: nowIso() }),
			});
			if (completeResult.ok && completeResult.goal) runtime.markTurnStopped(completeResult.goal.id);
			syncGoalTools();
			updateUI(ctx);
			return {
				content: [{
					type: "text",
					text: buildCompletionReport({
						detailedSummary: detailedSummary(state.goal),
						completionSummary: opts.completionSummary,
						auditSkippedReason: "per-goal auditor disabled",
						taskSummary: state.goal?.taskList ? buildTaskSummary(state.goal.taskList) : null,
					}),
				}],
				details: goalDetails(state.goal),
				terminate: true,
			};
		}

		// Check if auditor is disabled in settings
		if (settings.disabled === true) {
			if (opts.confirmBypassAuditor !== true) {
				return {
					content: [{ type: "text", text: [
						"The completion auditor is disabled in settings.",
						"",
						`Use \`goal_question\` to ask the user: "The independent completion auditor is disabled. Bypass independent verification and mark the goal complete?"`,
						"If the user confirms, call complete_goal again with confirmBypassAuditor: true.",
					].join("\n") }],
					details: goalDetails(state.goal),
				};
			}
			// Auditor disabled and confirmed — skip audit.
			// Defer archival: set goal complete in-memory + write active file WITHOUT
			// archiving. Archival happens at turn_end so the agent has a chance to
			// recognise the skipped audit before the goal is archived.
			pi.sendMessage<GoalAuditEventDetails>({
				customType: GOAL_AUDIT_ENTRY,
				content: `Goal completed — auditor disabled in settings.`,
				display: true,
				details: { phase: "skipped", goalId: auditTarget.id, auditor: auditorLabel },
			});
			try {
				goalService.appendEvents(ctx, [{
					type: "audit_skipped",
					goalId: auditTarget.id,
					reason: "disabled",
					provider: settings.provider,
					model: settings.model,
					thinkingLevel: settings.thinkingLevel,
					at: nowIso(),
				}]);
			} catch {
				// Ledger append failure should not block completion
			}
			// Set goal complete in memory (defer archival to turn_end)
			accountProgress(ctx);
			auditProgress = null;
			goalWidgetComponent?.invalidate();
			const completeResult = goalService.apply(ctx, {
				reconcile: false,
				focusToken: completionFocus,
				mutate: () => ({ ...auditTarget, status: "complete" as const, stopReason: "agent" as const, updatedAt: nowIso() }),
			});
			if (completeResult.ok && completeResult.goal) runtime.markTurnStopped(completeResult.goal.id);
			syncGoalTools();
			updateUI(ctx);
			return {
				content: [{
					type: "text",
					text: buildCompletionReport({
						detailedSummary: detailedSummary(state.goal),
						completionSummary: opts.completionSummary,
						auditSkippedReason: "auditor disabled in settings",
						taskSummary: state.goal?.taskList ? buildTaskSummary(state.goal.taskList) : null,
					}),
				}],
				details: goalDetails(state.goal),
				terminate: true,
			};
		}

		// Auditor is enabled — run the normal audit flow
		await pi.sendMessage<GoalAuditEventDetails>({
			customType: GOAL_AUDIT_ENTRY,
			content: [
				"Auditor: I am starting the independent completion audit.",
				`Goal id: ${auditTarget.id}`,
				`Auditor model: ${auditorLabel}`,
				opts.completionSummary?.trim() ? `Completion claim: ${opts.completionSummary.trim()}` : undefined,
			].filter((line): line is string => line !== undefined).join("\n"),
			display: true,
			details: { phase: "started", goalId: auditTarget.id, auditor: auditorLabel },
		}, { triggerTurn: true });
		if (!isFocusedOperationCurrent(completionFocus)) {
			return focusedOperationCancelledResult("Goal completion", completionFocus);
		}
		// Append ledger: audit started
		try {
			goalService.appendEvents(ctx, [{
				type: "audit_started",
				goalId: auditTarget.id,
				provider: settings.provider,
				model: settings.model,
				thinkingLevel: settings.thinkingLevel,
				at: nowIso(),
			}]);
		} catch {
			// Ledger append failure should not block completion
		}
		// Set up auditor progress display (before createAgentSession)
		const auditStartedAt = Date.now();
		auditProgress = {
			recentOutput: [],
			phase: "running",
			elapsedMs: 0,
		};
		// Start animation timer for the spinner in the auditor widget
		stopAuditAnimation();
		auditAnimationTimer = setInterval(() => {
			if (!auditProgress) {
				stopAuditAnimation();
				return;
			}
			auditProgress.elapsedMs = Date.now() - auditStartedAt;
			goalWidgetComponent?.invalidate();
		}, 80);
		auditAnimationTimer.unref?.();

		// Create a dedicated AbortController for the audit so it can be interrupted via Escape
		auditAbortController?.abort(); // Clean up any stale controller
		const completionAuditController = new AbortController();
		auditAbortController = completionAuditController;

		const auditor = await (dependencies.runCompletionAuditor ?? runGoalCompletionAuditor)({
			ctx,
			goal: auditTarget,
			completionSummary: opts.completionSummary,
			detailedSummary: detailedSummary(auditTarget),
			verificationSummary: opts.verificationSummary,
			settings: loadGoalSettings(ctx.cwd),
			signal: completionAuditController.signal,
			onProgress: (progress) => {
				auditProgress = {
					...progress,
					elapsedMs: Date.now() - auditStartedAt,
				};
				goalWidgetComponent?.invalidate();
			},
		});
		// Clear abort controller — audit finished on its own
		if (auditAbortController === completionAuditController) auditAbortController = null;
		// Clear auditor progress display
		stopAuditAnimation();
		if (!isFocusedOperationCurrent(completionFocus)) {
			auditProgress = null;
			goalWidgetComponent?.invalidate();
			return focusedOperationCancelledResult("Goal completion", completionFocus);
		}

		// If the audit was aborted by the user (Esc), show a TUI dialog letting
		// the user choose: mark complete without audit, or continue working.
		if (auditor.error === "Auditor aborted.") {
			auditProgress = null;
			goalWidgetComponent?.invalidate();
			updateUI(ctx);

			showingEscapeDialog = true;
			const userChoice: EscapeDialogResult = await showEscapeDialog(ctx, auditTarget.objective);
			showingEscapeDialog = false;
			if (!isFocusedOperationCurrent(completionFocus)) {
				return focusedOperationCancelledResult("Goal completion", completionFocus);
			}

			if (userChoice === "complete_without_audit") {
				// ── Mark complete without audit ────────────────────────────
				pi.sendMessage<GoalAuditEventDetails>({
					customType: GOAL_AUDIT_ENTRY,
					content: `Goal completed — user bypassed audit via Escape.`,
					display: true,
					details: { phase: "skipped", goalId: auditTarget.id, auditor: auditorLabel },
				});
				try {
					goalService.appendEvents(ctx, [{
						type: "audit_skipped",
						goalId: auditTarget.id,
						reason: "user_aborted",
						provider: settings.provider,
						model: settings.model,
						thinkingLevel: settings.thinkingLevel,
						at: nowIso(),
					}]);
				} catch {
					// Ledger append failure should not block completion
				}
				// Set goal complete in memory (defer archival to turn_end)
				accountProgress(ctx);
				const completeResult = goalService.apply(ctx, {
					reconcile: false,
					focusToken: completionFocus,
					mutate: () => ({ ...auditTarget, status: "complete" as const, stopReason: "agent" as const, updatedAt: nowIso() }),
				});
				if (completeResult.ok && completeResult.goal) runtime.markTurnStopped(completeResult.goal.id);
				syncGoalTools();
				updateUI(ctx);
				return {
					content: [{
						type: "text",
						text: [
							"User chose to mark the goal complete (bypassed audit via Escape).",
							"",
							"The goal is complete. Provide a final summary of what was accomplished.",
						].join("\n"),
					}],
					details: goalDetails(state.goal),
				};
			} else {
				// ── Continue working → pause the goal ──────────────
				pauseActiveGoal(ctx);
				if (state.goal) runtime.markTurnStopped(state.goal.id);
				return {
					content: [{ type: "text", text: "Goal paused — user chose to continue working after skipping audit." }],
					details: state.goal ? goalDetails(state.goal) : undefined,
				};
			}
		}

		// Show final audit output briefly before clearing
		if (auditProgress && auditor.output) {
			const outputLines = auditor.output.split("\n").slice(0, 8);
			auditProgress = {
				...auditProgress,
				phase: "done",
				recentOutput: outputLines,
				elapsedMs: Date.now() - auditStartedAt,
			};
			goalWidgetComponent?.invalidate();
		}
		// Append ledger: audit result
		const verdict = auditor.approved ? "approved" : auditor.error ? "error" : "disapproved" as const;
		try {
			goalService.appendEvents(ctx, [{
				type: "audit_result",
				goalId: auditTarget.id,
				verdict,
				report: auditor.output || "Auditor produced no output.",
				at: nowIso(),
			}]);
		} catch {
			// Ledger append failure should not block completion
		}
		if (!auditor.approved) {
			// Clear auditor progress to restore normal widget state
			auditProgress = null;
			goalWidgetComponent?.invalidate();
			const rejectionText = [
				"Goal audit rejected.",
				"",
				"Goal completion rejected by independent auditor.",
				auditor.model ? `Auditor model: ${auditor.model}${auditor.thinkingLevel ? `:${auditor.thinkingLevel}` : ""}` : undefined,
				auditor.error ? `Auditor error: ${auditor.error}` : undefined,
				"",
				auditor.output || "Auditor produced no approval marker.",
			].filter((line): line is string => line !== undefined).join("\n");
			pi.sendMessage<GoalAuditEventDetails>({
				customType: GOAL_AUDIT_ENTRY,
				content: rejectionText,
				display: true,
				details: { phase: "rejected", goalId: auditTarget.id, auditor: auditor.model },
			});
			return {
				content: [{ type: "text", text: rejectionText }],
				details: goalDetails(state.goal),
			};
		}
		const approvalText = [
			"Auditor: I approve this completion claim.",
			auditor.model ? `Auditor model: ${auditor.model}${auditor.thinkingLevel ? `:${auditor.thinkingLevel}` : ""}` : undefined,
			"",
			auditor.output || "Auditor approved completion.",
		].filter((line): line is string => line !== undefined).join("\n");
		pi.sendMessage<GoalAuditEventDetails>({
			customType: GOAL_AUDIT_ENTRY,
			content: approvalText,
			display: true,
			details: { phase: "approved", goalId: auditTarget.id, auditor: auditor.model },
		});
		// Account for any remaining elapsed time.
		// Defer archival: set goal complete in-memory + write active file WITHOUT
		// archiving. Archival happens at turn_end so the agent can see the auditor
		// approval before the goal is archived.
		accountProgress(ctx);
		auditProgress = null;
		goalWidgetComponent?.invalidate();
		const completeResult = goalService.apply(ctx, {
			reconcile: false,
			focusToken: completionFocus,
			mutate: () => ({ ...auditTarget, status: "complete" as const, stopReason: "agent" as const, updatedAt: nowIso() }),
		});
		if (completeResult.ok && completeResult.goal) runtime.markTurnStopped(completeResult.goal.id);
		syncGoalTools();
		updateUI(ctx);
		return {
			content: [{
				type: "text",
				text: buildCompletionReport({
					detailedSummary: detailedSummary(state.goal),
					completionSummary: opts.completionSummary,
					auditorReport: auditor.output,
					taskSummary: state.goal?.taskList ? buildTaskSummary(state.goal.taskList) : null,
				}),
			}],
			details: goalDetails(state.goal),
			terminate: true,
		};
	}


	pi.registerTool(defineTool({
		name: "complete_goal",
		label: "Complete Goal",
		description: "Mark the current active or paused pi goal complete. Only call this when the goal objective is actually achieved — no required work remains.",
		promptSnippet: "Mark the active or paused pi goal complete — only when every requirement is satisfied.",
		promptGuidelines: [
			"Call complete_goal only when the pi goal objective has actually been achieved and no required work remains.",
			"Before calling complete_goal, you MUST provide a verificationSummary that addresses every success criterion and any verification contract on the goal. Fold all verification evidence (test output, grep results, requirements coverage) into this single field.",
			"The auditor is authoritative: completion is archived only if the auditor report ends with <approved/>. If it ends with <disapproved/> or no approval marker, complete_goal is rejected and the goal remains open.",
			"Do NOT call complete_goal if any work remains, even if substantial progress was made. Do not use it merely because work is stopping, tests passed, or you are blocked.",
			"Do not use complete_goal=complete as an escape hatch when you are blocked. If you are blocked, call pause_goal({reason, suggestedAction?}) instead so the user can intervene.",
			"For sisyphus goals, do not mark complete until every numbered step has been executed and individually verified against its done criterion.",
			"The goal objective is immutable. The agent MUST NOT modify the goal objective on its own initiative. If the user gives requirements, feedback, or corrections that differ from the goal objective, ask the user to run /goal-tweak to revise the goal. Use goal_question to confirm when the change is ambiguous.",
			"If the goal has a verificationContract, your verificationSummary must address every item in the contract. The auditor will cross-check your claims against real artifacts.",
		],
		parameters: Type.Object({
			status: Type.Optional(StringEnum([COMPLETE_STATUS] as const, { description: "Set to complete only when the objective is achieved." })),
			completionSummary: Type.Optional(Type.String({ description: "Concise completion claim and evidence summary passed to the independent auditor agent." })),
			verificationSummary: Type.String({ description: "Required verification evidence showing what was checked before declaring completion. Must address every success criterion and any verification contract on the goal. Examples: 'Ran npm test (0 failures), re-read requirements and confirmed A1-A3 complete, grepped for remaining STP references (none found).' The exact requirements depend on the specific goal." }),
			confirmBypassAuditor: Type.Optional(Type.Boolean({ description: "Set to true to confirm bypassing the independent auditor when it is disabled in settings." })),
		}, { additionalProperties: false }),
		executionMode: "sequential",
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			return runGoalCompletionFlow(ctx, {
				completionSummary: params.completionSummary,
				verificationSummary: params.verificationSummary,
				confirmBypassAuditor: params.confirmBypassAuditor,
				status: params.status,
			});
		}
		,
		renderCall(args, theme) {
			const label = args?.status ?? "";
			return new Text(theme.fg("toolTitle", "complete_goal ") + theme.fg("success", label), 0, 0);
		},
		renderResult(result, _options, theme) {
			return renderGoalResult(result, theme);
		},
	}));

	// ── update_goal: the model's terminal-outcome surface (Stage 3) ────────
	// complete → the independent auditor verifies from actual evidence (no
	// paperwork field); blocked → a distinct agent-blocked state that stops
	// continuation. The three-consecutive-turn blocker rule is prompt policy.
	async function runGoalBlockedFlow(ctx: ExtensionContext): Promise<AgentToolResult<unknown>> {
		reconcileFocusedGoalFromDisk(ctx);
		const gate = validateGoalBlock({ goal: state.goal, runningGoalId });
		if (!gate.ok) {
			return {
				content: [{ type: "text", text: gate.message }],
				details: goalDetails(state.goal),
			};
		}
		if (!state.goal) throw new Error("Goal disappeared during blocked validation.");
		accountProgress(ctx);
		const result = goalService.apply(ctx, {
			reconcile: false,
			refreshFromDisk: true,
			mutate: (g) => ({
				...g,
				status: "blocked" as const,
				stopReason: "agent" as const,
				pauseReason: g.pauseReason ?? "The model reported this goal as blocked after the same blocker recurred on consecutive turns.",
				updatedAt: nowIso(),
			}),
			ledger: (written) => [{
				type: "goal_blocked",
				goalId: written.id,
				reason: written.pauseReason ?? "blocked",
				source: "agent",
				at: written.updatedAt,
			}],
		});
		if (result.ok) {
			clearContinuationState();
			clearActiveAccounting();
			if (result.goal) runtime.markTurnStopped(result.goal.id);
			syncGoalTools();
			updateUI(ctx);
		}
		return {
			content: [{
				type: "text",
				text: "Goal blocked. Continuation stopped; the goal is waiting for the user to resume, revise, or clear it. Stop now; do not start another tool call.",
			}],
			details: goalDetails(state.goal),
			terminate: true,
		};
	}

	pi.registerTool(defineTool({
		name: "update_goal",
		label: "Update Goal",
		description: "Report one of two terminal outcomes for the current run: status \"complete\" (runs the independent completion auditor, which verifies from actual evidence — no paperwork field) or status \"blocked\" (records a distinct agent-blocked state and stops continuation). Call blocked only after the same blocker recurs on three consecutive goal turns.",
		promptSnippet: "Report the current run as complete (audited) or blocked (after three consecutive identical blockers).",
		promptGuidelines: [
			"Call update_goal({status: \"complete\"}) only when every requirement is satisfied. There is no verification-summary parameter: the independent auditor derives the requirements from the objective and any verification contract, and inspects the actual workspace evidence.",
			"Call update_goal({status: \"blocked\"}) only after the SAME blocker has recurred on three consecutive goal turns. Do not block on the first or second occurrence — keep trying concrete next steps and ask for help when genuinely stuck. A user pause remains an immediate, distinct state controlled by the user.",
			"Do not use update_goal as an escape hatch: if the objective is achieved, complete it; if it is not, do not complete it. The goal objective is immutable — the model must never edit it on its own initiative.",
			"For sisyphus goals, do not mark complete until every numbered step has been executed and individually verified against its done criterion.",
		],
		parameters: Type.Object({
			status: StringEnum(["complete", "blocked"] as const, { description: "complete runs the independent auditor; blocked records a distinct agent-blocked state. Only these two outcomes are accepted." }),
		}, { additionalProperties: false }),
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (params.status === "blocked") {
				return runGoalBlockedFlow(ctx);
			}
			return runGoalCompletionFlow(ctx, {});
		},
		renderCall(args, theme) {
			return new Text(theme.fg("toolTitle", "update_goal ") + theme.fg("muted", args?.status ?? ""), 0, 0);
		},
		renderResult(result, _options, theme) {
			return renderGoalResult(result, theme);
		},
	}));

	pi.registerTool(defineTool({
		name: "pause_goal",
		label: "Pause Goal",
		description: "Pause the active pi goal and report a blocker to the user. The user must /goal-resume, /goal-tweak, or /goal-clear before work continues.",
		promptSnippet: "Pause the active pi goal and report a concrete blocker so the user can intervene.",
		promptGuidelines: [
			"Use pause_goal when you have hit a real blocker that you cannot resolve with one more reasonable next step: missing credentials, ambiguous or contradictory spec, a file or permission you cannot access, a sisyphus step whose precondition is not in the plan, or any irreversible / dangerous operation that requires explicit user approval.",
			"Do NOT use pause_goal to escape a merely hard problem; first try one concrete next step. Do not use pause_goal as a softer substitute for complete_goal \u2014 if the objective is achieved, complete it; if it is not, do not complete it.",
			"Never silently invent a workaround, fake completion, or quietly redefine the objective. Pause and report instead.",
			"Always pass a concrete one-sentence reason. When you know how the user can unblock you, pass suggestedAction (e.g. 'Set FOO_API_KEY env var and /goal-resume', or 'Use /goal-tweak to insert a precondition step before step 3').",
			"After pause_goal returns, stop. Do not call other tools in the same turn.",
			"For sisyphus goals: if any step is unclear, blocked, fails, or seems wrong, pause_goal is the correct action \u2014 do not skip the step or invent a workaround.",
		],
		parameters: Type.Object({
			reason: Type.String({ description: "One-sentence concrete blocker description. Plain language, not an apology." }),
			suggestedAction: Type.Optional(Type.String({ description: "Optional concrete suggestion for how the user can unblock (e.g. command to run, value to provide, /goal-tweak hint)." })),
		}),
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			reconcileFocusedGoalFromDisk(ctx);
			const reason = params.reason.trim();
			if (!reason) throw new Error("pause_goal requires a non-empty reason.");
			const pauseGate = validatePauseGoal({ goal: state.goal, runningGoalId, reason });
			if (!pauseGate.ok) {
				return {
					content: [{ type: "text", text: pauseGate.message }],
					details: goalDetails(state.goal),
				};
			}
			if (!state.goal) throw new Error("Goal disappeared during pause validation.");
			const suggested = params.suggestedAction?.trim() || undefined;

			// Account for any remaining elapsed time before stopping the run.
			accountProgress(ctx);
			state.goal = mergeGoalPromptFromDisk(ctx, state.goal);
			const next = buildPausedByAgentGoal(state.goal, { reason, suggestedAction: suggested, updatedAt: nowIso() });
			setGoal(next, ctx);
			// C9 fix: mark turn-stopped so subsequent in-turn tool calls are blocked.
			// This is the schema-level closure of "agent kept writing files after pause_goal".
			runtime.markTurnStopped(state.goal.id);

			const suggestionLine = suggested ? `\nSuggested: ${truncateText(suggested, 160)}` : "";
			ctx.ui.notify(
				`Goal paused by agent.\nReason: ${truncateText(reason, 200)}${suggestionLine}\n\nUse /goal-resume to continue, /goal-tweak to revise, or /goal-clear to abandon.`,
				"warning",
			);
			return {
				content: [{
					type: "text",
					text: `Goal paused. Reason: ${reason}${suggested ? `\nSuggested: ${suggested}` : ""}\nWaiting for user to /goal-resume, /goal-tweak, or /goal-clear. Stop now; do not start another tool call.`,
				}],
				details: goalDetails(state.goal),
				terminate: true,
			};
		},
		renderCall(args, theme) {
			return new Text(theme.fg("toolTitle", "pause_goal ") + theme.fg("warning", truncateText(args?.reason ?? "", 80)), 0, 0);
		},
		renderResult(result, _options, theme) {
			return renderGoalResult(result, theme);
		},
	}));

	pi.registerTool(defineTool({
		name: ABORT_GOAL_TOOL_NAME,
		label: "Abort Goal",
		description: "Abort the current active or paused pi goal and archive it without marking it complete.",
		promptSnippet: "Abort the current pi goal only when the user asks to abandon it or the objective is obsolete/impossible.",
		promptGuidelines: [
			"Use abort_goal only when the user explicitly asks to abandon/cancel the current goal, or when the goal is impossible, obsolete, or unsafe to continue and should not be marked complete.",
			"Do not use abort_goal as a substitute for complete_goal. If the objective is achieved, complete it instead.",
			"Do not use abort_goal for ordinary blockers that the user can resolve; use pause_goal({reason, suggestedAction?}) for that case.",
			"Always pass a concrete one-sentence reason. After abort_goal returns, stop and do not call other tools in the same turn.",
		],
		parameters: Type.Object({
			reason: Type.String({ description: "One-sentence reason for abandoning the current goal. Plain language, not an apology." }),
		}),
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			reconcileFocusedGoalFromDisk(ctx);
			const reason = params.reason.trim();
			if (!reason) throw new Error("abort_goal requires a non-empty reason.");
			const abortGate = validateGoalAbort({ goal: state.goal, runningGoalId, reason });
			if (!abortGate.ok) {
				return {
					content: [{ type: "text", text: abortGate.message }],
					details: goalDetails(state.goal),
				};
			}
			if (!state.goal) throw new Error("Goal disappeared during abort validation.");
			const abortedGoalId = state.goal.id;

			// Account for any remaining elapsed time before abandoning the run.
			accountProgress(ctx);
			state.goal = mergeGoalPromptFromDisk(ctx, state.goal);
			state.goal = buildAbortedByAgentGoal(state.goal, { reason, updatedAt: nowIso() });
			const archived = archiveCurrentGoal(ctx, "agent");
			setGoal(null, ctx, true, "aborted");
			runtime.markTurnStopped(abortedGoalId);

			const archiveLine = archived?.archivedPath ? `\nArchive: ${archived.archivedPath}` : "";
			ctx.ui.notify(
				`Goal aborted by agent.\nReason: ${truncateText(reason, 200)}${archiveLine}`,
				"warning",
			);
			// Append ledger event for abort
			try {
				goalService.appendEvents(ctx, [{
					type: "goal_aborted",
					goalId: abortedGoalId,
					reason,
					archivePath: archived?.archivedPath,
					at: nowIso(),
				}]);
			} catch {
				// Ledger append failure should not crash abort
			}
			return {
				content: [{
					type: "text",
					text: `Goal aborted. Reason: ${reason}${archiveLine}\nThe goal has been archived and cleared. Stop now; do not start another tool call.`,
				}],
				details: goalDetails(state.goal),
				terminate: true,
			};
		},
		renderCall(args, theme) {
			return new Text(theme.fg("toolTitle", "abort_goal ") + theme.fg("warning", truncateText(args?.reason ?? "", 80)), 0, 0);
		},
		renderResult(result, _options, theme) {
			return renderGoalResult(result, theme);
		},
	}));

	pi.registerTool(defineTool({
		name: SISYPHUS_STEP_TOOL_NAME,
		label: "Sisyphus Step Complete (Legacy)",
		description: "Legacy compatibility tool. Current Sisyphus mode is a prompt/criteria style and no longer uses schema-tracked step completion.",
		promptSnippet: "Legacy no-op: Sisyphus no longer requires step_complete.",
		promptGuidelines: [
			"Do not call this in normal operation. Sisyphus mode shares the normal goal lifecycle and completion gate.",
			"Call complete_goal only when the full objective is actually satisfied.",
		],
		parameters: Type.Object({
			stepIndex: Type.Integer({ minimum: 1, description: "Legacy step index. Ignored." }),
			evidence: Type.String({ description: "Legacy evidence text. Ignored by the schema." }),
			verifyCommand: Type.Optional(Type.String({ description: "Legacy field. Not executed." })),
		}),
		executionMode: "sequential",
		async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
			return {
				content: [{ type: "text", text: "step_complete is no longer required. Sisyphus is now a prompt/criteria style that uses the normal goal lifecycle. Continue working from the objective, or call complete_goal only when the full objective is actually satisfied." }],
				details: goalDetails(state.goal),
			};
		},
		renderCall(args, theme) {
			return new Text(theme.fg("toolTitle", "step_complete legacy ") + theme.fg("muted", `#${args?.stepIndex ?? "?"}`), 0, 0);
		},
		renderResult(result, _options, theme) {
			return renderGoalResult(result, theme);
		},
	}));

	// ── propose_task_list ──────────────────────────────────────────────────
	pi.registerTool(defineTool({
		name: PROPOSE_TASK_LIST_TOOL_NAME,
		label: "Propose Task List",
		description: "Propose a structured task list for the current goal. Mirrors the propose_goal_tweak pattern: shows a confirmation dialog and stops the turn.",
		promptSnippet: "Propose a task list with confirmation. Stops the turn after confirmation.",
		promptGuidelines: [
			"Use propose_task_list after a goal is confirmed, on the first continuation turn, if the objective naturally decomposes into trackable milestones.",
			"Do not add a task list for simple, single-step goals.",
			"If a task list already exists on the goal, only call propose_task_list to restructure it when (a) the user explicitly asks for a change, or (b) the goal objective or requirements have structurally changed. Do not restructure the task list autonomously.",
			"Existing tasks with matching IDs preserve their status/evidence/timestamps; new IDs start as pending; removed IDs are gone.",
			"After confirmation the turn stops; the next continuation will arrive automatically.",
			"You may optionally specify a verificationContract per task to define what verification evidence is required before completing that task.",
		],
		parameters: Type.Object({
			tasks: Type.Array(Type.Object({
				id: Type.String({ description: "Short stable slug e.g. 'task-1'" }),
				title: Type.String({ description: "Human-readable task title" }),
				verificationContract: Type.Optional(Type.String({ description: "Optional verification contract for this task — what evidence is required before marking it complete." })),
				lightweightSubtasks: Type.Optional(Type.Boolean({ description: "If true, subtasks are lightweight (no completion enforcement). Default false (full subtasks)." })),
				subtasks: Type.Optional(Type.Any({ description: "Optional recursive array of sub-tasks (same shape as parent). Nested up to subtaskDepth (default 1, from settings)." })),
			}), { description: "Array of task objects with id, title, optional subtasks" }),
			blockCompletion: Type.Optional(Type.Boolean({ description: "If true, warns when pending tasks remain during complete_goal. Default false." })),
			changeSummary: Type.Optional(Type.String({ description: "Optional summary of the task list proposal" })),
		}),
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			reconcileFocusedGoalFromDisk(ctx);
			if (!state.goal) {
				return {
					content: [{ type: "text", text: "No goal is set; propose_task_list requires an active goal." }],
					details: goalDetails(state.goal),
				};
			}
			// Reject if task lists are disabled via settings
			if (loadGoalSettings(ctx.cwd).disableTasks) {
				return {
					content: [{ type: "text", text: "propose_task_list is disabled by settings (disableTasks: true)." }],
					details: goalDetails(state.goal),
				};
			}
			const settings = loadGoalSettings(ctx.cwd);
			const gate = validateTaskListProposal({ goal: state.goal, tasks: params.tasks as GoalTask[], maxSubtaskDepth: settings.subtaskDepth });
			if (!gate.ok) {
				return {
					content: [{ type: "text", text: gate.message }],
					details: goalDetails(state.goal),
				};
			}
			const blockCompletion = params.blockCompletion === true;
			const now = nowIso();
			const existingTasks = state.goal.taskList?.tasks ?? [];
			const existingById = new Map(existingTasks.map((t) => [t.id, t]));

			// Merge: existing tasks with matching IDs preserve status/timestamps
			function mergeTask(input: GoalTask): GoalTask {
				const existing = existingById.get(input.id);
				const base: GoalTask = existing
					? {
						...existing,
						title: input.title,
						verificationContract: input.verificationContract ?? existing.verificationContract,
						lightweightSubtasks: input.lightweightSubtasks ?? existing.lightweightSubtasks,
					}
					: {
						id: input.id,
						title: input.title,
						status: "pending" as const,
						verificationContract: input.verificationContract || undefined,
						lightweightSubtasks: input.lightweightSubtasks || undefined,
					};
				if (input.subtasks && input.subtasks.length > 0) {
					base.subtasks = input.subtasks.map((child) => mergeTask(child));
				}
				return base;
			}
			const mergedTasks = params.tasks.map((p) => mergeTask(p as GoalTask));

			const taskList: GoalTaskList = {
				tasks: mergedTasks,
				blockCompletion,
				proposedAt: now,
			};

			// Show full proposed task list in confirmation dialog (with subtasks)
			function renderTaskLines(tasks: GoalTask[], indent = 0): string[] {
				const prefix = "  ".repeat(indent);
				const lines: string[] = [];
				for (const t of tasks) {
					const marker = t.status === "complete" ? "[x]" : t.status === "skipped" ? "[~]" : "[ ]";
					const lw = t.lightweightSubtasks ? " (lightweight)" : "";
					lines.push(`${prefix}${marker} ${t.id}: ${t.title}${lw}`);
					if (t.subtasks && t.subtasks.length > 0) {
						lines.push(...renderTaskLines(t.subtasks, indent + 1));
					}
				}
				return lines;
			}
			const taskLines = renderTaskLines(taskList.tasks);
			const gateLabel = blockCompletion ? " (blockCompletion enabled)" : "";
			const proposalText = [`Proposed task list${gateLabel}:`, "", ...taskLines].join("\n");
			const taskListFocus = focusedOperationToken(state.goal.id);

			const dialogResult = await showProposalDialog(ctx, proposalText, "goal", !state.goal?.skipAuditor);
			if (!isFocusedOperationCurrent(taskListFocus)) {
				return focusedOperationCancelledResult("Task list proposal", taskListFocus);
			}
			if (dialogResult.decision !== "confirm") {
				return {
					content: [{ type: "text", text: "Task list proposal declined." }],
					details: goalDetails(state.goal),
				};
			}
			// Persist any auditor toggle change
			if (state.goal) {
				state.goal = { ...state.goal, skipAuditor: !dialogResult.auditorEnabled };
			}

			// Apply
			const taskListResult = goalService.apply(ctx, {
				reconcile: false,
				focusToken: taskListFocus,
				refreshFromDisk: true,
				mutate: (g) => ({ ...g, taskList, updatedAt: now }),
				ledger: (written) => [{
					type: "task_list_set",
					goalId: written.id,
					taskCount: taskList.tasks.length,
					blockCompletion,
					at: written.updatedAt,
				}],
			});
			if (!taskListResult.ok) {
				return focusedOperationCancelledResult("Task list proposal", taskListFocus);
			}
			runtime.markTurnStopped(state.goal.id);
			syncGoalTools();
			updateUI(ctx);

			return {
				content: [{ type: "text", text: `Task list proposed and confirmed. ${taskList.tasks.length} task${taskList.tasks.length === 1 ? "" : "s"} set.${gateLabel}` }],
				details: goalDetails(state.goal),
				terminate: true,
			};
		},
		renderCall(args, theme) {
			const summary = args?.changeSummary ? truncateText(args.changeSummary, 80) : `${args?.tasks?.length ?? 0} tasks`;
			return new Text(theme.fg("toolTitle", "propose_task_list ") + theme.fg("muted", summary), 0, 0);
		},
		renderResult(result, _options, theme) {
			return renderGoalResult(result, theme);
		},
	}));

	// ── complete_task ─────────────────────────────────────────────────────
	pi.registerTool(defineTool({
		name: COMPLETE_TASK_TOOL_NAME,
		label: "Complete Task",
		description: "Mark a task as complete within the current goal's task list. Does NOT stop the turn — the agent can continue working.",
		promptSnippet: "Mark a task done and continue. Does not stop the turn.",
		promptGuidelines: [
			"Use complete_task to mark a task as complete with optional evidence text (max 200 characters).",
			"The turn does NOT stop after complete_task — you may continue with other work.",
			"If the task has a verificationContract, you MUST provide a verificationSummary that addresses it.",
		],
		parameters: Type.Object({
			taskId: Type.String({ description: "Task id to mark as complete" }),
			evidence: Type.Optional(Type.String({ description: "Optional evidence note (max 200 characters)" })),
			verificationSummary: Type.Optional(Type.String({ description: "Verification evidence for this task. Required if the task has a verificationContract." })),
		}),
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			reconcileFocusedGoalFromDisk(ctx);
			if (loadGoalSettings(ctx.cwd).disableTasks) {
				return {
					content: [{ type: "text", text: "complete_task is disabled by settings (disableTasks: true)." }],
					details: goalDetails(state.goal),
				};
			}
			const gate = validateTaskCompletion({ goal: state.goal, taskId: params.taskId });
			if (!gate.ok) {
				return {
					content: [{ type: "text", text: gate.message }],
					details: goalDetails(state.goal),
				};
			}
			if (!state.goal?.taskList) throw new Error("Task list disappeared during task completion.");

			// Check verification contract for the task (skip if contracts disabled)
			const settings = loadGoalSettings(ctx.cwd);
			const taskToComplete = findTaskInTree(state.goal.taskList.tasks, params.taskId);
			if (!settings.disableContracts) {
				const contractGate = validateVerificationSummary({
					verificationContract: taskToComplete?.verificationContract,
					verificationSummary: params.verificationSummary,
				});
				if (!contractGate.ok) {
					return {
						content: [{ type: "text", text: contractGate.message }],
						details: goalDetails(state.goal),
					};
				}
			}

			// Check subtask completion (full subtasks only)
			if (taskToComplete) {
				const subtaskGate = checkSubtasksComplete(taskToComplete);
				if (subtaskGate) {
					return {
						content: [{ type: "text", text: subtaskGate }],
						details: goalDetails(state.goal),
					};
				}
			}

			const now = nowIso();
			const evidence = params.evidence?.trim().slice(0, 200) || undefined;
			const updatedTasks = updateTaskInTree(state.goal.taskList.tasks, params.taskId, (t) => ({
				...t,
				status: "complete" as const,
				completedAt: now,
				evidence,
			}));
			const completeTaskResult = goalService.apply(ctx, {
				reconcile: false,
				refreshFromDisk: true,
				mutate: (g) => {
					if (!g.taskList) throw new Error("Goal disappeared during task completion.");
					return {
						...g,
						taskList: { ...g.taskList, blockCompletion: g.taskList.blockCompletion, tasks: updatedTasks },
						updatedAt: now,
					};
				},
				ledger: (written) => [{
					type: "task_complete",
					goalId: written.id,
					taskId: params.taskId,
					evidence,
					at: written.updatedAt,
				}],
			});
			if (!completeTaskResult.ok) {
				return {
					content: [{ type: "text", text: completeTaskResult.message }],
					details: goalDetails(state.goal),
				};
			}
			syncGoalTools();
			updateUI(ctx);

			const taskSummary = buildTaskSummary(state.goal.taskList!);
			return {
				content: [{ type: "text", text: `${params.taskId} complete. ${taskSummary}.` }],
				details: goalDetails(state.goal),
			};
		},
		renderCall(args, theme) {
			return new Text(theme.fg("toolTitle", "complete_task ") + theme.fg("success", args?.taskId ?? ""), 0, 0);
		},
		renderResult(result, _options, theme) {
			return renderGoalResult(result, theme);
		},
	}));

	// ── skip_task ─────────────────────────────────────────────────────────
	pi.registerTool(defineTool({
		name: SKIP_TASK_TOOL_NAME,
		label: "Skip Task",
		description: "Skip a pending task in the current goal's task list. Does NOT stop the turn — the agent can continue working.",
		promptSnippet: "Skip a task with a reason. Does not stop the turn.",
promptGuidelines: [
			"Use skip_task to mark a task as skipped with a required reason.",
			"The turn does NOT stop after skip_task — you may continue with other work.",
			"Only skip a task when the user explicitly asks you to, or when the task directly contradicts a hard constraint (e.g. an impossible requirement).",
			"Do NOT autonomously skip tasks to avoid work, or because they look optional, inconvenient, or out of scope. When in doubt, ask the user first.",
			"If skip_task is called on an already-skipped task, it toggles back to pending (unskip).",
		],
		parameters: Type.Object({
			taskId: Type.String({ description: "Task id to skip" }),
			reason: Type.String({ description: "Non-empty reason for skipping this task" }),
		}),
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			reconcileFocusedGoalFromDisk(ctx);
			if (loadGoalSettings(ctx.cwd).disableTasks) {
				return {
					content: [{ type: "text", text: "skip_task is disabled by settings (disableTasks: true)." }],
					details: goalDetails(state.goal),
				};
			}
			const gate = validateTaskSkip({ goal: state.goal, taskId: params.taskId, reason: params.reason });
			if (!gate.ok) {
				return {
					content: [{ type: "text", text: gate.message }],
					details: goalDetails(state.goal),
				};
			}
			if (!state.goal?.taskList) throw new Error("Task list disappeared during task skip.");
			const now = nowIso();
			const wasAlreadySkipped = findTaskInTree(state.goal.taskList.tasks, params.taskId)?.status === "skipped";

			const updatedTasks = updateTaskInTree(state.goal.taskList.tasks, params.taskId, (t) => {
				if (t.status === "skipped") {
					// Toggle back to pending — clear skip state, do NOT cascade to subtasks
					const { skippedAt, skipReason, ...rest } = t;
					return { ...rest, status: "pending" as const };
				}
				// First-time skip: cascade to all subtasks (full subtasks only)
				const base = { ...t, status: "skipped" as const, skippedAt: now, skipReason: params.reason.trim() };
				if (t.subtasks && t.subtasks.length > 0 && !t.lightweightSubtasks) {
					return skipAllSubtasks(base, now, params.reason.trim());
				}
				return base;
			});
			const skipTaskResult = goalService.apply(ctx, {
				reconcile: false,
				refreshFromDisk: true,
				mutate: (g) => {
					if (!g.taskList) throw new Error("Goal disappeared during task skip.");
					return {
						...g,
						taskList: { ...g.taskList, blockCompletion: g.taskList.blockCompletion, tasks: updatedTasks },
						updatedAt: now,
					};
				},
				ledger: (written) => [{
					type: "task_skipped",
					goalId: written.id,
					taskId: params.taskId,
					reason: wasAlreadySkipped ? "unskipped (toggle via skip_task)" : params.reason.trim(),
					at: written.updatedAt,
				}],
			});
			if (!skipTaskResult.ok) {
				return {
					content: [{ type: "text", text: skipTaskResult.message }],
					details: goalDetails(state.goal),
				};
			}
			syncGoalTools();
			updateUI(ctx);

			const taskSummary = buildTaskSummary(state.goal.taskList!);
			const action = wasAlreadySkipped ? "unsikpped" : "skipped";
			return {
				content: [{ type: "text", text: `${params.taskId} ${action}. ${taskSummary}.` }],
				details: goalDetails(state.goal),
			};
		},
		renderCall(args, theme) {
			return new Text(theme.fg("toolTitle", "skip_task ") + theme.fg("warning", args?.taskId ?? ""), 0, 0);
		},
		renderResult(result, _options, theme) {
			return renderGoalResult(result, theme);
		},
	}));

	// ── set_goal_tasks: flat parent-linked structural task-tree tool (Stage 4) ──
	pi.registerTool(defineTool({
		name: SET_GOAL_TASKS_TOOL_NAME,
		label: "Set Goal Tasks",
		description: "Create or structurally replace the task tree for the focused active or paused goal. Takes a flat parent-linked task list (id, title, optional parent_id, optional verification_contract, optional lightweight_subtasks) plus block_completion. Matching ids retain status and evidence. Structural changes use the existing confirmation dialog.",
		promptSnippet: "Set the goal task tree with confirmation. Stops the turn after confirmation.",
		promptGuidelines: [
			"Use set_goal_tasks after a goal is confirmed, on the first continuation turn, if the objective naturally decomposes into trackable milestones. Do not add a task list for simple single-step goals.",
			"If a task list already exists, only call set_goal_tasks to restructure it when (a) the user explicitly asks, or (b) the goal objective or requirements have structurally changed. Do not restructure autonomously.",
			"Existing tasks with matching ids preserve their status/evidence/timestamps; new ids start as pending; removed ids are gone.",
			"After confirmation the turn stops; the next continuation will arrive automatically.",
			"Validation is enforced at runtime: unique non-empty ids/titles, existing parents, acyclic relationships, at most 50 tasks, configured depth, and lightweight_subtasks only on tasks that have children.",
		],
		parameters: Type.Object({
			tasks: Type.Array(Type.Object({
				id: Type.String({ description: "Short stable slug e.g. 'task-1'" }),
				title: Type.String({ description: "Human-readable task title" }),
				parent_id: Type.Optional(Type.String({ description: "Optional id of the parent task in this same input; roots omit it." })),
				verification_contract: Type.Optional(Type.String({ description: "Optional evidence requirement for completing this task." })),
				lightweight_subtasks: Type.Optional(Type.Boolean({ description: "If true, this task's subtasks are lightweight (no completion enforcement). Only valid when the task has children." })),
			}), { description: "Flat parent-linked task list" }),
			block_completion: Type.Optional(Type.Boolean({ description: "If true, warns when pending tasks remain during completion. Default false." })),
			change_summary: Type.Optional(Type.String({ description: "Optional summary of the task list change" })),
		}, { additionalProperties: false }),
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			reconcileFocusedGoalFromDisk(ctx);
			if (!state.goal) {
				return {
					content: [{ type: "text", text: "No goal is set; set_goal_tasks requires a focused active or paused goal." }],
					details: goalDetails(state.goal),
				};
			}
			if (loadGoalSettings(ctx.cwd).disableTasks) {
				return {
					content: [{ type: "text", text: "set_goal_tasks is disabled by settings (disableTasks: true)." }],
					details: goalDetails(state.goal),
				};
			}
			if (state.goal.status !== "active" && state.goal.status !== "paused") {
				return {
					content: [{ type: "text", text: `set_goal_tasks applies to an active or paused goal; this goal is ${statusLabel(state.goal)}.` }],
					details: goalDetails(state.goal),
				};
			}
			const settings = loadGoalSettings(ctx.cwd);
			const converted = convertFlatTasks(params.tasks as FlatTaskInput[], { maxSubtaskDepth: settings.subtaskDepth });
			if (!converted.ok) {
				return {
					content: [{ type: "text", text: converted.message }],
					details: goalDetails(state.goal),
				};
			}
			const mergedTasks = mergeTasksWithExisting(state.goal.taskList?.tasks, converted.tasks);
			const blockCompletion = params.block_completion === true;
			const now = nowIso();
			const taskList: GoalTaskList = {
				tasks: mergedTasks,
				blockCompletion,
				proposedAt: now,
			};

			// Render the proposed tree for the confirmation dialog.
			function renderTaskLines(tasks: GoalTask[], indent = 0): string[] {
				const prefix = "  ".repeat(indent);
				const lines: string[] = [];
				for (const t of tasks) {
					const marker = t.status === "complete" ? "[x]" : t.status === "skipped" ? "[~]" : "[ ]";
					const lw = t.lightweightSubtasks ? " (lightweight)" : "";
					lines.push(`${prefix}${marker} ${t.id}: ${t.title}${lw}`);
					if (t.subtasks && t.subtasks.length > 0) {
						lines.push(...renderTaskLines(t.subtasks, indent + 1));
					}
				}
				return lines;
			}
			const taskLines = renderTaskLines(taskList.tasks);
			const gateLabel = blockCompletion ? " (blockCompletion enabled)" : "";
			const proposalText = [`Proposed task list${gateLabel}:`, "", ...taskLines].join("\n");
			const taskListFocus = focusedOperationToken(state.goal.id);
			const headless = shouldAutoConfirmProposal({ hasUI: ctx.hasUI, autoConfirmEnv: process.env.PI_GOAL_AUTO_CONFIRM });
			let dialogResult: { decision: "confirm" | "continue"; auditorEnabled: boolean };
			if (headless) {
				dialogResult = { decision: "confirm", auditorEnabled: state.goal?.skipAuditor ? false : true };
			} else {
				dialogResult = await showProposalDialog(ctx, proposalText, "goal", !state.goal?.skipAuditor);
			}
			if (!isFocusedOperationCurrent(taskListFocus)) {
				return focusedOperationCancelledResult("Task list proposal", taskListFocus);
			}
			if (dialogResult.decision !== "confirm") {
				return {
					content: [{ type: "text", text: "Task list proposal declined." }],
					details: goalDetails(state.goal),
				};
			}
			if (state.goal) {
				state.goal = { ...state.goal, skipAuditor: !dialogResult.auditorEnabled };
			}
			const applyResult = goalService.apply(ctx, {
				reconcile: false,
				focusToken: taskListFocus,
				refreshFromDisk: true,
				mutate: (g) => ({ ...g, taskList, updatedAt: now }),
				ledger: (written) => [{
					type: "task_list_set",
					goalId: written.id,
					taskCount: taskList.tasks.length,
					blockCompletion,
					at: written.updatedAt,
				}],
			});
			if (!applyResult.ok) {
				return focusedOperationCancelledResult("Task list proposal", taskListFocus);
			}
			runtime.markTurnStopped(state.goal.id);
			syncGoalTools();
			updateUI(ctx);
			return {
				content: [{ type: "text", text: `Task list set and confirmed. ${taskList.tasks.length} task${taskList.tasks.length === 1 ? "" : "s"}.${gateLabel}` }],
				details: goalDetails(state.goal),
				terminate: true,
			};
		},
		renderCall(args, theme) {
			const summary = args?.change_summary ? truncateText(args.change_summary, 80) : `${args?.tasks?.length ?? 0} tasks`;
			return new Text(theme.fg("toolTitle", "set_goal_tasks ") + theme.fg("muted", summary), 0, 0);
		},
		renderResult(result, _options, theme) {
			return renderGoalResult(result, theme);
		},
	}));

	// ── update_goal_task: discriminated per-task status tool (Stage 4) ───────
	pi.registerTool(defineTool({
		name: UPDATE_GOAL_TASK_TOOL_NAME,
		label: "Update Goal Task",
		description: "Update one task in the focused goal's task tree without stopping the turn: status \"complete\" (with optional evidence; requires evidence when the task has a verification contract and enforces completed children), \"skipped\" (requires a reason; restricted to explicit user direction or a hard contradiction), or \"pending\" (reopens a skipped task). Completed tasks are immutable through this tool.",
		promptSnippet: "Mark one task complete, skipped, or reopened. Does not stop the turn.",
		promptGuidelines: [
			"Use update_goal_task to update exactly one task; the turn does NOT stop so you may continue with other work.",
			"status=complete requires evidence when the task has a verification contract, and requires all non-lightweight children to be complete first.",
			"status=skipped requires a concrete reason and is restricted to explicit user direction or a hard contradiction (e.g. an impossible requirement). Do not skip to avoid work.",
			"status=pending reopens a skipped task (clears its skip state). Completed tasks cannot be reopened through this tool.",
		],
		parameters: Type.Object({
			task_id: Type.String({ description: "Task id to update" }),
			status: StringEnum(["complete", "skipped", "pending"] as const, { description: "complete (with optional evidence), skipped (requires reason), or pending (reopens a skipped task)." }),
			evidence: Type.Optional(Type.String({ description: "Evidence note for complete (max 200 characters). Required when the task has a verification contract." })),
			reason: Type.Optional(Type.String({ description: "Reason for skipped. Required when status=skipped." })),
		}, { additionalProperties: false }),
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			reconcileFocusedGoalFromDisk(ctx);
			if (loadGoalSettings(ctx.cwd).disableTasks) {
				return {
					content: [{ type: "text", text: "update_goal_task is disabled by settings (disableTasks: true)." }],
					details: goalDetails(state.goal),
				};
			}
			const gate = validateTaskCompletion({ goal: state.goal, taskId: params.task_id });
			// The completion gate rejects skipped/complete tasks; for status=pending
			// (reopen) we intentionally bypass it — the reopen rules are enforced in
			// the pending branch below.
			if (!gate.ok && params.status !== "pending") {
				return {
					content: [{ type: "text", text: gate.message }],
					details: goalDetails(state.goal),
				};
			}
			if (!state.goal?.taskList) throw new Error("Task list disappeared during task update.");
			const taskToUpdate = findTaskInTree(state.goal.taskList.tasks, params.task_id);
			if (!taskToUpdate) throw new Error(`Task ${params.task_id} not found.`);
			const settings = loadGoalSettings(ctx.cwd);
			const now = nowIso();

			if (params.status === "complete") {
				if (!settings.disableContracts && taskToUpdate.verificationContract && !params.evidence?.trim()) {
					return {
						content: [{ type: "text", text: `Task "${params.task_id}" has a verification contract; provide evidence to complete it.` }],
						details: goalDetails(state.goal),
					};
				}
				const subtaskGate = checkSubtasksComplete(taskToUpdate);
				if (subtaskGate) {
					return {
						content: [{ type: "text", text: subtaskGate }],
						details: goalDetails(state.goal),
					};
				}
				const evidence = params.evidence?.trim().slice(0, 200) || undefined;
				const updatedTasks = updateTaskInTree(state.goal.taskList.tasks, params.task_id, (t) => ({
					...t,
					status: "complete" as const,
					completedAt: now,
					evidence,
				}));
				const result = goalService.apply(ctx, {
					reconcile: false,
					refreshFromDisk: true,
					mutate: (g) => {
						if (!g.taskList) throw new Error("Task list disappeared during task update.");
						return { ...g, taskList: { ...g.taskList, tasks: updatedTasks }, updatedAt: now };
					},
					ledger: (written) => [{
						type: "task_complete",
						goalId: written.id,
						taskId: params.task_id,
						evidence,
						at: written.updatedAt,
					}],
				});
				if (!result.ok) {
					return { content: [{ type: "text", text: result.message }], details: goalDetails(state.goal) };
				}
				syncGoalTools();
				updateUI(ctx);
				return {
					content: [{ type: "text", text: `${params.task_id} complete. ${buildTaskSummary(state.goal.taskList!)}.` }],
					details: goalDetails(state.goal),
				};
			}

			if (params.status === "skipped") {
				const reason = params.reason?.trim();
				if (!reason) {
					return {
						content: [{ type: "text", text: "update_goal_task(status=skipped) requires a non-empty reason." }],
						details: goalDetails(state.goal),
					};
				}
				const skipGate = validateTaskSkip({ goal: state.goal, taskId: params.task_id, reason });
				if (!skipGate.ok) {
					return {
						content: [{ type: "text", text: skipGate.message }],
						details: goalDetails(state.goal),
					};
				}
				const updatedTasks = updateTaskInTree(state.goal.taskList.tasks, params.task_id, (t) => {
					const base = { ...t, status: "skipped" as const, skippedAt: now, skipReason: reason };
					if (t.subtasks && t.subtasks.length > 0 && !t.lightweightSubtasks) {
						return skipAllSubtasks(base, now, reason);
					}
					return base;
				});
				const result = goalService.apply(ctx, {
					reconcile: false,
					refreshFromDisk: true,
					mutate: (g) => {
						if (!g.taskList) throw new Error("Task list disappeared during task update.");
						return { ...g, taskList: { ...g.taskList, tasks: updatedTasks }, updatedAt: now };
					},
					ledger: (written) => [{
						type: "task_skipped",
						goalId: written.id,
						taskId: params.task_id,
						reason,
						at: written.updatedAt,
					}],
				});
				if (!result.ok) {
					return { content: [{ type: "text", text: result.message }], details: goalDetails(state.goal) };
				}
				syncGoalTools();
				updateUI(ctx);
				return {
					content: [{ type: "text", text: `${params.task_id} skipped. ${buildTaskSummary(state.goal.taskList!)}.` }],
					details: goalDetails(state.goal),
				};
			}

			// status === "pending": reopen a skipped task; completed tasks are immutable.
			if (taskToUpdate.status === "complete") {
				return {
					content: [{ type: "text", text: `Task "${params.task_id}" is complete and cannot be reopened through update_goal_task.` }],
					details: goalDetails(state.goal),
				};
			}
			if (taskToUpdate.status !== "skipped") {
				return {
					content: [{ type: "text", text: `Task "${params.task_id}" is not skipped; only skipped tasks can be reopened with status=pending.` }],
					details: goalDetails(state.goal),
				};
			}
			const updatedTasks = updateTaskInTree(state.goal.taskList.tasks, params.task_id, (t) => {
				const { skippedAt, skipReason, ...rest } = t;
				return { ...rest, status: "pending" as const };
			});
			const result = goalService.apply(ctx, {
				reconcile: false,
				refreshFromDisk: true,
				mutate: (g) => {
					if (!g.taskList) throw new Error("Task list disappeared during task update.");
					return { ...g, taskList: { ...g.taskList, tasks: updatedTasks }, updatedAt: now };
				},
				ledger: (written) => [{
					type: "task_skipped",
					goalId: written.id,
					taskId: params.task_id,
					reason: "unskipped (toggle via update_goal_task status=pending)",
					at: written.updatedAt,
				}],
			});
			if (!result.ok) {
				return { content: [{ type: "text", text: result.message }], details: goalDetails(state.goal) };
			}
			syncGoalTools();
			updateUI(ctx);
			return {
				content: [{ type: "text", text: `${params.task_id} reopened. ${buildTaskSummary(state.goal.taskList!)}.` }],
				details: goalDetails(state.goal),
			};
		},
		renderCall(args, theme) {
			return new Text(theme.fg("toolTitle", "update_goal_task ") + theme.fg("muted", `${args?.task_id ?? ""} ${args?.status ?? ""}`), 0, 0);
		},
		renderResult(result, _options, theme) {
			return renderGoalResult(result, theme);
		},
	}));

	pi.on("context", async (event): Promise<{ messages: typeof event.messages } | undefined> => {
		let changed = false;
		const latestGoalEventIndex = new Map<string, number>();
		event.messages.forEach((message, index) => {
			const queuedGoalId = goalEventMessageId(message as { customType?: string; details?: unknown; content?: unknown });
			if (queuedGoalId) latestGoalEventIndex.set(queuedGoalId, index);
		});

		const messages = event.messages.map((message, index) => {
			const candidate = message as { customType?: string; details?: unknown; content?: unknown };
			const queuedGoalId = goalEventMessageId(candidate);
			if (!queuedGoalId) return message;
			if (
				state.goal?.id === queuedGoalId
				&& (state.goal.status === "active")
				&& state.goal.autoContinue
				&& latestGoalEventIndex.get(queuedGoalId) === index
			) return message;
			changed = true;
			const details = asRecord(candidate.details) ?? {};
			return {
				...message,
				content: staleContinuationPrompt(queuedGoalId, state.goal),
				display: false,
				details: {
					...details,
					kind: "stale",
					goalId: queuedGoalId,
					currentGoalId: state.goal?.id ?? null,
					currentStatus: state.goal?.status ?? null,
				},
			} as typeof message;
		});
		return changed ? { messages } : undefined;
	});

	pi.on("turn_start", async (_event, ctx) => {
		// Per-turn flag resets (#4 + C9 fix).
		advanceTurnSeq();
		goalWorkToolCalledThisTurn = false;
		syncGoalTools();
		beginAccounting();
		updateUI(ctx);
	});

	// #4 + C9 fix + Phase 5 C3: gate in-turn tool calls based on lifecycle state.
	pi.on("tool_call", async (event, ctx) => {
		const stoppedGoalId = currentTurnStoppedGoalId();
		// Post-stop in-turn block (C9 0ad8 fix): after pause_goal / abort_goal /
		// complete_goal / propose_goal_tweak fires in this turn, block all subsequent tool calls except
		// read-only inspection. Forces the agent to yield the turn instead of "fixing"
		// the situation by creating extra files etc.
		if (stoppedGoalId !== null && runtime.isStaleCheckpointBlocked(event.toolName)) {
			return {
				block: true,
				reason: `The goal was already stopped earlier in this turn (goalId=${stoppedGoalId}). ` +
					`Do not call more tools; end the turn with a brief summary and yield to the user.`,
			};
		}
		// Stale checkpoint guard: if the turn was triggered by a queued continuation
		// for a goal that is no longer active/autoContinue, block work tools.
		const checkpointGoalId = runtime.getCheckpointGoalId();
		if (checkpointGoalId !== null && !isActionableContinuationGoal(checkpointGoalId) && isStaleCheckpointBlockedToolCall(event.toolName)) {
			// Block the tool call with a stale-checkpoint message.
			return {
				block: true,
				reason: `Cannot call ${event.toolName}: the goal checkpoint that triggered this turn is no longer active. ` +
					`Goal ${checkpointGoalId} has been paused, cleared, or replaced. ` +
					`End the turn with a brief summary and yield to the user.`,
			};
		}
		// Track for #4 empty-turn gate.
		if (isMeaningfulProgressToolCall(event.toolName, asRecord(event)?.args)) {
			goalWorkToolCalledThisTurn = true;
		}
		return;
	});

	pi.on("tool_execution_end", async (_event, ctx) => {
		accountProgress(ctx);
	});

	pi.on("turn_end", async (event, ctx) => {
		const message = event.message as AssistantMessageLike;
		if (confirmationIntent !== null || tweakDraftingFor !== null) return;
		const tokens = assistantTurnTokens(message);
		accountProgress(ctx, { completedTurnTokens: tokens });

		if (isAbortedAssistantMessage(message)) {
			pauseActiveGoal(ctx);
			return;
		}
		refreshGoalDisplayFromDisk(ctx);

		// Archive a goal that was marked complete by complete_goal but whose archival
		// was deferred so the agent could see/recognize the audit result first.
		// This runs after the agent's turn ends — the agent has now seen the result.
		if (state.goal?.status === "complete" && !state.goal?.archivedPath) {
			const completedGoal = state.goal;
			const archiveResult = goalService.apply(ctx, {
				reconcile: false,
				archive: true,
				commitFocused: false,
				mutate: () => completedGoal,
				ledger: (written) => [{
					type: "goal_completed",
					goalId: completedGoal.id,
					archivePath: written.archivedPath,
					at: nowIso(),
				}],
			});
			if (archiveResult.ok) {
				goalsById.delete(completedGoal.id);
				assignFocusedGoalId(null);
				appendFocusEntry(null, "completed");
			}
			syncGoalTools();
			updateUI(ctx);
		}

		// If the assistant ended a turn without queuing more tool calls, push a continuation right away.
		// #4: only queue if some real work was done this turn — otherwise the model is
		// just chatting and we should not keep firing turns on noise.
		if (
			!isToolUseAssistantMessage(message)
			&& state.goal?.status === "active"
			&& state.goal.autoContinue
			&& goalWorkToolCalledThisTurn
		) {
			queueContinuation(ctx);
		}
	});

	pi.on("message_end", async (event, ctx) => {
		if (isAbortedAssistantMessage(event.message)) pauseActiveGoal(ctx);
		const raw = asRecord(event.message);
		if (raw?.role === "custom" && raw.customType === GOAL_EVENT_ENTRY && raw.display !== false) {
			return { message: { ...event.message, display: false } as typeof event.message };
		}
	});

	pi.on("session_start", async (event, ctx) => {
		syncGoalTools();
		loadState(ctx);
		syncGoalTools();
		syncTerminalInputPause(ctx);
		if (event.reason === "resume" && !state.goal && !hasExplicitSessionFocus && openGoals().length > 1 && ctx.hasUI) {
			await focusGoalCommand(ctx);
		}
		// Codex behavior: prompt before reactivating a paused goal on resume.
		if (event.reason === "resume" && state.goal?.status === "paused" && ctx.hasUI) {
			const current = state.goal;
			const shouldResume = await ctx.ui.confirm("Resume paused goal?", `Goal: ${current.objective}`);
			if (shouldResume) {
				setGoal({ ...current, status: "active", autoContinue: true, stopReason: undefined, pauseReason: undefined, pauseSuggestedAction: undefined }, ctx);
			}
		}
		beginAccounting();
		queueContinuation(ctx, true);
	});

	pi.on("session_before_compact", async (_event, ctx) => {
		accountProgress(ctx);
	});

	pi.on("session_compact", async (_event, ctx) => {
		if (confirmationIntent !== null || tweakDraftingFor !== null) return;
		if (state.goal) persist(ctx);
		beginAccounting();
		// Arm a deterministic compaction summary for the next agent turn.
		// This replaces the generic reminder with artifact-backed state.
		if (shouldArmPostCompactReminder(state.goal)) {
			runtime.armPostCompactReminder();
		}
		queueContinuation(ctx, true);
	});

	pi.on("session_tree", async (_event, ctx) => {
		loadState(ctx);
		syncTerminalInputPause(ctx);
		beginAccounting();
		queueContinuation(ctx, true);
	});

	pi.on("before_agent_start", async (event, ctx) => {
		advanceTurnSeq();
		syncGoalTools();
		const currentSystemPrompt = () => ctx.getSystemPrompt?.() || event.systemPrompt;
		const incomingGoalId = extractGoalIdFromInjectedMessage(event.prompt ?? "");

		if (confirmationIntent !== null) {
			runtime.setCheckpoint(null);
			clearContinuationState();
			clearActiveAccounting();
			runningGoalId = null;
			return { systemPrompt: currentSystemPrompt() };
		}

		if (tweakDraftingFor !== null) {
			runtime.setCheckpoint(null);
			clearContinuationState();
			clearActiveAccounting();
			runningGoalId = null;
			return { systemPrompt: currentSystemPrompt() };
		}

		// If this turn was triggered by a hidden goal checkpoint that no longer
		// matches the active goal, abort the whole turn instead of letting the
		// model act on a stale instruction.
		if (incomingGoalId !== null) {
			// Reconcile from disk to pick up any external state changes before
			// evaluating whether the checkpoint is actionable.
			reconcileFocusedGoalFromDisk(ctx);
			runtime.setCheckpoint(incomingGoalId);
			clearContinuationState();
			if (!isActionableContinuationGoal(incomingGoalId)) {
				try {
					ctx.abort?.();
				} catch {}
				updateUI(ctx);
				return {
					systemPrompt: `${currentSystemPrompt()}\n\n${staleContinuationPrompt(incomingGoalId, state.goal)}`,
				};
			}
			runtime.setCheckpoint(null);
		} else {
			// A user-driven turn — clear any queued continuation so we don't
			// double-fire after the user's own message returns. Also reset the
			// autoContinue nudge state so the user always gets a fresh chain.
			runtime.setCheckpoint(null);
			clearContinuationState();
		}

		if (!state.goal) {
			runningGoalId = null;
			const openCount = openGoals().length;
			if (openCount > 0) {
				return { systemPrompt: `${currentSystemPrompt()}\n\n${unfocusedOpenGoalsPrompt(openCount)}` };
			}
			return;
		}
		reconcileFocusedGoalFromDisk(ctx);
		if (!state.goal) {
			runningGoalId = null;
			const openCount = openGoals().length;
			if (openCount > 0) return { systemPrompt: `${currentSystemPrompt()}\n\n${unfocusedOpenGoalsPrompt(openCount)}` };
			return;
		}
		runningGoalId = state.goal.status === "active" ? state.goal.id : null;
		if (state.goal.status === "complete") return;
		if (state.goal.status === "paused") {
			const current = state.goal;
			const pauseExtras: string[] = [];
			if (current.stopReason === "agent") {
				pauseExtras.push("");
				pauseExtras.push(`Pause reason (you set this in a prior turn via pause_goal): ${current.pauseReason ?? "(unknown)"}`);
				if (current.pauseSuggestedAction) pauseExtras.push(`You suggested: ${current.pauseSuggestedAction}`);
			}
			// Inject durable auditor feedback if available
			let auditorExtra = "";
			try {
				const ledger = readGoalLedger(ctx);
				const auditorResult = latestAuditorResultForGoal(ledger.events, current.id);
				if (auditorResult && auditorResult.verdict === "disapproved") {
					auditorExtra = `\n\n[AUDITOR REJECTION] An independent auditor previously rejected a completion request for this goal. Reason: ${auditorResult.report.slice(0, 300)}\nAddress the auditor's objections before requesting completion again.`;
				}
			} catch {
				// Ledger read failure should not break the prompt
			}
			return {
				systemPrompt: `${currentSystemPrompt()}\n\n[PI GOAL PAUSED goalId=${current.id}]\n${untrustedObjectiveBlock(current)}${pauseExtras.join("\n")}${auditorExtra}\n\nThe goal is paused. Do not autonomously continue substantive work unless the user resumes it with /goal-resume. If the user explicitly asks to finish or abandon the paused goal, or the objective is already satisfied based on available evidence, you may call complete_goal or abort_goal without resuming. Do not call pause_goal again.`,
			};
		}
		// Token-budget-limited goals get one-time wrap-up steering: summarize,
		// do not start new substantive work, never claim completion unless real.
		if (state.goal?.status === "budget_limited") {
			const limitedGoal = state.goal;
			const budgetText = budgetLine(limitedGoal);
			const reminder = runtime.consumePostBudgetReminder()
				? `\n\n[TOKEN BUDGET REACHED goalId=${limitedGoal.id}]\nThe goal's token budget has been reached${budgetText ? ` (${budgetText})` : ""}. Wrap up the current work in one final response: summarize what was accomplished and what remains, do not start new substantive work, and do not claim the goal is complete unless it actually is. To continue, the user must raise or remove the budget and resume the goal.`
				: "";
			return {
				systemPrompt: `${currentSystemPrompt()}\n\n[PI GOAL BUDGET LIMITED goalId=${limitedGoal.id}]\n${untrustedObjectiveBlock(limitedGoal)}${budgetText ? `\n${budgetText}` : ""}${reminder}`,
			};
		}
		const activeGoal = state.goal;
		const settings = loadGoalSettings(ctx.cwd);
		let prompt = goalPrompt(activeGoal, settings);
		// Inject durable auditor feedback if the latest result was a rejection
		try {
			const ledger = readGoalLedger(ctx);
			const auditorResult = latestAuditorResultForGoal(ledger.events, activeGoal.id);
			if (auditorResult && auditorResult.verdict === "disapproved" && ledger.events.some((e) => e.type === "completion_requested" && e.goalId === activeGoal.id)) {
				prompt = `${prompt}\n\n[AUDITOR REJECTION goalId=${activeGoal.id}]\nAn independent auditor previously rejected a completion request for this goal. Reason: ${auditorResult.report.slice(0, 300)}\nAddress the auditor's objections before requesting completion again.`;
			}
		} catch {
			// Ledger read failure should not break the prompt
		}
		if (runtime.isPostCompactReminderPending() && shouldInjectPostCompactReminder({ pending: true, goal: activeGoal })) {
			runtime.clearPostCompactReminder();
			// Use deterministic compaction summary instead of generic reminder
			try {
				const ledger = readGoalLedger(ctx);
				const compaction = buildCompactionSummary({ goalsById, focusedGoalId, ledgerEvents: ledger.events });
				prompt = `${prompt}\n\n[POST-COMPACTION RESYNC goalId=${activeGoal.id}]\n${compaction}`;
			} catch {
				prompt = `${prompt}\n\n[POST-COMPACTION RESYNC goalId=${state.goal.id}]\nThe conversation was just compacted. Re-read the objective and continue from the actual artifacts/state; do not rely on memory of the prior chat.`;
			}
		}
		return { systemPrompt: `${currentSystemPrompt()}\n\n${prompt}` };
	});

	pi.on("agent_end", async (event, ctx) => {
		if (confirmationIntent !== null || tweakDraftingFor !== null) return;
		const endedGoalId = runningGoalId;
		runningGoalId = null;

		// Account for any tokens from aborted in-flight assistant messages so
		// they are not silently lost (but charge them to the original goal).
		const abortedTokens = event.messages
			.filter(isAbortedAssistantMessage)
			.reduce((sum, message) => sum + assistantTurnTokens(message), 0);
		if (abortedTokens > 0 && endedGoalId && state.goal?.id === endedGoalId) {
			accountProgress(ctx, { completedTurnTokens: abortedTokens });
		}

		runtime.clearContinuationState();
		if (!state.goal || state.goal.status !== "active" || !state.goal.autoContinue) return;
		if (endedGoalId && state.goal.id !== endedGoalId) return;
		if (!reconcileFocusedGoalFromDisk(ctx)) return;
		if (hasAbortedAssistantMessage(event.messages) || ctx.signal?.aborted) {
			pauseActiveGoal(ctx);
			return;
		}
		persist(ctx);
		updateUI(ctx);
		queueContinuation(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		accountProgress(ctx);
		clearContinuationTimer();
		terminalInputUnsubscribe?.();
		terminalInputUnsubscribe = null;
		if (state.goal) persist(ctx);
	});
}
