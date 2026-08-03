/**
 * Stage 3 core-tools tests: create_goal / get_goal / update_goal.
 *
 * Verifies:
 *  - exactly three advertised goal tools when tasks are disabled;
 *  - create_goal is real, objective-explicit, focuses, reports other-open goals,
 *    enforces the 1-4000 character objective bound, and accepts token_budget;
 *  - get_goal returns the complete stable snapshot;
 *  - update_goal(complete) runs the audit WITHOUT a verification-summary
 *    parameter (audit from actual evidence); approval archives, rejection stays
 *    open;
 *  - update_goal(blocked) records a distinct agent-blocked state only from
 *    active, with the goal_blocked ledger event.
 */

import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import goalExtension from "../extensions/goal.ts";
import { createGoal, goalFocusDetails } from "../extensions/goal-record.ts";
import { parseGoalFile, writeActiveGoalFile } from "../extensions/storage/goal-files.ts";
import { goalLedgerPath } from "../extensions/goal-ledger.ts";

interface HarnessOptions {
	cwd: string;
	sessionEntries: unknown[];
	hasUI?: boolean;
	runCompletionAuditor?: (...args: any[]) => Promise<any>;
	settings?: Record<string, unknown>;
}

function createHarness(options: HarnessOptions) {
	const handlers = new Map<string, Function>();
	const commands = new Map<string, any>();
	const tools = new Map<string, ToolDefinition>();
	let activeTools = ["read", "bash", "edit", "write"];
	const pi = {
		registerTool: (def: ToolDefinition) => { tools.set(def.name, def); },
		registerCommand: (name: string, def: any) => { commands.set(name, def); },
		on: (event: string, handler: Function) => { handlers.set(event, handler); },
		appendEntry: () => {},
		registerMessageRenderer: () => {},
		sendMessage: () => {},
		getActiveTools: () => [...activeTools],
		setActiveTools: (names: string[]) => { activeTools = [...names]; },
		hasUI: options.hasUI ?? false,
	};
	const ctx = {
		cwd: options.cwd,
		hasUI: options.hasUI ?? false,
		sessionManager: {
			getBranch: () => options.sessionEntries,
			getCwd: () => options.cwd,
			getSessionId: () => "core-tools-session",
			getRoot: () => options.cwd,
		},
		ui: {
			notify: () => {},
			setStatus: () => {},
			setWidget: () => {},
			onTerminalInput: () => () => {},
			select: async () => undefined,
			confirm: async () => false,
			custom: async () => undefined,
		},
		getSystemPrompt: () => "base prompt",
		isIdle: () => true,
		hasPendingMessages: () => false,
		abort: () => {},
	} as unknown as ExtensionContext;
	goalExtension(pi as any, { runCompletionAuditor: options.runCompletionAuditor });
	return { handlers, commands, tools, ctx, get activeTools() { return [...activeTools]; } };
}

function makeFixture(opts: { objective?: string; tokenBudget?: number; pauseReason?: string; status?: string } = {}) {
	const cwd = mkdtempSync(path.join(tmpdir(), "goal-core-"));
	mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
	const goal = createGoal({
		objective: opts.objective ?? "=== Goal ===\nObjective: Core tools test",
		autoContinue: true,
		sisyphus: false,
	}, Date.UTC(2026, 7, 4, 9, 0, 0));
	if (opts.tokenBudget) goal.tokenBudget = opts.tokenBudget;
	if (opts.pauseReason) { goal.status = "paused" as const; goal.autoContinue = false; goal.stopReason = "agent"; goal.pauseReason = opts.pauseReason; }
	if (opts.status === "complete") goal.status = "complete" as const;
	const written = writeActiveGoalFile({ cwd }, goal);
	const sessionEntries = [{ type: "custom", customType: "pi-goal-focus", data: goalFocusDetails(goal.id, "created") }];
	const cleanup = () => { try { rmSync(cwd, { recursive: true, force: true }); } catch {} };
	return { cwd, goal: written, sessionEntries, cleanup };
}

