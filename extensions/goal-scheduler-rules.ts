import { randomUUID } from "node:crypto";
import { commandInstructions, type GoalCommands } from "./goal-controls.ts";
import type { GoalRecord } from "./goal-record.ts";
import type { GoalContinuation, GoalSchedulerState } from "./goal-scheduler-state.ts";

/**
 * The scheduling decisions, with no timers, settings reads or session context.
 * The scheduler passes in the time and the facts it read; these functions only
 * change the state they are handed or say what to do next. That keeps every
 * rule testable without a session.
 */

type WaitDeclaration = Extract<GoalContinuation, { kind: "wait" }>;
type DispatchKind = NonNullable<GoalSchedulerState["dispatch"]>["kind"];

/** Snapshot of the parts of a goal whose change means a run made progress. */
export function goalContentKey(goal: GoalRecord | null): string | undefined {
	return goal ? JSON.stringify([goal.objective, goal.sisyphus, goal.verificationContract, goal.taskList, goal.currentTaskId]) : undefined;
}

/** Back to a plain "ready" decision, as when no explicit wait or ready was declared. */
export function markImplicitReady(s: GoalSchedulerState): void {
	s.phase = "ready"; s.dispatch = undefined; s.generation = randomUUID();
	s.decision = { kind: "ready", purpose: "ready" };
}

/**
 * Idle pacing after a run that did nothing. One immediate reasoning-only
 * continuation, then 30s, 60s, 120s, 240s and 300s. The streak saturates to keep
 * long-running state bounded. A run with work, or a changed goal, resets it.
 */
export function nextIdlePacing(previous: GoalSchedulerState["idle"], progressed: boolean, now: number): GoalSchedulerState["idle"] {
	if (progressed) return undefined;
	const runs = Math.min(6, (previous?.runs ?? 0) + 1);
	const delay = runs === 1 ? 0 : Math.min(300_000, 30_000 * 2 ** (runs - 2));
	return { runs, nextAt: now + delay };
}

/** Milliseconds an idle-paced "ready" state still has to wait; 0 for any other state. */
export function idleDelay(s: GoalSchedulerState, now: number): number {
	return s.phase === "ready" && s.decision?.kind === "ready" && s.decision.purpose === "ready"
		? Math.max(0, (s.idle?.nextAt ?? 0) - now) : 0;
}

/**
 * True when the state holds a repair prompt. Repair only exists under a strict
 * contract; without one the caller turns it back into a plain ready.
 */
export function isRepairReady(s: GoalSchedulerState): boolean {
	return s.phase === "ready" && s.decision?.kind === "ready" && s.decision.purpose === "repair";
}

/** Validate a wait declaration and either extend the current wait or start a new one. Throws on a bad one. */
export function declareWait(s: GoalSchedulerState, input: WaitDeclaration, strict: boolean, now: number, commands?: GoalCommands): void {
	if (!strict) throw new Error(commandInstructions("New waits require strictExecutionContract=true in /goal-settings. This is a user preference; continue pursuing the goal without a wait unless the user opts in.", commands));
	if (typeof input.reason !== "string" || !input.reason.trim() || input.reason.length > 2000) throw new Error("wait requires a nonempty reason (at most 2000 characters).");
	const deadline = Date.parse(input.deadline);
	if (!/T.*(?:Z|[+-]\d\d:\d\d)$/.test(input.deadline) || !Number.isSafeInteger(deadline) || deadline <= now) throw new Error("wait requires a future ISO deadline with a timezone.");
	if (s.wait) {
		if (input.wait_id !== s.wait.id || deadline !== s.wait.deadline) throw new Error("Re-declare the current wait_id with its original deadline; checks cannot be reset.");
		if (input.polling && (input.polling.interval_seconds * 1000 !== s.wait.intervalMs || input.polling.max_checks !== s.wait.remainingChecks)) throw new Error("Existing wait polling cannot be reset; omit polling when re-declaring wait_id.");
		s.wait.token = randomUUID(); s.wait.signalled = false;
		if (s.wait.intervalMs) s.wait.nextCheckAt = now + s.wait.intervalMs;
	} else {
		if (input.wait_id) throw new Error("Unknown wait_id.");
		const polling = input.polling;
		if (polling && (!Number.isSafeInteger(polling.interval_seconds) || polling.interval_seconds < 1 || polling.interval_seconds > 2_147_483 || !Number.isSafeInteger(polling.max_checks) || polling.max_checks < 1)) throw new Error("Polling requires positive whole interval_seconds (at most 2147483) and max_checks.");
		s.wait = { id: randomUUID(), token: randomUUID(), reason: input.reason.trim(), deadline,
			...(polling ? { intervalMs: polling.interval_seconds * 1000, remainingChecks: polling.max_checks, nextCheckAt: now + polling.interval_seconds * 1000 } : {}) };
	}
	s.phase = "waiting"; s.decision = { kind: "wait" };
}

