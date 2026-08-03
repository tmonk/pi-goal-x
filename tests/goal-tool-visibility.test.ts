/**
 * Integration tests for the fixed three/five goal-tool profile (Stage 2 of
 * specs/2026-08-04-goal-simplification-hardening).
 *
 * Invariance contract:
 *  - the advertised goal-tool set is exactly three (tasks disabled) or exactly
 *    five (tasks enabled) and never changes with focus, status, budget,
 *    completion, audit, or compaction transitions;
 *  - profile installation never enables or disables ordinary Pi work tools;
 *  - invalid lifecycle calls are rejected by the executor with a concise
 *    state-aware result, not by removing tools;
 *  - removed tools are never registered and never advertised.
 *
 * Uses the same mock pattern as goal-core-tools.test.ts.
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

// Fixed profiles (Stage 2). Lifecycle state never changes these.
const FIVE_GOAL_TOOLS = ["create_goal", "get_goal", "update_goal", "set_goal_tasks", "update_goal_task"];
const CORE_GOAL_TOOLS = ["create_goal", "get_goal", "update_goal"];

// Arbitrary host tool seeds: profile installation must never touch these.
const HOST_SEED_A = ["read", "bash", "edit", "write"];
const HOST_SEED_B = ["read", "grep", "find", "ls", "fetch", "custom-ext-tool"];

const REMOVED_TOOLS = [
	"complete_goal", "pause_goal", "abort_goal", "propose_goal_tweak",
	"propose_goal_draft", "step_complete", "propose_task_list",
	"complete_task", "skip_task", "goal_question", "goal_questionnaire",
];

// ── Test Suite ───────────────────────────────────────────────────────────────

describe("Tool profile invariance", () => {
	const registeredTools: ToolDefinition[] = [];
	const lifecycleHandlers = new Map<string, Function>();
	let apiCalls: Array<{ type: string; data?: unknown }> = [];
	let activeToolNames: string[] = [...HOST_SEED_A];

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

	function expectGoalProfile(expected: readonly string[]): void {
		for (const tool of expected) {
			assert.ok(activeToolNames.includes(tool),
				`goal tool "${tool}" must be advertised. Active: ${JSON.stringify(activeToolNames)}`);
		}
		for (const removed of REMOVED_TOOLS) {
			assert.equal(activeToolNames.includes(removed), false,
				`removed tool "${removed}" must never be advertised. Active: ${JSON.stringify(activeToolNames)}`);
		}
		// Exactly the expected goal tools: no extras, no missing.
		const goalTools = activeToolNames.filter((t) => [...expected, ...REMOVED_TOOLS].includes(t));
		assert.equal(goalTools.length, expected.length,
			`goal profile must be exactly [${expected.join(", ")}], got: ${JSON.stringify(goalTools)}`);
	}

	function expectHostUntouched(seed: readonly string[]): void {
		const host = activeToolNames.filter((t) => !FIVE_GOAL_TOOLS.includes(t));
		assert.deepEqual(host.sort(), [...seed].sort(),
			`host tool selection must be untouched. Active: ${JSON.stringify(activeToolNames)}`);
	}

	async function runSession(cwd: string, entries: unknown[]): Promise<void> {
		const ss = lifecycleHandlers.get("session_start");
		assert.ok(ss, "session_start handler must be registered");
		await ss({ reason: "start" }, createMockCtx(cwd, entries));
	}

	// ── Fixed profile across every lifecycle state ─────────────────────────
	it("active goal: profile is exactly five and host tools are untouched", async () => {
		const f = testFixture();
		try {
			activeToolNames = [...HOST_SEED_A];
			apiCalls = [];
			await runSession(f.cwd, f.mockCtx.sessionManager.getBranch() as unknown[]);
			expectGoalProfile(FIVE_GOAL_TOOLS);
			expectHostUntouched(HOST_SEED_A);
		} finally {
			f.cleanup();
		}
	});

	it("no-focus session keeps the full five-tool profile (no dynamic allowlist)", async () => {
		const cwd = mkdtempSync(path.join(tmpdir(), "goal-tool-vis-nogoal-"));
		try {
			mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
			activeToolNames = [...HOST_SEED_A];
			apiCalls = [];
			await runSession(cwd, []);
			// No goal at all — the fixed profile still advertises all five tools.
			expectGoalProfile(FIVE_GOAL_TOOLS);
			expectHostUntouched(HOST_SEED_A);
		} finally {
			try { rmSync(cwd, { recursive: true, force: true }); } catch {}
		}
	});

	it("every non-active status keeps the full five-tool profile", async () => {
		for (const status of ["paused", "blocked", "budget_limited", "complete"] as const) {
			const f = testFixture();
			try {
				const goal = createGoal({
					objective: `Status: ${status}`,
					autoContinue: status === "complete" ? false : true,
					sisyphus: false,
				}, Date.UTC(2026, 5, 26, 10, 0, 0));
				goal.status = status;
				if (status === "paused" || status === "blocked") {
					goal.stopReason = "agent";
					goal.pauseReason = "Testing";
				}
				const written = writeActiveGoalFile({ cwd: f.cwd } as any, goal);
				const entries = [
					{ type: "custom", customType: "pi-goal-focus", data: goalFocusDetails(goal.id, "created") },
					{ type: "custom", customType: "pi-goal-state", data: { version: 3, goal: { ...goal, activePath: written.activePath } } },
				];
				activeToolNames = [...HOST_SEED_A];
				apiCalls = [];
				await runSession(f.cwd, entries);
				expectGoalProfile(FIVE_GOAL_TOOLS);
				expectHostUntouched(HOST_SEED_A);
			} finally {
				f.cleanup();
			}
		}
	});

	it("tasks disabled: profile is exactly three across states", async () => {
		for (const status of ["active", "paused", "complete"] as const) {
			const cwd = mkdtempSync(path.join(tmpdir(), "goal-tool-vis-notasks-"));
			try {
				mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
				writeFileSync(path.join(cwd, ".pi", "pi-goal-x-settings.json"), JSON.stringify({ disableTasks: true }));
				const goal = createGoal({
					objective: `No tasks ${status}`,
					autoContinue: true,
					sisyphus: false,
				}, Date.UTC(2026, 5, 26, 11, 0, 0));
				if (status !== "active") goal.status = status;
				const written = writeActiveGoalFile({ cwd } as any, goal);
				const entries = [
					{ type: "custom", customType: "pi-goal-focus", data: goalFocusDetails(goal.id, "created") },
					{ type: "custom", customType: "pi-goal-state", data: { version: 3, goal: { ...goal, activePath: written.activePath } } },
				];
				activeToolNames = [...HOST_SEED_B];
				apiCalls = [];
				await runSession(cwd, entries);
				expectGoalProfile(CORE_GOAL_TOOLS);
				expectHostUntouched(HOST_SEED_B);
			} finally {
				try { rmSync(cwd, { recursive: true, force: true }); } catch {}
			}
		}
	});

	// ── Transitions never change the profile ───────────────────────────────
	it("turn_start / before_agent_start / turn_end cycles leave profile and host unchanged", async () => {
		const f = testFixture();
		try {
			activeToolNames = [...HOST_SEED_B];
			apiCalls = [];
			await runSession(f.cwd, f.mockCtx.sessionManager.getBranch() as unknown[]);
			expectGoalProfile(FIVE_GOAL_TOOLS);
			expectHostUntouched(HOST_SEED_B);

			const ts = lifecycleHandlers.get("turn_start")!;
			const bas = lifecycleHandlers.get("before_agent_start")!;
			const te = lifecycleHandlers.get("turn_end")!;
			assert.ok(ts && bas && te);
			const ctx = f.mockCtx;
			for (let i = 0; i < 3; i++) {
				await ts({}, ctx);
				await bas({ systemPrompt: "", prompt: `turn-${i}`, systemPromptOptions: {} }, ctx);
				await te({ message: { role: "assistant", stopReason: "stop", usage: { input: 0, output: 0 } } }, ctx);
				expectGoalProfile(FIVE_GOAL_TOOLS);
				expectHostUntouched(HOST_SEED_B);
			}
		} finally {
			f.cleanup();
		}
	});

	it("status transitions via tool calls keep the profile fixed", async () => {
		const f = testFixture();
		try {
			activeToolNames = [...HOST_SEED_A];
			apiCalls = [];
			await runSession(f.cwd, f.mockCtx.sessionManager.getBranch() as unknown[]);
			const bas = lifecycleHandlers.get("before_agent_start")!;
			await bas({ systemPrompt: "", prompt: "start", systemPromptOptions: {} }, f.mockCtx);

			// update_goal(blocked) transitions active -> blocked; profile stays five.
			const update = registeredTools.find((t) => t.name === "update_goal");
			assert.ok(update);
			const result = await (update.execute as Function)("update-b", { status: "blocked" }, new AbortController().signal, undefined, f.mockCtx);
			assert.ok(result.terminate === true, "blocked terminates the turn");
			expectGoalProfile(FIVE_GOAL_TOOLS);
			expectHostUntouched(HOST_SEED_A);
		} finally {
			f.cleanup();
		}
	});

	// ── Invalid lifecycle calls: state-aware rejection, not tool removal ───
	it("update_goal(blocked) from a paused goal is rejected with a state-aware message while tools stay", async () => {
		const f = testFixture();
		try {
			// Pause the goal on disk, then reload the session.
			const paused = createGoal({
				objective: "Paused goal",
				autoContinue: false,
				sisyphus: false,
			}, Date.UTC(2026, 5, 26, 12, 0, 0));
			paused.status = "paused" as const;
			paused.stopReason = "agent";
			paused.pauseReason = "waiting on user";
			const written = writeActiveGoalFile({ cwd: f.cwd } as any, paused);
			const entries = [
				{ type: "custom", customType: "pi-goal-focus", data: goalFocusDetails(paused.id, "created") },
				{ type: "custom", customType: "pi-goal-state", data: { version: 3, goal: { ...paused, activePath: written.activePath } } },
			];
			activeToolNames = [...HOST_SEED_A];
			apiCalls = [];
			await runSession(f.cwd, entries);

			const update = registeredTools.find((t) => t.name === "update_goal");
			assert.ok(update);
			const result = await (update.execute as Function)("update-p", { status: "blocked" }, new AbortController().signal, undefined, f.mockCtx);
			const text = result.content?.[0]?.text ?? "";
			assert.ok(text.includes("applies only to an active goal"),
				`blocked from paused must be a state-aware failure, got: ${text.slice(0, 100)}`);
			// The full five-tool profile remains advertised after the rejection.
			expectGoalProfile(FIVE_GOAL_TOOLS);
			expectHostUntouched(HOST_SEED_A);
		} finally {
			f.cleanup();
		}
	});

	// ── Registration invariants ────────────────────────────────────────────
	it("all five model tools are registered with execute handlers; removed tools are not", () => {
		for (const name of FIVE_GOAL_TOOLS) {
			const tool = registeredTools.find((t) => t.name === name);
			assert.ok(tool, `Tool "${name}" must be registered`);
			assert.ok(typeof tool!.execute === "function", `Tool "${name}" must have an execute handler`);
		}
		for (const removed of REMOVED_TOOLS) {
			assert.equal(registeredTools.some((t) => t.name === removed), false, `${removed} must not be registered`);
		}
	});

	it("tool_call handler is registered", () => {
		const handler = lifecycleHandlers.get("tool_call");
		assert.ok(handler, "tool_call handler must be registered");
	});

	it("escape dialog handler paths are wired", () => {
		const handler = lifecycleHandlers.get("tool_call");
		assert.ok(handler, "tool_call handler must exist for escape dialog path");
		const tool = registeredTools.find((t) => t.name === "update_goal");
		assert.ok(tool, "update_goal tool must be registered");
	});

	// ── update_goal_task execution keeps the profile fixed ────────────────
	it("update_goal_task executes and the five-tool profile stays fixed", async () => {
		const f = testFixture();
		try {
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
			const entries = [
				{ type: "custom", customType: "pi-goal-focus", data: goalFocusDetails(goalWithTasks.id, "created") },
				{ type: "custom", customType: "pi-goal-state", data: { version: 3, goal: { ...goalWithTasks, activePath: written.activePath, taskList: goalData.taskList, updatedAt: now } } },
			];
			activeToolNames = [...HOST_SEED_A];
			apiCalls = [];
			await runSession(f.cwd, entries);
			const bas = lifecycleHandlers.get("before_agent_start")!;
			await bas({ systemPrompt: "", prompt: "start", systemPromptOptions: {} }, f.mockCtx);

			const updateTaskTool = registeredTools.find((t) => t.name === "update_goal_task");
			assert.ok(updateTaskTool, "update_goal_task tool must be registered");
			const result1 = await (updateTaskTool.execute as Function)(
				"call-task-1",
				{ task_id: "t1", status: "complete", evidence: "Done" },
				new AbortController().signal,
				undefined,
				f.mockCtx,
			);
			assert.ok(result1, "update_goal_task result must be defined");
			const text1 = result1.content?.[0]?.text ?? "";
			assert.ok(text1.includes("t1 complete") || text1.includes("1/2"),
				`update_goal_task should report t1 complete. Got: ${text1}`);

			// After executing update_goal_task, the profile and host set are unchanged.
			expectGoalProfile(FIVE_GOAL_TOOLS);
			expectHostUntouched(HOST_SEED_A);
		} finally {
			f.cleanup();
		}
	});

	// ── Host compatibility: arbitrary host tool seeds survive every event ──
	it("arbitrary host tool sets survive session, turn, and tool events untouched", async () => {
		const f = testFixture();
		try {
			activeToolNames = [...HOST_SEED_B];
			apiCalls = [];
			await runSession(f.cwd, f.mockCtx.sessionManager.getBranch() as unknown[]);
			const ts = lifecycleHandlers.get("turn_start")!;
			const bas = lifecycleHandlers.get("before_agent_start")!;
			await ts({}, f.mockCtx);
			await bas({ systemPrompt: "", prompt: "seed", systemPromptOptions: {} }, f.mockCtx);
			const get = registeredTools.find((t) => t.name === "get_goal");
			await (get!.execute as Function)("get-1", {}, new AbortController().signal, undefined, f.mockCtx);
			expectGoalProfile(FIVE_GOAL_TOOLS);
			expectHostUntouched(HOST_SEED_B);
		} finally {
			f.cleanup();
		}
	});
});
