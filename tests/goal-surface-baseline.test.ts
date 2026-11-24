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

import {
	ALL_REGISTERED_GOAL_TOOLS,
	CORE_GOAL_TOOL_NAMES,
	DRAFTING_GOAL_TOOLS,
	FIVE_GOAL_TOOLS,
} from "../extensions/goal-tool-names.ts";
import { createExtensionHarness } from "./support/extension-harness.ts";

// ── Extension on the shared fake host ───────────────────────────────────────

function loadExtension() {
	const { toolNames, commandNames } = createExtensionHarness({ cwd: process.cwd() });
	return { registeredTools: toolNames, registeredCommands: commandNames };
}

// ── The pinned baseline ──────────────────────────────────────────────────────

/**
 * The five goal tools registered today (registration order, which is also the
 * order pi exposes them in the model tool list), registered by
 * goal-core-tools.ts and goal-task-tools.ts.
 */
const EXPECTED_REGISTERED_TOOLS = [
	"get_goal",
	"create_goal",
	"update_goal",
	"set_goal_tasks",
	"update_goal_task",
	"goal_questionnaire",
	"propose_goal_draft",
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
	"goal-cancel",
	"goal-direct",
	"sisyphus-direct",
	"goal-list",
	"goal-status",
	"goal-refresh",
	"goal-recovery",
	"goal-focus",
	"goal-unfocus",
	"goal-settings",
	"goal-tweak",
	"goal-clear",
	"goal-pause",
	"goal-resume",
] as const;

test("baseline: execution and drafting tools are registered in pinned order", () => {
	const { registeredTools } = loadExtension();

	assert.deepEqual(registeredTools, [...EXPECTED_REGISTERED_TOOLS]);
});

test("baseline: exactly 16 slash commands are registered, in pinned order", () => {
	const { registeredCommands } = loadExtension();

	assert.deepEqual(registeredCommands, [...EXPECTED_REGISTERED_COMMANDS]);
});

test("baseline: no duplicate tool or command registrations", () => {
	const { registeredTools, registeredCommands } = loadExtension();

	assert.equal(new Set(registeredTools).size, registeredTools.length);
	assert.equal(new Set(registeredCommands).size, registeredCommands.length);
});

test("baseline: execution profiles remain three/five tools and drafting is separate", () => {
	assert.deepEqual(FIVE_GOAL_TOOLS, [
		"create_goal", "get_goal", "update_goal",
		"set_goal_tasks", "update_goal_task",
	]);
	assert.deepEqual(CORE_GOAL_TOOL_NAMES, [
		"create_goal", "get_goal", "update_goal",
	]);
	assert.deepEqual(DRAFTING_GOAL_TOOLS, [
		"goal_questionnaire", "propose_goal_draft",
	]);
});

test("baseline: every registered tool name is referenced by goal-tool-names constants", () => {
	const { registeredTools } = loadExtension();

	// Every registered goal tool must be named by goal-tool-names.ts so the
	// surface stays centralized.
	const knownNames = new Set<string>([...ALL_REGISTERED_GOAL_TOOLS]);
	for (const tool of registeredTools) {
		assert.ok(knownNames.has(tool), `registered tool ${tool} is not named in goal-tool-names.ts`);
	}
});
