import { commandHint, type GoalCommands } from "./goal-controls.ts";
import type { GoalKeybindings } from "./goal-settings.ts";
/**
 * /goal-status text builder (plan §13).
 *
 * Renders the SAME shared dashboard model as the above-editor widget: the
 * standard mode composes a static compact-dashboard box, the current-task
 * details block, recent activity, and the last audit result; verbose mode adds
 * the full diagnostic detail (§13.2). Pure module — no TUI imports, no ctx —
 * so the exact text is unit-testable and can never drift from the widget.
 */

import { truncateText } from "./goal-display.ts";
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
export const PLAIN_THEME = {
	fg: (_color: string, value: string) => value,
	bold: (value: string) => value,
} as never;

export interface GoalStatusTextOptions {
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
			: `No goal is set. Use ${commandHint("goal", options.commands)} or ${commandHint("sisyphus", options.commands)} to draft a goal.`;
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
	if (!model) return "No goal is set.";

	if (options.verbose) {
		return buildVerboseStatus(options.goal, model, events, options.settingsReport ?? [], width);
	}

	const parts: string[] = [];
	parts.push(renderCompactDashboard(model, PLAIN_THEME, width, { footerHint: `Run ${commandHint("goal-status", options.commands)} verbose for full detail`, keybindings: options.keybindings?.dashboard, auditorKey: options.keybindings?.toggleAuditor }).join("\n"));
	if (model.currentTask) {
		parts.push(renderCurrentTaskBlock(model, PLAIN_THEME, width).join("\n"));
	}
	if (model.recentActivity.length > 0) {
		parts.push(renderActivityBlock(model.recentActivity, PLAIN_THEME, width).join("\n"));
	}
	const audit = latestAuditorResultForGoal(events, model.goalId);
 if (latestAuditForGoal(events, model.goalId)?.type === "audit_started") parts.push("Latest audit: no recorded result.");
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
			? `WARN — no goal is focused; ${options.otherOpenGoals} open goal${options.otherOpenGoals === 1 ? "" : "s"} remain.`
			: "OK — no goal is focused and there are no open goals.";
		return ["Goal health: " + (options.otherOpenGoals > 0 ? "WARN" : "OK"), `Focus: ${focus}`, "Run /goal-status for the normal dashboard."].join("\n");
	}

	const checks: HealthCheck[] = [];
	checks.push({
		label: "Focus",
		value: options.focused ? "focused" : "not focused",
		severity: options.focused ? "ok" : "warn",
	});
	checks.push({
		label: "Lifecycle",
		value: `${statusLabelForHealth(goal)}${goal.autoContinue ? " · auto-continue on" : " · auto-continue off"}`,
		severity: goal.status === "active" || goal.status === "paused" || goal.status === "blocked" || goal.status === "budget_limited" || goal.status === "complete" ? "ok" : "error",
	});

	if (goal.status !== "complete") {
		const fileSeverity = options.activeFilePresent === false ? "error" : options.activeFilePresent === true ? "ok" : "warn";
		checks.push({
			label: "Goal file",
			value: goal.activePath ? (options.activeFilePresent === false ? `missing · ${goal.activePath}` : goal.activePath) : "missing active path",
			severity: fileSeverity,
		});
	}

	const malformed = options.ledgerMalformed ?? 0;
	checks.push({
		label: "Ledger",
		value: malformed > 0 ? `${malformed} malformed entr${malformed === 1 ? "y" : "ies"}` : "valid",
		severity: malformed > 0 ? "warn" : "ok",
	});

	if (goal.taskList) {
		const tasks = flattenHealthTasks(goal.taskList.tasks);
		const completed = tasks.filter((task) => task.status === "complete" || task.status === "skipped").length;
		const pending = tasks.length - completed;
		const contractedPending = tasks.filter((task) => task.status === "pending" && Boolean(task.verificationContract?.trim())).length;
		checks.push({
			label: "Tasks",
			value: `${completed}/${tasks.length} terminal · ${pending} pending${contractedPending > 0 ? ` · ${contractedPending} contracted` : ""}`,
			severity: goal.taskList.blockCompletion && pending > 0 ? "warn" : "ok",
		});
	}

	if (typeof goal.tokenBudget === "number" && goal.tokenBudget > 0) {
		const percentage = Math.round((goal.usage.tokensUsed / goal.tokenBudget) * 100);
		checks.push({
			label: "Budget",
			value: `${formatCompactTokensForHealth(goal.usage.tokensUsed)} / ${formatCompactTokensForHealth(goal.tokenBudget)} (${Math.max(0, percentage)}%)`,
			severity: goal.status === "budget_limited" || percentage >= 100 ? "warn" : percentage >= 90 ? "warn" : "ok",
		});
	}

	const overall = checks.some((check) => check.severity === "error") ? "ERROR" : checks.some((check) => check.severity === "warn") ? "WARN" : "OK";
	const lines = [`Goal health: ${overall}`, `Goal: ${truncateText(goal.objective, Math.max(20, width - 12))}`];
	for (const check of checks) lines.push(`${check.severity === "error" ? "ERROR" : check.severity === "warn" ? "WARN" : "OK"} ${check.label}: ${check.value}`);
	if (options.checkpointHealth && options.checkpointHealth.total > 0) {
		lines.push("");
		lines.push(formatCheckpointHealthReport(options.checkpointHealth, options.checkpointSessionFile));
	}
	lines.push("", "This is a storage/runtime health check, not a completion verdict.");
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
	return goal.status === "budget_limited" ? "budget limited" : goal.status;
}

