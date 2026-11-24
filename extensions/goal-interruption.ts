import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { InterruptionHost } from "./goal-scheduler-host.ts";
import { loadGoalSettings } from "./settings/resolve.ts";
import { t } from "./i18n/index.ts";

/** A user-stopped turn must not become a retry, nor affect a replacement goal. */
export class GoalInterruption {
	private heldGoalId: string | undefined;
	private abortedGoalId: string | undefined;
	private finishGoalId: string | undefined;
	private core: InterruptionHost;
	constructor(core: InterruptionHost) { this.core = core; }
	isHeld(goalId = this.core.state.goal?.id): boolean { return !!goalId && this.heldGoalId === goalId && this.core.state.goal?.id === goalId && this.core.state.goal.status === "active"; }
	ignoreAbort(goalId = this.core.runningGoalId ?? this.core.state.goal?.id): boolean { return !!goalId && this.abortedGoalId === goalId; }
	settled(): void { if (this.isHeld()) this.core.clearActiveAccounting(); this.abortedGoalId = undefined; this.finishGoalId = undefined; }
	reset(): void { this.heldGoalId = undefined; this.finishGoalId = undefined; }
	resumed(ctx: ExtensionContext): void { this.reset(); if (ctx.hasUI) ctx.ui.setStatus("goal-interrupt", undefined); }
	continueWithUser(ctx: ExtensionContext): void {
		if (!this.isHeld()) { this.reset(); return; }
		this.core.scheduler.releaseInterrupt(ctx);
		this.resumed(ctx);
	}
	private stopTurn(ctx: ExtensionContext): void {
		const goal = this.core.state.goal;
		if (!goal || goal.status !== "active") return;
		this.heldGoalId = goal.id;
		this.abortedGoalId = goal.id;
		this.core.clearContinuationState();
		this.core.scheduler.interrupt(ctx);
		ctx.ui.setStatus("goal-interrupt", t("Turn stopped · press pause again to pause the goal · Resume or send a message to continue"));
		ctx.ui.notify(t("Turn stopped. The goal is waiting for you; Resume or send a message to continue."), "info");
		ctx.abort?.();
		this.core.updateUI(ctx);
	}
	pause(ctx: ExtensionContext): void {
		const goal = this.core.state.goal;
		if (goal?.status !== "active") { this.reset(); if (!ctx.isIdle()) ctx.abort?.(); return; }
		const order = loadGoalSettings(ctx.cwd).pauseOrder ?? "together";
		if (order === "turn-first" && !this.isHeld()) { this.stopTurn(ctx); return; }
		this.reset();
		ctx.ui.setStatus("goal-interrupt", undefined);
		this.core.pauseActiveGoal(ctx);
		if (order === "goal-first") { if (!ctx.isIdle()) this.finishGoalId = goal.id; }
		else ctx.abort?.();
	}
	finishTurn(ctx: ExtensionContext): void {
		if (!this.finishGoalId) return;
		const id = this.finishGoalId;
		this.finishGoalId = undefined;
		if (this.core.state.goal?.id === id && this.core.state.goal.status === "paused") ctx.abort?.();
	}
	/** Pi's own interrupt remains turn-only when the goal pause key is different. */
	interruptTurn(ctx: ExtensionContext): void { this.stopTurn(ctx); }
}
