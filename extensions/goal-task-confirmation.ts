import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Component, TUI } from "@earendil-works/pi-tui";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { GoalTask } from "./goal-record.ts";

/** Render a task tree for confirmation dialogs (structural view). */
export function renderConfirmationTasks(tasks: readonly GoalTask[], indent: number): string[] {
	const prefix = "  ".repeat(indent);
	const lines: string[] = [];
	for (const t of tasks) {
		const lw = t.lightweightSubtasks ? " (lightweight)" : "";
		const contract = t.verificationContract ? ` contract: ${t.verificationContract}` : "";
		lines.push(`${prefix}[ ] ${t.id}: ${t.title}${lw}${contract}`);
		if (t.subtasks && t.subtasks.length > 0) {
			lines.push(...renderConfirmationTasks(t.subtasks, indent + 1));
		}
	}
	return lines;
}

/**
 * Task-only confirmation boundary (follow-up Stage 2). The complete result is
 * the user's {decision: confirm | cancel} — no auditor toggle, no
 * goal-creation wording, and no questionnaire state. `set_goal_tasks` confirms
 * the STRUCTURAL input here and merges progress only inside GoalService.apply
 * against the disk-refreshed clone. The dialog is a small self-contained
 * component with neutral, task-specific labels.
 */
export interface TaskConfirmationResult {
	decision: "confirm" | "cancel";
}

export async function showTaskConfirmation(ctx: ExtensionContext, proposalText: string): Promise<TaskConfirmationResult> {
	const autoConfirmEnv = process.env.PI_GOAL_AUTO_CONFIRM;
	if (autoConfirmEnv === "0") {
		// Explicit opt-out (benchmarking): in headless mode the proposal is
		// declined without a dialog.
		if (!ctx.hasUI) return { decision: "cancel" };
	} else if (!ctx.hasUI || autoConfirmEnv === "1") {
		// Headless default, or forced auto-confirm even with a UI.
		return { decision: "confirm" };
	}
	return showTaskListConfirmationDialog(ctx, proposalText);
}

async function showTaskListConfirmationDialog(ctx: ExtensionContext, proposalText: string): Promise<TaskConfirmationResult> {
	return await ctx.ui.custom<TaskConfirmationResult>(
		(tui: TUI, theme: Theme, _keybindings: unknown, done: (result: TaskConfirmationResult) => void): Component => {
			const wasHardwareCursorShown = tui.getShowHardwareCursor();
			tui.setShowHardwareCursor(false);

			// Default: "Confirm task list" (matches the pre-existing default).
			let selectedIndex = 0;

			const OPTIONS: Array<{ label: string; value: TaskConfirmationResult["decision"]; description: string }> = [
				{
					label: "Confirm task list",
					value: "confirm",
					description: "Replace the current task list with this structure.",
				},
				{
					label: "Keep current tasks",
					value: "cancel",
					description: "Leave the existing task list unchanged.",
				},
			];

			const BODY_LINES = proposalText.split("\n");
			const MAX_BODY = 16;

			const accent = (s: string) => theme.fg("accent", s);
			const dim = (s: string) => theme.fg("dim", s);
			const muted = (s: string) => theme.fg("muted", s);

			// ── Component ────────────────────────────────────────────────────
			const component: Component & { dispose?(): void } = {
				dispose() {
					tui.setShowHardwareCursor(wasHardwareCursorShown);
				},

				invalidate(): void {
					// No cached state to invalidate
				},

				render(width: number): string[] {
					const termWidth = Math.min(width, 80);
					const innerWidth = Math.min(termWidth, 64) - 2;

					function line(leftContent: string): string {
						const vis = visibleWidth(leftContent);
						const fill = innerWidth - vis;
						return accent("│") + leftContent + (fill > 0 ? " ".repeat(fill) : "") + accent("│");
					}

					const horizLine = "─".repeat(innerWidth);
					const lines: string[] = [];
					const p = "  ";

					// ── Header ────────────────────────────────────────────────
					lines.push(accent(`┌${horizLine}┐`));
					lines.push(line(p + theme.bold("Task list confirmation")));
					lines.push(accent(`├${horizLine}┤`));

					// ── Body: the proposed task tree ─────────────────────────
					const body = BODY_LINES.slice(0, MAX_BODY);
					for (const raw of body) {
						const trimmed = raw;
						lines.push(line(p + truncateToWidth(muted(trimmed || " "), innerWidth - p.length, "…")));
					}
					if (BODY_LINES.length > MAX_BODY) {
						lines.push(line(p + dim(`+${BODY_LINES.length - MAX_BODY} more lines`)));
					}
					lines.push(accent(`├${horizLine}┤`));

					// ── Options ─────────────────────────────────────────────
					OPTIONS.forEach((opt, i) => {
						const isSelected = i === selectedIndex;
						const marker = isSelected ? "▸ " : "  ";
						const label = isSelected ? theme.fg("accent", opt.label) : opt.label;
						lines.push(line(p + marker + truncateToWidth(label, innerWidth - 6, "…")));
						if (isSelected) {
							lines.push(line(p + " ".repeat(4) + truncateToWidth(dim(opt.description), innerWidth - 10, "…")));
						}
					});

					// ── Footer ───────────────────────────────────────────────
					lines.push(accent(`├${horizLine}┤`));
					lines.push(line(p + dim("Enter to select  ·  ↑↓ to navigate  ·  Esc = keep current tasks")));
					lines.push(accent(`└${horizLine}┘`));

					return lines;
				},

					handleInput(data: string): void {
						if (matchesKey(data, "up")) {
							selectedIndex = (selectedIndex - 1 + OPTIONS.length) % OPTIONS.length;
							tui.requestRender();
							return;
						}
						if (matchesKey(data, "down")) {
							selectedIndex = (selectedIndex + 1) % OPTIONS.length;
							tui.requestRender();
							return;
						}
						if (matchesKey(data, "enter")) {
							done({ decision: OPTIONS[selectedIndex].value });
							return;
						}
						if (matchesKey(data, "escape")) {
							done({ decision: "cancel" });
							return;
						}
					},
				};

				return component;
			},
			{
				// Bottom-anchored main-screen panel: composites into the frame in
				// place (no viewport scroll churn), keeps history visible above, and
				// leaves terminal scrollback fully usable while the dialog is open.
				overlay: true,
				overlayOptions: {
					anchor: "bottom-center",
					width: "95%",
					maxHeight: "45%",
				},
			},
		);
}
