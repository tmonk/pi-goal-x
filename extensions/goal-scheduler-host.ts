import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { GoalCommands } from "./goal-controls.ts";
import type { GoalMutationOutcome, GoalMutationSpec } from "./goal-service-types.ts";
import type { GoalRecord } from "./goal-record.ts";

/**
 * The part of the session the scheduler uses, and nothing else. `GoalCore`
 * satisfies it, and so does a small fake in a test.
 */
export interface SchedulerHost {
	pi: Pick<ExtensionAPI, "events">;
	state: { goal: GoalRecord | null };
	loadedCommands?: GoalCommands;
	runningGoalId: string | null;
	goalService: {
		flushForAudit(ctx: ExtensionContext): string | null;
		isTurnBuffered(): boolean;
		apply(ctx: ExtensionContext, spec: GoalMutationSpec): GoalMutationOutcome;
	};
	runtime: {
		clearContinuationState(): void;
		clearContinuationTimer(): void;
		markTurnStopped(goalId: string): void;
		setCheckpoint(goalId: string | null): void;
		queueContinuation(ctx: ExtensionContext, goal: GoalRecord, force?: boolean): void;
	};
	interruption: {
		isHeld(goalId?: string): boolean;
		resumed(ctx: ExtensionContext): void;
	};
	clearActiveAccounting(): void;
	reconcileFocusedGoalFromDisk(ctx: ExtensionContext, opts?: { preserveMemoryUsage?: boolean }): boolean;
	updateUI(ctx: ExtensionContext): void;
}

/** The part of the session the interruption tracker uses. */
export interface InterruptionHost {
	state: { goal: GoalRecord | null };
	runningGoalId: string | null;
	scheduler: {
		interrupt(ctx: ExtensionContext): void;
		releaseInterrupt(ctx: ExtensionContext): void;
	};
	clearActiveAccounting(): void;
	clearContinuationState(resetNetworkErrorBackoff?: boolean): void;
	pauseActiveGoal(ctx: ExtensionContext): void;
	updateUI(ctx: ExtensionContext): void;
}
