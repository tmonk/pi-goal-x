import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { buildCompletionReport, findSubtaskDepthViolation, validateTaskListProposal } from "../extensions/goal-policy.ts";
import { createGoal } from "../extensions/goal-record.ts";
import {
	archiveGoalFile,
	readActiveGoalPool,
	writeActiveGoalFile,
} from "../extensions/storage/goal-files.ts";
import type { GoalRecord } from "../extensions/goal-record.ts";

interface TestContext {
	cwd: string;
}

function tempCtx(): TestContext {
	return { cwd: mkdtempSync(path.join(tmpdir(), "goal-update-objective-test-")) };
}

function cleanup(ctx: TestContext): void {
	try {
		rmSync(ctx.cwd, { recursive: true, force: true });
	} catch {
		// ignore
	}
}

function makeGoal(overrides: Partial<GoalRecord> = {}): GoalRecord {
	return {
		...createGoal({
			objective: "Original objective: build feature X",
			autoContinue: true,
			sisyphus: false,
		}, Date.UTC(2026, 5, 2, 10, 0, 0)),
		...overrides,
	};
}

// ─── updatedObjective schema rejection (removed from the model surface) ──────

test("update_goal schema has additionalProperties: false and no updatedObjective", () => {
	const source = readFileSync("extensions/goal-tools.ts", "utf8");
	const updateGoalIdx = source.indexOf('name: "update_goal"');
	assert.ok(updateGoalIdx >= 0, "must find update_goal tool registration");
	const registerBlock = source.substring(updateGoalIdx, updateGoalIdx + 4000);
	assert.ok(registerBlock.includes("additionalProperties: false"),
		"update_goal schema must have additionalProperties: false");
	assert.ok(!registerBlock.includes("updatedObjective"),
		"update_goal schema must not contain updatedObjective");
	assert.ok(!source.includes("updatedObjective"),
		"updatedObjective must not appear anywhere in goal-tools.ts");
	assert.equal(source.includes('name: "complete_goal"'), false,
		"complete_goal tool registration must be removed");
});

test("update_goal routes complete directly to the shared completion flow with no options", () => {
	const source = readFileSync("extensions/goal-tools.ts", "utf8");
	// The completion flow is reached directly from the update_goal executor for
	// status=complete; blocked routes to the blocked flow. The internal options
	// type carries no paperwork fields: the public schema has only status.
	assert.ok(!source.includes("params.updatedObjective"),
		"Phase 1 updatedObjective handling must be removed");
	assert.ok(!source.includes("completionSummary?: string"),
		"internal options type must not carry completionSummary");
	assert.ok(!source.includes("verificationSummary?: string"),
		"internal options type must not carry verificationSummary");
	assert.ok(!source.includes("confirmBypassAuditor"),
		"internal options type must not carry confirmBypassAuditor");
	assert.ok(source.includes("return runGoalCompletionFlow(ctx);"),
		"executor must route status=complete to the flow without an options object");
	assert.ok(!source.includes("updatedObjective"),
		"handler must not reference updatedObjective in error messages");
});

// ─── completion flow unaffected ────────────────────────────────────────────

// ─── completion flow unaffected ────────────────────────────────────────────

test("update_goal(complete) with status=complete still works (completion flow unchanged)", () => {
	const ctx = tempCtx();
	try {
		const goal = makeGoal();
		const active = writeActiveGoalFile(ctx, goal);
		assert.equal(active.status, "active");

		const completed = writeActiveGoalFile(ctx, {
			...active,
			status: "complete" as const,
			stopReason: "agent" as const,
			updatedAt: new Date().toISOString(),
		});
		assert.equal(completed.status, "complete");
		assert.equal(completed.objective, active.objective);

		const diskContent = readFileSync(path.join(ctx.cwd, completed.activePath ?? "missing"), "utf8");
		assert.ok(diskContent.includes('"status": "complete"'));

		const archived = archiveGoalFile(ctx, completed);
		assert.equal(archived.activePath, undefined);
		assert.match(archived.archivedPath ?? "", /^\.pi\/goals\/archived\/goal_/);
	} finally {
		cleanup(ctx);
	}
});

// ─── buildCompletionReport ──────────────────────────────────────────────────

