import { commandInstructions } from "./goal-controls.ts";
import { randomUUID } from "node:crypto";
import type { ExtensionContext, AgentToolResult } from "@earendil-works/pi-coding-agent";
import { asRecord, type GoalRecord } from "./goal-record.ts";
import { budgetReached } from "./goal-accounting.ts";
import { invalidateGoalSettingsCache } from "./settings/files.ts";
import { loadGoalSettings } from "./settings/resolve.ts";
import { hasActiveDraft } from "./goal-drafting.ts";
import { newGoalScheduler, schedulerSummary, type GoalContinuation, type GoalSchedulerState } from "./goal-scheduler-state.ts";
import {
	claimDispatch, declareWait, dispatchKind, goalContentKey, idleDelay, isRepairReady, markImplicitReady, nextIdlePacing, releaseToIdle, waitHold,
} from "./goal-scheduler-rules.ts";
import type { SchedulerHost } from "./goal-scheduler-host.ts";
import { WakeTimer } from "./goal-wake-timer.ts";
import { t } from "./i18n/index.ts";

/**
 * Scheduling intent is durable; timers only arrange an opportunity to claim it.
 * The decisions themselves are pure functions in goal-scheduler-rules.ts; this
 * class reads settings and the clock, saves state through the service and
 * drives the timer.
 */
export class GoalScheduler {
	private timer = new WakeTimer();
	private ctx: ExtensionContext | undefined;
	private inRun = false;
	private armedGeneration: string | undefined;
	private declared = false;
	private runGoalId: string | undefined;
	private runGoalContent: string | undefined;
	private runHadWork = false;
	private runPacingEnabled = false;
	private denied = false;
	private unsubscribe: (() => void) | undefined;
	private core: SchedulerHost;
	constructor(core: SchedulerHost) { this.core = core; }

