/**
 * Reading and writing goal files, and the caches in front of them.
 *
 * The text format lives in goal-file-format.ts, path rules in goal-paths.ts
 * and the persisted pool snapshot in goal-pool-snapshot.ts. This module owns
 * the disk access and the three in-memory caches (file parses, directory
 * listings and the zero-op pool).
 */
import * as fs from "node:fs";
import { writeFileAtomicSync } from "./atomic-rename.ts";
import { parseGoalFileContent, serializeGoalFile } from "./goal-file-format.ts";
import {
	ARCHIVED_GOALS_DIR,
	GOALS_DIR,
	activePathForGoal,
	archivedPathForGoal,
	isActiveGoalFileName,
	isSafeActivePath,
	resolveGoalPath,
	sanitizeGoalPaths,
	type GoalFileContext,
} from "./goal-paths.ts";
import {
	poolFromSnapshot,
	readPoolSnapshotAsync,
	readPoolSnapshotSync,
	snapshotMatchesDirAsync,
	snapshotMatchesDirSync,
	updatePoolSnapshotSync,
	writePoolSnapshotAsync,
	writePoolSnapshotSync,
} from "./goal-pool-snapshot.ts";
import { ensureGoalStorageDirectory, goalStoragePath, isExternalGoalStorage } from "./goal-root.ts";
import { normalizeRelPath, nowIso, type GoalRecord } from "../goal-record.ts";

// The rest of the code imports these names from here.
export { ARCHIVED_GOALS_DIR, GOALS_DIR, activePathForGoal, archivedPathForGoal, resolveGoalPath, sanitizeGoalPaths, serializeGoalFile };
export type { GoalFileContext };

/**
 * Per-file parse cache, keyed by (absolute path, mtime, size). A steady-state
 * parse costs one lstat instead of lstat + read + JSON parse. Every parse
 * call site shares it and writers drop the entries they touch.
 */
interface GoalFileParseCacheEntry {
	mtimeMs: number;
	size: number;
	parsed: GoalRecord | null;
}

const goalFileParseCache = new Map<string, GoalFileParseCacheEntry>();

/** Directory listing cache (names only): keyed by (absolute path, dir mtime). */
interface GoalDirListingCacheEntry {
	mtimeMs: number;
	names: string[];
}

const goalDirListingCache = new Map<string, GoalDirListingCacheEntry>();

/**
 * Zero-op pool cache (NAF 2026-08-06): the fully scanned active pool per
 * goals dir, served without any stat. Every extension write (atomic write,
 * unlink, archive) drops it, so extension-made changes are always seen.
 * Edits made outside the extension go stale mid-session (see the naf spec).
 * The persist path re-reads the goal file under the lock, so cross-process
 * revision conflicts are still detected.
 */
const goalPoolCache = new Map<string, Map<string, GoalRecord>>();

/** Session boundary (session_start / resume): the next read rescans the pool from disk. */
export function invalidateGoalPoolCache(): void {
	goalPoolCache.clear();
}

function invalidateGoalPathCaches(filePath: string): void {
	goalFileParseCache.delete(filePath);
}

function invalidateGoalDirCache(root: string): void {
	goalDirListingCache.delete(root);
	goalPoolCache.delete(root);
}

export function ensureDirectory(ctx: GoalFileContext, relPath: string): void {
	ensureGoalStorageDirectory(ctx, relPath);
}

/** One metadata read suffices for existence and symlink checks; retain real IO errors. */
function statIfPresent(filePath: string): fs.Stats | undefined {
	try { return fs.lstatSync(filePath); }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

export function atomicWriteGoalFile(ctx: GoalFileContext, rootRel: string, relPath: string, content: string): void {
	ensureDirectory(ctx, rootRel);
	const filePath = resolveGoalPath(ctx, rootRel, relPath);
	// The atomic writer already lstats the target, so it does the symlink check.
	writeFileAtomicSync(filePath, content, { symlinkMessage: `Refusing to write symlinked goal file: ${relPath}` });
	invalidateGoalPathCaches(filePath);
	invalidateGoalDirCache(goalStoragePath(ctx, rootRel));
}

export function safeUnlinkGoalFile(ctx: GoalFileContext, rootRel: string, relPath: string): void {
	const filePath = resolveGoalPath(ctx, rootRel, relPath);
	const stat = statIfPresent(filePath);
	if (stat && !stat.isSymbolicLink()) {
		fs.unlinkSync(filePath);
		invalidateGoalPathCaches(filePath);
		invalidateGoalDirCache(goalStoragePath(ctx, rootRel));
		if (rootRel === GOALS_DIR) {
			const root = goalStoragePath(ctx, GOALS_DIR);
			const normalized = normalizeRelPath(relPath);
			updatePoolSnapshotSync(ctx, root, (goals) => goals.filter((g) => normalizeRelPath(g.activePath ?? "") !== normalized));
		}
	}
}

/**
 * Parse goal-file text and remember the result in the parse cache. Text that
 * is not even a JSON object is not cached; text that is valid but holds no
 * usable goal is cached as null, so it is not re-read until the file changes.
 */
function parseAndCache(filePath: string, mtimeMs: number, size: number, content: string): GoalRecord | null {
	const parsed = parseGoalFileContent(content);
	if (parsed === undefined) return null;
	goalFileParseCache.set(filePath, { mtimeMs, size, parsed });
	return parsed;
}

export function parseGoalFile(filePath: string): GoalRecord | null {
	let stat: fs.Stats;
	try {
		stat = fs.lstatSync(filePath);
	} catch {
		goalFileParseCache.delete(filePath);
		return null;
	}
	if (stat.isSymbolicLink()) return null;
	const cached = goalFileParseCache.get(filePath);
	if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
		return cached.parsed;
	}
	let content: string;
	try {
		content = fs.readFileSync(filePath, "utf8");
	} catch {
		return null;
	}
	return parseAndCache(filePath, stat.mtimeMs, stat.size, content);
}

