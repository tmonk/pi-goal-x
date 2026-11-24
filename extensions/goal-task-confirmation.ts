import { truncateToWidth } from "./widgets/text-cache.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { GoalTask } from "./goal-record.ts";
import { showChoiceDialog } from "./widgets/choice-dialog.ts";

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
	if (process.env.PI_GOAL_AUTO_CONFIRM === "1") return { decision: "confirm" };
	if (!ctx.hasUI) return { decision: process.env.PI_GOAL_AUTO_CONFIRM === "0" ? "cancel" : "confirm" };
	if (ctx.mode !== "rpc" && typeof ctx.ui.custom === "function") {
		const result = await showTaskListConfirmationDialog(ctx, proposalText);
		if (result) return result;
	}
	if (typeof ctx.ui.select !== "function") return { decision: "cancel" };
	const answer = await ctx.ui.select(`Task list confirmation\n\n${proposalText}`, ["Confirm task list", "Keep current tasks"]);
	return { decision: answer === "Confirm task list" ? "confirm" : "cancel" };
}

async function showTaskListConfirmationDialog(ctx: ExtensionContext, proposalText: string): Promise<TaskConfirmationResult | undefined> {
	const bodyLines = proposalText.split("\n");
	const maxBody = 16;
	const decision = await showChoiceDialog<TaskConfirmationResult["decision"]>(ctx, {
		sections: (theme, innerWidth) => {
			const body = bodyLines.slice(0, maxBody).map(raw => "  " + truncateToWidth(theme.fg("muted", raw || " "), innerWidth - 2, "…"));
			if (bodyLines.length > maxBody) body.push("  " + theme.fg("dim", `+${bodyLines.length - maxBody} more lines`));
			return [["  " + theme.bold("Task list confirmation")], body];
		},
		options: [
			{ label: "Confirm task list", value: "confirm", description: "Replace the current task list with this structure." },
			{ label: "Keep current tasks", value: "cancel", description: "Leave the existing task list unchanged." },
		],
		initialIndex: 0,
		highlight: "accent",
		cancelValue: "cancel",
		cancelHint: "keep current tasks",
		maxHeight: "60%",
	});
	return decision ? { decision } : undefined;
}
