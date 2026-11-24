import * as path from "node:path";
import { acquireFileLock, type FileLock } from "./file-lock.ts";
import { goalStoragePath, ensureGoalStorageDirectory } from "./goal-root.ts";
import type { GoalFileContext } from "./goal-files.ts";

/**
 * Short per-goal lock at `.pi/goals/.locks/<goalId>.lock`. It serializes
 * cross-process mutations of one goal; the optimistic revision check in
 * goal-service.ts still detects stale writers when the hand-off is fast.
 *
 * Acquisition is deliberately tight (8 × 1 ms by default): brief contention
 * succeeds, while a long-held lock fails fast so the caller can defer the
 * write instead of freezing the terminal.
 */
export const GOAL_LOCK_DIR = ".pi/goals/.locks";

export type GoalLock = FileLock;

function safeLockName(goalId: string): string {
	return goalId.replace(/[^A-Za-z0-9._-]/g, "_");
}

export function acquireGoalLock(
	ctx: GoalFileContext,
	goalId: string,
	opts: { attempts?: number; retryMs?: number; staleTtlMs?: number } = {},
): GoalLock {
	const attempts = opts.attempts ?? 8;
	ensureGoalStorageDirectory(ctx, GOAL_LOCK_DIR, false);
	return acquireFileLock(path.join(goalStoragePath(ctx, GOAL_LOCK_DIR), `${safeLockName(goalId)}.lock`), {
		attempts,
		retryMs: opts.retryMs ?? 1,
		staleTtlMs: opts.staleTtlMs ?? 30_000,
		timeoutError: () => new Error(`Timed out acquiring the goal lock for ${goalId} (${attempts} attempts). Another writer may hold it.`),
	});
}