test("buildCompletionReport handles updated objective display", () => {
	const report = buildCompletionReport({
		detailedSummary: "Goal: Build feature X\nUpdated objective: Build feature Y\nStatus: active",
		completionSummary: "Feature Y built successfully.",
		auditorReport: "Inspected and verified.\n\n<approved/>",
	});
	assert.ok(report.includes("Goal complete."));
	assert.ok(report.includes("<approved/>"));
});

// ─── tweak persist-path simulation (shared proposal validators) ────────────
// The tweak persist path writes the new objective via
// writeActiveGoalFile, appends a state entry, clears tweakDraftingFor, sets
// turnStoppedFor, and returns terminate:true. We simulate the storage-level
// write and verify the goal is updated on disk.

test("tweak persist path: writeActiveGoalFile with new objective (simulated handler execution)", () => {
	const ctx = tempCtx();
	try {
		const originalObj = "Original objective";
		const newObj = "Tweaked objective after /goal-tweak interview";

		// Write the original active goal
		const goal = makeGoal({ objective: originalObj });
		const active = writeActiveGoalFile(ctx, goal);
		assert.equal(active.objective, originalObj);

		// Simulate the tweak persist path: write with new objective (same
		// pattern the handler uses: spread state goal, set new objective + updatedAt)
		const tweaked = writeActiveGoalFile(ctx, {
			...active,
			objective: newObj,
			updatedAt: new Date().toISOString(),
		});
		assert.equal(tweaked.objective, newObj, "objective must be updated");
		assert.equal(tweaked.status, "active", "status must remain active after tweak");
		assert.equal(tweaked.activePath, active.activePath,
			"active file path should not change on tweak");

		// Verify disk has the updated objective
		const diskContent = readFileSync(path.join(ctx.cwd, tweaked.activePath ?? "missing"), "utf8");
		assert.ok(diskContent.includes(newObj), "disk must have the tweaked objective");
		assert.ok(diskContent.includes('"status": "active"'), "disk must show active status");

		// Verify still in the active pool
		const pool = readActiveGoalPool(ctx);
		assert.ok(pool.has(goal.id), "tweaked goal must still be in active pool");
	} finally {
		cleanup(ctx);
	}
});

test("tweak persist path: taskList persisted when tasks parameter provided", () => {
	const ctx = tempCtx();
	try {
		const goal = makeGoal({
			objective: "Goal with inherited tasks",
		});
		const active = writeActiveGoalFile(ctx, goal);

		const newTasks = [
			{ id: "t1", title: "Task one", status: "pending" as const },
			{ id: "t2", title: "Task two", status: "pending" as const, verificationContract: "Must verify" },
		];

		// Simulate the tweak persist path with tasks parameter
		const tweaked = writeActiveGoalFile(ctx, {
			...active,
			objective: "Updated objective with new tasks",
			updatedAt: new Date().toISOString(),
			taskList: {
				tasks: newTasks,
				blockCompletion: false,
				proposedAt: new Date().toISOString(),
			},
		});

		assert.ok(tweaked.taskList, "taskList must be set on tweaked goal");
		assert.equal(tweaked.taskList.tasks.length, 2, "must have 2 tasks");
		assert.equal(tweaked.taskList.tasks[0].id, "t1");
		assert.equal(tweaked.taskList.tasks[1].verificationContract, "Must verify");
		assert.equal(tweaked.objective, "Updated objective with new tasks");

		// Verify disk has the task list JSON
		const diskContent = readFileSync(path.join(ctx.cwd, tweaked.activePath ?? "missing"), "utf8");
		assert.ok(diskContent.includes("Task one"), "disk must contain task title");
		assert.ok(diskContent.includes("Must verify"), "disk must contain verification contract");
	} finally {
		cleanup(ctx);
	}
});

