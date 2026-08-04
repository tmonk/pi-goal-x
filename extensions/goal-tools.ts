import type { GoalCore } from "./goal-state.ts";
import { registerCoreTools } from "./goal-core-tools.ts";
import { registerTaskTools } from "./goal-task-tools.ts";
import { registerDraftingTools } from "./goal-drafting.ts";
import { runGoalCompletionFlow } from "./goal-completion.ts";

/**
 * Registration composition only (Stage 5 module split): the three core tools,
 * the two task tools, and the shared completion flow live in their own
 * modules; goal.ts calls this installer once at extension load.
 */
export function registerGoalTools(core: GoalCore): void {
	registerCoreTools(core, { runGoalCompletionFlow });
	registerTaskTools(core);
	registerDraftingTools(core);
}
