
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
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { GoalTask } from "./goal-record.ts";
import { shouldAutoConfirmProposal, showProposalDialog } from "./goal-questionnaire.ts";

/**
 * Task-only confirmation boundary (Stage 3 of the hardening plan). The complete
 * result is the user's {decision} — no auditor toggle, no goal-state mutation.
 * `set_goal_tasks` confirms the STRUCTURAL input here and merges progress only
 * inside GoalService.apply against the disk-refreshed clone.
 */
export interface TaskConfirmationResult {
	decision: "confirm" | "continue";
}

export async function showTaskConfirmation(
	ctx: ExtensionContext,
	proposalText: string,
): Promise<TaskConfirmationResult> {
	const headless = shouldAutoConfirmProposal({ hasUI: ctx.hasUI, autoConfirmEnv: process.env.PI_GOAL_AUTO_CONFIRM });
	if (headless) return { decision: "confirm" };
	const result = await showProposalDialog(ctx, proposalText, "goal");
	return { decision: result.decision };
}
