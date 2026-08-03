import assert from "node:assert/strict";
import test from "node:test";

import {
	ABORT_GOAL_TOOL_NAME,
	ACTIVE_GOAL_TOOL_NAMES,
	CORE_GOAL_TOOL_NAMES,
	CREATE_GOAL_TOOL_NAME,
	GET_GOAL_TOOL_NAME,
	GOAL_WORK_TOOL_NAMES,
	GOAL_PROGRESS_TOOL_NAMES,
	NO_FOCUSED_GOAL_TOOL_NAMES,
	PAUSED_GOAL_TOOL_NAMES,
	POST_STOP_ALLOWED_TOOLS,
	PROPOSE_DRAFT_TOOL_NAME,
	PROPOSE_TWEAK_TOOL_NAME,
	QUESTIONNAIRE_TOOL_NAME,
	QUESTION_TOOL_NAME,
	SISYPHUS_STEP_TOOL_NAME,
	TASK_TOOL_NAMES,
	UPDATE_GOAL_TOOL_NAME,
	isQuestionLikeToolName,
	lifecycleToolNamesForGoalStatus,
} from "../extensions/goal-tool-names.ts";

const CORE = ["create_goal", "get_goal", "update_goal"];

test("goal tool names are centralized and preserve published agent-facing names", () => {
	assert.equal(QUESTION_TOOL_NAME, "goal_question");
	assert.equal(QUESTIONNAIRE_TOOL_NAME, "goal_questionnaire");
	assert.equal(PROPOSE_DRAFT_TOOL_NAME, "propose_goal_draft");
	assert.equal(PROPOSE_TWEAK_TOOL_NAME, "propose_goal_tweak");
	assert.equal(SISYPHUS_STEP_TOOL_NAME, "step_complete");
	assert.equal(CREATE_GOAL_TOOL_NAME, "create_goal");
	assert.equal(GET_GOAL_TOOL_NAME, "get_goal");
	assert.equal(UPDATE_GOAL_TOOL_NAME, "update_goal");
	assert.equal(ABORT_GOAL_TOOL_NAME, "abort_goal");
	assert.deepEqual(CORE_GOAL_TOOL_NAMES, ["create_goal", "get_goal", "update_goal"]);
	assert.deepEqual(ACTIVE_GOAL_TOOL_NAMES, ["create_goal", "get_goal", "update_goal", "propose_task_list", "complete_task", "skip_task"]);
	assert.deepEqual(PAUSED_GOAL_TOOL_NAMES, ["create_goal", "get_goal", "update_goal", "propose_task_list"]);
	assert.deepEqual(NO_FOCUSED_GOAL_TOOL_NAMES, ["get_goal", "create_goal"]);
	assert.deepEqual(POST_STOP_ALLOWED_TOOLS, ["get_goal"]);
});

test("lifecycle tool visibility keeps no-focus read-only and focused mutations scoped", () => {
	assert.deepEqual(lifecycleToolNamesForGoalStatus(null), ["get_goal", "create_goal"]);
	assert.deepEqual(lifecycleToolNamesForGoalStatus("active", "drafting"), ["get_goal", "create_goal"]);
	assert.deepEqual(lifecycleToolNamesForGoalStatus("paused", "tweakDrafting"), ["get_goal", "create_goal"]);
	assert.deepEqual(lifecycleToolNamesForGoalStatus("complete"), ["get_goal", "create_goal"]);
	assert.deepEqual(lifecycleToolNamesForGoalStatus("active"), ["create_goal", "get_goal", "update_goal", "propose_task_list", "complete_task", "skip_task"]);
	assert.deepEqual(lifecycleToolNamesForGoalStatus("paused"), ["create_goal", "get_goal", "update_goal", "propose_task_list"]);
});

