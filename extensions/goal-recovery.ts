import { goalStoragePath, goalPoolSnapshotPath, ensureGoalStorageDirectory } from "./storage/goal-root.ts";
import { t, tn } from "./i18n/index.ts";
import { commandPaths, type GoalCommands } from "./goal-controls.ts";
/**
 * /goal-recovery — read-only storage/recovery report + guarded repair.
 *
 * Reliability campaign 2026-08-09. The report scans four failure classes:
 *   - malformed goal files (active_goal_*.md that do not parse);
 *   - malformed ledger lines (counted by the ledger reader);
 *   - stale locks (.pi/goals/.locks/*.lock whose pid is dead or whose age
 *     exceeds the TTL — left behind by crashed sessions);
 *   - orphaned snapshot data (pool-snapshot goals with no matching file).
 *
 * Everything is read-only by default. Repair operations (stale-lock removal,
 * snapshot refresh) require an explicit confirmation AND copy the affected
 * files into a timestamped backup directory first. Malformed goal files and
 * malformed ledger lines are reported but never rewritten automatically —
 * rewriting user-owned data is deliberately out of scope (and automatic
 * ledger rewriting is a documented non-goal of the reliability campaign).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { readGoalLedger } from "./goal-ledger.ts";
import { GOAL_LOCK_DIR, safeLockName } from "./storage/goal-lock.ts";
import { GOALS_DIR } from "./storage/goal-paths.ts";
import { pidAlive } from "./storage/file-lock.ts";
import { invalidateGoalPoolCache, parseGoalFile, readActiveGoalPool, type GoalFileContext } from "./storage/goal-files.ts";

export { GOALS_DIR };
export const RECOVERY_BACKUP_DIR = ".pi/goals/.recovery-backup";

interface MalformedGoalFileEntry {
	relPath: string;
	error: string;
}

interface StaleLockEntry {
	fileName: string;
	pid: number;
	startedAt: string;
	ageMs: number;
}

interface OrphanedSnapshotEntry {
	goalId: string;
	activePath: string;
}

interface RecoveryReport {
	scannedAt: string;
	malformedGoalFiles: MalformedGoalFileEntry[];
	malformedLedgerLines: number;
	staleLocks: StaleLockEntry[];
	orphanedSnapshotGoals: OrphanedSnapshotEntry[];
	healthy: boolean;
}

interface RecoveryRepairResult {
	applied: string[];
	backupDir: string | null;
	confirmed: boolean;
}

const LOCK_STALE_TTL_MS = 30_000;

function goalsDir(ctx: GoalFileContext): string {
	return goalStoragePath(ctx, GOALS_DIR);
}

function locksDir(ctx: GoalFileContext): string {
	return goalStoragePath(ctx, GOAL_LOCK_DIR);
}

/** Scan the goals dir for active_goal files that fail to parse. */
function scanMalformedGoalFiles(ctx: GoalFileContext): MalformedGoalFileEntry[] {
	const root = goalsDir(ctx);
	const out: MalformedGoalFileEntry[] = [];
	let names: string[];
	try {
		names = fs.readdirSync(root);
	} catch {
		return out;
	}
	for (const name of names) {
		if (!/^active_goal_.*\.md$/.test(name)) continue;
		const relPath = path.posix.join(GOALS_DIR, name);
		const parsed = parseGoalFile(path.join(root, name));
		if (!parsed) {
			out.push({ relPath, error: "file does not parse as a goal record" });
		}
	}
	return out;
}

/** Scan the lock dir for lock files whose pid is dead or whose age exceeds the TTL. */
function scanStaleLocks(ctx: GoalFileContext): StaleLockEntry[] {
	const dir = locksDir(ctx);
	const out: StaleLockEntry[] = [];
	let names: string[];
	try {
		names = fs.readdirSync(dir);
	} catch {
		return out;
	}
	const now = Date.now();
	for (const name of names) {
		if (!name.endsWith(".lock")) continue;
		try {
			const raw = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")) as { pid?: unknown; startedAt?: unknown };
			const pid = typeof raw.pid === "number" ? raw.pid : 0;
			const startedAt = typeof raw.startedAt === "string" ? raw.startedAt : "";
			const startedMs = new Date(startedAt).getTime();
			const ageMs = Number.isFinite(startedMs) ? Math.max(0, now - startedMs) : now;
			if (!pidAlive(pid) || ageMs > LOCK_STALE_TTL_MS) {
				out.push({ fileName: name, pid, startedAt, ageMs });
			}
		} catch {
			// Unreadable lock body: report as stale (pid unknown).
			out.push({ fileName: name, pid: 0, startedAt: "", ageMs: now });
		}
	}
	return out;
}

/** Snapshot goals whose active file no longer exists in the goals dir. */
function scanOrphanedSnapshotGoals(ctx: GoalFileContext): OrphanedSnapshotEntry[] {
	const root = goalsDir(ctx);
	const out: OrphanedSnapshotEntry[] = [];
	let present: Set<string>;
	try {
		present = new Set(fs.readdirSync(root));
	} catch {
		return out;
	}
	try {
		const snapshotPath = goalPoolSnapshotPath(ctx);
		const snapshot = JSON.parse(fs.readFileSync(snapshotPath, "utf8")) as { goals?: Array<{ goalId?: unknown; activePath?: unknown }> };
		for (const goal of snapshot.goals ?? []) {
			const activePath = typeof goal.activePath === "string" ? goal.activePath : "";
			const base = path.posix.basename(activePath);
			if (base && !present.has(base)) {
				out.push({ goalId: typeof goal.goalId === "string" ? goal.goalId : base, activePath });
			}
		}
	} catch {
		// Missing/corrupt snapshot: no orphan data to report.
	}
	return out;
}