function activeGoalFiles(cwd: string): string[] {
	try {
		return readdirSync(path.join(cwd, ".pi", "goals")).filter((n) => n.startsWith("active_goal_"));
	} catch {
		return [];
	}
}

function ledgerEvents(cwd: string): Array<Record<string, unknown>> {
	const filePath = goalLedgerPath({ cwd });
	try {
		return readFileSync(filePath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
	} catch {
		return [];
	}
}

async function start(h: ReturnType<typeof createHarness>): Promise<void> {
	await h.handlers.get("session_start")?.({ reason: "start" }, h.ctx);
	await h.handlers.get("before_agent_start")?.({ systemPrompt: "base", prompt: "test", systemPromptOptions: {} }, h.ctx);
}

// ── Tool surface ─────────────────────────────────────────────────────────────

test("exactly three goal tools are advertised when tasks are disabled", async () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "goal-core-notasks-"));
	mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
	writeFileSync(path.join(cwd, ".pi", "pi-goal-x-settings.json"), JSON.stringify({ disableTasks: true }));
	const goal = createGoal({ objective: "Tasks disabled", autoContinue: true, sisyphus: false }, Date.UTC(2026, 7, 4, 10, 0, 0));
	writeActiveGoalFile({ cwd }, goal);
	try {
		const h = createHarness({
			cwd,
			sessionEntries: [{ type: "custom", customType: "pi-goal-focus", data: goalFocusDetails(goal.id, "created") }],
		});
		await start(h);
		for (const present of ["create_goal", "get_goal", "update_goal"]) {
			assert.ok(h.activeTools.includes(present), `${present} must be advertised`);
		}
		for (const absent of [
			"propose_task_list", "complete_task", "skip_task",
			"complete_goal", "pause_goal", "abort_goal",
			"propose_goal_draft", "propose_goal_tweak", "step_complete",
		]) {
			assert.equal(h.activeTools.includes(absent), false, `${absent} must NOT be advertised`);
		}
	} finally {
		try { rmSync(cwd, { recursive: true, force: true }); } catch {}
	}
});

// ── create_goal ──────────────────────────────────────────────────────────────

test("create_goal creates, focuses, and reports other open goals", async () => {
	const f = makeFixture();
	try {
		const h = createHarness({ cwd: f.cwd, sessionEntries: f.sessionEntries });
		await start(h);
		const create = h.tools.get("create_goal")!;
		const before = activeGoalFiles(f.cwd).length;
		const result = await (create.execute as any)("create-1", {
			objective: "=== Goal ===\nObjective: Second goal from create_goal",
			mode: "regular",
		}, undefined, undefined, h.ctx);
		const text = result.content?.[0]?.text ?? "";
		assert.ok(text.includes("Second goal from create_goal"), "result should confirm creation");
		assert.ok(text.includes("1 other open goal"), "result should report other open goals");
		assert.equal(activeGoalFiles(f.cwd).length, before + 1, "a new active goal file must land on disk");
		assert.ok(ledgerEvents(f.cwd).some((e) => e.type === "goal_created"), "goal_created ledger event");
	} finally {
		f.cleanup();
	}
});

test("create_goal accepts token_budget and sisyphus mode", async () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "goal-core-budget-"));
	mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
	try {
		const h = createHarness({ cwd, sessionEntries: [] });
		await start(h);
		const create = h.tools.get("create_goal")!;
		await (create.execute as any)("create-2", {
			objective: "=== Goal ===\nObjective: Budgeted sisyphus",
			mode: "sisyphus",
			token_budget: 5000,
		}, undefined, undefined, h.ctx);
		const active = activeGoalFiles(cwd);
		assert.equal(active.length, 1);
		const parsed = parseGoalFile(path.join(cwd, ".pi", "goals", active[0]!));
		assert.ok(parsed, "goal must parse");
		assert.equal(parsed.tokenBudget, 5000, "token_budget must be persisted");
		assert.equal(parsed.sisyphus, true, "sisyphus mode must be persisted");
	} finally {
		try { rmSync(cwd, { recursive: true, force: true }); } catch {}
	}
});

