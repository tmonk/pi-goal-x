import { type Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
	formatDuration,
	formatTokenValue,
	statusLabel,
	truncateText,
} from "./goal-core.ts";
import { buildTaskSummary } from "./goal-policy.ts";
import { GOAL_PROGRESS_TOOL_NAMES } from "./goal-tool-names.ts";
import {
	asRecord,
	cloneGoal,
	type GoalEventDetails,
	type GoalEventKind,
	type GoalMode,
	type GoalRecord,
	type GoalStateEntry,
	type GoalStatus,
} from "./goal-record.ts";

export const STATE_ENTRY = "pi-goal-state";
export const FOCUS_ENTRY = "pi-goal-focus";
export const GOAL_EVENT_ENTRY = "pi-goal-event";
export const GOAL_AUDIT_ENTRY = "pi-goal-audit-event";
export const COMPLETE_STATUS = "complete";
/**
 * Tools that count as "real work" toward the active goal. If a non-tool-use
 * turn ends without any of these having been called, we DO NOT queue the next
 * autoContinue — the agent was just chatting. This stops infinite chat loops.
 */
export const GOAL_PROGRESS_TOOL_SET = new Set<string>(GOAL_PROGRESS_TOOL_NAMES);

// ---------- summaries ----------

export function usageLines(goal: GoalRecord): string[] {
	return [
		`Time spent: ${formatDuration(goal.usage.activeSeconds)}`,
		`Tokens used: ${formatTokenValue(goal.usage.tokensUsed)}`,
	];
}

export function detailedSummary(goal: GoalRecord | null): string {
	if (!goal) return "No goal is set. Use /goal <objective> or /sisyphus <objective> to start immediately.";
	const lines = [
		`Goal: ${goal.objective}`,
		`Status: ${statusLabel(goal)}`,
		`Auto-continue: ${goal.autoContinue ? "on" : "off"}`,
		...usageLines(goal),
	];
	if (goal.sisyphus) {
		lines.push("Mode: Sisyphus (prompt/criteria variant; shared goal lifecycle)");
	}
	if (goal.taskList) {
		const taskSummary = buildTaskSummary(goal.taskList);
		lines.push(`Tasks: ${taskSummary}`);
		// Find first pending task at any depth (BFS)
		const queue = [...(goal.taskList.tasks ?? [])];
		let firstPending: { id: string; title: string } | undefined;
		while (queue.length > 0 && !firstPending) {
			const t = queue.shift()!;
			if (t.status === "pending") firstPending = t;
			else if (t.subtasks) queue.push(...t.subtasks);
		}
		if (firstPending) {
			lines.push(`Next pending task: ${firstPending.id} — ${firstPending.title}`);
		}
	}
	if (goal.activePath) lines.push(`File: ${goal.activePath}`);
	if (goal.archivedPath) lines.push(`Archive: ${goal.archivedPath}`);
	if (goal.stopReason) lines.push(`Stop reason: ${goal.stopReason}`);
	if (goal.pauseReason) lines.push(`Agent pause reason: ${goal.pauseReason}`);
	if (goal.pauseSuggestedAction) lines.push(`Agent suggests: ${goal.pauseSuggestedAction}`);
	return lines.join("\n");
}

export function oneLineSummary(goal: GoalRecord | null): string {
	if (!goal) return "No goal is set.";
	const tail = goal.usage.tokensUsed > 0 ? ` [${formatTokenValue(goal.usage.tokensUsed).split(" ")[0]}]` : "";
	return `${statusLabel(goal)}${tail} - ${truncateText(goal.objective)}`;
}

// ---------- entry / render helpers ----------

export function goalDetails(goal: GoalRecord | null): GoalStateEntry {
	return { version: 3, goal: goal ? cloneGoal(goal) : null };
}

export function renderGoalResult(result: { details?: unknown; content: Array<{ type: string; text?: string }> }, theme: Theme): Text {
	const first = result.content.find((item) => item.type === "text" && typeof item.text === "string");
	const firstText = first?.text ?? "";
	const details = result.details as GoalStateEntry | undefined;
	if (!details || typeof details !== "object" || !("goal" in details)) {
		return new Text(firstText, 0, 0);
	}
	if (
		firstText.startsWith("Goal audit ")
		|| firstText.startsWith("Goal completion rejected")
		|| firstText.startsWith("Goal complete.")
		|| firstText.startsWith("Goal paused.")
		|| firstText.startsWith("Goal aborted.")
		|| firstText.startsWith("Goal confirmed and created.")
	) {
		return new Text(firstText, 0, 0);
	}
	return new Text(theme.fg("accent", "Goal ") + theme.fg("muted", oneLineSummary(details.goal)), 0, 0);
}

