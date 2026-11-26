import { uiCommandHint, type GoalCommands } from "./goal-controls.ts";
import type { GoalKeybindings } from "./settings/schema.ts";
/**
 * /goal-status text builder (plan §13).
 *
 * Renders the SAME shared dashboard model as the above-editor widget: the
 * standard mode composes a static compact-dashboard box, the current-task
 * details block, recent activity, and the last audit result; verbose mode adds
 * the full diagnostic detail (§13.2). Pure module — no TUI imports, no ctx —
 * so the exact text is unit-testable and can never drift from the widget.
 */

import { displayStatusLabel, truncateText } from "./goal-display.ts";
import { t, tn } from "./i18n/index.ts";
import type { GoalLedgerEvent, GoalLedgerEvent as LedgerEvent } from "./goal-ledger.ts";
import { latestAuditorResultForGoal, latestAuditForGoal, latestEventsForGoal } from "./goal-ledger.ts";
import type { GoalRecord, GoalTask } from "./goal-record.ts";
import { deriveGoalDashboardModel, formatCompactTokens, formatDashboardDuration } from "./widgets/goal-dashboard-model.ts";
import {
	renderActivityBlock,
	renderCompactDashboard,
	renderCurrentTaskBlock,
	renderUnfocusedDashboard,
} from "./widgets/goal-dashboard-renderer.ts";
import { formatCheckpointHealthReport, type CheckpointHealth } from "./goal-session-health.ts";

/** Fixed rendering width for the notify text (medium layout mode). */
export const GOAL_STATUS_WIDTH = 78;

/** Identity theme: the box text is emitted as plain text for ctx.ui.notify. */
const PLAIN_THEME = {
	fg: (_color: string, value: string) => value,
	bold: (value: string) => value,
} as never;

interface GoalStatusTextOptions {
	commands?: GoalCommands;
	keybindings?: GoalKeybindings;
	maxAutonomousRuns?: number;
	idleContinuationBackoff?: boolean;
	goal: GoalRecord | null;
	focused: boolean;
	otherOpenGoals: number;
	ledgerEvents?: GoalLedgerEvent[];
	ledgerMalformed?: number;
	verbose?: boolean;
	health?: boolean;
	/** Supplied by the command layer only for the explicit health check. */
	activeFilePresent?: boolean;
	/** Issue #30: persisted-checkpoint report for this session (health view only). */
	checkpointHealth?: CheckpointHealth | null;
	checkpointSessionFile?: string;
	/** Effective settings lines with provenance (verbose only). */
	settingsReport?: string[];
	/** Prompt-cache hit line (verbose only). */
	cacheLine?: string;
	width?: number;
}

/**
 * Build the /goal-status text.
 *
 * Standard (§13.1): static compact-dashboard rendering + current-task details
 * + recent activity + last audit result when available. The terminology and
 * hierarchy match the expanded dashboard (§13.3); no effective settings by
 * default.
 *
 * Verbose (§13.2): goal id, revision, full objective, complete task tree with
 * full evidence and contracts, recent ledger history, effective settings and
 * provenance, token budget detail, pause/blocker detail, paths, and the last
 * audit report.
 */
export function buildGoalStatusText(options: GoalStatusTextOptions): string {
	const width = options.width ?? GOAL_STATUS_WIDTH;
	if (options.health) return buildHealthStatus(options, width);
	if (!options.goal) {
		return options.otherOpenGoals > 0
			? renderUnfocusedDashboard(options.otherOpenGoals, PLAIN_THEME, width, options.commands).join("\n")
			: t("No goal is set. Use {goal} or {sisyphus} to draft a goal.", { goal: uiCommandHint("goal", options.commands), sisyphus: uiCommandHint("sisyphus", options.commands) });
	}
	const events = options.ledgerEvents ?? [];
	const model = deriveGoalDashboardModel(options.goal, {
		focused: options.focused,
		maxAutonomousRuns: options.maxAutonomousRuns,
		idleContinuationBackoff: options.idleContinuationBackoff,
		commands: options.commands,
		otherOpenGoals: options.otherOpenGoals,
		ledgerEvents: events,
	});
	if (!model) return t("No goal is set.");

	if (options.verbose) {
		return buildVerboseStatus(options.goal, model, events, options.settingsReport ?? [], width, options.cacheLine);
	}

	const parts: string[] = [];
	parts.push(renderCompactDashboard(model, PLAIN_THEME, width, { footerHint: t("Run {command} verbose for full detail", { command: uiCommandHint("goal-status", options.commands) }), keybindings: options.keybindings?.dashboard, auditorKey: options.keybindings?.toggleAuditor }).join("\n"));
	if (model.currentTask) {
		parts.push(renderCurrentTaskBlock(model, PLAIN_THEME, width).join("\n"));
	}
	if (model.recentActivity.length > 0) {
		parts.push(renderActivityBlock(model.recentActivity, PLAIN_THEME, width).join("\n"));
	}
	const audit = latestAuditorResultForGoal(events, model.goalId);
	if (latestAuditForGoal(events, model.goalId)?.type === "audit_started") parts.push(t("Latest audit: no recorded result."));
	if (audit) {
		parts.push(lastAuditBlock(audit, width));
	}
	return parts.join("\n\n");
}

