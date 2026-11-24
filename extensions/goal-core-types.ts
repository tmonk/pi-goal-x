import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { runGoalCompletionAuditor } from "./goal-auditor.ts";
import type { GoalCommandId, GoalCommands } from "./goal-controls.ts";
import type { GoalFocus } from "./goal-focus.ts";
import type { GoalInterruption } from "./goal-interruption.ts";
import type { GoalLifecycle } from "./goal-lifecycle.ts";
import type { GoalProgress } from "./goal-progress.ts";
import type { GoalRuntime } from "./goal-runtime.ts";
import type { GoalScheduler } from "./goal-scheduler.ts";
import type { GoalService } from "./goal-service.ts";
import type { GoalAuditMessages } from "./goal-session-safety.ts";
import type { GoalSessionState } from "./goal-session-state.ts";
import type { GoalView } from "./goal-view.ts";
import type { GoalWatch } from "./goal-watch.ts";

/**
 * The small pieces of `GoalCore` that a module can ask for. Each module names
 * the ones it uses and combines them with `&`, so its signature says what it
 * touches and a test can fake just that.
 *
 * Two kinds of piece live here. The flat ones (`GoalDiskSync`, `GoalUiRefresh`,
 * ...) are single members that `GoalCore` itself extends. The nested ones
 * (`GoalFocusedGoalAccess`, `GoalOperationGuard`, ...) are slices of a service
 * the core exposes, such as `state` or `goalService`; `&` merges two slices of
 * the same service into one.
 */

// Flat members.

/** Re-read the focused goal's file when it changed under us. */
export interface GoalDiskSync {
	reconcileFocusedGoalFromDisk(ctx: ExtensionContext, opts?: { preserveMemoryUsage?: boolean }): boolean;
}

/** Ask for the goal widget and status to redraw. */
export interface GoalUiRefresh {
	updateUI(ctx: ExtensionContext): void;
}

/** The commands the controls settings turned into slash-command shortcuts. */
export interface GoalLoadedCommands {
	loadedCommands?: GoalCommands;
}

export interface GoalCommandInvoker {
	invokeGoalCommand?: (id: GoalCommandId, args: string, ctx: ExtensionContext) => Promise<void>;
}

/** Problems found while loading the controls settings, shown once at session start. */
export interface GoalControlWarnings {
	controlWarnings?: string[];
}

/** Stop the continuation timer and the time accounting, as when a goal stops or changes. */
export interface GoalClockReset {
	clearContinuationState(resetNetworkErrorBackoff?: boolean): void;
	clearActiveAccounting(): void;
}

/** Which goal's turn is running now. */
export interface GoalRunningGoal {
	runningGoalId: string | null;
}

/** The running goal, and the way to stop the clocks around it. */
export interface GoalRunControl extends GoalRunningGoal, GoalClockReset {}

/** Start, stop or judge continuation of the focused goal. */
export interface GoalContinuationControl {
	isActionableContinuationGoal(goalId: string | null | undefined): goalId is string;
	/** Start accounting for the focused goal and schedule its next continuation. */
	armFocusedContinuation(ctx: ExtensionContext): void;
	pauseActiveGoal(ctx: ExtensionContext): void;
}

/** Settings changes that add or remove the task tools. */
export interface GoalToolProfile {
	installGoalToolProfile(tasksEnabled: boolean): void;
}

/** Handles the session owner and terminal-input hook share across events. */
export interface GoalSessionHandles {
	sessionOwner: object | null;
	terminalInputUnsubscribe: (() => void) | null;
}

export interface GoalAuditQueue {
	auditMessages: GoalAuditMessages;
}

export interface GoalDependencies {
	dependencies: { runCompletionAuditor?: typeof runGoalCompletionAuditor };
}

// Slices of a service the core exposes.

/** Read or replace the focused goal. */
export type GoalFocusedGoalAccess = StateSlice<"goal">;

/** The pool of open goals and which one has focus. */
export type GoalPoolAccess = StateSlice<"goalsById" | "focusedGoalId" | "openGoals">;

/** Detect that focus moved while slow work (a dialog, an audit) was in flight. */
export type GoalOperationGuard = StateSlice<"focusToken" | "isTokenCurrent" | "cancelledResult">;

/** Mark a dialog as open so Escape and input handling leave it alone. */
export type GoalModalAccess = StateSlice<"enterModal" | "exitModal">;

/** Ordered goal-file writes and ledger appends. */
export type GoalRecordWriter = ServiceSlice<"apply" | "appendEvents">;

/** Record that this turn stopped the goal, so continuation does not restart it. */
export type GoalTurnStopMarker = RuntimeSlice<"markTurnStopped">;

/** Charge the time and tokens used so far to the focused goal. */
export type GoalProgressCharge = ProgressSlice<"charge">;

/** The audit's live state: the running audit, its progress and its widget. */
export type GoalAuditStateAccess = StateSlice<"activeAudit"> &
	ViewSlice<"auditProgress" | "auditAnimationTimer" | "stopAuditAnimation" | "setAuditResult" | "clearAuditResult" | "widgetRef">;

// Slices of one service, for what a single module reaches for. `A & B` merges
// two slices of the same service, so `StateSlice<"goal"> & StateSlice<"goalsById">`
// asks for both members of `state`.

export type HostSlice<K extends keyof ExtensionAPI> = { pi: Pick<ExtensionAPI, K> };
export type StateSlice<K extends keyof GoalSessionState> = { state: Pick<GoalSessionState, K> };
export type ViewSlice<K extends keyof GoalView> = { view: Pick<GoalView, K> };
export type FocusSlice<K extends keyof GoalFocus> = { focus: Pick<GoalFocus, K> };
export type LifecycleSlice<K extends keyof GoalLifecycle> = { lifecycle: Pick<GoalLifecycle, K> };
export type ProgressSlice<K extends keyof GoalProgress> = { progress: Pick<GoalProgress, K> };
export type WatchSlice<K extends keyof GoalWatch> = { watch: Pick<GoalWatch, K> };
export type ServiceSlice<K extends keyof GoalService> = { goalService: Pick<GoalService, K> };
export type RuntimeSlice<K extends keyof GoalRuntime> = { runtime: Pick<GoalRuntime, K> };
export type SchedulerSlice<K extends keyof GoalScheduler> = { scheduler: Pick<GoalScheduler, K> };
export type InterruptionSlice<K extends keyof GoalInterruption> = { interruption: Pick<GoalInterruption, K> };
