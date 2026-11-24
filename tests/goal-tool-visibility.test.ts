/** The goal tool list is fixed: only disableTasks changes it, and host tools are never touched. */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
	createGoal,
	goalFocusDetails,
	type GoalStateEntry,
} from "../extensions/goal-record.ts";
import { writeActiveGoalFile } from "../extensions/storage/goal-files.ts";
import { createExtensionHarness } from "./support/extension-harness.ts";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { tempDir } from "./support/fs.ts";

// ── Helpers ──────────────────────────────────────────────────────────────────

// One extension is loaded for the whole file; each test supplies its own session context.
const host = createExtensionHarness({ cwd: process.cwd(), systemPrompt: "" });
const registeredTools = [...host.tools.values()] as ToolDefinition[];
const lifecycleHandlers = host.handlers;

/** Sets the host's active tool set, which the extension must leave alone. */
function seedHostTools(names: readonly string[]): void {
	host.pi.setActiveTools([...names]);
}

function testFixture() {
	const cwd = tempDir("goal-tool-vis-");
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

	const mockCtx = host.createContext({ cwd, sessionEntries });
	const cleanup = () => { try { rmSync(cwd, { recursive: true, force: true }); } catch {} };

	return { cwd, goal: written, mockCtx, cleanup };
}

// The two possible lists. Goal status, focus and drafting never change them.
const FIVE_GOAL_TOOLS = ["create_goal", "get_goal", "update_goal", "set_goal_tasks", "update_goal_task"];
const DRAFTING_TOOLS = ["goal_questionnaire", "propose_goal_draft"];
const ALL_GOAL_TOOLS = [...FIVE_GOAL_TOOLS, ...DRAFTING_TOOLS];
const WITH_TASKS = ALL_GOAL_TOOLS;
const WITHOUT_TASKS = ["create_goal", "get_goal", "update_goal", ...DRAFTING_TOOLS];

// Arbitrary host tool seeds: profile installation must never touch these.
const HOST_SEED_A = ["read", "bash", "edit", "write"];
const HOST_SEED_B = ["read", "grep", "find", "ls", "fetch", "custom-ext-tool"];

const REMOVED_TOOLS = [
	"complete_goal", "pause_goal", "abort_goal", "propose_goal_tweak",
	"step_complete", "propose_task_list", "complete_task", "skip_task",
	"goal_question",
];

// ── Test Suite ───────────────────────────────────────────────────────────────

