/**
 * Handler-level integration suite (Stage 6 of the hardening plan): drives the
 * ACTUAL registered five tools and the GoalService through a mock pi, with an
 * injected auditor fixture — no removed tools, no model-only bypass fields.
 *
 * This replaces the historical tests/e2e/extension.test.ts (complete_goal +
 * confirmBypassAuditor surface) and joins the validation scripts as
 * `npm run test:integration`.
 */

import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import goalExtension from "../../extensions/goal.ts";
import { createGoal, goalFocusDetails } from "../../extensions/goal-record.ts";
import { parseGoalFile, writeActiveGoalFile } from "../../extensions/storage/goal-files.ts";
import { goalLedgerPath } from "../../extensions/goal-ledger.ts";

interface Harness {
	handlers: Map<string, Function>;
	tools: Map<string, ToolDefinition>;
	ctx: ExtensionContext;
}

function createHarness(cwd: string, sessionEntries: unknown[], runCompletionAuditor?: (...args: any[]) => Promise<any>): Harness {
	const handlers = new Map<string, Function>();
	const tools = new Map<string, ToolDefinition>();
	const pi = {
		registerTool: (def: ToolDefinition) => { tools.set(def.name, def); },
		registerCommand: () => {},
		on: (event: string, handler: Function) => { handlers.set(event, handler); },
		appendEntry: () => {},
		registerMessageRenderer: () => {},
		sendMessage: () => {},
		getActiveTools: () => ["read", "bash", "edit", "write"],
		setActiveTools: () => {},
		hasUI: false,
	};
	const ctx = {
		cwd,
		hasUI: false,
		sessionManager: {
			getBranch: () => sessionEntries,
			getCwd: () => cwd,
			getSessionId: () => "integration-session",
			getRoot: () => cwd,
		},
		ui: {
			notify: () => {}, setStatus: () => {}, setWidget: () => {},
			onTerminalInput: () => () => {}, select: async () => undefined,
			confirm: async () => false, custom: async () => undefined,
		},
		getSystemPrompt: () => "base",
		isIdle: () => true,
		hasPendingMessages: () => false,
		abort: () => {},
	} as unknown as ExtensionContext;
	goalExtension(pi as any, runCompletionAuditor ? { runCompletionAuditor } : {});
	return { handlers, tools, ctx };
}

async function start(h: Harness): Promise<void> {
	await h.handlers.get("session_start")?.({ reason: "start" }, h.ctx);
	await h.handlers.get("before_agent_start")?.({ systemPrompt: "base", prompt: "go", systemPromptOptions: {} }, h.ctx);
}