interface HealthCheck {
	label: string;
	value: string;
	severity: "ok" | "warn" | "error";
}

/**
 * Render a concise, read-only integrity report. This deliberately checks
 * storage/runtime coherence only; it does not infer that the work itself is
 * complete from task counts or contracts.
 */
function buildHealthStatus(options: GoalStatusTextOptions, width: number): string {
	const goal = options.goal;
	if (!goal) {
		const focus = options.otherOpenGoals > 0
			? tn(options.otherOpenGoals, { one: "WARN — no goal is focused; {n} open goal remain.", other: "WARN — no goal is focused; {n} open goals remain." })
			: t("OK — no goal is focused and there are no open goals.");
		return [t("Goal health: {overall}", { overall: options.otherOpenGoals > 0 ? healthWord("WARN") : healthWord("OK") }), t("Focus: {focus}", { focus }), t("Run /goal-status for the normal dashboard.")].join("\n");
	}

	const checks: HealthCheck[] = [];
	checks.push({
		label: t("Focus"),
		value: options.focused ? t("focused") : t("not focused"),
		severity: options.focused ? "ok" : "warn",
	});
	checks.push({
		label: t("Lifecycle"),
		value: goal.autoContinue
			? t("{status} · auto-continue on", { status: statusLabelForHealth(goal) })
			: t("{status} · auto-continue off", { status: statusLabelForHealth(goal) }),
		severity: goal.status === "active" || goal.status === "paused" || goal.status === "blocked" || goal.status === "budget_limited" || goal.status === "complete" ? "ok" : "error",
	});

	if (goal.status !== "complete") {
		const fileSeverity = options.activeFilePresent === false ? "error" : options.activeFilePresent === true ? "ok" : "warn";
		checks.push({
			label: t("Goal file"),
			value: goal.activePath ? (options.activeFilePresent === false ? t("missing · {path}", { path: goal.activePath }) : goal.activePath) : t("missing active path"),
			severity: fileSeverity,
		});
	}

	const malformed = options.ledgerMalformed ?? 0;
	checks.push({
		label: t("Ledger"),
		value: malformed > 0 ? tn(malformed, { one: "{n} malformed entry", other: "{n} malformed entries" }) : t("valid"),
		severity: malformed > 0 ? "warn" : "ok",
	});

	if (goal.taskList) {
		const tasks = flattenHealthTasks(goal.taskList.tasks);
		const completed = tasks.filter((task) => task.status === "complete" || task.status === "skipped").length;
		const pending = tasks.length - completed;
		const contractedPending = tasks.filter((task) => task.status === "pending" && Boolean(task.verificationContract?.trim())).length;
		checks.push({
			label: t("Tasks"),
			value: t("{done}/{total} terminal · {pending} pending", { done: completed, total: tasks.length, pending }) + (contractedPending > 0 ? ` · ${t("{count} contracted", { count: contractedPending })}` : ""),
			severity: goal.taskList.blockCompletion && pending > 0 ? "warn" : "ok",
		});
	}

	if (typeof goal.tokenBudget === "number" && goal.tokenBudget > 0) {
		const percentage = Math.round((goal.usage.tokensUsed / goal.tokenBudget) * 100);
		checks.push({
			label: t("Budget"),
			value: t("{used} / {total} ({percent}%)", { used: formatCompactTokens(goal.usage.tokensUsed), total: formatCompactTokens(goal.tokenBudget), percent: Math.max(0, percentage) }),
			severity: goal.status === "budget_limited" || percentage >= 100 ? "warn" : percentage >= 90 ? "warn" : "ok",
		});
	}

	const overall = checks.some((check) => check.severity === "error") ? "ERROR" : checks.some((check) => check.severity === "warn") ? "WARN" : "OK";
	const lines = [t("Goal health: {overall}", { overall: healthWord(overall) }), t("Goal: {objective}", { objective: truncateText(goal.objective, Math.max(20, width - 12)) })];
	for (const check of checks) lines.push(t("{severity} {label}: {value}", { severity: healthWord(check.severity === "error" ? "ERROR" : check.severity === "warn" ? "WARN" : "OK"), label: check.label, value: check.value }));
	if (options.checkpointHealth && options.checkpointHealth.total > 0) {
		lines.push("");
		lines.push(formatCheckpointHealthReport(options.checkpointHealth, options.checkpointSessionFile));
	}
	lines.push("", t("This is a storage/runtime health check, not a completion verdict."));
	return lines.join("\n");
}

