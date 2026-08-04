/**
 * Handler-level integration suite (Stage 6 of the hardening plan): drives the
 * ACTUAL registered five tools and the GoalService through a mock pi, with an
 * injected auditor fixture — no removed tools, no model-only bypass fields.
 *
 * This replaces the historical tests/e2e/extension.test.ts (complete_goal +
 * confirmBypassAuditor surface) and joins the validation scripts as
 * `npm run test:integration`.
 */

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
	commands: Map<string, any>;
	ctx: ExtensionContext;
	notifies: Array<{ msg: string; level: string }>;
	activeToolsHistory: string[][];
	terminalInputHandler: ((data: string) => unknown) | null;
}

interface HarnessOptions {
	cwd: string;
	sessionEntries: unknown[];
	runCompletionAuditor?: (...args: any[]) => Promise<any>;
	hasUI?: boolean;
	select?: (prompt: string, options: string[]) => Promise<string | undefined>;
	input?: (prompt: string, fallback: string) => Promise<string | undefined>;
	confirm?: () => Promise<boolean>;
	uiCustom?: () => Promise<any>;
}

function createHarness(options: HarnessOptions): Harness {
	const handlers = new Map<string, Function>();
	const tools = new Map<string, ToolDefinition>();
	const commands = new Map<string, any>();
	const notifies: Array<{ msg: string; level: string }> = [];
	const activeToolsHistory: string[][] = [];
	let activeTools = ["read", "bash", "edit", "write"];
	let terminalInputHandler: ((data: string) => unknown) | null = null;
	const pi = {
		registerTool: (def: ToolDefinition) => { tools.set(def.name, def); },
		registerCommand: (name: string, def: any) => { commands.set(name, def); },
		on: (event: string, handler: Function) => { handlers.set(event, handler); },
		appendEntry: () => {},
		registerMessageRenderer: () => {},
		sendMessage: () => {},
		getActiveTools: () => [...activeTools],
		setActiveTools: (next: string[]) => { activeTools = [...next]; activeToolsHistory.push([...next]); },
		hasUI: options.hasUI ?? false,
	};
	const ctx = {
		cwd: options.cwd,
		hasUI: options.hasUI ?? false,
		sessionManager: {
			getBranch: () => options.sessionEntries,
			getCwd: () => options.cwd,
			getSessionId: () => "integration-session",
			getRoot: () => options.cwd,
		},
		ui: {
			notify: (msg: string, level: string) => { notifies.push({ msg, level }); }, setStatus: () => {}, setWidget: () => {},
			onTerminalInput: (cb: (data: string) => unknown) => { terminalInputHandler = cb; return () => {}; },
			select: options.select ?? (async () => undefined),
			input: options.input ?? (async () => undefined),
			confirm: options.confirm ?? (async () => false),
			custom: options.uiCustom ?? (async () => undefined),
		},
		getSystemPrompt: () => "base",
		isIdle: () => true,
		hasPendingMessages: () => false,
		abort: () => {},
	} as unknown as ExtensionContext;
	goalExtension(pi as any, options.runCompletionAuditor ? { runCompletionAuditor: options.runCompletionAuditor } : {});
	return {
		handlers, tools, commands, ctx, notifies, activeToolsHistory,
		get terminalInputHandler() { return terminalInputHandler; },
	};
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
			const originalConsoleError = console.error;
			console.error = () => {};
			try {
				await isolatedHandlers.get("session_start")?.({ reason: "start" }, emptyCtx);
			} finally {
				console.error = originalConsoleError;
			}
			assert.ok(getActiveToolsCalls >= 1, "profile install at session_start calls getActiveTools once");
		} finally {
			try { rmSync(cwd, { recursive: true, force: true }); } catch {}
		}
	});

	it("update_goal(complete) with an approved auditor fixture completes and archives at turn_end", async () => {
		const f = fixture();
		let auditArgs: any = null;
		try {
			const h = createHarness({ cwd: f.cwd, sessionEntries: f.sessionEntries, runCompletionAuditor: async (args: any) => {
				auditArgs = args;
				return { approved: true, disapproved: false, output: "All good\n<approved/>", model: "fixture" };
			} });
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
			const h = createHarness({ cwd: f.cwd, sessionEntries: f.sessionEntries, runCompletionAuditor: async () =>
				({ approved: false, disapproved: true, output: "Missing requirement\n<disapproved/>", model: "fixture" }) });
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
			const h = createHarness({ cwd: f.cwd, sessionEntries: f.sessionEntries, runCompletionAuditor: async () => { auditorCalled++; throw new Error("must not run"); } });
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
			const h = createHarness({ cwd: f.cwd, sessionEntries: f.sessionEntries, runCompletionAuditor: async () => { auditorCalled++; throw new Error("must not run"); } });
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
			const h = createHarness({ cwd: f.cwd, sessionEntries: f.sessionEntries });
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
			const h = createHarness({ cwd: f.cwd, sessionEntries: f.sessionEntries });
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

	it("goal-settings menu toggles the disabled switch through the registered handler", async () => {
		const f = fixture();
		try {
			const selects: string[] = ["  disabled: (default)", "Done"];
			const h = createHarness({
				cwd: f.cwd,
				sessionEntries: f.sessionEntries,
				hasUI: true,
				select: async () => selects.shift(),
			});
			await start(h);
			const settingsCmd = h.commands.get("goal-settings");
			assert.ok(settingsCmd, "goal-settings command registered");
			await settingsCmd.handler("", h.ctx); // must not throw (regression: recursive saveSettings)
			const settingsPath = path.join(f.cwd, ".pi", "pi-goal-x-settings.json");
			const saved = JSON.parse(readFileSync(settingsPath, "utf8"));
			assert.equal(saved.disabled, true, "menu toggle must persist disabled: true");
		} finally {
			f.cleanup();
		}
	});

	it("goal-settings menu editing persists a field without stack overflow", async () => {
		const f = fixture();
		try {
			writeFileSync(path.join(f.cwd, ".pi", "pi-goal-x-settings.json"), JSON.stringify({ disabled: true }));
			const selects: string[] = ["  thinking_level: off", "off", "Done"];
			const inputs: string[] = ["off"];
			const h = createHarness({
				cwd: f.cwd,
				sessionEntries: f.sessionEntries,
				hasUI: true,
				select: async () => selects.shift(),
				input: async () => inputs.shift(),
			});
			await start(h);
			const settingsCmd = h.commands.get("goal-settings");
			await settingsCmd.handler("", h.ctx);
			const saved = JSON.parse(readFileSync(path.join(f.cwd, ".pi", "pi-goal-x-settings.json"), "utf8"));
			assert.equal(saved.disabled, true, "existing setting preserved");
			assert.equal(saved.thinking_level, "off", "thinking_level edited through the menu");
		} finally {
			f.cleanup();
		}
	});

	describe("goal-settings menu (follow-up Stage 1)", () => {
		const settingsPath = (cwd: string) => path.join(cwd, ".pi", "pi-goal-x-settings.json");
		const readSettings = (cwd: string) => {
			const p = settingsPath(cwd);
			return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : {};
		};

		it("displays every one of the eight persisted rows and reflects file values", async () => {
			const f = fixture();
			try {
				writeFileSync(settingsPath(f.cwd), JSON.stringify({
					disableTasks: true, subtaskDepth: 3, provider: "anthropic", thinking_level: "high", disabled: true,
				}));
				let firstOptions: string[] = [];
				const h = createHarness({
					cwd: f.cwd, sessionEntries: f.sessionEntries, hasUI: true,
					select: async (_prompt: string, options: string[]) => {
						if (firstOptions.length === 0) firstOptions = [...options];
						return "Done";
					},
				});
				await start(h);
				await h.commands.get("goal-settings").handler("", h.ctx);
				const lines = firstOptions.filter((o) => o.startsWith("  ") && !o.startsWith("  ───"));
				assert.equal(lines.length, 8, `all eight rows rendered, got: ${lines.join(" | ")}`);
				assert.ok(lines.some((l) => l === "  disabled: true"));
				assert.ok(lines.some((l) => l === "  provider: anthropic"));
				assert.ok(lines.some((l) => l === "  model: (default)"));
				assert.ok(lines.some((l) => l === "  thinking_level: high"));
				assert.ok(lines.some((l) => l === "  disableTasks: true"));
				assert.ok(lines.some((l) => l === "  disableContracts: false"));
				assert.ok(lines.some((l) => l === "  subtaskDepth: 3"));
				assert.ok(lines.some((l) => l === "  autoSelectSingleGoal: false"));
			} finally {
				f.cleanup();
			}
		});

		it("toggles every boolean row directly and persists each value", async () => {
			const f = fixture();
			try {
				const selects = [
					"  disableTasks: (default)",
					"  disableContracts: (default)",
					"  disabled: (default)",
					"  autoSelectSingleGoal: (default)",
					"Done",
				];
				const h = createHarness({
					cwd: f.cwd, sessionEntries: f.sessionEntries, hasUI: true,
					select: async () => selects.shift(),
				});
				await start(h);
				await h.commands.get("goal-settings").handler("", h.ctx);
				const saved = readSettings(f.cwd);
				assert.equal(saved.disableTasks, true);
				assert.equal(saved.disableContracts, true);
				assert.equal(saved.disabled, true);
				assert.equal(saved.autoSelectSingleGoal, true);
				// Second pass toggles disableTasks off and autoSelectSingleGoal off; the
				// file must then omit both keys (false is the default and not persisted).
				const selects2 = ["  disableTasks: true", "  autoSelectSingleGoal: true", "Done"];
				const h2 = createHarness({
					cwd: f.cwd, sessionEntries: f.sessionEntries, hasUI: true,
					select: async () => selects2.shift(),
				});
				await start(h2);
				await h2.commands.get("goal-settings").handler("", h2.ctx);
				const saved2 = readSettings(f.cwd);
				assert.equal(saved2.disableTasks, undefined, "disableTasks toggled back off clears the key");
				assert.equal(saved2.autoSelectSingleGoal, undefined, "autoSelectSingleGoal toggled back off clears the key");
				assert.equal(saved2.disableContracts, true, "untouched boolean preserved");
				assert.equal(saved2.disabled, true, "untouched boolean preserved");
			} finally {
				f.cleanup();
			}
		});

		it("edits and clears provider and model text fields", async () => {
			const f = fixture();
			try {
				const selects = ["  provider: (default)", "  model: (default)", "Done"];
				const inputs = ["anthropic", "claude-sonnet-4"];
				const h = createHarness({
					cwd: f.cwd, sessionEntries: f.sessionEntries, hasUI: true,
					select: async () => selects.shift(),
					input: async () => inputs.shift(),
				});
				await start(h);
				await h.commands.get("goal-settings").handler("", h.ctx);
				const saved = readSettings(f.cwd);
				assert.equal(saved.provider, "anthropic");
				assert.equal(saved.model, "claude-sonnet-4");
				// Clear both by entering an empty value.
				const selects2 = ["  provider: anthropic", "  model: claude-sonnet-4", "Done"];
				const inputs2 = ["", ""];
				const h2 = createHarness({
					cwd: f.cwd, sessionEntries: f.sessionEntries, hasUI: true,
					select: async () => selects2.shift(),
					input: async () => inputs2.shift(),
				});
				await start(h2);
				await h2.commands.get("goal-settings").handler("", h2.ctx);
				const saved2 = readSettings(f.cwd);
				assert.equal(saved2.provider, undefined, "empty input clears provider");
				assert.equal(saved2.model, undefined, "empty input clears model");
			} finally {
				f.cleanup();
			}
		});

		it("accepts every thinking level and rejects unknown values", async () => {
			const f = fixture();
			try {
				const selects = [
					"  thinking_level: (default)", "off",
					"  thinking_level: off", "minimal",
					"  thinking_level: minimal", "low",
					"  thinking_level: low", "medium",
					"  thinking_level: medium", "high",
					"  thinking_level: high", "xhigh",
					"Done",
				];
				const inputs = ["off", "minimal", "low", "medium", "high", "xhigh"];
				const h = createHarness({
					cwd: f.cwd, sessionEntries: f.sessionEntries, hasUI: true,
					select: async () => selects.shift(),
					input: async () => inputs.shift(),
				});
				await start(h);
				await h.commands.get("goal-settings").handler("", h.ctx);
				const saved = readSettings(f.cwd);
				assert.equal(saved.thinking_level, "xhigh", "all six levels accepted in sequence");
				// Unknown value is rejected with a warning and nothing is persisted.
				const notifiesBefore = h.notifies.length;
				const selects2 = ["  thinking_level: xhigh", "bogus", "Done"];
				const inputs2 = ["bogus"];
				const h2 = createHarness({
					cwd: f.cwd, sessionEntries: f.sessionEntries, hasUI: true,
					select: async () => selects2.shift(),
					input: async () => inputs2.shift(),
				});
				await start(h2);
				await h2.commands.get("goal-settings").handler("", h2.ctx);
				assert.ok(h2.notifies.some((n) => n.level === "warning" && n.msg.includes("thinking_level must be one of")),
					"unknown thinking level warns");
				assert.equal(readSettings(f.cwd).thinking_level, "xhigh", "rejected value is not persisted");
			} finally {
				f.cleanup();
			}
		});

		it("subtaskDepth accepts 1 and rejects 1.5, 1x, zero, negative, infinity, and unsafe values", async () => {
			const f = fixture();
			try {
				const rejects = ["1.5", "1x", "0", "-3", "Infinity", "9007199254740992", "", "1"];
				const inputs = [...rejects];
				const selects: string[] = [];
				for (let i = 0; i < rejects.length; i++) selects.push("  subtaskDepth: (default)");
				selects.push("Done");
				const h = createHarness({
					cwd: f.cwd, sessionEntries: f.sessionEntries, hasUI: true,
					select: async () => selects.shift(),
					input: async () => inputs.shift(),
				});
				await start(h);
				await h.commands.get("goal-settings").handler("", h.ctx);
				const warnings = h.notifies.filter((n) => n.level === "warning" && n.msg.includes("subtaskDepth"));
				assert.equal(warnings.length, rejects.length - 1, `every invalid input warns: ${warnings.length}`);
				assert.equal(readSettings(f.cwd).subtaskDepth, 1, "only the valid input is persisted");
			} finally {
				f.cleanup();
			}
		});

		it("toggling tasks off, on, and off in one menu session reinstalls the correct fixed profile each time", async () => {
			const f = fixture();
			try {
				const selects = ["  disableTasks: (default)", "  disableTasks: true", "  disableTasks: (default)", "Done"];
				const h = createHarness({
					cwd: f.cwd, sessionEntries: f.sessionEntries, hasUI: true,
					select: async () => selects.shift(),
				});
				await start(h);
				// session_start installed the five-tool profile: history[0].
				assert.equal(h.activeToolsHistory.length, 1, "one install at session_start");
				await h.commands.get("goal-settings").handler("", h.ctx);
				// Each real change reinstalls exactly once: three, five, three.
				assert.equal(h.activeToolsHistory.length, 4, "three reinstalls after session_start");
				const installed = h.activeToolsHistory.slice(1).map((tools) => (tools.includes("set_goal_tasks") ? "five" : "three"));
				assert.deepEqual(installed, ["three", "five", "three"], "profile alternates three/five/three, never skipping a toggle");
				const saved = readSettings(f.cwd);
				assert.equal(saved.disableTasks, true, "final file state has tasks disabled");
			} finally {
				f.cleanup();
			}
		});

		it("headless /goal-settings reports the settings file path without editing", async () => {
			const f = fixture();
			try {
				const h = createHarness({ cwd: f.cwd, sessionEntries: f.sessionEntries, hasUI: false });
				await start(h);
				await h.commands.get("goal-settings").handler("", h.ctx);
				assert.ok(h.notifies.some((n) => n.msg.includes("Settings file: ") && n.msg.includes("pi-goal-x-settings.json")),
					`headless notification: ${h.notifies.map((n) => n.msg).join(" | ")}`);
				const p = settingsPath(f.cwd);
				assert.ok(!existsSync(p), "headless invocation must not create the settings file");
			} finally {
				f.cleanup();
			}
		});

		it("environment overrides take precedence in the profile-reinstall decision", async () => {
			const f = fixture();
			const prevTasks = process.env.PI_GOAL_DISABLE_TASKS;
			process.env.PI_GOAL_DISABLE_TASKS = "true";
			try {
				// session_start installs the three-tool profile because the env
				// override forces disableTasks even though the file is absent.
				const h = createHarness({ cwd: f.cwd, sessionEntries: f.sessionEntries, hasUI: true });
				await start(h);
				assert.equal(h.activeToolsHistory.length, 1, "three-tool install at session_start");
				assert.ok(!h.activeToolsHistory[0]!.includes("set_goal_tasks"), "env override installs the core profile");
				// Toggling the file value cannot change the effective setting, so no
				// reinstall may happen even though the menu session edits twice.
				const selects = ["  disableTasks: (default)", "  disableTasks: true", "Done"];
				const h2 = createHarness({
					cwd: f.cwd, sessionEntries: f.sessionEntries, hasUI: true,
					select: async () => selects.shift(),
				});
				await start(h2);
				await h2.commands.get("goal-settings").handler("", h2.ctx);
				assert.equal(h2.activeToolsHistory.length, 1, "no reinstall when the effective setting never changed");
			} finally {
				if (prevTasks === undefined) delete process.env.PI_GOAL_DISABLE_TASKS;
				else process.env.PI_GOAL_DISABLE_TASKS = prevTasks;
				f.cleanup();
			}
		});
	});

describe("confirmation and audit UX (follow-up Stage 2)", () => {
	it("/goal-clear asks for confirmation; cancelling is a byte-for-byte no-op", async () => {
		const f = fixture();
		try {
			const before = readFileSync(path.join(f.cwd, ".pi", "goals", activeGoalFiles(f.cwd)[0]!), "utf8");
			const ledgerBefore = ledgerEvents(f.cwd).length;
			let confirmPrompt = "";
			const h = createHarness({
				cwd: f.cwd, sessionEntries: f.sessionEntries, hasUI: true,
				confirm: async () => { confirmPrompt = "asked"; return false; },
			});
			await start(h);
			await h.commands.get("goal-clear").handler("", h.ctx);
			assert.ok(confirmPrompt === "asked", "confirmation must be requested before archiving");
			assert.equal(activeGoalFiles(f.cwd).length, 1, "goal must stay open after cancel");
			const after = readFileSync(path.join(f.cwd, ".pi", "goals", activeGoalFiles(f.cwd)[0]!), "utf8");
			assert.equal(after, before, "active goal file unchanged byte-for-byte");
			assert.equal(ledgerEvents(f.cwd).length, ledgerBefore, "no ledger entry appended on cancel");
			assert.ok(h.notifies.some((n) => n.msg.includes("cancelled")), "cancel acknowledged");
		} finally {
			f.cleanup();
		}
	});

	it("/goal-clear confirms and archives the selected goal", async () => {
		const f = fixture();
		try {
			const h = createHarness({
				cwd: f.cwd, sessionEntries: f.sessionEntries, hasUI: true,
				confirm: async () => true,
			});
			await start(h);
			await h.commands.get("goal-clear").handler("", h.ctx);
			assert.equal(activeGoalFiles(f.cwd).length, 0, "goal archived after confirm");
			const archived = readdirSync(path.join(f.cwd, ".pi", "goals", "archived"));
			assert.equal(archived.length, 1, "exactly one goal archived");
			assert.ok(h.notifies.some((n) => n.msg.includes("cleared and archived")), "archive acknowledged");
		} finally {
			f.cleanup();
		}
	});

	it("/goal-clear headless returns guidance without mutation", async () => {
		const f = fixture();
		try {
			const before = readFileSync(path.join(f.cwd, ".pi", "goals", activeGoalFiles(f.cwd)[0]!), "utf8");
			const ledgerBefore = ledgerEvents(f.cwd).length;
			const h = createHarness({ cwd: f.cwd, sessionEntries: f.sessionEntries, hasUI: false });
			await start(h);
			await h.commands.get("goal-clear").handler("", h.ctx);
			assert.equal(activeGoalFiles(f.cwd).length, 1, "headless clear must not archive");
			assert.equal(readFileSync(path.join(f.cwd, ".pi", "goals", activeGoalFiles(f.cwd)[0]!), "utf8"), before, "file unchanged");
			assert.equal(ledgerEvents(f.cwd).length, ledgerBefore, "no ledger entry in headless clear");
			assert.ok(h.notifies.some((n) => n.msg.includes("interactive session")), "headless guidance notification");
		} finally {
			f.cleanup();
		}
	});

	it("Escape abort during audit appends exactly one audit_skipped and completes without audit", async () => {
		const f = fixture();
		let auditorStartedResolve: (() => void) | null = null;
		try {
			const h = createHarness({
				cwd: f.cwd, sessionEntries: f.sessionEntries, hasUI: true,
				uiCustom: async () => "complete_without_audit",
				runCompletionAuditor: async ({ signal }: any) => {
						auditorStartedResolve?.();
					await new Promise<void>((resolve) => {
						signal.addEventListener("abort", () => resolve(), { once: true });
					});
					return { approved: false, disapproved: false, output: "Auditor aborted.", error: "Auditor aborted." };
				},
			});
			await start(h);
			const auditorStarted = new Promise<void>((resolve) => { auditorStartedResolve = resolve; });
			const update = h.tools.get("update_goal")!;
			const pending = (update.execute as any)("abort-1", { status: "complete" }, new AbortController().signal, undefined, h.ctx);
			// The auditor fixture is now running: progress display and the abort
			// controller are set. Simulate the user pressing Escape mid-audit.
			await auditorStarted;
			// The widget's Escape handler matches the raw ESC byte (\x1b).
			h.terminalInputHandler?.("");
			const result = await pending;
			const text = result.content?.[0]?.text ?? "";
			assert.ok(text.includes("Goal audit skipped"), `skip report: ${text.slice(0, 80)}`);
			const skipped = ledgerEvents(f.cwd).filter((e) => e.type === "audit_skipped");
			assert.equal(skipped.length, 1, "exactly one canonical audit_skipped event (no duplicate from the abort callback)");
			assert.equal((skipped[0] as any).reason, "user_aborted");
		} finally {
			f.cleanup();
		}
	});

	it("Escape abort then continue working leaves the goal active with no skip event", async () => {
		const f = fixture();
		let auditorStartedResolve: (() => void) | null = null;
		try {
			const h = createHarness({
				cwd: f.cwd, sessionEntries: f.sessionEntries, hasUI: true,
				uiCustom: async () => "continue_working",
				runCompletionAuditor: async ({ signal }: any) => {
					auditorStartedResolve?.();
					await new Promise<void>((resolve) => {
						signal.addEventListener("abort", () => resolve(), { once: true });
					});
					return { approved: false, disapproved: false, output: "Auditor aborted.", error: "Auditor aborted." };
				},
			});
			await start(h);
			const auditorStarted = new Promise<void>((resolve) => { auditorStartedResolve = resolve; });
			const update = h.tools.get("update_goal")!;
			const pending = (update.execute as any)("abort-2", { status: "complete" }, new AbortController().signal, undefined, h.ctx);
			await auditorStarted;
			// The widget's Escape handler matches the raw ESC byte (\x1b).
			h.terminalInputHandler?.("");
			const result = await pending;
			const text = result.content?.[0]?.text ?? "";
			assert.ok(text.includes("remains active"), `continue-working report: ${text}`);
			assert.notEqual(result.terminate, true, "continue working must not terminate the turn");
			const goal = parseGoalFile(path.join(f.cwd, ".pi", "goals", activeGoalFiles(f.cwd)[0]!));
			assert.equal(goal?.status, "active", "goal stays active after continue working");
			const events = ledgerEvents(f.cwd);
			assert.equal(events.some((e) => e.type === "audit_skipped"), false, "no skip event for continue working");
			assert.equal(events.some((e) => e.type === "goal_completed"), false, "goal not completed");
		} finally {
			f.cleanup();
		}
	});
});

describe("completion transaction hardening (follow-up Stage 3)", () => {
	it("completion commit write failure never reports success and never clears focus", async () => {
		const f = fixture();
		const goalsDir = path.join(f.cwd, ".pi", "goals");
		try {
			// Pre-create the ledger file so its fallback append path works even
			// when the goals directory is read-only (append needs write on the
			// file, not the directory; the atomic goal write needs a writable
			// directory and therefore fails).
			writeFileSync(goalLedgerPath({ cwd: f.cwd }), "", "utf8");
			const h = createHarness({
				cwd: f.cwd, sessionEntries: f.sessionEntries,
				runCompletionAuditor: async () =>
					({ approved: true, disapproved: false, output: "All good\n<approved/>", model: "fixture" }),
			});
			await start(h);
			// Block the authoritative active-file write (reads still work).
			chmodSync(goalsDir, 0o555);
			const update = h.tools.get("update_goal")!;
			const result = await (update.execute as any)("fail-write-1", { status: "complete" }, new AbortController().signal, undefined, h.ctx);
			const text = result.content?.[0]?.text ?? "";
			assert.ok(text.includes("Goal completion failed"), `failure report expected: ${text.slice(0, 120)}`);
			assert.ok(text.includes("not completed"), "must state the goal was not completed");
			assert.ok(!text.includes("Goal audit approved"), "no success report when the state mutation failed");
			assert.notEqual(result.terminate, true, "no termination request on failed completion");
			// The deferred archival at turn_end must not emit goal_completed.
			await h.handlers.get("turn_end")?.({ message: { role: "assistant", stopReason: "stop", usage: { input: 0, output: 0 } } }, h.ctx);
			const events = ledgerEvents(f.cwd);
			assert.equal(events.some((e) => e.type === "goal_completed"), false, "no goal_completed event");
			assert.ok(events.some((e) => e.type === "audit_result"), "audit itself ran and recorded its result");
			// The goal stays open and focused (get_goal still reports it, not complete).
			const get = h.tools.get("get_goal")!;
			const snapshot = await (get.execute as any)("g-1", {}, new AbortController().signal, undefined, h.ctx);
			const snapText = snapshot.content?.[0]?.text ?? "";
			assert.ok(snapText.includes("Status: running"), `goal still open and active: ${snapText.slice(0, 100)}`);
		} finally {
			try { chmodSync(goalsDir, 0o755); } catch {}
			f.cleanup();
		}
	});

	it("deferred-archive failure at turn_end keeps the goal open and records no goal_completed", async () => {
		const f = fixture();
		try {
			const h = createHarness({
				cwd: f.cwd, sessionEntries: f.sessionEntries,
				runCompletionAuditor: async () =>
					({ approved: true, disapproved: false, output: "All good\n<approved/>", model: "fixture" }),
			});
			await start(h);
			const update = h.tools.get("update_goal")!;
			const result = await (update.execute as any)("fail-arch-1", { status: "complete" }, new AbortController().signal, undefined, h.ctx);
			const text = result.content?.[0]?.text ?? "";
			assert.ok(text.includes("Goal audit approved"), "commit itself succeeded");
			// Sabotage the archived directory: the deferred archive write fails.
			const archivedDir = path.join(f.cwd, ".pi", "goals", "archived");
			rmSync(archivedDir, { recursive: true, force: true });
			writeFileSync(archivedDir, "not a directory", "utf8");
			await h.handlers.get("turn_end")?.({ message: { role: "assistant", stopReason: "stop", usage: { input: 0, output: 0 } } }, h.ctx);
			const events = ledgerEvents(f.cwd);
			assert.equal(events.some((e) => e.type === "goal_completed"), false, "no goal_completed when archive failed");
			assert.ok(h.notifies.some((n) => n.msg.includes("Failed to archive completed goal")), "archive failure is observable");
			assert.equal(activeGoalFiles(f.cwd).length, 1, "goal file stays in the active pool");
			// The active file still holds the completed goal (not archived).
			const remaining = parseGoalFile(path.join(f.cwd, ".pi", "goals", activeGoalFiles(f.cwd)[0]!));
			assert.equal(remaining?.status, "complete", "completed goal remains on disk, unarchived");
		} finally {
			f.cleanup();
		}
	});
});
