import { commandHint, commandInstructions, uiCommandHint, type GoalCommands } from "./goal-controls.ts";
import { t } from "./i18n/index.ts";
import { randomUUID } from "node:crypto";

type GoalDispatchKind = "ready" | "check" | "wake" | "repair" | "kickoff" | "recovery";
interface GoalWait {
	id: string;
	token: string;
	reason: string;
	deadline: number;
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
	decision?: { kind: "ready"; purpose: GoalDispatchKind } | { kind: "wait" };
	wait?: GoalWait;
	dispatch?: { id: string; kind: GoalDispatchKind; claimedAt: number };
	repairUsed: boolean;
	/** Optional idle pacing, effective only with idleContinuationBackoff=true. */
	idle?: { runs: number; nextAt: number };
}
export type GoalContinuation =
	| { kind: "ready" }
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
	if (s.idle !== undefined && (!s.idle || typeof s.idle !== "object" || !integer(s.idle.runs) || s.idle.runs < 1 || s.idle.runs > 6 || !integer(s.idle.nextAt) || s.idle.nextAt > 8_640_000_000_000_000)) return invalid();
	// Goals saved before next actions were removed still carry decision.nextAction.
	// The field is stripped after validation and never makes a goal invalid:
	// rejecting one would strand it as interrupted with spent allowance.
	if (s.decision && (s.decision.kind !== "wait" && (s.decision.kind !== "ready" || !["ready", "repair", "kickoff", "recovery"].includes(s.decision.purpose)))) return invalid();
	if (s.wait) {
		const w = s.wait;
		if (!text(w.id) || !text(w.token) || !text(w.reason) || (!integer(w.deadline) || w.deadline > 8_640_000_000_000_000)) return invalid();
		if (w.intervalMs !== undefined && (!integer(w.intervalMs) || w.intervalMs < 1000 || !integer(w.remainingChecks) || !integer(w.nextCheckAt))) return invalid();
		if (w.intervalMs === undefined && (w.remainingChecks !== undefined || w.nextCheckAt !== undefined)) return invalid();
		if (w.signalled !== undefined && typeof w.signalled !== "boolean") return invalid();
	}
	if (s.dispatch && (!text(s.dispatch.id) || !integer(s.dispatch.claimedAt) || !["ready", "check", "wake", "repair", "kickoff", "recovery"].includes(s.dispatch.kind))) return invalid();
	if ((s.phase === "claimed" || s.phase === "running") && !s.dispatch) return invalid();
	if (s.phase === "ready" && s.decision?.kind !== "ready") return invalid();
	if (s.phase === "waiting" && (!s.wait || s.decision?.kind !== "wait")) return invalid();
	const normalized = structuredClone(s) as GoalSchedulerState;
	if (normalized.decision && "nextAction" in normalized.decision) delete (normalized.decision as Record<string, unknown>).nextAction;
	return normalized;
}

/**
 * Split scheduling text into an append-safe counter line and the standing
 * instructions. Instructions (next action, wait, admission) are cleared by
 * omission, so a retained stale copy would keep issuing a cancelled order:
 * they belong with the reset-on-change state, never with retained counters.
 */
export function schedulerSummaryParts(s: GoalSchedulerState | undefined, limit?: number, showRuns = true, idleBackoff = false, commands?: GoalCommands, ui = false): { runs: string; instructions: string; idlePacing?: string } {
	// An unlimited allowance has no limit to report, so the runs line is left
	// empty rather than rendered as "used/unlimited". A finite allowance is
	// reported unless showAutonomousRuns is off. Enforcement reads the limit
	// elsewhere; this is display only.
	// `ui` renders for the host UI (follows the locale); the default is the model-facing English text.
	const runs = limit !== undefined && showRuns
		? ui
			? limit === 0
				? t("Autonomous runs: {used}/{limit} (automatic continuation disabled).", { used: s?.used ?? 0, limit })
				: t("Autonomous runs: {used}/{limit}.", { used: s?.used ?? 0, limit })
			: `Autonomous runs: ${s?.used ?? 0}/${limit}${limit === 0 ? " (automatic continuation disabled)" : ""}.`
		: "";
	const lines: string[] = [];
	let idlePacing: string | undefined;
	if (s) {
		if (idleBackoff && s.phase === "ready" && s.decision?.kind === "ready" && s.decision.purpose === "ready" && s.idle && s.idle.nextAt > Date.now()) {
			const seconds = Math.ceil((s.idle.nextAt - Date.now()) / 1000);
			const time = new Date(s.idle.nextAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
			idlePacing = ui
				? t("Next automatic attempt in {seconds}s ({time} local). {command} now.", { seconds, time, command: uiCommandHint("goal-resume", commands) })
				: `Next automatic attempt in ${seconds}s (${time} local). ${commandHint("goal-resume", commands)} now.`;
			lines.push(idlePacing);
		}
		if (s.wait) {
			const deadline = new Date(s.wait.deadline).toISOString();
			lines.push(ui ? t("Waiting: {reason}; wait_id={id}; deadline={deadline}.", { reason: s.wait.reason, id: s.wait.id, deadline }) : `Waiting: ${s.wait.reason}; wait_id=${s.wait.id}; deadline=${deadline}.`);
			if (s.wait.nextCheckAt !== undefined) {
				const next = new Date(s.wait.nextCheckAt).toISOString();
				lines.push(ui ? t("Next check: {next}; {remaining} checks remaining.", { next, remaining: s.wait.remainingChecks ?? 0 }) : `Next check: ${next}; ${s.wait.remainingChecks} checks remaining.`);
			}
		}
		if (s.phase === "interrupted") lines.push(ui ? t("Turn stopped. Resume or send a message to continue.") : "Turn stopped. Resume or send a message to continue.");
		if (s.phase === "claimed") lines.push(commandInstructions(ui ? t("Execution requires dispatch admission or explicit /goal-resume after interruption.") : "Execution requires dispatch admission or explicit /goal-resume after interruption.", commands));
	}
	return { runs, instructions: lines.join("\n"), idlePacing };
}

export function schedulerSummary(s: GoalSchedulerState | undefined, limit?: number, showRuns = true, idleBackoff = false, commands?: GoalCommands): string {
	const { runs, instructions } = schedulerSummaryParts(s, limit, showRuns, idleBackoff, commands);
	return [runs, instructions].filter(Boolean).join("\n");
}