test("create_goal rejects objectives over 4000 characters", async () => {
	const f = makeFixture();
	try {
		const h = createHarness({ cwd: f.cwd, sessionEntries: f.sessionEntries });
		await start(h);
		const create = h.tools.get("create_goal")!;
		const result = await (create.execute as any)("create-3", {
			objective: "x".repeat(4001),
		}, undefined, undefined, h.ctx);
		const text = result.content?.[0]?.text ?? "";
		assert.ok(text.includes("exceeds 4000 characters"), `must reject oversized objective, got: ${text.slice(0, 120)}`);
	} finally {
		f.cleanup();
	}
});

// ── get_goal ─────────────────────────────────────────────────────────────────

test("get_goal returns the complete stable snapshot", async () => {
	const now = new Date().toISOString();
	const cwd = mkdtempSync(path.join(tmpdir(), "goal-core-snapshot-"));
	mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
	const goal = createGoal({ objective: "Snapshot goal", autoContinue: true, sisyphus: true }, Date.UTC(2026, 7, 4, 11, 0, 0));
	goal.tokenBudget = 1000;
	goal.usage.tokensUsed = 250;
	goal.usage.activeSeconds = 120;
	goal.verificationContract = "Run npm test (0 failures).";
	goal.taskList = { tasks: [{ id: "t1", title: "Task one", status: "pending" as const }], blockCompletion: false, proposedAt: now };
	const written = writeActiveGoalFile({ cwd }, goal);
	try {
		const h = createHarness({
			cwd,
			sessionEntries: [{ type: "custom", customType: "pi-goal-focus", data: goalFocusDetails(goal.id, "created") }],
		});
		await start(h);
		const get = h.tools.get("get_goal")!;
		const result = await (get.execute as any)("get-1", {}, undefined, undefined, h.ctx);
		const text = result.content?.[0]?.text ?? "";
		assert.ok(text.includes("Snapshot goal"), "objective present");
		assert.ok(text.includes("Status:") && text.includes("running"), "status present");
		assert.ok(text.includes("Mode: sisyphus"), "mode present");
		assert.ok(text.includes("Budget:"), "budget present");
		assert.ok(text.includes("750 remaining"), "remaining budget present");
		assert.ok(text.includes("Tasks:"), "task summary present");
		assert.ok(text.includes("Verification contract:"), "contract present");
		assert.ok(text.includes(`Path: ${written.activePath}`), "path present");
	} finally {
		try { rmSync(cwd, { recursive: true, force: true }); } catch {}
	}
});

// ── update_goal(complete) without paperwork ──────────────────────────────────

test("update_goal(complete) runs the auditor without a verification-summary parameter", async () => {
	const f = makeFixture();
	let auditArgs: any = null;
	const approved = { approved: true, disapproved: false, output: "All good\n<approved/>", model: "mock" };
	try {
		const h = createHarness({
			cwd: f.cwd,
			sessionEntries: f.sessionEntries,
			runCompletionAuditor: async (args: any) => { auditArgs = args; return approved; },
		});
		await start(h);
		const update = h.tools.get("update_goal")!;
		await (update.execute as any)("update-1", { status: "complete" }, undefined, undefined, h.ctx);
		assert.ok(auditArgs, "auditor must run");
		assert.equal(auditArgs.verificationSummary, undefined, "no verification-summary paperwork");
		assert.equal(auditArgs.completionSummary, undefined, "no completion claim required");
		// Deferred archival happens at turn_end.
		await h.handlers.get("turn_end")?.({ message: { role: "assistant", stopReason: "stop", usage: { input: 0, output: 0 } } }, h.ctx);
		assert.equal(activeGoalFiles(f.cwd).length, 0, "approved completion archives the goal");
		const events = ledgerEvents(f.cwd);
		assert.ok(events.some((e) => e.type === "audit_result" && (e as any).verdict === "approved"), "audit_result ledger event");
		assert.ok(events.some((e) => e.type === "goal_completed"), "goal_completed ledger event");
	} finally {
		f.cleanup();
	}
});

