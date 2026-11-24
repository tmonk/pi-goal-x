/**
 * Exclusive cross-process file lock shared by goal records and settings files.
 *
 * Acquisition atomically creates `lockPath` holding `{ pid, startedAt }`. On
 * contention it retries a bounded number of times with a short synchronous
 * sleep, and removes stale locks (older than the TTL, or held by a dead pid).
 */

import * as fs from "node:fs";
import * as path from "node:path";

export interface FileLock {
	release(): void;
}

export interface FileLockOptions {
	attempts: number;
	retryMs: number;
	staleTtlMs: number;
	/** Error thrown once every attempt has failed. */
	timeoutError: () => Error;
}

let sleeper: Int32Array | undefined;

/** Synchronous bounded wait; Atomics.wait does not spin the CPU. */
export function sleepSync(ms: number): void {
	sleeper ??= new Int32Array(new SharedArrayBuffer(4));
	Atomics.wait(sleeper, 0, 0, ms);
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

function lockHolderPid(lockPath: string): number | undefined {
	try {
		const pid = (JSON.parse(fs.readFileSync(lockPath, "utf8")) as Record<string, unknown>).pid;
		return typeof pid === "number" ? pid : undefined;
	} catch {
		// An unparseable payload means a writer crashed mid-create: only the TTL applies.
		return undefined;
	}
}

/** Acquire the lock or throw `timeoutError()`. Callers MUST release() in a finally block. */
export function acquireFileLock(lockPath: string, options: FileLockOptions): FileLock {
	fs.mkdirSync(path.dirname(lockPath), { recursive: true });
	const payload = JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() });
	for (let attempt = 0; attempt < options.attempts; attempt++) {
		try {
			fs.writeFileSync(lockPath, payload, { flag: "wx" });
			let released = false;
			return {
				release(): void {
					if (released) return;
					released = true;
					try { fs.unlinkSync(lockPath); } catch { /* already removed by stale recovery */ }
				},
			};
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
		}
		let stale: boolean;
		try {
			const pid = lockHolderPid(lockPath);
			stale = Date.now() - fs.statSync(lockPath).mtimeMs > options.staleTtlMs || (pid !== undefined && !pidAlive(pid));
		} catch {
			// The holder released between EEXIST and stat: retry at once.
			continue;
		}
		if (stale) {
			try { fs.unlinkSync(lockPath); } catch { /* another process recovered it first */ }
			continue;
		}
		sleepSync(options.retryMs);
	}
	throw options.timeoutError();
}