	private owner(ctx: ExtensionContext): string { return ctx.sessionManager.getSessionId() || "unknown-session"; }
	private limit(ctx: ExtensionContext): number | undefined { return loadGoalSettings(ctx.cwd).maxAutonomousRuns; }
	private strict(ctx: ExtensionContext, s: GoalSchedulerState): boolean {
		return loadGoalSettings(ctx.cwd).strictExecutionContract === true || !!s.wait;
	}
	/** A method so each run's content snapshot can be counted and stubbed. */
	private goalContent(goal: GoalRecord | null): string | undefined { return goalContentKey(goal); }
	private paceIdle(s: GoalSchedulerState, goal: GoalRecord): void {
		const progressed = this.runHadWork || this.goalContent(goal) !== this.runGoalContent;
		s.idle = nextIdlePacing(s.idle, progressed, Date.now());
	}
	private available(ctx: ExtensionContext, s: GoalSchedulerState): boolean {
		const limit = this.limit(ctx);
		return limit === undefined || s.used < limit;
	}
	private state(ctx: ExtensionContext, goal: GoalRecord): GoalSchedulerState {
		const s = goal.scheduler ?? newGoalScheduler(this.owner(ctx));
		if (s.owner !== this.owner(ctx) || s.phase === "interrupted") throw new Error(commandInstructions("Goal scheduling belongs to another session or was interrupted. Use /goal-resume to take ownership.", this.core.loadedCommands));
		return s;
	}
	private write(ctx: ExtensionContext, change: (g: GoalRecord) => GoalRecord): GoalRecord {
		const error = this.core.goalService.flushForAudit(ctx);
		if (error || this.core.goalService.isTurnBuffered()) throw new Error(error || "Goal changes have not reached disk.");
		const id = this.core.state.goal?.id;
		if (!id) throw new Error("No focused goal.");
		const result = this.core.goalService.apply(ctx, { expectedGoalId: id, mutate: change,
			ledger: g => g.status === "paused" ? [{ type: "goal_paused", goalId: g.id, reason: g.pauseReason ?? "Scheduling paused", source: "agent", at: new Date().toISOString() }] : [],
		});
		if (!result.ok) throw new Error(result.message);
		this.core.updateUI(ctx);
		return result.goal;
	}
	private update(ctx: ExtensionContext, change: (s: GoalSchedulerState, g: GoalRecord) => void): GoalRecord {
		return this.write(ctx, g => { const s = this.state(ctx, g); change(s, g); return { ...g, scheduler: s }; });
	}
	private safe(ctx: ExtensionContext, fn: () => void): void {
		try { fn(); } catch (error) {
			this.cancelTimer();
			this.core.runtime.clearContinuationState();
			ctx.ui.notify(t("Goal scheduling stopped: {message}", { message: error instanceof Error ? error.message : String(error) }), "warning");
		}
	}
	cancelTimer(): void {
		this.timer.cancel();
		this.armedGeneration = undefined;
	}
	private later(ctx: ExtensionContext, delay: number, fn: () => void): void {
		this.cancelTimer();
		this.timer.arm(delay, () => this.safe(ctx, fn));
	}
	private pause(ctx: ExtensionContext, reason: string): void {
		this.cancelTimer();
		this.core.runtime.clearContinuationState();
		this.write(ctx, g => {
			if (g.scheduler && g.scheduler.owner !== this.owner(ctx)) throw new Error("Scheduling ownership changed; no pause was applied.");
			return { ...g, status: "paused", autoContinue: false, stopReason: "agent", pauseReason: reason,
				scheduler: g.scheduler ? { ...g.scheduler, generation: randomUUID(), phase: "idle", decision: undefined, dispatch: undefined, wait: undefined } : undefined };
		});
		this.core.clearActiveAccounting();
		ctx.ui.notify(reason, "warning");
	}
	/** Pause the focused goal because it cannot go on by itself, and say why. */
	pauseForError(ctx: ExtensionContext, reason: string): void {
		this.safe(ctx, () => this.pause(ctx, reason));
	}
	private allowanceReason(ctx: ExtensionContext): string {
		return this.limit(ctx) === 0 ? commandInstructions(t("Automatic continuation disabled by maxAutonomousRuns=0. Change the setting in /goal-settings, then use /goal-resume."), this.core.loadedCommands) : commandInstructions(t("Autonomous-run allowance exhausted. Increase or remove maxAutonomousRuns, or use /goal-resume to renew."), this.core.loadedCommands);
	}

	/** Bind once per live session. The event is deliberately not a triggerTurn message. */
	attach(ctx: ExtensionContext): void {
		this.ctx = ctx;
		this.unsubscribe?.();
		this.unsubscribe = this.core.pi.events?.on("pi-goal:wake", (event: unknown) => {
			const raw = asRecord(event);
			if (raw && this.ctx) this.signal(this.ctx, raw.goalId, raw.waitToken);
		});
	}
	shutdown(): void { this.cancelTimer(); this.unsubscribe?.(); this.unsubscribe = undefined; this.ctx = undefined; this.denied = false; }

	restore(ctx: ExtensionContext): void {
		this.attach(ctx);
		this.inRun = false; this.declared = false; this.runGoalId = undefined; this.denied = false;
		this.cancelTimer();
		this.safe(ctx, () => {
			this.core.reconcileFocusedGoalFromDisk(ctx);
			const goal = this.core.state.goal;
			if (!goal || goal.status !== "active" || !goal.autoContinue || !goal.scheduler) return;
			const s = goal.scheduler;
			if (s.owner !== this.owner(ctx)) { ctx.ui.notify(commandInstructions(t("Goal owned by another session. Use /goal-resume to take ownership."), this.core.loadedCommands), "info"); return; }
			if (["claimed", "running", "interrupted"].includes(s.phase)) {
				this.pause(ctx, commandInstructions("Previous autonomous execution was interrupted. Use /goal-resume; its dispatch will not be replayed.", this.core.loadedCommands));
				return;
			}
			this.schedule(ctx);
		});
	}