test("update_goal(complete) with a rejection keeps the goal open with feedback", async () => {
	const f = makeFixture();
	const disapproved = { approved: false, disapproved: true, output: "Missing requirement\n<disapproved/>", model: "mock" };
	try {
		const h = createHarness({
			cwd: f.cwd,
			sessionEntries: f.sessionEntries,
			runCompletionAuditor: async () => disapproved,
		});
		await start(h);
		const update = h.tools.get("update_goal")!;
		const result = await (update.execute as any)("update-2", { status: "complete" }, undefined, undefined, h.ctx);
		const text = result.content?.[0]?.text ?? "";
		assert.ok(text.includes("Goal audit rejected"), "rejection feedback returned");
		assert.equal(activeGoalFiles(f.cwd).length, 1, "goal stays open");
		const events = ledgerEvents(f.cwd);
		assert.ok(events.some((e) => e.type === "audit_result" && (e as any).verdict === "disapproved"), "disapproved audit recorded");
	} finally {
		f.cleanup();
	}
});

// ── update_goal(blocked) ─────────────────────────────────────────────────────

test("update_goal(blocked) records a distinct agent-blocked state from active", async () => {
	const f = makeFixture();
	try {
		const h = createHarness({ cwd: f.cwd, sessionEntries: f.sessionEntries });
		await start(h);
		const update = h.tools.get("update_goal")!;
		const result = await (update.execute as any)("update-3", { status: "blocked" }, undefined, undefined, h.ctx);
		assert.ok(result.terminate === true, "blocked terminates the turn");
		const active = activeGoalFiles(f.cwd);
		assert.equal(active.length, 1, "goal remains in the active dir");
		const parsed = parseGoalFile(path.join(f.cwd, ".pi", "goals", active[0]!));
		assert.ok(parsed, "goal must parse");
		assert.equal(parsed.status, "blocked", "status must be blocked");
		assert.equal(parsed.stopReason, "agent", "stopReason agent");
		const events = ledgerEvents(f.cwd);
		const blocked = events.find((e) => e.type === "goal_blocked") as Record<string, unknown> | undefined;
		assert.ok(blocked, "goal_blocked ledger event");
		assert.equal(blocked!.source, "agent");
		assert.ok(typeof blocked!.reason === "string" && (blocked!.reason as string).length > 0);
	} finally {
		f.cleanup();
	}
});

test("update_goal(blocked) is rejected from a non-active goal", async () => {
	const f = makeFixture({ pauseReason: "waiting on user" });
	try {
		const h = createHarness({ cwd: f.cwd, sessionEntries: f.sessionEntries });
		await start(h);
		const update = h.tools.get("update_goal")!;
		const result = await (update.execute as any)("update-4", { status: "blocked" }, undefined, undefined, h.ctx);
		const text = result.content?.[0]?.text ?? "";
		assert.ok(text.includes("applies only to an active goal"), `blocked must be rejected from paused, got: ${text}`);
		const active = activeGoalFiles(f.cwd);
		const parsed = parseGoalFile(path.join(f.cwd, ".pi", "goals", active[0]!));
		assert.equal(parsed?.status, "paused", "goal unchanged");
		assert.equal(ledgerEvents(f.cwd).filter((e) => e.type === "goal_blocked").length, 0, "no goal_blocked event");
	} finally {
		f.cleanup();
	}
});
