import { goalStoragePath, goalPoolSnapshotPath, isExternalGoalStorage, ensureGoalStorageDirectory, type GoalStorageContext } from "./goal-root.ts";
import * as fs from "node:fs";
import * as path from "node:path";
import { writeFileAtomic, writeFileAtomicSync } from "./atomic-rename.ts";

import {
	formatDuration,
	formatTokenValue,
	statusLabel,
} from "../goal-display.ts";
import {
	cloneGoal,
	normalizeGoalRecord,
	normalizeRelPath,
	nowIso,
	safeIdPart,
	type GoalRecord,
	type TaskStatus,
} from "../goal-record.ts";

export const GOALS_DIR = ".pi/goals";
export const ARCHIVED_GOALS_DIR = ".pi/goals/archived";

/**
 * Per-file parse cache (P1-1): keyed by (absolute path, mtime, size), so
 * steady-state parses of goal files cost one lstat instead of lstat+read+
 * JSON-parse. Every parse call site (pool scan, reconcile, merge-from-disk)
 * shares this cache; writers invalidate the entries they touch.
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
 * Zero-op pool cache (NAF 2026-08-06): the fully-scanned active pool per
 * goals dir, served without any stat. Every extension write (atomic write /
 * unlink / archive) invalidates it, so extension-mediated changes are always
 * observed; external (non-extension) file edits go stale mid-session
 * (documented in the naf spec PRODUCT.md). The safety-critical persist path
 * re-reads the goal file directly (parseGoalFile, mtime-keyed) under the
 * lock, so cross-process revision conflicts are still detected.
 */
const goalPoolCache = new Map<string, Map<string, GoalRecord>>();

/**
 * Session boundary (session_start / resume): drop the zero-op pool cache so
 * a new session rescans the goal pool fresh from disk.
 */
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

// ── Persistent pool snapshot (NAF cold-start, 2026-08-06) ───────────────────
// The zero-op pool cache is in-memory; a fresh process (new session) has no
// cache, so a cold pool read re-scanned every goal file (2 fs ops per goal).
// The snapshot persists the pool as ONE file, so a cold read is
// lstat(root) + readFile(snapshot) = 2 ops total, and every extension write
// keeps it current (read-modify-write, +4 ops per mutation — mutations are
// write-floor-exempt in the bench).
//
// Freshness: the snapshot records the goals-dir mtime; if the dir mtime
// changed (goal files added/removed — including external edits), the
// snapshot is invalidated and a full scan re-syncs it. In-place content
// edits to a goal file do NOT change the dir mtime, so a cold read may serve
// the last extension-written snapshot until the next extension write or
// mtime-changing change — the same staleness class as the in-memory pool
// cache's documented mid-session behavior (external hand-edits go stale;
// the safety-critical persist path still re-reads the goal file directly
// via parseGoalFile, mtime-keyed, so cross-process conflicts are detected).
interface PoolSnapshot {
	version: 1;
	dirMtimeMs: number;
	goals: GoalRecord[];
}

const POOL_SNAPSHOT_LEGACY_NAME = ".goals-pool-snapshot.json";

function poolSnapshotLegacyPath(root: string): string {
	return path.join(root, POOL_SNAPSHOT_LEGACY_NAME);
}

/** Read + validate the snapshot; null when missing/corrupt/unsupported. */
function readPoolSnapshotSync(ctx: GoalFileContext, root: string): PoolSnapshot | null {
	const parsed = tryParsePoolSnapshotSync(goalPoolSnapshotPath(ctx));
	if (parsed) return parsed;
	// One-time migration fallback: a snapshot written before 2026-08-09 lives
	// inside the goals dir; keep serving it until the next write replaces it.
	return tryParsePoolSnapshotSync(poolSnapshotLegacyPath(root));
}

