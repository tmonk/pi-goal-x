import type { GoalLedgerEvent } from "./goal-ledger.ts";
import type { GoalLedgerIndex } from "./goal-ledger-index.ts";
import { isValidLedgerEvent, sanitizeEvent } from "./goal-ledger-validate.ts";

// On-disk ledger checkpoint: the reconstructed accumulator, per-goal recent
// event tails, the runtime index, and the byte length of the ledger they cover.
// The JSONL ledger stays authoritative; any file that fails validation here is
// ignored and the ledger is parsed in full.

export const LEDGER_CHECKPOINT_FILE = ".goal-ledger-checkpoint.json";
export const LEDGER_CHECKPOINT_VERSION = 4;

export interface ReconstructedGoalState {
	goalId: string;
	latestStatus: "active" | "paused" | "complete" | "aborted" | "unknown";
	latestFocus: boolean;
	latestPauseReason?: string;
	latestPauseSuggestedAction?: string;
	latestAuditId?: string;
	latestAuditorResult?: { verdict: "approved" | "disapproved" | "error"; report: string; at: string };
	/** Issue #26: bounded latest Oracle disposition for this goal. */
	latestOracleResult?: { fingerprint: string; adviceId: string; disposition: "actionable" | "needs_human" | "insufficient_context"; summary: string; at: string };
	createdAt?: string;
	completedAt?: string;
	abortedAt?: string;
	tweakedAt?: string;
	resumedAt?: string;
}

/**
 * Incremental reconstruction accumulator (checkpoint support).
 *
 * reconstructGoalLedger(events) === finalizeLedgerState(applyLedgerEvents(fresh(), events)),
 * so a checkpoint can store the accumulator mid-stream and replay only the
 * ledger tail by applying the remaining events, then finalizing once.
 */
export interface ReconstructAccumulator {
	goals: Map<string, ReconstructedGoalState>;
	terminalGoals: Map<string, ReconstructedGoalState>;
	focusedGoalId: string | null;
	focusGeneration: number;
	focusGenByGoal: Map<string, number>;
}

/** In-memory ledger checkpoint (maps in native form). */
export interface LedgerCheckpoint {
	version: typeof LEDGER_CHECKPOINT_VERSION;
	format: "goal-ledger-checkpoint";
	createdAt: string;
	/** Byte length of the ledger covered (compared against stat().size). */
	coveredBytes: number;
	/** Number of ledger events covered. */
	coveredEvents: number;
	/** Pre-finalize accumulator (focus bookkeeping kept for incremental tail apply). */
	acc: ReconstructAccumulator;
	/** Per-goal recent-event tails (capped), already sanitized. */
	recentEventsByGoal: Map<string, GoalLedgerEvent[]>;
	runtimeIndex: Map<string, GoalLedgerIndex>;
}

const GOAL_STATUSES = ["active", "paused", "complete", "aborted", "unknown"];
const ORACLE_DISPOSITIONS = ["actionable", "needs_human", "insufficient_context"];

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function isNonNegativeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** JSON-safe checkpoint shape (Maps serialized as arrays). */
export function checkpointToJson(cp: LedgerCheckpoint): unknown {
	const goalStateToJson = (s: ReconstructedGoalState) => ({
		goalId: s.goalId,
		latestStatus: s.latestStatus,
		latestFocus: s.latestFocus,
		latestPauseReason: s.latestPauseReason,
		latestPauseSuggestedAction: s.latestPauseSuggestedAction,
		latestAuditorResult: s.latestAuditorResult,
		latestAuditId: s.latestAuditId,
		latestOracleResult: s.latestOracleResult,
		createdAt: s.createdAt,
		completedAt: s.completedAt,
		abortedAt: s.abortedAt,
		tweakedAt: s.tweakedAt,
		resumedAt: s.resumedAt,
	});
	const mapToJson = (m: Map<string, ReconstructedGoalState>) => Array.from(m.values()).map(goalStateToJson);
	return {
		version: cp.version,
		format: cp.format,
		createdAt: cp.createdAt,
		coveredBytes: cp.coveredBytes,
		coveredEvents: cp.coveredEvents,
		acc: {
			goals: mapToJson(cp.acc.goals),
			terminalGoals: mapToJson(cp.acc.terminalGoals),
			focusedGoalId: cp.acc.focusedGoalId,
			focusGeneration: cp.acc.focusGeneration,
			focusGenByGoal: Array.from(cp.acc.focusGenByGoal.entries()),
		},
		recentEventsByGoal: Array.from(cp.recentEventsByGoal.entries()),
		runtimeIndex: Array.from(cp.runtimeIndex, ([id, entry]) => [id, { ...entry, oracle: Array.from(entry.oracle) }]),
	};
}

