import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { GoalFocus } from "./goal-focus.ts";
import {
	createGoal,
	nowIso,
	type GoalCreationConfig,
	type GoalRecord,
	type GoalStatus,
	type StopReason,
} from "./goal-record.ts";
import type { GoalProgress } from "./goal-progress.ts";
import { newGoalScheduler } from "./goal-scheduler-state.ts";
import type { GoalScheduler } from "./goal-scheduler.ts";
import type { GoalService } from "./goal-service.ts";
import type { GoalSessionState } from "./goal-session-state.ts";
import { mergeGoalPromptFromDisk } from "./storage/goal-files.ts";
import { buildGoalRunningNotification } from "./widgets/goal-notifications.ts";
import { t } from "./i18n/index.ts";

interface GoalLifecycleDeps {
	session: GoalSessionState;
	goalService: GoalService;
	focus(): GoalFocus;
	progress(): GoalProgress;
	scheduler(): GoalScheduler;
	updateUI(ctx: ExtensionContext): void;
	clearContinuationState(): void;
	clearActiveAccounting(): void;
}

/** How a goal starts, stops, pauses and is saved. Each change goes through the goal service. */
export class GoalLifecycle {
	private deps: GoalLifecycleDeps;

	constructor(deps: GoalLifecycleDeps) {
		this.deps = deps;
	}

	/** Saves the focused goal, or just stamps it when there is no context to write with. */
	persist(ctx?: ExtensionContext): void {
		const { session, goalService } = this.deps;
		if (!ctx) {
			const current = session.goal;
			if (current) session.goal = { ...current, updatedAt: nowIso() };
			return;
		}
		goalService.persist(ctx);
		this.deps.updateUI(ctx);
	}

	/** Pulls an objective edited on disk into the focused goal. Returns whether it changed. */
	syncPromptFromDisk(ctx: ExtensionContext): boolean {
		const { session } = this.deps;
		if (!session.goal || session.goal.status === "complete") return false;
		const previousObjective = session.goal.objective;
		session.goal = mergeGoalPromptFromDisk(ctx, session.goal);
		return session.goal.objective !== previousObjective;
	}

	refreshDisplayFromDisk(ctx: ExtensionContext): void {
		const { session } = this.deps;
		if (!session.goal || session.goal.status === "complete") return;
		if (this.syncPromptFromDisk(ctx)) session.goal = { ...session.goal, updatedAt: nowIso() };
		this.deps.updateUI(ctx);
	}

	/** Creates a goal and focuses it. With `startNow`, an auto-continue goal begins its first run. */
	create(config: GoalCreationConfig, ctx: ExtensionContext, startNow = true, verificationContract?: string, tokenBudget?: number): void {
		const { session, goalService } = this.deps;
		const goal = createGoal(config);
		goal.scheduler = newGoalScheduler(ctx.sessionManager.getSessionId());
		if (verificationContract) goal.verificationContract = verificationContract;
		if (config.taskList) goal.taskList = config.taskList;
		if (typeof tokenBudget === "number" && tokenBudget > 0) goal.tokenBudget = Math.floor(tokenBudget);
		const result = goalService.create(ctx, {
			goal,
			ledger: [
				{
					type: "goal_created",
					goalId: goal.id,
					objective: goal.objective,
					sisyphus: goal.sisyphus,
					autoContinue: goal.autoContinue,
					at: goal.createdAt,
				},
				...(goal.taskList ? [{
					type: "task_list_set" as const,
					goalId: goal.id,
					taskCount: goal.taskList.tasks.length,
					blockCompletion: goal.taskList.blockCompletion,
					at: goal.createdAt,
				}] : []),
			],
		});
		if (result.focusChanged) this.deps.focus().appendEntry(result.goalId, "created");
		this.deps.progress().begin();
		ctx.ui.notify(`${buildGoalRunningNotification(config)}\n${goal.tokenBudget === undefined ? t("Budget: none") : t("Budget: {tokens} tokens", { tokens: goal.tokenBudget })}`, "info");
		if (startNow && session.goal?.autoContinue) this.deps.scheduler().kickoff(ctx);
	}

	/** Takes the focused goal out of the active pool and files it, paused unless it was complete. */
	archive(ctx: ExtensionContext, reason: StopReason | undefined): GoalRecord | null {
		if (!this.deps.session.goal) return null;
		const result = this.deps.goalService.apply(ctx, {
			reconcile: false,
			refreshFromDisk: true,
			archive: true,
			commitFocused: false,
			mutate: (g) => ({ ...g, status: g.status === "complete" ? "complete" : "paused", stopReason: reason }),
		});
		return result.ok ? result.goal : null;
	}

	stop(status: Exclude<GoalStatus, "active">, reason: StopReason | undefined, ctx: ExtensionContext): void {
		const { session, goalService } = this.deps;
		if (!session.goal) return;
		const result = goalService.apply(ctx, {
			reconcile: false,
			refreshFromDisk: true,
			mutate: (g) => ({ ...g, status, stopReason: reason, updatedAt: nowIso() }),
			ledger: (written) => status === "paused"
				? [{
					type: "goal_paused",
					goalId: written.id,
					reason: reason ?? "unknown",
					suggestedAction: written.pauseSuggestedAction,
					status,
					at: written.updatedAt,
				}]
				: [],
		});
		if (!result.ok) return;
		// A stopped goal can no longer queue continuations or accrue time.
		this.deps.clearContinuationState();
		this.deps.clearActiveAccounting();
		// A status the user can see is saved now, not at turn end.
		goalService.flushTurn(ctx);
		this.deps.updateUI(ctx);
	}

	/** The user paused (Escape, or an aborted turn). Clears any earlier agent pause reason. */
	pause(ctx: ExtensionContext): void {
		const { session } = this.deps;
		if (!session.goal || session.goal.status !== "active") return;
		session.goal = { ...session.goal, autoContinue: false, pauseReason: undefined, pauseSuggestedAction: undefined };
		this.stop("paused", "user", ctx);
		ctx.ui.notify(t("Goal paused."), "info");
	}

	/**
	 * Flips whether the focused goal gets an independent audit. The choice is
	 * saved on the goal, recorded in the ledger, and announced. It does nothing
	 * without a focused goal, or once the goal is complete.
	 */
	toggleAuditor(ctx: ExtensionContext): void {
		const { session, goalService } = this.deps;
		const goal = session.goal;
		if (!goal) {
			ctx.ui.notify(t("No focused goal to toggle the auditor for."), "info");
			return;
		}
		if (goal.status === "complete") {
			ctx.ui.notify(t("This goal is complete; the auditor no longer applies."), "info");
			return;
		}
		const nextEnabled = goal.skipAuditor === true;
		const result = goalService.apply(ctx, {
			reconcile: false,
			refreshFromDisk: true,
			mutate: (g) => ({ ...g, skipAuditor: g.skipAuditor === true ? undefined : true, updatedAt: nowIso() }),
			ledger: (written) => [{ type: "auditor_toggled" as const, goalId: written.id, enabled: nextEnabled, at: written.updatedAt }],
		});
		if (!result.ok) {
			ctx.ui.notify(t("Could not toggle the auditor: {message}", { message: result.message }), "error");
			return;
		}
		goalService.flushTurn(ctx);
		this.deps.updateUI(ctx);
		ctx.ui.notify(nextEnabled ? t("Auditor enabled for this goal.") : t("Auditor disabled for this goal."), "info");
	}
}
