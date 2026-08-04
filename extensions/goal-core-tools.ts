import { StringEnum, Type } from "@earendil-works/pi-ai";
import { defineTool, type AgentToolResult, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { formatDuration, formatTokenValue, statusLabel, truncateText } from "./goal-core.ts";
import { extractVerificationContract } from "./goal-contract.ts";
import { detailedSummary, goalDetails, renderGoalResult } from "./goal-format.ts";
import { budgetLine } from "./goal-accounting.ts";
import { buildGoalCreatedReport, buildTaskSummary, validateGoalBlock } from "./goal-policy.ts";
import { buildUnfocusedOpenGoalsSummary, otherOpenGoalCount } from "./goal-pool.ts";
import { nowIso, validateTokenBudgetInput } from "./goal-record.ts";
import type { GoalCore } from "./goal-state.ts";

export function registerCoreTools(
	core: GoalCore,
	deps: {
		runGoalCompletionFlow: (core: GoalCore, ctx: ExtensionContext) => Promise<AgentToolResult<unknown>>;
	},
): void {
	const { pi } = core;

pi.registerTool(defineTool({
	name: "get_goal",
	label: "Get Goal",
	description: "Get the current pi goal for this session: objective, status, auto-continue, usage, and local file paths.",
	promptSnippet: "Read the active pi goal state for the current session.",
	promptGuidelines: [
		"Use get_goal when you need the current goal before deciding whether to continue or mark it complete.",
		"Before marking a goal complete, compare every explicit requirement with concrete evidence from the workspace/session.",
		"If the returned goal has sisyphus mode on, you must execute strictly step-by-step in the order written in the objective; do not skip, combine, or rush steps, and stop to ask the user when blocked or unclear.",
	],
	parameters: Type.Object({}, { additionalProperties: false }),
	async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
		core.reconcileFocusedGoalFromDisk(ctx);
		if (core.state.goal) core.syncGoalPromptFromDisk(ctx);
		const view = core.goalForDisplay() ?? core.state.goal;
		const otherCount = otherOpenGoalCount(core.goalsById, core.focusedGoalId);
		if (!view) {
			const text = core.openGoals().length > 0
				? `${buildUnfocusedOpenGoalsSummary(core.openGoals().length)}\n\nCall create_goal with the objective to create and focus a new goal, or ask the user to run /goal-focus to choose an open goal.`
				: "No goal is set in this session. Call create_goal with the objective when the user explicitly asks to start a persistent goal.";
			return {
				content: [{ type: "text", text }],
				details: goalDetails(view),
			};
		}
		const lines: string[] = [view.objective, ""];
		lines.push(`Status: ${statusLabel(view)}`);
		lines.push(`Mode: ${view.sisyphus ? "sisyphus" : "regular"}`);
		const usageBits: string[] = [];
		if (view.usage.activeSeconds > 0) usageBits.push(formatDuration(view.usage.activeSeconds));
		if (view.usage.tokensUsed > 0) usageBits.push(formatTokenValue(view.usage.tokensUsed));
		lines.push(`Usage: ${usageBits.length > 0 ? usageBits.join(" · ") : "none"}`);
		const budget = budgetLine(view);
		if (budget) lines.push(`Budget: ${budget}`);
		if (view.taskList) lines.push(`Tasks: ${buildTaskSummary(view.taskList)}`);
		if (view.verificationContract?.trim()) lines.push(`Verification contract: ${view.verificationContract.trim()}`);
		if (view.status === "paused" || view.status === "blocked") {
			if (view.pauseReason) lines.push(`Blocker: ${view.pauseReason}`);
			if (view.pauseSuggestedAction) lines.push(`Suggested action: ${view.pauseSuggestedAction}`);
		}
		if (view.activePath) lines.push(`Path: ${view.activePath}`);
		if (view.archivedPath) lines.push(`Archive: ${view.archivedPath}`);
		if (otherCount > 0) lines.push(`Other open goals: ${otherCount} (user can run /goal-list or /goal-focus)`);
		lines.push("");
		lines.push("Lifecycle: call update_goal({status: \"complete\"}) only when every requirement is satisfied — the independent auditor verifies from actual evidence. Call update_goal({status: \"blocked\"}) only after the same blocker recurs on three consecutive goal turns. User commands handle pause/resume/clear/focus.");
		return {
			content: [{ type: "text", text: lines.join("\n") }],
			details: goalDetails(view),
		};
	},
	renderCall(_args, theme) {
		return new Text(theme.fg("toolTitle", "get_goal"), 0, 0);
	},
	renderResult(result, _options, theme) {
		return renderGoalResult(result, theme);
	},
}));

pi.registerTool(defineTool({
	name: "create_goal",
	label: "Create Goal",
	description: "Create and focus a new pi goal after an explicit user request. Only call this when the user has explicitly asked to make something a persistent goal (directly, or via /goal or /sisyphus); do NOT infer a goal from an ordinary task. Creating a goal focuses it and leaves other open goals untouched.",
	promptSnippet: "Create a persistent pi goal only when the user explicitly asks for one.",
	promptGuidelines: [
		"Call create_goal only when the user explicitly asks to start a long-running goal or hands you a concrete objective to pursue. Never infer a goal from an ordinary one-off task.",
		"Creating a new goal focuses it and leaves other open goals untouched. Do not archive or replace existing goals unless the user explicitly asks through a user command.",
		"Pass mode=\"sisyphus\" only when the user explicitly invoked Sisyphus mode.",
	],
	parameters: Type.Object({
		objective: Type.String({ description: "Full goal text. For Sisyphus goals this MUST include the user's numbered steps + per-step done criteria, taken faithfully from the user's input. 1-4000 characters." }),
		mode: Type.Optional(StringEnum(["regular", "sisyphus"] as const, { description: "Goal mode. Defaults to regular. Use sisyphus only when the user explicitly invoked Sisyphus mode." })),
		token_budget: Type.Optional(Type.Integer({ minimum: 1, description: "Optional token budget in whole tokens. Accept it only when the user explicitly supplied a budget; never invent one." })),
	}, { additionalProperties: false }),
	executionMode: "sequential",
	async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
		core.reconcileFocusedGoalFromDisk(ctx);
		const objective = params.objective.trim();
		if (!objective) throw new Error("create_goal requires a non-empty objective.");
		if (objective.length > 4000) {
			return {
				content: [{ type: "text", text: `create_goal objective exceeds 4000 characters (${objective.length}). Shorten the objective and retry.` }],
				details: goalDetails(core.state.goal),
			};
		}
		const sisyphusFlag = params.mode === "sisyphus";
		let tokenBudget: number | undefined;
		if (params.token_budget !== undefined) {
			// Tool callers are untrusted: re-validate the budget beyond the schema.
			const budgetGate = validateTokenBudgetInput(params.token_budget);
			if (!budgetGate.ok) {
				return {
					content: [{ type: "text", text: budgetGate.message }],
					details: goalDetails(core.state.goal),
				};
			}
			tokenBudget = budgetGate.value;
		}
		const { objective: cleanedObjective, verificationContract } = extractVerificationContract(objective);
		core.replaceGoal(
			{ objective: cleanedObjective, autoContinue: true, sisyphus: sisyphusFlag },
			ctx,
			true,
			verificationContract,
			tokenBudget,
		);
		const created = core.state.goal;
		const otherCount = otherOpenGoalCount(core.goalsById, core.focusedGoalId);
		const otherLine = otherCount > 0
			? `\n${otherCount} other open goal${otherCount === 1 ? "" : "s"} remain in .pi/goals — this goal is now the session focus.`
			: "";
		return {
			content: [{ type: "text", text: `${buildGoalCreatedReport({ objective: created?.objective ?? objective, detailedSummary: detailedSummary(created) })}${otherLine}` }],
			details: goalDetails(created),
			terminate: true,
		};
	},
	renderCall(args, theme) {
		const prefix = args?.mode === "sisyphus" ? "create_goal sisyphus " : "create_goal ";
		return new Text(theme.fg("toolTitle", prefix) + theme.fg("muted", args?.objective ?? ""), 0, 0);
	},
	renderResult(result, _options, theme) {
		return renderGoalResult(result, theme);
	},
}));

	// ── update_goal: the model's terminal-outcome surface (Stage 3) ────────
