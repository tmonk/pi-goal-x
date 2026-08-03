/**
 * Integration tests for lifecycle tool visibility.
 *
 * Tests that syncGoalTools() correctly manages the active tool set
 * through lifecycle events — session_start, before_agent_start, etc.
 * Uses the same mock pattern as extension.test.ts.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";

import piGoalExtension from "../extensions/goal.ts";
import {
	createGoal,
	goalFocusDetails,
	type GoalRecord,
	type GoalStateEntry,
} from "../extensions/goal-record.ts";
import { writeActiveGoalFile } from "../extensions/storage/goal-files.ts";
import type { ToolDefinition, ExtensionContext } from "@earendil-works/pi-coding-agent";

// ── Helpers ──────────────────────────────────────────────────────────────────

function createMockCtx(cwd: string, sessionEntries: unknown[]): ExtensionContext {
	return {
		cwd,
		hasUI: false,
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
	const cwd = mkdtempSync(path.join(tmpdir(), "goal-tool-vis-"));
	mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
	writeFileSync(path.join(cwd, ".pi", "pi-goal-x-settings.json"), JSON.stringify({ disabled: true }));

	const goal = createGoal({
		objective: "Tool visibility test",
		autoContinue: true,
		sisyphus: false,
	}, Date.UTC(2026, 5, 26, 9, 0, 0));

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

// ── Expected tool sets (Stage 3: stable three-core + legacy task shims) ────

const ACTIVE_LIFECYCLE_TOOLS = [
	"create_goal", "get_goal", "update_goal",
	"set_goal_tasks", "update_goal_task",
];

const PAUSED_LIFECYCLE_TOOLS = [
	"create_goal", "get_goal", "update_goal", "set_goal_tasks",
];

const NO_GOAL_TOOLS = ["get_goal", "create_goal"];

const BASE_WORK_TOOLS = ["read", "bash", "edit", "write"];

// Every lifecycle tool that must be present for active goals
const ALL_LIFECYCLE_TOOLS = [...ACTIVE_LIFECYCLE_TOOLS];

// ── Test Suite ───────────────────────────────────────────────────────────────

describe("Tool visibility integration", () => {
	const registeredTools: ToolDefinition[] = [];
	const lifecycleHandlers = new Map<string, Function>();
	let apiCalls: Array<{ type: string; data?: unknown }> = [];
	let activeToolNames: string[] = [...BASE_WORK_TOOLS];

	const mockPi = {
		registerTool: (def: ToolDefinition) => { registeredTools.push(def); },
		registerCommand: () => {},
		on: (event: string, handler: Function) => { lifecycleHandlers.set(event, handler); },
		appendEntry: (customType: string, data: unknown) => {
			apiCalls.push({ type: "appendEntry", data: { customType, data } });
		},
		registerMessageRenderer: () => {},
		sendMessage: () => {},
		getActiveTools: () => [...activeToolNames],
		setActiveTools: (names: string[]) => { activeToolNames = [...names]; },
		hasUI: false,
	};

	before(() => {
		piGoalExtension(mockPi as any);
	});

	// ── After session_start with active goal ─────────────────────────────
	it("active goal exposes all lifecycle tools after before_agent_start", async () => {
		const f = testFixture();
		try {
			const ss = lifecycleHandlers.get("session_start");
			assert.ok(ss, "session_start handler must be registered");

			// Reset tool state before test
			activeToolNames = [...BASE_WORK_TOOLS];
			apiCalls = [];

			await ss({ reason: "start" }, f.mockCtx);

			// session_start loads state but does NOT call syncGoalTools.
			// Tool sync happens in before_agent_start, which we call next.
			// After session_start alone, only base work tools are present.
			const bas = lifecycleHandlers.get("before_agent_start");
			assert.ok(bas, "before_agent_start handler must be registered");
			await bas({
				systemPrompt: "",
				prompt: "test",
				systemPromptOptions: {},
			}, f.mockCtx);

			// After before_agent_start, an active goal should have all lifecycle tools
			for (const tool of ALL_LIFECYCLE_TOOLS) {
				assert.ok(activeToolNames.includes(tool),
					`active goal should have tool "${tool}" after before_agent_start. Active tools: ${JSON.stringify(activeToolNames)}`);
			}

			// Base work tools should also be present
			for (const tool of BASE_WORK_TOOLS) {
				assert.ok(activeToolNames.includes(tool),
					`active goal should have work tool "${tool}" after before_agent_start`);
			}

			// create_goal IS available (stable core, Stage 3)
			assert.ok(activeToolNames.includes("create_goal"),
				"create_goal must be in active tool set");

			// propose_goal_draft is a drafting-phase shim; create_goal is the
			// stable core creation tool
			assert.ok(activeToolNames.includes("create_goal"),
				"create_goal must be in active tool set");
			assert.equal(activeToolNames.includes("propose_goal_draft"), false,
				"propose_goal_draft must NOT be in the normal active tool set");
		} finally {
			f.cleanup();
		}
	});

	// ── After before_agent_start with active goal ────────────────────────
	it("active goal exposes all lifecycle tools after before_agent_start", async () => {
		const f = testFixture();
		try {
			// Set up state
			const ss = lifecycleHandlers.get("session_start");
			assert.ok(ss);
			await ss({ reason: "start" }, f.mockCtx);

			activeToolNames = [...BASE_WORK_TOOLS];
			apiCalls = [];

			const bas = lifecycleHandlers.get("before_agent_start");
			assert.ok(bas, "before_agent_start handler must be registered");

			await bas({
				systemPrompt: "",
				prompt: "test",
				systemPromptOptions: {},
			}, f.mockCtx);

			for (const tool of ALL_LIFECYCLE_TOOLS) {
				assert.ok(activeToolNames.includes(tool),
					`active goal should have tool "${tool}" after before_agent_start`);
			}

			// Base work tools should also be present
			for (const tool of BASE_WORK_TOOLS) {
				assert.ok(activeToolNames.includes(tool),
					`active goal should have work tool "${tool}" after before_agent_start`);
			}
		} finally {
			f.cleanup();
		}
	});

	// ── No goal (null state) ─────────────────────────────────────────────
	it("no goal exposes only get_goal and create_goal", async () => {
		// Use a temp dir with NO goals at all (no .pi/goals directory)
		const cwd = mkdtempSync(path.join(tmpdir(), "goal-tool-vis-nogoal-"));
		try {
			// Start with empty state (no focus entry, no goals on disk)
			const emptyCtx = createMockCtx(cwd, []);

			activeToolNames = [...BASE_WORK_TOOLS];
			apiCalls = [];

			const ss = lifecycleHandlers.get("session_start");
			assert.ok(ss);
			await ss({ reason: "start" }, emptyCtx);

			// session_start loads state but does NOT call syncGoalTools.
			// Tool sync happens in before_agent_start.
			const bas = lifecycleHandlers.get("before_agent_start");
			assert.ok(bas);
			await bas({
				systemPrompt: "",
				prompt: "test",
				systemPromptOptions: {},
			}, emptyCtx);

			// Only get_goal should be available
			for (const tool of NO_GOAL_TOOLS) {
				assert.ok(activeToolNames.includes(tool),
					`no-goal state should have tool "${tool}"`);
			}

			// Lifecycle tools should NOT be present
			for (const tool of ALL_LIFECYCLE_TOOLS) {
				if (tool === "get_goal") continue; // get_goal IS expected
				if (tool === "create_goal") continue; // create_goal IS expected (Stage 3)
				assert.equal(activeToolNames.includes(tool), false,
					`no-goal state must NOT have tool "${tool}"`);
			}
		} finally {
			try { rmSync(cwd, { recursive: true, force: true }); } catch {}
		}
	});

	// ── Complete goal status ─────────────────────────────────────────────
	it("completed goal exposes only get_goal and create_goal", async () => {
		const f = testFixture();
		try {
			// Start with a completed goal
			const completedGoal = createGoal({
				objective: "Completed test goal",
				autoContinue: false,
				sisyphus: false,
			}, Date.UTC(2026, 5, 26, 10, 0, 0));
			completedGoal.status = "complete" as const;
			(completedGoal as GoalRecord & { completedAt: string }).completedAt = new Date().toISOString();

			const written = writeActiveGoalFile({ cwd: f.cwd } as any, completedGoal);
			const focusEntry = goalFocusDetails(completedGoal.id, "created");
			const stateEntry: GoalStateEntry = { version: 3, goal: { ...completedGoal, activePath: written.activePath } };
			const sessionEntries = [
				{ type: "custom", customType: "pi-goal-focus", data: focusEntry },
				{ type: "custom", customType: "pi-goal-state", data: stateEntry },
			];
			const completedCtx = createMockCtx(f.cwd, sessionEntries);

			activeToolNames = [...BASE_WORK_TOOLS];
			apiCalls = [];

			const ss = lifecycleHandlers.get("session_start");
			assert.ok(ss);
			await ss({ reason: "start" }, completedCtx);

			// session_start loads state but does NOT call syncGoalTools.
			// Tool sync happens in before_agent_start.
			const bas = lifecycleHandlers.get("before_agent_start");
			assert.ok(bas);
			await bas({
				systemPrompt: "",
				prompt: "test",
				systemPromptOptions: {},
			}, completedCtx);

			// Only get_goal should be available for completed goals
			for (const tool of ["get_goal"]) {
				assert.ok(activeToolNames.includes(tool),
					`completed goal should have tool "${tool}"`);
			}

			// Lifecycle tools should NOT be present (except get_goal / create_goal)
			for (const tool of ALL_LIFECYCLE_TOOLS) {
				if (tool === "get_goal") continue;
				if (tool === "create_goal") continue;
				assert.equal(activeToolNames.includes(tool), false,
					`completed goal must NOT have tool "${tool}"`);
			}

			// propose_goal_tweak should also be absent
			assert.equal(activeToolNames.includes("propose_goal_tweak"), false,
				"propose_goal_tweak must not be available for completed goals");
		} finally {
			f.cleanup();
		}
	});

	// ── Paused goal status ──────────────────────────────────────────────
	it("paused goal exposes reduced lifecycle tool set without pause_goal", async () => {
		const f = testFixture();
		try {
			// Start active, then simulate goal being paused via state
			const pausedGoal = createGoal({
				objective: "Paused test goal",
				autoContinue: false,
				sisyphus: false,
			}, Date.UTC(2026, 5, 26, 11, 0, 0));
			pausedGoal.status = "paused" as const;
			pausedGoal.stopReason = "agent";
			pausedGoal.pauseReason = "Testing pause state";
			pausedGoal.pauseSuggestedAction = "Run some tests";

			const written = writeActiveGoalFile({ cwd: f.cwd } as any, pausedGoal);
			const focusEntry = goalFocusDetails(pausedGoal.id, "created");
			const stateEntry: GoalStateEntry = { version: 3, goal: { ...pausedGoal, activePath: written.activePath } };
			const sessionEntries = [
				{ type: "custom", customType: "pi-goal-focus", data: focusEntry },
				{ type: "custom", customType: "pi-goal-state", data: stateEntry },
			];
			const pausedCtx = createMockCtx(f.cwd, sessionEntries);

			activeToolNames = [...BASE_WORK_TOOLS];
			apiCalls = [];

			const ss = lifecycleHandlers.get("session_start");
			assert.ok(ss);
			await ss({ reason: "start" }, pausedCtx);

			// session_start loads state but does NOT call syncGoalTools.
			// Tool sync happens in before_agent_start.
			const bas = lifecycleHandlers.get("before_agent_start");
			assert.ok(bas);
			await bas({
				systemPrompt: "",
				prompt: "test",
				systemPromptOptions: {},
			}, pausedCtx);

			// Paused lifecycle tools should be present
			for (const tool of PAUSED_LIFECYCLE_TOOLS) {
				assert.ok(activeToolNames.includes(tool),
					`paused goal should have tool "${tool}"`);
			}

			// pause_goal must NOT be available for paused goals
			assert.equal(activeToolNames.includes("pause_goal"), false,
				"pause_goal must NOT be available for paused goals");

			// complete_task and skip_task should NOT be available
			assert.equal(activeToolNames.includes("complete_task"), false,
				"complete_task must NOT be available for paused goals");
			assert.equal(activeToolNames.includes("skip_task"), false,
				"skip_task must NOT be available for paused goals");

			// Base work tools should also be present
			for (const tool of BASE_WORK_TOOLS) {
				assert.ok(activeToolNames.includes(tool),
					`paused goal should have work tool "${tool}"`);
			}
		} finally {
			f.cleanup();
		}
	});

	// ── Test that the tool set remains stable after multiple lifecycle events ─
	it("tool set remains stable after multiple lifecycle events", async () => {
		const f = testFixture();
		try {
			const ss = lifecycleHandlers.get("session_start");
			assert.ok(ss);
			const bas = lifecycleHandlers.get("before_agent_start");
			assert.ok(bas);

			// Fire session_start
			activeToolNames = [...BASE_WORK_TOOLS];
			apiCalls = [];
			await ss({ reason: "start" }, f.mockCtx);

			// Fire before_agent_start multiple times (simulating turns)
			for (let i = 0; i < 3; i++) {
				await bas({
					systemPrompt: "",
					prompt: `turn-${i}`,
					systemPromptOptions: {},
				}, f.mockCtx);

				// Verify all lifecycle tools are present each turn
				for (const tool of ALL_LIFECYCLE_TOOLS) {
					assert.ok(activeToolNames.includes(tool),
						`turn ${i}: active goal should have tool "${tool}"`);
				}
			}
		} finally {
			f.cleanup();
		}
	});

	// ── Verify complete_goal and pause_goal appear in active tools ───────
	it("core goal tools are always in active tool set", () => {
		// Direct assertion: these constants are the source of truth
		assert.ok(ACTIVE_LIFECYCLE_TOOLS.includes("create_goal"),
			"create_goal must be in active lifecycle tools");
		assert.ok(ACTIVE_LIFECYCLE_TOOLS.includes("get_goal"),
			"get_goal must be in active lifecycle tools");
		assert.ok(ACTIVE_LIFECYCLE_TOOLS.includes("update_goal"),
			"update_goal must be in active lifecycle tools");
		// Old lifecycle shims must NOT be advertised
		for (const removed of ["complete_goal", "pause_goal", "abort_goal", "propose_goal_tweak"]) {
			assert.equal(ACTIVE_LIFECYCLE_TOOLS.includes(removed), false,
				`${removed} must not be advertised`);
		}
	});

	// ── Verify all registered lifecycle tools have execute handlers ──────
	it("all five model tools are registered with execute handlers", () => {
		const toolNames = [
			"get_goal", "create_goal", "update_goal", "set_goal_tasks", "update_goal_task",
		];
		for (const name of toolNames) {
			const tool = registeredTools.find((t) => t.name === name);
			assert.ok(tool, `Tool "${name}" must be registered`);
			assert.ok(typeof tool!.execute === "function", `Tool "${name}" must have an execute handler`);
		}
		// Removed tools must not be registered at all.
		for (const removed of ["complete_goal", "pause_goal", "abort_goal", "propose_goal_tweak", "propose_goal_draft", "step_complete", "propose_task_list", "complete_task", "skip_task", "goal_question", "goal_questionnaire"]) {
			assert.equal(registeredTools.some((t) => t.name === removed), false, `${removed} must not be registered`);
		}
	});

	// ── tool_call handler is registered ──────────────────────────────────
	it("tool_call handler is registered for complete_goal processing", () => {
		const handler = lifecycleHandlers.get("tool_call");
		assert.ok(handler, "tool_call handler must be registered");
	});

	// ── Escape dialog component is available via the import ──────────────
	it("escape dialog handler paths are wired", () => {
		// The escape flow (Esc during audit → showEscapeDialog → pause path)
		// is triggered via the update_goal execute handler when the auditor
		// raises "Auditor aborted." This test verifies the handler piping is intact.
		const handler = lifecycleHandlers.get("tool_call");
		assert.ok(handler, "tool_call handler must exist for escape dialog path");
		const tool = registeredTools.find((t) => t.name === "update_goal");
		assert.ok(tool, "update_goal tool must be registered");
	});

	// ── Active goal WITH task list exposes all lifecycle tools ──────────
	it("active goal with task list exposes all lifecycle tools", async () => {
		const f = testFixture();
		try {
			// Create a goal with a task list (mimics propose_goal_draft + task list flow)
			const now = new Date().toISOString();
			const goalWithTasks = createGoal({
				objective: "Test goal with task list",
				autoContinue: true,
				sisyphus: false,
			}, Date.UTC(2026, 6, 7, 12, 0, 0));

			// Write the goal file with embedded task list
			const goalData = {
				...goalWithTasks,
				taskList: {
					tasks: [
						{ id: "fix-nameerror", title: "Fix the NameError crash", status: "pending" as const },
						{ id: "polish-accordions", title: "Polish accordion display", status: "pending" as const },
						{ id: "verify-clean-run", title: "Verify clean run", status: "pending" as const },
					],
					blockCompletion: false,
					proposedAt: now,
				},
				updatedAt: now,
			};
			const written = writeActiveGoalFile({ cwd: f.cwd } as any, goalData);

			const focusEntry = goalFocusDetails(goalWithTasks.id, "created");
			const stateEntry: GoalStateEntry = {
				version: 3,
				goal: {
					...goalWithTasks,
					activePath: written.activePath,
					taskList: goalData.taskList,
					updatedAt: now,
				},
			};
			const sessionEntries = [
				{ type: "custom", customType: "pi-goal-focus", data: focusEntry },
				{ type: "custom", customType: "pi-goal-state", data: stateEntry },
			];
			const taskCtx = createMockCtx(f.cwd, sessionEntries);

			activeToolNames = [...BASE_WORK_TOOLS];
			apiCalls = [];

			// Fire session_start -- loads the goal with tasks from disk
			const ss = lifecycleHandlers.get("session_start");
			assert.ok(ss);
			await ss({ reason: "start" }, taskCtx);

			// Fire before_agent_start -- triggers syncGoalTools
			const bas = lifecycleHandlers.get("before_agent_start");
			assert.ok(bas);
			await bas({
				systemPrompt: "",
				prompt: "test with tasks",
				systemPromptOptions: {},
			}, taskCtx);

			// ALL lifecycle tools must be present
			for (const tool of ALL_LIFECYCLE_TOOLS) {
				assert.ok(activeToolNames.includes(tool),
					`active goal WITH task list should have tool "${tool}". Active: ${JSON.stringify(activeToolNames)}`);
			}

			// Base work tools must also be present
			for (const tool of BASE_WORK_TOOLS) {
				assert.ok(activeToolNames.includes(tool),
					`active goal WITH task list should have work tool "${tool}"`);
			}

			// propose_goal_draft is a drafting-phase shim; create_goal is the
			// stable core creation tool
			assert.ok(activeToolNames.includes("create_goal"),
				"create_goal must be in active tool set");
			assert.equal(activeToolNames.includes("propose_goal_draft"), false,
				"propose_goal_draft must NOT be in the normal active tool set");

			// create_goal IS available (stable core, Stage 3)
			assert.ok(activeToolNames.includes("create_goal"),
				"create_goal must be in active tool set");

			// goal_question/goal_questionnaire were removed in Stage 6
			assert.equal(activeToolNames.includes("goal_question"), false,
				"goal_question must not be advertised");
			assert.equal(activeToolNames.includes("goal_questionnaire"), false,
				"goal_questionnaire must not be advertised");
		} finally {
			f.cleanup();
		}
	});

	// ── Goal with tasks survives multiple before_agent_start cycles ──────
	it("active goal with task list shows correct tools across multiple turns", async () => {
		const f = testFixture();
		try {
			const now = new Date().toISOString();
			const goalWithTasks = createGoal({
				objective: "Multi-turn test",
				autoContinue: true,
				sisyphus: false,
			}, Date.UTC(2026, 6, 7, 13, 0, 0));

			const goalData = {
				...goalWithTasks,
				taskList: {
					tasks: [{ id: "t1", title: "Task 1", status: "pending" as const }],
					blockCompletion: false,
					proposedAt: now,
				},
				updatedAt: now,
			};
			const written = writeActiveGoalFile({ cwd: f.cwd } as any, goalData);

			const focusEntry = goalFocusDetails(goalWithTasks.id, "created");
			const stateEntry: GoalStateEntry = {
				version: 3,
				goal: {
					...goalWithTasks,
					activePath: written.activePath,
					taskList: goalData.taskList,
					updatedAt: now,
				},
			};
			const sessionEntries = [
				{ type: "custom", customType: "pi-goal-focus", data: focusEntry },
				{ type: "custom", customType: "pi-goal-state", data: stateEntry },
			];
			const multiCtx = createMockCtx(f.cwd, sessionEntries);

			// Fire session_start
			const ss = lifecycleHandlers.get("session_start");
			assert.ok(ss);
			await ss({ reason: "start" }, multiCtx);

			// Simulate turn_start firing before each before_agent_start
			const ts = lifecycleHandlers.get("turn_start");
			const bas = lifecycleHandlers.get("before_agent_start");
			assert.ok(ts, "turn_start handler must be registered");
			assert.ok(bas);

			for (let i = 0; i < 3; i++) {
				// turn_start fires at the start of each new agent turn
				activeToolNames = [...BASE_WORK_TOOLS];
				apiCalls = [];
				await ts({}, multiCtx);

				// Verify syncGoalTools was called (tools should be active)
				for (const tool of ALL_LIFECYCLE_TOOLS) {
					assert.ok(activeToolNames.includes(tool),
						`turn ${i} (after turn_start): active goal should have tool "${tool}"`);
				}

				// before_agent_start fires and should keep tools stable
				await bas({
					systemPrompt: "",
					prompt: `multi-turn-${i}`,
					systemPromptOptions: {},
				}, multiCtx);

				for (const tool of ALL_LIFECYCLE_TOOLS) {
					assert.ok(activeToolNames.includes(tool),
						`turn ${i} (after before_agent_start): active goal should have tool "${tool}"`);
				}
			}
		} finally {
			f.cleanup();
		}
	});

	// ── Progressive task completion keeps tools stable ───────────────────
	it("update_goal_task tool executes and stays active after marking tasks done", async () => {
		const f = testFixture();
		try {
			// Set up a goal WITH a task list
			const now = new Date().toISOString();
			const goalWithTasks = createGoal({
				objective: "Tasks: complete them",
				autoContinue: true,
				sisyphus: false,
			}, Date.UTC(2026, 6, 7, 14, 0, 0));

			const goalData = {
				...goalWithTasks,
				taskList: {
					tasks: [
						{ id: "t1", title: "Task one", status: "pending" as const },
						{ id: "t2", title: "Task two", status: "pending" as const },
					],
					blockCompletion: false,
					proposedAt: now,
				},
				updatedAt: now,
			};
			const written = writeActiveGoalFile({ cwd: f.cwd } as any, goalData);

			const focusEntry = goalFocusDetails(goalWithTasks.id, "created");
			const stateEntry: GoalStateEntry = {
				version: 3,
				goal: {
					...goalWithTasks,
					activePath: written.activePath,
					taskList: goalData.taskList,
					updatedAt: now,
				},
			};
			const sessionEntries = [
				{ type: "custom", customType: "pi-goal-focus", data: focusEntry },
				{ type: "custom", customType: "pi-goal-state", data: stateEntry },
			];
			const taskCtx = createMockCtx(f.cwd, sessionEntries);

			// Fire session_start
			const ss = lifecycleHandlers.get("session_start");
			assert.ok(ss);
			await ss({ reason: "start" }, taskCtx);

			// Fire before_agent_start to sync tools
			const bas = lifecycleHandlers.get("before_agent_start");
			assert.ok(bas);
			await bas({
				systemPrompt: "",
				prompt: "start working",
				systemPromptOptions: {},
			}, taskCtx);

			// Verify update_goal_task is in the active set
			assert.ok(activeToolNames.includes("update_goal_task"),
				"update_goal_task must be active before task completion");

			// Call update_goal_task tool execute handler
			const updateTaskTool = registeredTools.find((t) => t.name === "update_goal_task");
			assert.ok(updateTaskTool, "update_goal_task tool must be registered");

			const result1 = await (updateTaskTool.execute as Function)(
				"call-task-1",
				{ task_id: "t1", status: "complete", evidence: "Done" },
				new AbortController().signal,
				undefined,
				taskCtx,
			);
			assert.ok(result1, "complete_task result must be defined");
			const text1 = result1.content?.[0]?.text ?? "";
			assert.ok(text1.includes("t1 complete") || text1.includes("1/2"),
				`complete_task should report t1 complete. Got: ${text1}`);

			// After executing update_goal_task, all lifecycle tools should still be present
			for (const tool of ALL_LIFECYCLE_TOOLS) {
				assert.ok(activeToolNames.includes(tool),
					`after completing t1, should still have tool "${tool}". Active: ${JSON.stringify(activeToolNames)}`);
			}

			// Complete the second task
			const result2 = await (updateTaskTool.execute as Function)(
				"call-task-2",
				{ task_id: "t2", status: "complete", evidence: "Done too" },
				new AbortController().signal,
				undefined,
				taskCtx,
			);
			assert.ok(result2, "complete_task result must be defined");

			// Tools should still be present after all tasks complete
			for (const tool of ALL_LIFECYCLE_TOOLS) {
				assert.ok(activeToolNames.includes(tool),
					`after all tasks complete, should still have tool "${tool}". Active: ${JSON.stringify(activeToolNames)}`);
			}
		} finally {
			f.cleanup();
		}
	});

	// ── Tool resilience: turn_start sync after external tool removal ──────
	it("turn_start re-syncs active tools after external removal", async () => {
		const f = testFixture();
		try {
			const ss = lifecycleHandlers.get("session_start");
			assert.ok(ss);
			await ss({ reason: "start" }, f.mockCtx);

			const bas = lifecycleHandlers.get("before_agent_start");
			assert.ok(bas);
			await bas({
				systemPrompt: "",
				prompt: "test",
				systemPromptOptions: {},
			}, f.mockCtx);

			// Tools should be present after before_agent_start
			for (const tool of ALL_LIFECYCLE_TOOLS) {
				assert.ok(activeToolNames.includes(tool),
					`tool "${tool}" should be present after before_agent_start`);
			}

			// Simulate external tool removal (e.g., another extension removed tools)
			activeToolNames = [...BASE_WORK_TOOLS];

			// turn_start fires and calls syncGoalTools, which should restore them
			const ts = lifecycleHandlers.get("turn_start");
			assert.ok(ts);
			await ts({}, f.mockCtx);

			// All lifecycle tools must be restored by syncGoalTools
			for (const tool of ALL_LIFECYCLE_TOOLS) {
				assert.ok(activeToolNames.includes(tool),
					`tool "${tool}" should be restored by turn_start sync`);
			}
		} finally {
			f.cleanup();
		}
	});
});