function parseGoalState(value: unknown): ReconstructedGoalState | null {
	if (!isRecord(value) || typeof value.goalId !== "string") return null;
	const latestStatus = value.latestStatus;
	if (typeof latestStatus !== "string" || !GOAL_STATUSES.includes(latestStatus)) return null;
	const auditor = value.latestAuditorResult as Record<string, unknown> | undefined;
	if (auditor !== undefined) {
		if (auditor.verdict !== "approved" && auditor.verdict !== "disapproved" && auditor.verdict !== "error") return null;
		if (typeof auditor.report !== "string" || typeof auditor.at !== "string") return null;
	}
	const oracle = value.latestOracleResult as Record<string, unknown> | undefined;
	if (oracle !== undefined && (!oracle || typeof oracle.fingerprint !== "string" || typeof oracle.adviceId !== "string" || typeof oracle.summary !== "string" || typeof oracle.at !== "string"
		|| !ORACLE_DISPOSITIONS.includes(oracle.disposition as string))) return null;
	return {
		goalId: value.goalId,
		latestStatus: latestStatus as ReconstructedGoalState["latestStatus"],
		latestFocus: value.latestFocus === true,
		latestAuditId: optionalString(value.latestAuditId),
		latestOracleResult: oracle as ReconstructedGoalState["latestOracleResult"],
		latestPauseReason: optionalString(value.latestPauseReason),
		latestPauseSuggestedAction: optionalString(value.latestPauseSuggestedAction),
		latestAuditorResult: auditor
			? { verdict: auditor.verdict as "approved" | "disapproved" | "error", report: auditor.report as string, at: auditor.at as string }
			: undefined,
		createdAt: optionalString(value.createdAt),
		completedAt: optionalString(value.completedAt),
		abortedAt: optionalString(value.abortedAt),
		tweakedAt: optionalString(value.tweakedAt),
		resumedAt: optionalString(value.resumedAt),
	};
}

function parseGoalStateMap(values: unknown[]): Map<string, ReconstructedGoalState> | null {
	const result = new Map<string, ReconstructedGoalState>();
	for (const raw of values) {
		const state = parseGoalState(raw);
		if (!state) return null;
		result.set(state.goalId, state);
	}
	return result;
}

function isValidOracleEntry(pair: unknown): boolean {
	if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== "string" || !pair[1] || typeof pair[1] !== "object") return false;
	const state = pair[1] as Record<string, unknown>;
	if (!Number.isSafeInteger(state.failedAttempts) || (state.failedAttempts as number) < 0 || typeof state.followupAttempted !== "boolean") return false;
	const result = state.result as Record<string, unknown> | undefined;
	if (result !== undefined && (!result || typeof result.adviceId !== "string" || typeof result.summary !== "string" || !ORACLE_DISPOSITIONS.includes(result.disposition as string))) return false;
	const failure = state.lastFailure as Record<string, unknown> | undefined;
	return failure === undefined || Boolean(failure && typeof failure.errorCode === "string" && typeof failure.message === "string");
}

function parseRuntimeIndex(pairs: unknown[]): Map<string, GoalLedgerIndex> | null {
	const result = new Map<string, GoalLedgerIndex>();
	for (const pair of pairs) {
		if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== "string") return null;
		const entry = pair[1];
		if (!entry || !Array.isArray(entry.recent) || !Array.isArray(entry.activity) || !Array.isArray(entry.oracle)) return null;
		if (entry.recent.length > 12 || entry.activity.length > 64) return null;
		if (entry.activity.length > 0 && !entry.lastActivityEvent) return null;
		const pinned = [entry.audit, entry.auditStarted, entry.settledAudit, entry.completion, entry.lifecycle, entry.lastActivityEvent].filter(Boolean);
		if (![...entry.recent, ...entry.activity, ...pinned].every(isValidLedgerEvent)) return null;
		if (!entry.oracle.every(isValidOracleEntry)) return null;
		result.set(pair[0], { ...entry, oracle: new Map(entry.oracle) });
	}
	return result;
}

function parseRecentEvents(pairs: [unknown, unknown][]): Map<string, GoalLedgerEvent[]> {
	const result = new Map<string, GoalLedgerEvent[]>();
	for (const [goalId, events] of pairs) {
		if (typeof goalId !== "string" || !Array.isArray(events)) continue;
		const clean = events.filter(isValidLedgerEvent).map((event) => sanitizeEvent(event));
		if (clean.length > 0) result.set(goalId, clean);
	}
	return result;
}

/** Parse + validate a checkpoint file body; null on any mismatch (version/format/shape). */
export function checkpointFromJson(value: unknown): LedgerCheckpoint | null {
	if (!isRecord(value)) return null;
	if (value.version !== LEDGER_CHECKPOINT_VERSION || value.format !== "goal-ledger-checkpoint") return null;
	if (!isNonNegativeInteger(value.coveredBytes) || !isNonNegativeInteger(value.coveredEvents)) return null;
	const acc = value.acc as Record<string, unknown> | undefined;
	if (!acc || typeof acc.focusGeneration !== "number" || !Number.isSafeInteger(acc.focusGeneration)) return null;
	if (!Array.isArray(acc.goals) || !Array.isArray(acc.terminalGoals) || !Array.isArray(acc.focusGenByGoal)) return null;
	if (!Array.isArray(value.recentEventsByGoal) || !Array.isArray(value.runtimeIndex)) return null;

	const goals = parseGoalStateMap(acc.goals);
	const terminalGoals = parseGoalStateMap(acc.terminalGoals);
	const runtimeIndex = parseRuntimeIndex(value.runtimeIndex);
	if (!goals || !terminalGoals || !runtimeIndex) return null;

	const focusGenByGoal = new Map<string, number>();
	for (const [goalId, generation] of acc.focusGenByGoal as [unknown, unknown][]) {
		if (typeof goalId === "string" && typeof generation === "number") focusGenByGoal.set(goalId, generation);
	}
	return {
		runtimeIndex,
		version: LEDGER_CHECKPOINT_VERSION,
		format: "goal-ledger-checkpoint",
		createdAt: typeof value.createdAt === "string" ? value.createdAt : "",
		coveredBytes: value.coveredBytes,
		coveredEvents: value.coveredEvents,
		acc: {
			goals,
			terminalGoals,
			focusedGoalId: typeof acc.focusedGoalId === "string" ? acc.focusedGoalId : null,
			focusGeneration: acc.focusGeneration,
			focusGenByGoal,
		},
		recentEventsByGoal: parseRecentEvents(value.recentEventsByGoal),
	};
}
