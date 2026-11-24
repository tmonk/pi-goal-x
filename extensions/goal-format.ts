import { t } from "./i18n/index.ts";
import { type Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { commandInstructions, type GoalCommands } from "./goal-controls.ts";
import {
	displayStatusLabel,
	formatDuration,
	formatTokenValue,
	statusLabel,
	truncateText,
} from "./goal-display.ts";
import { buildTaskSummary } from "./goal-policy.ts";
import { countTaskSubtree } from "./goal-task-count.ts";
import { latestAuditorResultForGoal, latestAuditForGoal, latestEventsForGoal, type GoalLedgerEvent } from "./goal-ledger.ts";
import { extractGoalIdFromInjectedMessage } from "./goal-messages.ts";
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

// Reading injected goal messages and assistant turns lives in goal-messages.ts;
// these names stay importable from here.
export {
	assistantTurnTokens,
	extractGoalIdFromInjectedMessage,
	hasAbortedAssistantMessage,
	hasErrorAssistantMessage,
	hasNetworkErrorAssistantMessage,
	isAbortedAssistantMessage,
	isErrorAssistantMessage,
	isMeaningfulProgressToolCall,
	isNetworkErrorAssistantMessage,
	providerErrorText,
} from "./goal-messages.ts";

// ---------- summaries ----------

function usageLines(goal: GoalRecord): string[] {
	return [
		`Time spent: ${formatDuration(goal.usage.activeSeconds)}`,
		`Tokens used: ${formatTokenValue(goal.usage.tokensUsed)}`,
	];
}

export function detailedSummary(goal: GoalRecord | null, commands?: GoalCommands): string {
	if (!goal) return commandInstructions("No goal is set. Use /goal <objective> or /sisyphus <objective> to start immediately.", commands);
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
	if (!goal) return t("No goal is set.");
	const tail = goal.usage.tokensUsed > 0 ? ` [${formatTokenValue(goal.usage.tokensUsed).split(" ")[0]}]` : "";
	return `${displayStatusLabel(goal)}${tail} - ${truncateText(goal.objective)}`;
}

// ---------- entry / render helpers ----------

export function goalDetails(goal: GoalRecord | null, resultDetail?: string): GoalStateEntry {
	return { version: 3, goal: goal ? cloneGoal(goal) : null, ...(resultDetail ? { resultDetail } : {}) };
}

/** A plain text tool result carrying the goal state; `terminate` is included only when given. */
export function goalTextResult(text: string, goal: GoalRecord | null, terminate?: boolean) {
	return { content: [{ type: "text" as const, text }], details: goalDetails(goal), ...(terminate === undefined ? {} : { terminate }) };
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
	return new Text(theme.fg("accent", `${t("Goal")} `) + theme.fg("muted", oneLineSummary(details.goal)), 0, 0);
}

function normalizeGoalEventDetails(value: unknown): GoalEventDetails {
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

function eventStatusLabel(status: GoalStatus): string {
	return status === "active" ? t("active") : status === "paused" ? t("paused") : status === "blocked" ? t("blocked") : status === "budget_limited" ? t("budget limited") : t("complete");
}

export function renderGoalEvent(message: { details?: GoalEventDetails }, options: { expanded: boolean }, theme: Theme): Text {
	const details = normalizeGoalEventDetails(message.details);
	const label = details.kind === "stale" ? t("stale checkpoint") : t("checkpoint");
	if (!options.expanded) {
		return new Text(theme.fg("customMessageLabel", `${t("Goal")} `) + theme.fg("customMessageText", label), 0, 0);
	}
	const lines = [t("Status: {status}", { status: details.status === "active" ? t("running") : details.status ? eventStatusLabel(details.status) : t("unknown") })];
	if (details.objective) lines.push(t("Objective: {objective}", { objective: details.objective }));
	lines.push(t("Goal id: {id}", { id: details.goalId }));
	if (details.currentGoalId || details.currentStatus) {
		const current = details.currentGoalId ?? t("none");
		lines.push(details.currentStatus
			? t("Current: {goal} ({status})", { goal: current, status: eventStatusLabel(details.currentStatus) })
			: t("Current: {goal}", { goal: current }));
	}
	return new Text(
		theme.fg("customMessageLabel", `${t("Goal")} ${label}`) + "\n" + theme.fg("customMessageText", lines.join("\n")),
		0,
		0,
	);
}

export function renderGoalAuditEvent(message: { content?: unknown; details?: GoalAuditEventDetails }, _options: { expanded: boolean }, theme: Theme): Text {
	const phase = message.details?.phase ?? "started";
	const label = phase === "approved" ? t("Goal audit approved") : phase === "rejected" ? t("Goal audit rejected") : phase === "skipped" ? t("Goal audit skipped") : t("Goal audit started");
	const content = typeof message.content === "string" ? message.content : t("{heading}.", { heading: label });
	return new Text(
		theme.fg("customMessageLabel", label) + "\n" + theme.fg("customMessageText", content),
		0,
		0,
	);
}

export function goalEventMessageId(message: { customType?: string; details?: unknown; content?: unknown }): string | null {
	if (message.customType !== GOAL_EVENT_ENTRY) return null;
	const details = asRecord(message.details);
	const goalId = details && typeof details.goalId === "string" ? details.goalId : null;
	if (goalId) return goalId;
	return typeof message.content === "string" ? extractGoalIdFromInjectedMessage(message.content) : null;
}

/**
 * E1: per-goal history block (last audit verdict + recent lifecycle events)
 * surfaced by get_goal and /goal-status; the ledger already records it.
 */
export function buildGoalHistoryBlock(goal: GoalRecord | null, ledgerEvents: GoalLedgerEvent[]): string {
	if (!goal) return "";
	const lines: string[] = [];
	const audit = latestAuditorResultForGoal(ledgerEvents, goal.id);
	if (latestAuditForGoal(ledgerEvents, goal.id)?.type === "audit_started") lines.push("Latest audit: no recorded result.");
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
