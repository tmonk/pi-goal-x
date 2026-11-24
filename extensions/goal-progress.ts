import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { budgetReached, type GoalAccounting } from "./goal-accounting.ts";
import type { GoalInterruption } from "./goal-interruption.ts";
import { cloneGoal, nowIso } from "./goal-record.ts";
import type { GoalRuntime } from "./goal-runtime.ts";
import type { GoalScheduler } from "./goal-scheduler.ts";
import type { GoalService } from "./goal-service.ts";
import type { GoalSessionState } from "./goal-session-state.ts";
import type { GoalWatch } from "./goal-watch.ts";

interface GoalProgressDeps {
	session: GoalSessionState;
	accounting: GoalAccounting;
	runtime: GoalRuntime;
	goalService: GoalService;
	watch: GoalWatch;
	scheduler(): GoalScheduler;
	interruption(): GoalInterruption;
	persist(ctx: ExtensionContext): void;
	updateUI(ctx: ExtensionContext): void;
}

/** Charges tokens and time to the focused goal and moves it to budget_limited when the budget runs out. */
export class GoalProgress {
	private deps: GoalProgressDeps;

	constructor(deps: GoalProgressDeps) {
		this.deps = deps;
	}

	/** Starts timing the focused goal, unless something says it should not accrue time right now. */
	begin(): void {
		const { session, accounting } = this.deps;
		const scheduler = this.deps.scheduler();
		const goal = session.goal;
		const runningElsewhere = session.runningGoalId && session.runningGoalId !== goal?.id;
		if (scheduler.isDenied() || runningElsewhere || scheduler.isWaiting() || this.deps.interruption().isHeld() || goal?.status !== "active") {
			accounting.clear();
			return;
		}
		accounting.begin(goal.id);
	}

	charge(ctx: ExtensionContext, opts: { completedTurnTokens?: number } = {}): void {
		const { session, accounting, goalService } = this.deps;
		const runningElsewhere = session.runningGoalId && session.runningGoalId !== session.goal?.id;
		if (this.deps.scheduler().isDenied() || runningElsewhere) {
			accounting.clear();
			return;
		}
		// A complete goal waits for archival at turn end, so skip the disk check for it.
		const focused = session.goal;
		if (focused?.activePath && focused.status !== "complete" && !goalService.reconcileFocused(ctx, { preserveMemoryUsage: true })) return;
		const goal = session.goal;
		if (!goal || goal.status !== "active" || !accounting.isActiveFor(goal.id)) {
			this.begin();
			return;
		}

		// The charge is idempotent: the same interval is never billed twice.
		const { tokens, seconds } = accounting.charge({ completedTurnTokens: opts.completedTurnTokens });
		if (tokens === 0 && seconds === 0) return;

		const next = cloneGoal(goal);
		next.usage.tokensUsed += tokens;
		next.usage.activeSeconds += seconds;
		next.updatedAt = nowIso();
		session.goal = next;
		this.deps.persist(ctx);

		// Saving can replace the goal with what was written, so read it back.
		const saved = session.goal;
		if (!saved) return;
		this.deps.watch.warnAboutBudget(ctx, saved);
		if (saved.status === "active" && typeof saved.tokenBudget === "number" && budgetReached(saved)) this.limitBudget(ctx, saved.tokenBudget);
	}

	/**
	 * Marks the goal budget_limited exactly once. It is no longer active, so
	 * accounting stops and this cannot fire again. Records the ledger event,
	 * arms the one-time wrap-up reminder, and cancels pending continuations.
	 */
	private limitBudget(ctx: ExtensionContext, budget: number): void {
		const { goalService, runtime, accounting } = this.deps;
		const transition = goalService.apply(ctx, {
			reconcile: false,
			mutate: (g) => ({ ...g, status: "budget_limited" as const, updatedAt: nowIso() }),
			ledger: (written) => [{
				type: "goal_budget_limited",
				goalId: written.id,
				budget,
				tokensUsed: written.usage.tokensUsed,
				at: written.updatedAt,
			}],
		});
		if (!transition.ok) return;
		runtime.armPostBudgetReminder();
		runtime.clearContinuationState();
		accounting.clear();
		this.deps.updateUI(ctx);
	}
}
