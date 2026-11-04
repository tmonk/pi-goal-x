import { appendGoalEvent } from "../extensions/goal-ledger.ts";
/**
 * Stage 3 core-tools tests: create_goal / get_goal / update_goal.
 *
 * Verifies:
 *  - exactly three advertised goal tools when tasks are disabled;
 *  - create_goal is real, objective-explicit, focuses, reports other-open goals,
 *    honors the configurable max objective length setting (no limit by default),
 *    and accepts token_budget;
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
import { createGoal, goalFocusDetails, normalizeGoalRecord } from "../extensions/goal-record.ts";
import { parseGoalFile, writeActiveGoalFile } from "../extensions/storage/goal-files.ts";
import { goalLedgerPath } from "../extensions/goal-ledger.ts";
import { STATE_ENTRY } from "../extensions/goal-format.ts";

interface HarnessOptions {
	cwd: string;
	sessionEntries: unknown[];
	hasUI?: boolean;
	runCompletionAuditor?: (...args: any[]) => Promise<any>;
	settings?: Record<string, unknown>;
	uiCustom?: (...args: any[]) => Promise<any>;
	onSendMessage?: (message: any, opts?: any) => void;
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
		sendMessage: (message: any, opts?: any) => { options.onSendMessage?.(message, opts); },
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
			custom: options.uiCustom ?? (async () => undefined),
		},
		getSystemPrompt: () => "base prompt",
		isIdle: () => true,
		hasPendingMessages: () => false,
		abort: () => {},
	} as unknown as ExtensionContext;
	goalExtension(pi as any, { runCompletionAuditor: options.runCompletionAuditor });
	return {
		handlers,
		commands,
		tools,
		ctx,
		get activeTools() { return [...activeTools]; },
		get core() { return (pi as unknown as { _goalCore: any })._goalCore; },
	};
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

test("three core and three drafting tools are advertised when tasks are disabled", async () => {
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
		for (const present of ["create_goal", "get_goal", "update_goal", "goal_question", "goal_questionnaire", "propose_goal_draft"]) {
			assert.ok(h.activeTools.includes(present), `${present} must be advertised`);
		}
		for (const absent of [
			"propose_task_list", "complete_task", "skip_task",
			"complete_goal", "pause_goal", "abort_goal",
			"set_goal_tasks", "update_goal_task", "propose_goal_tweak", "step_complete",
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
		const result = await (create.execute as any)("create-2", {
			objective: "=== Goal ===\nObjective: Budgeted sisyphus",
			mode: "sisyphus",
			token_budget: 5000,
		}, undefined, undefined, h.ctx);
		const active = activeGoalFiles(cwd);
		assert.equal(active.length, 1);
		const parsed = parseGoalFile(path.join(cwd, ".pi", "goals", active[0]!));
		assert.ok(parsed, "goal must parse");
		assert.equal(parsed.tokenBudget, 5000, "token_budget must be persisted");
		assert.match(JSON.stringify(result.content), /Budget: 5000 tokens/);
		assert.equal(parsed.sisyphus, true, "sisyphus mode must be persisted");
	} finally {
		try { rmSync(cwd, { recursive: true, force: true }); } catch {}
	}
});

test("create_goal accepts long objectives by default (no hard 4000 limit)", async () => {
	const f = makeFixture();
	try {
		const h = createHarness({ cwd: f.cwd, sessionEntries: f.sessionEntries });
		await start(h);
		const create = h.tools.get("create_goal")!;
		const result = await (create.execute as any)("create-3", {
			objective: "x".repeat(5000),
		}, undefined, undefined, h.ctx);
		const text = result.content?.[0]?.text ?? "";
		assert.ok(text.includes("x".repeat(40)), "long objective is accepted when no max objective length is configured");
		assert.equal(activeGoalFiles(f.cwd).length, 2, "the long-objective goal is created alongside the fixture goal");
	} finally {
		f.cleanup();
	}
});

test("create_goal enforces the configured max objective length setting", async () => {
	const f = makeFixture();
	try {
		writeFileSync(path.join(f.cwd, ".pi", "pi-goal-x-settings.json"), JSON.stringify({ objectiveMaxChars: 100 }));
		const h = createHarness({ cwd: f.cwd, sessionEntries: f.sessionEntries });
		await start(h);
		const create = h.tools.get("create_goal")!;
		const rejected = await (create.execute as any)("create-4", {
			objective: "x".repeat(101),
		}, undefined, undefined, h.ctx);
		const text = rejected.content?.[0]?.text ?? "";
		assert.ok(text.includes("exceeds 100 characters"), `must reject objectives over the configured limit, got: ${text.slice(0, 120)}`);
		assert.equal(activeGoalFiles(f.cwd).length, 1, "no goal is created when the objective is over the limit (fixture goal only)");
		const accepted = await (create.execute as any)("create-5", {
			objective: "x".repeat(100),
		}, undefined, undefined, h.ctx);
		assert.ok(accepted.content?.[0]?.text ?? "", "objective exactly at the limit is accepted");
		assert.equal(activeGoalFiles(f.cwd).length, 2, "at-limit objective creates the goal");
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
		// PR E: the concise default omits verbose-only sections; pass verbose to
		// pin the complete stable snapshot.
		const result = await (get.execute as any)("get-1", { verbose: true }, undefined, undefined, h.ctx);
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

// ── PR E §53: concise get_goal default ───────────────────────────────

test("get_goal default is concise; verbose retains full diagnostics", async () => {
	const now = new Date().toISOString();
	const cwd = mkdtempSync(path.join(tmpdir(), "goal-core-concise-"));
	mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
	const goal = createGoal({ objective: "Concise snapshot goal", autoContinue: true, sisyphus: false }, Date.UTC(2026, 7, 4, 11, 0, 0));
	goal.verificationContract = "Run npm test (0 failures).";
	goal.taskList = {
		tasks: [
			{ id: "t1", title: "Done task", status: "complete" as const },
			{ id: "t2", title: "Current task", status: "pending" as const, verificationContract: "prove it" },
			{ id: "t3", title: "Next up", status: "pending" as const },
		],
		blockCompletion: false,
		proposedAt: now,
	};
	goal.currentTaskId = "t2";
	writeActiveGoalFile({ cwd }, goal);
	try {
		const h = createHarness({
			cwd,
			sessionEntries: [{ type: "custom", customType: "pi-goal-focus", data: goalFocusDetails(goal.id, "created") }],
		});
		await start(h);
		const get = h.tools.get("get_goal")!;
		const result = await (get.execute as any)("g-1", {}, undefined, undefined, h.ctx);
		const text = result.content?.[0]?.text ?? "";
		assert.ok(text.includes(`Objective: ${goal.objective}`), "full objective kept (explicit state-read tool)");
		assert.ok(text.includes("Current task: t2 — Current task — contract: prove it"), "current task with contract");
		assert.ok(text.includes("Next pending: t3 — Next up"), "next pending (distinct from current)");
		assert.ok(!text.includes("Lifecycle:"), "lifecycle prose omitted from the concise default");
		assert.ok(!text.includes("Path:"), "paths are verbose-only");

		const verboseResult = await (get.execute as any)("g-2", { verbose: true }, undefined, undefined, h.ctx);
		const vtext = verboseResult.content?.[0]?.text ?? "";
		assert.ok(vtext.includes("Lifecycle:"), "verbose keeps lifecycle guidance");
		assert.ok(vtext.includes("Path:"), "verbose keeps paths");
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
		appendGoalEvent(h.ctx, { type: "audit_result", goalId: h.core.state.goal!.id, verdict: "disapproved", report: "Missing boundary test " + "x".repeat(1000), at: new Date().toISOString() });
		const update = h.tools.get("update_goal")!;
		await (update.execute as any)("update-1", { status: "complete" }, undefined, undefined, h.ctx);
		assert.ok(auditArgs, "auditor must run");
		assert.equal(auditArgs.verificationSummary, undefined, "no verification-summary paperwork");
		assert.equal(auditArgs.completionSummary, undefined, "no completion claim required");
		assert.match(auditArgs.warmContext, /Previous rejection.*Missing boundary test/);
		assert.ok(auditArgs.warmContext.length < 1200, "previous findings are bounded");
		// Deferred archival happens at turn_end.
		await h.handlers.get("turn_end")?.({ message: { role: "assistant", stopReason: "stop", usage: { input: 0, output: 0 } } }, h.ctx);
		assert.equal(activeGoalFiles(f.cwd).length, 0, "approved completion archives the goal");
		const events = ledgerEvents(f.cwd);
		assert.ok(events.some((e) => e.type === "audit_result" && (e as any).verdict === "approved"), "audit_result ledger event");
		assert.ok(events.some((e) => e.type === "goal_completed"), "goal_completed ledger event");
		// §15.4: approval shows the result card during deferred completion.
		assert.equal(h.core.auditResult?.verdict, "approved", "approval sets the result card verdict");
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
		// §15.4: the result card state is set for the widget, then clears.
		assert.deepEqual(h.core.auditResult?.verdict, "disapproved", "rejection sets the result card verdict");
		h.core.clearAuditResult();
		assert.equal(h.core.auditResult, null, "clearAuditResult restores the normal dashboard state");
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
		const result = await (update.execute as any)("update-3", { status: "blocked", reason: "test blocker" }, undefined, undefined, h.ctx);
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
		const result = await (update.execute as any)("update-4", { status: "blocked", reason: "test blocker" }, undefined, undefined, h.ctx);
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

test("update_goal(blocked) surfaces an apply failure instead of claiming success (#22)", async () => {
	const f = makeFixture();
	try {
		const h = createHarness({ cwd: f.cwd, sessionEntries: f.sessionEntries });
		await start(h);
		// Simulate a failed mutation (lock contention / revision conflict).
		const service = h.core.goalService;
		const originalApply = service.apply.bind(service);
		service.apply = () => ({ ok: false, message: "simulated conflict: goal modified by another process" });
		try {
			const update = h.tools.get("update_goal")!;
			const result = await (update.execute as any)("update-3", { status: "blocked", reason: "test blocker" }, undefined, undefined, h.ctx);
			const text = result.content?.[0]?.text ?? "";
			assert.ok(text.includes("simulated conflict"), `must surface the mutation message, got: ${text}`);
			assert.ok(text.includes("NOT marked blocked"), `must not claim the goal is blocked, got: ${text}`);
			assert.ok(result.terminate !== true, "must not terminate the turn so the agent can retry");
		} finally {
			service.apply = originalApply;
		}
		// The goal on disk is untouched: still active, no blocked event.
		const active = activeGoalFiles(f.cwd);
		const parsed = parseGoalFile(path.join(f.cwd, ".pi", "goals", active[0]!));
		assert.equal(parsed?.status, "active", "goal must remain active");
		assert.equal(ledgerEvents(f.cwd).filter((e) => e.type === "goal_blocked").length, 0, "no goal_blocked event");
	} finally {
		f.cleanup();
	}
});

test("update_goal(paused) surfaces an apply failure instead of claiming success (#22)", async () => {
	const f = makeFixture();
	try {
		const h = createHarness({ cwd: f.cwd, sessionEntries: f.sessionEntries });
		await start(h);
		const service = h.core.goalService;
		const originalApply = service.apply.bind(service);
		service.apply = () => ({ ok: false, message: "simulated lock contention" });
		try {
			const update = h.tools.get("update_goal")!;
			const result = await (update.execute as any)("update-paused", { status: "paused", reason: "waiting on user input" }, undefined, undefined, h.ctx);
			const text = result.content?.[0]?.text ?? "";
			assert.ok(text.includes("simulated lock contention"), `must surface the mutation message, got: ${text}`);
			assert.ok(text.includes("NOT paused"), `must not claim the goal is paused, got: ${text}`);
			assert.ok(result.terminate !== true, "must not terminate the turn so the agent can retry");
		} finally {
			service.apply = originalApply;
		}
		const active = activeGoalFiles(f.cwd);
		const parsed = parseGoalFile(path.join(f.cwd, ".pi", "goals", active[0]!));
		assert.equal(parsed?.status, "active", "goal must remain active");
		assert.equal(ledgerEvents(f.cwd).filter((e) => e.type === "goal_paused").length, 0, "no goal_paused event");
	} finally {
		f.cleanup();
	}
});

// ── Stage 1 hardening: lifecycle authority and completion paths ──────────────

test("legacy paused record with autoContinue:true stays paused after session restore", async () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "goal-core-pausedrestore-"));
	mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
	// Legacy on-disk record: paused status with a stale true continuation flag.
	const legacy = normalizeGoalRecord({
		id: "legacy-paused",
		objective: "=== Goal ===\nObjective: Legacy paused goal",
		status: "paused",
		autoContinue: true,
		createdAt: "2026-08-03T09:00:00.000Z",
		updatedAt: "2026-08-03T09:00:00.000Z",
	})!;
	const written = writeActiveGoalFile({ cwd }, legacy);
	const sessionEntries = [
		{ type: "custom", customType: STATE_ENTRY, data: { goal: written } },
		{ type: "custom", customType: "pi-goal-focus", data: goalFocusDetails(legacy.id, "created") },
	];
	try {
		const h = createHarness({ cwd, sessionEntries });
		await start(h);
		const get = h.tools.get("get_goal")!;
		const result = await (get.execute as any)("get-1", {}, undefined, undefined, h.ctx);
		const text = result.content?.[0]?.text ?? "";
		assert.ok(text.includes("paused"), `restored legacy goal must be paused, got: ${text.slice(0, 120)}`);
		assert.ok(!text.includes("running"), "paused goal must not read as running");
		// The on-disk file must also still say paused after the restore reads.
		const parsed = parseGoalFile(path.join(cwd, written.activePath ?? "missing"));
		assert.equal(parsed?.status, "paused", "disk record must stay paused after restore");
		assert.equal(parsed?.autoContinue, true, "autoContinue flag survives as data");
	} finally {
		try { rmSync(cwd, { recursive: true, force: true }); } catch {}
	}
});

test("update_goal(complete) with auditor disabled in settings skips audit and records audit_skipped", async () => {
	const f = makeFixture();
	let auditorCalled = 0;
	try {
		writeFileSync(path.join(f.cwd, ".pi", "pi-goal-x-settings.json"), JSON.stringify({ disabled: true }));
		const h = createHarness({
			cwd: f.cwd,
			sessionEntries: f.sessionEntries,
			runCompletionAuditor: async () => { auditorCalled += 1; throw new Error("auditor must not run"); },
		});
		await start(h);
		const update = h.tools.get("update_goal")!;
		const result = await (update.execute as any)("update-5", { status: "complete" }, undefined, undefined, h.ctx);
		assert.ok(result.terminate === true, "disabled-auditor completion terminates the turn");
		const text = result.content?.[0]?.text ?? "";
		assert.ok(text.includes("Goal audit skipped"), "report must state audit skipped");
		assert.ok(text.includes("auditor disabled in settings"), "report must carry the settings reason");
		assert.equal(auditorCalled, 0, "auditor must not run when globally disabled");
		// Deferred archival at turn_end.
		await h.handlers.get("turn_end")?.({ message: { role: "assistant", stopReason: "stop", usage: { input: 0, output: 0 } } }, h.ctx);
		assert.equal(activeGoalFiles(f.cwd).length, 0, "disabled-auditor completion archives the goal");
		const events = ledgerEvents(f.cwd);
		const order = events.map((e) => e.type);
		assert.ok(events.some((e) => e.type === "completion_requested"), "completion_requested first");
		const skipped = events.find((e) => e.type === "audit_skipped") as Record<string, unknown> | undefined;
		assert.ok(skipped, "audit_skipped recorded");
		assert.equal(skipped!.reason, "disabled");
		assert.ok(events.some((e) => e.type === "goal_completed"), "goal_completed recorded");
		assert.ok(order.indexOf("completion_requested") < order.indexOf("audit_skipped"), "semantic order: completion_requested before audit_skipped");
		assert.ok(order.indexOf("audit_skipped") < order.indexOf("goal_completed"), "semantic order: audit_skipped before deferred completion");
	} finally {
		f.cleanup();
	}
});

test("update_goal(complete) honors a legacy persisted skipAuditor:true record", async () => {
	const f = makeFixture();
	let auditorCalled = 0;
	try {
		// Simulate the legacy per-goal bypass record on disk.
		const active = readdirSync(path.join(f.cwd, ".pi", "goals")).filter((n) => n.startsWith("active_goal_"))[0]!;
		const filePath = path.join(f.cwd, ".pi", "goals", active);
		const parsed = parseGoalFile(filePath)!;
		writeActiveGoalFile({ cwd: f.cwd }, { ...parsed, skipAuditor: true });
		const h = createHarness({
			cwd: f.cwd,
			sessionEntries: f.sessionEntries,
			runCompletionAuditor: async () => { auditorCalled += 1; throw new Error("auditor must not run"); },
		});
		await start(h);
		const update = h.tools.get("update_goal")!;
		const result = await (update.execute as any)("update-6", { status: "complete" }, undefined, undefined, h.ctx);
		const text = result.content?.[0]?.text ?? "";
		assert.ok(text.includes("per-goal auditor disabled"), "legacy skipAuditor honored with its reason");
		assert.equal(auditorCalled, 0, "auditor must not run for legacy per-goal skip");
		const events = ledgerEvents(f.cwd);
		const skipped = events.find((e) => e.type === "audit_skipped") as Record<string, unknown> | undefined;
		assert.ok(skipped, "audit_skipped recorded for legacy skip");
		assert.equal(skipped!.reason, "disabled");
	} finally {
		f.cleanup();
	}
});

test("aborted audit: Escape complete_without_audit commits with audit_skipped(user_aborted) without terminating", async () => {
	const f = makeFixture();
	let escapeDialogShown = false;
	try {
		const h = createHarness({
			cwd: f.cwd,
			sessionEntries: f.sessionEntries,
			hasUI: true,
			uiCustom: async () => { escapeDialogShown = true; return "complete_without_audit"; },
			runCompletionAuditor: async () => ({ approved: false, disapproved: false, output: "Auditor aborted.", error: "Auditor aborted." }),
		});
		await start(h);
		const update = h.tools.get("update_goal")!;
		const result = await (update.execute as any)("update-7", { status: "complete" }, undefined, undefined, h.ctx);
		assert.ok(escapeDialogShown, "Escape dialog must be shown after auditor abort");
		assert.notEqual(result.terminate, true, "Esc-bypass completion must NOT terminate the turn (agent continues to summarize)");
		const text = result.content?.[0]?.text ?? "";
		assert.ok(text.includes("Goal audit skipped"), "report must state audit skipped");
		assert.ok(text.includes("Provide a final summary"), "Esc path keeps the final-summary guidance");
		const events = ledgerEvents(f.cwd);
		const skipped = events.find((e) => e.type === "audit_skipped") as Record<string, unknown> | undefined;
		assert.ok(skipped, "audit_skipped recorded for user abort");
		assert.equal(skipped!.reason, "user_aborted");
	} finally {
		f.cleanup();
	}
});

test("focus changed while audit runs cancels completion without modifying the goal", async () => {
	const f = makeFixture();
	try {
		const h = createHarness({
			cwd: f.cwd,
			sessionEntries: f.sessionEntries,
			runCompletionAuditor: async () => {
				// The user changes focus during the independent audit, before its result.
				await h.commands.get("goal-unfocus").handler("", h.ctx);
				return { approved: true, disapproved: false, output: "All good\n<approved/>" };
			},
		});
		await start(h);
		const update = h.tools.get("update_goal")!;
		const result = await (update.execute as any)("update-8", { status: "complete" }, undefined, undefined, h.ctx);
		const text = result.content?.[0]?.text ?? "";
		assert.ok(text.includes("no longer focused"), `completion must be cancelled, got: ${text.slice(0, 120)}`);
		assert.equal(activeGoalFiles(f.cwd).length, 1, "goal must remain open and unmodified");
		const events = ledgerEvents(f.cwd);
		const outcomes = events.filter((e) => e.type === "audit_result");
		assert.equal(outcomes.length, 1, "focus interruption has exactly one recorded outcome");
		const outcome = outcomes[0];
		assert.ok(outcome);
		assert.equal(outcome.verdict, "error");
		assert.match(String(outcome.report), /focus changed/i);
		assert.equal(outcome.goalId, events.find((e) => e.type === "audit_started")?.goalId);
	} finally {
		f.cleanup();
	}
});

test("create_goal rejects fractional, zero, and unsafe token_budget values", async () => {
	const f = makeFixture();
	try {
		const h = createHarness({ cwd: f.cwd, sessionEntries: f.sessionEntries });
		await start(h);
		const create = h.tools.get("create_goal")!;
		for (const bad of [1.5, 0, -10, Number.MAX_SAFE_INTEGER + 1]) {
			const result = await (create.execute as any)("create-bad", {
				objective: "Budget rejection test",
				token_budget: bad,
			}, undefined, undefined, h.ctx);
			const text = result.content?.[0]?.text ?? "";
			assert.ok(text.includes("token_budget"), `must reject token_budget=${bad}, got: ${text.slice(0, 80)}`);
		}
		assert.equal(activeGoalFiles(f.cwd).length, 1, "no NEW goal may be created from invalid budget input (fixture goal remains)");
	} finally {
		f.cleanup();
	}
});
