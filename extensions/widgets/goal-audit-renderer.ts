/**
 * Audit dashboard and result card. Same box system as the goal dashboard,
 * fed by the audit view models in auditor-dashboard-model.ts.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { bindingKeys, type GoalKeybinding } from "../goal-controls.ts";
import { truncateText } from "../goal-display.ts";
import { formatGoalKeybinding } from "../settings/schema.ts";
import type { AuditorDashboardModel, AuditResultCard } from "./auditor-dashboard-model.ts";
import { accent, Box, dim, fit, frame, progressBar, type RenderColor } from "./dashboard-box.ts";
import { formatAuditElapsed } from "./dashboard-format.ts";

const CHECK_SYMBOL = { passed: "✓", running: "◌", pending: "·", failed: "✗" } as const;
const CHECK_COLOR = { passed: "success", running: "accent", pending: "muted", failed: "error" } as const;

/**
 * Structured audit dashboard: five check stages, a progress bar, and the
 * elapsed duration. Raw tools and recent output appear only when
 * showToolDetails is set (expanded audit mode) or when the audit finished
 * with a failure.
 */
export function renderAuditorDashboard(
	model: AuditorDashboardModel,
	theme: Theme,
	width: number,
	opts: { showToolDetails?: boolean; interruptKey?: GoalKeybinding } = {},
): string[] {
	const box = new Box(theme, width);
	const inner = box.inner;
	const lines: string[] = [];
	lines.push(box.header(frame(theme, `Independent completion audit ─ ${model.auditorLabel}`), frame(theme, formatAuditElapsed(model.elapsedMs))));

	for (const check of model.checks) {
		lines.push(box.line(`${theme.fg(CHECK_COLOR[check.state] as RenderColor, CHECK_SYMBOL[check.state])} ${check.label}`));
	}

	if (model.percentage !== undefined) {
		const barWidth = Math.max(8, Math.min(inner - 12, 30));
		lines.push(box.line(`${progressBar(theme, model.percentage, barWidth)} ${theme.fg("muted", `${model.percentage}%`)}`));
	}

	const showDiagnostics = opts.showToolDetails === true || model.verdict === "disapproved" || model.verdict === "error";
	if (showDiagnostics) {
		if (model.currentTool) {
			const args = model.currentToolArgs ? ` ${dim(theme, truncateText(model.currentToolArgs, Math.max(10, inner - 20)))}` : "";
			lines.push(box.line(`${accent(theme, "tool")} ${model.currentTool}${args}`));
		}
		if (model.recentOutput.length > 0) {
			lines.push(box.line(dim(theme, "─".repeat(Math.max(4, inner - 8)))));
			for (const output of model.recentOutput.slice(0, 3)) {
				lines.push(box.line(dim(theme, truncateText(output, Math.max(8, inner - 4)))));
			}
		}
	}

	const interruptKey = opts.interruptKey ?? "escape";
	lines.push(box.footer(model.active && bindingKeys(interruptKey).length ? `${formatGoalKeybinding(interruptKey)}: stop audit` : ""));
	return lines;
}

/** Audit result card: APPROVED, or CHANGES REQUIRED / ERROR with the findings. */
export function renderAuditResultCard(card: AuditResultCard, theme: Theme, width: number): string[] {
	const box = new Box(theme, width);
	const approved = card.verdict === "approved";
	const color: RenderColor = approved ? "success" : "error";
	const symbol = approved ? "✓" : "✗";
	return [
		box.header(frame(theme, `Audit result ─ ${card.label}`)),
		...card.lines.map((line) => box.line(`${theme.fg(color, symbol)} ${fit(line, box.inner - 4)}`)),
		box.footer(""),
	];
}
