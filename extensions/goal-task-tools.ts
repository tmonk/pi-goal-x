/**
 * Task-tool support for the Stage 4 consolidation:
 * flat parent-linked `set_goal_tasks` input → recursive GoalTask[] tree,
 * with the same validation rules the recursive path enforced (unique ids,
 * non-empty titles, existing parents, acyclic, ≤50 tasks, configured depth,
 * valid lightweight-subtask placement), plus id-stable merging that preserves
 * status/evidence/timestamps for matching ids.
 */

import { StringEnum, Type } from "@earendil-works/pi-ai";
import { defineTool, type AgentToolResult, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

import { goalDetails, renderGoalResult } from "./goal-format.ts";
import { statusLabel, truncateText } from "./goal-core.ts";
import { loadGoalSettings } from "./goal-settings.ts";
import { buildTaskSummary, checkSubtasksComplete, findSubtaskDepthViolation, skipAllSubtasks } from "./goal-policy.ts";
import { showTaskConfirmation, type TaskConfirmationResult } from "./goal-task-confirmation.ts";
import {
	SET_GOAL_TASKS_TOOL_NAME,
	UPDATE_GOAL_TASK_TOOL_NAME,
} from "./goal-tool-names.ts";
import { nowIso, type GoalTask, type GoalTaskList } from "./goal-record.ts";

export const MAX_TASKS = 50;

export interface FlatTaskInput {
	id: string;
	title: string;
	parent_id?: string;
	verification_contract?: string;
	lightweight_subtasks?: boolean;
}

export interface FlatTaskListInput {
	tasks: FlatTaskInput[];
	block_completion?: boolean;
	change_summary?: string;
}

export type FlatTaskConversion =
	| { ok: true; tasks: GoalTask[] }
	| { ok: false; message: string };

/**
 * Convert a flat parent-linked task list into the recursive GoalTask[]
 * representation, validating:
 *  - non-empty unique ids and titles;
 *  - parent_id references an existing task in the same input;
 *  - acyclic parent relationships;
 *  - at most MAX_TASKS tasks total;
 *  - subtask depth within maxDepth (subtaskDepth setting, default 1);
 *  - lightweight_subtasks is only set on tasks that actually have children.
 */
export function convertFlatTasks(flat: FlatTaskInput[], opts: { maxSubtaskDepth?: number } = {}): FlatTaskConversion {
	if (!Array.isArray(flat)) return { ok: false, message: "tasks must be an array." };
	if (flat.length > MAX_TASKS) return { ok: false, message: `Task list cannot exceed ${MAX_TASKS} tasks.` };

	const ids = new Set<string>();
	for (const item of flat) {
		const id = typeof item.id === "string" ? item.id.trim() : "";
		if (!id) return { ok: false, message: "All tasks must have a non-empty id." };
		if (ids.has(id)) return { ok: false, message: `Duplicate task id: "${id}".` };
		ids.add(id);
		const title = typeof item.title === "string" ? item.title.trim() : "";
		if (!title) return { ok: false, message: `Task "${id}" must have a non-empty title.` };
	}

	// Parent must exist and relationships must be acyclic.
	const byId = new Map<string, FlatTaskInput>(flat.map((item) => [item.id.trim(), item]));
	for (const item of flat) {
		const parentId = typeof item.parent_id === "string" && item.parent_id.trim() ? item.parent_id.trim() : undefined;
		if (parentId && !byId.has(parentId)) {
			return { ok: false, message: `Task "${item.id.trim()}" references missing parent "${parentId}".` };
		}
		if (parentId) {
			// Walk up; if we return to the node itself, there is a cycle.
			let cursor: FlatTaskInput | undefined = byId.get(parentId);
			const seen = new Set<string>([item.id.trim()]);
			while (cursor) {
				if (seen.has(cursor.id.trim())) {
					return { ok: false, message: `Cyclic parent relationship involving task "${cursor.id.trim()}".` };
				}
				seen.add(cursor.id.trim());
				const up = typeof cursor.parent_id === "string" && cursor.parent_id.trim() ? cursor.parent_id.trim() : undefined;
				cursor = up ? byId.get(up) : undefined;
			}
		}
	}

	// Build the tree.
	const childrenOf = new Map<string, FlatTaskInput[]>();
	const roots: FlatTaskInput[] = [];
	for (const item of flat) {
		const parentId = typeof item.parent_id === "string" && item.parent_id.trim() ? item.parent_id.trim() : undefined;
		if (parentId) {
			const siblings = childrenOf.get(parentId) ?? [];
			siblings.push(item);
			childrenOf.set(parentId, siblings);
		} else {
			roots.push(item);
		}
	}
	const order = new Map<string, number>(flat.map((item, index) => [item.id.trim(), index]));

	function buildNode(item: FlatTaskInput): GoalTask {
		const node: GoalTask = {
			id: item.id.trim(),
			title: item.title.trim(),
			status: "pending",
			verificationContract: typeof item.verification_contract === "string" && item.verification_contract.trim()
				? item.verification_contract.trim()
				: undefined,
			lightweightSubtasks: item.lightweight_subtasks === true ? true : undefined,
		};
		const children = childrenOf.get(node.id) ?? [];
		if (children.length > 0) {
			node.subtasks = children
				.sort((a, b) => (order.get(a.id.trim()) ?? 0) - (order.get(b.id.trim()) ?? 0))
				.map(buildNode);
		}
		return node;
	}
	const tasks = roots
		.sort((a, b) => (order.get(a.id.trim()) ?? 0) - (order.get(b.id.trim()) ?? 0))
		.map(buildNode);

	// Lightweight placement: lightweight_subtasks must be on a task with children.
	for (const item of flat) {
		if (item.lightweight_subtasks === true) {
			const children = childrenOf.get(item.id.trim());
			if (!children || children.length === 0) {
				return { ok: false, message: `Task "${item.id.trim()}" sets lightweight_subtasks but has no subtasks.` };
			}
		}
	}

	const maxDepth = opts.maxSubtaskDepth ?? 1;
	const depthViolation = findSubtaskDepthViolation(tasks, maxDepth);
	if (depthViolation) return { ok: false, message: depthViolation };

	return { ok: true, tasks };
}

/**
 * Merge converted tasks into an existing tree. Matching ids preserve runtime
 * progress ONLY (status, evidence, completion/skip timestamps, skip reason);
 * incoming structural fields are authoritative and omission clears them
 * (verification contract, lightweight flag, parentage, child structure).
 */
export function mergeTasksWithExisting(existing: GoalTask[] | undefined, incoming: GoalTask[]): GoalTask[] {
	const existingById = new Map<string, GoalTask>();
	function index(tasks: GoalTask[]): void {
		for (const t of tasks) {
			existingById.set(t.id, t);
			if (t.subtasks) index(t.subtasks);
		}
	}
	index(existing ?? []);

	function mergeTask(input: GoalTask): GoalTask {
		const prior = existingById.get(input.id);
		const progress: Pick<GoalTask, "status" | "evidence" | "completedAt" | "skippedAt" | "skipReason"> = prior
			? {
				status: prior.status,
				evidence: prior.evidence,
				completedAt: prior.completedAt,
				skippedAt: prior.skippedAt,
				skipReason: prior.skipReason,
			}
			: { status: "pending" };
		const base: GoalTask = {
			id: input.id,
			title: input.title,
			// Structural fields are authoritative; undefined (omitted) clears.
			verificationContract: input.verificationContract,
			lightweightSubtasks: input.lightweightSubtasks,
			...progress,
		};
		if (input.subtasks && input.subtasks.length > 0) {
			base.subtasks = input.subtasks.map((child) => mergeTask(child));
		} else if (prior?.subtasks) {
			// Structural removal of all children for this id.
			delete base.subtasks;
		}
		return base;
	}
	return incoming.map(mergeTask);
}

/** Count every node in a task tree (roots + all descendants). */
export function countTasks(tasks: readonly GoalTask[] | undefined): number {
	if (!tasks) return 0;
	let total = 0;
	function walk(list: readonly GoalTask[]): void {
		for (const t of list) {
			total += 1;
			if (t.subtasks) walk(t.subtasks);
		}
	}
	walk(tasks);
	return total;
}

// ── Tool registration (moved from goal-tools.ts in the Stage 5 module split) ─

export function registerTaskTools(core: import("./goal-state.ts").GoalCore): void {
	const { pi } = core;

	// ── set_goal_tasks: flat parent-linked structural task-tree tool ───────────
pi.registerTool(defineTool({
	name: SET_GOAL_TASKS_TOOL_NAME,
	label: "Set Goal Tasks",
	description: "Create or structurally replace the task tree for the focused active or paused goal. Takes a flat parent-linked task list (id, title, optional parent_id, optional verification_contract, optional lightweight_subtasks) plus block_completion. Matching ids retain status and evidence. Structural changes use the existing confirmation dialog.",
	promptSnippet: "Set the goal task tree with confirmation. Stops the turn after confirmation.",
	promptGuidelines: [
		"Use set_goal_tasks after a goal is confirmed, on the first continuation turn, if the objective naturally decomposes into trackable milestones. Do not add a task list for simple single-step goals.",
		"If a task list already exists, only call set_goal_tasks to restructure it when (a) the user explicitly asks, or (b) the goal objective or requirements have structurally changed. Do not restructure autonomously.",
		"Existing tasks with matching ids preserve their status/evidence/timestamps; new ids start as pending; removed ids are gone.",
		"After confirmation the turn stops; the next continuation will arrive automatically.",
		"Validation is enforced at runtime: unique non-empty ids/titles, existing parents, acyclic relationships, at most 50 tasks, configured depth, and lightweight_subtasks only on tasks that have children.",
	],
	parameters: Type.Object({
		tasks: Type.Array(Type.Object({
			id: Type.String({ description: "Short stable slug e.g. 'task-1'" }),
			title: Type.String({ description: "Human-readable task title" }),
			parent_id: Type.Optional(Type.String({ description: "Optional id of the parent task in this same input; roots omit it." })),
			verification_contract: Type.Optional(Type.String({ description: "Optional evidence requirement for completing this task." })),
			lightweight_subtasks: Type.Optional(Type.Boolean({ description: "If true, this task's subtasks are lightweight (no completion enforcement). Only valid when the task has children." })),
		}), { description: "Flat parent-linked task list" }),
		block_completion: Type.Optional(Type.Boolean({ description: "If true, warns when pending tasks remain during completion. Default false." })),
		change_summary: Type.Optional(Type.String({ description: "Optional summary of the task list change" })),
	}, { additionalProperties: false }),
	executionMode: "sequential",
	async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
		core.reconcileFocusedGoalFromDisk(ctx);
		if (!core.state.goal) {
			return {
				content: [{ type: "text", text: "No goal is set; set_goal_tasks requires a focused active or paused goal." }],
				details: goalDetails(core.state.goal),
			};
		}
		if (loadGoalSettings(ctx.cwd).disableTasks) {
			return {
				content: [{ type: "text", text: "set_goal_tasks is disabled by settings (disableTasks: true)." }],
				details: goalDetails(core.state.goal),
			};
		}
		if (core.state.goal.status !== "active" && core.state.goal.status !== "paused") {
			return {
				content: [{ type: "text", text: `set_goal_tasks applies to an active or paused goal; this goal is ${statusLabel(core.state.goal)}.` }],
				details: goalDetails(core.state.goal),
			};
		}
		const settings = loadGoalSettings(ctx.cwd);
		const converted = convertFlatTasks(params.tasks as FlatTaskInput[], { maxSubtaskDepth: settings.subtaskDepth });
		if (!converted.ok) {
			return {
				content: [{ type: "text", text: converted.message }],
				details: goalDetails(core.state.goal),
			};
		}
		const blockCompletion = params.block_completion === true;
		const now = nowIso();

		// Render the proposed STRUCTURAL tree for the confirmation dialog.
		// Progress merge happens inside GoalService.apply against the
		// disk-refreshed clone.
		function renderTaskLines(tasks: GoalTask[], indent = 0): string[] {
			const prefix = "  ".repeat(indent);
			const lines: string[] = [];
			for (const t of tasks) {
				const marker = t.status === "complete" ? "[x]" : t.status === "skipped" ? "[~]" : "[ ]";
				const lw = t.lightweightSubtasks ? " (lightweight)" : "";
				lines.push(`${prefix}${marker} ${t.id}: ${t.title}${lw}`);
				if (t.subtasks && t.subtasks.length > 0) {
					lines.push(...renderTaskLines(t.subtasks, indent + 1));
				}
			}
			return lines;
		}
		const taskLines = renderTaskLines(converted.tasks);
		const gateLabel = blockCompletion ? " (blockCompletion enabled)" : "";
		const proposalText = [`Proposed task list${gateLabel}:`, "", ...taskLines].join("\n");
		const taskListFocus = core.focusedOperationToken(core.state.goal.id);
		// Task-only confirmation: the complete result is the user's decision.
		// No auditor toggle and no goal-state mutation happen here.
		core.enterGoalModal();
		let dialogResult: TaskConfirmationResult;
		try {
			dialogResult = await showTaskConfirmation(ctx, proposalText);
		} finally {
			core.exitGoalModal();
		}
		if (!core.isFocusedOperationCurrent(taskListFocus)) {
			return core.focusedOperationCancelledResult("Task list proposal", taskListFocus);
		}
		if (dialogResult.decision !== "confirm") {
			return {
				content: [{ type: "text", text: "Task list kept unchanged." }],
				details: goalDetails(core.state.goal),
			};
		}
		const applyResult = core.goalService.apply(ctx, {
			reconcile: false,
			focusToken: taskListFocus,
			refreshFromDisk: true,
			// Merge the confirmed structural input against the disk-refreshed
			// clone so a concurrent external edit is preserved unless the
			// requested operation changes the same task.
			mutate: (g) => {
				const merged = mergeTasksWithExisting(g.taskList?.tasks, converted.tasks);
				return { ...g, taskList: { tasks: merged, blockCompletion, proposedAt: now }, updatedAt: now };
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
			return {
				content: [{ type: "text", text: `Task list not applied: ${applyResult.message ?? "the state mutation was rejected"}. Review the current goal and re-propose the task list.` }],
				details: goalDetails(core.state.goal),
			};
		}
		core.runtime.markTurnStopped(core.state.goal.id);
		core.updateUI(ctx);
		const confirmedCount = countTasks(core.state.goal.taskList?.tasks);
		return {
			content: [{ type: "text", text: `Task list set and confirmed. ${confirmedCount} task${confirmedCount === 1 ? "" : "s"}.${gateLabel}` }],
			details: goalDetails(core.state.goal),
			terminate: true,
		};
	},
	renderCall(args, theme) {
		const summary = args?.change_summary ? truncateText(args.change_summary, 80) : `${args?.tasks?.length ?? 0} tasks`;
		return new Text(theme.fg("toolTitle", "set_goal_tasks ") + theme.fg("muted", summary), 0, 0);
	},
	renderResult(result, _options, theme) {
		return renderGoalResult(result, theme);
	},
}));

// ── update_goal_task: discriminated per-task status tool ───────────────────
pi.registerTool(defineTool({
	name: UPDATE_GOAL_TASK_TOOL_NAME,
	label: "Update Goal Task",
	description: "Update one task in the focused goal's task tree without stopping the turn: status \"complete\" (with optional evidence; requires evidence when the task has a verification contract and enforces completed children), \"skipped\" (requires a reason; restricted to explicit user direction or a hard contradiction), or \"pending\" (reopens a skipped task). Completed tasks are immutable through this tool.",
	promptSnippet: "Mark one task complete, skipped, or reopened. Does not stop the turn.",
	promptGuidelines: [
		"Use update_goal_task to update exactly one task; the turn does NOT stop so you may continue with other work.",
		"status=complete requires evidence when the task has a verification contract, and requires all non-lightweight children to be complete first.",
		"status=skipped requires a concrete reason and is restricted to explicit user direction or a hard contradiction (e.g. an impossible requirement). Do not skip to avoid work.",
		"status=pending reopens a skipped task (clears its skip state). Completed tasks cannot be reopened through this tool.",
	],
	parameters: Type.Object({
		task_id: Type.String({ description: "Task id to update" }),
		status: StringEnum(["complete", "skipped", "pending"] as const, { description: "complete (with optional evidence), skipped (requires reason), or pending (reopens a skipped task)." }),
		evidence: Type.Optional(Type.String({ description: "Evidence note for complete (max 200 characters). Required when the task has a verification contract." })),
		reason: Type.Optional(Type.String({ description: "Reason for skipped. Required when status=skipped." })),
	}, { additionalProperties: false }),
	executionMode: "sequential",
	async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
		core.reconcileFocusedGoalFromDisk(ctx);
		if (loadGoalSettings(ctx.cwd).disableTasks) {
			return {
				content: [{ type: "text", text: "update_goal_task is disabled by settings (disableTasks: true)." }],
				details: goalDetails(core.state.goal),
			};
		}
		// update_goal_task applies only to an active goal with an existing task
		// list; invalid lifecycle calls return a state-aware failure.
		if (!core.state.goal) {
			return { content: [{ type: "text", text: "No goal is focused." }], details: goalDetails(core.state.goal) };
		}
		if (core.state.goal.status !== "active") {
			return {
				content: [{ type: "text", text: `update_goal_task applies only to an active goal (current status: ${core.state.goal.status}).` }],
				details: goalDetails(core.state.goal),
			};
		}
		if (!core.state.goal.taskList) {
			return { content: [{ type: "text", text: "The goal has no task list." }], details: goalDetails(core.state.goal) };
		}
		const settings = loadGoalSettings(ctx.cwd);
		const now = nowIso();
		const taskFocus = core.focusedOperationToken(core.state.goal.id);

		if (params.status === "complete") {
			const evidence = params.evidence?.trim().slice(0, 200) || undefined;
			const result = core.goalService.updateTask(ctx, {
				focusToken: taskFocus,
				taskId: params.task_id,
				validate: (task) => {
					if (task.status === "complete") return { ok: false, message: `Task "${params.task_id}" is already complete.` };
					if (task.status === "skipped") return { ok: false, message: `Task "${params.task_id}" was already skipped.` };
					if (!settings.disableContracts && task.verificationContract && !evidence) {
						return { ok: false, message: `Task "${params.task_id}" has a verification contract; provide evidence to complete it.` };
					}
					const subtaskGate = checkSubtasksComplete(task);
					if (subtaskGate) return { ok: false, message: subtaskGate };
					return { ok: true };
				},
				update: (task) => ({ ...task, status: "complete" as const, completedAt: now, evidence }),
				ledger: (written) => [{
					type: "task_complete",
					goalId: written.id,
					taskId: params.task_id,
					evidence,
					at: written.updatedAt,
				}],
			});
			if (!result.ok) {
				return { content: [{ type: "text", text: result.message }], details: goalDetails(core.state.goal) };
			}
			core.updateUI(ctx);
			return {
				content: [{ type: "text", text: `${params.task_id} complete. ${buildTaskSummary(core.state.goal.taskList!)}.` }],
				details: goalDetails(core.state.goal),
			};
		}

		if (params.status === "skipped") {
			const reason = params.reason?.trim();
			if (!reason) {
				return {
					content: [{ type: "text", text: "update_goal_task(status=skipped) requires a non-empty reason." }],
					details: goalDetails(core.state.goal),
				};
			}
			const result = core.goalService.updateTask(ctx, {
				focusToken: taskFocus,
				taskId: params.task_id,
				validate: (task) => {
					if (task.status === "complete") return { ok: false, message: `Task "${params.task_id}" is already complete.` };
					return { ok: true };
				},
				update: (task) => {
					const base = { ...task, status: "skipped" as const, skippedAt: now, skipReason: reason };
					if (task.subtasks && task.subtasks.length > 0 && !task.lightweightSubtasks) {
						return skipAllSubtasks(base, now, reason);
					}
					return base;
				},
				ledger: (written) => [{
					type: "task_skipped",
					goalId: written.id,
					taskId: params.task_id,
					reason,
					at: written.updatedAt,
				}],
			});
			if (!result.ok) {
				return { content: [{ type: "text", text: result.message }], details: goalDetails(core.state.goal) };
			}
			core.updateUI(ctx);
			return {
				content: [{ type: "text", text: `${params.task_id} skipped. ${buildTaskSummary(core.state.goal.taskList!)}.` }],
				details: goalDetails(core.state.goal),
			};
		}

		// status === "pending": reopen a skipped task; completed tasks are immutable.
		const result = core.goalService.updateTask(ctx, {
			focusToken: taskFocus,
			taskId: params.task_id,
			validate: (task) => {
				if (task.status === "complete") {
					return { ok: false, message: `Task "${params.task_id}" is complete and cannot be reopened through update_goal_task.` };
				}
				if (task.status !== "skipped") {
					return { ok: false, message: `Task "${params.task_id}" is not skipped; only skipped tasks can be reopened with status=pending.` };
				}
				return { ok: true };
			},
			update: (task) => {
				const { skippedAt, skipReason, ...rest } = task;
				return { ...rest, status: "pending" as const };
			},
			ledger: (written) => [{
				type: "task_reopened",
				goalId: written.id,
				taskId: params.task_id,
				at: written.updatedAt,
			}],
		});
		if (!result.ok) {
			return { content: [{ type: "text", text: result.message }], details: goalDetails(core.state.goal) };
		}
		core.updateUI(ctx);
		return {
			content: [{ type: "text", text: `${params.task_id} reopened. ${buildTaskSummary(core.state.goal.taskList!)}.` }],
			details: goalDetails(core.state.goal),
		};
	},
	renderCall(args, theme) {
		return new Text(theme.fg("toolTitle", "update_goal_task ") + theme.fg("muted", `${args?.task_id ?? ""} ${args?.status ?? ""}`), 0, 0);
	},
	renderResult(result, _options, theme) {
		return renderGoalResult(result, theme);
	},
}));

}
