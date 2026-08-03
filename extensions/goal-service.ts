import { cloneGoal, nowIso, type GoalFocusReason, type GoalRecord } from "./goal-record.ts";
import { appendGoalEvent, type GoalLedgerEvent } from "./goal-ledger.ts";
import {
	archiveGoalFile,
	atomicWriteGoalFile,
	ensureDirectory,
	mergeGoalPromptFromDisk,
	readActiveGoalPool,
	safeUnlinkGoalFile,
	sanitizeGoalPaths,
	writeActiveGoalFile,
	type GoalFileContext,
} from "./storage/goal-files.ts";
import { mergeFocusedGoalWithDisk } from "./goal-pool.ts";

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
}

export type GoalServiceContext = GoalFileContext;

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

export interface GoalMutationFailure {
	ok: false;
	message: string;
}

export type GoalMutationOutcome = GoalMutationResult | GoalMutationFailure;

/**
 * GoalService — the extension's sole mutation boundary for goal records.
 *
 * Ordered pipeline for every focused-goal mutation (mirrors TECH.md storage
 * section):
 *
 *   1. safe focused record reconciliation from disk;
 *   2. expected goal id + focus revision check;
 *   3. mutation on a clone;
 *   4. active-file write (or archival for complete/clear/abort);
 *   5. ledger append best effort;
 *   6. in-memory pool/focus commit;
 *   7. runtime/UI effects (returned and signalled through the ref hooks).
 *
 * If the active-file write fails it throws, so memory/ledger/focus/archive are
 * never committed. A failed ledger append after the authoritative write keeps
 * the successful state transition and reports diagnostics via the hook, matching
 * the current best-effort ledger semantics.
 */
export class GoalService {
	private readonly ref: GoalServiceRef;

	constructor(ref: GoalServiceRef) {
		this.ref = ref;
	}

	/** Safe focused record reconciliation from disk. */
	reconcileFocused(ctx: GoalServiceContext, opts: { preserveMemoryUsage?: boolean } = {}): boolean {
		const current = this.ref.getFocused();
		const fresh = readActiveGoalPool(ctx);
		const focusedGoalId = this.ref.getFocusedGoalId();
		if (!focusedGoalId) {
			this.ref.replacePool(fresh);
			return true;
		}
		const diskGoal = fresh.get(focusedGoalId) ?? null;
		if (!diskGoal) {
			if (current && !current.activePath) {
				this.ref.replacePool(fresh);
				fresh.set(current.id, current);
				this.ref.assignFocusedGoalId(current.id);
				return true;
			}
			const lostGoalId = current?.id ?? null;
			this.ref.replacePool(fresh);
			this.ref.assignFocusedGoalId(null);
			this.ref.onFocusedGoalLost(lostGoalId, ctx);
			return false;
		}
		const reconciled = current && opts.preserveMemoryUsage
			? mergeFocusedGoalWithDisk({ memoryGoal: current, diskGoal })
			: diskGoal;
		this.ref.replacePool(fresh);
		fresh.set(reconciled.id, reconciled);
		this.ref.assignFocusedGoalId(reconciled.id);
		this.ref.onReconciled(reconciled);
		return true;
	}

