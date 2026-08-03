/**
 * GoalAccounting — serialized, idempotent token/time accounting.
 *
 * One instance per extension. `begin(goalId)` starts a session for an active
 * goal; `charge()` computes the elapsed seconds since the last charge and the
 * completed-turn tokens, then advances the baseline so repeated calls never
 * double-charge the same wall-clock interval. `liveSeconds()` is a read-only
 * display helper that does not mutate state.
 *
 * Also exposes the token-budget helpers used by the runtime to detect the
 * one-time `budget_limited` transition.
 */

export interface AccountingCharge {
	tokens: number;
	seconds: number;
}

export interface BudgetLike {
	tokenBudget?: number;
	usage: { tokensUsed: number };
}

export class GoalAccounting {
	private activeGoalId: string | null = null;
	private lastAccountedAt: number | null = null;

	/** Start accounting for a goal id (or clear when null). */
	begin(goalId: string | null): void {
		this.activeGoalId = goalId;
		this.lastAccountedAt = goalId ? Date.now() : null;
	}

	clear(): void {
		this.activeGoalId = null;
		this.lastAccountedAt = null;
	}

	get goalId(): string | null {
		return this.activeGoalId;
	}

	/** True when accounting is active for exactly this goal. */
	isActiveFor(goalId: string): boolean {
		return this.activeGoalId === goalId && this.lastAccountedAt !== null;
	}

	/**
	 * Serialized idempotent charge: returns the tokens + whole elapsed seconds
	 * accumulated since the previous charge, then advances the baseline to
	 * `now`. Calling again immediately afterwards yields 0 seconds (never
	 * double-charges the same interval).
	 */
	charge(opts: { now?: number; completedTurnTokens?: number } = {}): AccountingCharge {
		const now = opts.now ?? Date.now();
		const elapsedSeconds = this.lastAccountedAt === null
			? 0
			: Math.max(0, Math.floor((now - this.lastAccountedAt) / 1000));
		this.lastAccountedAt = now;
		const tokens = Math.max(0, Math.trunc(opts.completedTurnTokens ?? 0));
		return { tokens, seconds: elapsedSeconds };
	}

	/** Live elapsed whole seconds for display; does not advance the baseline. */
	liveSeconds(now = Date.now()): number {
		if (this.lastAccountedAt === null) return 0;
		return Math.max(0, Math.floor((now - this.lastAccountedAt) / 1000));
	}
}

/** Remaining token budget, or null when no budget is set. */
export function budgetRemaining(goal: BudgetLike): number | null {
	if (typeof goal.tokenBudget !== "number" || !Number.isFinite(goal.tokenBudget) || goal.tokenBudget <= 0) {
		return null;
	}
	const used = Math.max(0, Math.floor(goal.usage.tokensUsed));
	return Math.max(0, Math.floor(goal.tokenBudget - used));
}

/** True when a budget is set and accounted usage has reached it. */
export function budgetReached(goal: BudgetLike): boolean {
	const remaining = budgetRemaining(goal);
	return remaining !== null && remaining === 0;
}

/** Token-budget description for display/steering text. */
export function budgetLine(goal: BudgetLike): string | null {
	const remaining = budgetRemaining(goal);
	if (remaining === null) return null;
	const used = Math.floor(goal.usage.tokensUsed);
	return `token budget: ${used}/${Math.floor(goal.tokenBudget ?? 0)} used, ${remaining} remaining`;
}
