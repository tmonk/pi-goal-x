import { appendGoalEvent, appendGoalEvents, type GoalLedgerEvent } from "./goal-ledger.ts";
import type { GoalDiagnostic, GoalServiceContext } from "./goal-service-types.ts";

/**
 * Append ledger events without making them part of the authoritative state
 * transaction. A batch is the common path; individual retries preserve the
 * best-effort behavior and keep failures observable per event. Returns false
 * when any event could not be appended.
 *
 * This is one of the modules allowed to call the ledger primitives; GoalService
 * is its only caller.
 */
export function appendLedgerEventsBestEffort(ctx: GoalServiceContext, events: GoalLedgerEvent[], onDiagnostic: (diagnostic: GoalDiagnostic) => void): boolean {
	if (events.length === 0) return true;
	if (events.length > 1 && appendGoalEvents(ctx, events).ok) return true;
	let success = true;
	for (const event of events) {
		const append = appendGoalEvent(ctx, event);
		if (!append.ok) {
			success = false;
			onDiagnostic({
				severity: "warning",
				source: "ledger",
				goalId: "goalId" in event ? event.goalId : undefined,
				eventType: event.type,
				message: `Ledger append failed for ${event.type}${"goalId" in event ? ` (goal ${event.goalId})` : ""}: ${String(append.error)}`,
			});
		}
	}
	return success;
}