describe("Fixed goal tool list", () => {
	function expectGoalProfile(expected: readonly string[]): void {
		for (const tool of expected) {
			assert.ok(host.activeTools.includes(tool),
				`goal tool "${tool}" must be advertised. Active: ${JSON.stringify(host.activeTools)}`);
		}
		for (const removed of REMOVED_TOOLS) {
			assert.equal(host.activeTools.includes(removed), false,
				`removed tool "${removed}" must never be advertised. Active: ${JSON.stringify(host.activeTools)}`);
		}
		// Exactly the expected goal tools: no extras, no missing.
		const goalTools = host.activeTools.filter((t) => [...ALL_GOAL_TOOLS, ...REMOVED_TOOLS].includes(t));
		assert.equal(goalTools.length, expected.length,
			`goal profile must be exactly [${expected.join(", ")}], got: ${JSON.stringify(goalTools)}`);
	}

	function expectHostUntouched(seed: readonly string[]): void {
		const hostTools = host.activeTools.filter((t) => !ALL_GOAL_TOOLS.includes(t));
		assert.deepEqual(hostTools.sort(), [...seed].sort(),
			`host tool selection must be untouched. Active: ${JSON.stringify(host.activeTools)}`);
	}

	async function runSession(cwd: string, entries: unknown[]): Promise<void> {
		const ss = lifecycleHandlers.get("session_start");
		assert.ok(ss, "session_start handler must be registered");
		await ss({ reason: "start" }, host.createContext({ cwd, sessionEntries: entries }));
	}

	// ── Fixed profile across every lifecycle state ─────────────────────────
	it("an active goal without tasks gets the full list and host tools are untouched", async () => {
		const f = testFixture();
		try {
			seedHostTools(HOST_SEED_A);
			await runSession(f.cwd, f.mockCtx.sessionManager.getBranch() as unknown[]);
			expectGoalProfile(WITH_TASKS);
			expectHostUntouched(HOST_SEED_A);
		} finally {
			f.cleanup();
		}
	});

	it("a session with no focused goal gets the same list", async () => {
		const cwd = tempDir("goal-tool-vis-nogoal-");
		try {
			mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
			seedHostTools(HOST_SEED_A);
			await runSession(cwd, []);
			expectGoalProfile(WITH_TASKS);
			expectHostUntouched(HOST_SEED_A);
		} finally {
			try { rmSync(cwd, { recursive: true, force: true }); } catch {}
		}
	});

	it("every goal status gets the same list", async () => {
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
				seedHostTools(HOST_SEED_A);
				await runSession(f.cwd, entries);
				expectGoalProfile(WITH_TASKS);
				expectHostUntouched(HOST_SEED_A);
			} finally {
				f.cleanup();
			}
		}
	});

	it("with tasks disabled, every status gets the list without task tools", async () => {
		for (const status of ["active", "paused", "complete"] as const) {
			const cwd = tempDir("goal-tool-vis-notasks-");
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
				seedHostTools(HOST_SEED_B);
				await runSession(cwd, entries);
				expectGoalProfile(WITHOUT_TASKS);
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
			seedHostTools(HOST_SEED_B);
			await runSession(f.cwd, f.mockCtx.sessionManager.getBranch() as unknown[]);
			expectGoalProfile(WITH_TASKS);
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
				expectGoalProfile(WITH_TASKS);
				expectHostUntouched(HOST_SEED_B);
			}
		} finally {
			f.cleanup();
		}
	});

	it("blocking a goal leaves the list unchanged", async () => {
		const f = testFixture();
		try {
			seedHostTools(HOST_SEED_A);
			await runSession(f.cwd, f.mockCtx.sessionManager.getBranch() as unknown[]);
			const bas = lifecycleHandlers.get("before_agent_start")!;
			await bas({ systemPrompt: "", prompt: "start", systemPromptOptions: {} }, f.mockCtx);

			const update = registeredTools.find((t) => t.name === "update_goal");
			assert.ok(update);
			const result = await (update.execute as Function)("update-b", { status: "blocked", reason: "test blocker" }, new AbortController().signal, undefined, f.mockCtx);
			assert.ok(result.terminate === true, "blocked terminates the turn");
			expectGoalProfile(WITH_TASKS);
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
			seedHostTools(HOST_SEED_A);
			await runSession(f.cwd, entries);

			const update = registeredTools.find((t) => t.name === "update_goal");
			assert.ok(update);
			const result = await (update.execute as Function)("update-p", { status: "blocked", reason: "test blocker" }, new AbortController().signal, undefined, f.mockCtx);
			const text = result.content?.[0]?.text ?? "";
			assert.ok(text.includes("applies only to an active goal"),
				`blocked from paused must be a state-aware failure, got: ${text.slice(0, 100)}`);
			expectGoalProfile(WITH_TASKS);
			expectHostUntouched(HOST_SEED_A);
		} finally {
			f.cleanup();
		}
	});

	// ── Registration invariants ────────────────────────────────────────────
	it("execution and drafting tools are registered with execute handlers", () => {
		for (const name of FIVE_GOAL_TOOLS) {
			const tool = registeredTools.find((t) => t.name === name);
			assert.ok(tool, `Tool "${name}" must be registered`);
			assert.ok(typeof tool!.execute === "function", `Tool "${name}" must have an execute handler`);
		}
		for (const name of ["goal_questionnaire", "propose_goal_draft"]) {
			const tool = registeredTools.find((t) => t.name === name);
			assert.ok(tool, `Drafting tool "${name}" must be registered`);
			assert.ok(typeof tool!.execute === "function", `Drafting tool "${name}" must have an execute handler`);
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
	it("update_goal_task executes and the list stays fixed", async () => {
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
			seedHostTools(HOST_SEED_A);
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
			expectGoalProfile(WITH_TASKS);
			expectHostUntouched(HOST_SEED_A);
		} finally {
			f.cleanup();
		}
	});

	// ── Host compatibility: arbitrary host tool seeds survive every event ──
	it("arbitrary host tool sets survive session, turn, and tool events untouched", async () => {
		const f = testFixture();
		try {
			seedHostTools(HOST_SEED_B);
			await runSession(f.cwd, f.mockCtx.sessionManager.getBranch() as unknown[]);
			const ts = lifecycleHandlers.get("turn_start")!;
			const bas = lifecycleHandlers.get("before_agent_start")!;
			await ts({}, f.mockCtx);
			await bas({ systemPrompt: "", prompt: "seed", systemPromptOptions: {} }, f.mockCtx);
			const get = registeredTools.find((t) => t.name === "get_goal");
			await (get!.execute as Function)("get-1", {}, new AbortController().signal, undefined, f.mockCtx);
			expectGoalProfile(WITH_TASKS);
			expectHostUntouched(HOST_SEED_B);
		} finally {
			f.cleanup();
		}
	});
});