// complete → the independent auditor verifies from actual evidence (no
// paperwork field); blocked → a distinct agent-blocked state that stops
// continuation. The three-consecutive-turn blocker rule is prompt policy.
async function runGoalBlockedFlow(ctx: ExtensionContext): Promise<AgentToolResult<unknown>> {
	core.reconcileFocusedGoalFromDisk(ctx);
	const gate = validateGoalBlock({ goal: core.state.goal, runningGoalId: core.runningGoalId });
	if (!gate.ok) {
		return {
			content: [{ type: "text", text: gate.message }],
			details: goalDetails(core.state.goal),
		};
	}
	if (!core.state.goal) throw new Error("Goal disappeared during blocked validation.");
	core.accountProgress(ctx);
	const result = core.goalService.apply(ctx, {
		reconcile: false,
		refreshFromDisk: true,
		mutate: (g) => ({
			...g,
			status: "blocked" as const,
			stopReason: "agent" as const,
			pauseReason: g.pauseReason ?? "The model reported this goal as blocked after the same blocker recurred on consecutive turns.",
			updatedAt: nowIso(),
		}),
		ledger: (written) => [{
			type: "goal_blocked",
			goalId: written.id,
			reason: written.pauseReason ?? "blocked",
			source: "agent",
			at: written.updatedAt,
		}],
	});
	if (result.ok) {
		core.clearContinuationState();
		core.clearActiveAccounting();
		if (result.goal) core.runtime.markTurnStopped(result.goal.id);
		core.updateUI(ctx);
	}
	return {
		content: [{
			type: "text",
			text: "Goal blocked. Continuation stopped; the goal is waiting for the user to resume, revise, or clear it. Stop now; do not start another tool call.",
		}],
		details: goalDetails(core.state.goal),
		terminate: true,
	};
}

