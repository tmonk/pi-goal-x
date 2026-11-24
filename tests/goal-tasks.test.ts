/**
 * Tests for task list policy helpers in goal-policy.ts
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
	buildTaskSummary,
	checkSubtasksComplete,
	findSubtaskDepthViolation,
	findTaskInTree,
	skipAllSubtasks,
	taskCompletionBlockWarning,
	updateTaskInTree,
} from "../extensions/goal-policy.ts";

// ── Fixtures ─────────────────────────────────────────────────────────────────

// ── buildTaskSummary ─────────────────────────────────────────────────────────

test("buildTaskSummary: no tasks", () => {
	const result = buildTaskSummary({
		tasks: [],
		blockCompletion: false,
		proposedAt: "2026-05-27T00:00:00.000Z",
	});
	assert.equal(result, "No tasks");
});

test("buildTaskSummary: all pending", () => {
	const result = buildTaskSummary({
		tasks: [
			{ id: "t1", title: "Task 1", status: "pending" },
			{ id: "t2", title: "Task 2", status: "pending" },
		],
		blockCompletion: false,
		proposedAt: "2026-05-27T00:00:00.000Z",
	});
	assert.equal(result, "0/2 tasks complete");
});

test("buildTaskSummary: some complete", () => {
	const result = buildTaskSummary({
		tasks: [
			{ id: "t1", title: "Task 1", status: "complete" },
			{ id: "t2", title: "Task 2", status: "pending" },
			{ id: "t3", title: "Task 3", status: "pending" },
		],
		blockCompletion: false,
		proposedAt: "2026-05-27T00:00:00.000Z",
	});
	assert.equal(result, "1/3 tasks complete");
});

test("buildTaskSummary: some skipped", () => {
	const result = buildTaskSummary({
		tasks: [
			{ id: "t1", title: "Task 1", status: "complete" },
			{ id: "t2", title: "Task 2", status: "skipped" },
			{ id: "t3", title: "Task 3", status: "pending" },
		],
		blockCompletion: false,
		proposedAt: "2026-05-27T00:00:00.000Z",
	});
	assert.equal(result, "1/3 tasks complete (1 skipped)");
});

test("buildTaskSummary: all complete", () => {
	const result = buildTaskSummary({
		tasks: [
			{ id: "t1", title: "Task 1", status: "complete" },
			{ id: "t2", title: "Task 2", status: "complete" },
		],
		blockCompletion: false,
		proposedAt: "2026-05-27T00:00:00.000Z",
	});
	assert.equal(result, "2/2 tasks complete");
});

// ── taskCompletionBlockWarning ────────────────────────────────────────────────

test("taskCompletionBlockWarning: no blockCompletion returns null", () => {
	const result = taskCompletionBlockWarning({
		tasks: [{ id: "t1", title: "Task 1", status: "pending" }],
		blockCompletion: false,
		proposedAt: "2026-05-27T00:00:00.000Z",
	});
	assert.equal(result, null);
});

test("taskCompletionBlockWarning: blockCompletion but no pending returns null", () => {
	const result = taskCompletionBlockWarning({
		tasks: [{ id: "t1", title: "Task 1", status: "complete" }],
		blockCompletion: true,
		proposedAt: "2026-05-27T00:00:00.000Z",
	});
	assert.equal(result, null);
});

test("taskCompletionBlockWarning: blockCompletion with pending returns warning", () => {
	const result = taskCompletionBlockWarning({
		tasks: [
			{ id: "t1", title: "Task 1", status: "complete" },
			{ id: "t2", title: "Task 2", status: "pending" },
		],
		blockCompletion: true,
		proposedAt: "2026-05-27T00:00:00.000Z",
	});
	assert.ok(result);
	assert.match(result, /pending/);
	assert.match(result, /blockCompletion/);
});

test("taskCompletionBlockWarning: plural tasks", () => {
	const result = taskCompletionBlockWarning({
		tasks: [
			{ id: "t1", title: "Task 1", status: "pending" },
			{ id: "t2", title: "Task 2", status: "pending" },
		],
		blockCompletion: true,
		proposedAt: "2026-05-27T00:00:00.000Z",
	});
	assert.match(result!, /2 tasks/);
});

// ── Subtask depth validation ────────────────────────────────────────────

test("findSubtaskDepthViolation: no violation at default depth", () => {
	const tasks = [{
		id: "t1", title: "Task 1", status: "pending" as const,
		subtasks: [
			{ id: "t1a", title: "Sub A", status: "pending" as const },
		],
	}];
	const violation = findSubtaskDepthViolation(tasks, 1);
	assert.equal(violation, undefined);
});

test("findSubtaskDepthViolation: catches sub-sub-tasks at depth=1", () => {
	const tasks = [{
		id: "t1", title: "Task 1", status: "pending" as const,
		subtasks: [{
			id: "t1a", title: "Sub A", status: "pending" as const,
			subtasks: [
				{ id: "t1ai", title: "Sub-sub", status: "pending" as const },
			],
		}],
	}];
	const violation = findSubtaskDepthViolation(tasks, 1);
	assert.ok(violation, "should find violation");
	assert.match(violation!, /subtask nesting depth/);
	assert.match(violation!, /maximum of 1/);
});

test("findSubtaskDepthViolation: sub-sub-tasks allowed at depth=2", () => {
	const tasks = [{
		id: "t1", title: "Task 1", status: "pending" as const,
		subtasks: [{
			id: "t1a", title: "Sub A", status: "pending" as const,
			subtasks: [
				{ id: "t1ai", title: "Sub-sub", status: "pending" as const },
			],
		}],
	}];
	const violation = findSubtaskDepthViolation(tasks, 2);
	assert.equal(violation, undefined);
});

test("findSubtaskDepthViolation: catches 3-levels at depth=2", () => {
	const tasks = [{
		id: "t1", title: "Task 1", status: "pending" as const,
		subtasks: [{
			id: "t1a", title: "Sub A", status: "pending" as const,
			subtasks: [{
				id: "t1ai", title: "Sub-sub", status: "pending" as const,
				subtasks: [{ id: "t1aia", title: "Sub-sub-sub", status: "pending" as const }],
			}],
		}],
	}];
	const violation = findSubtaskDepthViolation(tasks, 2);
	assert.ok(violation);
});

test("findSubtaskDepthViolation: no violation for tasks without subtasks", () => {
	const tasks = [
		{ id: "t1", title: "Task 1", status: "pending" as const },
		{ id: "t2", title: "Task 2", status: "pending" as const },
	];
	assert.equal(findSubtaskDepthViolation(tasks, 1), undefined);
});

// ── checkSubtasksComplete ───────────────────────────────────────────────

test("checkSubtasksComplete: returns undefined when no subtasks", () => {
	const task = { id: "t1", title: "Task 1", status: "pending" as const };
	assert.equal(checkSubtasksComplete(task), undefined);
});

test("checkSubtasksComplete: returns undefined when lightweight", () => {
	const task = {
		id: "t1", title: "Task 1", status: "pending" as const,
		lightweightSubtasks: true,
		subtasks: [{ id: "t1a", title: "Sub A", status: "pending" as const }],
	};
	assert.equal(checkSubtasksComplete(task), undefined);
});

test("checkSubtasksComplete: returns message when subtask is pending", () => {
	const task = {
		id: "t1", title: "Task 1", status: "pending" as const,
		subtasks: [
			{ id: "t1a", title: "Sub A", status: "complete" as const },
			{ id: "t1b", title: "Sub B", status: "pending" as const },
		],
	};
	const result = checkSubtasksComplete(task);
	assert.ok(result);
	assert.match(result!, /pending subtask/);
});

test("checkSubtasksComplete: returns undefined when all subtasks complete/skipped", () => {
	const task = {
		id: "t1", title: "Task 1", status: "pending" as const,
		subtasks: [
			{ id: "t1a", title: "Sub A", status: "complete" as const },
			{ id: "t1b", title: "Sub B", status: "skipped" as const },
		],
	};
	assert.equal(checkSubtasksComplete(task), undefined);
});

test("checkSubtasksComplete: checks nested subtasks", () => {
	const task = {
		id: "t1", title: "Task 1", status: "pending" as const,
		subtasks: [{
			id: "t1a", title: "Sub A", status: "complete" as const,
			subtasks: [
				{ id: "t1ai", title: "Sub-sub A", status: "complete" as const },
				{ id: "t1aii", title: "Sub-sub B", status: "pending" as const },
			],
		}],
	};
	assert.ok(checkSubtasksComplete(task));
});

// ── skipAllSubtasks ─────────────────────────────────────────────────────

test("skipAllSubtasks: skips direct subtasks", () => {
	const task = {
		id: "t1", title: "Task 1", status: "skipped" as const,
		subtasks: [
			{ id: "t1a", title: "Sub A", status: "pending" as const },
			{ id: "t1b", title: "Sub B", status: "pending" as const },
		],
	};
	const result = skipAllSubtasks(task, "2026-01-01", "Test skip");
	assert.equal(result.subtasks![0]!.status, "skipped");
	assert.equal(result.subtasks![0]!.skipReason, "Test skip");
	assert.equal(result.subtasks![1]!.status, "skipped");
});

test("skipAllSubtasks: does not modify completed subtasks", () => {
	const task = {
		id: "t1", title: "Task 1", status: "skipped" as const,
		subtasks: [
			{ id: "t1a", title: "Sub A", status: "complete" as const, completedAt: "2026-01-01" },
			{ id: "t1b", title: "Sub B", status: "pending" as const },
		],
	};
	const result = skipAllSubtasks(task, "2026-06-01", "Cascade");
	assert.equal(result.subtasks![0]!.status, "complete"); // unchanged
	assert.equal(result.subtasks![1]!.status, "skipped");
});

test("skipAllSubtasks: skips nested subtasks", () => {
	const task = {
		id: "t1", title: "Task 1", status: "skipped" as const,
		subtasks: [{
			id: "t1a", title: "Sub A", status: "pending" as const,
			subtasks: [
				{ id: "t1ai", title: "Sub-sub", status: "pending" as const },
			],
		}],
	};
	const result = skipAllSubtasks(task, "2026-01-01", "Nested");
	assert.equal(result.subtasks![0]!.subtasks![0]!.status, "skipped");
});

// ── findTaskInTree / updateTaskInTree ───────────────────────────────────

test("findTaskInTree: finds top-level task", () => {
	const tasks = [
		{ id: "t1", title: "T1", status: "pending" as const },
		{ id: "t2", title: "T2", status: "pending" as const },
	];
	assert.equal(findTaskInTree(tasks, "t2")?.id, "t2");
});

test("findTaskInTree: finds nested task", () => {
	const tasks = [{
		id: "t1", title: "T1", status: "pending" as const,
		subtasks: [
			{ id: "t1a", title: "Sub A", status: "pending" as const },
		],
	}];
	assert.equal(findTaskInTree(tasks, "t1a")?.id, "t1a");
});

test("findTaskInTree: returns undefined for missing task", () => {
	const tasks = [{ id: "t1", title: "T1", status: "pending" as const }];
	assert.equal(findTaskInTree(tasks, "missing"), undefined);
});

test("updateTaskInTree: updates top-level task", () => {
	const tasks = [
		{ id: "t1", title: "T1", status: "pending" as const },
		{ id: "t2", title: "T2", status: "pending" as const },
	];
	const updated = updateTaskInTree(tasks, "t1", (t) => ({ ...t, status: "complete" as const }));
	assert.equal(updated[0]!.status, "complete");
	assert.equal(updated[1]!.status, "pending");
});

test("updateTaskInTree: updates nested task", () => {
	const tasks = [{
		id: "t1", title: "T1", status: "pending" as const,
		subtasks: [
			{ id: "t1a", title: "Sub A", status: "pending" as const },
		],
	}];
	const updated = updateTaskInTree(tasks, "t1a", (t) => ({ ...t, status: "complete" as const }));
	assert.equal(updated[0]!.subtasks![0]!.status, "complete");
});

test("updateTaskInTree: leaves unrelated tasks unchanged", () => {
	const tasks = [
		{ id: "t1", title: "T1", status: "pending" as const },
		{ id: "t2", title: "T2", status: "pending" as const },
	];
	const updated = updateTaskInTree(tasks, "t2", (t) => ({ ...t, status: "skipped" as const }));
	assert.equal(updated[0]!.status, "pending");
	assert.equal(updated[1]!.status, "skipped");
});

test("buildTaskSummary: counts subtasks recursively", () => {
	const taskList = {
		tasks: [{
			id: "t1", title: "T1", status: "complete" as const,
			subtasks: [
				{ id: "t1a", title: "Sub A", status: "pending" as const },
			],
		}],
		blockCompletion: false,
		proposedAt: "2026-05-27T00:00:00.000Z",
	};
	const result = buildTaskSummary(taskList);
	// t1 (complete) + t1a (pending) = 1/2 complete
	assert.match(result, /1\/2/);
});

test("taskCompletionBlockWarning: counts pending subtasks", () => {
	const taskList = {
		tasks: [{
			id: "t1", title: "T1", status: "complete" as const,
			subtasks: [
				{ id: "t1a", title: "Sub A", status: "pending" as const },
			],
		}],
		blockCompletion: true,
		proposedAt: "2026-05-27T00:00:00.000Z",
	};
	const result = taskCompletionBlockWarning(taskList);
	assert.ok(result);
	assert.match(result!, /1 task/);
});
