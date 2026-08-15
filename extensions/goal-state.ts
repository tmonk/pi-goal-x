import { type AgentToolResult, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { FOCUS_ENTRY, STATE_ENTRY, GOAL_EVENT_ENTRY, goalDetails } from "./goal-format.ts";
import { loadGoalSettings, loadGoalSettingsFileConfig } from "./goal-settings.ts";
import {
	ALL_REGISTERED_GOAL_TOOLS,
	CORE_GOAL_TOOLS,
	DRAFTING_GOAL_TOOLS,
	FIVE_GOAL_TOOLS,
} from "./goal-tool-names.ts";
import { budgetReached } from "./goal-accounting.ts";
import {
	asRecord,
	cloneGoal,
	createGoal,
	goalFocusDetails,
	normalizeGoalFocusEntry,
	normalizeGoalRecord,
	nowIso,
	type GoalCreationConfig,
	type GoalEventDetails,
	type GoalFocusEntry,
	type GoalFocusReason,
	type GoalRecord,
	type GoalStatus,
	type StopReason,
} from "./goal-record.ts";
import {
	mergeGoalPromptFromDisk,
	readActiveGoalPoolAsync,
	sanitizeGoalPaths,
} from "./storage/goal-files.ts";
import { GoalService } from "./goal-service.ts";
import { readGoalLedger } from "./goal-ledger.ts";
import { GoalAccounting } from "./goal-accounting.ts";
import { GoalRuntime } from "./goal-runtime.ts";
import {
	focusedGoalFromPool,
	openGoalsFromPool,
	otherOpenGoalCount,
	resolveSessionFocus,
} from "./goal-pool.ts";
import { buildGoalRunningNotification } from "./widgets/goal-notifications.ts";
import { GOAL_WIDGET_KEY, GoalWidgetComponent, liveDisplayGoal, makeGoalWidgetFactory, type AuditorWidgetProgress } from "./widgets/goal-widget.ts";
import type { AuditVerdict } from "./widgets/auditor-dashboard-model.ts";
import { runGoalCompletionAuditor } from "./goal-auditor.ts";



/**
 * The shared mutable core of the goal extension. All state lives here; the
 * tools/commands/events/widget modules receive this core and operate on it.
 * `state.goal` mirrors the old `state` object: reading returns the focused
 * goal, assigning replaces it in the pool and updates the focus.
 */
export interface GoalCore {
	pi: ExtensionAPI;
	dependencies: { runCompletionAuditor?: typeof runGoalCompletionAuditor };
	state: { goal: GoalRecord | null };
	readonly goalsById: Map<string, GoalRecord>;
	readonly focusedGoalId: string | null;
	readonly focusRevision: number;
	hasExplicitSessionFocus: boolean;
	runningGoalId: string | null;
	auditProgress: AuditorWidgetProgress | null;
	auditAnimationTimer: ReturnType<typeof setInterval> | null;
	auditAbortController: AbortController | null;
	/** §15.4: finished audit result card shown briefly before the dashboard returns. */
	auditResult: { verdict: AuditVerdict; report: string; at: string } | null;
	setAuditResult(verdict: AuditVerdict, report: string): void;
	clearAuditResult(): void;
	goalModalDepth: number;
	enterGoalModal(): void;
	exitGoalModal(): void;
	auditAborted: boolean;
	goalWorkToolCalledThisTurn: boolean;
	tasksEnabled: boolean;
	debugMode: boolean;
	terminalInputUnsubscribe: (() => void) | null;
	goalWidgetComponentRef: { current: GoalWidgetComponent | null };
	goalService: GoalService;
	runtime: GoalRuntime;
	accounting: GoalAccounting;

	assignFocusedGoalId(goalId: string | null): void;
	focusedOperationToken(goalId: string): { goalId: string; revision: number };
	isFocusedOperationCurrent(token: { goalId: string; revision: number }): boolean;
	focusedOperationCancelledResult(action: string, token: { goalId: string; revision: number }): AgentToolResult<unknown>;
	installGoalToolProfile(tasksEnabled: boolean): void;
	installDraftingToolProfile(): void;
	stopAuditAnimation(): void;
	abortAudit(ctx: ExtensionContext): void;
	clearContinuationTimer(): void;
	clearContinuationState(): void;
	clearActiveAccounting(): void;
	advanceTurnSeq(): void;
	currentTurnStoppedGoalId(): string | null;
	isActionableContinuationGoal(goalId: string | null | undefined): goalId is string;
	isStaleCheckpointBlockedToolCall(toolName: string): boolean;
	clearStoppedRuntimeState(): void;
	openGoals(): GoalRecord[];
	/** §10: toggle the unified dashboard between compact and expanded modes. */
	toggleDashboardExpanded(): void;
	/** §10: whether the unified dashboard is currently expanded. */
	isDashboardExpanded(): boolean;
	reconcileFocusedGoalFromDisk(ctx: ExtensionContext, opts?: { preserveMemoryUsage?: boolean }): boolean;
	appendFocusEntry(goalId: string | null, reason: GoalFocusReason): void;
	setFocusedGoalId(goalId: string | null, ctx: ExtensionContext, reason: GoalFocusReason, opts?: { recordLedger?: boolean }): void;
	updateFocusedGoal(next: GoalRecord, ctx: ExtensionContext, shouldPersist?: boolean): void;
	armFocusedContinuation(ctx: ExtensionContext): void;
	removeFocusedGoal(ctx: ExtensionContext, reason: GoalFocusReason): void;
	beginAccounting(): void;
	goalForDisplay(): GoalRecord | null;
	accountProgress(ctx: ExtensionContext, opts?: { completedTurnTokens?: number }): void;
	syncGoalPromptFromDisk(ctx: ExtensionContext): boolean;
	persist(ctx?: ExtensionContext): void;
	refreshGoalDisplayFromDisk(ctx: ExtensionContext): void;
	updateUI(ctx: ExtensionContext): void;
	clearGoalWidget(ctx: ExtensionContext): void;
	loadState(ctx: ExtensionContext): Promise<void>;
	setGoal(next: GoalRecord | null, ctx: ExtensionContext, shouldPersist?: boolean, focusReason?: GoalFocusReason): void;
	archiveCurrentGoal(ctx: ExtensionContext, reason: StopReason | undefined): GoalRecord | null;
	stopActiveGoal(status: Exclude<GoalStatus, "active">, reason: StopReason | undefined, ctx: ExtensionContext): void;
	pauseActiveGoal(ctx: ExtensionContext): void;
	/** §auditor-toggle: flip the focused goal's persisted per-goal skipAuditor and record the ledger event. */
	toggleGoalAuditor(ctx: ExtensionContext): void;
	queueContinuation(ctx: ExtensionContext, force?: boolean): void;
	flushGoalTransaction(ctx: ExtensionContext): void;
	replaceGoal(config: GoalCreationConfig, ctx: ExtensionContext, startNow?: boolean, verificationContract?: string, tokenBudget?: number): void;
	/** F5: bump the last-activity timestamp (called on real work events). */
	touchGoalActivity(): void;
	/** F5: detect a stalled active auto-continue goal; returns the [GOAL STALLED] steering note. */
	checkStall(ctx: ExtensionContext): string;
}

export function createGoalCore(
	pi: ExtensionAPI,
	dependencies: { runCompletionAuditor?: typeof runGoalCompletionAuditor } = {},
): GoalCore {
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
	 * service; handlers keep validation and runtime/UI effects.
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
		onDiagnostic: (diagnostic) => {
			// Non-fatal failure sink: ledger appends must never roll back the
			// authoritative state write, but they stay observable.
			console.warn(`[pi-goal] ${diagnostic.source} diagnostic: ${diagnostic.message}`);
		},
	});
	let runningGoalId: string | null = null;
	let terminalInputUnsubscribe: (() => void) | null = null;
	let auditProgress: AuditorWidgetProgress | null = null;
	let auditAnimationTimer: ReturnType<typeof setInterval> | null = null;
	let auditResult: { verdict: AuditVerdict; report: string; at: string } | null = null;
	let auditResultClearTimer: ReturnType<typeof setTimeout> | null = null;

	function setAuditResult(verdict: AuditVerdict, report: string): void {
		auditResult = { verdict, report, at: nowIso() };
		if (auditResultClearTimer) clearTimeout(auditResultClearTimer);
		// Short-lived foreground display (§2.5): the card is visible while the
		// user reads it, then the normal dashboard returns automatically.
		auditResultClearTimer = setTimeout(() => {
			auditResult = null;
			auditResultClearTimer = null;
			goalWidgetComponentRef.current?.invalidate();
		}, 6000);
		auditResultClearTimer.unref?.();
		goalWidgetComponentRef.current?.invalidate();
	}

	function clearAuditResult(): void {
		if (auditResultClearTimer) clearTimeout(auditResultClearTimer);
		auditResultClearTimer = null;
		auditResult = null;
	}
	let auditAbortController: AbortController | null = null;
	let auditAborted = false;

	let goalModalDepth = 0;
	let debugMode = false;
	// §10: unified dashboard expansion state (compact vs expanded task view),
	// owned by the core so it survives host-side widget re-instantiation.
	let dashboardExpanded = false;

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
	});
	const accounting = new GoalAccounting();

	// Whether the task tools are advertised, decided once at session start from
	// settings (disableTasks). Stage 4 replaces them with the two task tools.
	let tasksEnabled = true;

	// Transient runtime state: set when the user aborts a running audit via
	// Escape. No ledger event is appended from the low-level abort callback;
	// the completion flow appends exactly one canonical event after the
	// user's dialog choice (follow-up Stage 2).

	/**
	 * Install the fixed three/five goal-tool profile. Called only after session
	 * initialization and after a settings change that toggles disableTasks.
	 * Lifecycle transitions, focus changes, status changes, and compaction never
	 * add/remove/restore goal tools, and this never mutates the host's ordinary
	 * work-tool selection. On success the module-level tasksEnabled tracker is
	 * updated to the installed value, so callers can compare the effective
	 * setting against the last profile actually installed (used by the settings
	 * menu to detect repeated disableTasks toggles across one menu session).
	 */
	function installGoalToolProfile(tasksEnabledArg: boolean): void {
		try {
			const current = new Set(pi.getActiveTools());
			for (const knownGoalTool of ALL_REGISTERED_GOAL_TOOLS) current.delete(knownGoalTool);
			for (const goalTool of tasksEnabledArg ? FIVE_GOAL_TOOLS : CORE_GOAL_TOOLS) current.add(goalTool);
			const next = [...current].sort();
			const before = [...pi.getActiveTools()].sort();
			// Idempotent: never rebuild (or re-report) a profile that is already
			// installed. Lifecycle transitions must not churn the tool surface.
			if (next.length !== before.length || next.some((name, index) => name !== before[index])) {
				pi.setActiveTools([...current]);
			}
			tasksEnabled = tasksEnabledArg;
		} catch (err) {
			console.error("[pi-goal] installGoalToolProfile error:", err instanceof Error ? err.message : String(err));
		}
	}

	/**
	 * Install the transient drafting profile. This is the sole permitted
	 * exception to the fixed execution three/five profile: it is entered only
	 * by an explicit user drafting command and is removed on confirm/cancel.
	 */
	function installDraftingToolProfile(): void {
		try {
			const current = new Set(pi.getActiveTools());
			for (const knownGoalTool of ALL_REGISTERED_GOAL_TOOLS) current.delete(knownGoalTool);
			for (const goalTool of DRAFTING_GOAL_TOOLS) current.add(goalTool);
			const next = [...current].sort();
			const before = [...pi.getActiveTools()].sort();
			if (next.length !== before.length || next.some((name, index) => name !== before[index])) {
				pi.setActiveTools([...current]);
			}
		} catch (err) {
			console.error("[pi-goal] installDraftingToolProfile error:", err instanceof Error ? err.message : String(err));
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
		auditAbortController.abort();
		auditAbortController = null;
		stopAuditAnimation();
		auditProgress = null;
		goalWidgetComponentRef.current?.invalidate();
		// Record the abort as transient runtime state only; the completion flow
		// decides the single canonical ledger outcome after the dialog choice.
		auditAborted = true;
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
		if (previousGoalId !== goalId) goalService.flushTurn(ctx); // P1-3: persist the old buffer before switching focus
		assignFocusedGoalId(goalId && goalsById.has(goalId) ? goalId : null);
		if (previousGoalId !== focusedGoalId) {
			clearContinuationState();
			clearActiveAccounting();
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
		updateUI(ctx);
	}

	function updateFocusedGoal(next: GoalRecord, ctx: ExtensionContext, shouldPersist = true): void {
		goalsById.set(next.id, next);
		assignFocusedGoalId(next.id);
		if (shouldPersist) persist(ctx);
		updateUI(ctx);
	}

	function armFocusedContinuation(ctx: ExtensionContext): void {
		beginAccounting();
		if (state.goal?.status === "active" && state.goal.autoContinue) queueContinuation(ctx, true);
	}

	function removeFocusedGoal(ctx: ExtensionContext, reason: GoalFocusReason): void {
		goalService.flushTurn(ctx); // P1-3: persist pending mutations before the goal leaves the session
		if (focusedGoalId) goalsById.delete(focusedGoalId);
		assignFocusedGoalId(null);
		clearStoppedRuntimeState();
		appendFocusEntry(null, reason);
		updateUI(ctx);
	}

	function beginAccounting(): void {
		if (!state.goal || (state.goal.status !== "active")) {
			clearActiveAccounting();
			return;
		}
		accounting.begin(state.goal.id);
	}

	function goalForDisplay(): GoalRecord | null {
		// P1-12: extracted live-usage view.
		return liveDisplayGoal(state.goal, accounting);
	}

	function accountProgress(ctx: ExtensionContext, opts: { completedTurnTokens?: number } = {}): void {
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

		// F6: threshold alerts at 50/75/90% — one ledger event + notification each.
		const budgetGoal = state.goal;
		if (budgetGoal && budgetGoal.status === "active" && typeof budgetGoal.tokenBudget === "number" && budgetGoal.tokenBudget > 0 && budgetGoal.usage.tokensUsed > 0) {
			const pct = budgetGoal.usage.tokensUsed / budgetGoal.tokenBudget;
			for (const threshold of [0.5, 0.75, 0.9]) {
				const key = `${budgetGoal.id}:${threshold}`;
				if (!budgetWarningsFired.has(key) && pct >= threshold) {
					budgetWarningsFired.add(key);
					try {
						goalService.appendEvents(ctx, [{
							type: "goal_budget_warning",
							goalId: budgetGoal.id,
							budget: budgetGoal.tokenBudget,
							tokensUsed: budgetGoal.usage.tokensUsed,
							pct: Math.round(pct * 100),
							at: nowIso(),
						}]);
					} catch {
						// Alert must never crash the turn.
					}
					ctx.ui.notify(`Token budget ${Math.round(pct * 100)}% used (${budgetGoal.usage.tokensUsed}/${budgetGoal.tokenBudget} tokens) — consider raising or trimming scope before the limit.`, "warning");
				}
			}
		}

		// Token-budget transition: when accounted usage reaches the budget, mark the
		// goal budget_limited exactly once (status no longer active, so accounting
		// stops and the transition cannot re-fire), emit the ledger event, arm the
		// one-time wrap-up steering, and cancel pending continuations.
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
		if (ctx) updateUI(ctx);
	}

	function refreshGoalDisplayFromDisk(ctx: ExtensionContext): void {
		if (!state.goal || state.goal.status === "complete") return;
		if (syncGoalPromptFromDisk(ctx)) {
			state.goal = { ...state.goal, updatedAt: nowIso() };
		}
		updateUI(ctx);
	}

	const goalWidgetComponentRef: { current: GoalWidgetComponent | null } = { current: null };
	let widgetRegistered = false;

	function clearGoalWidget(ctx: ExtensionContext): void {
		ctx.ui.setStatus("goal", undefined);
		ctx.ui.setWidget(GOAL_WIDGET_KEY, undefined);
		widgetRegistered = false;
		goalWidgetComponentRef.current = null;
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

	let lastGoalActivityAt = Date.now();
	let stallNotified = false;
	const budgetWarningsFired = new Set<string>(); // "goalId:threshold"

	function touchGoalActivity(): void {
		lastGoalActivityAt = Date.now();
		stallNotified = false;
	}

	function checkStall(ctx: ExtensionContext): string {
		if (!state.goal || state.goal.status !== "active" || !state.goal.autoContinue) return "";
		const timeoutMinutes = loadGoalSettings(ctx.cwd).stallTimeoutMinutes ?? 0;
		if (timeoutMinutes <= 0 || stallNotified) return "";
		const idleMs = Date.now() - lastGoalActivityAt;
		if (idleMs < timeoutMinutes * 60_000) return "";
		stallNotified = true;
		const goalId = state.goal.id;
		try {
			goalService.appendEvents(ctx, [{
				type: "goal_stalled",
				goalId,
				reason: `No continuation or tool activity for ${timeoutMinutes} minute${timeoutMinutes === 1 ? "" : "s"}.`,
				at: nowIso(),
			}]);
		} catch {
			// Stall detection must never crash the turn.
		}
		ctx.ui.notify(`Goal stalled: no activity for ${timeoutMinutes} minute${timeoutMinutes === 1 ? "" : "s"}.`, "warning");
		return `\n\n[GOAL STALLED goalId=${goalId}]\nNo continuation or tool activity for ${timeoutMinutes} minute${timeoutMinutes === 1 ? "" : "s"}. Report your progress or ask the user to pause or resume the goal.`;
	}

	let uiFlushScheduled = false;
	let lastUiCtx: ExtensionContext | null = null;

	/**
	 * P1-9: coalesced widget updates. Multiple updateUI calls within one
	 * synchronous block (a tool handler typically calls it 2–4 times) collapse
	 * into a single microtask render; the final turn_end render still shows the
	 * latest state. The render itself reads live state at flush time.
	 */
	function updateUI(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		lastUiCtx = ctx;
		if (uiFlushScheduled) return;
		uiFlushScheduled = true;
		queueMicrotask(() => {
			uiFlushScheduled = false;
			if (lastUiCtx) renderUI(lastUiCtx);
		});
	}

	function renderUI(ctx: ExtensionContext): void {
		const totalOpen = openGoals().length;
		if (!state.goal && totalOpen === 0) {
			clearGoalWidget(ctx);
			return;
		}
		if (!state.goal) {
			// Optional quiet mode: with hideUnfocusedBanner the unfocused
			// widget + status hint are suppressed entirely while open goals
			// exist, so a session that never focuses stays silent. The
			// banner returns as soon as the setting is turned off again or
			// a goal is focused (both re-enter renderUI via updateUI).
			if (loadGoalSettings(ctx.cwd).hideUnfocusedBanner === true) {
				clearGoalWidget(ctx);
				return;
			}
			ctx.ui.setStatus("goal", `goal: unfocused [${totalOpen} open] - /goal-focus`);
			if (!widgetRegistered) {
				ctx.ui.setWidget(
					GOAL_WIDGET_KEY,
					makeGoalWidgetFactory({
						getGoal: () => goalForDisplay() ?? state.goal,
						getOpenGoalCount: () => openGoals().length,
						getAuditorProgress: () => auditProgress,
						getSettings: () => loadGoalSettings(ctx.cwd),
						getDebugMode: () => debugMode,
						getStalled: () => stallNotified,
						getExpanded: () => dashboardExpanded,
						getLedgerEvents: () => readGoalLedger(ctx).events,
						getAuditResult: () => auditResult,
					}),
					{ placement: "aboveEditor" },
				);
				widgetRegistered = true;
			} else {
				goalWidgetComponentRef.current?.update();
			}
			return;
		}

		// The goal widget is the single home for goal status: the status line
		// lives in the compact/expanded dashboard (goal: <label> [<usage>]
		// (+N open)), so the focused-goal footer segment is cleared — a stale
		// unfocused hint or earlier status must not linger once a goal is
		// focused. The unfocused branch above still sets its own hint.
		ctx.ui.setStatus("goal", undefined);

		if (!widgetRegistered) {
			ctx.ui.setWidget(
				GOAL_WIDGET_KEY,
				makeGoalWidgetFactory({
					getGoal: () => goalForDisplay() ?? state.goal,
					getOpenGoalCount: () => openGoals().length,
					getAuditorProgress: () => auditProgress,
					getSettings: () => loadGoalSettings(ctx.cwd),
					getDebugMode: () => debugMode,
					getStalled: () => stallNotified,
					getExpanded: () => dashboardExpanded,
					getLedgerEvents: () => readGoalLedger(ctx).events,
					getAuditResult: () => auditResult,
				}),
				{ placement: "aboveEditor" },
			);
			widgetRegistered = true;
		} else {
			goalWidgetComponentRef.current?.update();
		}
	}

	async function loadState(ctx: ExtensionContext): Promise<void> {
		goalsById = await readActiveGoalPoolAsync(ctx);
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
		if (shouldPersist) persist(ctx);
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
			goalService.flushTurn(ctx); // P1-3: user-visible status change persists now, not at turn end
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

	/**
	 * §auditor-toggle: flip the focused goal's independent-auditor setting.
	 * Persisted per-goal (revision-safe via goalService.apply), recorded as an
	 * auditor_toggled ledger event, reflected in the dashboard, and announced.
	 * Inert when no goal is focused or the goal is complete; the widget's
	 * modal-depth guard keeps it inert while a goal modal is open.
	 */
	function toggleGoalAuditor(ctx: ExtensionContext): void {
		if (!state.goal) {
			ctx.ui.notify("No focused goal to toggle the auditor for.", "info");
			return;
		}
		if (state.goal.status === "complete") {
			ctx.ui.notify("This goal is complete; the auditor no longer applies.", "info");
			return;
		}
		const nextEnabled = state.goal.skipAuditor === true;
		const result = goalService.apply(ctx, {
			reconcile: false,
			refreshFromDisk: true,
			mutate: (g) => ({ ...g, skipAuditor: g.skipAuditor === true ? undefined : true, updatedAt: nowIso() }),
			ledger: (written) => [{ type: "auditor_toggled" as const, goalId: written.id, enabled: nextEnabled, at: written.updatedAt }],
		});
		if (!result.ok) {
			ctx.ui.notify("Could not toggle the auditor: " + result.message, "error");
			return;
		}
		goalService.flushTurn(ctx); // P1-3: user-visible setting change persists now, not at turn end
		updateUI(ctx);
		ctx.ui.notify(nextEnabled ? "Auditor enabled for this goal." : "Auditor disabled for this goal.", "info");
	}

	function flushGoalTransaction(ctx: ExtensionContext): void {
		goalService.flushTurn(ctx);
	}

	function queueContinuation(ctx: ExtensionContext, force = false): void {
		if (!state.goal) return;
		runtime.queueContinuation(ctx, state.goal, force);
	}

	function enterGoalModal(): void {
		goalModalDepth++;
	}

	function exitGoalModal(): void {
		goalModalDepth = Math.max(0, goalModalDepth - 1);
	}

	function replaceGoal(config: GoalCreationConfig, ctx: ExtensionContext, startNow = true, verificationContract?: string, tokenBudget?: number): void {
		const goal = createGoal(config);
		if (verificationContract) goal.verificationContract = verificationContract;
		if (config.taskList) goal.taskList = config.taskList;
		if (typeof tokenBudget === "number" && tokenBudget > 0) goal.tokenBudget = Math.floor(tokenBudget);
		const result = goalService.create(ctx, {
			goal,
		ledger: [
			{
				type: "goal_created",
				goalId: goal.id,
				objective: goal.objective,
				sisyphus: goal.sisyphus,
				autoContinue: goal.autoContinue,
				at: goal.createdAt,
			},
			...(goal.taskList ? [{
				type: "task_list_set" as const,
				goalId: goal.id,
				taskCount: goal.taskList.tasks.length,
				blockCompletion: goal.taskList.blockCompletion,
				at: goal.createdAt,
			}] : []),
		],
		});
		if (result.focusChanged) appendFocusEntry(result.goalId, "created");
		beginAccounting();
		ctx.ui.notify(buildGoalRunningNotification(config), "info");
		if (startNow && state.goal?.autoContinue) queueContinuation(ctx, true);
	}

	return {
		pi,
		dependencies,
		state,
		get goalsById() {
			return goalsById;
		},
		get focusedGoalId() {
			return focusedGoalId;
		},
		get focusRevision() {
			return focusRevision;
		},
		get hasExplicitSessionFocus() {
			return hasExplicitSessionFocus;
		},
		set hasExplicitSessionFocus(value: boolean) {
			hasExplicitSessionFocus = value;
		},
		get runningGoalId() {
			return runningGoalId;
		},
		set runningGoalId(value: string | null) {
			runningGoalId = value;
		},
		get auditProgress() {
			return auditProgress;
		},
		set auditProgress(value: AuditorWidgetProgress | null) {
			auditProgress = value;
		},
		get auditResult() {
			return auditResult;
		},
		set auditResult(value: { verdict: AuditVerdict; report: string; at: string } | null) {
			auditResult = value;
		},
		setAuditResult,
		clearAuditResult,
		get auditAnimationTimer() {
			return auditAnimationTimer;
		},
		set auditAnimationTimer(value: ReturnType<typeof setInterval> | null) {
			auditAnimationTimer = value;
		},
		get auditAbortController() {
			return auditAbortController;
		},
		set auditAbortController(value: AbortController | null) {
			auditAbortController = value;
		},
		get goalModalDepth() {
			return goalModalDepth;
		},
		set goalModalDepth(value: number) {
			goalModalDepth = value;
		},
		get auditAborted() {
			return auditAborted;
		},
		set auditAborted(value: boolean) {
			auditAborted = value;
		},
		get goalWorkToolCalledThisTurn() {
			return goalWorkToolCalledThisTurn;
		},
		set goalWorkToolCalledThisTurn(value: boolean) {
			goalWorkToolCalledThisTurn = value;
		},
		get tasksEnabled() {
			return tasksEnabled;
		},
		set tasksEnabled(value: boolean) {
			tasksEnabled = value;
		},
		get debugMode() {
			return debugMode;
		},
		set debugMode(value: boolean) {
			debugMode = value;
		},
		get terminalInputUnsubscribe() {
			return terminalInputUnsubscribe;
		},
		set terminalInputUnsubscribe(value: (() => void) | null) {
			terminalInputUnsubscribe = value;
		},
		toggleDashboardExpanded() {
			dashboardExpanded = !dashboardExpanded;
			goalWidgetComponentRef.current?.invalidate();
		},
		isDashboardExpanded() {
			return dashboardExpanded;
		},
		goalWidgetComponentRef,
		goalService,
		runtime,
		accounting,
		assignFocusedGoalId,
		focusedOperationToken,
		isFocusedOperationCurrent,
		focusedOperationCancelledResult,
		installGoalToolProfile,
		installDraftingToolProfile,
		stopAuditAnimation,
		abortAudit,
		clearContinuationTimer,
		clearContinuationState,
		clearActiveAccounting,
		advanceTurnSeq,
		currentTurnStoppedGoalId,
		isActionableContinuationGoal,
		isStaleCheckpointBlockedToolCall,
		clearStoppedRuntimeState,
		enterGoalModal,
		exitGoalModal,
		openGoals,
		reconcileFocusedGoalFromDisk,
		appendFocusEntry,
		setFocusedGoalId,
		updateFocusedGoal,
		armFocusedContinuation,
		removeFocusedGoal,
		beginAccounting,
		goalForDisplay,
		accountProgress,
		syncGoalPromptFromDisk,
		persist,
		refreshGoalDisplayFromDisk,
		updateUI,
		clearGoalWidget,
		loadState,
		setGoal,
		archiveCurrentGoal,
		stopActiveGoal,
		pauseActiveGoal,
		toggleGoalAuditor,
		queueContinuation,
		flushGoalTransaction,
		touchGoalActivity,
		checkStall,
		replaceGoal,
	};
}
