import assert from "node:assert/strict";
import test from "node:test";

import {
	cloneGoal,
	createGoal,
	goalFocusDetails,
	normalizeGoalFocusEntry,
	normalizeGoalRecord,
	type GoalCreationConfig,
	type GoalTaskList,
} from "../extensions/goal-record.ts";

const baseConfig: GoalCreationConfig = {
	objective: "=== Goal ===\nObjective: ship the refactor",
	autoContinue: true,
	sisyphus: false,
};

test("createGoal builds stable goal records with fresh usage and requested mode", () => {
	const goal = createGoal(baseConfig, Date.UTC(2026, 0, 2, 3, 4, 5));

	assert.equal(goal.objective, baseConfig.objective);
	assert.equal(goal.status, "active");
	assert.equal(goal.autoContinue, true);
	assert.equal(goal.sisyphus, false);
	assert.deepEqual(goal.usage, { tokensUsed: 0, activeSeconds: 0 });
	assert.equal(goal.createdAt, "2026-01-02T03:04:05.000Z");
	assert.equal(goal.updatedAt, "2026-01-02T03:04:05.000Z");
	assert.match(goal.id, /^[a-z0-9]+-[a-z0-9]+$/);
});

test("normalizeGoalRecord preserves known fields while sanitizing unsafe or missing values", () => {
	const normalized = normalizeGoalRecord({
		id: "goal-123",
		objective: "  Keep behavior  ",
		status: "paused",
		stopReason: "agent",
		pauseReason: "blocked",
		pauseSuggestedAction: "ask user",
		autoContinue: false,
		usage: { tokensUsed: 12.9, activeSeconds: 7.2 },
		sisyphus: true,
		activePath: ".pi/goals/active.md",
		archivedPath: ".pi/goals/archived/old.md",
		createdAt: "2026-02-03T04:05:06.000Z",
		updatedAt: "2026-02-03T04:06:06.000Z",
	});

	assert.ok(normalized);
	assert.equal(normalized.id, "goal-123");
	assert.equal(normalized.objective, "Keep behavior");
	assert.equal(normalized.status, "paused");
	assert.equal(normalized.stopReason, "agent");
	assert.equal(normalized.pauseReason, "blocked");
	assert.equal(normalized.pauseSuggestedAction, "ask user");
	assert.equal(normalized.autoContinue, false);
	assert.deepEqual(normalized.usage, { tokensUsed: 12, activeSeconds: 7 });
	assert.equal(normalized.sisyphus, true);
	assert.equal(normalized.activePath, ".pi/goals/active.md");
	assert.equal(normalized.archivedPath, ".pi/goals/archived/old.md");
	assert.equal(normalized.createdAt, "2026-02-03T04:05:06.000Z");
	assert.equal(normalized.updatedAt, "2026-02-03T04:06:06.000Z");
});

test("cloneGoal returns a detached usage object", () => {
	const goal = createGoal(baseConfig, Date.UTC(2026, 0, 2, 3, 4, 5));
	const cloned = cloneGoal(goal);
	cloned.usage.tokensUsed = 500;

	assert.equal(goal.usage.tokensUsed, 0);
	assert.equal(cloned.usage.tokensUsed, 500);
});

test("normalizeGoalRecord with taskList present round-trips tasks", () => {
	const normalized = normalizeGoalRecord({
		id: "goal-task",
		objective: "Do stuff",
		status: "active",
		autoContinue: true,
		usage: { tokensUsed: 0, activeSeconds: 0 },
		sisyphus: false,
		taskList: {
			tasks: [
				{ id: "t1", title: "Task 1", status: "complete" },
				{ id: "t2", title: "Task 2", status: "pending" },
				{ id: "t3", title: "Task 3", status: "skipped", skipReason: "N/A" },
			],
			blockCompletion: true,
			proposedAt: "2026-05-27T00:00:00.000Z",
		},
	});

	assert.ok(normalized);
	assert.ok(normalized.taskList);
	assert.equal(normalized.taskList.tasks.length, 3);
	assert.equal(normalized.taskList.tasks[0]!.id, "t1");
	assert.equal(normalized.taskList.tasks[0]!.status, "complete");
	assert.equal(normalized.taskList.tasks[1]!.status, "pending");
	assert.equal(normalized.taskList.tasks[2]!.status, "skipped");
	assert.equal(normalized.taskList.tasks[2]!.skipReason, "N/A");
	assert.equal(normalized.taskList.blockCompletion, true);
});

test("normalizeGoalRecord with malformed taskList returns taskList undefined", () => {
	const normalized = normalizeGoalRecord({
		id: "goal-mal",
		objective: "Test",
		status: "active",
		autoContinue: true,
		usage: { tokensUsed: 0, activeSeconds: 0 },
		sisyphus: false,
		taskList: "not-an-object",
	});
	assert.ok(normalized);
	assert.equal(normalized.taskList, undefined);

	// Empty tasks array
	const normalized2 = normalizeGoalRecord({
		id: "goal-empty",
		objective: "Test",
		status: "active",
		autoContinue: true,
		usage: { tokensUsed: 0, activeSeconds: 0 },
		sisyphus: false,
		taskList: { tasks: [], blockCompletion: false, proposedAt: "2026-05-27T00:00:00.000Z" },
	});
	assert.ok(normalized2);
	assert.equal(normalized2.taskList, undefined);
});

test("cloneGoal deep-clones tasks array", () => {
	const goal = createGoal({
		objective: "Test",
		autoContinue: true,
		sisyphus: false,
	}, Date.UTC(2026, 0, 2, 3, 4, 5));
	const taskList: GoalTaskList = {
		tasks: [
			{ id: "t1", title: "Task 1", status: "pending" },
			{ id: "t2", title: "Task 2", status: "complete", completedAt: "2026-05-27T00:00:00.000Z" },
		],
		blockCompletion: false,
		proposedAt: "2026-05-27T00:00:00.000Z",
	};
	goal.taskList = taskList;

	const cloned = cloneGoal(goal);
	assert.ok(cloned.taskList);
	assert.equal(cloned.taskList.tasks.length, 2);

	// Mutation should not affect original
	cloned.taskList.tasks[0]!.status = "complete";
	cloned.taskList.blockCompletion = true;

	assert.equal(goal.taskList.tasks[0]!.status, "pending");
	assert.equal(goal.taskList.blockCompletion, false);
});

test("goal focus entries persist only session focus metadata", () => {
	assert.deepEqual(goalFocusDetails("goal/123", "created"), {
		version: 1,
		focusedGoalId: "goal_123",
		reason: "created",
	});
	assert.deepEqual(goalFocusDetails(null, "cleared"), {
		version: 1,
		focusedGoalId: null,
		reason: "cleared",
	});
	assert.deepEqual(goalFocusDetails(null, "unfocused"), {
		version: 1,
		focusedGoalId: null,
		reason: "unfocused",
	});

	assert.deepEqual(normalizeGoalFocusEntry({ version: 1, focusedGoalId: "abc/def", reason: "resumed" }), {
		version: 1,
		focusedGoalId: "abc_def",
		reason: "resumed",
	});
	assert.deepEqual(normalizeGoalFocusEntry({ version: 1, focusedGoalId: null, reason: "unfocused" }), {
		version: 1,
		focusedGoalId: null,
		reason: "unfocused",
	});
	assert.deepEqual(normalizeGoalFocusEntry({ version: 1, focusedGoalId: "", reason: "unknown" }), {
		version: 1,
		focusedGoalId: null,
		reason: "selected",
	});
	assert.equal(normalizeGoalFocusEntry({ version: 3, focusedGoalId: "abc" }), null);
});