function tryParsePoolSnapshotSync(filePath: string): PoolSnapshot | null {
	try {
		const data = JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<PoolSnapshot>;
		if (data.version === 1 && Array.isArray(data.goals) && typeof data.dirMtimeMs === "number") {
			return data as PoolSnapshot;
		}
	} catch {
		// missing or corrupt — caller falls back to a full scan
	}
	return null;
}

async function readPoolSnapshotAsync(ctx: GoalFileContext, root: string): Promise<PoolSnapshot | null> {
	const parsed = await tryParsePoolSnapshotAsync(goalPoolSnapshotPath(ctx));
	if (parsed) return parsed;
	return tryParsePoolSnapshotAsync(poolSnapshotLegacyPath(root));
}

async function tryParsePoolSnapshotAsync(filePath: string): Promise<PoolSnapshot | null> {
	try {
		const data = JSON.parse(await fs.promises.readFile(filePath, "utf8")) as Partial<PoolSnapshot>;
		if (data.version === 1 && Array.isArray(data.goals) && typeof data.dirMtimeMs === "number") {
			return data as PoolSnapshot;
		}
	} catch {
		return null;
	}
	return null;
}

function hydratePoolFromSnapshot(snapshot: PoolSnapshot): Map<string, GoalRecord> {
	const pool = new Map<string, GoalRecord>();
	for (const goal of snapshot.goals) {
		if (goal.status === "complete") continue; // matches scanActiveGoalFiles
		pool.set(goal.id, goal);
	}
	return pool;
}

/** Best-effort atomic snapshot write (temp + rename). */
function writePoolSnapshotSync(ctx: GoalFileContext, root: string, goals: GoalRecord[]): void {
	try {
		const rootStat = fs.lstatSync(root);
		const snapshot: PoolSnapshot = { version: 1, dirMtimeMs: rootStat.mtimeMs, goals };
		if (isExternalGoalStorage(ctx)) ensureGoalStorageDirectory(ctx, ".pi/goals/.metadata");
		const target = goalPoolSnapshotPath(ctx);
		writeFileAtomicSync(target, JSON.stringify(snapshot));
		removeLegacyPoolSnapshot(root);
	} catch {
		// best-effort: a missing/stale snapshot just costs a full scan next cold read
	}
}

async function writePoolSnapshotAsync(ctx: GoalFileContext, root: string, goals: GoalRecord[]): Promise<void> {
	try {
		const rootStat = await fs.promises.lstat(root);
		const snapshot: PoolSnapshot = { version: 1, dirMtimeMs: rootStat.mtimeMs, goals };
		if (isExternalGoalStorage(ctx)) ensureGoalStorageDirectory(ctx, ".pi/goals/.metadata");
		const target = goalPoolSnapshotPath(ctx);
		await writeFileAtomic(target, JSON.stringify(snapshot));
		removeLegacyPoolSnapshot(root);
	} catch {
		// best-effort
	}
}

/** Merge a delta (written goal or removal) into the persisted snapshot. */
function updatePoolSnapshotSync(ctx: GoalFileContext, root: string, mutate: (goals: GoalRecord[]) => GoalRecord[]): void {
	const snapshot = readPoolSnapshotSync(ctx, root);
	if (!snapshot) return; // no snapshot yet — next cold read does a full scan + write
	snapshot.goals = mutate(snapshot.goals);
	try {
		const rootStat = fs.lstatSync(root);
		snapshot.dirMtimeMs = rootStat.mtimeMs;
		if (isExternalGoalStorage(ctx)) ensureGoalStorageDirectory(ctx, ".pi/goals/.metadata");
		const target = goalPoolSnapshotPath(ctx);
		writeFileAtomicSync(target, JSON.stringify(snapshot));
		removeLegacyPoolSnapshot(root);
	} catch {
		// best-effort
	}
}

/** Best-effort removal of the legacy in-dir snapshot after the first new-location write. */
function removeLegacyPoolSnapshot(root: string): void {
	try {
		fs.unlinkSync(poolSnapshotLegacyPath(root));
	} catch {
		// already absent
	}
}

export type GoalFileContext = GoalStorageContext;

