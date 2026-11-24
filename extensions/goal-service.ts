import { goalStorageContext, goalStorageRoot } from "./storage/goal-root.ts";
import { cloneGoal, nowIso, type GoalFocusReason, type GoalRecord, type GoalTask, type GoalUsage } from "./goal-record.ts";
import { appendGoalEvent, appendGoalEvents, type GoalLedgerEvent } from "./goal-ledger.ts";
import { findTaskInTree, updateTaskInTree } from "./goal-policy.ts";
import {
	GOALS_DIR,
	archiveGoalFile,
	mergeGoalPromptFromDisk,
	parseGoalFile,
	readActiveGoalPoolView,
	resolveGoalPath,
	sanitizeGoalPaths,
	writeActiveGoalFile,
	type GoalFileContext,
} from "./storage/goal-files.ts";
import { acquireGoalLock, type GoalLock } from "./storage/goal-lock.ts";
import { mergeFocusedGoalWithDisk } from "./goal-pool.ts";

interface GoalDiagnostic {
	severity: "warning";
	source: "ledger" | "storage";
	goalId?: string;
	eventType?: string;
	message: string;
}

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

type GoalServiceContext = GoalFileContext;

interface GoalMutationSpec {
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

interface GoalMutationResult {
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

type GoalTaskUpdateOutcome = { ok: true; goal: GoalRecord; task: GoalTask } | { ok: false; message: string };

/** Find the spec's task, validate it and apply its update, without touching the goal. */
function applyTaskUpdate(tasks: GoalTask[], spec: GoalTaskUpdateSpec): { ok: false; message: string } | { ok: true; updatedTask: GoalTask; updatedTasks: GoalTask[] } {
	const task = findTaskInTree(tasks, spec.taskId);
	if (!task) return { ok: false, message: `Task "${spec.taskId}" not found.` };
	if (spec.validate) {
		const gate = spec.validate(task);
		if (!gate.ok) return gate;
	}
	const updated = spec.update(task);
	if (typeof updated === "object" && "ok" in updated && !updated.ok) return updated;
	const updatedTask = updated as GoalTask;
	return { ok: true, updatedTask, updatedTasks: updateTaskInTree(tasks, spec.taskId, () => updatedTask) };
}

const NO_FOCUSED_GOAL = "No focused goal to mutate.";
const NO_TASK_LIST = "The goal has no task list.";

function staleFocusTokenMessage(token: { goalId: string }): string {
	return `Mutation cancelled because goal ${token.goalId} is no longer focused in this session. The shared goal was not modified.`;
}

/** The goal with one task's update applied, stamped with `revision`. */
function withUpdatedTask(base: GoalRecord, spec: GoalTaskUpdateSpec, updatedTask: GoalTask, updatedTasks: GoalTask[], revision: number): GoalRecord {
	return {
		...base,
		taskList: { ...base.taskList!, tasks: updatedTasks },
		// Execution focus: start sets it explicitly; completing or skipping the
		// current task clears it.
		currentTaskId: resolveUpdatedCurrentTaskId(spec, base.currentTaskId, updatedTask),
		updatedAt: nowIso(),
		revision,
	};
}

/** Where every task of a tree lives, kept current as batch updates replace tasks. */
class TaskLocator {
	private readonly locations = new Map<string, { tasks: GoalTask[]; index: number }>();

	constructor(tasks: GoalTask[]) {
		this.add(tasks);
	}

	find(taskId: string): GoalTask | undefined {
		const location = this.locations.get(taskId);
		return location?.tasks[location.index];
	}

	/** Swap `task` for `updated` in place, following id and subtask changes. */
	replace(task: GoalTask, updated: GoalTask): void {
		const location = this.locations.get(task.id)!;
		location.tasks[location.index] = updated;
		if (updated.id !== task.id) {
			this.locations.delete(task.id);
			this.locations.set(updated.id, location);
		}
		if (updated.subtasks !== task.subtasks) {
			if (task.subtasks) this.remove(task.subtasks);
			if (updated.subtasks) this.add(updated.subtasks);
		}
	}

	private add(tasks: GoalTask[]): void {
		for (let index = 0; index < tasks.length; index++) {
			const task = tasks[index]!;
			this.locations.set(task.id, { tasks, index });
			if (task.subtasks) this.add(task.subtasks);
		}
	}

