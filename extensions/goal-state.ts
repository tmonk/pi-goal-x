import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { GoalAccounting } from "./goal-accounting.ts";
import type { runGoalCompletionAuditor } from "./goal-auditor.ts";
import type { GoalCommandId, GoalCommands } from "./goal-controls.ts";
import { GoalFocus } from "./goal-focus.ts";
import { GOAL_EVENT_ENTRY } from "./goal-format.ts";
import { GoalInterruption } from "./goal-interruption.ts";
import { GoalLifecycle } from "./goal-lifecycle.ts";
import { GoalProgress } from "./goal-progress.ts";
import type {
	GoalCreationConfig,
	GoalEventDetails,
	GoalFocusReason,
	GoalRecord,
	GoalStatus,
	StopReason,
} from "./goal-record.ts";
import { GoalRuntime } from "./goal-runtime.ts";
import { GoalScheduler } from "./goal-scheduler.ts";
import { GoalService } from "./goal-service.ts";
import { GoalAuditMessages } from "./goal-session-safety.ts";
import { GoalSessionState, type ActiveGoalAudit } from "./goal-session-state.ts";
import { ALL_REGISTERED_GOAL_TOOLS, applicableGoalTools } from "./goal-tool-names.ts";
import { GoalView, type AuditResultCard } from "./goal-view.ts";
import { GoalWatch } from "./goal-watch.ts";
import type { AuditVerdict } from "./widgets/auditor-dashboard-model.ts";
import type { AuditorWidgetProgress, GoalWidgetComponent } from "./widgets/goal-widget.ts";

export type { ActiveGoalAudit };

/**
 * What tools, commands, events and widgets use to reach the session. It is a
 * facade: the state lives in `GoalSessionState`, and each group of behavior
 * lives in its own service (`GoalFocus`, `GoalLifecycle`, `GoalProgress`,
 * `GoalView`, `GoalWatch`). `createGoalCore` builds them and wires them together.
 * `state.goal` reads the focused goal; assigning it replaces the goal in the pool.
 */
export interface GoalCore {
	pi: ExtensionAPI;
	dependencies: { runCompletionAuditor?: typeof runGoalCompletionAuditor };
	state: { goal: GoalRecord | null };
	readonly goalsById: Map<string, GoalRecord>;
	readonly focusedGoalId: string | null;
	readonly focusRevision: number;
	sessionOwner: object | null;
	hasExplicitSessionFocus: boolean;
	runningGoalId: string | null;
	auditProgress: AuditorWidgetProgress | null;
	auditAnimationTimer: ReturnType<typeof setInterval> | null;
	activeAudit: ActiveGoalAudit | null;
	/** §15.4: finished audit result card shown briefly before the dashboard returns. */
	auditResult: AuditResultCard | null;
	setAuditResult(verdict: AuditVerdict, report: string): void;
	clearAuditResult(): void;
	goalModalDepth: number;
	enterGoalModal(): void;
	exitGoalModal(): void;
	invalidateSession(): void;
	goalWorkToolCalledThisTurn: boolean;
	tasksEnabled: boolean;
	terminalInputUnsubscribe: (() => void) | null;
	goalWidgetComponentRef: { current: GoalWidgetComponent | null };
	goalService: GoalService;
	runtime: GoalRuntime;
	scheduler: GoalScheduler;
	interruption: GoalInterruption;
	invokeGoalCommand?: (id: GoalCommandId, args: string, ctx: ExtensionContext) => Promise<void>;
	loadedCommands?: GoalCommands;
	controlWarnings?: string[];
	auditMessages: GoalAuditMessages;
	accounting: GoalAccounting;