export function normalizeGoalEventDetails(value: unknown): GoalEventDetails {
	const raw = asRecord(value);
	// "checkpoint" is the only kind writers emit today; "stale" remains a
	// legacy read for historical checkpoint entries.
	const kind: GoalEventKind = raw?.kind === "stale" ? "stale" : "checkpoint";
	const goalId = typeof raw?.goalId === "string" ? raw.goalId : "unknown";
	const focus: GoalMode | undefined = raw?.focus === "sisyphus" ? "sisyphus" : raw?.focus === "goal" ? "goal" : undefined;
	const status = raw?.status === "active" || raw?.status === "paused" || raw?.status === "complete" ? (raw.status as GoalStatus) : undefined;
	const currentStatus =
		raw?.currentStatus === "active" || raw?.currentStatus === "paused" || raw?.currentStatus === "complete"
			? (raw.currentStatus as GoalStatus)
			: raw?.currentStatus === null
				? null
				: undefined;
	return {
		kind,
		goalId,
		status,
		objective: typeof raw?.objective === "string" ? raw.objective : undefined,
		timestamp: typeof raw?.timestamp === "number" ? raw.timestamp : undefined,
		currentGoalId: typeof raw?.currentGoalId === "string" || raw?.currentGoalId === null ? raw.currentGoalId : undefined,
		currentStatus,
		focus,
	};
}

export interface GoalAuditEventDetails {
	phase: "started" | "approved" | "rejected" | "skipped";
	goalId: string;
	auditor?: string;
}

export function renderGoalEvent(message: { details?: GoalEventDetails }, options: { expanded: boolean }, theme: Theme): Text {
	const details = normalizeGoalEventDetails(message.details);
	const label = details.kind === "stale" ? "stale checkpoint" : "checkpoint";
	if (!options.expanded) {
		return new Text(theme.fg("customMessageLabel", "Goal ") + theme.fg("customMessageText", label), 0, 0);
	}
	const lines = [`Status: ${details.status === "active" ? "running" : details.status ?? "unknown"}`];
	if (details.objective) lines.push(`Objective: ${details.objective}`);
	lines.push(`Goal id: ${details.goalId}`);
	if (details.currentGoalId || details.currentStatus) {
		lines.push(`Current: ${details.currentGoalId ?? "none"}${details.currentStatus ? ` (${details.currentStatus})` : ""}`);
	}
	return new Text(
		theme.fg("customMessageLabel", `Goal ${label}`) + "\n" + theme.fg("customMessageText", lines.join("\n")),
		0,
		0,
	);
}

export function renderGoalAuditEvent(message: { content?: unknown; details?: GoalAuditEventDetails }, _options: { expanded: boolean }, theme: Theme): Text {
	const phase = message.details?.phase ?? "started";
	const label = phase === "approved" ? "approved" : phase === "rejected" ? "rejected" : phase === "skipped" ? "skipped" : "started";
	const content = typeof message.content === "string" ? message.content : `Goal audit ${label}.`;
	return new Text(
		theme.fg("customMessageLabel", `Goal audit ${label}`) + "\n" + theme.fg("customMessageText", content),
		0,
		0,
	);
}

export function extractGoalIdFromInjectedMessage(text: string): string | null {
	// Phase 5 C1: structured outer marker `<pi_goal_continuation goal_id="..." kind="...">`.
	// Borrowed from pi-codex-goal. More robust than bare bracket text because
	// the angle brackets + attributes are nearly impossible for users to type
	// by accident, and the structure is grep-able / parse-able by external tooling.
	const xmlMatch = text.match(/^<pi_goal_continuation\s+goal_id=\"([^\"]+)\"/);
	if (xmlMatch) return xmlMatch[1] ?? null;
	const match = text.match(/^\[(?:GOAL CHECKPOINT|GOAL CONTINUATION|GOAL STALE) goalId=([^\]\s]+)\]/);
	return match?.[1] ?? null;
}

export function goalEventMessageId(message: { customType?: string; details?: unknown; content?: unknown }): string | null {
	if (message.customType !== GOAL_EVENT_ENTRY) return null;
	const details = asRecord(message.details);
	const goalId = details && typeof details.goalId === "string" ? details.goalId : null;
	if (goalId) return goalId;
	return typeof message.content === "string" ? extractGoalIdFromInjectedMessage(message.content) : null;
}

export function isAbortedAssistantMessage(message: unknown): boolean {
	const raw = asRecord(message);
	return raw?.role === "assistant" && raw.stopReason === "aborted";
}

export function isToolUseAssistantMessage(message: unknown): boolean {
	const raw = asRecord(message);
	return raw?.role === "assistant" && raw.stopReason === "toolUse";
}

export function hasAbortedAssistantMessage(messages: unknown[]): boolean {
	return messages.some(isAbortedAssistantMessage);
}

export function usageChannelTokens(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return 0;
	return Math.max(0, Math.trunc(value));
}

export function assistantTurnTokens(message: unknown): number {
	const raw = asRecord(message);
	if (!raw || raw.role !== "assistant") return 0;
	const usage = asRecord(raw.usage);
	if (!usage) return 0;
	return usageChannelTokens(usage.input) + usageChannelTokens(usage.output);
}

export function isMeaningfulProgressToolCall(toolName: string, args: unknown): boolean {
	if (!GOAL_PROGRESS_TOOL_SET.has(toolName)) return false;
	if (toolName === "read") {
		const path = asRecord(args)?.path;
		if (typeof path === "string" && (path === ".pi/goals" || path.startsWith(".pi/goals/"))) return false;
	}
	if (toolName === "bash") {
		const command = asRecord(args)?.command;
		if (typeof command === "string" && /^\s*echo\b/.test(command)) return false;
	}
	return true;
}
