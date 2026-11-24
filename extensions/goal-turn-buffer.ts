import type { GoalRecord } from "./goal-record.ts";
import type { GoalLedgerEvent } from "./goal-ledger.ts";
import { goalStorageContext, goalStorageRoot } from "./storage/goal-root.ts";
import type { GoalServiceContext } from "./goal-service-types.ts";

/**
 * The per-turn transaction buffer. Task, status and usage mutations and their
 * ledger events accumulate here in memory during a turn and flush once (one
 * lock acquire, one goal-file write, one ledger batch) at turn end or at an
 * explicit flush boundary: audit dispatch, pause or stop, focus change, session
 * reload. Reads during the turn overlay the buffered goal so in-turn mutations
 * are always visible; the optimistic revision check runs at flush time.
 *
 * This holds the state only. The service owns the writes.
 */
export class TurnBuffer {
	active = false;
	goalId: string | null = null;
	/** The newest in-turn record, or null when nothing was mutated yet. */
	goal: GoalRecord | null = null;
	/** Write the archived file instead of the active one when flushing. */
	archive = false;
	ledger: GoalLedgerEvent[] = [];
	/** The record the turn started from; its revision is what the disk must still hold at flush. */
	base: GoalRecord | null = null;
	context: GoalServiceContext | null = null;
	/** Why the last flush did not persist, for callers that must not go on. */
	flushError: string | null = null;

	/** Start a new transaction for the focused goal. */
	open(ctx: GoalServiceContext, goalId: string | null, focused: GoalRecord | null): void {
		this.active = true;
		this.goalId = goalId;
		this.goal = null;
		this.archive = false;
		this.ledger = [];
		this.context = goalStorageContext(ctx);
		this.base = focused ? { ...focused, usage: { ...focused.usage } } : null;
		this.flushError = null;
	}

	/** The focus moved to `goal` mid-turn: start over on it once the previous buffer was flushed. */
	switchTo(goal: GoalRecord): void {
		this.active = true;
		this.goalId = goal.id;
		this.goal = goal;
		this.archive = false;
		this.ledger = [];
		this.base = goal;
	}

	/** First mutation of the turn: remember the goal and the revision to check against. */
	stage(goal: GoalRecord): void {
		this.goal = goal;
		this.goalId = goal.id;
		if (this.base?.id !== goal.id) this.base = { ...goal, usage: { ...goal.usage } };
	}

	/** True when `ctx` points at the storage root this turn was opened on. */
	sameStorage(ctx: GoalServiceContext): boolean {
		return !!this.context && goalStorageRoot(this.context) === goalStorageRoot(ctx);
	}

	/** Drop the buffered record and events after a rejected flush. */
	reject(): void {
		this.active = false;
		this.goal = null;
		this.ledger = [];
	}

	/** Forget everything, as when a session is replaced. */
	reset(): void {
		this.active = false;
		this.goalId = null;
		this.goal = null;
		this.archive = false;
		this.ledger = [];
		this.context = null;
		this.base = null;
	}
}
