import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { runGoalCompletionAuditor } from "./goal-auditor.ts";
import { registerGoalCommands } from "./goal-commands.ts";
import { registerGoalEvents } from "./goal-events.ts";
import {
	GOAL_AUDIT_ENTRY,
	GOAL_EVENT_ENTRY,
	renderGoalAuditEvent,
	renderGoalEvent,
	type GoalAuditEventDetails,
} from "./goal-format.ts";
import type { GoalEventDetails } from "./goal-record.ts";
import { createGoalCore } from "./goal-state.ts";
import { registerGoalTools } from "./goal-tools.ts";

/**
 * pi-goal thin installer. All state lives in the GoalCore (goal-state.ts);
 * the tool surface, command palette, event handlers, and widget/keybindings
 * are registered from their dedicated modules. No goal-file writes, ledger
 * appends, or prompt construction happen here.
 */
export default function goalExtension(
	pi: ExtensionAPI,
	dependencies: { runCompletionAuditor?: typeof runGoalCompletionAuditor } = {},
): void {
	pi.registerMessageRenderer<GoalEventDetails>(GOAL_EVENT_ENTRY, renderGoalEvent);
	pi.registerMessageRenderer<GoalAuditEventDetails>(GOAL_AUDIT_ENTRY, renderGoalAuditEvent);

	const core = createGoalCore(pi, dependencies);
	registerGoalCommands(core);
	registerGoalTools(core);
	registerGoalEvents(core);
}
