import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
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
