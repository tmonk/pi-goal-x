/**
 * Task-tool support for the Stage 4 consolidation:
 * flat parent-linked `set_goal_tasks` input → recursive GoalTask[] tree,
 * with the same validation rules the recursive path enforced (unique ids,
 * non-empty titles, existing parents, acyclic, ≤50 tasks, configured depth,
 * valid lightweight-subtask placement), plus id-stable merging that preserves
 * status/evidence/timestamps for matching ids.
 */

import { type GoalTask } from "./goal-record.ts";
import { findSubtaskDepthViolation } from "./goal-policy.ts";

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
