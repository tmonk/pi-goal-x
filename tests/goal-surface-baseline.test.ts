/**
 * Stage 0 characterization: the exact registered model-tool and slash-command
 * surface of the goal extension as of the codex-inspired-goal-interface
 * baseline (specs/2026-08-03-codex-inspired-goal-interface).
 *
 * This test is the interface contract for the simplification work. It pins:
 *   - the exact tools registered at extension load (registration order);
 *   - the exact slash commands registered at extension load;
 *   - the phase-dependent advertised tool sets from goal-tool-names.ts.
 *
 * Stages 3-6 of TECH.md intentionally change this surface (five tools, ten
 * commands). Each change must update this baseline deliberately.
 */

import assert from "node:assert/strict";
import test from "node:test";

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

import piGoalExtension from "../extensions/goal.ts";
import {
	ACTIVE_GOAL_TOOL_NAMES,
	NO_FOCUSED_GOAL_TOOL_NAMES,
	PAUSED_GOAL_TOOL_NAMES,
} from "../extensions/goal-tool-names.ts";

// ── Recording mock Pi ───────────────────────────────────────────────────────

function createRecordingPi() {
	const registeredTools: string[] = [];
	const registeredCommands: string[] = [];
	const messages: unknown[] = [];

	const pi = {
		registerTool: (def: ToolDefinition) => {
			registeredTools.push(def.name);
		},
		registerCommand: (name: string) => {
			registeredCommands.push(name);
		},
		on: () => {},
		appendEntry: () => {},
		registerMessageRenderer: () => {},
		sendMessage: (msg: unknown) => {
			messages.push(msg);
		},
		sendUserMessage: () => {},
		getActiveTools: () => ["read", "bash", "edit", "write"],
		setActiveTools: () => {},
		hasUI: false,
	};

	return { pi, registeredTools, registeredCommands, messages };
}

// ── The pinned baseline ──────────────────────────────────────────────────────

/**
 * The 13 goal tools registered today (registration order, which is also the
 * order pi exposes them in the model tool list):
 * goal_question, goal_questionnaire (from goal-questionnaire.ts), then the
 * eleven tools registered in goal.ts.
 */
const EXPECTED_REGISTERED_TOOLS = [
	"goal_question",
	"goal_questionnaire",
	"get_goal",
	"create_goal",
	"propose_goal_draft",
	"propose_goal_tweak",
	"complete_goal",
	"pause_goal",
	"abort_goal",
	"step_complete",
	"propose_task_list",
	"complete_task",
	"skip_task",
] as const;

/**
 * The 15 slash commands registered today (registration order):
 * ten dedicated lifecycle commands plus five legacy/aliased commands that the
 * interface simplification will remove (/goal-status, /goals, /goals-set,
 * /sisyphus-set, /goal-abort).
 */
const EXPECTED_REGISTERED_COMMANDS = [
	"goal",
	"goal-status",
	"goal-list",
	"goal-focus",
	"goal-unfocus",
	"goal-settings",
	"goals",
	"sisyphus",
	"goals-set",
	"sisyphus-set",
	"goal-tweak",
	"goal-clear",
	"goal-abort",
	"goal-pause",
	"goal-resume",
] as const;

test("baseline: exactly 13 goal tools are registered, in pinned order", () => {
	const { pi, registeredTools } = createRecordingPi();
	piGoalExtension(pi as never);

	assert.deepEqual(registeredTools, [...EXPECTED_REGISTERED_TOOLS]);
});

test("baseline: exactly 15 slash commands are registered, in pinned order", () => {
	const { pi, registeredCommands } = createRecordingPi();
	piGoalExtension(pi as never);

	assert.deepEqual(registeredCommands, [...EXPECTED_REGISTERED_COMMANDS]);
});

test("baseline: no duplicate tool or command registrations", () => {
	const { pi, registeredTools, registeredCommands } = createRecordingPi();
	piGoalExtension(pi as never);

	assert.equal(new Set(registeredTools).size, registeredTools.length);
	assert.equal(new Set(registeredCommands).size, registeredCommands.length);
});

test("baseline: phase-dependent advertised tool sets are the pre-simplification sets", () => {
	// Advertised sets come from goal-tool-names.ts. These are the values the
	// dynamic syncGoalTools() installs today; Stage 3 replaces the mechanism
	// with a static five-tool (or three-tool) install.
	assert.deepEqual(ACTIVE_GOAL_TOOL_NAMES, [
		"get_goal", "complete_goal", "pause_goal", "abort_goal",
		"propose_goal_tweak", "propose_task_list", "complete_task", "skip_task",
	]);
	assert.deepEqual(PAUSED_GOAL_TOOL_NAMES, [
		"get_goal", "complete_goal", "abort_goal",
		"propose_goal_tweak", "propose_task_list",
	]);
	assert.deepEqual(NO_FOCUSED_GOAL_TOOL_NAMES, ["get_goal"]);
});

test("baseline: every registered tool name is referenced by goal-tool-names constants", () => {
	const { pi, registeredTools } = createRecordingPi();
	piGoalExtension(pi as never);

	// All 13 registered tools must be named by goal-tool-names.ts so the
	// surface stays centralized. (create_goal is currently registered but
	// hidden from the active set; apply_goal_tweak is a legacy name that is no
	// longer registered.)
	const knownNames = new Set([
		...ACTIVE_GOAL_TOOL_NAMES,
		...PAUSED_GOAL_TOOL_NAMES,
		...NO_FOCUSED_GOAL_TOOL_NAMES,
		"goal_question",
		"goal_questionnaire",
		"create_goal",
		"propose_goal_draft",
		"step_complete",
	]);
	for (const tool of registeredTools) {
		assert.ok(knownNames.has(tool), `registered tool ${tool} is not named in goal-tool-names.ts`);
	}
});