/** Read-only recovery report. Never mutates goal storage. */
export function runRecoveryReport(ctx: GoalFileContext): RecoveryReport {
	const ledger = readGoalLedger(ctx);
	const malformedGoalFiles = scanMalformedGoalFiles(ctx);
	const staleLocks = scanStaleLocks(ctx);
	const orphanedSnapshotGoals = scanOrphanedSnapshotGoals(ctx);
	return {
		scannedAt: new Date().toISOString(),
		malformedGoalFiles,
		malformedLedgerLines: ledger.malformed,
		staleLocks,
		orphanedSnapshotGoals,
		healthy: malformedGoalFiles.length === 0 && ledger.malformed === 0 && staleLocks.length === 0 && orphanedSnapshotGoals.length === 0,
	};
}

/**
 * Apply the safe repair operations with confirmation + backup.
 *
 * Repairs: stale-lock removal (backed up then unlinked) and pool-snapshot
 * refresh (backed up then rewritten from a fresh scan). Returns what was
 * applied. When `confirm` rejects, nothing is touched.
 */
export async function runRecoveryRepair(
	ctx: GoalFileContext,
	report: RecoveryReport,
	confirm: () => Promise<boolean>,
): Promise<RecoveryRepairResult> {
	if (report.staleLocks.length === 0 && report.orphanedSnapshotGoals.length === 0) {
		return { applied: [], backupDir: null, confirmed: false };
	}
	const confirmed = await confirm();
	if (!confirmed) return { applied: [], backupDir: null, confirmed: false };

	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const backupDir = goalStoragePath(ctx, `${RECOVERY_BACKUP_DIR}/${stamp}`);
	ensureGoalStorageDirectory(ctx, `${RECOVERY_BACKUP_DIR}/${stamp}`);
	const applied: string[] = [];

	for (const lock of report.staleLocks) {
		const source = path.join(locksDir(ctx), lock.fileName);
		try {
			fs.copyFileSync(source, path.join(backupDir, `lock-${safeLockName(lock.fileName)}`));
			fs.unlinkSync(source);
			applied.push(t("removed stale lock {name}", { name: lock.fileName }));
		} catch {
			// best-effort per item
		}
	}

	if (report.orphanedSnapshotGoals.length > 0) {
		const snapshotPath = goalPoolSnapshotPath(ctx);
		try {
			if (fs.existsSync(snapshotPath)) {
				fs.copyFileSync(snapshotPath, path.join(backupDir, "pool-snapshot.json"));
			}
			// Refresh the pool snapshot from a fresh scan (invalidate first so
			// the re-read goes cold and rewrites the snapshot).
			invalidateGoalPoolCache();
			readActiveGoalPool(ctx);
			applied.push(tn(report.orphanedSnapshotGoals.length, { one: "refreshed pool snapshot ({n} orphaned entry dropped)", other: "refreshed pool snapshot ({n} orphaned entries dropped)" }));
		} catch {
			// best-effort
		}
	}

	return { applied, backupDir, confirmed: true };
}

export function formatRecoveryReport(report: RecoveryReport, commands?: GoalCommands): string {
	const lines: string[] = [];
	lines.push(report.healthy ? t("Recovery report: OK — no issues found.") : t("Recovery report: issues found."));
	if (report.malformedGoalFiles.length > 0) {
		lines.push(`  - ${t("{count} malformed goal file(s):", { count: report.malformedGoalFiles.length })}`);
		for (const f of report.malformedGoalFiles) lines.push(`      ${f.relPath} — ${f.error}`);
	}
	if (report.malformedLedgerLines > 0) {
		lines.push(`  - ${t("{count} malformed ledger line(s) (read-only; manual review advised)", { count: report.malformedLedgerLines })}`);
	}
	if (report.staleLocks.length > 0) {
		lines.push(`  - ${t("{count} stale lock(s):", { count: report.staleLocks.length })}`);
		for (const l of report.staleLocks) lines.push(`      ${t("{name} (pid {pid}, {seconds}s old)", { name: l.fileName, pid: l.pid, seconds: Math.round(l.ageMs / 1000) })}`);
	}
	if (report.orphanedSnapshotGoals.length > 0) {
		lines.push(`  - ${tn(report.orphanedSnapshotGoals.length, { one: "{n} orphaned snapshot entry:", other: "{n} orphaned snapshot entries:" })}`);
		for (const o of report.orphanedSnapshotGoals) lines.push(`      ${o.goalId} (${o.activePath})`);
	}
	if (report.staleLocks.length > 0 || report.orphanedSnapshotGoals.length > 0) {
		const route = commandPaths(commands, "goal-recovery")[0];
		lines.push(route ? t("Run `/{route} repair` to remove stale locks and refresh the pool snapshot (confirmation + backup required).", { route })
			: t("Enable a recovery command in /goal-settings controls to repair these files (confirmation + backup required)."));
	}
	return lines.join("\n");
}
