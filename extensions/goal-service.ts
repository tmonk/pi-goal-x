import { cloneGoal, nowIso, type GoalRecord, type GoalTask } from "./goal-record.ts";
import type { GoalLedgerEvent } from "./goal-ledger.ts";
import {
	GOALS_DIR,
	archiveGoalFile,
	mergeGoalPromptFromDisk,
	parseGoalFile,
	readActiveGoalPoolView,
	resolveGoalPath,
	sanitizeGoalPaths,
	writeActiveGoalFile,
} from "./storage/goal-files.ts";
import { acquireGoalLock, type GoalLock } from "./storage/goal-lock.ts";
import { appendLedgerEventsBestEffort } from "./goal-ledger-sink.ts";
import { planReconcile } from "./goal-reconcile.ts";
import { applyTaskBatch, applyTaskUpdate, withUpdatedTask } from "./goal-task-update.ts";
import { TurnBuffer } from "./goal-turn-buffer.ts";
import { addUsage, UsageBaseline, usageSince } from "./goal-usage-baseline.ts";
import type {
	GoalMutationOutcome,
	GoalMutationResult,
	GoalMutationSpec,
	GoalServiceContext,
	GoalServiceRef,
	GoalTaskUpdateOutcome,
	GoalTaskUpdateSpec,
} from "./goal-service-types.ts";

export type { GoalMutationOutcome, GoalServiceRef, GoalTaskUpdateSpec };

const NO_FOCUSED_GOAL = "No focused goal to mutate.";
const NO_TASK_LIST = "The goal has no task list.";

function staleFocusTokenMessage(token: { goalId: string }): string {
	return `Mutation cancelled because goal ${token.goalId} is no longer focused in this session. The shared goal was not modified.`;
}

/** Ledger events a mutation spec produces for the written record; a throwing spec yields none. */
function ledgerEventsFor(spec: GoalMutationSpec, written: GoalRecord): GoalLedgerEvent[] {
	if (!spec.ledger) return [];
	try {
		return typeof spec.ledger === "function" ? spec.ledger(written) : spec.ledger;
	} catch {
		return [];
	}
}

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
 *
 * The parts that need no storage live next to it: the turn buffer
 * (goal-turn-buffer.ts), the reconcile decision (goal-reconcile.ts), task
 * updates (goal-task-update.ts) and usage merging (goal-usage-baseline.ts).
 */
/** Everything a goal file saves, in a fixed key order, except the two fields every write changes. */
function savedContent(goal: GoalRecord): string {
	const sorted = (value: unknown): unknown => {
		if (Array.isArray(value)) return value.map(sorted);
		if (value === null || typeof value !== "object") return value;
		return Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([key, item]) => [key, sorted(item)]));
	};
	const { updatedAt: _updatedAt, revision: _revision, ...rest } = goal;
	return JSON.stringify(sorted(rest));
}

export class GoalService {
	private readonly ref: GoalServiceRef;
	private readonly usage = new UsageBaseline();
	private readonly turn = new TurnBuffer();

	constructor(ref: GoalServiceRef) {
		this.ref = ref;
	}

	/** Open (or reopen) the per-turn transaction for the focused goal. */
	beginTurn(ctx: GoalServiceContext, goalId: string | null): void {
		if (this.turn.active) {
			this.flushTurn(ctx);
			// Lock contention must not discard the previous transaction. Keep it
			// open so the next turn boundary retries the same buffered write.
			if (this.turn.active) return;
		}
		this.turn.open(ctx, goalId, this.ref.getFocused());
	}

	/**
	 * Flush the buffered transaction: one lock acquire, one (archived or
	 * active) goal-file write with a revision bump, one batched ledger append.
	 * No-op when nothing was buffered. Returns the written record or null.
	 */
	flushTurn(ctx: GoalServiceContext): GoalRecord | null {
		if (!this.turn.active) return null;
		ctx = this.turn.context ?? ctx;
		this.turn.flushError = null;
		const goal = this.turn.goal;
		if (!goal) {
			this.turn.active = false;
			return null;
		}
		let lock: GoalLock;
		try {
			lock = acquireGoalLock(ctx, goal.id);
		} catch {
			this.turn.flushError = "Goal storage is locked; pending changes have not been persisted.";
			// Another writer holds the lock; preserve the buffer so a later turn
			// boundary can retry it instead of silently losing the mutation.
			return null;
		}
		try {
			const freshDisk = this.readFreshDiskGoal(ctx, goal);
			const expected = this.turn.base ?? goal;
			if (!freshDisk || (freshDisk.revision ?? 0) !== (expected.revision ?? 0)) {
				this.rejectConflictedTurn(ctx, goal, expected, freshDisk);
				return null;
			}
			const next = { ...goal, revision: (freshDisk.revision ?? 0) + 1 };
			const written = this.turn.archive || next.status === "complete"
				? archiveGoalFile(ctx, next)
				: writeActiveGoalFile(ctx, next);
			this.turn.active = false;
			this.appendLedger(ctx, this.turn.ledger);
			this.usage.track(written.id, written.usage);
			if (this.ref.getFocusedGoalId() === written.id) this.ref.setFocused(written);
			else this.ref.getPool().set(written.id, written);
			return written;
		} finally {
			lock.release();
		}
	}

