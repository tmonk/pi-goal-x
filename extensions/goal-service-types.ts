import type { GoalFocusReason, GoalRecord, GoalTask } from "./goal-record.ts";
import type { GoalLedgerEvent } from "./goal-ledger.ts";
import type { GoalFileContext } from "./storage/goal-files.ts";

export interface GoalDiagnostic {
	severity: "warning";
	source: "ledger" | "storage";
	goalId?: string;
	eventType?: string;
	message: string;
}

export type GoalServiceContext = GoalFileContext;

/**
 * Session state access + runtime glue hooks that the GoalService needs.
 * The extension (`extensions/goal.ts`) wires these to its closure state so the
 * service stays the sole mutation boundary while the runtime effects
 * (continuation queue, accounting, nudge state, tools, UI) remain in the
 * extension's event handlers.
 */
export interface GoalServiceRef {
	getFocused(): GoalRecord | null;
	/** Mirror of the `state.goal` setter: pool upsert + focus assignment. */
	setFocused(goal: GoalRecord | null): void;
	getPool(): Map<string, GoalRecord>;
	replacePool(pool: Map<string, GoalRecord>): void;
	getFocusedGoalId(): string | null;
	/** Assigns the session focus; bumps the focus revision when it changes. */
	assignFocusedGoalId(goalId: string | null): void;
	focusToken(goalId: string): { goalId: string; revision: number };
	isTokenCurrent(token: { goalId: string; revision: number }): boolean;
	appendFocusEntry(goalId: string | null, reason: GoalFocusReason): void;
	/** The focused goal vanished during reconciliation (external clear/archive/delete). */
	onFocusedGoalLost(lostGoalId: string | null, ctx: GoalServiceContext): void;
	/** A reconciled goal is now focused; clear continuation/accounting as its status requires. */
	onReconciled(goal: GoalRecord): void;
	/** The session focus changed; clear continuation/accounting/nudge state. */
	onFocusChanged(from: string | null, to: string | null): void;
	/** Observable diagnostic sink for non-fatal failures (ledger appends). */
	onDiagnostic(diagnostic: GoalDiagnostic): void;
}

export interface GoalMutationSpec {
	/** If provided, the focused goal id must equal this or the mutation is rejected. */
	expectedGoalId?: string | null;
	/** If provided, the token must still be current (same goal id + focus revision). */
	focusToken?: { goalId: string; revision: number };
	/** Skip the leading disk reconciliation (used when the caller already reconciled or must not). */
	reconcile?: boolean;
	/** Merge the authoritative objective body from disk before mutating. */
	refreshFromDisk?: boolean;
	/** Mutate a clone of the focused goal. May ignore its input to produce a fixed record. */
	mutate: (goal: GoalRecord) => GoalRecord;
	/** Ledger events appended best-effort AFTER the authoritative file write. */
	ledger?: GoalLedgerEvent[] | ((written: GoalRecord) => GoalLedgerEvent[]);
	/** Write the archived goal file instead of the active file (complete/clear/abort). */
	archive?: boolean;
	/** Commit the written record as the focused in-memory goal. Default true. */
	commitFocused?: boolean;
}

export interface GoalMutationResult {
	ok: true;
	goal: GoalRecord;
	previousGoalId: string | null;
	goalId: string | null;
	focusChanged: boolean;
}

interface GoalMutationFailure {
	ok: false;
	message: string;
}

export type GoalMutationOutcome = GoalMutationResult | GoalMutationFailure;

export interface GoalTaskUpdateSpec {
	/** If provided, the token must still be current (same goal id + focus revision). */
	focusToken?: { goalId: string; revision: number };
	/** The task to update, loaded fresh from the disk record. */
	taskId: string;
	/** Optional transition validation against the FRESH task; a failure aborts with a typed message. */
	validate?(task: GoalTask): { ok: true } | { ok: false; message: string };
	/** Transform the FRESH task. A failure aborts; only this task's path changes. */
	update(task: GoalTask): GoalTask | { ok: false; message: string };
	/**
	 * Explicit execution focus (start): set the persisted currentTaskId to this
	 * task, replacing any previous one. Otherwise focus is cleared when the
	 * current task becomes terminal (complete or skipped).
	 */
	setCurrentTaskId?: string;
	/** Ledger events appended best-effort AFTER the authoritative file write. */
	ledger?(written: GoalRecord, updatedTask: GoalTask): GoalLedgerEvent[];
}

export type GoalTaskUpdateOutcome = { ok: true; goal: GoalRecord; task: GoalTask } | { ok: false; message: string };