export function writeActiveGoalFile(ctx: GoalFileContext, current: GoalRecord): GoalRecord {
	const activePath = activePathForGoal(ctx, current);
	const next = sanitizeGoalPaths(ctx, { ...current, activePath, updatedAt: nowIso() });
	atomicWriteGoalFile(ctx, GOALS_DIR, activePath, serializeGoalFile(next));
	// Keep the persisted pool snapshot current (read-modify-write, best-effort).
	updatePoolSnapshotSync(ctx, goalStoragePath(ctx, GOALS_DIR), (goals) => {
		const rest = goals.filter((g) => g.id !== next.id);
		rest.push(next);
		return rest;
	});
	return next;
}

export function archiveGoalFile(ctx: GoalFileContext, current: GoalRecord): GoalRecord {
	const archivedPath = archivedPathForGoal(ctx, current);
	const next = sanitizeGoalPaths(ctx, { ...current, archivedPath, updatedAt: nowIso() });
	delete next.activePath;
	atomicWriteGoalFile(ctx, ARCHIVED_GOALS_DIR, archivedPath, serializeGoalFile(next));
	if (isSafeActivePath(ctx, current.activePath)) {
		try {
			safeUnlinkGoalFile(ctx, GOALS_DIR, current.activePath);
		} catch {}
	}
	return next;
}

export function mergeGoalPromptFromDisk(ctx: GoalFileContext, current: GoalRecord): GoalRecord {
	if (!isSafeActivePath(ctx, current.activePath)) return current;
	// NAF: the zero-op pool cache is the session view of the parsed goal file
	// (dropped on every extension write), so the per-turn merge costs no fs ops.
	// When the cache is empty (cold, or just dropped by a write), fall back to
	// the mtime-keyed direct parse.
	const root = goalStoragePath(ctx, GOALS_DIR);
	const cached = goalPoolCache.get(root)?.get(current.id);
	if (cached) return { ...current, objective: cached.objective };
	try {
		const parsed = parseGoalFile(resolveGoalPath(ctx, GOALS_DIR, current.activePath));
		if (!parsed) return current;
		return { ...current, objective: parsed.objective };
	} catch {
		return current;
	}
}

// ── Pool scan ───────────────────────────────────────────────────────────────

/**
 * Whether a goals dir can be scanned. A symlinked root is refused for an
 * external pool and treated as empty otherwise. Shared by the sync and async scans.
 */
function checkScanRoot(ctx: GoalFileContext, root: string, rootStat: fs.Stats): "scan" | "empty" {
	if (!rootStat.isSymbolicLink()) return "scan";
	if (isExternalGoalStorage(ctx)) throw new Error(`Goal root is a symlink: ${root}`);
	return "empty";
}

function activeGoalNames(names: string[]): string[] {
	return names.filter(isActiveGoalFileName).sort((a, b) => a.localeCompare(b));
}

/** Pool entry for a parsed file: open goals only, with the path pinned to its real location. */
function poolEntry(ctx: GoalFileContext, parsed: GoalRecord | null, relPath: string): GoalRecord | null {
	if (!parsed || parsed.status === "complete") return null;
	return sanitizeGoalPaths(ctx, { ...parsed, activePath: relPath });
}

function poolFromEntries(goals: Iterable<GoalRecord | null>): Map<string, GoalRecord> {
	const pool = new Map<string, GoalRecord>();
	for (const goal of goals) {
		if (goal) pool.set(goal.id, goal);
	}
	return pool;
}

