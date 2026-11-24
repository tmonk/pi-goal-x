/**
 * Folding ledger events into per-goal state. The fold is incremental: a
 * checkpoint stores the accumulator mid-stream and replays only the ledger
 * tail, then finalizes once.
 */
import type { GoalLedgerEvent } from "./goal-ledger-events.ts";
import { auditApplies } from "./goal-ledger-index.ts";
import type { ReconstructAccumulator, ReconstructedGoalState } from "./goal-ledger-checkpoint.ts";

export interface ReconstructedLedgerState {
	focusedGoalId: string | null;
	goals: Map<string, ReconstructedGoalState>;
	terminalGoals: Map<string, ReconstructedGoalState>;
}

export function reconstructGoalLedger(events: GoalLedgerEvent[]): ReconstructedLedgerState {
	return finalizeLedgerState(applyLedgerEvents(freshAccumulator(), events));
}

export function freshAccumulator(): ReconstructAccumulator {
	return {
		goals: new Map(),
		terminalGoals: new Map(),
		focusedGoalId: null,
		focusGeneration: 0,
		focusGenByGoal: new Map(),
	};
}

export function applyLedgerEvents(acc: ReconstructAccumulator, events: GoalLedgerEvent[]): ReconstructAccumulator {
	// Locals instead of property chains: B3.reconstruct is measured over 10k
	// event lists and must hold the NAF 10x headroom (0.3ms at 5k).
	const goals = acc.goals;
	const terminalGoals = acc.terminalGoals;
	const focusGenByGoal = acc.focusGenByGoal;
	let focusedGoalId = acc.focusedGoalId;
	let focusGeneration = acc.focusGeneration;

	/** Move a goal to the terminal map, creating a stub when its creation event is missing. */
	const settle = (goalId: string, status: "complete" | "aborted"): ReconstructedGoalState => {
		const state = goals.get(goalId) ?? { goalId, latestStatus: status, latestFocus: false };
		state.latestStatus = status;
		terminalGoals.set(goalId, state);
		goals.delete(goalId);
		return state;
	};

	for (const event of events) {
		switch (event.type) {
			case "goal_created":
				goals.set(event.goalId, { goalId: event.goalId, latestStatus: "active", latestFocus: false, createdAt: event.at });
				break;
			case "goal_focused":
				focusedGoalId = event.goalId;
				focusGeneration++;
				if (goals.has(event.goalId) || terminalGoals.has(event.goalId)) focusGenByGoal.set(event.goalId, focusGeneration);
				break;
			case "goal_unfocused":
				focusedGoalId = null;
				focusGeneration++;
				break;
			case "goal_paused": {
				const state = goals.get(event.goalId);
				if (!state) break;
				state.latestStatus = event.status ?? "paused";
				state.latestPauseReason = event.reason;
				state.latestPauseSuggestedAction = event.suggestedAction;
				break;
			}
			case "goal_resumed": {
				const state = goals.get(event.goalId);
				if (!state) break;
				state.latestStatus = "active";
				state.resumedAt = event.at;
				delete state.latestPauseReason;
				delete state.latestPauseSuggestedAction;
				break;
			}
			case "goal_tweaked": {
				const state = goals.get(event.goalId);
				if (state) state.tweakedAt = event.at;
				break;
			}
			case "audit_started":
			case "audit_skipped":
			case "audit_result": {
				const state = goals.get(event.goalId) ?? terminalGoals.get(event.goalId);
				if (state && auditApplies(state.latestAuditId, event)) {
					state.latestAuditId = event.auditId;
					state.latestAuditorResult = event.type === "audit_result"
						? { verdict: event.verdict, report: event.report, at: event.at }
						: undefined;
				}
				break;
			}
			case "goal_completed":
				settle(event.goalId, "complete").completedAt = event.at;
				break;
			case "goal_aborted":
				settle(event.goalId, "aborted").abortedAt = event.at;
				break;
			case "oracle_result": {
				const state = goals.get(event.goalId) ?? terminalGoals.get(event.goalId);
				if (state) {
					state.latestOracleResult = {
						fingerprint: event.fingerprint,
						adviceId: event.adviceId,
						disposition: event.disposition,
						summary: event.summary,
						at: event.at,
					};
				}
				break;
			}
			default:
				// Other events (completion requests, oracle metadata, tasks, budgets)
				// do not change reconstructed state.
				break;
		}
	}
	acc.focusedGoalId = focusedGoalId;
	acc.focusGeneration = focusGeneration;
	return acc;
}

/** Materialize focus flags once (O(goals)), clearing focus on terminal goals. */
export function finalizeLedgerState(acc: ReconstructAccumulator): ReconstructedLedgerState {
	const { goals, terminalGoals, focusGenByGoal } = acc;
	const focusGeneration = acc.focusGeneration;
	// Materialize the generation-based focus flags (O(goals) once, not per event).
	for (const g of goals.values()) g.latestFocus = focusGenByGoal.get(g.goalId) === focusGeneration;
	for (const g of terminalGoals.values()) g.latestFocus = focusGenByGoal.get(g.goalId) === focusGeneration;

	// If the focused goal was moved to terminal (e.g., aborted/completed), clear focus.
	if (acc.focusedGoalId && !goals.has(acc.focusedGoalId)) {
		acc.focusedGoalId = null;
	}

	return { focusedGoalId: acc.focusedGoalId, goals, terminalGoals };
}

/** Shallow-clone an accumulator so finalizing (or extending) never mutates a cached copy. */
export function cloneAccumulator(acc: ReconstructAccumulator): ReconstructAccumulator {
	return {
		goals: new Map(acc.goals),
		terminalGoals: new Map(acc.terminalGoals),
		focusedGoalId: acc.focusedGoalId,
		focusGeneration: acc.focusGeneration,
		focusGenByGoal: new Map(acc.focusGenByGoal),
	};
}
