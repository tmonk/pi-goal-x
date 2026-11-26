import { planUpdateGoal } from "./goal-tool-inputs.ts";
import { commandHint } from "./goal-controls.ts";
import { schedulerSummary } from "./goal-scheduler-state.ts";
import { goalDetailPage, type GoalDetailSection } from "./goal-detail.ts";
import { taskIndex } from "./goal-task-index.ts";
import { StringEnum, Type } from "@earendil-works/pi-ai";
import { defineTool, type AgentToolResult, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { formatDuration, formatTokenValue, statusLabel, truncateText } from "./goal-display.ts";
import { extractVerificationContract } from "./goal-contract.ts";
import { buildGoalHistoryBlock, buildGoalTaskDetailBlock, detailedSummary, goalDetails, goalTextResult, renderGoalResult } from "./goal-format.ts";
import { modelBudgetLine } from "./goal-accounting.ts";
import { buildGoalCreatedReport, buildTaskSummary, sisyphusStepProgress } from "./goal-policy.ts";
import { buildUnfocusedOpenGoalsSummary, otherOpenGoalCount } from "./goal-pool.ts";
import { readGoalLedger } from "./goal-ledger.ts";
import { loadGoalSettings } from "./settings/resolve.ts";
import { deriveTasksFromObjective } from "./goal-task-derive.ts";
import { type GoalRecord, type GoalTask, validateTokenBudgetInput } from "./goal-record.ts";
import type { GoalCompletionCore } from "./goal-completion.ts";
import type {
	GoalDiskSync,
	GoalLoadedCommands,
	GoalPoolAccess,
	HostSlice,
	LifecycleSlice,
	SchedulerSlice,
	ServiceSlice,
	ViewSlice,
} from "./goal-core-types.ts";
import type { GoalUpdateFlowsCore } from "./goal-update-flows.ts";

/**
 * What the goal tools read and change. The completion and update flows run
 * from `update_goal`, so their needs are part of it.
 */
type CoreToolsCore = GoalCompletionCore &
	GoalUpdateFlowsCore &
	GoalPoolAccess &
	GoalDiskSync &
	GoalLoadedCommands &
	HostSlice<"registerTool"> &
	ServiceSlice<"flushTurn"> &
	LifecycleSlice<"create" | "syncPromptFromDisk"> &
	SchedulerSlice<"declare"> &
	ViewSlice<"goalForDisplay">;
import { promptProfile } from "./prompts/goal-prompts.ts";
import { runGoalAgentPauseFlow, runGoalBlockedFlow } from "./goal-update-flows.ts";

/** Current + first-pending (excluding current) task pointers for concise get_goal. */
function conciseTaskPointers(goal: GoalRecord): { findCurrentTask?: GoalTask; firstPendingTask?: GoalTask } {
	if (!goal.taskList) return {};
	const index = taskIndex(goal.taskList.tasks);
	const firstPendingTask = index.pending.find(task => task.id !== goal.currentTaskId);
	const findCurrentTask = goal.currentTaskId ? index.byId.get(goal.currentTaskId) : undefined;
	return { findCurrentTask, firstPendingTask };
}

/** The first two lines of every get_goal state read: identity and scheduler. */
function goalHeaderLines(core: CoreToolsCore, ctx: ExtensionContext, view: GoalRecord): string[] {
	const settings = loadGoalSettings(ctx.cwd);
	return [
		`Goal ${view.id}: ${statusLabel(view)}, ${view.sisyphus ? "sisyphus" : "regular"}`,
		schedulerSummary(view.scheduler, settings.maxAutonomousRuns, settings.showAutonomousRuns, settings.idleContinuationBackoff === true, core.loadedCommands),
	];
}

/** Full legacy get_goal output. */
function verboseGoalLines(core: CoreToolsCore, ctx: ExtensionContext, view: GoalRecord, includeHistory: boolean): string[] {
	const lines = goalHeaderLines(core, ctx, view);
	lines.push(`Objective: ${view.objective}`, "");
	lines.push(`Status: ${statusLabel(view)}`);
	lines.push(`Mode: ${view.sisyphus ? "sisyphus" : "regular"}`);
	if (view.sisyphus) {
		// E6: sisyphus ordered-step progress.
		const steps = sisyphusStepProgress(view);
		if (steps) lines.push(`At step: ${steps.current} of ${steps.total}`);
	}
	const usageBits: string[] = [];
	if (view.usage.activeSeconds > 0) usageBits.push(formatDuration(view.usage.activeSeconds));
	if (view.usage.tokensUsed > 0) usageBits.push(formatTokenValue(view.usage.tokensUsed));
	lines.push(`Cumulative goal usage (not context occupancy): ${usageBits.length > 0 ? usageBits.join(" · ") : "none"}`);
	const budget = modelBudgetLine(view);
	if (budget) lines.push(`Budget: ${budget}`);
	if (view.taskList) {
		lines.push(`Tasks: ${buildTaskSummary(view.taskList)}`);
		// F1: task-detail block mirroring the widget.
		const detail = buildGoalTaskDetailBlock(view);
		if (detail) lines.push("", detail);
	}
	if (view.verificationContract?.trim()) lines.push(`Verification contract: ${view.verificationContract.trim()}`);
	if (view.status === "paused" || view.status === "blocked") {
		if (view.pauseReason) lines.push(`Blocker: ${view.pauseReason}`);
		if (view.pauseSuggestedAction) lines.push(`Suggested action: ${view.pauseSuggestedAction}`);
	}
	if (view.activePath) lines.push(`Path: ${view.activePath}`);
	if (view.archivedPath) lines.push(`Archive: ${view.archivedPath}`);
	const otherCount = otherOpenGoalCount(core.state.goalsById, core.state.focusedGoalId);
	if (otherCount > 0) lines.push(`Other open goals: ${otherCount} (user can run ${commandHint("goal-list", core.loadedCommands)} or ${commandHint("goal-focus", core.loadedCommands)})`);
	lines.push("");
	lines.push("Lifecycle: call update_goal({status: \"complete\"}) only when every requirement is satisfied — the independent auditor verifies from actual evidence. Call update_goal({status: \"blocked\"}) only after the same blocker recurs on three consecutive goal turns. User commands handle pause/resume/clear/focus.");
	// E1: goal history (last audit verdict + recent lifecycle events).
	if (includeHistory) {
		const history = buildGoalHistoryBlock(view, readGoalLedger(ctx).events);
		if (history) lines.push("", history);
	}
	return lines;
}

/** Compact state read; full requirements remain available through detail pages. */
function compactGoalLines(core: CoreToolsCore, ctx: ExtensionContext, view: GoalRecord, includeHistory: boolean): string[] {
	const lines = goalHeaderLines(core, ctx, view);
	lines.push(`Objective: ${truncateText(view.objective, 180)}${view.objective.length > 180 ? " (full: get_goal section=objective)" : ""}`);
	if (view.taskList) {
		const { findCurrentTask, firstPendingTask } = conciseTaskPointers(view);
		if (findCurrentTask) {
			const contract = findCurrentTask.verificationContract ? ` — contract: ${truncateText(findCurrentTask.verificationContract, 240)}` : "";
			lines.push(`Current task: ${findCurrentTask.id} — ${truncateText(findCurrentTask.title, 180)}${contract}`);
		}
		if (firstPendingTask) {
			lines.push(`Next pending: ${firstPendingTask.id} — ${truncateText(firstPendingTask.title, 180)}`);
		}
		lines.push(`Tasks: ${buildTaskSummary(view.taskList)}`);
	} else if (view.currentTaskId) {
		lines.push(`Current task: ${view.currentTaskId}`);
	}
	const budget = modelBudgetLine(view);
	if (budget) lines.push(`Budget: ${budget}`);
	if ((view.status === "paused" || view.status === "blocked") && view.pauseReason) {
		lines.push(`Blocker: ${view.pauseReason}`);
	}
	if (includeHistory) {
		const history = buildGoalHistoryBlock(view, readGoalLedger(ctx).events);
		if (history) lines.push(history);
	}
	return lines;
}

export function registerCoreTools(
	core: CoreToolsCore,
	deps: {
		runGoalCompletionFlow: (core: GoalCompletionCore, ctx: ExtensionContext, completionSummary?: string) => Promise<AgentToolResult<unknown>>;
	},
): void {
	const { pi } = core;

	pi.registerTool(defineTool({
		name: "get_goal",
		label: "Get Goal",
		description: "Read focused goal state. Default: compact summary. Retrieve full objective/contracts, tasks, or history in 4000-character pages with section and cursor. verbose preserves full legacy output.",
		promptSnippet: "Inspect goal state or retrieve omitted requirements.",
		promptGuidelines: [],
		parameters: Type.Object({
			section: Type.Optional(StringEnum(["summary", "objective", "tasks", "history"] as const)),
			task_id: Type.Optional(Type.String({description: "With section=tasks, retrieve one task."})),
			cursor: Type.Optional(Type.String({maxLength: 256, description: "Next page; repeat section/task."})),
			verbose: Type.Optional(Type.Boolean({ description: "Full detail mode." })),
			include_history: Type.Optional(Type.Boolean()),
		}, { additionalProperties: false }),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			core.reconcileFocusedGoalFromDisk(ctx);
			if (core.state.goal) core.lifecycle.syncPromptFromDisk(ctx);
			const view = core.view.goalForDisplay() ?? core.state.goal;
			const params = (_params ?? {}) as { verbose?: boolean; include_history?: boolean; section?: "summary" | GoalDetailSection; task_id?: string; cursor?: string };
			const taskId = params.task_id?.trim() || undefined;
			// PR E profile: legacy-v1 keeps pre-optimization verbose-by-default output;
			// compact-v2 (default) returns a concise state line set because the full
			// policy already lives in the injected active-goal system block.
			const verbose = promptProfile() === "legacy-v1" || params.verbose === true;
			if (!view) {
				const unfocusedCount = otherOpenGoalCount(core.state.goalsById, null);
				const text = unfocusedCount > 0
					? `${buildUnfocusedOpenGoalsSummary(unfocusedCount)}\n\nCall create_goal with the objective to create and focus a new goal, or ask the user to run ${commandHint("goal-focus", core.loadedCommands)} to choose an open goal.`
					: "No goal is set in this session. Call create_goal with the objective when the user explicitly asks to start a persistent goal.";
				return goalTextResult(text, view);
			}
			if (params.section && params.section !== "summary") {
				if (!["objective", "tasks", "history"].includes(params.section)) return goalTextResult("Unknown goal section.", view);
				const history = params.section === "history" ? readGoalLedger(ctx) : undefined;
				const page = goalDetailPage(view, {section: params.section, task_id: taskId, cursor: params.cursor}, history?.events, history?.revision);
				return {content: [{type: "text", text: page.text}], details: {...goalDetails(view), ...(page.ok ? {page: {content: page.content, nextCursor: page.nextCursor, totalChars: page.totalChars}} : {})}};
			}
			if (params.cursor || taskId) return goalTextResult("Use section=objective, tasks, or history for detail retrieval; task_id requires tasks.", view);
			const lines = verbose && !params.section
				? verboseGoalLines(core, ctx, view, params.include_history === true || verbose)
				: compactGoalLines(core, ctx, view, Boolean(params.include_history));
			return goalTextResult(lines.join("\n"), view);
		},
		renderCall(_args, theme) {
			return new Text(theme.fg("toolTitle", "get_goal"), 0, 0);
		},
		renderResult(result, _options, theme) {
			return renderGoalResult(result, _options, theme);
		},
	}));

	pi.registerTool(defineTool({
		name: "create_goal",
		label: "Create Goal",
		description: "Create and focus a persistent goal only on explicit user request; other open goals remain unchanged.",
		promptSnippet: "Create a goal only when explicitly requested.",
		promptGuidelines: ["Never infer persistent goals, Sisyphus mode, or token budgets from an ordinary task. The objective must faithfully preserve all user requirements and ordered steps."],
		parameters: Type.Object({
			objective: Type.String({ description: "Full objective; preserve ordered steps and done criteria." }),
			mode: Type.Optional(StringEnum(["regular", "sisyphus"] as const, { description: "Default regular; sisyphus only if requested." })),
			token_budget: Type.Optional(Type.Integer({ minimum: 1, description: "Whole-token budget, only if supplied by the user." })),
		}, { additionalProperties: false }),
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			core.reconcileFocusedGoalFromDisk(ctx);
			const objective = params.objective.trim();
			if (!objective) throw new Error("create_goal requires a non-empty objective.");
			const objectiveMaxChars = loadGoalSettings(ctx.cwd).objectiveMaxChars ?? 0;
			if (objectiveMaxChars > 0 && objective.length > objectiveMaxChars) {
				return goalTextResult(`create_goal objective exceeds ${objectiveMaxChars} characters (${objective.length}). Shorten the objective or raise the max objective length setting.`, core.state.goal);
			}
			let tokenBudget: number | undefined;
			if (params.token_budget !== undefined) {
				// Tool callers are untrusted: re-validate the budget beyond the schema.
				const budgetGate = validateTokenBudgetInput(params.token_budget);
				if (!budgetGate.ok) return goalTextResult(budgetGate.message, core.state.goal);
				tokenBudget = budgetGate.value;
			}
			const { objective: cleanedObjective, verificationContract } = extractVerificationContract(objective);
			core.lifecycle.create(
				{ objective: cleanedObjective, autoContinue: true, sisyphus: params.mode === "sisyphus" },
				ctx,
				true,
				verificationContract,
				tokenBudget,
			);
			const created = core.state.goal;
			const otherCount = otherOpenGoalCount(core.state.goalsById, core.state.focusedGoalId);
			const otherLine = otherCount > 0
				? `\n${otherCount} other open goal${otherCount === 1 ? "" : "s"} remain in .pi/goals — this goal is now the session focus.`
				: "";
			// F2: the agent path stays tool-driven — surface the derivable task plan
			// as guidance so the agent proposes it via set_goal_tasks.
			const derived = !created?.taskList ? deriveTasksFromObjective(cleanedObjective) : null;
			const bootstrapLine = derived && derived.length > 0
				? `\n\nThe objective contains ${derived.length} ordered step${derived.length === 1 ? "" : "s"}; propose them as the task tree with set_goal_tasks if the user wants tracked milestones.`
				: "";
			const report = buildGoalCreatedReport({ objective: created?.objective ?? objective, detailedSummary: detailedSummary(created), tokenBudget: created?.tokenBudget });
			return goalTextResult(`${report}${bootstrapLine}${otherLine}`, created, true);
		},
		renderCall(args, theme) {
			const prefix = args?.mode === "sisyphus" ? "create_goal sisyphus " : "create_goal ";
			return new Text(theme.fg("toolTitle", prefix) + theme.fg("muted", args?.objective ?? ""), 0, 0);
		},
		renderResult(result, _options, theme) {
			return renderGoalResult(result, _options, theme);
		},
	}));

	// update_goal is the model's terminal-outcome surface. complete → the
	// independent auditor verifies from actual evidence (no paperwork field);
	// blocked and paused → agent-initiated states that stop continuation.
	pi.registerTool(defineTool({
		name: "update_goal",
		label: "Update Goal",
		description: "Update lifecycle status or optionally save continuation. New waits require strictExecutionContract opt-in. Wait: future ISO deadline; reuse wait_id/deadline without polling on recheck. Completion is audited.",
		promptSnippet: "Complete, block, pause, or optionally save a scheduling decision.",
		promptGuidelines: [],
		parameters: Type.Object({
			status: Type.Optional(StringEnum(["complete", "blocked", "paused"] as const, { description: "Exclusive with continuation." })),
			continuation: Type.Optional(Type.Union([
				Type.Object({ kind: Type.Literal("ready") }, { additionalProperties: false }),
				Type.Object({ kind: Type.Literal("wait"), reason: Type.String({ minLength: 1, maxLength: 2000 }), deadline: Type.String(), wait_id: Type.Optional(Type.String()), polling: Type.Optional(Type.Object({ interval_seconds: Type.Integer({ minimum: 1 }), max_checks: Type.Integer({ minimum: 1 }) }, { additionalProperties: false })) }, { additionalProperties: false }),
			])),
			reason: Type.Optional(Type.String({ description: "Required when status is paused or blocked: describe the concrete blocker." })),
			attempted_actions: Type.Optional(Type.Array(Type.String({ maxLength: 240 }), { maxItems: 8, description: "Actions attempted against the blocker." })),
			suggested_action: Type.Optional(Type.String({ description: "Optional suggested next step when status is paused." })),
			completion_summary: Type.Optional(Type.String({ description: "Untrusted completion claim; never evidence." })),
		}, { additionalProperties: false }),
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const planned = planUpdateGoal(params);
			if (!planned.ok) return {isError: true, content: [{type: "text", text: planned.message}], details: {}, terminate: false};
			core.goalService.flushTurn(ctx);
			const plan = planned.plan;
			switch (plan.action) {
				case "continuation": return core.scheduler.declare(ctx, plan.continuation);
				case "blocked": return runGoalBlockedFlow(core, ctx, plan.reason, plan.attemptedActions);
				case "paused": return runGoalAgentPauseFlow(core, ctx, plan.reason, plan.suggestedAction);
				case "complete": return deps.runGoalCompletionFlow(core, ctx, plan.completionSummary);
			}
		},
		renderCall(args, theme) {
			return new Text(theme.fg("toolTitle", "update_goal ") + theme.fg("muted", args?.status ?? ""), 0, 0);
		},
		renderResult(result, _options, theme) {
			return renderGoalResult(result, _options, theme);
		},
	}));
}