export function timestampForFile(iso = nowIso()): string {
	const date = new Date(iso);
	const safe = Number.isFinite(date.getTime()) ? date : new Date();
	const pad = (value: number, width = 2) => String(value).padStart(width, "0");
	return [
		safe.getFullYear(),
		pad(safe.getMonth() + 1),
		pad(safe.getDate()),
		pad(safe.getHours()),
		pad(safe.getMinutes()),
		pad(safe.getSeconds()),
		pad(Math.floor(safe.getMilliseconds() / 10)),
	].join("");
}

export function isSafeRelativeUnder(ctx: GoalFileContext, rootRel: string, relPath: string | undefined): relPath is string {
	if (!relPath || path.isAbsolute(relPath) || relPath.includes("\0")) return false;
	const normalized = normalizeRelPath(relPath);
	const parent = normalizeRelPath(path.posix.dirname(normalized));
	if (parent !== normalizeRelPath(rootRel)) return false;
	const root = goalStoragePath(ctx, rootRel);
	const absolutePath = goalStoragePath(ctx, normalized);
	const relative = path.relative(root, absolutePath);
	return !relative.startsWith("..") && !path.isAbsolute(relative);
}

export function isSafeActivePath(ctx: GoalFileContext, relPath: string | undefined): relPath is string {
	return Boolean(
		isSafeRelativeUnder(ctx, GOALS_DIR, relPath)
			&& /^active_goal_.*\.md$/.test(path.posix.basename(normalizeRelPath(relPath))),
	);
}

export function isSafeArchivedPath(ctx: GoalFileContext, relPath: string | undefined): relPath is string {
	return Boolean(
		isSafeRelativeUnder(ctx, ARCHIVED_GOALS_DIR, relPath)
			&& /^goal_.*\.md$/.test(path.posix.basename(normalizeRelPath(relPath))),
	);
}

export function sanitizeGoalPaths(ctx: GoalFileContext, goal: GoalRecord): GoalRecord {
	const next = cloneGoal(goal);
	if (!isSafeActivePath(ctx, next.activePath)) delete next.activePath;
	if (!isSafeArchivedPath(ctx, next.archivedPath)) delete next.archivedPath;
	return next;
}

export function ensureDirectory(ctx: GoalFileContext, relPath: string): void {
	ensureGoalStorageDirectory(ctx, relPath);
}

export function resolveGoalPath(ctx: GoalFileContext, rootRel: string, relPath: string): string {
	const root = goalStoragePath(ctx, rootRel);
	const absolutePath = goalStoragePath(ctx, normalizeRelPath(relPath));
	const relative = path.relative(root, absolutePath);
	if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`Goal path escapes ${rootRel}: ${relPath}`);
	return absolutePath;
}

export function atomicWriteGoalFile(ctx: GoalFileContext, rootRel: string, relPath: string, content: string): void {
	ensureDirectory(ctx, rootRel);
	const filePath = resolveGoalPath(ctx, rootRel, relPath);
	if (statIfPresent(filePath)?.isSymbolicLink()) throw new Error(`Refusing to write symlinked goal file: ${relPath}`);
	writeFileAtomicSync(filePath, content);
	invalidateGoalPathCaches(filePath);
	invalidateGoalDirCache(goalStoragePath(ctx, rootRel));
}

