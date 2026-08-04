import { cloneGoal, nowIso, type GoalFocusReason, type GoalRecord, type GoalTask } from "./goal-record.ts";
import { appendGoalEvent, type GoalLedgerEvent } from "./goal-ledger.ts";
import { findTaskInTree, updateTaskInTree } from "./goal-policy.ts";
import {
	GOALS_DIR,
	archiveGoalFile,
	atomicWriteGoalFile,
	ensureDirectory,
	mergeGoalPromptFromDisk,
	parseGoalFile,
	readActiveGoalPool,
	resolveGoalPath,
	safeUnlinkGoalFile,
	sanitizeGoalPaths,
	writeActiveGoalFile,
	type GoalFileContext,
} from "./storage/goal-files.ts";
import { acquireGoalLock, type GoalLock } from "./storage/goal-lock.ts";
import { mergeFocusedGoalWithDisk } from "./goal-pool.ts";

/**
 * Session state access + runtime glue hooks that the GoalService needs.
 * The extension (`extensions/goal.ts`) wires these to its closure state so the
 * service stays the sole mutation boundary while the runtime effects
 * (continuation queue, accounting, nudge state, tools, UI) remain in the
 * extension's event handlers.
 */
export interface GoalDiagnostic {
	severity: "warning";
	source: "ledger";
	goalId?: string;
	eventType?: string;
	message: string;
}

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
export interface GoalTaskUpdateSpec {
	/** If provided, the token must still be current (same goal id + focus revision). */
	focusToken?: { goalId: string; revision: number };
	/** The task to update, loaded fresh from the disk record. */
	taskId: string;
	/** Optional transition validation against the FRESH task; a failure aborts with a typed message. */
	validate?(task: GoalTask): { ok: true } | { ok: false; message: string };
	/** Transform the FRESH task. A failure aborts; only this task's path changes. */
	update(task: GoalTask): GoalTask | { ok: false; message: string };
	/** Ledger events appended best-effort AFTER the authoritative file write. */
	ledger?(written: GoalRecord, updatedTask: GoalTask): GoalLedgerEvent[];
}

