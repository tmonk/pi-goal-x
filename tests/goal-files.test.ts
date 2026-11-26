import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createGoal, type GoalTaskList } from "../extensions/goal-record.ts";
import {
	activePathForGoal,
	archiveGoalFile,
	archivedPathForGoal,
	invalidateGoalPoolCache,
	parseGoalFile,
	readActiveGoalPool,
	refreshActiveGoalPool,
	serializeGoalFile,
	writeActiveGoalFile,
} from "../extensions/storage/goal-files.ts";

function tempCtx(): { cwd: string } {
	return { cwd: mkdtempSync(path.join(tmpdir(), "pi-goal-files-")) };
}

function cleanup(ctx: { cwd: string }): void {
	rmSync(ctx.cwd, { recursive: true, force: true });
}

test("serializeGoalFile and parseGoalFile round-trip metadata while allowing prompt body edits", () => {
	const ctx = tempCtx();
	try {
		const goal = createGoal({
			objective: "=== Goal ===\nObjective: original",
			autoContinue: true,
			sisyphus: false,
		}, Date.UTC(2026, 0, 2, 3, 4, 5));
		const filePath = path.join(ctx.cwd, "goal.md");
		const edited = serializeGoalFile(goal).replace(
			"=== Goal ===\nObjective: original\n\n## Progress",
			"=== Goal ===\nObjective: edited on disk\n\n## Progress",
		);
		writeFileSync(filePath, edited, "utf8");

		const parsed = parseGoalFile(filePath);
		assert.ok(parsed);
		assert.equal(parsed.id, goal.id);
		assert.equal(parsed.objective, "=== Goal ===\nObjective: edited on disk");
		assert.equal(parsed.status, "active");
	} finally {
		cleanup(ctx);
	}
});

