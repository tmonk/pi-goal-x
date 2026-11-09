import { commandInstructions } from "./goal-controls.ts";
import { randomUUID } from "node:crypto";
import type { ExtensionContext, AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { GoalCore } from "./goal-state.ts";
import { asRecord, type GoalRecord } from "./goal-record.ts";
import { budgetReached } from "./goal-accounting.ts";
import { loadGoalSettings, invalidateGoalSettingsCache } from "./goal-settings.ts";
import { newGoalScheduler, schedulerSummary, type GoalContinuation, type GoalSchedulerState } from "./goal-scheduler-state.ts";

/** Scheduling intent is durable; timers only arrange an opportunity to claim it. */
export class GoalScheduler {
	private timer: ReturnType<typeof setTimeout> | undefined;
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
	private core: GoalCore;
	constructor(core: GoalCore) { this.core = core; }

	private owner(ctx: ExtensionContext): string { return ctx.sessionManager.getSessionId() || "unknown-session"; }
	private limit(ctx: ExtensionContext): number | undefined { return loadGoalSettings(ctx.cwd).maxAutonomousRuns; }
	private strict(ctx: ExtensionContext, s: GoalSchedulerState): boolean {
		return loadGoalSettings(ctx.cwd).strictExecutionContract === true || !!s.wait;
	}
	private implicitReady(s: GoalSchedulerState): void {
		s.phase = "ready"; s.dispatch = undefined; s.generation = randomUUID();
		s.decision = { kind: "ready", purpose: "ready" };
	}
	private goalContent(goal: GoalRecord | null): string | undefined {
		return goal ? JSON.stringify([goal.objective, goal.sisyphus, goal.verificationContract, goal.taskList, goal.currentTaskId]) : undefined;
	}
	private paceIdle(s: GoalSchedulerState, goal: GoalRecord): void {
		if (this.runHadWork || this.goalContent(goal) !== this.runGoalContent) {
			s.idle = undefined;
			return;
		}
		// One immediate reasoning-only continuation, then 30s, 60s, 120s,
		// 240s and 300s. Saturate the streak to keep long-running state bounded.
		const runs = Math.min(6, (s.idle?.runs ?? 0) + 1);
		const delay = runs === 1 ? 0 : Math.min(300_000, 30_000 * 2 ** (runs - 2));
		s.idle = { runs, nextAt: Date.now() + delay };
	}
	private idleDelay(s: GoalSchedulerState): number {
		return s.phase === "ready" && s.decision?.kind === "ready" && s.decision.purpose === "ready"
			? Math.max(0, (s.idle?.nextAt ?? 0) - Date.now()) : 0;
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
			ctx.ui.notify(`Goal scheduling stopped: ${error instanceof Error ? error.message : String(error)}`, "warning");
		}
	}
	cancelTimer(): void {
		if (this.timer !== undefined) clearTimeout(this.timer);
		this.timer = undefined;
		this.armedGeneration = undefined;
	}
	private later(ctx: ExtensionContext, delay: number, fn: () => void): void {
		this.cancelTimer();
		this.timer = setTimeout(() => { this.timer = undefined; this.safe(ctx, fn); }, Math.min(2_147_483_647, Math.max(0, delay)));
		this.timer.unref?.();
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
	private allowanceReason(ctx: ExtensionContext): string {
		return this.limit(ctx) === 0 ? commandInstructions("Automatic continuation disabled by maxAutonomousRuns=0. Change the setting in /goal-settings, then use /goal-resume.", this.core.loadedCommands) : commandInstructions("Autonomous-run allowance exhausted. Increase or remove maxAutonomousRuns, or use /goal-resume to renew.", this.core.loadedCommands);
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
			if (s.owner !== this.owner(ctx)) { ctx.ui.notify(commandInstructions("Goal owned by another session. Use /goal-resume to take ownership.", this.core.loadedCommands), "info"); return; }
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
					if (!this.strict(ctx, s)) throw new Error(commandInstructions("New waits require strictExecutionContract=true in /goal-settings. This is a user preference; continue pursuing the goal without a wait unless the user opts in.", this.core.loadedCommands));
					if (typeof input.reason !== "string" || !input.reason.trim() || input.reason.length > 2000) throw new Error("wait requires a nonempty reason (at most 2000 characters).");
					const deadline = Date.parse(input.deadline);
					if (!/T.*(?:Z|[+-]\d\d:\d\d)$/.test(input.deadline) || !Number.isSafeInteger(deadline) || deadline <= Date.now()) throw new Error("wait requires a future ISO deadline with a timezone.");
					if (s.wait) {
						if (input.wait_id !== s.wait.id || deadline !== s.wait.deadline) throw new Error("Re-declare the current wait_id with its original deadline; checks cannot be reset.");
						if (input.polling && (input.polling.interval_seconds * 1000 !== s.wait.intervalMs || input.polling.max_checks !== s.wait.remainingChecks)) throw new Error("Existing wait polling cannot be reset; omit polling when re-declaring wait_id.");
						s.wait.token = randomUUID(); s.wait.signalled = false;
						if (s.wait.intervalMs) s.wait.nextCheckAt = Date.now() + s.wait.intervalMs;
					} else {
						if (input.wait_id) throw new Error("Unknown wait_id.");
						const polling = input.polling;
						if (polling && (!Number.isSafeInteger(polling.interval_seconds) || polling.interval_seconds < 1 || polling.interval_seconds > 2_147_483 || !Number.isSafeInteger(polling.max_checks) || polling.max_checks < 1)) throw new Error("Polling requires positive whole interval_seconds (at most 2147483) and max_checks.");
						s.wait = { id: randomUUID(), token: randomUUID(), reason: input.reason.trim(), deadline,
							...(polling ? { intervalMs: polling.interval_seconds * 1000, remainingChecks: polling.max_checks, nextCheckAt: Date.now() + polling.interval_seconds * 1000 } : {}) };
					}
					s.phase = "waiting"; s.decision = { kind: "wait" };
				} else throw new Error("Unknown continuation kind.");
				s.dispatch = undefined;
				s.generation = randomUUID();
			});
			this.declared = true;
			this.core.runtime.markTurnStopped(goal.id);
			const wait = goal.scheduler?.wait;
			return { content: [{ type: "text", text: `Scheduling decision saved. Stop this execution.\n${schedulerSummary(goal.scheduler, this.limit(ctx), loadGoalSettings(ctx.cwd).showAutonomousRuns, loadGoalSettings(ctx.cwd).idleContinuationBackoff === true, this.core.loadedCommands)}${wait ? `\nWake token: ${wait.token}. Register this token with the producer before completion; adapters must retain early results.` : ""}` }], details: { goal, ...(wait ? { wait_id: wait.id, waitToken: wait.token } : {}) }, terminate: true };
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
				ctx.ui.notify(`Goal checkpoint rejected: ${String(error)}`, "warning");
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
		this.safe(ctx, () => this.update(ctx, state => {
			state.generation = randomUUID(); state.phase = "idle"; state.decision = undefined; state.dispatch = undefined; state.wait = undefined;
			state.repairUsed = false;
			state.idle = undefined;
		}));
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
				this.update(ctx, (state, current) => { this.implicitReady(state); if (loadGoalSettings(ctx.cwd).idleContinuationBackoff && this.runPacingEnabled) this.paceIdle(state, current); else state.idle = undefined; });
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
	schedule(ctx: ExtensionContext): void {
		if (this.inRun || this.denied || this.core.interruption.isHeld()) return;
		// A guided draft owns the turn: its profile has no goal tools and its
		// prompt forbids substantive work. Resume scheduling after confirm/cancel.
		if (this.core.isDrafting()) return;
		invalidateGoalSettingsCache();
		this.safe(ctx, () => {
			this.core.reconcileFocusedGoalFromDisk(ctx);
			const g = this.core.state.goal;
			if (!g || g.status !== "active" || !g.autoContinue || !g.scheduler) return;
			let s = this.state(ctx, g);
			if (!loadGoalSettings(ctx.cwd).idleContinuationBackoff && s.idle) s = this.update(ctx, state => { state.idle = undefined; }).scheduler!;
			if (s.phase === "ready" && s.decision?.kind === "ready" && s.decision.purpose === "repair" && !this.strict(ctx, s)) {
				s = this.update(ctx, state => this.implicitReady(state)).scheduler!;
			}
			if (!["ready", "waiting"].includes(s.phase)) return;
			if (budgetReached(g)) { this.pause(ctx, "Goal token budget exhausted."); return; }
			if (!this.available(ctx, s)) { this.pause(ctx, this.allowanceReason(ctx)); return; }
			// Recovery and repair retain the wait while changing phase to ready.
			if (s.wait && Date.now() >= s.wait.deadline) { this.pause(ctx, "Wait deadline reached."); return; }
			if (s.phase === "waiting" && s.wait) {
				this.core.clearActiveAccounting();
				if (!s.wait.signalled && s.wait.remainingChecks === 0) { this.pause(ctx, "Wait check allowance exhausted."); return; }
				if (!s.wait.signalled && (s.wait.nextCheckAt === undefined || s.wait.nextCheckAt > Date.now())) {
					const due = Math.min(s.wait.deadline, s.wait.nextCheckAt ?? Infinity);
					this.later(ctx, due - Date.now(), () => this.schedule(ctx)); return;
				}
			}
			const idleDelay = this.idleDelay(s);
			if (idleDelay > 0) {
				this.core.runtime.clearContinuationTimer();
				this.core.clearActiveAccounting();
				this.later(ctx, idleDelay, () => this.schedule(ctx)); return;
			}
			this.cancelTimer();
			// Runtime readiness polling cannot authorize: claim() is called again at delivery.
			this.armedGeneration = s.generation;
			this.core.runtime.queueContinuation(ctx, g, true);
		});
	}
	claim(ctx: ExtensionContext): Record<string, unknown> | null {
		if (this.core.interruption.isHeld()) return null;
		const generation = this.armedGeneration;
		if (!generation) return null;
		this.armedGeneration = undefined;
		invalidateGoalSettingsCache();
		try {
			let result: Record<string, unknown> | null = null;
			let deferred = false;
			this.update(ctx, (s, g) => {
				if (s.generation !== generation) throw new Error("Scheduling generation changed.");
				if (g.status !== "active" || !g.autoContinue || budgetReached(g) || !this.available(ctx, s)) throw new Error(this.allowanceReason(ctx));
				if (s.wait && Date.now() >= s.wait.deadline) throw new Error("Wait deadline reached.");
				if (s.phase === "ready" && s.decision?.kind === "ready" && s.decision.purpose === "repair" && !this.strict(ctx, s)) this.implicitReady(s);
				if (!loadGoalSettings(ctx.cwd).idleContinuationBackoff) s.idle = undefined;
				if (this.idleDelay(s) > 0) { deferred = true; return; }
				let kind = s.phase === "ready" && s.decision?.kind === "ready" ? s.decision.purpose : undefined;
				if (s.phase === "waiting" && s.wait) {
					if (s.wait.signalled) kind = "wake";
					else if (s.wait.nextCheckAt !== undefined && s.wait.nextCheckAt <= Date.now() && (s.wait.remainingChecks ?? 0) > 0) { kind = "check"; s.wait.remainingChecks!--; }
				}
				if (!kind) throw new Error("No scheduling decision authorizes this checkpoint.");
				s.used++; s.phase = "claimed"; s.dispatch = { id: randomUUID(), kind, claimedAt: Date.now() };
				if (kind === "repair") s.repairUsed = true;
				else if (kind !== "recovery") s.repairUsed = false;
				if (s.wait) { s.wait.signalled = false; s.wait.token = randomUUID(); }
				result = { generation: s.generation, dispatchId: s.dispatch.id };
			});
			if (deferred) this.schedule(ctx);
			return result;
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
		return !this.inRun && !!s && (s.phase === "waiting" || (!!this.ctx && loadGoalSettings(this.ctx.cwd).idleContinuationBackoff === true && this.idleDelay(s) > 0));
	}
	isDenied(): boolean { return this.denied; }
}
