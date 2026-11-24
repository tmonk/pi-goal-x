import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { commandHint, type GoalCommands } from "./goal-controls.ts";
import type { GoalRecord } from "./goal-record.ts";
import { nowIso } from "./goal-record.ts";
import type { GoalService } from "./goal-service.ts";
import type { GoalSessionState } from "./goal-session-state.ts";
import { loadGoalSettings } from "./goal-settings.ts";

const BUDGET_WARNING_THRESHOLDS = [0.5, 0.75, 0.9];

interface GoalWatchDeps {
	session: GoalSessionState;
	goalService: GoalService;
	getCommands(): GoalCommands | undefined;
}

/**
 * Raises the two warnings that do not change a goal: it has gone quiet (stall),
 * or its token budget is filling up. Each warning fires once.
 */
export class GoalWatch {
	private lastActivityAt = Date.now();
	private stallNotified = false;
	// Keys look like "goalId:budget:threshold", so raising a budget re-arms the warnings.
	private budgetWarningsFired = new Set<string>();
	private deps: GoalWatchDeps;

	constructor(deps: GoalWatchDeps) {
		this.deps = deps;
	}

	isStalled(): boolean {
		return this.stallNotified;
	}

	/** Real work happened (a continuation or a tool call). */
	touchActivity(): void {
		this.lastActivityAt = Date.now();
		this.stallNotified = false;
	}

	/** Returns the [GOAL STALLED] steering note when an active auto-continue goal has been idle too long, else "". */
	checkStall(ctx: ExtensionContext): string {
		const goal = this.deps.session.goal;
		if (!goal || goal.status !== "active" || !goal.autoContinue) return "";
		const minutes = loadGoalSettings(ctx.cwd).stallTimeoutMinutes ?? 0;
		if (minutes <= 0 || this.stallNotified) return "";
		if (Date.now() - this.lastActivityAt < minutes * 60_000) return "";
		this.stallNotified = true;
		const idle = `No continuation or tool activity for ${minutes} minute${minutes === 1 ? "" : "s"}.`;
		try {
			this.deps.goalService.appendEvents(ctx, [{ type: "goal_stalled", goalId: goal.id, reason: idle, at: nowIso() }]);
		} catch {
			// A failed ledger write must not crash the turn.
		}
		ctx.ui.notify(`Goal stalled: no activity for ${minutes} minute${minutes === 1 ? "" : "s"}.`, "warning");
		return `\n\n[GOAL STALLED goalId=${goal.id}]\n${idle} Report your progress or ask the user to pause or resume the goal.`;
	}

	/** One warning per call, even when several thresholds were crossed at once. */
	warnAboutBudget(ctx: ExtensionContext, goal: GoalRecord): void {
		const budget = goal.tokenBudget;
		if (goal.status !== "active" || typeof budget !== "number" || budget <= 0 || goal.usage.tokensUsed <= 0) return;
		const fraction = goal.usage.tokensUsed / budget;
		const keyFor = (threshold: number) => `${goal.id}:${budget}:${threshold}`;
		const crossed = BUDGET_WARNING_THRESHOLDS.filter(t => fraction >= t && !this.budgetWarningsFired.has(keyFor(t)));
		if (!crossed.length) return;
		for (const threshold of crossed) this.budgetWarningsFired.add(keyFor(threshold));
		const percent = Math.round(fraction * 100);
		try {
			this.deps.goalService.appendEvents(ctx, [{
				type: "goal_budget_warning",
				goalId: goal.id,
				budget,
				tokensUsed: goal.usage.tokensUsed,
				pct: percent,
				at: nowIso(),
			}]);
		} catch {
			// A failed ledger write must not crash the turn.
		}
		const hint = commandHint("goal-tweak", this.deps.getCommands());
		ctx.ui.notify(`Token budget ${percent}% used (${goal.usage.tokensUsed}/${budget} tokens). Use ${hint} to change or remove the budget.`, "warning");
	}
}