test("goal file paths stay under active and archive roots even with unsafe metadata", () => {
	const ctx = tempCtx();
	try {
		const goal = createGoal({
			objective: "Persist safely",
			autoContinue: true,
			sisyphus: true,
		}, Date.UTC(2026, 0, 2, 3, 4, 5));
		const unsafe = { ...goal, activePath: "../escape.md", archivedPath: ".pi/goals/not-archive.md" };

		assert.match(activePathForGoal(ctx, unsafe), /^\.pi\/goals\/active_goal_/);
		assert.match(archivedPathForGoal(ctx, unsafe), /^\.pi\/goals\/archived\/goal_/);

		const active = writeActiveGoalFile(ctx, unsafe);
		assert.match(active.activePath ?? "", /^\.pi\/goals\/active_goal_/);
		const activeFile = path.join(ctx.cwd, active.activePath ?? "missing");
		assert.match(readFileSync(activeFile, "utf8"), /# Goal Prompt/);
		assert.equal(pathExists(path.join(ctx.cwd, "..", "escape.md")), false);

		const archived = archiveGoalFile(ctx, active);
		assert.equal(archived.activePath, undefined);
		assert.match(archived.archivedPath ?? "", /^\.pi\/goals\/archived\/goal_/);
	} finally {
		cleanup(ctx);
	}
});

test("the active goal pool scans deterministic safe active goal files only", () => {
	const ctx = tempCtx();
	try {
		mkdirSync(path.join(ctx.cwd, ".pi/goals"), { recursive: true });
		const first = writeActiveGoalFile(ctx, {
			...createGoal({ objective: "First", autoContinue: true, sisyphus: false }, Date.UTC(2026, 0, 2, 3, 4, 5)),
			id: "b-goal",
		});
		const second = writeActiveGoalFile(ctx, {
			...createGoal({ objective: "Second", autoContinue: true, sisyphus: true }, Date.UTC(2026, 0, 1, 3, 4, 5)),
			id: "a-goal",
		});
		writeFileSync(path.join(ctx.cwd, ".pi/goals", "active_goal_invalid.md"), "not json", "utf8");
		writeFileSync(path.join(ctx.cwd, ".pi/goals", "note.md"), serializeGoalFile(first), "utf8");
		try {
			symlinkSync(path.join(ctx.cwd, first.activePath ?? "missing"), path.join(ctx.cwd, ".pi/goals", "active_goal_symlink.md"));
		} catch {}

		const goals = [...readActiveGoalPool(ctx).values()];
		assert.deepEqual(goals.map((goal) => goal.id), ["a-goal", "b-goal"]);
		assert.deepEqual(goals.map((goal) => goal.activePath), [second.activePath, first.activePath]);

		const pool = readActiveGoalPool(ctx);
		assert.deepEqual(Array.from(pool.keys()).sort(), ["a-goal", "b-goal"]);
	} finally {
		cleanup(ctx);
	}
});

test("writeActiveGoalFile no longer auto-archives for complete status (deferred archival)", () => {
	const ctx = tempCtx();
	try {
		const goal = createGoal({
			objective: "Complete goal defer archival",
			autoContinue: true,
			sisyphus: false,
		}, Date.UTC(2026, 5, 1, 12, 0, 0));
		const active = writeActiveGoalFile(ctx, goal);
		assert.match(active.activePath ?? "", /^\.pi\/goals\/active_goal_/);
		assert.equal(active.archivedPath, undefined);

		// Now mark it complete BUT write via writeActiveGoalFile — should NOT archive
		const completeGoal = { ...active, status: "complete" as const };
		const result = writeActiveGoalFile(ctx, completeGoal);
		// Should still be an active file (not archived)
		assert.match(result.activePath ?? "", /^\.pi\/goals\/active_goal_/, "complete goal should still have activePath when written via writeActiveGoalFile");
		assert.equal(result.archivedPath, undefined, "complete goal should NOT be auto-archived by writeActiveGoalFile");
		// The active file should exist on disk with status complete in metadata
		const raw = readFileSync(path.join(ctx.cwd, result.activePath ?? "missing"), "utf8");
		assert.ok(raw.includes('"status": "complete"'), "file on disk must have status complete");

		// archiveGoalFile should still work when called explicitly
		const archived = archiveGoalFile(ctx, result);
		assert.equal(archived.activePath, undefined);
		assert.match(archived.archivedPath ?? "", /^\.pi\/goals\/archived\/goal_/);
	} finally {
		cleanup(ctx);
	}
});

function pathExists(filePath: string): boolean {
	try {
		readFileSync(filePath);
		return true;
	} catch {
		return false;
	}
}

test("serializeGoalFile includes ## Tasks section when taskList is present", () => {
	const goal = createGoal({ objective: "Do stuff", autoContinue: true, sisyphus: false });
	const taskList: GoalTaskList = {
		tasks: [
			{ id: "t1", title: "Write tests", status: "complete", evidence: "all pass" },
			{ id: "t2", title: "Add migration", status: "pending" },
			{ id: "t3", title: "Update docs", status: "skipped", skipReason: "superseded" },
		],
		blockCompletion: true,
		proposedAt: "2026-05-27T00:00:00.000Z",
	};
	goal.taskList = taskList;

	const serialized = serializeGoalFile(goal);
	assert.ok(serialized.includes("## Tasks"), "should include Tasks section");
	assert.ok(serialized.includes("[x] t1: Write tests"), "complete task uses [x]");
	assert.ok(serialized.includes("[ ] t2: Add migration"), "pending task uses [ ]");
	assert.ok(serialized.includes("[~] t3: Update docs"), "skipped task uses [~]");
	assert.ok(serialized.includes("blockCompletion: true"), "should include blockCompletion in comment");
	assert.ok(serialized.includes("evidence: all pass"), "should include evidence for complete task");
	assert.ok(serialized.includes("skipped: superseded"), "should include skipReason for skipped task");
});

test("serializeGoalFile omits ## Tasks section when no taskList", () => {
	const goal = createGoal({ objective: "Simple goal", autoContinue: true, sisyphus: false });
	const serialized = serializeGoalFile(goal);
	assert.equal(serialized.includes("## Tasks"), false);
});

test("parseGoalFile round-trips taskList through JSON header", () => {
	const goal = createGoal({ objective: "Stuff", autoContinue: true, sisyphus: false });
	goal.taskList = {
		tasks: [
			{ id: "t1", title: "Task 1", status: "complete" },
			{ id: "t2", title: "Task 2", status: "pending" },
		],
		blockCompletion: false,
		proposedAt: "2026-05-27T00:00:00.000Z",
	};

	const serialized = serializeGoalFile(goal);
	const tmpDir = mkdtempSync(path.join(tmpdir(), "goal-test-"));
	try {
		const filePath = path.join(tmpDir, "test-goal.md");
		writeFileSync(filePath, serialized, "utf8");
		const parsed = parseGoalFile(filePath);
		assert.ok(parsed);
		assert.ok(parsed.taskList);
		assert.equal(parsed.taskList.tasks.length, 2);
		assert.equal(parsed.taskList.tasks[0]!.id, "t1");
		assert.equal(parsed.taskList.tasks[0]!.status, "complete");
		assert.equal(parsed.taskList.tasks[1]!.id, "t2");
		assert.equal(parsed.taskList.tasks[1]!.status, "pending");
		assert.equal(parsed.taskList.blockCompletion, false);
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
	}
});

test("parseGoalFile parses goal without taskList unchanged", () => {
	const goal = createGoal({ objective: "Simple task", autoContinue: true, sisyphus: false });
	const serialized = serializeGoalFile(goal);
	const tmpDir = mkdtempSync(path.join(tmpdir(), "goal-test-"));
	try {
		const filePath = path.join(tmpDir, "test-goal.md");
		writeFileSync(filePath, serialized, "utf8");
		const parsed = parseGoalFile(filePath);
		assert.ok(parsed);
		assert.equal(parsed.taskList, undefined);
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
	}
});

test("refreshActiveGoalPool sees an in-place edit that a plain cold read misses (#178)", () => {
	const shared = mkdtempSync(path.join(tmpdir(), "pi-goal-shared-"));
	const ctx = { cwd: mkdtempSync(path.join(tmpdir(), "pi-goal-cwd-")), goalStorageRoot: shared };
	try {
		const written = writeActiveGoalFile(ctx, createGoal({ objective: "Shared goal", autoContinue: false, sisyphus: false }));
		const file = path.join(shared, written.activePath!.slice(".pi/goals/".length));
		assert.equal(readActiveGoalPool(ctx).get(written.id)?.revision, written.revision, "primes the snapshot");

		writeFileSync(file, serializeGoalFile({ ...written, revision: (written.revision ?? 0) + 3 }), "utf8");
		invalidateGoalPoolCache();
		assert.equal(readActiveGoalPool(ctx).get(written.id)?.revision, written.revision, "plain cold read serves the stale snapshot");

		assert.equal(refreshActiveGoalPool(ctx).get(written.id)?.revision, (written.revision ?? 0) + 3);
		invalidateGoalPoolCache();
		assert.equal(readActiveGoalPool(ctx).get(written.id)?.revision, (written.revision ?? 0) + 3, "the snapshot was rewritten");
	} finally {
		rmSync(shared, { recursive: true, force: true });
		cleanup(ctx);
	}
});
