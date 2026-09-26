import { type Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
	formatDuration,
	formatTokenValue,
	statusLabel,
	truncateText,
} from "./goal-core.ts";
import { buildTaskSummary } from "./goal-policy.ts";
import { countTaskSubtree } from "./goal-task-count.ts";
import { latestAuditorResultForGoal, latestEventsForGoal, type GoalLedgerEvent } from "./goal-ledger.ts";
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
	type GoalTask,
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

export function goalDetails(goal: GoalRecord | null, resultDetail?: string): GoalStateEntry {
	return { version: 3, goal: goal ? cloneGoal(goal) : null, ...(resultDetail ? { resultDetail } : {}) };
}

export function renderGoalResult(result: { details?: unknown; content: Array<{ type: string; text?: string }> }, options: { expanded?: boolean } | undefined, theme: Theme): Text {
	const first = result.content.find((item) => item.type === "text" && typeof item.text === "string");
	const firstText = first?.text ?? "";
	const details = result.details as GoalStateEntry | undefined;
	if (details && typeof details === "object" && "resultDetail" in details && details.resultDetail && options?.expanded) {
		// E7: the collapsed heading stays byte-identical; the full reason is one
		// keystroke away in the expanded tool-result detail view.
		return new Text(`${firstText}\n${details.resultDetail}`, 0, 0);
	}
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

/**
 * Issue #30 v2 markers are self-closing and carry an explicit version:
 * `<pi_goal_continuation goal_id="..." kind="checkpoint" v="2"/>`.
 */
function matchV2SelfClosingContinuation(text: string): string | null {
	const match = text.match(/^<pi_goal_continuation\s+goal_id="([^"]+)"[^>]*v="2"\s*\/?>/);
	return match?.[1] ?? null;
}

function matchLegacyContinuation(text: string): string | null {
	// Phase 5 C1: structured outer marker `<pi_goal_continuation goal_id="..." kind="...">`.
	// Borrowed from pi-codex-goal. More robust than bare bracket text because
	// the angle brackets + attributes are nearly impossible for users to type
	// by accident, and the structure is grep-able / parse-able by external tooling.
	const xmlMatch = text.match(/^<pi_goal_continuation\s+goal_id="([^"]+)"/);
	if (xmlMatch) return xmlMatch[1] ?? null;
	return null;
}

function matchLegacyBracketCheckpoint(text: string): string | null {
	const match = text.match(/^\[(?:GOAL CHECKPOINT|GOAL CONTINUATION|GOAL STALE) goalId=([^\]\s]+)\]/);
	return match?.[1] ?? null;
}