function fixture(opts: { objective?: string; skipAuditor?: boolean; tasksEnabled?: boolean } = {}) {
	const cwd = mkdtempSync(path.join(tmpdir(), "goal-int-"));
	mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
	if (opts.tasksEnabled === false) {
		writeFileSync(path.join(cwd, ".pi", "pi-goal-x-settings.json"), JSON.stringify({ disableTasks: true }));
	}
	const goal = createGoal({
		objective: opts.objective ?? "=== Goal ===\nObjective: Integration test",
		autoContinue: true,
		sisyphus: false,
	}, Date.UTC(2026, 8, 4, 9, 0, 0));
	if (opts.skipAuditor) goal.skipAuditor = true;
	const written = writeActiveGoalFile({ cwd }, goal);
	const sessionEntries = [
		{ type: "custom", customType: "pi-goal-focus", data: goalFocusDetails(goal.id, "created") },
	];
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
	try {
		return readFileSync(goalLedgerPath({ cwd }), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
	} catch {
		return [];
	}
}

describe("five-tool handler integration", () => {
	it("extension loading defers getActiveTools until session_start", async () => {
		// The fixed profile is installed at session_start; extension loading
		// itself must not touch the active-tool API (host compatibility).
		let getActiveToolsCalls = 0;
		const isolatedHandlers = new Map<string, Function>();
		const isolatedPi = {
			registerTool: () => {},
			registerCommand: () => {},
			on: (event: string, handler: Function) => { isolatedHandlers.set(event, handler); },
			appendEntry: () => {}, registerMessageRenderer: () => {}, sendMessage: () => {},
			getActiveTools: () => { getActiveToolsCalls++; throw new Error("Extension runtime not initialized."); },
			setActiveTools: () => {}, hasUI: false,
		};
		goalExtension(isolatedPi as any);
		assert.equal(getActiveToolsCalls, 0, "no getActiveTools call during extension loading");
		const cwd = mkdtempSync(path.join(tmpdir(), "goal-int-load-"));
		mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
		try {
			const emptyCtx = {
				cwd, hasUI: false,
				sessionManager: { getBranch: () => [], getCwd: () => cwd, getSessionId: () => "s", getRoot: () => cwd },
				ui: { notify: () => {}, setStatus: () => {}, setWidget: () => {}, onTerminalInput: () => () => {}, select: async () => undefined, confirm: async () => false, custom: async () => undefined },
				getSystemPrompt: () => "", isIdle: () => true, hasPendingMessages: () => false, abort: () => {},
			} as unknown as ExtensionContext;
			await isolatedHandlers.get("session_start")?.({ reason: "start" }, emptyCtx);
			assert.ok(getActiveToolsCalls >= 1, "profile install at session_start calls getActiveTools once");
		} finally {
			try { rmSync(cwd, { recursive: true, force: true }); } catch {}
		}
	});

	it("update_goal(complete) with an approved auditor fixture completes and archives at turn_end", async () => {
		const f = fixture();
		let auditArgs: any = null;
		try {
			const h = createHarness(f.cwd, f.sessionEntries, async (args: any) => {
				auditArgs = args;
				return { approved: true, disapproved: false, output: "All good\n<approved/>", model: "fixture" };
			});
			await start(h);
			const update = h.tools.get("update_goal")!;
			const result = await (update.execute as any)("u-1", { status: "complete" }, new AbortController().signal, undefined, h.ctx);
			const text = result.content?.[0]?.text ?? "";
			assert.ok(text.includes("Goal audit approved"), "approval report");
			assert.ok(text.includes("<approved/>"), "auditor output included");
			assert.equal(auditArgs.verificationSummary, undefined, "no paperwork field");
			await h.handlers.get("turn_end")?.({ message: { role: "assistant", stopReason: "stop", usage: { input: 0, output: 0 } } }, h.ctx);
			assert.equal(activeGoalFiles(f.cwd).length, 0, "archived at turn_end");
			const events = ledgerEvents(f.cwd);
			assert.ok(events.some((e) => e.type === "audit_result" && (e as any).verdict === "approved"));
			assert.ok(events.some((e) => e.type === "goal_completed"));
		} finally {
			f.cleanup();
		}
	});

	it("update_goal(complete) with a disapproved auditor fixture stays open with feedback", async () => {
		const f = fixture();
		try {
			const h = createHarness(f.cwd, f.sessionEntries, async () =>
				({ approved: false, disapproved: true, output: "Missing requirement\n<disapproved/>", model: "fixture" }));
			await start(h);
			const update = h.tools.get("update_goal")!;
			const result = await (update.execute as any)("u-2", { status: "complete" }, new AbortController().signal, undefined, h.ctx);
			const text = result.content?.[0]?.text ?? "";
			assert.ok(text.includes("Goal audit rejected"), "rejection feedback");
			assert.equal(activeGoalFiles(f.cwd).length, 1, "goal stays open");
		} finally {
			f.cleanup();
		}
	});

	it("update_goal(complete) with settings.disabled skips the auditor and records audit_skipped", async () => {
		const f = fixture();
		let auditorCalled = 0;
		try {
			writeFileSync(path.join(f.cwd, ".pi", "pi-goal-x-settings.json"), JSON.stringify({ disabled: true }));
			const h = createHarness(f.cwd, f.sessionEntries, async () => { auditorCalled++; throw new Error("must not run"); });
			await start(h);
			const update = h.tools.get("update_goal")!;
			const result = await (update.execute as any)("u-3", { status: "complete" }, new AbortController().signal, undefined, h.ctx);
			const text = result.content?.[0]?.text ?? "";
			assert.ok(text.includes("Goal audit skipped"), "skip report");
			assert.ok(text.includes("auditor disabled in settings"));
			assert.equal(auditorCalled, 0);
			const events = ledgerEvents(f.cwd);
			assert.ok(events.some((e) => e.type === "audit_skipped" && (e as any).reason === "disabled"));
		} finally {
			f.cleanup();
		}
	});

	it("update_goal(complete) honors a legacy persisted skipAuditor record", async () => {
		const f = fixture({ skipAuditor: true });
		let auditorCalled = 0;
		try {
			const h = createHarness(f.cwd, f.sessionEntries, async () => { auditorCalled++; throw new Error("must not run"); });
			await start(h);
			const update = h.tools.get("update_goal")!;
			const result = await (update.execute as any)("u-4", { status: "complete" }, new AbortController().signal, undefined, h.ctx);
			const text = result.content?.[0]?.text ?? "";
			assert.ok(text.includes("per-goal auditor disabled"), "legacy skip honored");
			assert.equal(auditorCalled, 0);
		} finally {
			f.cleanup();
		}
	});

	it("set_goal_tasks + update_goal_task work end-to-end through the registered handlers", async () => {
		const f = fixture();
		try {
			const h = createHarness(f.cwd, f.sessionEntries);
			await start(h);
			const setTasks = h.tools.get("set_goal_tasks")!;
			const result = await (setTasks.execute as any)("s-1", {
				tasks: [{ id: "t1", title: "Alpha" }, { id: "t2", title: "Beta" }],
			}, new AbortController().signal, undefined, h.ctx);
			assert.ok(result.terminate === true, "structural change terminates the turn");
			await h.handlers.get("before_agent_start")?.({ systemPrompt: "base", prompt: "go2", systemPromptOptions: {} }, h.ctx);
			const updateTask = h.tools.get("update_goal_task")!;
			const upd = await (updateTask.execute as any)("u-5", { task_id: "t1", status: "complete", evidence: "verified" },
				new AbortController().signal, undefined, h.ctx);
			const text = upd.content?.[0]?.text ?? "";
			assert.ok(text.includes("t1 complete"), `task update result: ${text}`);
			const goal = parseGoalFile(path.join(f.cwd, ".pi", "goals", activeGoalFiles(f.cwd)[0]!));
			assert.equal(goal?.taskList?.tasks.find((t) => t.id === "t1")?.status, "complete");
			assert.equal(goal?.taskList?.tasks.find((t) => t.id === "t2")?.status, "pending");
		} finally {
			f.cleanup();
		}
	});

	it("tasks-disabled settings install the three-core profile", async () => {
		const f = fixture({ tasksEnabled: false });
		try {
			const h = createHarness(f.cwd, f.sessionEntries);
			await start(h);
			for (const present of ["create_goal", "get_goal", "update_goal"]) {
				assert.ok(h.tools.has(present), `${present} registered`);
			}
			// The executors reject task calls when disabled.
			const setTasks = h.tools.get("set_goal_tasks")!;
			const result = await (setTasks.execute as any)("s-2", { tasks: [{ id: "t1", title: "X" }] },
				new AbortController().signal, undefined, h.ctx);
			const text = result.content?.[0]?.text ?? "";
			assert.ok(text.includes("disabled by settings"), `task tool disabled message: ${text}`);
		} finally {
			f.cleanup();
		}
	});
});
