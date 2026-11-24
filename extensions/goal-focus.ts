import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { GoalInterruption } from "./goal-interruption.ts";
import { FOCUS_ENTRY, STATE_ENTRY } from "./goal-format.ts";
import { resolveSessionFocus } from "./goal-pool.ts";
import {
	asRecord,
	goalFocusDetails,
	normalizeGoalFocusEntry,
	normalizeGoalRecord,
	nowIso,
	type GoalFocusEntry,
	type GoalFocusReason,
	type GoalRecord,
} from "./goal-record.ts";
import type { GoalScheduler } from "./goal-scheduler.ts";
import type { GoalService } from "./goal-service.ts";
import type { GoalSessionState } from "./goal-session-state.ts";
import { loadGoalSettings } from "./settings/resolve.ts";
import { mergeGoalPromptFromDisk, readActiveGoalPoolAsync, sanitizeGoalPaths } from "./storage/goal-files.ts";
import { goalStorageContext } from "./storage/goal-root.ts";

interface GoalFocusDeps {
	pi: ExtensionAPI;
	session: GoalSessionState;
	goalService: GoalService;
	interruption(): GoalInterruption;
	scheduler(): GoalScheduler;
	persist(ctx: ExtensionContext): void;
	updateUI(ctx: ExtensionContext): void;
	clearContinuationState(): void;
	clearActiveAccounting(): void;
	clearStoppedRuntimeState(): void;
}

/**
 * Which goal this session is looking at: changing focus, dropping the focused
 * goal, recording focus in the session log, and rebuilding it all when a
 * session starts.
 */
export class GoalFocus {
	private deps: GoalFocusDeps;

	constructor(deps: GoalFocusDeps) {
		this.deps = deps;
	}

	/** Writes the focus choice into the session log so a resumed session finds it again. */
	appendEntry(goalId: string | null, reason: GoalFocusReason): void {
		const { session, pi } = this.deps;
		session.hasExplicitSessionFocus = true;
		const storageRoot = session.externalFocusRoot ? { storageRoot: session.focusStorageRoot } : {};
		pi.appendEntry(FOCUS_ENTRY, { ...goalFocusDetails(goalId, reason), ...storageRoot });
	}

	setFocus(goalId: string | null, ctx: ExtensionContext, reason: GoalFocusReason, opts: { recordLedger?: boolean } = {}): void {
		const { session, goalService } = this.deps;
		const previousGoalId = session.focusedGoalId;
		if (previousGoalId !== goalId) {
			this.deps.interruption().reset();
			if (ctx.hasUI) ctx.ui.setStatus("goal-interrupt", undefined);
			this.deps.scheduler().takeover(ctx);
			// Persist the old goal's pending writes before focus moves off it.
			goalService.flushTurn(ctx);
		}
		session.assignFocusedGoalId(goalId && session.goalsById.has(goalId) ? goalId : null);
		if (previousGoalId !== session.focusedGoalId) {
			this.deps.clearContinuationState();
			this.deps.clearActiveAccounting();
		}
		this.appendEntry(session.focusedGoalId, reason);
		try {
			if (opts.recordLedger !== false && session.focusedGoalId) {
				goalService.appendEvents(ctx, [{ type: "goal_focused", goalId: session.focusedGoalId, reason, at: nowIso() }]);
			} else if (opts.recordLedger !== false && previousGoalId) {
				goalService.appendEvents(ctx, [{ type: "goal_unfocused", reason, at: nowIso() }]);
			}
		} catch {
			// A failed ledger write must not break a focus change.
		}
		this.deps.updateUI(ctx);
	}

	/** Puts `next` in the pool, focuses it, and optionally saves it. */
	updateFocused(next: GoalRecord, ctx: ExtensionContext, shouldPersist = true): void {
		const { session } = this.deps;
		session.goalsById.set(next.id, next);
		session.assignFocusedGoalId(next.id);
		if (shouldPersist) this.deps.persist(ctx);
		this.deps.updateUI(ctx);
	}

	/** Takes the focused goal out of this session without touching its file. */
	removeFocused(ctx: ExtensionContext, reason: GoalFocusReason): void {
		const { session, goalService } = this.deps;
		goalService.flushTurn(ctx);
		if (session.focusedGoalId) session.goalsById.delete(session.focusedGoalId);
		session.assignFocusedGoalId(null);
		this.deps.clearStoppedRuntimeState();
		this.appendEntry(null, reason);
		this.deps.updateUI(ctx);
	}

