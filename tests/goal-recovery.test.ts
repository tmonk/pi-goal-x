import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";

import { createGoal } from "../extensions/goal-record.ts";
import { readGoalLedger } from "../extensions/goal-ledger.ts";
import { readActiveGoalPool, writeActiveGoalFile, type GoalFileContext } from "../extensions/storage/goal-files.ts";
import {
	runRecoveryReport,
	runRecoveryRepair,
	formatRecoveryReport,
	GOALS_DIR,
	RECOVERY_BACKUP_DIR,
} from "../extensions/goal-recovery.ts";
import { removeDir, tempDir } from "./support/fs.ts";

function tempCtx(): GoalFileContext {
	const cwd = tempDir("goal-recovery-");
	fs.mkdirSync(path.join(cwd, GOALS_DIR, "archived"), { recursive: true });
	fs.mkdirSync(path.join(cwd, GOALS_DIR, ".locks"), { recursive: true });
	return { cwd };
}

function cleanup(ctx: GoalFileContext): void {
	removeDir(ctx.cwd);
}

function writeGoal(ctx: GoalFileContext, objective = "healthy goal"): void {
	writeActiveGoalFile(ctx, createGoal({ objective, autoContinue: true, sisyphus: false }, Date.UTC(2026, 8, 6, 9, 0, 0)));
}

function writeStaleLock(ctx: GoalFileContext, name: string): void {
	fs.writeFileSync(
		path.join(ctx.cwd, GOALS_DIR, ".locks", name),
		JSON.stringify({ pid: 999_999_999, startedAt: new Date(Date.now() - 5 * 60_000).toISOString() }),
		"utf8",
	);
}

test("recovery report: healthy fixture reports no issues", () => {
	const ctx = tempCtx();
	try {
		writeGoal(ctx);
		const report = runRecoveryReport(ctx);
		assert.equal(report.healthy, true);
		assert.deepEqual(report.malformedGoalFiles, []);
		assert.equal(report.malformedLedgerLines, 0);
		assert.deepEqual(report.staleLocks, []);
		assert.deepEqual(report.orphanedSnapshotGoals, []);
		assert.match(formatRecoveryReport(report), /OK — no issues found/);
	} finally {
		cleanup(ctx);
	}
});

test("recovery report: malformed goal file, bad ledger line, stale lock, and orphaned snapshot are all identified", () => {
	const ctx = tempCtx();
	try {
		writeGoal(ctx);
		// Malformed goal file.
		fs.writeFileSync(path.join(ctx.cwd, GOALS_DIR, "active_goal_bad.md"), "this is not a goal file", "utf8");
		// Malformed ledger line.
		fs.appendFileSync(path.join(ctx.cwd, GOALS_DIR, "goal_events.jsonl"), "{{{ not json\n", "utf8");
		// Stale lock (dead pid + old startedAt).
		writeStaleLock(ctx, "g1.lock");
		// Orphaned snapshot entry: a snapshot goal whose file does not exist.
		writeGoal(ctx);
		readActiveGoalPool(ctx); // cold read writes the pool snapshot
		const snapshotPath = path.join(ctx.cwd, ".pi", ".goals-pool-snapshot.json");
		assert.ok(fs.existsSync(snapshotPath), "cold read wrote a snapshot");
		const snapshot = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));
		snapshot.goals.push({ goalId: "gone", activePath: "active_goal_gone.md", latestStatus: "active" });
		fs.writeFileSync(snapshotPath, JSON.stringify(snapshot), "utf8");

		const report = runRecoveryReport(ctx);
		assert.equal(report.healthy, false);
		assert.equal(report.malformedGoalFiles.length, 1);
		assert.match(report.malformedGoalFiles[0]!.relPath, /active_goal_bad\.md$/);
		assert.equal(report.malformedLedgerLines, 1);
		assert.equal(report.staleLocks.length, 1);
		assert.equal(report.staleLocks[0]!.fileName, "g1.lock");
		assert.equal(report.orphanedSnapshotGoals.length, 1);
		assert.equal(report.orphanedSnapshotGoals[0]!.goalId, "gone");
		assert.match(formatRecoveryReport(report), /issues found/);
	} finally {
		cleanup(ctx);
	}
});

