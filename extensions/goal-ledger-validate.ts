import { safeIdPart } from "./goal-record.ts";
import type { GoalLedgerEvent } from "./goal-ledger-events.ts";

type Check = (value: unknown) => boolean;

const str: Check = (v) => typeof v === "string";
const num: Check = (v) => typeof v === "number";
const bool: Check = (v) => typeof v === "boolean";
const optional = (check: Check): Check => (v) => v === undefined || check(v);
const oneOf = (...allowed: unknown[]): Check => (v) => allowed.includes(v);
const budget: Check = (v) => v === null || (Number.isSafeInteger(v) && Number(v) > 0);

const optStr = optional(str);
const verdict = oneOf("approved", "disapproved", "error");
const disposition = oneOf("actionable", "needs_human", "insufficient_context");

/** Required shape of every ledger event type, beyond `type` and `at`. */
const EVENT_FIELDS: Record<GoalLedgerEvent["type"], Record<string, Check>> = {
	goal_created: { goalId: str, objective: str, sisyphus: bool, autoContinue: bool },
	goal_focused: { goalId: str, reason: str },
	goal_unfocused: { reason: str },
	goal_paused: { goalId: str, reason: str, suggestedAction: optStr, status: optional(oneOf("paused")), source: optional(oneOf("user", "agent")) },
	goal_resumed: { goalId: str, reason: str },
	goal_tweaked: { goalId: str, changeSummary: str },
	auditor_toggled: { goalId: str, enabled: bool },
	completion_requested: { goalId: str, summary: optStr },
	audit_started: { goalId: str, provider: optStr, model: optStr, thinkingLevel: optStr },
	audit_result: { goalId: str, verdict, report: str },
	audit_skipped: { goalId: str, reason: oneOf("disabled", "user_aborted"), provider: optStr, model: optStr, thinkingLevel: optStr },
	goal_completed: { goalId: str, archivePath: optStr },
	goal_archived: { goalId: str, archivePath: str },
	goal_archive_failed: { goalId: str, message: str },
	goal_aborted: { goalId: str, reason: str, archivePath: optStr },
	task_list_set: { goalId: str, taskCount: num, blockCompletion: bool },
	task_complete: { goalId: str, taskId: str, evidence: optStr },
	task_skipped: { goalId: str, taskId: str, reason: str },
	task_reopened: { goalId: str, taskId: str },
	task_started: { goalId: str, taskId: str },
	goal_budget_changed: { goalId: str, oldBudget: budget, newBudget: budget, tokensUsed: num },
	goal_budget_limited: { goalId: str, budget: num, tokensUsed: num },
	goal_budget_warning: { goalId: str, budget: num, tokensUsed: num, pct: num },
	goal_stalled: { goalId: str, reason: str },
	goal_blocked: { goalId: str, reason: str, source: oneOf("agent", "system") },
	oracle_started: { goalId: str, fingerprint: str, provider: str, model: str, reason: str, thinkingLevel: optStr },
	oracle_result: { goalId: str, fingerprint: str, adviceId: str, disposition, summary: str },
	oracle_failed: { goalId: str, fingerprint: str, attempt: num, errorCode: oneOf("config", "provider", "aborted", "invalid_output"), message: str },
	oracle_followup_attempted: { goalId: str, fingerprint: str, adviceId: str, firstToolName: str },
};

/** The field checks of each event type as arrays, so validating an event allocates nothing. */
const EVENT_CHECKS = new Map(Object.entries(EVENT_FIELDS).map(([type, fields]) => [type, Object.entries(fields)]));

const AUDIT_TYPES = new Set(["audit_started", "audit_result", "audit_skipped"]);

export function isValidLedgerEvent(value: unknown): value is GoalLedgerEvent {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const obj = value as Record<string, unknown>;
	if (typeof obj.type !== "string" || typeof obj.at !== "string") return false;
	const checks = EVENT_CHECKS.get(obj.type);
	if (!checks) return false;
	if (AUDIT_TYPES.has(obj.type) && obj.auditId !== undefined && (typeof obj.auditId !== "string" || !obj.auditId)) return false;
	for (const [field, check] of checks) {
		if (!check(obj[field])) return false;
	}
	return true;
}

/** Normalize the goal id of an event; events without a goal id pass through unchanged. */
export function sanitizeEvent(event: GoalLedgerEvent): GoalLedgerEvent {
	if (!("goalId" in event)) return event;
	return { ...event, goalId: safeIdPart(event.goalId) };
}