	/**
	 * Reject the speculative transaction: never overwrite another writer. The
	 * session keeps its own usage delta on top of the disk record when the goal
	 * still exists, and forgets the goal when it is gone.
	 */
	private rejectConflictedTurn(ctx: GoalServiceContext, goal: GoalRecord, expected: GoalRecord, freshDisk: GoalRecord | null): void {
		const message = `Goal ${goal.id} changed in another process; buffered changes were rejected. Refresh and retry.`;
		this.turn.flushError = message;
		this.turn.reject();
		if (freshDisk && this.ref.getFocusedGoalId() === goal.id) {
			this.ref.setFocused({ ...freshDisk, usage: addUsage(freshDisk.usage, usageSince(goal.usage, expected.usage)) });
			this.usage.track(freshDisk.id, freshDisk.usage);
		} else if (!freshDisk) {
			this.ref.getPool().delete(goal.id);
			if (this.ref.getFocusedGoalId() === goal.id) {
				this.ref.assignFocusedGoalId(null);
				this.ref.onFocusedGoalLost(goal.id, ctx);
			}
		}
		this.ref.onDiagnostic({ severity: "warning", source: "storage", goalId: goal.id, message });
	}

	/** Completion must never audit state that failed to flush. */
	flushForAudit(ctx: GoalServiceContext): string | null {
		this.flushTurn(ctx);
		return this.turn.flushError;
	}

	/** End the turn: flush any pending transaction (safe to call always). */
	endTurn(ctx: GoalServiceContext): void {
		this.flushTurn(ctx);
	}

	/** True while the transaction buffer is open. */
	isTurnBuffered(): boolean {
		return this.turn.active;
	}

	private appendLedger(ctx: GoalServiceContext, events: GoalLedgerEvent[]): boolean {
		return appendLedgerEventsBestEffort(ctx, events, diagnostic => this.ref.onDiagnostic(diagnostic));
	}

	/** Safe focused record reconciliation from disk. */
	reconcileFocused(ctx: GoalServiceContext, opts: { preserveMemoryUsage?: boolean } = {}): boolean {
		const plan = planReconcile({
			current: this.ref.getFocused(),
			focusedGoalId: this.ref.getFocusedGoalId(),
			view: this.ref.getPool(),
			source: readActiveGoalPoolView(ctx),
			buffered: this.turn.active ? this.turn.goal : null,
			preserveMemoryUsage: opts.preserveMemoryUsage,
		});
		switch (plan.kind) {
			case "unchanged":
				if (plan.goal) this.ref.onReconciled(plan.goal);
				return true;
			case "pool-only":
				this.ref.replacePool(plan.pool);
				return true;
			case "focus":
				this.ref.replacePool(plan.pool);
				plan.pool.set(plan.goal.id, plan.goal);
				this.ref.assignFocusedGoalId(plan.goal.id);
				if (plan.fromDisk) {
					this.ref.onReconciled(plan.goal);
					this.usage.track(plan.goal.id, plan.goal.usage);
				}
				return true;
			case "lost":
				this.ref.replacePool(plan.pool);
				this.ref.assignFocusedGoalId(null);
				this.ref.onFocusedGoalLost(plan.lostGoalId, ctx);
				return false;
		}
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
		if (!current) return { ok: false, message: NO_FOCUSED_GOAL };

		// 2. expected goal id + focus revision validation.
		if (spec.expectedGoalId != null && current.id !== spec.expectedGoalId) {
			return { ok: false, message: `Mutation rejected: expected goal ${spec.expectedGoalId} but the focused goal is ${current.id}.` };
		}
		if (spec.focusToken && !this.ref.isTokenCurrent(spec.focusToken)) {
			return { ok: false, message: staleFocusTokenMessage(spec.focusToken) };
		}

		// During a turn the mutation is buffered in memory (no lock, no disk write
		// yet); the flush acquires the lock, writes, and appends the ledger once.
		if (this.turn.active) return this.applyBuffered(ctx, spec, current);
		return this.applyLocked(ctx, spec, current);
	}

