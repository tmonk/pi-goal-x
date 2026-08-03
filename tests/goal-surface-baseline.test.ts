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
 * The 14 goal tools registered today (registration order, which is also the
 * order pi exposes them in the model tool list):
 * goal_question, goal_questionnaire (from goal-questionnaire.ts), then the
 * twelve tools registered in goal.ts (Stage 3 added update_goal and made
 * create_goal real).
 */
const EXPECTED_REGISTERED_TOOLS = [
	"get_goal",
	"create_goal",
	"update_goal",
	"set_goal_tasks",
	"update_goal_task",
] as const;

/**
 * The 10 slash commands registered today (the curated Stage 5 palette):
 * /goal and /sisyphus are the two direct creation paths (bare /goal shows
 * status); the remaining eight are dedicated lifecycle commands. The five
 * legacy/aliased commands (/goal-status, /goals, /goals-set, /sisyphus-set,
 * /goal-abort) are removed with documented mappings.
 */
const EXPECTED_REGISTERED_COMMANDS = [
	"goal",
	"sisyphus",
	"goal-list",
	"goal-focus",
	"goal-unfocus",
	"goal-settings",
	"goal-tweak",
	"goal-clear",
	"goal-pause",
	"goal-resume",
] as const;

test("baseline: exactly 5 goal tools are registered, in pinned order", () => {
	const { pi, registeredTools } = createRecordingPi();
	piGoalExtension(pi as never);

	assert.deepEqual(registeredTools, [...EXPECTED_REGISTERED_TOOLS]);
});

test("baseline: exactly 10 slash commands are registered, in pinned order", () => {
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

test("baseline: advertised tool sets are the Stage 6 five-tool surface", () => {
	// Stage 3 installs the stable three-tool core (create_goal, get_goal,
	// update_goal) without phase-dependent synchronization. The legacy task
	// tools remain advertised until Stage 4 replaces them.
	assert.deepEqual(ACTIVE_GOAL_TOOL_NAMES, [
		"create_goal", "get_goal", "update_goal",
		"set_goal_tasks", "update_goal_task",
	]);
	assert.deepEqual(PAUSED_GOAL_TOOL_NAMES, [
		"create_goal", "get_goal", "update_goal", "set_goal_tasks",
	]);
	assert.deepEqual(NO_FOCUSED_GOAL_TOOL_NAMES, ["get_goal", "create_goal"]);
});

test("baseline: every registered tool name is referenced by goal-tool-names constants", () => {
	const { pi, registeredTools } = createRecordingPi();
	piGoalExtension(pi as never);

	// All 14 registered tools must be named by goal-tool-names.ts so the
	// surface stays centralized.
	const knownNames = new Set<string>([
		...ACTIVE_GOAL_TOOL_NAMES,
		...PAUSED_GOAL_TOOL_NAMES,
		...NO_FOCUSED_GOAL_TOOL_NAMES,
	]);
	for (const tool of registeredTools) {
		assert.ok(knownNames.has(tool), `registered tool ${tool} is not named in goal-tool-names.ts`);
	}
});