/** What a wait does to scheduling right now. */
type WaitHold =
	| { action: "proceed"; releaseAccounting: boolean }
	| { action: "pause"; reason: string; releaseAccounting: boolean }
	/** Arm a timer for `delay` ms and stop scheduling until it fires. */
	| { action: "timer"; delay: number; releaseAccounting: boolean };

export function waitHold(s: GoalSchedulerState, now: number): WaitHold {
	const wait = s.wait;
	// Recovery and repair retain the wait while changing phase to ready.
	if (wait && now >= wait.deadline) return { action: "pause", reason: "Wait deadline reached.", releaseAccounting: false };
	if (s.phase !== "waiting" || !wait) return { action: "proceed", releaseAccounting: false };
	if (wait.signalled) return { action: "proceed", releaseAccounting: true };
	if (wait.remainingChecks === 0) return { action: "pause", reason: "Wait check allowance exhausted.", releaseAccounting: true };
	if (wait.nextCheckAt === undefined || wait.nextCheckAt > now) {
		const due = Math.min(wait.deadline, wait.nextCheckAt ?? Infinity);
		return { action: "timer", delay: due - now, releaseAccounting: true };
	}
	return { action: "proceed", releaseAccounting: true };
}

/**
 * Which kind of dispatch the saved state authorizes right now, if any. A signalled
 * wait wakes; a due poll is a check and uses one of its remaining checks.
 */
export function dispatchKind(s: GoalSchedulerState, now: number): DispatchKind | undefined {
	let kind = s.phase === "ready" && s.decision?.kind === "ready" ? s.decision.purpose : undefined;
	if (s.phase === "waiting" && s.wait) {
		if (s.wait.signalled) kind = "wake";
		else if (s.wait.nextCheckAt !== undefined && s.wait.nextCheckAt <= now && (s.wait.remainingChecks ?? 0) > 0) { kind = "check"; s.wait.remainingChecks!--; }
	}
	return kind;
}

/** Spend one autonomous run on `kind`: claim the state and return the ids the checkpoint must carry. */
export function claimDispatch(s: GoalSchedulerState, kind: DispatchKind, now: number): { generation: string; dispatchId: string } {
	s.used++; s.phase = "claimed"; s.dispatch = { id: randomUUID(), kind, claimedAt: now };
	if (kind === "repair") s.repairUsed = true;
	else if (kind !== "recovery") s.repairUsed = false;
	if (s.wait) { s.wait.signalled = false; s.wait.token = randomUUID(); }
	return { generation: s.generation, dispatchId: s.dispatch.id };
}

/** Back to idle after genuine host work: nothing scheduled, nothing waited on, pacing reset. */
export function releaseToIdle(s: GoalSchedulerState): void {
	s.generation = randomUUID(); s.phase = "idle"; s.decision = undefined; s.dispatch = undefined; s.wait = undefined;
	s.repairUsed = false;
	s.idle = undefined;
}