test("progress tool set excludes read-only and drafting dialogue tools", () => {
	for (const toolName of ["get_goal", QUESTION_TOOL_NAME, QUESTIONNAIRE_TOOL_NAME, PROPOSE_DRAFT_TOOL_NAME, PROPOSE_TWEAK_TOOL_NAME, CREATE_GOAL_TOOL_NAME]) {
		assert.equal(GOAL_PROGRESS_TOOL_NAMES.includes(toolName as typeof GOAL_PROGRESS_TOOL_NAMES[number]), false, toolName);
	}
	for (const toolName of ["bash", "read", "write", UPDATE_GOAL_TOOL_NAME, "complete_task", "skip_task"]) {
		assert.equal(GOAL_PROGRESS_TOOL_NAMES.includes(toolName as typeof GOAL_PROGRESS_TOOL_NAMES[number]), true, toolName);
	}
});

test("goal work tool set keeps lifecycle and workhorse tools visible to continuation gating", () => {
	for (const toolName of [
		PROPOSE_TWEAK_TOOL_NAME,
		CREATE_GOAL_TOOL_NAME,
		UPDATE_GOAL_TOOL_NAME,
		GET_GOAL_TOOL_NAME,
		PROPOSE_DRAFT_TOOL_NAME,
		QUESTION_TOOL_NAME,
		QUESTIONNAIRE_TOOL_NAME,
		"bash",
		"write",
	]) {
		assert.equal(GOAL_WORK_TOOL_NAMES.includes(toolName as typeof GOAL_WORK_TOOL_NAMES[number]), true);
	}
	assert.equal(GOAL_WORK_TOOL_NAMES.includes(SISYPHUS_STEP_TOOL_NAME as typeof GOAL_WORK_TOOL_NAMES[number]), false);
	assert.equal(GOAL_WORK_TOOL_NAMES.includes(ABORT_GOAL_TOOL_NAME as typeof GOAL_WORK_TOOL_NAMES[number]), false);
});

test("isQuestionLikeToolName allows dialogue tools but not workhorse tools", () => {
	for (const name of [QUESTION_TOOL_NAME, QUESTIONNAIRE_TOOL_NAME, "question", "questionnaire", "ask_user", "clarify_scope", "confirm_choice"]) {
		assert.equal(isQuestionLikeToolName(name), true, name);
	}
	for (const name of ["bash", "read", "write", "edit", "grep", "find", "ls", "step_complete", "pause_goal", "abort_goal"]) {
		assert.equal(isQuestionLikeToolName(name), false, name);
	}
});

test("lifecycleToolNamesForGoalStatus covers all status x phase combinations", () => {
	const statuses = [null, undefined, "active", "paused", "blocked", "budget_limited", "complete"] as const;
	const phases = ["normal", "drafting", "tweakDrafting"] as const;

	for (const status of statuses) {
		for (const phase of phases) {
			const tools = lifecycleToolNamesForGoalStatus(status, phase);
			assert.ok(Array.isArray(tools), `should return an array for status=${status}, phase=${phase}`);
			assert.ok(tools.length >= 1, `should have at least one tool for status=${status}, phase=${phase}`);
			if (phase === "drafting" || phase === "tweakDrafting") {
				assert.deepEqual(tools, ["get_goal", "create_goal"], `drafting phase should only expose read/create for status=${status}`);
			} else if (status === "active") {
				assert.deepEqual(tools, ["create_goal", "get_goal", "update_goal", "propose_task_list", "complete_task", "skip_task"]);
			} else if (status === "paused") {
				assert.deepEqual(tools, ["create_goal", "get_goal", "update_goal", "propose_task_list"]);
			} else {
				assert.deepEqual(tools, ["get_goal", "create_goal"]);
			}
		}
	}
});

test("ACTIVE_GOAL_TOOL_NAMES contains every registered core lifecycle tool", () => {
	for (const name of CORE) {
		assert.ok(ACTIVE_GOAL_TOOL_NAMES.includes(name as typeof ACTIVE_GOAL_TOOL_NAMES[number]),
			`active goal tool set must include ${name}`);
	}
	// Old lifecycle tools are non-advertised compatibility shims.
	for (const name of ["complete_goal", "pause_goal", ABORT_GOAL_TOOL_NAME, PROPOSE_TWEAK_TOOL_NAME]) {
		assert.equal(ACTIVE_GOAL_TOOL_NAMES.includes(name as typeof ACTIVE_GOAL_TOOL_NAMES[number]), false,
			`active goal tool set must NOT include ${name}`);
	}
});

