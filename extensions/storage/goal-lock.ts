/**
 * Short per-goal filesystem lock (follow-up Stage 4).
 *
 * An exclusive lock is acquired through atomic creation of a lock file under
 * `.pi/goals/.locks/<goalId>.lock` carrying { pid, startedAt } metadata.
 * Acquisition is bounded: on contention the caller waits briefly and retries,
 * and stale locks (older than the TTL, or whose pid is no longer alive) are
 * recovered by removal. The lock serializes cross-process mutations of the
 * same goal; the optimistic revision check (goal-service.ts) detects stale
 * writers even when the lock hand-off is fast.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { GoalFileContext } from "./goal-files.ts";

export const GOAL_LOCK_DIR = ".pi/goals/.locks";

export interface GoalLock {
	release(): void;
}

const DEFAULT_ACQUIRE_ATTEMPTS = 100;
const DEFAULT_RETRY_MS = 25;
const DEFAULT_STALE_TTL_MS = 30_000;

function safeLockName(goalId: string): string {
	return goalId.replace(/[^A-Za-z0-9._-]/g, "_");
}

function pidAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

function readLockPayload(lockPath: string): { pid?: number; startedAt?: string } {
	try {
		const raw = JSON.parse(fs.readFileSync(lockPath, "utf8")) as Record<string, unknown>;
		return {
			pid: typeof raw.pid === "number" ? raw.pid : undefined,
			startedAt: typeof raw.startedAt === "string" ? raw.startedAt : undefined,
		};
	} catch {
		// Unparseable payload means a writer crashed mid-create: treat as stale.
		return {};
	}
}

function sleepMs(ms: number): void {
	// Synchronous bounded wait (Atomics.wait is legal on the main thread and
	// does not burn CPU like a spin loop).
	const buffer = new Int32Array(new SharedArrayBuffer(4));
	Atomics.wait(buffer, 0, 0, ms);
}

/**
 * Acquire the exclusive per-goal lock. Throws after the bounded attempt window
 * if a live writer never releases it. The caller MUST release() the returned
 * lock (use a finally block).
 */
export function acquireGoalLock(
	ctx: GoalFileContext,
	goalId: string,
	opts: { attempts?: number; retryMs?: number; staleTtlMs?: number } = {},
): GoalLock {
	const attempts = opts.attempts ?? DEFAULT_ACQUIRE_ATTEMPTS;
	const retryMs = opts.retryMs ?? DEFAULT_RETRY_MS;
	const ttlMs = opts.staleTtlMs ?? DEFAULT_STALE_TTL_MS;
	const lockDir = path.resolve(ctx.cwd, GOAL_LOCK_DIR);
	const lockPath = path.join(lockDir, `${safeLockName(goalId)}.lock`);
	fs.mkdirSync(lockDir, { recursive: true });
	const payload = JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() });

	for (let attempt = 0; attempt < attempts; attempt++) {
		try {
			fs.writeFileSync(lockPath, payload, { flag: "wx" });
			let released = false;
			return {
				release(): void {
					if (released) return;
					released = true;
					try {
						fs.unlinkSync(lockPath);
					} catch {
						// Lock already gone (stale recovery elsewhere); nothing to do.
					}
				},
			};
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
			// Bounded stale-lock recovery.
			try {
				const stat = fs.statSync(lockPath);
				const payloadInfo = readLockPayload(lockPath);
				const pid = payloadInfo.pid;
				const stale = Date.now() - stat.mtimeMs > ttlMs || (pid !== undefined && !pidAlive(pid));
				if (stale) {
					try {
						fs.unlinkSync(lockPath);
					} catch {
						// Someone else recovered it first; retry acquisition.
					}
					continue;
				}
			} catch {
				// Lock vanished between stat and read (holder released): retry.
				continue;
			}
			sleepMs(retryMs);
		}
	}
	throw new Error(`Timed out acquiring the goal lock for ${goalId} (${attempts} attempts). Another writer may hold it.`);
}
