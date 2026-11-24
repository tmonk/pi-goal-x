/** Read-only lookups over a list of ledger events (latest audit, recent events for a goal). */
import type { GoalAuditEvent, GoalLedgerEvent } from "./goal-ledger-events.ts";
import { auditApplies } from "./goal-ledger-index.ts";

/** New attempts supersede old verdicts; overlapping attempts match by identity. */
export function latestAuditForGoal(events: GoalLedgerEvent[], goalId: string): GoalAuditEvent | undefined {
	let latest: GoalAuditEvent | undefined;
	for (const event of events) {
		if ((event.type === "audit_started" || event.type === "audit_result" || event.type === "audit_skipped") && event.goalId === goalId && auditApplies(latest?.auditId, event)) latest = event;
	}
	return latest;
}

export function latestAuditorResultForGoal(events: GoalLedgerEvent[], goalId: string): {verdict: "approved" | "disapproved" | "error"; report: string; at: string} | undefined {
	const latest = latestAuditForGoal(events, goalId);
	return latest?.type === "audit_result" ? {verdict: latest.verdict, report: latest.report, at: latest.at} : undefined;
}

export function latestSettledAuditorResultForGoal(events: GoalLedgerEvent[], goalId: string): { verdict: "approved" | "disapproved" | "error"; report: string; at: string } | undefined {
	for (let i = events.length - 1; i >= 0; i--) {
		const event = events[i]!
		if (event.type === "audit_result" && event.goalId === goalId) {
			return { verdict: event.verdict, report: event.report, at: event.at };
		}
	}
	return undefined;
}

export function latestEventsForGoal(events: GoalLedgerEvent[], goalId: string, limit = 10): GoalLedgerEvent[] {
	const result: GoalLedgerEvent[] = [];
	for (let i = events.length - 1; i >= 0; i--) {
		const event = events[i]!
		if ("goalId" in event && event.goalId === goalId) {
			result.unshift(event);
			if (result.length >= limit) break;
		}
	}
	return result;
}
