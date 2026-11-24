/**
 * Persistent pool snapshot (NAF cold start, 2026-08-06).
 *
 * The in-memory pool cache is empty in a fresh process, so a cold pool read
 * used to scan every goal file (2 fs ops per goal). The snapshot keeps the
 * whole pool in ONE file: a cold read is lstat(root) + readFile(snapshot),
 * and every extension write keeps it current (read-modify-write).
 *
 * Freshness: the snapshot records the goals-dir mtime. If the mtime changed
 * (goal files added or removed, including by hand), the caller falls back to
 * a full scan and writes a new snapshot. Editing a goal file in place does
 * not change the dir mtime, so a cold read may serve the last snapshot until
 * the next extension write. That is the same staleness class as the in-memory
 * pool cache; the persist path re-reads the goal file under the lock, so
 * cross-process conflicts are still caught.
 *
 * Every write here is best-effort: a missing or stale snapshot only costs a
 * full scan on the next cold read.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { writeFileAtomic, writeFileAtomicSync } from "./atomic-rename.ts";
import { ensureGoalStorageDirectory, goalPoolSnapshotPath, isExternalGoalStorage } from "./goal-root.ts";
import { isActiveGoalFileName, type GoalFileContext } from "./goal-paths.ts";
import { normalizeRelPath, type GoalRecord } from "../goal-record.ts";

interface PoolSnapshot {
	version: 1;
	dirMtimeMs: number;
	goals: GoalRecord[];
}

/** Before 2026-08-09 the snapshot lived inside the goals dir. */
const LEGACY_NAME = ".goals-pool-snapshot.json";

function legacyPath(root: string): string {
	return path.join(root, LEGACY_NAME);
}

/** Validate snapshot text; null when it is missing, corrupt or an unknown version. */
function parseSnapshot(text: string): PoolSnapshot | null {
	try {
		const data = JSON.parse(text) as Partial<PoolSnapshot>;
		if (data.version === 1 && Array.isArray(data.goals) && typeof data.dirMtimeMs === "number") return data as PoolSnapshot;
	} catch {
		// corrupt: the caller falls back to a full scan
	}
	return null;
}

function readFileOrEmpty(filePath: string): string {
	try { return fs.readFileSync(filePath, "utf8"); } catch { return ""; }
}

async function readFileOrEmptyAsync(filePath: string): Promise<string> {
	try { return await fs.promises.readFile(filePath, "utf8"); } catch { return ""; }
}

/** The current snapshot, falling back to the legacy in-dir file until the next write replaces it. */
export function readPoolSnapshotSync(ctx: GoalFileContext, root: string): PoolSnapshot | null {
	return parseSnapshot(readFileOrEmpty(goalPoolSnapshotPath(ctx))) ?? parseSnapshot(readFileOrEmpty(legacyPath(root)));
}

export async function readPoolSnapshotAsync(ctx: GoalFileContext, root: string): Promise<PoolSnapshot | null> {
	return parseSnapshot(await readFileOrEmptyAsync(goalPoolSnapshotPath(ctx)))
		?? parseSnapshot(await readFileOrEmptyAsync(legacyPath(root)));
}

/** Open goals of a snapshot, keyed by id (complete goals are not in the pool). */
export function poolFromSnapshot(snapshot: PoolSnapshot): Map<string, GoalRecord> {
	const pool = new Map<string, GoalRecord>();
	for (const goal of snapshot.goals) {
		if (goal.status === "complete") continue;
		pool.set(goal.id, goal);
	}
	return pool;
}

/** True when the snapshot's goal file names equal the active_goal files in `names`. */
export function snapshotMatchesNames(names: string[], snapshot: PoolSnapshot): boolean {
	const remaining = new Set(names.filter(isActiveGoalFileName));
	for (const goal of snapshot.goals) {
		const name = path.posix.basename(normalizeRelPath(goal.activePath ?? ""));
		if (isActiveGoalFileName(name) && !remaining.delete(name)) return false;
	}
	return remaining.size === 0;
}

export function snapshotMatchesDirSync(root: string, snapshot: PoolSnapshot): boolean {
	try {
		return snapshotMatchesNames(fs.readdirSync(root), snapshot);
	} catch {
		return false;
	}
}

export async function snapshotMatchesDirAsync(root: string, snapshot: PoolSnapshot): Promise<boolean> {
	try {
		return snapshotMatchesNames(await fs.promises.readdir(root), snapshot);
	} catch {
		return false;
	}
}

/** Make sure the snapshot's directory exists (only needed for an external pool). */
function prepareSnapshotDirectory(ctx: GoalFileContext): void {
	if (isExternalGoalStorage(ctx)) ensureGoalStorageDirectory(ctx, ".pi/goals/.metadata");
}

/** Best-effort removal of the legacy in-dir snapshot after the first write to the new location. */
function removeLegacySnapshot(root: string): void {
	try {
		fs.unlinkSync(legacyPath(root));
	} catch {
		// already absent
	}
}

function writeSnapshotSync(ctx: GoalFileContext, root: string, snapshot: PoolSnapshot): void {
	prepareSnapshotDirectory(ctx);
	writeFileAtomicSync(goalPoolSnapshotPath(ctx), JSON.stringify(snapshot));
	removeLegacySnapshot(root);
}

export function writePoolSnapshotSync(ctx: GoalFileContext, root: string, goals: GoalRecord[]): void {
	try {
		writeSnapshotSync(ctx, root, { version: 1, dirMtimeMs: fs.lstatSync(root).mtimeMs, goals });
	} catch {
		// best-effort
	}
}

export async function writePoolSnapshotAsync(ctx: GoalFileContext, root: string, goals: GoalRecord[]): Promise<void> {
	try {
		const rootStat = await fs.promises.lstat(root);
		prepareSnapshotDirectory(ctx);
		await writeFileAtomic(goalPoolSnapshotPath(ctx), JSON.stringify({ version: 1, dirMtimeMs: rootStat.mtimeMs, goals } satisfies PoolSnapshot));
		removeLegacySnapshot(root);
	} catch {
		// best-effort
	}
}

/** Merge a delta (a written goal or a removal) into the persisted snapshot. */
export function updatePoolSnapshotSync(ctx: GoalFileContext, root: string, mutate: (goals: GoalRecord[]) => GoalRecord[]): void {
	const snapshot = readPoolSnapshotSync(ctx, root);
	if (!snapshot) return; // no snapshot yet: the next cold read scans and writes one
	snapshot.goals = mutate(snapshot.goals);
	try {
		snapshot.dirMtimeMs = fs.lstatSync(root).mtimeMs;
		writeSnapshotSync(ctx, root, snapshot);
	} catch {
		// best-effort
	}
}