	/** Persist a stopped turn without renewing allowance or scheduling work. */
	interrupt(ctx: ExtensionContext): void {
		this.cancelTimer();
		this.safe(ctx, () => this.update(ctx, s => {
			s.phase = "interrupted"; s.generation = randomUUID(); s.dispatch = undefined; s.decision = undefined; s.wait = undefined;
		}));
	}
	releaseInterrupt(ctx: ExtensionContext): void {
		this.safe(ctx, () => this.write(ctx, g => {
			const s = g.scheduler;
			if (!s || s.owner !== this.owner(ctx) || s.phase !== "interrupted") return g;
			return { ...g, scheduler: { ...s, phase: "idle", generation: randomUUID() } };
		}));
	}

	/** Only explicit user resume resets spent allowance, including while already active/waiting. */
	resume(ctx: ExtensionContext): boolean {
		invalidateGoalSettingsCache();
		if (this.limit(ctx) === 0) { ctx.ui.notify(this.allowanceReason(ctx), "warning"); return false; }
		try {
			this.cancelTimer();
			this.core.runtime.clearContinuationState();
			this.write(ctx, g => {
				if (g.status === "complete" || budgetReached(g)) throw new Error("A completed or token-budget-limited goal cannot resume.");
				return { ...g, status: "active", autoContinue: true, stopReason: undefined, pauseReason: undefined, pauseSuggestedAction: undefined,
					scheduler: { ...newGoalScheduler(this.owner(ctx)), phase: "ready", decision: { kind: "ready", purpose: "kickoff" } } };
			});
			this.core.interruption.resumed(ctx);
			// A resume during host work waits for settlement; another model turn
			// still invalidates it through turn(), just like a declaration.
			this.declared = this.inRun;
			this.schedule(ctx);
			return true;
		} catch (error) { ctx.ui.notify(String(error), "warning"); return false; }
	}
	kickoff(ctx: ExtensionContext): void {
		// A goal created in ordinary user work can finish in that run. Replacing
		// another run's goal needs its own saved kickoff and fresh attribution.
		if (this.inRun && (!this.runGoalId || this.runGoalId === this.core.state.goal?.id)) return;
		this.safe(ctx, () => {
			const goal = this.core.state.goal;
			if (!goal || goal.status !== "active" || !goal.autoContinue) return;
			if (this.limit(ctx) === 0) { this.update(ctx, () => {}); ctx.ui.notify(this.allowanceReason(ctx), "info"); return; }
			this.update(ctx, s => { s.phase = "ready"; s.decision = { kind: "ready", purpose: "kickoff" }; });
			this.schedule(ctx);
		});
	}

	declare(ctx: ExtensionContext, input: GoalContinuation): AgentToolResult<unknown> {
		try {
			if (!this.core.state.goal || this.core.state.goal.status !== "active" || !this.core.state.goal.autoContinue || this.denied) throw new Error("Scheduling requires an active auto-continue goal in this session.");
			invalidateGoalSettingsCache(); // an agent may have just configured the allowance
			const goal = this.update(ctx, s => {
				if (!this.available(ctx, s)) throw new Error(this.allowanceReason(ctx));
				if (this.strict(ctx, s)) s.idle = undefined;
				if (input.kind === "ready") {
					s.phase = "ready"; s.decision = { kind: "ready", purpose: "ready" }; s.wait = undefined;
				} else if (input.kind === "wait") {
					declareWait(s, input, this.strict(ctx, s), Date.now(), this.core.loadedCommands);
				} else throw new Error("Unknown continuation kind.");
				s.dispatch = undefined;
				s.generation = randomUUID();
			});
			this.declared = true;
			this.core.runtime.markTurnStopped(goal.id);
			const wait = goal.scheduler?.wait;
			const settings = loadGoalSettings(ctx.cwd);
			return { content: [{ type: "text", text: `Scheduling decision saved. Stop this execution.\n${schedulerSummary(goal.scheduler, this.limit(ctx), settings.showAutonomousRuns, settings.idleContinuationBackoff === true, this.core.loadedCommands)}${wait ? `\nWake token: ${wait.token}. Register this token with the producer before completion; adapters must retain early results.` : ""}` }], details: { goal, ...(wait ? { wait_id: wait.id, waitToken: wait.token } : {}) }, terminate: true };
		} catch (error) { return { content: [{ type: "text", text: `Scheduling decision NOT saved: ${error instanceof Error ? error.message : String(error)}` }], details: { error: true }, terminate: false }; }
	}