function flattenHealthTasks(tasks: GoalTask[]): GoalTask[] {
	const result: GoalTask[] = [];
	for (const task of tasks) {
		result.push(task);
		if (task.subtasks) result.push(...flattenHealthTasks(task.subtasks));
	}
	return result;
}

function statusLabelForHealth(goal: GoalRecord): string {
	return displayStatusLabel({ ...goal, sisyphus: false, autoContinue: false, stopReason: undefined });
}

function healthWord(word: "OK" | "WARN" | "ERROR"): string {
	return word === "OK" ? t("OK") : word === "WARN" ? t("WARN") : t("ERROR");
}

function lastAuditBlock(
	audit: { verdict: "approved" | "disapproved" | "error"; report: string; at: string },
	width: number,
): string {
	const verdictLabel = audit.verdict === "approved" ? t("APPROVED") : audit.verdict === "disapproved" ? t("CHANGES REQUIRED") : t("ERROR");
	const auditTitle = t("Audit result");
	const line = t("Last audit: {verdict} ({date}) — {report}", { verdict: verdictLabel, date: audit.at.slice(0, 10), report: truncateText(audit.report.replace(/\s+/g, " "), 90) });
	const inner = Math.max(4, width - 2);
	return [
		`╭─ ${auditTitle} ─ ${verdictLabel} ${"─".repeat(Math.max(1, inner - visibleLen(`─ ${auditTitle} ─ ${verdictLabel} `) - 1))}╮`,
		`│ ${truncateText(line, inner - 2)}${" ".repeat(Math.max(0, inner - 2 - truncateText(line, inner - 2).length))}│`,
		`╰${"─".repeat(inner)}╯`,
	].join("\n");
}

function visibleLen(value: string): number {
	return value.length;
}

// ── Verbose (§13.2) ─────────────────────────────────────────────────────────

