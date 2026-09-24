import { randomUUID } from "node:crypto";

export type GoalDispatchKind = "ready" | "check" | "wake" | "repair" | "kickoff" | "recovery";
export interface GoalWait {
	id: string;
	token: string;
	reason: string;
	deadline: number;
	/**
	 * Set only on a wait the runtime raised for a detected background task. It
	 * marks the wait as system-managed: it does not put the goal under the
	 * explicit execution contract, and it is dropped once the goal continues.
	 */
	taskId?: string;
	intervalMs?: number;
	remainingChecks?: number;
	nextCheckAt?: number;
	signalled?: boolean;
}
export interface GoalSchedulerState {
	version: 1;
	owner: string;
	generation: string;
	used: number;
	phase: "idle" | "ready" | "waiting" | "claimed" | "running" | "interrupted";
	decision?: { kind: "ready"; nextAction: string; purpose: GoalDispatchKind } | { kind: "wait" };
	wait?: GoalWait;
	dispatch?: { id: string; kind: GoalDispatchKind; claimedAt: number };
	repairUsed: boolean;
}
export type GoalContinuation =
	| { kind: "ready"; next_action: string }
	| { kind: "wait"; reason: string; deadline: string; wait_id?: string; polling?: { interval_seconds: number; max_checks: number } };

export function newGoalScheduler(owner: string): GoalSchedulerState {
	return { version: 1, owner, generation: randomUUID(), used: 0, phase: "idle", repairUsed: false };
}

/** Corrupt scheduling data must not silently reset spent allowance. */
export function normalizeGoalScheduler(raw: unknown): GoalSchedulerState | undefined {
	if (raw === undefined) return undefined;
	const invalid = (): GoalSchedulerState => ({ ...newGoalScheduler("invalid"), phase: "interrupted", used: Number.MAX_SAFE_INTEGER });
	if (!raw || typeof raw !== "object") return invalid();
	const s = raw as GoalSchedulerState;
	const integer = (n: unknown) => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
	const text = (v: unknown) => typeof v === "string" && v.length > 0 && v.length <= 2000;
	if (s.version !== 1 || !text(s.owner) || !text(s.generation) || !integer(s.used) || typeof s.repairUsed !== "boolean" || !["idle", "ready", "waiting", "claimed", "running", "interrupted"].includes(s.phase)) return invalid();
	if (s.decision && (s.decision.kind !== "wait" && (s.decision.kind !== "ready" || !text(s.decision.nextAction) || !["ready", "repair", "kickoff", "recovery"].includes(s.decision.purpose)))) return invalid();
	if (s.wait) {
		const w = s.wait;
		if (!text(w.id) || !text(w.token) || !text(w.reason) || (!integer(w.deadline) || w.deadline > 8_640_000_000_000_000)) return invalid();
		if (w.taskId !== undefined && !text(w.taskId)) return invalid();
		if (w.intervalMs !== undefined && (!integer(w.intervalMs) || w.intervalMs < 1000 || !integer(w.remainingChecks) || !integer(w.nextCheckAt))) return invalid();
		if (w.intervalMs === undefined && (w.remainingChecks !== undefined || w.nextCheckAt !== undefined)) return invalid();
		if (w.signalled !== undefined && typeof w.signalled !== "boolean") return invalid();
	}
	if (s.dispatch && (!text(s.dispatch.id) || !integer(s.dispatch.claimedAt) || !["ready", "check", "wake", "repair", "kickoff", "recovery"].includes(s.dispatch.kind))) return invalid();
	if ((s.phase === "claimed" || s.phase === "running") && !s.dispatch) return invalid();
	if (s.phase === "ready" && s.decision?.kind !== "ready") return invalid();
	if (s.phase === "waiting" && (!s.wait || s.decision?.kind !== "wait")) return invalid();
	return structuredClone(s);
}

/**
 * Split scheduling text into an append-safe counter line and the standing
 * instructions. Instructions (next action, wait, admission) are cleared by
 * omission, so a retained stale copy would keep issuing a cancelled order:
 * they belong with the reset-on-change state, never with retained counters.
 */
export function schedulerSummaryParts(s: GoalSchedulerState | undefined, limit?: number): { runs: string; instructions: string } {
	// A wait raised for a detected background task rides on the runs line instead
	// of adding its own rows. The widget's height latches per regime, and a system
	// task wait is not a regime change, so extra rows would be head-sliced away:
	// the box footer disappears. The status row already reads "Waiting" on its
	// own, and the tracked task plus its re-check stay visible in the clause.
	const taskWait = s?.wait && s.wait.taskId !== undefined ? s.wait : undefined;
	const runs = `Autonomous runs: ${s?.used ?? 0}/${limit ?? "unlimited"}${limit === 0 ? " (automatic continuation disabled)" : ""}.`
		+ (taskWait ? ` ${taskWait.reason}${taskWait.nextCheckAt !== undefined ? ` Next check ${new Date(taskWait.nextCheckAt).toISOString()}.` : ""}` : "");
	const lines: string[] = [];
	if (s) {
		if (s.decision?.kind === "ready") lines.push(`Next action: ${s.decision.nextAction}`);
		if (s.wait && !taskWait) {
			lines.push(`Waiting: ${s.wait.reason}; wait_id=${s.wait.id}; deadline=${new Date(s.wait.deadline).toISOString()}.`);
			if (s.wait.nextCheckAt !== undefined) lines.push(`Next check: ${new Date(s.wait.nextCheckAt).toISOString()}; ${s.wait.remainingChecks} checks remaining.`);
		}
		if (s.phase === "interrupted" || s.phase === "claimed") lines.push("Execution requires dispatch admission or explicit /goal-resume after interruption.");
	}
	return { runs, instructions: lines.join("\n") };
}

export function schedulerSummary(s: GoalSchedulerState | undefined, limit?: number): string {
	const { runs, instructions } = schedulerSummaryParts(s, limit);
	return instructions ? `${runs}\n${instructions}` : runs;
}