test("POST_STOP_ALLOWED_TOOLS only includes get_goal", () => {
	assert.equal(POST_STOP_ALLOWED_TOOLS.length, 1, "post-stop allowlist should be minimal");
	assert.equal(POST_STOP_ALLOWED_TOOLS[0], "get_goal");
});

test("PAUSED_GOAL_TOOL_NAMES excludes pause_goal, abort_goal and task completion tools", () => {
	assert.equal(PAUSED_GOAL_TOOL_NAMES.includes("pause_goal" as any), false);
	assert.equal(PAUSED_GOAL_TOOL_NAMES.includes(ABORT_GOAL_TOOL_NAME as any), false);
	assert.equal(PAUSED_GOAL_TOOL_NAMES.includes("complete_task" as any), false);
	assert.equal(PAUSED_GOAL_TOOL_NAMES.includes("skip_task" as any), false);
});

test("NO_FOCUSED_GOAL_TOOL_NAMES has get_goal and create_goal", () => {
	assert.equal(NO_FOCUSED_GOAL_TOOL_NAMES.length, 2);
	assert.deepEqual([...NO_FOCUSED_GOAL_TOOL_NAMES].sort(), ["create_goal", "get_goal"]);
});

test("GOAL_WORK_TOOL_NAMES includes core + shim + work tools", () => {
	const expectedWork = [
		UPDATE_GOAL_TOOL_NAME,
		"propose_goal_tweak",
		"propose_task_list",
		"complete_task",
		"skip_task",
		"create_goal",
		"propose_goal_draft",
		"goal_question",
		"goal_questionnaire",
		"get_goal",
		"write",
		"edit",
		"bash",
		"read",
		"grep",
		"find",
		"ls",
	];
	for (const name of expectedWork) {
		assert.ok(GOAL_WORK_TOOL_NAMES.includes(name as typeof GOAL_WORK_TOOL_NAMES[number]),
			`GOAL_WORK_TOOL_NAMES must include ${name}`);
	}
	// step_complete and the removed lifecycle shims should be excluded
	assert.equal(GOAL_WORK_TOOL_NAMES.includes("step_complete" as any), false);
	assert.equal(GOAL_WORK_TOOL_NAMES.includes("complete_goal" as any), false);
	assert.equal(GOAL_WORK_TOOL_NAMES.includes("pause_goal" as any), false);
	assert.equal(GOAL_WORK_TOOL_NAMES.includes(ABORT_GOAL_TOOL_NAME as any), false);
});

test("GOAL_PROGRESS_TOOL_NAMES excludes drafting and dialogue tools", () => {
	const excluded = ["get_goal", "goal_question", "goal_questionnaire", "propose_goal_draft", "propose_goal_tweak", "create_goal"];
	for (const name of excluded) {
		assert.equal(GOAL_PROGRESS_TOOL_NAMES.includes(name as typeof GOAL_PROGRESS_TOOL_NAMES[number]), false,
			`progress set must exclude ${name}`);
	}
	const included = [UPDATE_GOAL_TOOL_NAME, "complete_task", "skip_task", "write", "edit", "bash", "read"];
	for (const name of included) {
		assert.equal(GOAL_PROGRESS_TOOL_NAMES.includes(name as typeof GOAL_PROGRESS_TOOL_NAMES[number]), true,
			`progress set must include ${name}`);
	}
});

test("TASK_TOOL_NAMES are the legacy three and separate from the core", () => {
	assert.deepEqual(TASK_TOOL_NAMES, ["propose_task_list", "complete_task", "skip_task"]);
	for (const name of CORE) {
		assert.equal(TASK_TOOL_NAMES.includes(name as any), false);
	}
});
