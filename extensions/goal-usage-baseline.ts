import type { GoalRecord, GoalUsage } from "./goal-record.ts";

/** Usage the session added on top of a baseline, never negative. */
export interface UsageDelta {
	tokens: number;
	seconds: number;
}

/** The delta of `current` over `baseline`, clamped at zero so usage is never reduced. */
export function usageSince(current: GoalUsage, baseline: GoalUsage): UsageDelta {
	return {
		tokens: Math.max(0, current.tokensUsed - baseline.tokensUsed),
		seconds: Math.max(0, current.activeSeconds - baseline.activeSeconds),
	};
}

/** `usage` with a delta added on top. */
export function addUsage(usage: GoalUsage, delta: UsageDelta): GoalUsage {
	return { tokensUsed: usage.tokensUsed + delta.tokens, activeSeconds: usage.activeSeconds + delta.seconds };
}

/**
 * The usage this session last wrote to disk for a goal (or the disk usage the
 * session's accounting is relative to after load or reconcile). It is the
 * baseline for additive usage merging: when a write finds a newer revision on
 * disk, the delta since this baseline is merged onto the disk record instead
 * of the local usage being dropped.
 */
export class UsageBaseline {
	private last: { goalId: string; tokensUsed: number; activeSeconds: number } | null = null;

	/** Record the usage value the focused goal's in-memory accounting builds on. */
	track(goalId: string, usage: GoalUsage): void {
		this.last = { goalId, tokensUsed: usage.tokensUsed, activeSeconds: usage.activeSeconds };
	}

	/**
	 * Session-local usage delta since the last recorded baseline. Falls back to
	 * the disk usage when this session has no baseline for the goal (it never
	 * persisted or reconciled it).
	 */
	deltaFor(current: GoalRecord, disk: GoalRecord): UsageDelta {
		const baseline = this.last?.goalId === current.id
			? { tokensUsed: this.last.tokensUsed, activeSeconds: this.last.activeSeconds }
			: disk.usage;
		return usageSince(current.usage, baseline);
	}

	clear(): void {
		this.last = null;
	}
}
