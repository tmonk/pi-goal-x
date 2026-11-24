/** Every event that can be appended to the goal ledger (one JSON object per line). */
export type GoalLedgerEvent =
	| { type: "goal_created"; goalId: string; objective: string; sisyphus: boolean; autoContinue: boolean; at: string }
	| { type: "goal_focused"; goalId: string; reason: string; at: string }
	| { type: "goal_unfocused"; reason: string; at: string }
	| { type: "goal_paused"; goalId: string; reason: string; suggestedAction?: string; status?: "paused"; source?: "user" | "agent"; at: string }
	| { type: "goal_resumed"; goalId: string; reason: string; at: string }
	| { type: "goal_tweaked"; goalId: string; changeSummary: string; at: string }
	| { type: "auditor_toggled"; goalId: string; enabled: boolean; at: string }
	| { type: "completion_requested"; goalId: string; summary?: string; at: string }
	| { type: "audit_started"; goalId: string; auditId?: string; provider?: string; model?: string; thinkingLevel?: string; at: string }
	| { type: "audit_result"; goalId: string; auditId?: string; verdict: "approved" | "disapproved" | "error"; report: string; at: string }
	| { type: "audit_skipped"; goalId: string; auditId?: string; reason: "disabled" | "user_aborted"; provider?: string; model?: string; thinkingLevel?: string; at: string }
	| { type: "goal_completed"; goalId: string; archivePath?: string; at: string }
	| { type: "goal_archived"; goalId: string; archivePath: string; at: string }
	| { type: "goal_archive_failed"; goalId: string; message: string; at: string }
	| { type: "goal_aborted"; goalId: string; reason: string; archivePath?: string; at: string }
	| { type: "task_list_set"; goalId: string; taskCount: number; blockCompletion: boolean; at: string }
	| { type: "task_complete"; goalId: string; taskId: string; evidence?: string; at: string }
	| { type: "task_skipped"; goalId: string; taskId: string; reason: string; at: string }
	| { type: "task_reopened"; goalId: string; taskId: string; at: string }
	| { type: "task_started"; goalId: string; taskId: string; at: string }
	| { type: "goal_budget_changed"; goalId: string; oldBudget: number | null; newBudget: number | null; tokensUsed: number; at: string }
	| { type: "goal_budget_limited"; goalId: string; budget: number; tokensUsed: number; at: string }
	| { type: "goal_budget_warning"; goalId: string; budget: number; tokensUsed: number; pct: number; at: string }
	| { type: "goal_stalled"; goalId: string; reason: string; at: string }
	| { type: "goal_blocked"; goalId: string; reason: string; source: "agent" | "system"; at: string }
	| { type: "oracle_started"; goalId: string; fingerprint: string; provider: string; model: string; thinkingLevel?: string; reason: string; at: string }
	| { type: "oracle_result"; goalId: string; fingerprint: string; adviceId: string; disposition: "actionable" | "needs_human" | "insufficient_context"; summary: string; recommendedTitle?: string; at: string }
	| { type: "oracle_failed"; goalId: string; fingerprint: string; attempt: number; errorCode: "config" | "provider" | "aborted" | "invalid_output"; message: string; at: string }
	| { type: "oracle_followup_attempted"; goalId: string; fingerprint: string; adviceId: string; firstToolName: string; at: string };

export type GoalAuditEvent = Extract<GoalLedgerEvent, { type: "audit_started" | "audit_result" | "audit_skipped" }>;