/** Uncached full scan (used when the zero-op pool cache is empty). */
function scanActiveGoalFiles(ctx: GoalFileContext, root: string): Map<string, GoalRecord> {
	let names: string[];
	try {
		const rootStat = fs.lstatSync(root);
		if (checkScanRoot(ctx, root, rootStat) === "empty") return new Map();
		const cachedListing = goalDirListingCache.get(root);
		if (cachedListing && cachedListing.mtimeMs === rootStat.mtimeMs) {
			names = cachedListing.names;
		} else {
			names = activeGoalNames(fs.readdirSync(root));
			goalDirListingCache.set(root, { mtimeMs: rootStat.mtimeMs, names });
		}
	} catch (error) {
		if (isExternalGoalStorage(ctx)) throw error;
		return new Map();
	}
	return poolFromEntries(names.map((name) => {
		const relPath = `${GOALS_DIR}/${name}`;
		if (!isSafeActivePath(ctx, relPath)) return null;
		return poolEntry(ctx, parseGoalFile(resolveGoalPath(ctx, GOALS_DIR, relPath)), relPath);
	}));
}

/**
 * Parallel scan: fs.promises readdir plus per-file stat/read in parallel,
 * seeding the parse cache so later sync reads hit it. Used by session startup.
 */
async function scanActiveGoalFilesAsync(ctx: GoalFileContext, root: string): Promise<Map<string, GoalRecord>> {
	let names: string[];
	try {
		const rootStat = await fs.promises.lstat(root);
		if (checkScanRoot(ctx, root, rootStat) === "empty") return new Map();
		names = activeGoalNames(await fs.promises.readdir(root));
	} catch (error) {
		if (isExternalGoalStorage(ctx)) throw error;
		return new Map();
	}
	return poolFromEntries(await Promise.all(names.map(async (name): Promise<GoalRecord | null> => {
		const relPath = `${GOALS_DIR}/${name}`;
		if (!isSafeActivePath(ctx, relPath)) return null;
		const abs = resolveGoalPath(ctx, GOALS_DIR, relPath);
		try {
			const [stat, content] = await Promise.all([
				fs.promises.lstat(abs),
				fs.promises.readFile(abs, "utf8"),
			]);
			if (stat.isSymbolicLink()) return null;
			return poolEntry(ctx, parseAndCache(abs, stat.mtimeMs, stat.size, content), relPath);
		} catch {
			return null;
		}
	})));
}

/**
 * Cold pool read: serve the persisted snapshot when the goals dir is unchanged
 * (2 ops), or when only non-goal entries changed (ledger churn: one extra
 * readdir to check the active_goal file names are identical, which catches an
 * external add or remove). Otherwise scan every file and write a new snapshot.
 */
function readPoolWithSnapshotSync(ctx: GoalFileContext, root: string): Map<string, GoalRecord> {
	let rootStat: fs.Stats | null = null;
	try {
		rootStat = fs.lstatSync(root);
	} catch {
		rootStat = null;
	}
	if (rootStat && !rootStat.isSymbolicLink()) {
		const snapshot = readPoolSnapshotSync(ctx, root);
		if (snapshot && (snapshot.dirMtimeMs === rootStat.mtimeMs || snapshotMatchesDirSync(root, snapshot))) {
			return poolFromSnapshot(snapshot);
		}
	}
	const pool = scanActiveGoalFiles(ctx, root);
	writePoolSnapshotSync(ctx, root, Array.from(pool.values()));
	return pool;
}

async function readPoolWithSnapshotAsync(ctx: GoalFileContext, root: string): Promise<Map<string, GoalRecord>> {
	let rootStat: fs.Stats | null = null;
	try {
		rootStat = await fs.promises.lstat(root);
	} catch {
		rootStat = null;
	}
	if (rootStat && !rootStat.isSymbolicLink()) {
		const snapshot = await readPoolSnapshotAsync(ctx, root);
		if (snapshot && (snapshot.dirMtimeMs === rootStat.mtimeMs || await snapshotMatchesDirAsync(root, snapshot))) {
			return poolFromSnapshot(snapshot);
		}
	}
	const pool = await scanActiveGoalFilesAsync(ctx, root);
	await writePoolSnapshotAsync(ctx, root, Array.from(pool.values()));
	return pool;
}

export function readActiveGoalPoolView(ctx: GoalFileContext): ReadonlyMap<string, GoalRecord> {
	const root = goalStoragePath(ctx, GOALS_DIR);
	const cached = goalPoolCache.get(root);
	if (cached) return cached;
	const pool = readPoolWithSnapshotSync(ctx, root);
	goalPoolCache.set(root, pool);
	return pool;
}

export function readActiveGoalPool(ctx: GoalFileContext): Map<string, GoalRecord> {
	return new Map(readActiveGoalPoolView(ctx));
}

/**
 * Async pool read for session startup (loadState). Serves the zero-op pool
 * cache when present; a cold read fills it, so the sync reads that follow
 * (reconcile, get_goal, prompts) cost nothing.
 */
export async function readActiveGoalPoolAsync(ctx: GoalFileContext): Promise<Map<string, GoalRecord>> {
	const root = goalStoragePath(ctx, GOALS_DIR);
	const cachedPool = goalPoolCache.get(root);
	if (cachedPool) return new Map(cachedPool);
	const pool = await readPoolWithSnapshotAsync(ctx, root);
	goalPoolCache.set(root, pool);
	return new Map(pool);
}