	/** Replaces the focused goal (or clears it with null), resetting runtime state the change makes stale. */
	setGoal(next: GoalRecord | null, ctx: ExtensionContext, shouldPersist = true, focusReason?: GoalFocusReason): void {
		const { session } = this.deps;
		const previousGoalId = session.goal?.id ?? null;
		session.goal = next;
		const focusChanged = previousGoalId !== session.focusedGoalId;
		if (focusChanged) {
			this.deps.clearContinuationState();
			this.deps.clearActiveAccounting();
		}
		if (focusReason && focusChanged) this.appendEntry(session.focusedGoalId, focusReason);
		const goal = session.goal;
		if (!goal || goal.status !== "active" || !goal.autoContinue) this.deps.clearContinuationState();
		if (!goal || goal.status === "paused" || goal.status === "complete") this.deps.clearActiveAccounting();
		if (shouldPersist) this.deps.persist(ctx);
		this.deps.updateUI(ctx);
	}

	/** Rebuilds the pool and focus from disk and the session log when a session starts. */
	async load(ctx: ExtensionContext): Promise<void> {
		const { session } = this.deps;
		const revision = ++session.focusRevision;
		const storage = goalStorageContext(ctx);
		const entries = ctx.sessionManager.getBranch();
		const settings = loadGoalSettings(storage.cwd);
		const pool = await readActiveGoalPoolAsync(storage);
		if (revision !== session.focusRevision) return;
		// The host may invalidate a context while disk I/O is pending.
		ctx.sessionManager.getSessionId?.();
		const defaultRoot = path.resolve(ctx.cwd, ".pi/goals");
		session.focusStorageRoot = storage.goalStorageRoot;
		session.externalFocusRoot = session.focusStorageRoot !== path.resolve(storage.cwd, ".pi/goals");
		session.goalsById = pool;
		session.tasksEnabled = !loadGoalSettings(ctx.cwd).disableTasks;
		session.assignFocusedGoalId(null);

		// Walk the log backwards for the newest focus entry and the newest
		// legacy state entry (older versions saved the whole goal in the log).
		let focusEntry: GoalFocusEntry | null = null;
		let legacyGoal: GoalRecord | null = null;
		let legacyStateSeen = false;
		for (let i = entries.length - 1; i >= 0; i--) {
			const entry = entries[i] as { type?: string; customType?: string; data?: unknown };
			if (entry.type !== "custom") continue;
			if (!focusEntry && entry.customType === FOCUS_ENTRY) focusEntry = normalizeGoalFocusEntry(entry.data);
			if (!legacyStateSeen && entry.customType === STATE_ENTRY) {
				legacyGoal = normalizeGoalRecord(asRecord(entry.data)?.goal);
				legacyStateSeen = true;
			}
			if (focusEntry && legacyStateSeen) break;
		}
		if (legacyGoal && legacyGoal.status !== "complete") {
			legacyGoal = sanitizeGoalPaths(ctx, mergeGoalPromptFromDisk(ctx, legacyGoal));
		}
		// A focus entry from another goal storage root does not apply here.
		if (focusEntry && (focusEntry.storageRoot ?? defaultRoot) !== session.focusStorageRoot) {
			focusEntry = { ...focusEntry, focusedGoalId: null };
			legacyGoal = null;
		}
		if (session.focusStorageRoot !== defaultRoot) legacyGoal = null;
		session.hasExplicitSessionFocus = focusEntry !== null;
		session.assignFocusedGoalId(resolveSessionFocus({
			pool: session.goalsById,
			focusEntry,
			legacyGoal,
			autoSelectSingleGoal: settings.autoSelectSingleGoal,
		}));
		if (!focusEntry && session.focusedGoalId) {
			try {
				this.appendEntry(session.focusedGoalId, legacyGoal?.id === session.focusedGoalId ? "migrated" : "selected");
			} catch {
				// The session log may be unwritable; focus still works in memory.
			}
		}
		for (const [id, goal] of session.goalsById) {
			if (goal.status === "complete") session.goalsById.delete(id);
		}
		this.deps.clearStoppedRuntimeState();
		session.runningGoalId = null;
		this.deps.updateUI(ctx);
	}
}