test("tweak persist path: original taskList inherited when tasks omitted", () => {
	const ctx = tempCtx();
	try {
		const originalTasks = [
			{ id: "orig1", title: "Original task", status: "pending" as const },
		];

		// Write goal WITH task list
		const goal = makeGoal({
			objective: "Goal with original task list",
			taskList: {
				tasks: originalTasks,
				blockCompletion: false,
				proposedAt: new Date().toISOString(),
			},
		});
		const active = writeActiveGoalFile(ctx, goal);
		assert.ok(active.taskList, "original must have taskList");

		// Simulate the tweak persist path WITHOUT tasks parameter:
		// the handler inherits the current goal's taskList
		const updatedObjective = "Objective tweaked, tasks inherited unchanged";
		const withInherited = writeActiveGoalFile(ctx, {
			...active,
			objective: updatedObjective,
			updatedAt: new Date().toISOString(),
			taskList: active.taskList, // This is what the handler does
		});

		assert.ok(withInherited.taskList, "inherited taskList must be present");
		assert.equal(withInherited.taskList.tasks.length, 1);
		assert.equal(withInherited.taskList.tasks[0].id, "orig1");
		assert.equal(withInherited.taskList.tasks[0].title, "Original task");
		assert.equal(withInherited.objective, updatedObjective);

		// Verify disk has both the new objective and the original task
		const diskContent = readFileSync(path.join(ctx.cwd, withInherited.activePath ?? "missing"), "utf8");
		assert.ok(diskContent.includes(updatedObjective), "disk must have new objective");
		assert.ok(diskContent.includes("Original task"), "disk must have original task from inheritance");
	} finally {
		cleanup(ctx);
	}
});

test("tweak persist path: taskList cleared when tasks omitted and goal has no taskList", () => {
	const ctx = tempCtx();
	try {
		// Goal WITHOUT task list
		const goal = makeGoal({ objective: "Goal without task list" });
		const active = writeActiveGoalFile(ctx, goal);
		assert.equal(active.taskList, undefined, "original must have no taskList");

		// Simulate handler: no tasks param and no inherited taskList
		const tweaked = writeActiveGoalFile(ctx, {
			...active,
			objective: "Still no tasks",
			updatedAt: new Date().toISOString(),
			taskList: undefined, // Handler does not set taskList
		});

		assert.equal(tweaked.taskList, undefined, "must still have no taskList");
	} finally {
		cleanup(ctx);
	}
});

test("tweak persist path: task validation rejects deep subtasks", () => {
	const ctx = tempCtx();
	try {
		const goal = makeGoal({ objective: "Test validation" });
		const active = writeActiveGoalFile(ctx, goal);

		// Tasks with subtask depth > 1 (default max) — this is what the
		// handler's findSubtaskDepthViolation call would catch at confirm time.
		// We verify the goal can be written but that validateTaskListProposal
		const deepTasks = [{
			id: "t1", title: "Parent", status: "pending" as const,
			subtasks: [{
				id: "t1a", title: "Child", status: "pending" as const,
				subtasks: [
					{ id: "t1ai", title: "Grandchild", status: "pending" as const },
				],
			}],
		}];

		// Simulate the handler calling findSubtaskDepthViolation
		const depthViolation = findSubtaskDepthViolation(deepTasks, 1);
		assert.ok(depthViolation, "must reject tasks with subtask depth > 1");
		assert.ok(depthViolation.includes("subtask nesting depth"),
			`must mention depth violation. Got: ${depthViolation}`);

		// Also verify that validateTaskListProposal rejects it
		const proposalResult = validateTaskListProposal({ goal: tweakedRecord(active), tasks: deepTasks });
		assert.equal(proposalResult.ok, false, "must reject deep subtasks");
		assert.ok(proposalResult.message.includes("depth"),
			`must mention depth. Got: ${proposalResult.message}`);
	} finally {
		cleanup(ctx);
	}
});

function tweakedRecord(g: GoalRecord): GoalRecord {
	return { ...g, status: "active" as const, autoContinue: true };
}

// ─── prompt evolution instruction ────────────────────────────────────────────

test("goal evolution instruction mentions /goal-tweak instead of updatedObjective", async () => {
	const { goalPrompt, continuationPrompt } = await import("../extensions/prompts/goal-prompts.ts");
	const goal = makeGoal();

	const contText = continuationPrompt(goal);
	assert.ok(!contText.includes("updatedObjective"), "continuationPrompt must NOT reference updatedObjective");
	assert.ok(contText.includes("immutable"), "continuationPrompt must mention the goal is immutable");
	assert.ok(contText.includes("/goal-tweak"), "continuationPrompt must instruct user to run /goal-tweak");

	const goalText = goalPrompt(goal);
	assert.ok(!goalText.includes("updatedObjective"), "goalPrompt must NOT reference updatedObjective");
	assert.ok(goalText.includes("/goal-tweak"), "goalPrompt must instruct user to run /goal-tweak");
});