	/** Reject an internal dispatch without giving its cancellation to the focused goal. */
	rejectCheckpoint(ctx: ExtensionContext): void {
		this.denied = true;
		this.cancelTimer();
		this.core.runtime.clearContinuationTimer();
		this.core.runningGoalId = null;
		ctx.abort?.();
	}

	/** One logical run can contain multiple agent_start events during native retry/compaction. */
	begin(ctx: ExtensionContext): void {
		this.ctx = ctx;
		// Native custom-turn preparation can reject a checkpoint before agent_start.
		// Its later lifecycle events still belong to that rejected dispatch.
		if (this.denied) return;
		if (this.inRun) { this.core.runningGoalId = this.runGoalId ?? null; return; }
		this.inRun = true; this.declared = false; this.denied = false;
		this.runGoalId = this.core.state.goal?.id;
		this.runPacingEnabled = loadGoalSettings(ctx.cwd).idleContinuationBackoff === true;
		this.runGoalContent = this.runPacingEnabled ? this.goalContent(this.core.state.goal) : undefined;
		this.runHadWork = false;
		this.cancelTimer(); this.core.runtime.clearContinuationTimer();
		this.core.runningGoalId = this.core.state.goal?.id ?? null;
	}
	/** Work in any tool turn counts until the entire logical execution settles. */
	recordWork(): void { if (this.inRun && this.runPacingEnabled) this.runHadWork = true; }
	turn(ctx: ExtensionContext): void {
		if (!this.declared) return;
		this.declared = false;
		this.safe(ctx, () => this.update(ctx, s => { s.decision = undefined; s.phase = "idle"; s.dispatch = undefined; }));
	}
	message(ctx: ExtensionContext, rawMessage: unknown): void {
		if (this.denied) return;
		const msg = asRecord(rawMessage);
		if (!msg || !["user", "custom"].includes(String(msg.role))) return;
		if (msg.customType === "pi-goal-audit-event") return;
		if (msg.customType === "pi-goal-event") {
			const d = asRecord(msg.details);
			if (d?.kind !== "checkpoint") return;
			try {
				this.update(ctx, (s, g) => {
					if (d.version !== 3 || s.phase !== "claimed" || g.id !== d.goalId || s.generation !== d.generation || s.dispatch?.id !== d.dispatchId || g.status !== "active" || !g.autoContinue) throw new Error("Stale or unclaimed goal checkpoint.");
					// Retain the admitted action as context; phase prevents reusing its authorization.
					s.phase = "running";
				});
			} catch (error) {
				this.rejectCheckpoint(ctx);
				this.core.runtime.setCheckpoint(String(d?.goalId ?? "invalid"));
				ctx.ui.notify(t("Goal checkpoint rejected: {message}", { message: String(error) }), "warning");
			}
			return;
		}
		// Genuine host work supersedes an old scheduling claim, but never resets used.
		this.takeover(ctx);
	}
	takeover(ctx: ExtensionContext): void {
		this.cancelTimer(); this.core.runtime.clearContinuationState();
		this.declared = false;
		const s = this.core.state.goal?.scheduler;
		if (!s || s.owner !== this.owner(ctx)) return;
		this.safe(ctx, () => this.update(ctx, releaseToIdle));
	}
	settled(ctx: ExtensionContext, successful = true): void {
		this.inRun = false;
		if (this.denied) {
			this.denied = false;
			this.runGoalId = undefined;
			// A rejected message creates no scheduling intent. Resume only intent
			// that the currently focused goal already saved before the rejection.
			this.schedule(ctx);
			return;
		}
		if (this.runGoalId && this.core.state.goal?.id !== this.runGoalId) { this.schedule(ctx); return; }
		invalidateGoalSettingsCache();
		this.safe(ctx, () => {
			const goal = this.core.state.goal;
			if (!goal || goal.status !== "active" || !goal.autoContinue || !successful) return;
			const s = this.state(ctx, goal);
			const strict = this.strict(ctx, s);
			if (this.declared && s.decision) {
				if (strict || (s.decision.kind === "ready" && s.decision.purpose !== "ready")) { this.schedule(ctx); return; }
			}
			if (!strict) {
				this.update(ctx, (state, current) => { markImplicitReady(state); if (loadGoalSettings(ctx.cwd).idleContinuationBackoff && this.runPacingEnabled) this.paceIdle(state, current); else state.idle = undefined; });
				this.schedule(ctx); return;
			}
			if (s.repairUsed || !this.available(ctx, s)) {
				this.pause(ctx, !this.available(ctx, s) ? this.allowanceReason(ctx) : commandInstructions("No execution disposition after the contract-repair prompt. Use /goal-resume to continue.", this.core.loadedCommands));
				return;
			}
			this.update(ctx, state => {
				state.phase = "ready"; state.dispatch = undefined;
				state.decision = { kind: "ready", purpose: "repair" };
			});
			this.schedule(ctx);
		});
	}
	recover(ctx: ExtensionContext): void {
		this.safe(ctx, () => {
			this.update(ctx, s => { s.phase = "ready"; s.dispatch = undefined; s.decision = { kind: "ready", purpose: "recovery" }; });
			this.schedule(ctx);
		});
	}

