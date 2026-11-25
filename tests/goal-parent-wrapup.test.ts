import assert from "node:assert/strict";
import test from "node:test";

import { createGoal, type GoalRecord, type GoalTaskList } from "../extensions/goal-record.ts";
import { taskListBlock, wrapUpPhase } from "../extensions/prompts/goal-prompts.ts";

/**
 * Completing a subtask clears `currentTaskId` (`resolveUpdatedCurrentTaskId` in
 * `extensions/goal-task-update.ts`), and the block only printed a `Current:` line
 * while a focus existed. A phase whose subtasks have all ended is still pending
 * and still has its own acceptance to meet, but it rendered as one more `[ ]`
 * root — indistinguishable from untouched work — so agents moved on to the next
 * phase and left it open.
 */

function goal(currentTaskId?: string, taskList?: GoalTaskList): GoalRecord {
	const g = createGoal({ objective: "Ship the three phases", autoContinue: true, sisyphus: false });
	g.id = "wrapup-goal";
	g.currentTaskId = currentTaskId;
	g.taskList = taskList ?? phases();
	return g;
}

function phases(): GoalTaskList {
	return {
		blockCompletion: false,
		proposedAt: "2026-11-14T00:00:00.000Z",
		tasks: [
			{
				id: "p1", title: "Phase one", status: "pending", verificationContract: "Phase one acceptance",
				subtasks: [{ id: "1.1", title: "Step one one", status: "complete", completedAt: "2026-11-13T00:00:00.000Z" }],
			},
			{
				id: "p2", title: "Phase two", status: "pending", verificationContract: "Phase two acceptance",
				subtasks: [{ id: "2.1", title: "Step two one", status: "pending" }],
			},
		],
	};
}

test("a phase whose subtasks all ended is named for wrap-up", () => {
	const block = taskListBlock(goal());
	assert.match(block, /Wrap-up: every subtask of p1 has ended and p1 is still pending\./);
	assert.match(block, /Close it with update_goal_task\(\{task_id:"p1", status:"complete"\}\)/, "the next step is copy-pasteable");
	assert.match(block, /instead of moving on to the next phase/);
	assert.match(block, /\[ \] p1: Phase one/, "the phase still counts as pending work");
});

test("the wrap-up line comes before the pending roots it refers to", () => {
	const lines = taskListBlock(goal()).split("\n");
	const wrap = lines.findIndex(line => line.includes("Wrap-up:"));
	const root = lines.findIndex(line => line.includes("[ ] p1:"));
	assert.ok(wrap > 0 && wrap < root, "the reminder is not buried under the truncated pending list");
});

test("skipped subtasks count as ended", () => {
	const skipped = phases();
	skipped.tasks[0]!.subtasks![0]!.status = "skipped";
	assert.equal(wrapUpPhase(goal(undefined, skipped))?.id, "p1");
});

test("no wrap-up while a subtask is still open", () => {
	const open = phases();
	open.tasks[0]!.subtasks![0]!.status = "pending";
	assert.equal(wrapUpPhase(goal(undefined, open)), undefined);
	assert.doesNotMatch(taskListBlock(goal(undefined, open)), /Wrap-up:/);
});

test("a started phase is not told to wrap up", () => {
	const block = taskListBlock(goal("p1"));
	assert.match(block, /Current: p1 · Phase one/);
	assert.doesNotMatch(block, /Wrap-up:/, "Current already names it");
});

test("nested phases wrap up from the inside out", () => {
	const nested = phases();
	nested.tasks = [{
		id: "outer", title: "Outer", status: "pending", verificationContract: "Outer acceptance",
		subtasks: [{
			id: "inner", title: "Inner", status: "pending", verificationContract: "Inner acceptance",
			subtasks: [{ id: "leaf", title: "Leaf", status: "complete", completedAt: "2026-11-13T00:00:00.000Z" }],
		}],
	}];
	assert.equal(wrapUpPhase(goal(undefined, nested))?.id, "inner");
});

test("lightweight subtasks keep their existing meaning", () => {
	const light = phases();
	light.tasks[0] = {
		id: "p1", title: "Phase one", status: "pending", lightweightSubtasks: true,
		subtasks: [{ id: "1.1", title: "Step one one", status: "complete", completedAt: "2026-11-13T00:00:00.000Z" }],
	};
	assert.equal(wrapUpPhase(goal(undefined, light)), undefined, "a checklist is not a phase to close");
});

test("disableTasks keeps the block and the wrap-up empty", () => {
	assert.equal(taskListBlock(goal(), { disableTasks: true } as never), "");
	assert.equal(wrapUpPhase(goal(), { disableTasks: true } as never), undefined);
});

test("the block never changes the goal it was given", () => {
	const g = goal();
	const before = structuredClone(g);
	taskListBlock(g);
	assert.deepEqual(g, before, "display derivation never writes back the focus");
});