test("recovery repair: confirmation rejection touches nothing", async () => {
	const ctx = tempCtx();
	try {
		writeGoal(ctx);
		writeStaleLock(ctx, "g1.lock");
		const report = runRecoveryReport(ctx);
		assert.equal(report.staleLocks.length, 1);

		const result = await runRecoveryRepair(ctx, report, async () => false);
		assert.equal(result.confirmed, false);
		assert.deepEqual(result.applied, []);
		assert.equal(result.backupDir, null);
		assert.ok(fs.existsSync(path.join(ctx.cwd, GOALS_DIR, ".locks", "g1.lock")), "lock untouched");
	} finally {
		cleanup(ctx);
	}
});

test("recovery repair: confirmed repair backs up, removes stale locks, and refreshes the snapshot", async () => {
	const ctx = tempCtx();
	try {
		writeGoal(ctx);
		writeStaleLock(ctx, "g1.lock");
		// Orphaned snapshot entry.
		readActiveGoalPool(ctx); // cold read writes the pool snapshot
		const snapshotPath = path.join(ctx.cwd, ".pi", ".goals-pool-snapshot.json");
		const snapshot = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));
		const orphanCount = snapshot.goals.length;
		snapshot.goals.push({ goalId: "gone", activePath: "active_goal_gone.md", latestStatus: "active" });
		fs.writeFileSync(snapshotPath, JSON.stringify(snapshot), "utf8");

		const report = runRecoveryReport(ctx);
		assert.equal(report.staleLocks.length, 1);
		assert.equal(report.orphanedSnapshotGoals.length, 1);

		const result = await runRecoveryRepair(ctx, report, async () => true);
		assert.equal(result.confirmed, true);
		assert.ok(result.backupDir && result.backupDir.startsWith(path.join(ctx.cwd, RECOVERY_BACKUP_DIR)), "backup dir under .recovery-backup");
		assert.ok(fs.existsSync(path.join(result.backupDir!, "lock-g1.lock")), "stale lock backed up");
		assert.ok(!fs.existsSync(path.join(ctx.cwd, GOALS_DIR, ".locks", "g1.lock")), "stale lock removed");
		assert.ok(fs.existsSync(path.join(result.backupDir!, "pool-snapshot.json")), "snapshot backed up before refresh");
		assert.equal(result.applied.length, 2);

		// The refreshed snapshot no longer contains the orphan.
		const refreshed = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));
		assert.equal(refreshed.goals.length, orphanCount);
		assert.ok(!refreshed.goals.some((g: { goalId?: string }) => g.goalId === "gone"), "orphan dropped from the refreshed snapshot");

		// A follow-up report is healthy for the repaired classes.
		const after = runRecoveryReport(ctx);
		assert.equal(after.staleLocks.length, 0);
		assert.equal(after.orphanedSnapshotGoals.length, 0);
	} finally {
		cleanup(ctx);
	}
});

test("recovery report: never appends ledger events or rewrites goal files", () => {
	const ctx = tempCtx();
	try {
		writeGoal(ctx);
		const ledgerBefore = readGoalLedger({ cwd: ctx.cwd }).events.length;
		runRecoveryReport(ctx);
		runRecoveryReport(ctx);
		assert.equal(readGoalLedger({ cwd: ctx.cwd }).events.length, ledgerBefore, "report is read-only for the ledger");
		assert.equal(fs.readdirSync(path.join(ctx.cwd, GOALS_DIR)).filter((n) => n.startsWith("active_goal_")).length, 1);
	} finally {
		cleanup(ctx);
	}
});
