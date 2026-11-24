import type { GoalLedgerEvent } from "./goal-ledger.ts";
import type { OracleConsultState } from "./goal-oracle.ts";
import { isActivityEvent, sameActivityEvent } from "./goal-activity.ts";

/** Bounded working set per goal; complete history remains in the JSONL ledger. */
type GoalAuditEvent = Extract<GoalLedgerEvent, {type: "audit_started" | "audit_result" | "audit_skipped"}>;
export function auditApplies(latestId: string | undefined, event: GoalAuditEvent): boolean {
	return event.type === "audit_started" || (event.type === "audit_skipped" && event.reason === "disabled") || latestId === undefined || event.auditId === latestId;
}

export interface GoalLedgerIndex {
	recent: GoalLedgerEvent[];
	activity: GoalLedgerEvent[];
	lastActivityEvent?: GoalLedgerEvent;
	audit?: GoalAuditEvent;
	auditStarted?: GoalAuditEvent;
	settledAudit?: GoalAuditEvent;
	completion?: GoalLedgerEvent;
	lifecycle?: GoalLedgerEvent;
	oracle: Map<string, OracleConsultState>;
}
function newGoalLedgerIndex(): GoalLedgerIndex {
	return { recent: [], activity: [], oracle: new Map() };
}
const lifecycleEvents = new Set(["goal_created", "goal_paused", "goal_resumed", "goal_blocked", "goal_budget_limited", "goal_completed", "goal_aborted", "goal_archived"]);
export function indexLedgerEvent(index: Map<string, GoalLedgerIndex>, event: GoalLedgerEvent): void {
	if (!("goalId" in event)) return;
	let goal = index.get(event.goalId);
	if (!goal) { goal = newGoalLedgerIndex(); index.set(event.goalId, goal); }
	goal.recent.push(event);
	if (goal.recent.length > 12) goal.recent.shift();
	if (lifecycleEvents.has(event.type)) goal.lifecycle = event;
	if (event.type === "audit_started" || event.type === "audit_result" || event.type === "audit_skipped") {
		if (event.type === "audit_started") goal.auditStarted = event;
		if (event.type === "audit_result") goal.settledAudit = event;
		if (auditApplies(goal.audit?.auditId, event)) goal.audit = event;
	}
	if (event.type === "completion_requested") goal.completion = event;
	if (isActivityEvent(event) && (!goal.lastActivityEvent || !sameActivityEvent(event, goal.lastActivityEvent))) {
		goal.lastActivityEvent = event;
		// Stable insertion after equal timestamps matches Array.sort's tie order.
		const last = goal.activity[goal.activity.length - 1];
		if (!last || event.at >= last.at) goal.activity.push(event);
			else {
			let low = 0; let high = goal.activity.length;
			while (low < high) {
				const mid = (low + high) >>> 1;
				if (goal.activity[mid]!.at <= event.at) low = mid + 1;
					else high = mid;
			}
			goal.activity.splice(low, 0, event);
		}
		if (goal.activity.length > 64) goal.activity.shift();
	}
	if ("fingerprint" in event) {
		const prior = goal.oracle.get(event.fingerprint) ?? { failedAttempts: 0, followupAttempted: false };
		const state = { ...prior };
		if (event.type === "oracle_result") state.result = { adviceId: event.adviceId, disposition: event.disposition, summary: event.summary };
		if (event.type === "oracle_failed") { state.failedAttempts++; state.lastFailure = { errorCode: event.errorCode, message: event.message }; }
		if (event.type === "oracle_followup_attempted") state.followupAttempted = true;
		goal.oracle.set(event.fingerprint, state);
	}
}
export function buildLedgerIndex(events: readonly GoalLedgerEvent[]): Map<string, GoalLedgerIndex> {
	const index = new Map<string, GoalLedgerIndex>();
	for (const event of events) indexLedgerEvent(index, event);
	return index;
}
