import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";

import { createGoal, type GoalRecord } from "../extensions/goal-record.ts";
import {
	invalidateGoalPoolCache,
	parseGoalFile,
	readActiveGoalPool,
	writeActiveGoalFile,
} from "../extensions/storage/goal-files.ts";
import { removeDir, tempDir } from "./support/fs.ts";

const SNAPSHOT_NAME = ".goals-pool-snapshot.json";

function tempCwd(): string {
	return tempDir("goal-pool-snapshot-");
}

function writeGoal(cwd: string, id: string): void {
	writeActiveGoalFile({ cwd }, createGoal({ objective: `objective ${id}`, autoContinue: true, sisyphus: false }, Date.UTC(2026, 8, 5, 9, 0, 0)));
}

function snapshotPaths(cwd: string): { newPath: string; legacyPath: string; goalsDir: string } {
	const goalsDir = path.join(cwd, ".pi", "goals");
	return { newPath: path.join(cwd, ".pi", SNAPSHOT_NAME), legacyPath: path.join(goalsDir, SNAPSHOT_NAME), goalsDir };
}

test("pool snapshot lives outside the watched goals dir and records its mtime", () => {
	const cwd = tempCwd();
	try {
		writeGoal(cwd, "g1");
		// A cold read writes the snapshot; invalidate the in-memory cache so the
		// read goes cold again.
		invalidateGoalPoolCache();
		const pool = readActiveGoalPool({ cwd });
		assert.equal(pool.size, 1);
		assert.ok(fs.existsSync(snapshotPaths(cwd).newPath), "snapshot written outside the goals dir");
		assert.ok(!fs.existsSync(snapshotPaths(cwd).legacyPath), "no legacy in-dir snapshot");

		const snapshot = JSON.parse(fs.readFileSync(snapshotPaths(cwd).newPath, "utf8"));
		const goalsDirStat = fs.lstatSync(snapshotPaths(cwd).goalsDir);
		// The fast path (2-op cold read: lstat + snapshot read, no readdir
		// fallback) holds exactly when the recorded dir mtime matches the live
		// one — and the snapshot's own write no longer perturbs that key.
		assert.equal(snapshot.dirMtimeMs, goalsDirStat.mtimeMs, "dir mtime key matches after the snapshot write");
		assert.equal(snapshot.version, 1);
		assert.equal(snapshot.goals.length, 1);
	} finally {
		removeDir(cwd);
	}
});

test("pool snapshot: a subsequent goal write keeps the fast-path key valid", () => {
	const cwd = tempCwd();
	try {
		writeGoal(cwd, "g1");
		invalidateGoalPoolCache();
		readActiveGoalPool({ cwd }); // cold: full scan + snapshot write

		// Another extension write (updatePoolSnapshotSync path).
		writeGoal(cwd, "g2");
		const snapshot = JSON.parse(fs.readFileSync(snapshotPaths(cwd).newPath, "utf8"));
		const goalsDirStat = fs.lstatSync(snapshotPaths(cwd).goalsDir);
		assert.equal(snapshot.dirMtimeMs, goalsDirStat.mtimeMs, "delta update keeps the mtime key fresh");
		assert.equal(snapshot.goals.length, 2);

		// Cold read after cache invalidation serves the snapshot (2-op path).
		invalidateGoalPoolCache();
		const pool = readActiveGoalPool({ cwd });
		assert.equal(pool.size, 2);
	} finally {
		removeDir(cwd);
	}
});

test("pool snapshot: legacy in-dir snapshot is served as a one-time fallback", () => {
	const cwd = tempCwd();
	try {
		writeGoal(cwd, "g1");
		// Simulate a pre-relocation snapshot: valid content at the legacy path,
		// consistent with the on-disk filename set (the name check must pass)
		// and carrying a marker that only snapshot hydration would preserve.
		const goalsDir = snapshotPaths(cwd).goalsDir;
		const diskFile = fs.readdirSync(goalsDir).find((n) => n.startsWith("active_goal_"))!;
		const diskGoal = parseGoalFile(path.join(goalsDir, diskFile))!;
		const markerGoal = { ...diskGoal, snapshotMarker: true };
		const legacy = {
			version: 1,
			dirMtimeMs: fs.lstatSync(goalsDir).mtimeMs,
			goals: [markerGoal],
		};
		fs.writeFileSync(snapshotPaths(cwd).legacyPath, JSON.stringify(legacy), "utf8");

		invalidateGoalPoolCache();
		const pool = readActiveGoalPool({ cwd });
		assert.equal(pool.size, 1, "legacy snapshot hydrates the pool");
		const served = [...pool.values()][0]!;
		assert.equal((served as GoalRecord & { snapshotMarker?: boolean }).snapshotMarker, true, "served from the legacy snapshot, not a rescan");
	} finally {
		removeDir(cwd);
	}
});

test("pool snapshot: writing removes the legacy in-dir file", () => {
	const cwd = tempCwd();
	try {
		writeGoal(cwd, "g1");
		fs.writeFileSync(snapshotPaths(cwd).legacyPath, "{}", "utf8");
		invalidateGoalPoolCache();
		readActiveGoalPool({ cwd });
		assert.ok(!fs.existsSync(snapshotPaths(cwd).legacyPath), "legacy file cleaned up after the new write");
		assert.ok(fs.existsSync(snapshotPaths(cwd).newPath));
	} finally {
		removeDir(cwd);
	}
});
