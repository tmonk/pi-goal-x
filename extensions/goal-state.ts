import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { GoalAccounting } from "./goal-accounting.ts";
import type { runGoalCompletionAuditor } from "./goal-auditor.ts";
import type {
	GoalAuditQueue,
	GoalCommandInvoker,
	GoalContinuationControl,
	GoalControlWarnings,
	GoalDependencies,
	GoalDiskSync,
	GoalLoadedCommands,
	GoalRunControl,
	GoalSessionHandles,
	GoalToolProfile,
	GoalUiRefresh,
} from "./goal-core-types.ts";
import { GoalFocus } from "./goal-focus.ts";
import { GOAL_EVENT_ENTRY } from "./goal-format.ts";
import { GoalInterruption } from "./goal-interruption.ts";
import { GoalLifecycle } from "./goal-lifecycle.ts";
import { GoalProgress } from "./goal-progress.ts";
import type { GoalEventDetails } from "./goal-record.ts";
import { GoalRuntime } from "./goal-runtime.ts";
import { GoalScheduler } from "./goal-scheduler.ts";
import { GoalService } from "./goal-service.ts";
import { GoalAuditMessages } from "./goal-session-safety.ts";
import { GoalSessionState, type ActiveGoalAudit } from "./goal-session-state.ts";
import { ALL_REGISTERED_GOAL_TOOLS, applicableGoalTools } from "./goal-tool-names.ts";
import { GoalView } from "./goal-view.ts";
import { GoalWatch } from "./goal-watch.ts";

export type { ActiveGoalAudit };

/**
 * What tools, commands, events and widgets use to reach the session. It is a
 * facade over `GoalSessionState` (the plain state) and the services built
 * around it: `focus`, `lifecycle`, `progress`, `view` and `watch`, plus the
 * goal service, runtime, scheduler and interruption. `createGoalCore` builds
 * them and wires them together.
 *
 * Callers reach a service directly (`core.view.update`, `core.focus.setFocus`)
 * and the few members here are shortcuts that join several services or are used
 * by the scheduler and interruption. Modules do not take the whole core; they
 * declare the slices they need from `goal-core-types.ts`.
 * `state.goal` reads the focused goal; assigning it replaces the goal in the pool.
 */
export interface GoalCore
	extends GoalDiskSync,
		GoalUiRefresh,
		GoalLoadedCommands,
		GoalCommandInvoker,
		GoalControlWarnings,
		GoalRunControl,
		GoalContinuationControl,
		GoalToolProfile,
		GoalSessionHandles,
		GoalAuditQueue,
		GoalDependencies {
	pi: ExtensionAPI;
	state: GoalSessionState;
	view: GoalView;
	focus: GoalFocus;
	lifecycle: GoalLifecycle;
	progress: GoalProgress;
	watch: GoalWatch;
	goalService: GoalService;
	runtime: GoalRuntime;
	scheduler: GoalScheduler;
	interruption: GoalInterruption;
	accounting: GoalAccounting;
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
		view,
		focus,
		lifecycle,
		progress,
		watch,
		goalService,
		runtime,
		get scheduler() { return scheduler; },
		get interruption() { return interruption; },
		accounting,
		auditMessages: new GoalAuditMessages(),
		sessionOwner: null,
		terminalInputUnsubscribe: null,
		get runningGoalId() { return session.runningGoalId; },
		set runningGoalId(value: string | null) { session.runningGoalId = value; },

		updateUI,
		clearContinuationState,
		clearActiveAccounting,
		isActionableContinuationGoal,
		installGoalToolProfile: tasksEnabled => installToolProfile(pi, session, tasksEnabled),
		armFocusedContinuation: ctx => {
			progress.begin();
			if (session.goal?.status === "active" && session.goal.autoContinue) scheduler.schedule(ctx);
		},
		pauseActiveGoal: ctx => lifecycle.pause(ctx),
		reconcileFocusedGoalFromDisk: (ctx, opts) => goalService.reconcileFocused(ctx, opts),
	};
	const interruption: GoalInterruption = new GoalInterruption(core);
	const scheduler: GoalScheduler = new GoalScheduler(core);
	return core;
}