	private remove(tasks: GoalTask[]): void {
		for (const task of tasks) {
			this.locations.delete(task.id);
			if (task.subtasks) this.remove(task.subtasks);
		}
	}
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

function resolveUpdatedCurrentTaskId(spec: GoalTaskUpdateSpec, current: string | undefined, updatedTask: GoalTask): string | undefined {
	if (spec.setCurrentTaskId !== undefined) return spec.setCurrentTaskId;
	const terminal = updatedTask.status === "complete" || updatedTask.status === "skipped";
	if (terminal && current === spec.taskId) return undefined;
	return current;
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
 */
export class GoalService {
	private readonly ref: GoalServiceRef;

	/**
	 * The usage this session last wrote to disk for a goal (or the disk usage
	 * the session's accounting is relative to after load/reconcile). The
	 * baseline for additive usage merging: on a persist revision conflict the
	 * delta since this baseline is merged onto the disk record instead of the
	 * local usage being dropped.
	 */
	private lastPersistedUsage: { goalId: string; tokensUsed: number; activeSeconds: number } | null = null;

	/**
	 * Per-turn transaction buffer (P1-3): task/status/usage mutations and
	 * ledger events accumulate in memory during a turn and flush once — one
	 * lock acquire, one goal-file write, one ledger batch — at turn end or at
	 * an explicit flush boundary (audit dispatch, pause/stop, focus change,
	 * session reload). Reads during the turn overlay the buffered goal so
	 * in-turn mutations are always visible; the optimistic revision check runs
	 * at flush time.
	 */
	private flushError: string | null = null;
	private turnBase: GoalRecord | null = null;
	private turnContext: GoalServiceContext | null = null;

	private turn: { active: boolean; goalId: string | null; goal: GoalRecord | null; archive: boolean; ledger: GoalLedgerEvent[] } = {
		active: false,
		goalId: null,
		goal: null,
		archive: false,
		ledger: [],
	};

	/** Open (or reopen) the per-turn transaction for the focused goal. */
	beginTurn(ctx: GoalServiceContext, goalId: string | null): void {
		if (this.turn.active) {
			this.flushTurn(ctx);
			// Lock contention must not discard the previous transaction. Keep it
			// open so the next turn boundary retries the same buffered write.
			if (this.turn.active) return;
		}
		this.turn = { active: true, goalId, goal: null, archive: false, ledger: [] };
		this.turnContext = goalStorageContext(ctx);
		const focused = this.ref.getFocused();
		this.turnBase = focused ? {...focused, usage: {...focused.usage}} : null;
		this.flushError = null;
	}

	/**
	 * Flush the buffered transaction: one lock acquire, one (archived or
	 * active) goal-file write with a revision bump, one batched ledger append.
	 * No-op when nothing was buffered. Returns the written record or null.
	 */
	flushTurn(ctx: GoalServiceContext): GoalRecord | null {
		if (!this.turn.active) return null;
		ctx = this.turnContext ?? ctx;
		this.flushError = null;
		const goal = this.turn.goal;
		if (!goal) {
			this.turn.active = false;
			return null;
		}
		let lock: GoalLock;
		try {
			lock = acquireGoalLock(ctx, goal.id);
		} catch {
			this.flushError = "Goal storage is locked; pending changes have not been persisted.";
			// Another writer holds the lock; preserve the buffer so a later turn
			// boundary can retry it instead of silently losing the mutation.
			return null;
		}
		try {
			const freshDisk = this.readFreshDiskGoal(ctx, goal);
			const expected = this.turnBase ?? goal;
			if (!freshDisk || (freshDisk.revision ?? 0) !== (expected.revision ?? 0)) {
				this.rejectConflictedTurn(ctx, goal, expected, freshDisk);
				return null;
			}
			const base = freshDisk;
			const next = { ...goal, revision: (base.revision ?? 0) + 1 };
			const written = this.turn.archive || next.status === "complete"
				? archiveGoalFile(ctx, next)
				: writeActiveGoalFile(ctx, next);
			this.turn.active = false;
			this.appendLedgerEventsBestEffort(ctx, this.turn.ledger);
			this.trackBaseline(written.id, written.usage);
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
		this.flushError = message;
		this.turn.active = false;
		this.turn.goal = null;
		this.turn.ledger = [];
		if (freshDisk && this.ref.getFocusedGoalId() === goal.id) {
			const tokens = Math.max(0, goal.usage.tokensUsed - expected.usage.tokensUsed);
			const seconds = Math.max(0, goal.usage.activeSeconds - expected.usage.activeSeconds);
			this.ref.setFocused({ ...freshDisk, usage: { tokensUsed: freshDisk.usage.tokensUsed + tokens, activeSeconds: freshDisk.usage.activeSeconds + seconds } });
			this.trackBaseline(freshDisk.id, freshDisk.usage);
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
		return this.flushError;
	}

	/** End the turn: flush any pending transaction (safe to call always). */
	endTurn(ctx: GoalServiceContext): void {
		this.flushTurn(ctx);
	}

	/** True while the transaction buffer is open. */
	isTurnBuffered(): boolean {
		return this.turn.active;
	}

	constructor(ref: GoalServiceRef) {
		this.ref = ref;
	}

	/** Record the usage value the focused goal's in-memory accounting builds on. */
	private trackBaseline(goalId: string, usage: GoalUsage): void {
		this.lastPersistedUsage = { goalId, tokensUsed: usage.tokensUsed, activeSeconds: usage.activeSeconds };
	}

	/**
	 * Session-local usage delta since the last recorded baseline (clamped at
	 * zero so usage is never reduced). Falls back to the disk usage when this
	 * session has no baseline for the goal (never persisted/reconciled it).
	 */
	private usageDelta(current: GoalRecord, disk: GoalRecord): { tokens: number; seconds: number } {
		const baseline = this.lastPersistedUsage?.goalId === current.id
			? this.lastPersistedUsage
			: { goalId: current.id, tokensUsed: disk.usage.tokensUsed, activeSeconds: disk.usage.activeSeconds };
		return {
			tokens: Math.max(0, current.usage.tokensUsed - baseline.tokensUsed),
			seconds: Math.max(0, current.usage.activeSeconds - baseline.activeSeconds),
		};
	}

	/**
	 * Append ledger events without making them part of the authoritative state
	 * transaction. A batch is the common path; individual retries preserve the
	 * existing best-effort behavior and keep failures observable per event.
	 */
	private appendLedgerEventsBestEffort(ctx: GoalServiceContext, events: GoalLedgerEvent[]): boolean {
		if (events.length === 0) return true;
		if (events.length > 1 && appendGoalEvents(ctx, events).ok) return true;
		let success = true;
		for (const event of events) {
			const append = appendGoalEvent(ctx, event);
			if (!append.ok) {
				success = false;
				this.ref.onDiagnostic({
					severity: "warning",
					source: "ledger",
					goalId: "goalId" in event ? event.goalId : undefined,
					eventType: event.type,
					message: `Ledger append failed for ${event.type}${"goalId" in event ? ` (goal ${event.goalId})` : ""}: ${String(append.error)}`,
				});
			}
		}
		return success;
	}

	/** Safe focused record reconciliation from disk. */
	reconcileFocused(ctx: GoalServiceContext, opts: { preserveMemoryUsage?: boolean } = {}): boolean {
		const current = this.ref.getFocused();
		const source = readActiveGoalPoolView(ctx);
		const focused = this.ref.getFocusedGoalId();
		const view = this.ref.getPool();
		const buffered = this.turn.active ? this.turn.goal : null;
		let unchanged = source.size === view.size && (!focused || source.has(focused));
		if (unchanged) for (const [id, goal] of source) {
			if (view.get(id) !== (buffered?.id === id ? buffered : goal)) { unchanged = false; break; }
		}
		if (unchanged) {
			const same = focused ? view.get(focused) : undefined;
			if (same) this.ref.onReconciled(same);
			return true;
		}
		const fresh = new Map(source);
		// P1-3: overlay the buffered goal so in-turn mutations are visible to
		// every read (reconcile, get_goal, prompts) without a disk round trip.
		if (this.turn.active && this.turn.goal) fresh.set(this.turn.goal.id, this.turn.goal);
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
		this.trackBaseline(reconciled.id, reconciled.usage);
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
			if (this.turn.active) return { ok: false, message: this.flushError ?? "Previous goal changes are still awaiting persistence." };
			this.turn = { active: true, goalId: current.id, goal: current, archive: false, ledger: [] };
			this.turnBase = current;
		}
		if (!this.turn.goal) {
			this.turn.goal = current;
			this.turn.goalId = current.id;
			if (this.turnBase?.id !== current.id) this.turnBase = { ...current, usage: { ...current.usage } };
		}
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
			this.appendLedgerEventsBestEffort(ctx, ledgerEventsFor(spec, written));

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
			this.trackBaseline(written.id, written.usage);
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
			const locator = new TaskLocator(next.taskList!.tasks);
			const events: GoalLedgerEvent[] = [];
			for (const spec of specs) {
				if (spec.focusToken && !this.ref.isTokenCurrent(spec.focusToken)) return { ok: false, message: "The focused goal changed; no updates applied." };
				const task = locator.find(spec.taskId);
				if (!task) return { ok: false, message: `Task "${spec.taskId}" not found.` };
				const valid = spec.validate?.(task);
				if (valid && !valid.ok) return valid;
				const updated = spec.update(task);
				if ("ok" in updated && !updated.ok) return updated;
				const updatedTask = updated as GoalTask;
				locator.replace(task, updatedTask);
				next.currentTaskId = resolveUpdatedCurrentTaskId(spec, next.currentTaskId, updatedTask);
				next.updatedAt = nowIso();
				if (spec.ledger) events.push(...spec.ledger(next, updatedTask));
			}
			if (this.turn.active) return this.apply(ctx, { reconcile: false, expectedGoalId: current.id, focusToken: specs[0]?.focusToken, mutate: () => next, ledger: events });
			const written = writeActiveGoalFile(ctx, { ...next, revision: (base.revision ?? 0) + 1 });
			this.appendLedgerEventsBestEffort(ctx, events);
			this.trackBaseline(written.id, written.usage);
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
			this.appendLedgerEventsBestEffort(ctx, this.taskLedgerEvents(spec, written, updatedTask));
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
		this.trackBaseline(written.id, written.usage);
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
		// P1-3: within a turn the persist is buffered; the flush at turn end
		// performs the single write + ledger batch.
		if (this.turn.active) {
			const next = { ...current, updatedAt: nowIso() };
			this.turn.goal = next;
			this.ref.setFocused(next);
			return next;
		}
		const capturedRevision = current.revision ?? 0;
		let lock: GoalLock;
		try {
			lock = acquireGoalLock(ctx, current.id, { attempts: 4, retryMs: 25 }); // P1-5: 100ms bound
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
				const { tokens, seconds } = this.usageDelta(current, freshDisk);
				if (tokens === 0 && seconds === 0) return null;
				const merged = mergeGoalPromptFromDisk(ctx, {
					...freshDisk,
					usage: {
						tokensUsed: freshDisk.usage.tokensUsed + tokens,
						activeSeconds: freshDisk.usage.activeSeconds + seconds,
					},
					updatedAt: nowIso(),
					revision: (freshDisk.revision ?? 0) + 1,
				});
				return this.writeFocused(ctx, merged);
			}
			return this.writeFocused(ctx, mergeGoalPromptFromDisk(ctx, { ...current, updatedAt: nowIso(), revision: capturedRevision + 1 }));
		} finally {
			lock.release();
		}
	}

	/** Create a goal: write active file → ledger → memory/focus commit. */
	create(ctx: GoalServiceContext, spec: { goal: GoalRecord; ledger?: GoalLedgerEvent[] }): GoalMutationResult {
		const previousGoalId = this.ref.getFocused()?.id ?? null;
		const written = writeActiveGoalFile(ctx, spec.goal);
		if (spec.ledger) this.appendLedgerEventsBestEffort(ctx, spec.ledger);
		this.ref.setFocused(written);
		this.trackBaseline(written.id, written.usage);
		const focusChanged = previousGoalId !== written.id;
		if (focusChanged) this.ref.onFocusChanged(previousGoalId, written.id);
		return { ok: true, goal: written, previousGoalId, goalId: written.id, focusChanged };
	}

	/** Audit outcomes can bypass the current turn without flushing unrelated work. */
	appendEvents(ctx: GoalServiceContext, events: GoalLedgerEvent[], opts: {immediate?: boolean} = {}): boolean {
		if (this.turn.active && !opts.immediate && this.turnContext && goalStorageRoot(this.turnContext) === goalStorageRoot(ctx)) {
			this.turn.ledger.push(...events);
			return true;
		}
		return this.appendLedgerEventsBestEffort(ctx, events);
	}

	/** Detach an outgoing session's buffer after its final persistence attempt. */
	endSession(ctx?: GoalServiceContext): void {
		try {
			const storage = this.turnContext ?? ctx;
			if (storage) this.flushTurn(storage);
		} finally {
			if (this.turn.active) this.ref.onDiagnostic({severity: "warning", source: "storage", message: this.flushError ?? "Outgoing goal changes could not be persisted before session replacement."});
			this.turn = {active: false, goalId: null, goal: null, archive: false, ledger: []};
			this.turnContext = null;
			this.turnBase = null;
			this.lastPersistedUsage = null;
		}
	}
}
