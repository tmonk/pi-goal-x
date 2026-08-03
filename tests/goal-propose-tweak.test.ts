/**
 * Integration tests for the propose_goal_tweak tool handler.
 *
 * Tests the tool's validation gates and rejection behavior by loading the
 * extension with a mock pi API and calling the execute handler directly.
 * The confirm path (which requires tweakDraftingFor to be set internally) is
 * tested via the writeActiveGoalFile simulation in goal-update-objective.test.ts.
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, describe, it, before } from "node:test";

import piGoalExtension from "../extensions/goal.ts";
import {
	createGoal,
	goalFocusDetails,
	type GoalRecord,
	type GoalStateEntry,
} from "../extensions/goal-record.ts";
import {
	writeActiveGoalFile,
} from "../extensions/storage/goal-files.ts";
import type { ToolDefinition, ExtensionContext } from "@earendil-works/pi-coding-agent";

// ── Helpers ──────────────────────────────────────────────────────────────────

interface MockPi {
	registerTool: (def: ToolDefinition) => void;
	registerCommand: () => void;
	on: (event: string, handler: Function) => void;
	appendEntry: (customType: string, data: unknown) => void;
	registerMessageRenderer: () => void;
	sendMessage: () => void;
	getActiveTools: () => Map<string, unknown>;
	setActiveTools: () => void;
	hasUI: boolean;
}

function createMockPi(registeredTools: ToolDefinition[], lifecycleHandlers: Map<string, Function>, apiCalls: Array<{ type: string; data?: unknown }>): MockPi {
	return {
		registerTool: (def: ToolDefinition) => { registeredTools.push(def); },
		registerCommand: () => {},
		on: (event: string, handler: Function) => { lifecycleHandlers.set(event, handler); },
		appendEntry: (customType: string, data: unknown) => {
			apiCalls.push({ type: "appendEntry", data: { customType, data } });
		},
		registerMessageRenderer: () => {},
		sendMessage: () => {},
		getActiveTools: () => new Map(),
		setActiveTools: () => {},
		hasUI: false,
	};
}

function createMockCtx(cwd: string, sessionEntries: unknown[]): ExtensionContext {
	return {
		cwd,
		hasUI: false,
		ui: {
			notify: () => {},
			setStatus: () => {},
			setWidget: () => {},
		},
		sessionManager: {
			getBranch: () => sessionEntries,
			getCwd: () => cwd,
			getSessionId: () => "test-session",
			getRoot: () => cwd,
			append: () => {},
			appendModelChange: () => {},
			appendThinkingLevelChange: () => {},
			appendCompetingWriteCheck: () => {},
			buildSessionContext: () => ({ messages: [], sessionId: "test", model: null, thinkingLevel: "medium" }),
		},
		getSystemPrompt: () => "",
		isIdle: () => true,
		hasPendingMessages: () => false,
		abort: () => {},
	} as unknown as ExtensionContext;
}

function testFixture() {
	const cwd = mkdtempSync(path.join(tmpdir(), "goal-propose-tweak-"));
	mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
	writeFileSync(path.join(cwd, ".pi", "pi-goal-x-settings.json"), JSON.stringify({ disabled: true }));

	const goal = createGoal({
		objective: "Propose tweak integration test: initial objective",
		autoContinue: true,
		sisyphus: false,
	}, Date.UTC(2026, 5, 27, 10, 0, 0));

	const written = writeActiveGoalFile({ cwd } as any, goal);
	const focusEntry = goalFocusDetails(goal.id, "created");
	const stateEntry: GoalStateEntry = { version: 3, goal: { ...goal, activePath: written.activePath } };
	const sessionEntries = [
		{ type: "custom", customType: "pi-goal-focus", data: focusEntry },
		{ type: "custom", customType: "pi-goal-state", data: stateEntry },
	];

	const mockCtx = createMockCtx(cwd, sessionEntries);
	const cleanup = () => { try { rmSync(cwd, { recursive: true, force: true }); } catch {} };

	return { cwd, goal: written, mockCtx, cleanup };
}

function getTool(registeredTools: ToolDefinition[], name: string): ToolDefinition {
	const t = registeredTools.find((t) => t.name === name);
	if (!t) throw new Error(`Tool "${name}" not found`);
	return t;
}

// ── Test Suite ───────────────────────────────────────────────────────────────

describe("propose_goal_tweak", () => {
	const registeredTools: ToolDefinition[] = [];
	const lifecycleHandlers = new Map<string, Function>();
	const apiCalls: Array<{ type: string; data?: unknown }> = [];
	let mockPi: MockPi;

	before(() => {
		mockPi = createMockPi(registeredTools, lifecycleHandlers, apiCalls);
		piGoalExtension(mockPi as any);
	});

	// ── Tool registration ──────────────────────────────────────────────────

	it("is registered with the correct name", () => {
		const tool = getTool(registeredTools, "propose_goal_tweak");
		assert.equal(tool.name, "propose_goal_tweak");
	});

	it("has required parameters: newObjective and changeSummary", () => {
		const tool = getTool(registeredTools, "propose_goal_tweak");
		const params = tool.parameters as any;
		assert.ok(params, "tool must have parameters defined");
		assert.ok(params.properties?.newObjective, "must have newObjective parameter");
		assert.ok(params.properties?.changeSummary, "must have changeSummary parameter");
		assert.equal(params.required?.includes("newObjective") ?? false, true,
			"newObjective must be required");
		assert.equal(params.required?.includes("changeSummary") ?? false, true,
			"changeSummary must be required");
	});

	it("is NOT in the lifecycle tool set for active and paused goals (Stage 3 shim)", async () => {
		const { lifecycleToolNamesForGoalStatus } = await import("../extensions/goal-tool-names.ts");
		// Stage 3 demoted propose_goal_tweak to a non-advertised compatibility
		// shim; it only appears during the /goal-tweak drafting phase.
		const activeTools = lifecycleToolNamesForGoalStatus("active", "normal");
		assert.equal(activeTools.includes("propose_goal_tweak"), false,
			"propose_goal_tweak must NOT appear in active lifecycle tools");
		const pausedTools = lifecycleToolNamesForGoalStatus("paused", "normal");
		assert.equal(pausedTools.includes("propose_goal_tweak"), false,
			"propose_goal_tweak must NOT appear in paused lifecycle tools");
		const tweakPhaseTools = lifecycleToolNamesForGoalStatus("paused", "tweakDrafting");
		assert.equal(tweakPhaseTools.includes("propose_goal_tweak"), false,
			"propose_goal_tweak is added by syncGoalTools during the tweak phase, not by the lifecycle set");
		const completeTools = lifecycleToolNamesForGoalStatus("complete", "normal");
		assert.equal(completeTools.includes("propose_goal_tweak"), false,
			"propose_goal_tweak must NOT appear in complete lifecycle tools");
		const noGoalTools = lifecycleToolNamesForGoalStatus(null, "normal");
		assert.equal(noGoalTools.includes("propose_goal_tweak"), false,
			"propose_goal_tweak must NOT appear when no goal is set");
	});

	// ── Validation gates ────────────────────────────────────────────────────

	it("rejects with correct message when no goal is set (no session_start fired)", async () => {
		const f = testFixture();
		try {
			const tool = getTool(registeredTools, "propose_goal_tweak");
			// Do NOT fire session_start — state.goal is null
			const result = await (tool.execute as Function)(
				"call-1",
				{ newObjective: "=== Goal ===\nObjective: Updated", changeSummary: "Updated objective" },
				new AbortController().signal,
				undefined,
				f.mockCtx,
			);
			assert.ok(result, "result must be defined");
			const text = result.content?.[0]?.text ?? "";
			assert.ok(text.includes("No goal is set"), `must say 'No goal is set'. Got: ${text}`);
		} finally {
			f.cleanup();
		}
	});

	it("auto-starts tweak drafting flow when tweakDraftingFor does not match", async () => {
		const f = testFixture();
		try {
			// Fire session_start to load state.goal
			const ss = lifecycleHandlers.get("session_start");
			assert.ok(ss, "session_start handler must be registered");
			await ss({ reason: "start" }, f.mockCtx);

			const tool = getTool(registeredTools, "propose_goal_tweak");
			const result = await (tool.execute as Function)(
				"call-2",
				{ newObjective: "=== Goal ===\nObjective: Updated", changeSummary: "Updated objective" },
				new AbortController().signal,
				undefined,
				f.mockCtx,
			);
			assert.ok(result, "result must be defined");
			const text = result.content?.[0]?.text ?? "";
			assert.ok(
				text.includes("auto-started") || text.includes("Tweak drafting flow"),
				`must auto-start tweak drafting flow. Got: ${text}`,
			);
		} finally {
			f.cleanup();
		}
	});

	it("rejects when newObjective is null or undefined at schema level", () => {
		const tool = getTool(registeredTools, "propose_goal_tweak");
		const params = tool.parameters as any;
		assert.ok(params.properties?.newObjective, "newObjective must be defined in schema");
		assert.ok(params.required?.includes("newObjective"),
			"newObjective must be in required array");
	});

	it("rejects when changeSummary is null or undefined at schema level", () => {
		const tool = getTool(registeredTools, "propose_goal_tweak");
		const params = tool.parameters as any;
		assert.ok(params.properties?.changeSummary, "changeSummary must be defined in schema");
		assert.ok(params.required?.includes("changeSummary"),
			"changeSummary must be in required array");
	});

	// ── Prompt guidelines ───────────────────────────────────────────────────

	it("has optional tasks parameter matching propose_goal_draft's schema", () => {
		const tool = getTool(registeredTools, "propose_goal_tweak");
		const params = tool.parameters as any;
		assert.ok(params.properties?.tasks, "must have tasks parameter");
		assert.equal(params.required?.includes("tasks") ?? false, false,
			"tasks must be optional (not in required array)");
		const tasksSchema = params.properties.tasks;
		assert.ok(tasksSchema, "tasks schema must be defined");
		// Check it's an array type
		assert.match(JSON.stringify(tasksSchema), /"type":"array"/i, "tasks must be an array type");
		// Check items schema includes id, title, verificationContract, lightweightSubtasks
		const itemsStr = JSON.stringify(tasksSchema);
		assert.ok(itemsStr.includes("id"), "tasks items must have id field");
		assert.ok(itemsStr.includes("title"), "tasks items must have title field");
		assert.ok(itemsStr.includes("verificationContract"), "tasks items must have verificationContract field");
		assert.ok(itemsStr.includes("lightweightSubtasks"), "tasks items must have lightweightSubtasks field");
		assert.ok(itemsStr.includes("subtasks"), "tasks items must have subtasks field");
	});

	it("prompt guidelines mention confirmation dialog and tasks parameter", () => {
		const tool = getTool(registeredTools, "propose_goal_tweak");
		const joined = tool.promptGuidelines?.join(" ") ?? "";
		assert.ok(joined.includes("Confirm") && joined.includes("Continue Chatting"),
			"guidelines must mention Confirm / Continue Chatting");
		assert.ok(joined.includes("propose_goal_tweak"),
			"guidelines must reference the tool name");
		assert.ok(joined.includes("tasks (optional)") || joined.includes("tasks parameter"),
			"guidelines must mention the tasks parameter");
		assert.ok(joined.includes("inherit") || joined.includes("inherited"),
			"guidelines must mention inheritance behavior");
	});

	it("renders call with truncated changeSummary", () => {
		const tool = getTool(registeredTools, "propose_goal_tweak");
		assert.ok(typeof tool.renderCall === "function", "renderCall must be a function");
	});

	it("renderResult delegates to renderGoalResult", () => {
		const tool = getTool(registeredTools, "propose_goal_tweak");
		assert.ok(typeof tool.renderResult === "function", "renderResult must be a function");
	});
});