	/** Buffered mutation path: the flush at turn end does the single write + ledger batch. */
	private applyBuffered(ctx: GoalServiceContext, spec: GoalMutationSpec, current: GoalRecord): GoalMutationOutcome {
		if (this.turn.goalId !== null && current.id !== this.turn.goalId) {
			// Focus changed mid-turn: persist the previous buffer first.
			this.flushTurn(ctx);
			if (this.turn.active) return { ok: false, message: this.turn.flushError ?? "Previous goal changes are still awaiting persistence." };
			this.turn.switchTo(current);
		}
		if (!this.turn.goal) this.turn.stage(current);
		const mutated = sanitizeGoalPaths(ctx, {
			...spec.mutate(cloneGoal(current)),
			revision: (current.revision ?? 0) + 1,
		});
		this.turn.ledger.push(...ledgerEventsFor(spec, mutated));
		this.turn.goal = mutated;
		this.turn.archive = spec.archive === true;
		return this.commitMutation(spec, current.id, mutated);
	}

	/** Immediate mutation path: exclusive per-goal lock + optimistic revision check. */
	private applyLocked(ctx: GoalServiceContext, spec: GoalMutationSpec, current: GoalRecord): GoalMutationOutcome {
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
			const mutated = {
				...spec.mutate(cloneGoal(base)),
				revision: capturedRevision + 1,
			};

			// 4. authoritative file write (active or archive). A failure here throws
			//    and prevents any memory/ledger/focus/archive commit.
			const written = spec.archive ? archiveGoalFile(ctx, mutated) : writeActiveGoalFile(ctx, mutated);

			// 5. ledger append best effort.
			this.appendLedger(ctx, ledgerEventsFor(spec, written));

			return this.commitMutation(spec, current.id, written);
		} finally {
			lock.release();
		}
	}

	/** In-memory pool/focus commit and runtime/UI effects of a written mutation. */
	private commitMutation(spec: GoalMutationSpec, previousGoalId: string, written: GoalRecord): GoalMutationResult {
		const commitFocused = spec.commitFocused !== false;
		if (commitFocused) {
			this.ref.setFocused(written);
			this.usage.track(written.id, written.usage);
		}
		const goalId = commitFocused ? written.id : this.ref.getFocusedGoalId();
		const focusChanged = commitFocused && previousGoalId !== written.id;
		if (focusChanged) this.ref.onFocusChanged(previousGoalId, written.id);
		return { ok: true, goal: written, previousGoalId, goalId, focusChanged };
	}

	/**
	 * Disk-fresh single-task transaction. During a turn it applies to the
	 * buffered goal in memory (validation still runs against the in-turn
	 * state) and the flush writes once. Otherwise:
	 *  1. reconcile the focused record;
	 *  2. validate focus token/id;
	 *  3. acquire the per-goal lock and re-read the authoritative file;
	 *  4. a stale writer retries ONCE with the fresh state — the transition
	 *     validation re-checks that the same task and relevant status/structure
	 *     are unchanged, so a genuinely concurrent edit is rejected rather than
	 *     silently merged;
	 *  5. load the fresh task, validate the transition, update only that task;
	 *  6. write with an incremented revision, append the ledger, and commit.
	 * Expected races (removed task, removed task list) return typed failures
	 * instead of throwing.
	 */
	updateTask(ctx: GoalServiceContext, spec: GoalTaskUpdateSpec): GoalTaskUpdateOutcome {
		if (this.turn.active) return this.updateTaskBuffered(ctx, spec);
		return this.updateTaskAttempt(ctx, spec, 1);
	}

	private updateTaskBuffered(ctx: GoalServiceContext, spec: GoalTaskUpdateSpec): GoalTaskUpdateOutcome {
		const current = this.turn.goal ?? this.ref.getFocused();
		if (!current) return { ok: false, message: NO_FOCUSED_GOAL };
		if (spec.focusToken && !this.ref.isTokenCurrent(spec.focusToken)) {
			return { ok: false, message: staleFocusTokenMessage(spec.focusToken) };
		}
		if (!current.taskList) return { ok: false, message: NO_TASK_LIST };
		const applied = applyTaskUpdate(current.taskList.tasks, spec);
		if (!applied.ok) return applied;
		const { updatedTask, updatedTasks } = applied;
		const mutated = sanitizeGoalPaths(ctx, withUpdatedTask(current, spec, updatedTask, updatedTasks, (current.revision ?? 0) + 1));
		this.turn.ledger.push(...this.taskLedgerEvents(spec, mutated, updatedTask));
		this.turn.goal = mutated;
		this.ref.setFocused(mutated);
		return { ok: true, goal: mutated, task: updatedTask };
	}

	/** Ordered all-or-nothing batch. Each validator sees earlier changes in the clone. */
	updateTasks(ctx: GoalServiceContext, specs: GoalTaskUpdateSpec[]): GoalMutationOutcome {
		if (!this.reconcileFocused(ctx)) return { ok: false, message: NO_FOCUSED_GOAL };
		const current = this.ref.getFocused();
		if (!current?.taskList) return { ok: false, message: NO_TASK_LIST };
		let lock: GoalLock | undefined;
		try {
			let base = current;
			if (!this.turn.active) {
				lock = acquireGoalLock(ctx, current.id);
				const fresh = this.readFreshDiskGoal(ctx, current);
				if (!fresh || (fresh.revision ?? 0) !== (current.revision ?? 0)) return { ok: false, message: "The goal changed in another process; no updates applied. Refresh and retry." };
				if (fresh.status !== "active" || !fresh.taskList) return { ok: false, message: "The persisted goal is no longer active with tasks; no updates applied." };
				base = { ...fresh, usage: current.usage };
			}
			const next = cloneGoal(base);
			const batch = applyTaskBatch(next, specs, token => this.ref.isTokenCurrent(token));
			if (!batch.ok) return batch;
			if (this.turn.active) return this.apply(ctx, { reconcile: false, expectedGoalId: current.id, focusToken: specs[0]?.focusToken, mutate: () => next, ledger: batch.events });
			const written = writeActiveGoalFile(ctx, { ...next, revision: (base.revision ?? 0) + 1 });
			this.appendLedger(ctx, batch.events);
			this.usage.track(written.id, written.usage);
			this.ref.setFocused(written);
			return { ok: true, goal: written, previousGoalId: current.id, goalId: written.id, focusChanged: false };
		} finally { lock?.release(); }
	}

	private updateTaskAttempt(ctx: GoalServiceContext, spec: GoalTaskUpdateSpec, retriesLeft: number): GoalTaskUpdateOutcome {
		if (!this.reconcileFocused(ctx)) {
			return { ok: false, message: "The focused goal was lost during reconciliation; the task was not updated." };
		}
		const current = this.ref.getFocused();
		if (!current) return { ok: false, message: NO_FOCUSED_GOAL };
		if (spec.focusToken && !this.ref.isTokenCurrent(spec.focusToken)) {
			return { ok: false, message: staleFocusTokenMessage(spec.focusToken) };
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
				// Retry once against the fresh state; the transition validation
				// below is the guard for task status/structure changes.
				if (retriesLeft > 0) return this.updateTaskAttempt(ctx, spec, retriesLeft - 1);
				return { ok: false, message: `Goal ${current.id} was modified by another process (revision ${capturedRevision} -> ${diskRevision}); current revision is ${diskRevision}. The task was not updated.` };
			}
			const base = mergeGoalPromptFromDisk(ctx, current);
			if (!base.taskList) return { ok: false, message: NO_TASK_LIST };
			const applied = applyTaskUpdate(base.taskList.tasks, spec);
			if (!applied.ok) return applied;
			const { updatedTask, updatedTasks } = applied;
			const written = writeActiveGoalFile(ctx, withUpdatedTask(base, spec, updatedTask, updatedTasks, capturedRevision + 1));
			this.appendLedger(ctx, this.taskLedgerEvents(spec, written, updatedTask));
			this.ref.setFocused(written);
			return { ok: true, goal: written, task: updatedTask };
		} finally {
			lock.release();
		}
	}

	/** Ledger events for a task update. An unexpected spec error keeps the state transition and is reported. */
	private taskLedgerEvents(spec: GoalTaskUpdateSpec, written: GoalRecord, updatedTask: GoalTask): GoalLedgerEvent[] {
		if (!spec.ledger) return [];
		try {
			return spec.ledger(written, updatedTask);
		} catch (err) {
			this.ref.onDiagnostic({
				severity: "warning",
				source: "ledger",
				goalId: spec.taskId,
				message: `Ledger spec error during task update: ${String(err)}`,
			});
			return [];
		}
	}

	/** Write the record (archived once complete), record it as the usage baseline and focus it. */
	private writeFocused(ctx: GoalServiceContext, record: GoalRecord): GoalRecord {
		const written = record.status === "complete" ? archiveGoalFile(ctx, record) : writeActiveGoalFile(ctx, record);
		this.usage.track(written.id, written.usage);
		this.ref.setFocused(written);
		return written;
	}

	/**
	 * Persist the focused goal: bump updatedAt, merge objective from disk, write
	 * active or archive. Serialized by the per-goal lock with a short bounded
	 * budget. If another process bumped the revision meanwhile, the persist
	 * does not clobber the disk's authoritative fields — instead the session's
	 * additive usage/accounting delta since the last baseline is merged onto
	 * the disk record (concurrent work is never silently dropped).
	 */
	persist(ctx: GoalServiceContext): GoalRecord | null {
		const current = this.ref.getFocused();
		if (!current) return null;
		// Within a turn the persist is buffered; the flush at turn end performs
		// the single write + ledger batch.
		if (this.turn.active) {
			const next = { ...current, updatedAt: nowIso() };
			this.turn.goal = next;
			this.ref.setFocused(next);
			return next;
		}
		const capturedRevision = current.revision ?? 0;
		let lock: GoalLock;
		try {
			lock = acquireGoalLock(ctx, current.id, { attempts: 4, retryMs: 25 }); // 100ms bound
		} catch {
			// Another writer holds the goal lock; skip this persist tick.
			return null;
		}
		try {
			const freshDisk = this.readFreshDiskGoal(ctx, current);
			if (!freshDisk) return null;
			if ((freshDisk.revision ?? 0) !== capturedRevision) {
				// Revision moved concurrently: merge only the additive usage
				// delta from this session onto the disk record and advance its
				// revision. All other fields stay authoritative from disk.
				const delta = this.usage.deltaFor(current, freshDisk);
				if (delta.tokens === 0 && delta.seconds === 0) return null;
				const merged = mergeGoalPromptFromDisk(ctx, {
					...freshDisk,
					usage: addUsage(freshDisk.usage, delta),
					updatedAt: nowIso(),
					revision: (freshDisk.revision ?? 0) + 1,
				});
				return this.writeFocused(ctx, merged);
			}
			// The turn-end flush already saved this goal. When the file holds exactly
			// what memory holds, a write would only bump the revision and the time,
			// so skip it: the second goal write and pool snapshot rewrite of every turn.
			if (savedContent(freshDisk) === savedContent(current)) return current;
			return this.writeFocused(ctx, mergeGoalPromptFromDisk(ctx, { ...current, updatedAt: nowIso(), revision: capturedRevision + 1 }));
		} finally {
			lock.release();
		}
	}

	/** Create a goal: write active file → ledger → memory/focus commit. */
	create(ctx: GoalServiceContext, spec: { goal: GoalRecord; ledger?: GoalLedgerEvent[] }): GoalMutationResult {
		const previousGoalId = this.ref.getFocused()?.id ?? null;
		const written = writeActiveGoalFile(ctx, spec.goal);
		if (spec.ledger) this.appendLedger(ctx, spec.ledger);
		this.ref.setFocused(written);
		this.usage.track(written.id, written.usage);
		const focusChanged = previousGoalId !== written.id;
		if (focusChanged) this.ref.onFocusChanged(previousGoalId, written.id);
		return { ok: true, goal: written, previousGoalId, goalId: written.id, focusChanged };
	}

	/** Audit outcomes can bypass the current turn without flushing unrelated work. */
	appendEvents(ctx: GoalServiceContext, events: GoalLedgerEvent[], opts: {immediate?: boolean} = {}): boolean {
		if (this.turn.active && !opts.immediate && this.turn.sameStorage(ctx)) {
			this.turn.ledger.push(...events);
			return true;
		}
		return this.appendLedger(ctx, events);
	}

	/** Detach an outgoing session's buffer after its final persistence attempt. */
	endSession(ctx?: GoalServiceContext): void {
		try {
			const storage = this.turn.context ?? ctx;
			if (storage) this.flushTurn(storage);
		} finally {
			if (this.turn.active) this.ref.onDiagnostic({severity: "warning", source: "storage", message: this.turn.flushError ?? "Outgoing goal changes could not be persisted before session replacement."});
			this.turn.reset();
			this.usage.clear();
		}
	}
}