function buildVerboseStatus(goal: GoalRecord, model: ReturnType<typeof deriveGoalDashboardModel>, events: GoalLedgerEvent[], settingsReport: string[], _width: number, cacheLine?: string): string {
	const lines: string[] = [];
	lines.push(t("Goal id: {id}", { id: goal.id }));
	lines.push(...(model?.scheduling ?? []));
	lines.push(t("Revision: {revision}", { revision: goal.revision ?? 0 }));
	lines.push(model?.focused ? t("Status: {status} (focused)", { status: String(model?.status.label) }) : t("Status: {status} (not focused)", { status: String(model?.status.label) }));
	lines.push(t("Mode: {mode} · auto-continue: {state}", { mode: goal.sisyphus ? t("sisyphus") : t("goal"), state: goal.autoContinue ? t("on") : t("off") }));
	lines.push(t("Usage: {duration} · {tokens} tokens", { duration: formatDashboardDuration(goal.usage.activeSeconds), tokens: formatCompactTokens(goal.usage.tokensUsed) }));
	if (cacheLine) lines.push(cacheLine);
	if (model?.budget) {
		lines.push(t("Budget: {used} / {total} · {percent}% used · {remaining} remaining", { used: formatCompactTokens(model.budget.used), total: formatCompactTokens(model.budget.total), percent: model.budget.percentage, remaining: formatCompactTokens(model.budget.remaining) }));
	}
	if (goal.pauseReason) lines.push(t("Pause/blocker: {reason}", { reason: goal.pauseReason }));
	if (goal.pauseSuggestedAction) lines.push(t("Suggested action: {action}", { action: goal.pauseSuggestedAction }));
	if (goal.activePath) lines.push(t("File: {path}", { path: goal.activePath }));
	if (goal.archivedPath) lines.push(t("Archive: {path}", { path: goal.archivedPath }));

	lines.push("", t("Objective:"), goal.objective.trim());

	if (goal.verificationContract) {
		lines.push("", t("Verification contract: {contract}", { contract: goal.verificationContract.trim() }));
	}
	if (goal.taskList) {
		lines.push("", t("Tasks ({total} top-level, {done} done):", { total: topLevelCount(goal.taskList.tasks), done: goal.taskList.tasks.filter((task) => task.status === "complete" || task.status === "skipped").length }));
		for (const line of renderTaskTreeVerbose(goal.taskList.tasks, 0, goal.currentTaskId)) {
			lines.push(line);
		}
	}
	if (model?.currentTask) {
		lines.push("", model.currentTask.inferred
			? t("Current task: {id} · {title} (inferred)", { id: model.currentTask.id, title: model.currentTask.title })
			: t("Current task: {id} · {title}", { id: model.currentTask.id, title: model.currentTask.title }));
		if (model.currentTask.totalSubtasks > 0) {
			lines.push(t("  subtasks: {done}/{total} ({percent}%)", { done: model.currentTask.completedSubtasks, total: model.currentTask.totalSubtasks, percent: model.currentTask.subtaskPercentage }));
		}
		if (model.currentTask.verificationContract) lines.push(t("  contract: {contract}", { contract: model.currentTask.verificationContract }));
		if (model.currentTask.evidence) lines.push(t("  evidence: {evidence}", { evidence: model.currentTask.evidence }));
	}

	const recent = latestEventsForGoal(events, goal.id, 12);
	if (recent.length > 0) {
		lines.push("", t("Recent ledger:"));
		for (const event of recent) {
			lines.push(`  ${event.at.slice(0, 19)} ${event.type}`);
		}
	}
	const audit = latestAuditorResultForGoal(events, goal.id);
	if (latestAuditForGoal(events, goal.id)?.type === "audit_started") lines.push("", t("Latest audit: no recorded result."));
	if (audit) {
		lines.push("", t("Last audit ({date}): {verdict}", { date: audit.at.slice(0, 10), verdict: audit.verdict }));
		lines.push(truncateText(audit.report.replace(/\s+/g, " "), 400));
	}
	if (settingsReport.length > 0) {
		lines.push("", t("Effective settings:"));
		lines.push(...settingsReport.map((line) => `  ${line}`));
	}
	return lines.join("\n");
}

function topLevelCount(tasks: GoalTask[]): number {
	return tasks.length;
}

function renderTaskTreeVerbose(tasks: GoalTask[], depth = 0, currentTaskId?: string): string[] {
	const lines: string[] = [];
	const indent = "  ".repeat(depth);
	for (const task of tasks) {
		const isCurrent = task.id === currentTaskId;
		const marker = isCurrent ? "▸" : task.status === "complete" ? "✓" : task.status === "skipped" ? "~" : "·";
		const contract = task.verificationContract ? ` — ${t("contract: {contract}", { contract: task.verificationContract })}` : "";
		const evidence = task.status === "complete" && task.evidence ? ` — ${t("evidence: {evidence}", { evidence: task.evidence })}` : "";
		lines.push(`${indent}${marker} ${task.id}  ${task.title}${contract}${evidence}`);
		if (task.subtasks && task.subtasks.length > 0) {
			lines.push(...renderTaskTreeVerbose(task.subtasks, depth + 1, currentTaskId));
		}
	}
	return lines;
}

// Re-export for consumers that want the same event type.
export type { LedgerEvent };