export type GoalTaskUpdateOutcome = { ok: true; goal: GoalRecord; task: GoalTask } | { ok: false; message: string };

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
	 * Read the goal's authoritative active file directly (no complete-status
	 * filter, unlike the pool reader) for the optimistic revision check under
	 * the per-goal lock. Returns null when the file is gone (external
	 * archive/delete) or the goal has no active path.
	 */
	private readFreshDiskGoal(ctx: GoalServiceContext, current: GoalRecord): GoalRecord | null {
		if (!current.activePath) return null;
		try {
			return parseGoalFile(resolveGoalPath(ctx, GOALS_DIR, current.activePath));
		} catch {
			return null;
		}
	}

	/**
	 * The single ordered mutation pipeline for a focused goal.
	 * Returns the written record plus focus-change effects; the extension maps
	 * failures to user-facing results.
	 *
	 * Cross-process control (follow-up Stage 4): after the session-local
	 * validation, an exclusive per-goal lock is acquired (bounded, with stale
	 * recovery) and the authoritative file is re-read under the lock. If the
	 * persisted revision differs from the one captured at reconciliation, the
	 * mutation returns a typed conflict carrying the current revision instead
	 * of overwriting blindly. On success the revision is incremented, the file
	 * is written atomically, ledger events are appended best-effort, memory is
	 * committed, and the lock is released in a finally block.
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

		// 2b. exclusive per-goal lock + optimistic revision check (follow-up Stage 4).
		const capturedRevision = current.revision ?? 0;
		const lock = acquireGoalLock(ctx, current.id);
		try {
			const freshDisk = this.readFreshDiskGoal(ctx, current);
			if (!freshDisk) {
				return { ok: false, message: `Goal ${current.id} was deleted or archived by another process while this mutation was in progress; the mutation was not applied.` };
			}
			const diskRevision = freshDisk.revision ?? 0;
			if (diskRevision !== capturedRevision) {
				return { ok: false, message: `Goal ${current.id} was modified by another process (revision ${capturedRevision} -> ${diskRevision}); current revision is ${diskRevision}. Refresh and retry; the mutation was not applied.` };
			}

			// 3. mutation on a clone (after an optional authoritative objective merge).
			const base = spec.refreshFromDisk ? mergeGoalPromptFromDisk(ctx, current) : current;
			const mutated = sanitizeGoalPaths(ctx, {
				...spec.mutate(cloneGoal(base)),
				revision: capturedRevision + 1,
			});

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
					const append = appendGoalEvent(ctx, event);
					if (!append.ok) {
						// Ledger append failure after the authoritative write keeps the
						// successful state transition; surface an observable diagnostic.
						this.ref.onDiagnostic({
							severity: "warning",
							source: "ledger",
							goalId: "goalId" in event ? event.goalId : undefined,
							eventType: event.type,
							message: `Ledger append failed for ${event.type}${("goalId" in event) ? ` (goal ${event.goalId})` : ""}: ${String(append.error)}`,
						});
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
		} finally {
			lock.release();
		}
	}



/**
 * Disk-fresh single-task transaction. Pipeline:
 *  1. reconcile the focused record;
 *  2. validate focus token/id;
 *  3. load the fresh task from the cloned disk record;
 *  4. validate the requested transition against that fresh task;
 *  5. update only that task's path;
 *  6. write the active file, append the ledger, and commit.
 * Expected races (removed task, removed task list) return typed failures
 * instead of throwing.
 */
		updateTask(ctx: GoalServiceContext, spec: GoalTaskUpdateSpec): GoalTaskUpdateOutcome {
		return this.updateTaskAttempt(ctx, spec, 1);
	}

	/**
	 * Disk-fresh single-task transaction (follow-up Stage 4 adds the per-goal
	 * lock + optimistic revision check). Pipeline:
	 *  1. reconcile the focused record;
	 *  2. validate focus token/id;
	 *  3. acquire the per-goal lock and re-read the authoritative file;
	 *  4. a stale writer gets a typed conflict; it retries ONCE with the fresh
	 *     state — the transition validation re-checks that the same task and
	 *     relevant status/structure are unchanged, so a genuinely concurrent
	 *     edit is rejected rather than silently merged;
	 *  5. load the fresh task, validate the transition, update only that task;
	 *  6. write with an incremented revision, append the ledger, and commit.
	 */
	private updateTaskAttempt(ctx: GoalServiceContext, spec: GoalTaskUpdateSpec, retriesLeft: number): GoalTaskUpdateOutcome {
		if (!this.reconcileFocused(ctx)) {
			return { ok: false, message: "The focused goal was lost during reconciliation; the task was not updated." };
		}
		const current = this.ref.getFocused();
		if (!current) {
			return { ok: false, message: "No focused goal to mutate." };
		}
		if (spec.focusToken && !this.ref.isTokenCurrent(spec.focusToken)) {
			return { ok: false, message: `Mutation cancelled because goal ${spec.focusToken.goalId} is no longer focused in this session. The shared goal was not modified.` };
		}
		const capturedRevision = current.revision ?? 0;
		const lock = acquireGoalLock(ctx, current.id);
		try {
			const freshDisk = this.readFreshDiskGoal(ctx, current);
			if (!freshDisk) {
				return { ok: false, message: `Goal ${current.id} was deleted or archived by another process while the task update was in progress; the task was not updated.` };
			}
			const diskRevision = freshDisk.revision ?? 0;
			if (diskRevision !== capturedRevision) {
				if (retriesLeft > 0) {
					// Retry once against the fresh state; the transition validation
					// below is the guard for task status/structure changes.
					return this.updateTaskAttempt(ctx, spec, retriesLeft - 1);
				}
				return { ok: false, message: `Goal ${current.id} was modified by another process (revision ${capturedRevision} -> ${diskRevision}); current revision is ${diskRevision}. The task was not updated.` };
			}
			const base = mergeGoalPromptFromDisk(ctx, current);
			if (!base.taskList) {
				return { ok: false, message: "The goal has no task list." };
			}
			const task = findTaskInTree(base.taskList.tasks, spec.taskId);
			if (!task) {
				return { ok: false, message: `Task "${spec.taskId}" not found.` };
			}
			if (spec.validate) {
				const gate = spec.validate(task);
				if (!gate.ok) return gate;
			}
			const updated = spec.update(task);
			if (typeof updated === "object" && "ok" in updated && !updated.ok) return updated;
			const updatedTask = updated as GoalTask;
			const updatedTasks = updateTaskInTree(base.taskList.tasks, spec.taskId, () => updatedTask);
			const mutated = sanitizeGoalPaths(ctx, {
				...base,
				taskList: { ...base.taskList, tasks: updatedTasks },
				updatedAt: nowIso(),
				revision: capturedRevision + 1,
			});
			const written = writeActiveGoalFile(ctx, mutated);
			if (spec.ledger) {
				try {
					for (const event of spec.ledger(written, updatedTask)) {
						const append = appendGoalEvent(ctx, event);
						if (!append.ok) {
							this.ref.onDiagnostic({
								severity: "warning",
								source: "ledger",
								goalId: "goalId" in event ? event.goalId : undefined,
								eventType: event.type,
								message: `Ledger append failed for ${event.type}${("goalId" in event) ? ` (goal ${event.goalId})` : ""}: ${String(append.error)}`,
							});
						}
					}
				} catch (err) {
					// Unexpected ledger-spec error after the authoritative write keeps
					// the successful state transition.
					this.ref.onDiagnostic({
						severity: "warning",
						source: "ledger",
						goalId: spec.taskId,
						message: `Ledger spec error during task update: ${String(err)}`,
					});
				}
			}
			this.ref.setFocused(written);
			return { ok: true, goal: written, task: updatedTask };
		} finally {
			lock.release();
		}
	}

	/**
	 * Persist the focused goal: bump updatedAt, merge objective from disk, write
	 * active or archive. Serialized by the per-goal lock with a short bounded
	 * budget; if another process bumped the revision meanwhile, the persist is
	 * skipped (returns null) so a stale usage/updatedAt snapshot never
	 * overwrites a concurrent authoritative change.
	 */
	persist(ctx: GoalServiceContext): GoalRecord | null {
		const current = this.ref.getFocused();
		if (!current) return null;
		const capturedRevision = current.revision ?? 0;
		let lock: GoalLock;
		try {
			lock = acquireGoalLock(ctx, current.id, { attempts: 10, retryMs: 25 });
		} catch {
			// Another writer holds the goal lock; skip this persist tick.
			return null;
		}
		try {
			const freshDisk = this.readFreshDiskGoal(ctx, current);
			if (!freshDisk || (freshDisk.revision ?? 0) !== capturedRevision) {
				return null;
			}
			const merged = mergeGoalPromptFromDisk(ctx, { ...current, updatedAt: nowIso(), revision: capturedRevision + 1 });
			const written = merged.status === "complete" ? archiveGoalFile(ctx, merged) : writeActiveGoalFile(ctx, merged);
			this.ref.setFocused(written);
			return written;
		} finally {
			lock.release();
		}
	}

	/** Create a goal: write active file → ledger → memory/focus commit. */
	create(ctx: GoalServiceContext, spec: { goal: GoalRecord; ledger?: GoalLedgerEvent[] }): GoalMutationResult {
		const previousGoalId = this.ref.getFocused()?.id ?? null;
		const written = writeActiveGoalFile(ctx, sanitizeGoalPaths(ctx, spec.goal));
		if (spec.ledger) {
			for (const event of spec.ledger) {
				const append = appendGoalEvent(ctx, event);
				if (!append.ok) {
					// Best-effort ledger; creation still succeeds.
					this.ref.onDiagnostic({
						severity: "warning",
						source: "ledger",
						goalId: "goalId" in event ? event.goalId : undefined,
						eventType: event.type,
						message: `Ledger append failed for ${event.type}${"goalId" in event ? ` (goal ${event.goalId})` : ""}: ${String(append.error)}`,
					});
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
			const append = appendGoalEvent(ctx, event);
			if (!append.ok) {
				// Ledger append failure must not crash the surrounding flow, but it
				// stays observable through the diagnostic hook.
				this.ref.onDiagnostic({
					severity: "warning",
					source: "ledger",
					goalId: "goalId" in event ? event.goalId : undefined,
					eventType: event.type,
					message: `Ledger append failed for ${event.type}${"goalId" in event ? ` (goal ${event.goalId})` : ""}: ${String(append.error)}`,
				});
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
