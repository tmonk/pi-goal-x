import { CacheStats } from "./goal-cache-stats.ts";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { goalDetails } from "./goal-format.ts";
import { focusedGoalFromPool, openGoalsFromPool } from "./goal-pool.ts";
import type { GoalRecord } from "./goal-record.ts";

/** A completion audit that is running, waiting for the user, or settling. */
export interface ActiveGoalAudit {
	controller: AbortController;
	phase: "running" | "awaiting-choice" | "settling" | "settled";
	cancel(reason: string): void;
}

/** Identifies one focused goal at one focus revision, so late work can tell it went stale. */
interface FocusToken {
	goalId: string;
	revision: number;
}

/**
 * The plain state one session owns: the goal pool, which goal is focused, and
 * a few flags. It does no I/O and draws nothing; services receive it and act
 * on it. `goal` reads the focused goal, and assigning it puts the goal in the
 * pool and focuses it.
 */
export class GoalSessionState {
	goalsById = new Map<string, GoalRecord>();
	focusedGoalId: string | null = null;
	/** Bumps whenever focus or the session changes, so slow work can detect it. */
	focusRevision = 0;
	hasExplicitSessionFocus = false;
	/** Where the session's focus entries say the goal files live. */
	focusStorageRoot: string | undefined;
	externalFocusRoot = false;
	runningGoalId: string | null = null;
	goalModalDepth = 0;
	/** Whether the task tools are advertised; decided at session start from settings. */
	tasksEnabled = true;
	goalWorkToolCalledThisTurn = false;
	/** What the provider reported it cached, this session. */
	readonly cacheStats = new CacheStats();
	activeAudit: ActiveGoalAudit | null = null;

	get goal(): GoalRecord | null {
		return focusedGoalFromPool(this.goalsById, this.focusedGoalId);
	}

	set goal(next: GoalRecord | null) {
		if (next) {
			this.goalsById.set(next.id, next);
			this.assignFocusedGoalId(next.id);
			return;
		}
		if (this.focusedGoalId) this.goalsById.delete(this.focusedGoalId);
		this.assignFocusedGoalId(null);
	}

	assignFocusedGoalId(next: string | null): void {
		if (this.focusedGoalId !== next) {
			this.focusRevision += 1;
			this.activeAudit?.cancel("Goal focus changed during completion audit.");
		}
		this.focusedGoalId = next;
	}

	/** The session was replaced or shut down. */
	invalidate(): void {
		this.focusRevision += 1;
		this.activeAudit?.cancel("Session replaced or shut down during completion audit.");
	}

	openGoals(): GoalRecord[] {
		return openGoalsFromPool(this.goalsById);
	}

	focusToken(goalId: string): FocusToken {
		return { goalId, revision: this.focusRevision };
	}

	isTokenCurrent(token: FocusToken): boolean {
		return this.focusedGoalId === token.goalId && this.focusRevision === token.revision;
	}

	cancelledResult(action: string, token: FocusToken): AgentToolResult<unknown> & { terminate: true } {
		return {
			content: [{
				type: "text" as const,
				text: `${action} cancelled because goal ${token.goalId} is no longer focused in this session. The shared goal was not modified.`,
			}],
			details: goalDetails(this.goal),
			terminate: true,
		};
	}

	enterModal(): void {
		this.goalModalDepth++;
	}

	exitModal(): void {
		this.goalModalDepth = Math.max(0, this.goalModalDepth - 1);
	}
}