	/**
	 * The single ordered mutation pipeline for a focused goal.
	 * Returns the written record plus focus-change effects; the extension maps
	 * failures to user-facing results.
	 */
	apply(ctx: GoalServiceContext, spec: GoalMutationSpec): GoalMutationOutcome {
		// 1. reconcile (unless the caller opts out — e.g. the tweak path, which
		//    must not clobber the authoritative new objective with the old file).
		if (spec.reconcile !== false && !this.reconcileFocused(ctx)) {
			return { ok: false, message: "The focused goal was lost during reconciliation; the mutation was not applied." };
		}
		const current = this.ref.getFocused();
		if (!current) {
			return { ok: false, message: "No focused goal to mutate." };
		}

		// 2. expected goal id + focus revision validation.
		if (spec.expectedGoalId != null && current.id !== spec.expectedGoalId) {
			return { ok: false, message: `Mutation rejected: expected goal ${spec.expectedGoalId} but the focused goal is ${current.id}.` };
		}
		if (spec.focusToken && !this.ref.isTokenCurrent(spec.focusToken)) {
			return { ok: false, message: `Mutation cancelled because goal ${spec.focusToken.goalId} is no longer focused in this session. The shared goal was not modified.` };
		}

		// 3. mutation on a clone (after an optional authoritative objective merge).
		const base = spec.refreshFromDisk ? mergeGoalPromptFromDisk(ctx, current) : current;
		const mutated = sanitizeGoalPaths(ctx, spec.mutate(cloneGoal(base)));

		// 4. authoritative file write (active or archive). A failure here throws
		//    and prevents any memory/ledger/focus/archive commit.
		const written = spec.archive ? archiveGoalFile(ctx, mutated) : writeActiveGoalFile(ctx, mutated);

		// 5. ledger append best effort.
		if (spec.ledger) {
			let events: GoalLedgerEvent[];
			try {
				events = typeof spec.ledger === "function" ? spec.ledger(written) : spec.ledger;
			} catch {
				events = [];
			}
			for (const event of events) {
				try {
					appendGoalEvent(ctx, event);
				} catch {
					// Ledger append failure after the authoritative write keeps the
					// successful state transition and reports diagnostics.
				}
			}
		}

		// 6. in-memory pool/focus commit.
		const previousGoalId = current.id;
		const commitFocused = spec.commitFocused !== false;
		if (commitFocused) this.ref.setFocused(written);
		const goalId = commitFocused ? written.id : this.ref.getFocusedGoalId();
		const focusChanged = commitFocused && previousGoalId !== written.id;

		// 7. runtime/UI effects.
		if (focusChanged) this.ref.onFocusChanged(previousGoalId, written.id);

		return { ok: true, goal: written, previousGoalId, goalId, focusChanged };
	}

	/** Persist the focused goal: bump updatedAt, merge objective from disk, write active or archive. */
	persist(ctx: GoalServiceContext): GoalRecord | null {
		const current = this.ref.getFocused();
		if (!current) return null;
		const merged = mergeGoalPromptFromDisk(ctx, { ...current, updatedAt: nowIso() });
		const written = merged.status === "complete" ? archiveGoalFile(ctx, merged) : writeActiveGoalFile(ctx, merged);
		this.ref.setFocused(written);
		return written;
	}

	/** Create a goal: write active file → ledger → memory/focus commit. */
	create(ctx: GoalServiceContext, spec: { goal: GoalRecord; ledger?: GoalLedgerEvent[] }): GoalMutationResult {
		const previousGoalId = this.ref.getFocused()?.id ?? null;
		const written = writeActiveGoalFile(ctx, sanitizeGoalPaths(ctx, spec.goal));
		if (spec.ledger) {
			for (const event of spec.ledger) {
				try {
					appendGoalEvent(ctx, event);
				} catch {
					// Best-effort ledger; creation still succeeds.
				}
			}
		}
		this.ref.setFocused(written);
		const focusChanged = previousGoalId !== written.id;
		if (focusChanged) this.ref.onFocusChanged(previousGoalId, written.id);
		return { ok: true, goal: written, previousGoalId, goalId: written.id, focusChanged };
	}

	/** Append ledger events best-effort (audit flow / focus changes happen mid-turn, outside apply). */
	appendEvents(ctx: GoalServiceContext, events: GoalLedgerEvent[]): void {
		for (const event of events) {
			try {
				appendGoalEvent(ctx, event);
			} catch {
				// Ledger append failure must not crash the surrounding flow.
			}
		}
	}

	/** Diagnostic write for the debug widget toggle (separate debug dir; not a goal mutation). */
	writeDebugFile(ctx: GoalServiceContext, relPath: string, content: string): void {
		const gfc: GoalFileContext = { cwd: ctx.cwd };
		ensureDirectory(gfc, ".pi/goals/debug");
		atomicWriteGoalFile(gfc, ".pi/goals/debug", relPath, content);
	}

	/** Diagnostic removal for the debug widget toggle. */
	removeDebugFile(ctx: GoalServiceContext, relPath: string): void {
		try {
			safeUnlinkGoalFile({ cwd: ctx.cwd }, ".pi/goals/debug", relPath);
		} catch {
			// Debug file removal is best-effort.
		}
	}
}