function formatCompactTokensForHealth(value: number): string {
	if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
	if (value >= 1_000) return `${(value / 1_000).toFixed(1).replace(/\.0$/, "")}K`;
	return String(Math.max(0, Math.floor(value)));
}

function lastAuditBlock(
	audit: { verdict: "approved" | "disapproved" | "error"; report: string; at: string },
	width: number,
): string {
	const verdictLabel = audit.verdict === "approved" ? "APPROVED" : audit.verdict === "disapproved" ? "CHANGES REQUIRED" : "ERROR";
	const line = `Last audit: ${verdictLabel} (${audit.at.slice(0, 10)}) — ${truncateText(audit.report.replace(/\s+/g, " "), 90)}`;
	const inner = Math.max(4, width - 2);
	return [
		`╭─ Audit result ─ ${verdictLabel} ${"─".repeat(Math.max(1, inner - visibleLen(`─ Audit result ─ ${verdictLabel} `) - 1))}╮`,
		`│ ${truncateText(line, inner - 2)}${" ".repeat(Math.max(0, inner - 2 - truncateText(line, inner - 2).length))}│`,
		`╰${"─".repeat(inner)}╯`,
	].join("\n");
}

function visibleLen(value: string): number {
	return value.length;
}

// ── Verbose (§13.2) ─────────────────────────────────────────────────────────

function buildVerboseStatus(goal: GoalRecord, model: ReturnType<typeof deriveGoalDashboardModel>, events: GoalLedgerEvent[], settingsReport: string[], _width: number): string {
	const lines: string[] = [];
	lines.push(`Goal id: ${goal.id}`);
	lines.push(...(model?.scheduling ?? []));
	lines.push(`Revision: ${goal.revision ?? 0}`);
	lines.push(`Status: ${model?.status.label}${model?.focused ? " (focused)" : " (not focused)"}`);
	lines.push(`Mode: ${goal.sisyphus ? "sisyphus" : "goal"} · auto-continue: ${goal.autoContinue ? "on" : "off"}`);
	lines.push(`Usage: ${formatDashboardDuration(goal.usage.activeSeconds)} · ${formatCompactTokens(goal.usage.tokensUsed)} tokens`);
	if (model?.budget) {
		lines.push(`Budget: ${formatCompactTokens(model.budget.used)} / ${formatCompactTokens(model.budget.total)} · ${model.budget.percentage}% used · ${formatCompactTokens(model.budget.remaining)} remaining`);
	}
	if (goal.pauseReason) lines.push(`Pause/blocker: ${goal.pauseReason}`);
	if (goal.pauseSuggestedAction) lines.push(`Suggested action: ${goal.pauseSuggestedAction}`);
	if (goal.activePath) lines.push(`File: ${goal.activePath}`);
	if (goal.archivedPath) lines.push(`Archive: ${goal.archivedPath}`);

	lines.push("", "Objective:", goal.objective.trim());

	if (goal.verificationContract) {
		lines.push("", `Verification contract: ${goal.verificationContract.trim()}`);
	}
	if (goal.taskList) {
		lines.push("", `Tasks (${topLevelCount(goal.taskList.tasks)} top-level, ${goal.taskList.tasks.filter((t) => t.status === "complete" || t.status === "skipped").length} done):`);
		for (const line of renderTaskTreeVerbose(goal.taskList.tasks, 0, goal.currentTaskId)) {
			lines.push(line);
		}
	}
	if (model?.currentTask) {
		lines.push("", `Current task: ${model.currentTask.id} · ${model.currentTask.title}${model.currentTask.inferred ? " (inferred)" : ""}`);
		if (model.currentTask.totalSubtasks > 0) {
			lines.push(`  subtasks: ${model.currentTask.completedSubtasks}/${model.currentTask.totalSubtasks} (${model.currentTask.subtaskPercentage}%)`);
		}
		if (model.currentTask.verificationContract) lines.push(`  contract: ${model.currentTask.verificationContract}`);
		if (model.currentTask.evidence) lines.push(`  evidence: ${model.currentTask.evidence}`);
	}

	const recent = latestEventsForGoal(events, goal.id, 12);
	if (recent.length > 0) {
		lines.push("", "Recent ledger:");
		for (const event of recent) {
			lines.push(`  ${event.at.slice(0, 19)} ${event.type}`);
		}
	}
	const audit = latestAuditorResultForGoal(events, goal.id);
 if (latestAuditForGoal(events, goal.id)?.type === "audit_started") lines.push("", "Latest audit: no recorded result.");
	if (audit) {
		lines.push("", `Last audit (${audit.at.slice(0, 10)}): ${audit.verdict}`);
		lines.push(truncateText(audit.report.replace(/\s+/g, " "), 400));
	}
	if (settingsReport.length > 0) {
		lines.push("", "Effective settings:");
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
	for (const t of tasks) {
		const isCurrent = t.id === currentTaskId;
		const marker = isCurrent ? "▸" : t.status === "complete" ? "✓" : t.status === "skipped" ? "~" : "·";
		const contract = t.verificationContract ? ` — contract: ${t.verificationContract}` : "";
		const evidence = t.status === "complete" && t.evidence ? ` — evidence: ${t.evidence}` : "";
		lines.push(`${indent}${marker} ${t.id}  ${t.title}${contract}${evidence}`);
		if (t.subtasks && t.subtasks.length > 0) {
			lines.push(...renderTaskTreeVerbose(t.subtasks, depth + 1, currentTaskId));
		}
	}
	return lines;
}

// Re-export for consumers that want the same event type.
export type { LedgerEvent };