	assignFocusedGoalId(goalId: string | null): void;
	focusedOperationToken(goalId: string): { goalId: string; revision: number };
	isFocusedOperationCurrent(token: { goalId: string; revision: number }): boolean;
	focusedOperationCancelledResult(action: string, token: { goalId: string; revision: number }): AgentToolResult<unknown>;
	installGoalToolProfile(tasksEnabled: boolean): void;
	stopAuditAnimation(): void;
	abortAudit(ctx: ExtensionContext): void;
	clearContinuationTimer(): void;
	clearContinuationState(resetNetworkErrorBackoff?: boolean): void;
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

/**
 * Advertises the goal tools. Only the disableTasks setting changes the list;
 * goal status, focus and drafting never do, so the cached prompt prefix
 * survives them. Host tools are left alone, and nothing is set when the list is
 * already right.
 */
function installToolProfile(pi: ExtensionAPI, session: GoalSessionState, tasksEnabled: boolean): void {
	try {
		const current = new Set(pi.getActiveTools());
		for (const knownGoalTool of ALL_REGISTERED_GOAL_TOOLS) current.delete(knownGoalTool);
		for (const goalTool of applicableGoalTools(tasksEnabled)) current.add(goalTool);
		const next = [...current].sort();
		const before = [...pi.getActiveTools()].sort();
		if (next.length !== before.length || next.some((name, index) => name !== before[index])) {
			pi.setActiveTools([...current]);
		}
		// Recorded so the settings menu can tell when disableTasks really changed.
		session.tasksEnabled = tasksEnabled;
	} catch (err) {
		console.error("[pi-goal] installGoalToolProfile error:", err instanceof Error ? err.message : String(err));
	}
}

export function createGoalCore(
	pi: ExtensionAPI,
	dependencies: { runCompletionAuditor?: typeof runGoalCompletionAuditor } = {},
): GoalCore {
	const session = new GoalSessionState();
	const accounting = new GoalAccounting();

	// The services need each other, so the ones built later are reached through
	// these functions, which are only called after everything exists.
	const clearActiveAccounting = () => accounting.clear();
	const clearContinuationState = (resetNetworkErrorBackoff = true) => {
		scheduler?.cancelTimer();
		runtime.clearContinuationState(resetNetworkErrorBackoff);
	};
	const clearStoppedRuntimeState = () => {
		clearContinuationState();
		clearActiveAccounting();
	};
	const updateUI = (ctx: ExtensionContext) => view.update(ctx);
	const getCommands = () => core.loadedCommands;
	const isActionableContinuationGoal = (goalId: string | null | undefined): goalId is string =>
		!!goalId && session.goal?.id === goalId && session.goal.status === "active" && session.goal.autoContinue && !interruption?.isHeld(goalId);

	/**
	 * The one way goal records are written. Every goal-file write, ledger
	 * append, and ordered write, ledger, memory commit goes through this
	 * service; handlers keep validation and runtime/UI effects.
	 */
	const goalService = new GoalService({
		getFocused: () => session.goal,
		setFocused: (goal) => {
			session.goal = goal;
		},
		getPool: () => session.goalsById,
		replacePool: (pool) => {
			session.goalsById = pool;
		},
		getFocusedGoalId: () => session.focusedGoalId,
		assignFocusedGoalId: (goalId) => session.assignFocusedGoalId(goalId),
		focusToken: (goalId) => session.focusToken(goalId),
		isTokenCurrent: (token) => session.isTokenCurrent(token),
		appendFocusEntry: (goalId, reason) => focus.appendEntry(goalId, reason),
		onFocusedGoalLost: (_lostGoalId, ctx) => {
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
		// Ledger appends never roll back the state write, but a failure stays visible.
		onDiagnostic: (diagnostic) => {
			console.warn(`[pi-goal] ${diagnostic.source} diagnostic: ${diagnostic.message}`);
		},
	});

	const runtime = new GoalRuntime({
		authorize: ctx => scheduler.claim(ctx),
		recover: ctx => scheduler.recover(ctx),
		dispatchFailed: ctx => scheduler.failedDispatch(ctx),
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
		getGoal: () => session.goal,
		isActionable: isActionableContinuationGoal,
	});

	const watch = new GoalWatch({ session, goalService, getCommands });
	const view = new GoalView({
		session,
		accounting,
		isInterruptionHeld: () => interruption.isHeld(),
		getCommands,
		isStalled: () => watch.isStalled(),
	});
	const progress = new GoalProgress({
		session,
		accounting,
		runtime,
		goalService,
		watch,
		scheduler: () => scheduler,
		interruption: () => interruption,
		persist: ctx => lifecycle.persist(ctx),
		updateUI,
	});
	const focus: GoalFocus = new GoalFocus({
		pi,
		session,
		goalService,
		interruption: () => interruption,
		scheduler: () => scheduler,
		persist: ctx => lifecycle.persist(ctx),
		updateUI,
		clearContinuationState,
		clearActiveAccounting,
		clearStoppedRuntimeState,
	});
	const lifecycle: GoalLifecycle = new GoalLifecycle({
		session,
		goalService,
		focus: () => focus,
		progress: () => progress,
		scheduler: () => scheduler,
		updateUI,
		clearContinuationState,
		clearActiveAccounting,
	});

	const core: GoalCore = {
		pi,
		dependencies,
		state: session,
		sessionOwner: null,
		get goalsById() { return session.goalsById; },
		get focusedGoalId() { return session.focusedGoalId; },
		get focusRevision() { return session.focusRevision; },
		get hasExplicitSessionFocus() { return session.hasExplicitSessionFocus; },
		set hasExplicitSessionFocus(value: boolean) { session.hasExplicitSessionFocus = value; },
		get runningGoalId() { return session.runningGoalId; },
		set runningGoalId(value: string | null) { session.runningGoalId = value; },
		get goalModalDepth() { return session.goalModalDepth; },
		set goalModalDepth(value: number) { session.goalModalDepth = value; },
		get goalWorkToolCalledThisTurn() { return session.goalWorkToolCalledThisTurn; },
		set goalWorkToolCalledThisTurn(value: boolean) { session.goalWorkToolCalledThisTurn = value; },
		get tasksEnabled() { return session.tasksEnabled; },
		set tasksEnabled(value: boolean) { session.tasksEnabled = value; },
		get activeAudit() { return session.activeAudit; },
		set activeAudit(value: ActiveGoalAudit | null) { session.activeAudit = value; },
		get auditProgress() { return view.auditProgress; },
		set auditProgress(value: AuditorWidgetProgress | null) { view.auditProgress = value; },
		get auditResult() { return view.auditResult; },
		set auditResult(value: AuditResultCard | null) { view.auditResult = value; },
		get auditAnimationTimer() { return view.auditAnimationTimer; },
		set auditAnimationTimer(value: ReturnType<typeof setInterval> | null) { view.auditAnimationTimer = value; },
		terminalInputUnsubscribe: null,
		goalWidgetComponentRef: view.widgetRef,
		goalService,
		runtime,
		get scheduler() { return scheduler; },
		get interruption() { return interruption; },
		auditMessages: new GoalAuditMessages(),
		accounting,

		assignFocusedGoalId: next => session.assignFocusedGoalId(next),
		focusedOperationToken: goalId => session.focusToken(goalId),
		isFocusedOperationCurrent: token => session.isTokenCurrent(token),
		focusedOperationCancelledResult: (action, token) => session.cancelledResult(action, token),
		invalidateSession: () => session.invalidate(),
		enterGoalModal: () => session.enterModal(),
		exitGoalModal: () => session.exitModal(),
		openGoals: () => session.openGoals(),
		installGoalToolProfile: tasksEnabled => installToolProfile(pi, session, tasksEnabled),

		setAuditResult: (verdict, report) => view.setAuditResult(verdict, report),
		clearAuditResult: () => view.clearAuditResult(),
		stopAuditAnimation: () => view.stopAuditAnimation(),
		abortAudit: () => view.abortAudit(),
		toggleDashboardExpanded: () => view.toggleDashboardExpanded(),
		isDashboardExpanded: () => view.isDashboardExpanded(),
		goalForDisplay: () => view.goalForDisplay(),
		updateUI,
		clearGoalWidget: ctx => view.clear(ctx),

		clearContinuationTimer: () => runtime.clearContinuationTimer(),
		clearContinuationState,
		clearActiveAccounting,
		clearStoppedRuntimeState,
		advanceTurnSeq: () => runtime.advanceTurn(),
		currentTurnStoppedGoalId: () => runtime.currentTurnStoppedGoalId(),
		isActionableContinuationGoal,
		isStaleCheckpointBlockedToolCall: toolName => runtime.isStaleCheckpointBlocked(toolName),
		queueContinuation: ctx => scheduler.schedule(ctx),
		armFocusedContinuation: ctx => {
			progress.begin();
			if (session.goal?.status === "active" && session.goal.autoContinue) scheduler.schedule(ctx);
		},

		appendFocusEntry: (goalId, reason) => focus.appendEntry(goalId, reason),
		setFocusedGoalId: (goalId, ctx, reason, opts) => focus.setFocus(goalId, ctx, reason, opts),
		updateFocusedGoal: (next, ctx, shouldPersist) => focus.updateFocused(next, ctx, shouldPersist),
		removeFocusedGoal: (ctx, reason) => focus.removeFocused(ctx, reason),
		setGoal: (next, ctx, shouldPersist, focusReason) => focus.setGoal(next, ctx, shouldPersist, focusReason),
		loadState: ctx => focus.load(ctx),

		reconcileFocusedGoalFromDisk: (ctx, opts) => goalService.reconcileFocused(ctx, opts),
		syncGoalPromptFromDisk: ctx => lifecycle.syncPromptFromDisk(ctx),
		refreshGoalDisplayFromDisk: ctx => lifecycle.refreshDisplayFromDisk(ctx),
		persist: ctx => lifecycle.persist(ctx),
		flushGoalTransaction: ctx => goalService.flushTurn(ctx),
		replaceGoal: (config, ctx, startNow, verificationContract, tokenBudget) => lifecycle.create(config, ctx, startNow, verificationContract, tokenBudget),
		archiveCurrentGoal: (ctx, reason) => lifecycle.archive(ctx, reason),
		stopActiveGoal: (status, reason, ctx) => lifecycle.stop(status, reason, ctx),
		pauseActiveGoal: ctx => lifecycle.pause(ctx),
		toggleGoalAuditor: ctx => lifecycle.toggleAuditor(ctx),

		beginAccounting: () => progress.begin(),
		accountProgress: (ctx, opts) => progress.charge(ctx, opts),
		touchGoalActivity: () => watch.touchActivity(),
		checkStall: ctx => watch.checkStall(ctx),
	};
	const interruption: GoalInterruption = new GoalInterruption(core);
	const scheduler: GoalScheduler = new GoalScheduler(core);
	return core;
}
