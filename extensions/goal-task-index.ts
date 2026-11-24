import type { GoalTask } from "./goal-record.ts";

export interface TaskIndex {
	tasks: GoalTask[];
	byId: Map<string, GoalTask>;
	ordered: Array<{task: GoalTask; depth: number; parentId?: string}>;
	pending: GoalTask[];
	complete: number;
	skipped: number;
}
const cache: Array<{index: TaskIndex; chars: number}> = [];
let cachedChars = 0;
const taskFields = ["id", "title", "status", "completedAt", "skippedAt", "evidence", "skipReason", "verificationContract", "lightweightSubtasks"] as const;

/** Compare fields without serializing long titles/contracts. Also catches in-place edits. */
function sameTasks(left: readonly GoalTask[], right: readonly GoalTask[]): boolean {
	if (left.length !== right.length) return false;
	for (let i = 0; i < left.length; i++) {
		const a = left[i]!; const b = right[i]!;
		for (const field of taskFields) if (a[field] !== b[field]) return false;
		if (a.subtasks || b.subtasks) {
			if (!a.subtasks || !b.subtasks || !sameTasks(a.subtasks, b.subtasks)) return false;
		}
	}
	return true;
}
const emptyTasks: GoalTask[] = [];
/** Content validated: usage-only copies reuse derivations; mutable input never aliases the snapshot. */
export function taskIndex(tasks: readonly GoalTask[] = emptyTasks): TaskIndex {
	for (let i = cache.length - 1; i >= 0; i--) {
		const entry = cache[i]!;
		if (sameTasks(tasks, entry.index.tasks)) return entry.index;
	}
	let chars = 0;
	const copy = (list: readonly GoalTask[]): GoalTask[] => list.map(task => {
		for (const field of taskFields) if (typeof task[field] === "string") chars += (task[field] as string).length;
		return {...task, ...(task.subtasks ? {subtasks: copy(task.subtasks)} : {})};
	});
	const snapshot = copy(tasks);
	const result: TaskIndex = {tasks: snapshot, byId: new Map(), ordered: [], pending: [], complete: 0, skipped: 0};
	const walk = (list: GoalTask[], depth: number, parentId?: string): void => {
		for (const task of list) {
			result.byId.set(task.id, task); result.ordered.push({task, depth, parentId});
			if (task.status === "pending") result.pending.push(task);
				else if (task.status === "complete") result.complete++;
				else result.skipped++;
			if (task.subtasks) walk(task.subtasks, depth + 1, task.id);
		}
	};
	walk(snapshot, 0);
// Bound retained text as well as entry count. Oversized plans remain fully supported.
	if (chars <= 2_000_000) {
		while (cache.length >= 32 || cachedChars + chars > 2_000_000) cachedChars -= cache.shift()!.chars;
		cache.push({index: result, chars}); cachedChars += chars;
	}
	return result;
}
