/**
 * The `set_goal_tasks` and `update_goal_task` tools. Tree conversion and
 * merging live in goal-task-tree.ts.
 */

import { StringEnum, Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

import type { GoalTaskUpdateSpec } from "./goal-service.ts";
import type {
	GoalDiskSync,
	GoalFocusedGoalAccess,
	GoalModalAccess,
	GoalOperationGuard,
	GoalTurnStopMarker,
	GoalUiRefresh,
	HostSlice,
	ServiceSlice,
} from "./goal-core-types.ts";

/** What the task tools read and change. */
export type TaskToolsCore = HostSlice<"registerTool"> &
	GoalFocusedGoalAccess &
	GoalOperationGuard &
	GoalModalAccess &
	GoalUiRefresh &
	GoalDiskSync &
	GoalTurnStopMarker &
	ServiceSlice<"apply" | "updateTask" | "updateTasks">;
import { goalDetails, renderGoalResult } from "./goal-format.ts";
import { statusLabel, truncateText } from "./goal-display.ts";
import { loadGoalSettings } from "./settings/resolve.ts";
import { buildTaskSummary, checkSubtasksComplete, findTaskInTree, skipAllSubtasks } from "./goal-policy.ts";
import { showTaskConfirmation, type TaskConfirmationResult } from "./goal-task-confirmation.ts";
import { dropBlankStatus, normalizeTaskProgress, type TaskProgressInput } from "./goal-tool-inputs.ts";
export type { TaskProgressInput } from "./goal-tool-inputs.ts";
import {
	SET_GOAL_TASKS_TOOL_NAME,
	UPDATE_GOAL_TASK_TOOL_NAME,
} from "./goal-tool-names.ts";
import { nowIso, currentTaskIdIsPending, type GoalTask } from "./goal-record.ts";
import { convertFlatTasks, countTasks, mergeTasksWithExisting, renderTaskLines, taskTreeSchema, type FlatTaskInput } from "./goal-task-tree.ts";

function progressSpec(input: TaskProgressInput, core: TaskToolsCore, ctx: ExtensionContext): GoalTaskUpdateSpec {
	const settings = loadGoalSettings(ctx.cwd);
	const now = nowIso();
	const evidence = input.evidence?.trim().slice(0, 200) || undefined;
	const reason = input.reason?.trim();
	return {
		taskId: input.task_id, focusToken: core.state.focusToken(core.state.goal!.id),
		...(input.status === "start" ? {setCurrentTaskId: input.task_id} : {}),
		validate: task => {
			if (input.status === "start" && task.status !== "pending") return {ok: false, message: `Task "${task.id}" is ${task.status}; only pending tasks can be started.`};
			if (input.status !== "start" && task.status === "complete") return {ok: false, message: `Task "${task.id}" is already complete and cannot be reopened.`};
			if (input.status === "complete") {
				if (task.status === "skipped") return {ok: false, message: `Task "${task.id}" was already skipped.`};
				if (!settings.disableContracts && task.verificationContract && !evidence) return {ok: false, message: `Task "${task.id}" has a verification contract; provide evidence to complete it.`};
				const gate = checkSubtasksComplete(task);
				if (gate) return {ok: false, message: gate};
			}
			if (input.status === "skipped" && !reason) return {ok: false, message: "status=skipped requires a non-empty reason."};
			if (input.status === "pending" && task.status !== "skipped") return {ok: false, message: "Only skipped tasks can be reopened with status=pending."};
			return {ok: true};
		},
		update: task => {
			if (input.status === "start") return task;
			if (input.status === "complete") return {...task, status: "complete", completedAt: now, evidence};
			if (input.status === "skipped") {
				const next: GoalTask = {...task, status: "skipped", skippedAt: now, skipReason: reason};
				return task.subtasks?.length && !task.lightweightSubtasks ? skipAllSubtasks(next, now, reason!) : next;
			}
			const {skippedAt, skipReason, ...rest} = task;
			return {...rest, status: "pending"};
		},
		ledger: written => {
			const base = {goalId: written.id, taskId: input.task_id, at: written.updatedAt};
			if (input.status === "start") return [{...base, type: "task_started"}];
			if (input.status === "complete") return [{...base, type: "task_complete", evidence}];
			if (input.status === "skipped") return [{...base, type: "task_skipped", reason: reason!}];
			return [{...base, type: "task_reopened"}];
		},
	};
}

// ── Tool registration ─

export function registerTaskTools(core: TaskToolsCore): void {
	const { pi } = core;

	// ── set_goal_tasks: flat parent-linked structural task-tree tool ───────────
	pi.registerTool(defineTool({
		name: SET_GOAL_TASKS_TOOL_NAME,
		label: "Set Goal Tasks",
		description: "Set or restructure the task tree with user confirmation. Matching IDs retain progress; removed IDs are deleted. Confirmation stops the turn; continuation follows.",
		promptSnippet: "Set the goal task tree with confirmation.",
		promptGuidelines: ["Use tasks only for useful milestones. Restructure an existing tree only when the user asks or requirements structurally change. Input is a flat parent-linked tree, at most 50 tasks, within configured depth. lightweight_subtasks is valid only on parents."],
		parameters: Type.Object({
			tasks: taskTreeSchema(),
			block_completion: Type.Optional(Type.Boolean({ description: "The goal cannot complete until every task is done." })),
			change_summary: Type.Optional(Type.String()),
		}, { additionalProperties: false }),
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const reply = (text: string) => ({ content: [{ type: "text" as const, text }], details: goalDetails(core.state.goal) });
			core.reconcileFocusedGoalFromDisk(ctx);
			if (!core.state.goal) return reply("No goal is set; set_goal_tasks requires a focused active or paused goal.");
			if (loadGoalSettings(ctx.cwd).disableTasks) return reply("set_goal_tasks is disabled by settings (disableTasks: true).");
			if (core.state.goal.status !== "active" && core.state.goal.status !== "paused") {
				return reply(`set_goal_tasks applies to an active or paused goal; this goal is ${statusLabel(core.state.goal)}.`);
			}
			const settings = loadGoalSettings(ctx.cwd);
			const converted = convertFlatTasks(params.tasks as FlatTaskInput[], { maxSubtaskDepth: settings.subtaskDepth });
			if (!converted.ok) return reply(converted.message);
			const blockCompletion = params.block_completion === true;
			const now = nowIso();

			// Render the proposed STRUCTURAL tree for the confirmation dialog.
			// Progress merge happens inside GoalService.apply against the
			// disk-refreshed clone.
			const taskLines = renderTaskLines(converted.tasks);
			const gateLabel = blockCompletion ? " (blockCompletion enabled)" : "";
			const proposalText = [`Proposed task list${gateLabel}:`, "", ...taskLines].join("\n");
			const taskListFocus = core.state.focusToken(core.state.goal.id);
			// Task-only confirmation: the complete result is the user's decision.
			// No auditor toggle and no goal-state mutation happen here.
			core.state.enterModal();
			let dialogResult: TaskConfirmationResult;
			try {
				dialogResult = await showTaskConfirmation(ctx, proposalText);
			} finally {
				core.state.exitModal();
			}
			if (!core.state.isTokenCurrent(taskListFocus)) {
				return core.state.cancelledResult("Task list proposal", taskListFocus);
			}
			if (dialogResult.decision !== "confirm") return reply("Task list kept unchanged.");
			const applyResult = core.goalService.apply(ctx, {
				reconcile: false,
				focusToken: taskListFocus,
				refreshFromDisk: true,
				// Merge the confirmed structural input against the disk-refreshed
				// clone so a concurrent external edit is preserved unless the
				// requested operation changes the same task.
				mutate: (g) => {
					const merged = mergeTasksWithExisting(g.taskList?.tasks, converted.tasks);
					// Keep currentTaskId only when the same id remains pending;
					// otherwise clear it. Dashboard state recomputes on the next render.
					const currentTaskId =
						g.currentTaskId && currentTaskIdIsPending(merged, g.currentTaskId) ? g.currentTaskId : undefined;
					return { ...g, currentTaskId, taskList: { tasks: merged, blockCompletion, proposedAt: now }, updatedAt: now };
				},
				ledger: (written) => [{
					type: "task_list_set",
					goalId: written.id,
					taskCount: countTasks(written.taskList?.tasks),
					blockCompletion,
					at: written.updatedAt,
				}],
			});
			if (!applyResult.ok) {
				// A stale writer receives a typed conflict carrying the current
				// revision; whole-tree replacement is authoritative and must not
				// silently merge unknown new structure (follow-up Stage 4).
				return reply(`Task list not applied: ${applyResult.message ?? "the state mutation was rejected"}. Review the current goal and re-propose the task list.`);
			}
			core.runtime.markTurnStopped(core.state.goal.id);
			core.updateUI(ctx);
			const confirmedCount = countTasks(core.state.goal.taskList?.tasks);
			return { ...reply(`Task list set and confirmed. ${confirmedCount} task${confirmedCount === 1 ? "" : "s"}.${gateLabel}`), terminate: true };
		},
		renderCall(args, theme) {
			const summary = args?.change_summary ? truncateText(args.change_summary, 80) : `${args?.tasks?.length ?? 0} tasks`;
			return new Text(theme.fg("toolTitle", "set_goal_tasks ") + theme.fg("muted", summary), 0, 0);
		},
		renderResult(result, _options, theme) {
			return renderGoalResult(result, _options, theme);
		},
	}));

	// ── update_goal_task: discriminated per-task status tool ───────────────────
	pi.registerTool(defineTool({
		name: UPDATE_GOAL_TASK_TOOL_NAME,
		label: "Update Goal Task",
		description: "Update task progress without stopping the turn. Use ordered updates for an atomic batch, or task_id/status for one task. An invalid update rejects the whole batch.",
		promptSnippet: "Start, complete, skip, or reopen tasks; batch related progress.",
		promptGuidelines: ["start requires pending and sets current task. complete requires evidence for contracted tasks and completed/skipped non-lightweight children. skipped requires a reason and explicit user direction or a hard contradiction; never skip to avoid work. pending reopens skipped tasks only; completed tasks are immutable. Completing/skipping the current task clears focus."],
		parameters: Type.Object({
			task_id: Type.Optional(Type.String({ description: "Single-task form; with updates, any non-empty root fields must repeat one batch entry." })),
			status: Type.Optional(StringEnum(["start", "complete", "skipped", "pending"] as const, { description: "Single-task status. Leave it out when using updates." })),
			updates: Type.Optional(Type.Array(Type.Object({task_id: Type.String(), status: StringEnum(["start", "complete", "skipped", "pending"] as const), evidence: Type.Optional(Type.String()), reason: Type.Optional(Type.String())}, {additionalProperties: false}), {maxItems: 100, description: "Ordered atomic batch. An empty array is allowed only with valid single-task fields."})),
			evidence: Type.Optional(Type.String({ description: "Completion evidence; max 200 chars." })),
			reason: Type.Optional(Type.String({ description: "Required for skipped." })),
		}, { additionalProperties: false }),
		// Some models send "" for every optional field. Google rejects "" in an
		// enum, so it is not in the schema; drop a blank status here instead,
		// before Pi validates the call.
		prepareArguments: (args) => dropBlankStatus(args) as never,
		executionMode: "sequential",
		async execute(_toolCallId, rawParams, _signal, _onUpdate, ctx) {
			const reply = (text: string) => ({ content: [{ type: "text" as const, text }], details: goalDetails(core.state.goal) });
			const normalized = normalizeTaskProgress(rawParams);
			if (!normalized.ok) return reply(normalized.message);
			core.reconcileFocusedGoalFromDisk(ctx);
			if (loadGoalSettings(ctx.cwd).disableTasks) return reply("update_goal_task is disabled by settings (disableTasks: true).");
			// update_goal_task applies only to an active goal; invalid lifecycle
			// calls return a state-aware failure.
			if (!core.state.goal) return reply("No goal is focused.");
			if (core.state.goal.status !== "active") return reply(`update_goal_task applies only to an active goal (current status: ${core.state.goal.status}).`);
			if (normalized.batch) {
				const updates = normalized.updates;
				const result = core.goalService.updateTasks(ctx, updates.map(u => progressSpec(u, core, ctx)));
				if (!result.ok) return reply(result.message);
				core.updateUI(ctx);
				return reply(`${updates.map(u => `${u.task_id} ${u.status}`).join("; ")}. ${buildTaskSummary(result.goal.taskList!)}.`);
			}
			if (!core.state.goal.taskList) return reply("The goal has no task list.");

			const params = normalized.updates[0]!;
			const settings = loadGoalSettings(ctx.cwd);
			const now = nowIso();
			const taskId = params.task_id;
			const taskFocus = core.state.focusToken(core.state.goal.id);
			/** Apply one task update; on success refresh the UI and report `done()`. */
			const updateOne = (spec: Omit<GoalTaskUpdateSpec, "focusToken" | "taskId">, done: () => string) => {
				const result = core.goalService.updateTask(ctx, { focusToken: taskFocus, taskId, ...spec });
				if (!result.ok) return reply(result.message);
				core.updateUI(ctx);
				return reply(done());
			};
			const summary = () => buildTaskSummary(core.state.goal!.taskList!);

			if (params.status === "start") {
				return updateOne({
					validate: (task) => {
						if (task.status !== "pending") {
							return { ok: false, message: `Task "${taskId}" is ${task.status}; only pending tasks can be started.` };
						}
						return { ok: true };
					},
					update: (task) => task,
					// Set explicit execution focus; a later start replaces it, and
					// completing/skipping this task clears it.
					setCurrentTaskId: taskId,
					ledger: (written) => [{ type: "task_started", goalId: written.id, taskId, at: written.updatedAt }],
				}, () => {
					// Surface the task contract so the next continuation prompt and
					// the dashboard can show what starting this task requires.
					const started = findTaskInTree(core.state.goal!.taskList?.tasks ?? [], taskId);
					const contract = started?.verificationContract ? ` Contract: ${started.verificationContract}` : "";
					return `Started ${taskId}${contract}. ${summary()}.`;
				});
			}

			if (params.status === "complete") {
				const evidence = params.evidence?.trim().slice(0, 200) || undefined;
				return updateOne({
					validate: (task) => {
						if (task.status === "complete") return { ok: false, message: `Task "${taskId}" is already complete.` };
						if (task.status === "skipped") return { ok: false, message: `Task "${taskId}" was already skipped.` };
						if (!settings.disableContracts && task.verificationContract && !evidence) {
							return { ok: false, message: `Task "${taskId}" has a verification contract; provide evidence to complete it.` };
						}
						const subtaskGate = checkSubtasksComplete(task);
						if (subtaskGate) return { ok: false, message: subtaskGate };
						return { ok: true };
					},
					update: (task) => ({ ...task, status: "complete" as const, completedAt: now, evidence }),
					ledger: (written) => [{ type: "task_complete", goalId: written.id, taskId, evidence, at: written.updatedAt }],
				}, () => `${taskId} complete. ${summary()}.`);
			}

			if (params.status === "skipped") {
				const reason = params.reason?.trim();
				if (!reason) return reply("update_goal_task(status=skipped) requires a non-empty reason.");
				return updateOne({
					validate: (task) => {
						if (task.status === "complete") return { ok: false, message: `Task "${taskId}" is already complete.` };
						return { ok: true };
					},
					update: (task) => {
						const base = { ...task, status: "skipped" as const, skippedAt: now, skipReason: reason };
						if (task.subtasks && task.subtasks.length > 0 && !task.lightweightSubtasks) {
							return skipAllSubtasks(base, now, reason);
						}
						return base;
					},
					ledger: (written) => [{ type: "task_skipped", goalId: written.id, taskId, reason, at: written.updatedAt }],
				}, () => `${taskId} skipped. ${summary()}.`);
			}

			// status === "pending": reopen a skipped task; completed tasks are immutable.
			return updateOne({
				validate: (task) => {
					if (task.status === "complete") {
						return { ok: false, message: `Task "${taskId}" is complete and cannot be reopened through update_goal_task.` };
					}
					if (task.status !== "skipped") {
						return { ok: false, message: `Task "${taskId}" is not skipped; only skipped tasks can be reopened with status=pending.` };
					}
					return { ok: true };
				},
				update: (task) => {
					const { skippedAt, skipReason, ...rest } = task;
					return { ...rest, status: "pending" as const };
				},
				ledger: (written) => [{ type: "task_reopened", goalId: written.id, taskId, at: written.updatedAt }],
			}, () => `${taskId} reopened. ${summary()}.`);
		},
		renderCall(args, theme) {
			const summary = args?.updates?.length ? `${args.updates.length} updates` : `${args?.task_id ?? ""} ${args?.status ?? ""}`;
			return new Text(theme.fg("toolTitle", "update_goal_task ") + theme.fg("muted", summary), 0, 0);
		},
		renderResult(result, _options, theme) {
			return renderGoalResult(result, _options, theme);
		},
	}));

}