pi.registerTool(defineTool({
	name: "update_goal",
	label: "Update Goal",
	description: "Report one of two terminal outcomes for the current run: status \"complete\" (runs the independent completion auditor, which verifies from actual evidence — no paperwork field) or status \"blocked\" (records a distinct agent-blocked state and stops continuation). Call blocked only after the same blocker recurs on three consecutive goal turns.",
	promptSnippet: "Report the current run as complete (audited) or blocked (after three consecutive identical blockers).",
	promptGuidelines: [
		"Call update_goal({status: \"complete\"}) only when every requirement is satisfied. There is no verification-summary parameter: the independent auditor derives the requirements from the objective and any verification contract, and inspects the actual workspace evidence.",
		"Call update_goal({status: \"blocked\"}) only after the SAME blocker has recurred on three consecutive goal turns. Do not block on the first or second occurrence — keep trying concrete next steps and ask for help when genuinely stuck. A user pause remains an immediate, distinct state controlled by the user.",
		"Do not use update_goal as an escape hatch: if the objective is achieved, complete it; if it is not, do not complete it. The goal objective is immutable — the model must never edit it on its own initiative.",
		"For sisyphus goals, do not mark complete until every numbered step has been executed and individually verified against its done criterion.",
	],
	parameters: Type.Object({
		status: StringEnum(["complete", "blocked"] as const, { description: "complete runs the independent auditor; blocked records a distinct agent-blocked state. Only these two outcomes are accepted." }),
	}, { additionalProperties: false }),
	executionMode: "sequential",
	async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
		if (params.status === "blocked") {
			return runGoalBlockedFlow(ctx);
		}
		return deps.runGoalCompletionFlow(core, ctx);
	},
	renderCall(args, theme) {
		return new Text(theme.fg("toolTitle", "update_goal ") + theme.fg("muted", args?.status ?? ""), 0, 0);
	},
	renderResult(result, _options, theme) {
		return renderGoalResult(result, theme);
	},
}));
}
