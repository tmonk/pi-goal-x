/**
 * Task tree support for the task tools: flat parent-linked `set_goal_tasks`
 * input → recursive GoalTask[] tree, with validation (unique ids, non-empty
 * titles, existing parents, acyclic, ≤50 tasks, configured depth, valid
 * lightweight-subtask placement), plus id-stable merging that preserves
 * status/evidence/timestamps for matching ids.
 */

import { Type } from "@earendil-works/pi-ai";

import { findSubtaskDepthViolation } from "./goal-policy.ts";
import type { GoalTask } from "./goal-record.ts";

const MAX_TASKS = 50;

export interface FlatTaskInput {
	id: string;
	title: string;
	parent_id?: string;
	verification_contract?: string;
	lightweight_subtasks?: boolean;
}

type FlatTaskConversion =
	| { ok: true; tasks: GoalTask[] }
	| { ok: false; message: string };

function trimmed(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

function parentIdOf(item: FlatTaskInput): string | undefined {
	return trimmed(item.parent_id) || undefined;
}

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
		const id = trimmed(item.id);
		if (!id) return { ok: false, message: "All tasks must have a non-empty id." };
		if (ids.has(id)) return { ok: false, message: `Duplicate task id: "${id}".` };
		ids.add(id);
		if (!trimmed(item.title)) return { ok: false, message: `Task "${id}" must have a non-empty title.` };
	}

	// Parent must exist and relationships must be acyclic.
	const byId = new Map<string, FlatTaskInput>(flat.map((item) => [item.id.trim(), item]));
	for (const item of flat) {
		const parentId = parentIdOf(item);
		if (!parentId) continue;
		if (!byId.has(parentId)) {
			return { ok: false, message: `Task "${item.id.trim()}" references missing parent "${parentId}".` };
		}
		// Walk up; if we return to the node itself, there is a cycle.
		let cursor: FlatTaskInput | undefined = byId.get(parentId);
		const seen = new Set<string>([item.id.trim()]);
		while (cursor) {
			const cursorId = cursor.id.trim();
			if (seen.has(cursorId)) {
				return { ok: false, message: `Cyclic parent relationship involving task "${cursorId}".` };
			}
			seen.add(cursorId);
			const up = parentIdOf(cursor);
			cursor = up ? byId.get(up) : undefined;
		}
	}

	// Build the tree.
	const childrenOf = new Map<string, FlatTaskInput[]>();
	const roots: FlatTaskInput[] = [];
	for (const item of flat) {
		const parentId = parentIdOf(item);
		if (!parentId) {
			roots.push(item);
			continue;
		}
		const siblings = childrenOf.get(parentId) ?? [];
		siblings.push(item);
		childrenOf.set(parentId, siblings);
	}

	function buildNode(item: FlatTaskInput): GoalTask {
		const node: GoalTask = {
			id: item.id.trim(),
			title: item.title.trim(),
			status: "pending",
			verificationContract: trimmed(item.verification_contract) || undefined,
			lightweightSubtasks: item.lightweight_subtasks === true ? true : undefined,
		};
		const children = childrenOf.get(node.id) ?? [];
		if (children.length > 0) {
			node.subtasks = children.map(buildNode);
		}
		return node;
	}
	// Both buckets were populated in input order, so sorting would repeat that work.
	const tasks = roots.map(buildNode);

	// Lightweight placement: lightweight_subtasks must be on a task with children.
	for (const item of flat) {
		if (item.lightweight_subtasks === true && !childrenOf.get(item.id.trim())?.length) {
			return { ok: false, message: `Task "${item.id.trim()}" sets lightweight_subtasks but has no subtasks.` };
		}
	}

	const depthViolation = findSubtaskDepthViolation(tasks, opts.maxSubtaskDepth ?? 1);
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

/** One line per task, indented by depth, for the task-list confirmation dialog. */
export function renderTaskLines(tasks: GoalTask[], indent = 0): string[] {
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

/** The flat task list taken by set_goal_tasks and propose_goal_draft. */
export function taskTreeSchema() {
	return Type.Array(Type.Object({
		id: Type.String({ description: "Short slug, e.g. task-1." }),
		title: Type.String(),
		parent_id: Type.Optional(Type.String({ description: "Leave out for top-level tasks." })),
		verification_contract: Type.Optional(Type.String({ description: "Evidence needed to complete it." })),
		lightweight_subtasks: Type.Optional(Type.Boolean({ description: "Its subtasks do not block it." })),
	}));
}