	signal(ctx: ExtensionContext, goalId: unknown, token: unknown): void {
		this.safe(ctx, () => {
			this.core.reconcileFocusedGoalFromDisk(ctx);
			const g = this.core.state.goal; const s = g?.scheduler;
			if (!g || g.id !== goalId || g.status !== "active" || !g.autoContinue || s?.owner !== this.owner(ctx) || s.phase !== "waiting" || !s.wait || s.wait.token !== token || s.wait.signalled) return;
			this.update(ctx, current => { if (current.wait?.token !== token || current.phase !== "waiting") throw new Error("Wait changed."); current.wait.signalled = true; });
			if (!this.inRun) this.schedule(ctx);
		});
	}
	/** Apply an explicit preference edit without renewing runs or lifecycle state. */
	refreshSettings(ctx: ExtensionContext): void {
		invalidateGoalSettingsCache();
		if (this.inRun && !loadGoalSettings(ctx.cwd).idleContinuationBackoff) {
			this.runPacingEnabled = false;
			const s = this.core.state.goal?.scheduler;
			if (s?.idle && s.owner === this.owner(ctx)) this.safe(ctx, () => this.update(ctx, state => { state.idle = undefined; }));
		}
		this.schedule(ctx);
		// Keep the explicit refresh snapshot warm so the next /goal-refresh can
		// distinguish an external edit from the state just shown to the user.
		loadGoalSettings(ctx.cwd);
	}
	/** Pause or arm a timer when a wait still blocks dispatch. True when scheduling must stop here. */
	private holdForWait(ctx: ExtensionContext, s: GoalSchedulerState): boolean {
		const hold = waitHold(s, Date.now());
		if (hold.releaseAccounting) this.core.clearActiveAccounting();
		if (hold.action === "pause") { this.pause(ctx, hold.reason); return true; }
		if (hold.action === "timer") { this.later(ctx, hold.delay, () => this.schedule(ctx)); return true; }
		return false;
	}
	schedule(ctx: ExtensionContext): void {
		if (this.inRun || this.denied || this.core.interruption.isHeld()) return;
		// No automatic turns while the user is drafting. Work resumes after
		// the draft is confirmed or cancelled.
		if (hasActiveDraft(this.core)) return;
		invalidateGoalSettingsCache();
		this.safe(ctx, () => {
			this.core.reconcileFocusedGoalFromDisk(ctx);
			const g = this.core.state.goal;
			if (!g || g.status !== "active" || !g.autoContinue || !g.scheduler) return;
			let s = this.state(ctx, g);
			if (!loadGoalSettings(ctx.cwd).idleContinuationBackoff && s.idle) s = this.update(ctx, state => { state.idle = undefined; }).scheduler!;
			if (isRepairReady(s) && !this.strict(ctx, s)) {
				s = this.update(ctx, markImplicitReady).scheduler!;
			}
			if (!["ready", "waiting"].includes(s.phase)) return;
			if (budgetReached(g)) { this.pause(ctx, "Goal token budget exhausted."); return; }
			if (!this.available(ctx, s)) { this.pause(ctx, this.allowanceReason(ctx)); return; }
			if (this.holdForWait(ctx, s)) return;
			const pacedDelay = idleDelay(s, Date.now());
			if (pacedDelay > 0) {
				this.core.runtime.clearContinuationTimer();
				this.core.clearActiveAccounting();
				this.later(ctx, pacedDelay, () => this.schedule(ctx)); return;
			}
			this.cancelTimer();
			// Runtime readiness polling cannot authorize: claim() is called again at delivery.
			this.armedGeneration = s.generation;
			this.core.runtime.queueContinuation(ctx, g, true);
		});
	}
	/** Turn the armed readiness into one claimed dispatch, or throw when nothing authorizes it. */
	private authorizeDispatch(ctx: ExtensionContext, s: GoalSchedulerState, g: GoalRecord, generation: string): Record<string, unknown> | "deferred" {
		if (s.generation !== generation) throw new Error("Scheduling generation changed.");
		if (g.status !== "active" || !g.autoContinue || budgetReached(g) || !this.available(ctx, s)) throw new Error(this.allowanceReason(ctx));
		if (s.wait && Date.now() >= s.wait.deadline) throw new Error("Wait deadline reached.");
		if (isRepairReady(s) && !this.strict(ctx, s)) markImplicitReady(s);
		if (!loadGoalSettings(ctx.cwd).idleContinuationBackoff) s.idle = undefined;
		if (idleDelay(s, Date.now()) > 0) return "deferred";
		const now = Date.now();
		const kind = dispatchKind(s, now);
		if (!kind) throw new Error("No scheduling decision authorizes this checkpoint.");
		return claimDispatch(s, kind, now);
	}
	claim(ctx: ExtensionContext): Record<string, unknown> | null {
		if (this.core.interruption.isHeld()) return null;
		const generation = this.armedGeneration;
		if (!generation) return null;
		this.armedGeneration = undefined;
		invalidateGoalSettingsCache();
		try {
			let claimed = undefined as Record<string, unknown> | "deferred" | undefined;
			this.update(ctx, (s, g) => { claimed = this.authorizeDispatch(ctx, s, g, generation); });
			if (claimed === "deferred") { this.schedule(ctx); return null; }
			return claimed ?? null;
		} catch (error) {
			const current = this.core.state.goal?.scheduler;
			if (current && (current.owner !== this.owner(ctx) || current.generation !== generation)) return null;
			this.safe(ctx, () => this.pause(ctx, `Goal wake stopped: ${error instanceof Error ? error.message : String(error)}`));
			return null;
		}
	}
	failedDispatch(ctx: ExtensionContext): void {
		this.safe(ctx, () => this.pause(ctx, commandInstructions("Goal checkpoint delivery failed after claiming allowance. Use /goal-resume; it will not be replayed.", this.core.loadedCommands)));
	}
	isWaiting(): boolean {
		const s = this.core.state.goal?.scheduler;
		return !this.inRun && !!s && (s.phase === "waiting" || (!!this.ctx && loadGoalSettings(this.ctx.cwd).idleContinuationBackoff === true && idleDelay(s, Date.now()) > 0));
	}
	isDenied(): boolean { return this.denied; }
}