/** One metadata read suffices for existence and symlink checks; retain real IO errors. */
function statIfPresent(filePath: string): fs.Stats | undefined {
	try { return fs.lstatSync(filePath); }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
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

export function makeActiveGoalPath(goal: GoalRecord): string {
	return `${GOALS_DIR}/active_goal_${timestampForFile(goal.createdAt)}_${safeIdPart(goal.id)}.md`;
}

export function makeArchivedGoalPath(goal: GoalRecord): string {
	return `${ARCHIVED_GOALS_DIR}/goal_${timestampForFile(goal.updatedAt)}_${safeIdPart(goal.id)}.md`;
}

export function activePathForGoal(ctx: GoalFileContext, goal: GoalRecord): string {
	return isSafeActivePath(ctx, goal.activePath) ? goal.activePath : makeActiveGoalPath(goal);
}

export function archivedPathForGoal(ctx: GoalFileContext, goal: GoalRecord): string {
	return isSafeArchivedPath(ctx, goal.archivedPath) ? goal.archivedPath : makeArchivedGoalPath(goal);
}

function taskCheckbox(status: TaskStatus): string {
	if (status === "complete") return "x";
	if (status === "skipped") return "~";
	return " ";
}

function taskLineSuffix(task: { status: TaskStatus; evidence?: string; skipReason?: string; verificationContract?: string }): string {
	const parts: string[] = [];
	if (task.status === "complete" && task.evidence) parts.push(`evidence: ${task.evidence}`);
	if (task.status === "skipped" && task.skipReason) parts.push(`skipped: ${task.skipReason}`);
	if ((task.status === "pending") && task.verificationContract) parts.push(`contract: ${task.verificationContract}`);
	return parts.length > 0 ? ` — ${parts.join("; ")}` : "";
}

export function serializeGoalFile(goal: GoalRecord): string {
	const meta = JSON.stringify({ version: 3, ...goal }, null, 2);
	const pauseLines: string[] = [];
	if (goal.pauseReason) pauseLines.push(`- Agent pause reason: ${goal.pauseReason}`);
	if (goal.pauseSuggestedAction) pauseLines.push(`- Agent suggests: ${goal.pauseSuggestedAction}`);
	const pauseBlock = pauseLines.length > 0 ? `\n${pauseLines.join("\n")}` : "";
	let taskSection = "";
	if (goal.taskList) {
		const taskLines = goal.taskList.tasks.map((t) => {
			return `- [${taskCheckbox(t.status)}] ${t.id}: ${t.title}${taskLineSuffix(t)}`;
		});
		taskSection = `\n## Tasks

<!-- blockCompletion: ${goal.taskList.blockCompletion} -->\n${taskLines.join("\n")}\n`;
	}
	const contractLine = goal.verificationContract?.trim() ? `
- Verification contract: ${goal.verificationContract.trim()}` : "";
	return `${meta}

# Goal Prompt

${goal.objective.trim()}

## Progress

- Status: ${statusLabel(goal)}
- Auto-continue: ${goal.autoContinue ? "on" : "off"}
- Sisyphus mode: ${goal.sisyphus ? "yes (prompt/criteria style)" : "no"}
- Time spent: ${formatDuration(goal.usage.activeSeconds)}
- Tokens used: ${formatTokenValue(goal.usage.tokensUsed)}${contractLine}${taskSection}${pauseBlock}
`;
}

export function findJsonObjectEnd(content: string): number {
	let depth = 0;
	let inString = false;
	let escaped = false;

	for (let i = 0; i < content.length; i++) {
		const char = content[i];
		if (inString) {
			if (escaped) {
				escaped = false;
			} else if (char === "\\") {
				escaped = true;
			} else if (char === "\"") {
				inString = false;
			}
			continue;
		}
		if (char === "\"") {
			inString = true;
			continue;
		}
		if (char === "{") {
			depth++;
			continue;
		}
		if (char === "}") {
			depth--;
			if (depth === 0) return i;
		}
	}
	return -1;
}

export function extractObjectiveFromBody(body: string): string | undefined {
	const lines = body.replace(/^\s+/, "").split(/\r?\n/);
	const start = lines.findIndex((line) => line.trim() === "# Goal Prompt");
	if (start < 0) return body.trim() || undefined;
	let end = lines.length;
	for (let i = start + 1; i < lines.length; i++) {
		if (lines[i]?.trim() === "## Progress") {
			end = i;
			break;
		}
	}
	return lines.slice(start + 1, end).join("\n").trim() || undefined;
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
	return parseGoalContentCached(filePath, stat.mtimeMs, stat.size, content);
}

/**
 * Parse goal-file content and seed the P1-1 parse cache (shared by the sync
 * and the parallel async readers). Returns null for malformed content.
 */
export function parseGoalContentCached(filePath: string, mtimeMs: number, size: number, content: string): GoalRecord | null {
	const end = findJsonObjectEnd(content);
	if (end < 0) return null;
	let raw: Record<string, unknown>;
	try {
		raw = JSON.parse(content.slice(0, end + 1)) as Record<string, unknown>;
	} catch {
		return null;
	}
	const objective = extractObjectiveFromBody(content.slice(end + 1)) ?? raw.objective;
	const parsed = normalizeGoalRecord({ ...raw, objective });
	goalFileParseCache.set(filePath, { mtimeMs, size, parsed });
	return parsed;
}

export function writeActiveGoalFile(ctx: GoalFileContext, current: GoalRecord): GoalRecord {
	const activePath = activePathForGoal(ctx, current);
	const next = sanitizeGoalPaths(ctx, { ...current, activePath, updatedAt: nowIso() });
	atomicWriteGoalFile(ctx, GOALS_DIR, activePath, serializeGoalFile(next));
	// Keep the persistent pool snapshot current (read-modify-write, best-effort).
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
	// (invalidated on every extension write) — source the objective from it so
	// the per-turn merge is 0 fs ops. When the cache is empty (cold or just
	// invalidated by a write), fall back to the mtime-keyed direct parse.
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

/** Uncached full scan (used when the zero-op pool cache is empty). */
function scanActiveGoalFiles(ctx: GoalFileContext, root: string): GoalRecord[] {
	let entries: string[];
	try {
		const rootStat = fs.lstatSync(root);
		if (rootStat.isSymbolicLink()) { if (isExternalGoalStorage(ctx)) throw new Error(`Goal root is a symlink: ${root}`); return []; }
		const cachedListing = goalDirListingCache.get(root);
		if (cachedListing && cachedListing.mtimeMs === rootStat.mtimeMs) {
			entries = cachedListing.names;
		} else {
			entries = fs.readdirSync(root)
				.filter((name) => /^active_goal_.*\.md$/.test(name))
				.sort((a, b) => a.localeCompare(b));
			goalDirListingCache.set(root, { mtimeMs: rootStat.mtimeMs, names: entries });
		}
	} catch (error) {
		if (isExternalGoalStorage(ctx)) throw error;
		return [];
	}
	return entries
		.map((name) => {
			const relPath = `${GOALS_DIR}/${name}`;
			if (!isSafeActivePath(ctx, relPath)) return null;
			const parsed = parseGoalFile(resolveGoalPath(ctx, GOALS_DIR, relPath));
			if (!parsed || parsed.status === "complete") return null;
			return sanitizeGoalPaths(ctx, { ...parsed, activePath: relPath });
		})
		.filter((goal): goal is GoalRecord => goal !== null);
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

/** Cold pool read: serve the persisted snapshot when the goals dir is unchanged (2 ops),
 * or when only non-goal entries changed (ledger churn: one extra readdir to verify the
 * active_goal filename set is identical — catches external add/remove). Otherwise full
 * scan + re-snapshot (external goal add/remove or no snapshot yet). */
function readPoolWithSnapshotSync(ctx: GoalFileContext, root: string): Map<string, GoalRecord> {
	let rootStat: fs.Stats | null = null;
	try {
		rootStat = fs.lstatSync(root);
	} catch {
		rootStat = null;
	}
	if (rootStat && !rootStat.isSymbolicLink()) {
		const snapshot = readPoolSnapshotSync(ctx, root);
		if (snapshot) {
			if (snapshot.dirMtimeMs === rootStat.mtimeMs || activeGoalNamesMatchSync(root, snapshot)) {
				return hydratePoolFromSnapshot(snapshot);
			}
		}
	}
	const pool = new Map<string, GoalRecord>();
	for (const goal of scanActiveGoalFiles(ctx, root)) {
		pool.set(goal.id, goal);
	}
	writePoolSnapshotSync(ctx, root, Array.from(pool.values()));
	return pool;
}

/** True when the snapshot's goal filename set equals the goals dir's active_goal files. */
function activeGoalNamesMatchSync(root: string, snapshot: PoolSnapshot): boolean {
	try {
		return activeGoalNamesMatch(fs.readdirSync(root), snapshot);
	} catch {
		return false;
	}
}

async function activeGoalNamesMatchAsync(root: string, snapshot: PoolSnapshot): Promise<boolean> {
	try {
		return activeGoalNamesMatch(await fs.promises.readdir(root), snapshot);
	} catch {
		return false;
	}
}

function activeGoalNamesMatch(names: string[], snapshot: PoolSnapshot): boolean {
	const remaining = new Set(names.filter(name => /^active_goal_.*\.md$/.test(name)));
	for (const goal of snapshot.goals) {
		const name = path.posix.basename(normalizeRelPath(goal.activePath ?? ""));
		if (/^active_goal_.*\.md$/.test(name) && !remaining.delete(name)) return false;
	}
	return remaining.size === 0;
}

/**
 * Parallel pool read (P1-7): fs.promises-based readdir + per-file stat/read
 * in parallel, seeding the P1-1 parse cache so subsequent sync reads hit it.
 * Used by session startup rehydration (loadState). NAF: serves the zero-op
 * pool cache when present; a cold read populates it so subsequent sync reads
 * (reconcile, get_goal, prompts) are zero-op.
 */
export async function readActiveGoalPoolAsync(ctx: GoalFileContext): Promise<Map<string, GoalRecord>> {
	const root = goalStoragePath(ctx, GOALS_DIR);
	const cachedPool = goalPoolCache.get(root);
	if (cachedPool) return new Map(cachedPool);
	const pool = await readPoolWithSnapshotAsync(ctx, root);
	goalPoolCache.set(root, pool);
	return new Map(pool);
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
		if (snapshot) {
			if (snapshot.dirMtimeMs === rootStat.mtimeMs || (await activeGoalNamesMatchAsync(root, snapshot))) {
				return hydratePoolFromSnapshot(snapshot);
			}
		}
	}
	const pool = await scanActiveGoalFilesAsync(ctx, root);
	await writePoolSnapshotAsync(ctx, root, Array.from(pool.values()));
	return pool;
}

async function scanActiveGoalFilesAsync(ctx: GoalFileContext, root: string): Promise<Map<string, GoalRecord>> {
	let names: string[];
	try {
		const rootStat = await fs.promises.lstat(root);
		if (rootStat.isSymbolicLink()) { if (isExternalGoalStorage(ctx)) throw new Error(`Goal root is a symlink: ${root}`); return new Map(); }
		names = (await fs.promises.readdir(root))
			.filter((name) => /^active_goal_.*\.md$/.test(name))
			.sort((a, b) => a.localeCompare(b));
	} catch (error) {
		if (isExternalGoalStorage(ctx)) throw error;
		return new Map();
	}
	const parsed = await Promise.all(names.map(async (name): Promise<GoalRecord | null> => {
		const relPath = `${GOALS_DIR}/${name}`;
		if (!isSafeActivePath(ctx, relPath)) return null;
		const abs = resolveGoalPath(ctx, GOALS_DIR, relPath);
		try {
			const [stat, content] = await Promise.all([
				fs.promises.lstat(abs),
				fs.promises.readFile(abs, "utf8"),
			]);
			if (stat.isSymbolicLink()) return null;
			const parsed = parseGoalContentCached(abs, stat.mtimeMs, stat.size, content);
			if (!parsed || parsed.status === "complete") return null;
			return sanitizeGoalPaths(ctx, { ...parsed, activePath: relPath });
		} catch {
			return null;
		}
	}));
	const pool = new Map<string, GoalRecord>();
	for (const goal of parsed) {
		if (goal) pool.set(goal.id, goal);
	}
	return pool;
}
