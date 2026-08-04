import assert from "node:assert/strict";
import test from "node:test";

import {
	ALL_REGISTERED_GOAL_TOOLS,
	CORE_GOAL_TOOL_NAMES,
	CORE_GOAL_TOOLS,
	CREATE_GOAL_TOOL_NAME,
	FIVE_GOAL_TOOLS,
	GET_GOAL_TOOL_NAME,
	GOAL_PROGRESS_TOOL_NAMES,
	GOAL_WORK_TOOL_NAMES,
	POST_STOP_ALLOWED_TOOLS,
	SET_GOAL_TASKS_TOOL_NAME,
	TASK_TOOL_NAMES,
	UPDATE_GOAL_TASK_TOOL_NAME,
	UPDATE_GOAL_TOOL_NAME,
} from "../extensions/goal-tool-names.ts";

const CORE = ["create_goal", "get_goal", "update_goal"];

// Every removed drafting/lifecycle tool name — none may exist in the module.
const REMOVED = [
	"propose_goal_draft", "propose_goal_tweak", "step_complete", "goal_question",
	"goal_questionnaire", "abort_goal", "propose_task_list", "complete_task",
	"skip_task", "complete_goal", "pause_goal",
];

test("the five public tool names are preserved", () => {
	assert.equal(CREATE_GOAL_TOOL_NAME, "create_goal");
	assert.equal(GET_GOAL_TOOL_NAME, "get_goal");
	assert.equal(UPDATE_GOAL_TOOL_NAME, "update_goal");
	assert.equal(SET_GOAL_TASKS_TOOL_NAME, "set_goal_tasks");
	assert.equal(UPDATE_GOAL_TASK_TOOL_NAME, "update_goal_task");
});

test("fixed profiles: core three, task two, all five registered", () => {
	assert.deepEqual(CORE_GOAL_TOOL_NAMES, CORE);
	assert.deepEqual(TASK_TOOL_NAMES, ["set_goal_tasks", "update_goal_task"]);
	assert.deepEqual(FIVE_GOAL_TOOLS, [...CORE, ...TASK_TOOL_NAMES]);
	assert.deepEqual(CORE_GOAL_TOOLS, CORE);
	assert.deepEqual(ALL_REGISTERED_GOAL_TOOLS, FIVE_GOAL_TOOLS);
});

test("the reduced module exposes no removed constants or heuristics", async () => {
	const fs = await import("node:fs/promises");
	const source = await fs.readFile("extensions/goal-tool-names.ts", "utf8");
	for (const removed of REMOVED) {
		assert.ok(!source.includes(`const ${removed.toUpperCase().replace(/-/g, "_")}_TOOL_NAME`),
			`removed constant ${removed} must not exist in goal-tool-names.ts`);
	}
	assert.ok(!source.includes("GoalToolPhase"), "GoalToolPhase must be gone");
	assert.ok(!source.includes("lifecycleToolNamesForGoalStatus"), "lifecycleToolNamesForGoalStatus must be gone");
	assert.ok(!source.includes("isQuestionLikeToolName"), "question heuristics must be gone");
});

test("progress tool set excludes read-only surface tools and workhorse includes them", () => {
	for (const name of ["get_goal", "create_goal"]) {
		assert.equal(GOAL_PROGRESS_TOOL_NAMES.includes(name as typeof GOAL_PROGRESS_TOOL_NAMES[number]), false, name);
	}
	for (const name of [UPDATE_GOAL_TOOL_NAME, UPDATE_GOAL_TASK_TOOL_NAME, "write", "edit", "bash", "read"]) {
		assert.equal(GOAL_PROGRESS_TOOL_NAMES.includes(name as typeof GOAL_PROGRESS_TOOL_NAMES[number]), true, name);
	}
});

test("work tool set covers the five goal tools plus common host work tools", () => {
	for (const name of FIVE_GOAL_TOOLS) {
		assert.ok(GOAL_WORK_TOOL_NAMES.includes(name as typeof GOAL_WORK_TOOL_NAMES[number]), `work set must include ${name}`);
	}
	for (const name of ["bash", "write", "read", "edit", "grep", "find", "ls"]) {
		assert.ok(GOAL_WORK_TOOL_NAMES.includes(name as typeof GOAL_WORK_TOOL_NAMES[number]), `work set must include ${name}`);
	}
	for (const removed of REMOVED) {
		assert.equal(GOAL_WORK_TOOL_NAMES.includes(removed as typeof GOAL_WORK_TOOL_NAMES[number]), false,
			`work set must not include ${removed}`);
	}
});

test("POST_STOP_ALLOWED_TOOLS only includes get_goal", () => {
	assert.equal(POST_STOP_ALLOWED_TOOLS.length, 1, "post-stop allowlist should be minimal");
	assert.equal(POST_STOP_ALLOWED_TOOLS[0], "get_goal");
});
