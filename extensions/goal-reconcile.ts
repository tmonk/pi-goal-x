import type { GoalRecord } from "./goal-record.ts";
import { mergeFocusedGoalWithDisk } from "./goal-pool.ts";

/** What reconciling the session's goals with the disk should do. */
type ReconcilePlan =
	/** Memory already matches the disk; `goal` is the focused goal, if any. */
	| { kind: "unchanged"; goal: GoalRecord | undefined }
	/** Nothing is focused: just take the disk pool. */
	| { kind: "pool-only"; pool: Map<string, GoalRecord> }
	/**
	 * Take the disk pool, then put `goal` into it and focus it. `fromDisk` is
	 * true when the disk's record was adopted, false when a goal that has no file
	 * yet was kept from memory.
	 */
	| { kind: "focus"; pool: Map<string, GoalRecord>; goal: GoalRecord; fromDisk: boolean }
	/** The focused goal is gone from the disk. */
	| { kind: "lost"; pool: Map<string, GoalRecord>; lostGoalId: string | null };

interface ReconcileInput {
	/** The focused goal in memory. */
	current: GoalRecord | null;
	focusedGoalId: string | null;
	/** The session's goal pool as it is now. */
	view: Map<string, GoalRecord>;
	/** The active goals on disk. */
	source: ReadonlyMap<string, GoalRecord>;
	/** The goal held in the open turn buffer, which is newer than the disk. */
	buffered: GoalRecord | null;
	preserveMemoryUsage?: boolean;
}

/**
 * Decide how the session's goals follow the disk. Pure: the service applies the
 * plan through its ref, in the order the plan's fields are listed.
 */
export function planReconcile(input: ReconcileInput): ReconcilePlan {
	const { current, focusedGoalId: focused, view, source, buffered } = input;
	let unchanged = source.size === view.size && (!focused || source.has(focused));
	if (unchanged) for (const [id, goal] of source) {
		if (view.get(id) !== (buffered?.id === id ? buffered : goal)) { unchanged = false; break; }
	}
	if (unchanged) return { kind: "unchanged", goal: focused ? view.get(focused) : undefined };
	const fresh = new Map(source);
	// Overlay the buffered goal so in-turn mutations are visible to every read
	// (reconcile, get_goal, prompts) without a disk round trip.
	if (buffered) fresh.set(buffered.id, buffered);
	if (!focused) return { kind: "pool-only", pool: fresh };
	const diskGoal = fresh.get(focused) ?? null;
	if (!diskGoal) {
		if (current && !current.activePath) return { kind: "focus", pool: fresh, goal: current, fromDisk: false };
		return { kind: "lost", pool: fresh, lostGoalId: current?.id ?? null };
	}
	const reconciled = current && input.preserveMemoryUsage
		? mergeFocusedGoalWithDisk({ memoryGoal: current, diskGoal })
		: diskGoal;
	return { kind: "focus", pool: fresh, goal: reconciled, fromDisk: true };
}