export function extractGoalIdFromInjectedMessage(text: string): string | null {
	return (
		matchV2SelfClosingContinuation(text)
		?? matchLegacyContinuation(text)
		?? matchLegacyBracketCheckpoint(text)
	);
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

export function isErrorAssistantMessage(message: unknown): boolean {
	const raw = asRecord(message);
	return raw?.role === "assistant" && raw.stopReason === "error";
}

/**
 * Transient provider failures are safe for goal-level recovery backoff:
 * Pi-declared network errors plus HTTP 429/5xx-style outages surfaced by
 * providers (429 rate limits, 503 server_error, HTTP/2 PROTOCOL_ERROR,
 * "Endpoint is unavailable", overloaded, gateway failures). Deliberately excludes auth and
 * malformed-request failures (and quota/billing text), which retrying
 * cannot fix.
 */
const TRANSIENT_PROVIDER_ERROR_RE = new RegExp(
	[
		"\\bnetwork[_\\s-]?error\\b",
		"\\bprotocol[_\\s-]?error\\b",
		"\\bserver[_\\s]?error\\b",
		"\\b(?:429|502|503|504|529)\\b",
		"\\brate[_\\s-]?limited\\b",
		"\\brate[_\\s-]?limit\\b",
		"\\btoo many requests\\b",
		"\\bservice unavailable\\b",
		"\\bbad gateway\\b",
		"\\bgateway timeout\\b",
		"\\bupstream request failed\\b",
		"\\bendpoint is unavailable\\b",
		"\\boverloaded[_\\s]?error\\b",
	].join("|"),
	"i",
);

/** Quota/billing exhaustion is deterministic; retrying cannot fix it. */
const NON_TRANSIENT_PROVIDER_ERROR_RE = new RegExp(
	[
		"\\binsufficient[_\\s]?quota\\b",
		"\\bout of budget\\b",
		"\\bquota exceeded\\b",
		"\\bbilling\\b",
		"GoUsageLimitError",
		"FreeUsageLimitError",
	].join("|"),
	"i",
);

/** A transient provider failure is safe for the bounded goal backoff. */
export function isNetworkErrorAssistantMessage(message: unknown): boolean {
	if (!isErrorAssistantMessage(message)) return false;
	const raw = asRecord(message);
	const details = [raw?.rawStopReason, raw?.errorMessage]
		.filter((value): value is string => typeof value === "string")
		.join(" ");
	// Quota/billing exhaustion is deterministic and must never be retried.
	if (NON_TRANSIENT_PROVIDER_ERROR_RE.test(details)) return false;
	return TRANSIENT_PROVIDER_ERROR_RE.test(details);
}

export function isToolUseAssistantMessage(message: unknown): boolean {
	const raw = asRecord(message);
	return raw?.role === "assistant" && raw.stopReason === "toolUse";
}

export function hasAbortedAssistantMessage(messages: unknown[]): boolean {
	return messages.some(isAbortedAssistantMessage);
}

export function hasErrorAssistantMessage(messages: unknown[]): boolean {
	return messages.some(isErrorAssistantMessage);
}

export function hasNetworkErrorAssistantMessage(messages: unknown[]): boolean {
	return messages.some(isNetworkErrorAssistantMessage);
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

/**
 * E1: per-goal history block (last audit verdict + recent lifecycle events)
 * surfaced by get_goal and /goal-status; the ledger already records it.
 */
export function buildGoalHistoryBlock(goal: GoalRecord | null, ledgerEvents: GoalLedgerEvent[]): string {
	if (!goal) return "";
	const lines: string[] = [];
	const audit = latestAuditorResultForGoal(ledgerEvents, goal.id);
	if (audit) {
		lines.push(`Last audit: ${audit.verdict} (${audit.at.slice(0, 10)}) — ${truncateText(audit.report, 90)}`);
	}
	const recent = latestEventsForGoal(ledgerEvents, goal.id, 6);
	if (recent.length > 0) {
		lines.push("Recent events:");
		for (const event of recent) {
			lines.push(`  ${event.at.slice(11, 19)} ${event.type}`);
		}
	}
	return lines.join("\n");
}

/**
 * F1: task-detail block mirroring the widget — counts, next pending with
 * contracts, recent completions with evidence. Used by get_goal.
 */
export function buildGoalTaskDetailBlock(goal: GoalRecord): string {
	if (!goal.taskList || goal.taskList.tasks.length === 0) return "";
	const { total, complete, skipped } = countTaskSubtree(goal.taskList.tasks);
	const lines: string[] = [];
	const header = `${complete}/${total} tasks complete${skipped > 0 ? ` (${skipped} skipped)` : ""}`;
	const pending: Array<{ task: GoalTask; depth: number }> = [];
	const recent: GoalTask[] = [];
	(function walk(tasks: GoalTask[], depth: number): void {
		for (const t of tasks) {
			if (t.status === "pending") pending.push({ task: t, depth });
			if (t.status === "complete" && recent.length < 2) recent.push(t);
			if (t.subtasks && t.subtasks.length > 0) walk(t.subtasks, depth + 1);
		}
	})(goal.taskList.tasks, 0);
	lines.push(`Tasks: ${header}`);
	for (const entry of pending.slice(0, 3)) {
		lines.push(`${"  ".repeat(entry.depth)}[ ] ${entry.task.id}: ${entry.task.title}`);
		if (entry.task.verificationContract) lines.push(`${"  ".repeat(entry.depth + 1)}contract: ${entry.task.verificationContract}`);
	}
	if (pending.length > 3) lines.push(`(+${pending.length - 3} more pending — expand the dashboard with Ctrl+Shift+T)`);
	for (const t of recent) {
		lines.push(`[x] ${t.id}: ${t.title}${t.evidence ? ` — ${t.evidence}` : ""}`);
	}
	return lines.join("\n");
}
