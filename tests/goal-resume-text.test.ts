/**
 * `/goal-resume <text>` passes the trailing text to the agent verbatim as a
 * plain user message; the no-arg form is unchanged.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import goalExtension from "../extensions/goal.ts";
import { createGoal, type GoalRecord } from "../extensions/goal-record.ts";
import { newGoalScheduler } from "../extensions/goal-scheduler-state.ts";
import { saveGoalSettingsFileConfig } from "../extensions/goal-settings.ts";
import { writeActiveGoalFile } from "../extensions/storage/goal-files.ts";

function createHarness(cwd: string, opts: { idle?: boolean; throwOnSend?: Error } = {}) {
	const handlers = new Map<string, Function>();
	const commands = new Map<string, any>();
	const notifications: string[] = [];
	const notified: Array<{ message: string; severity?: string }> = [];
	const sent: Array<{ message: string; deliverAs?: string }> = [];
	const pi = {
		registerTool: () => {},
		registerCommand: (name: string, def: any) => { commands.set(name, def); },
		on: (event: string, handler: Function) => { handlers.set(event, handler); },
		appendEntry: () => {},
		registerMessageRenderer: () => {},
		sendUserMessage: (message: string, options?: { deliverAs?: string }) => {
			if (opts.throwOnSend) throw opts.throwOnSend;
			sent.push({ message, deliverAs: options?.deliverAs });
		},
		sendMessage: () => {},
		getActiveTools: () => [],
		setActiveTools: () => {},
		hasUI: false,
	};
	const ctx = {
		cwd,
		hasUI: false,
		sessionManager: {
			getBranch: () => [] as unknown[],
			getCwd: () => cwd,
			getSessionId: () => "resume-text-session",
			getRoot: () => cwd,
		},
		ui: {
			notify: (message: string, severity?: string) => { notifications.push(message); notified.push({ message, severity }); },
			setStatus: () => {},
			setWidget: () => {},
			onTerminalInput: () => () => {},
			select: async () => undefined,
			confirm: async () => false,
			custom: async () => undefined,
		},
		getSystemPrompt: () => "base",
		isIdle: () => opts.idle ?? true,
		hasPendingMessages: () => false,
		abort: () => {},
	} as unknown as ExtensionContext;
	goalExtension(pi as any, {});
	const core = (pi as unknown as { _goalCore?: any })._goalCore!;
	return { commands, ctx, notifications, notified, sent, core, pi };
}

function pausedGoalFixture(cwd: string, core: any, ctx: ExtensionContext): GoalRecord {
	const goal: GoalRecord = {
		...createGoal({ objective: "Fix the flaky test", autoContinue: true, sisyphus: false }, Date.UTC(2026, 0, 2, 3, 4, 5)),
		status: "paused",
		scheduler: newGoalScheduler("resume-text-session"),
	};
	writeActiveGoalFile(ctx, goal);
	core.reconcileFocusedGoalFromDisk(ctx);
	core.setFocusedGoalId(goal.id, ctx, "selected", { recordLedger: false });
	return goal;
}

function cleanupHarness(cwd: string, core: any): void {
	try {
		core?.scheduler.shutdown();
		core?.clearContinuationState();
	} catch {}
	try { rmSync(cwd, { recursive: true, force: true }); } catch {}
}

test("/goal-resume <text> delivers the trimmed text verbatim as a followUp when idle", async () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "goal-resume-text-"));
	try {
		const h = createHarness(cwd);
		await h.commands.get("goal-resume")!.handler("  focus on the failing test first  ", h.ctx);
		assert.deepEqual(h.sent, [{ message: "focus on the failing test first", deliverAs: "followUp" }]);
	} finally {
		try { rmSync(cwd, { recursive: true, force: true }); } catch {}
	}
});

test("/goal-resume <text> delivers as steer when the agent is busy", async () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "goal-resume-text-"));
	try {
		const h = createHarness(cwd, { idle: false });
		await h.commands.get("goal-resume")!.handler("check the logs", h.ctx);
		assert.deepEqual(h.sent, [{ message: "check the logs", deliverAs: "steer" }]);
	} finally {
		try { rmSync(cwd, { recursive: true, force: true }); } catch {}
	}
});

test("/goal-resume with no args sends nothing and resumes as before", async () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "goal-resume-text-"));
	try {
		const h = createHarness(cwd);
		await h.commands.get("goal-resume")!.handler("", h.ctx);
		assert.equal(h.sent.length, 0);
		assert.ok(h.notifications.includes("No goal is focused."));
	} finally {
		try { rmSync(cwd, { recursive: true, force: true }); } catch {}
	}
});

test("/goal-resume with whitespace-only args sends nothing", async () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "goal-resume-text-"));
	try {
		const h = createHarness(cwd);
		await h.commands.get("goal-resume")!.handler("   \t ", h.ctx);
		assert.equal(h.sent.length, 0);
		assert.ok(h.notifications.includes("No goal is focused."));
	} finally {
		try { rmSync(cwd, { recursive: true, force: true }); } catch {}
	}
});

test("text is delivered even when no goal is focused", async () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "goal-resume-text-"));
	try {
		const h = createHarness(cwd);
		await h.commands.get("goal-resume")!.handler("note for later", h.ctx);
		assert.deepEqual(h.sent, [{ message: "note for later", deliverAs: "followUp" }]);
		assert.ok(h.notifications.includes("No goal is focused."), "resume path still runs after delivery");
	} finally {
		try { rmSync(cwd, { recursive: true, force: true }); } catch {}
	}
});

test("no-arg resume against a paused goal renews the allowance and sends nothing", async () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "goal-resume-text-"));
	const h = createHarness(cwd);
	try {
		pausedGoalFixture(cwd, h.core, h.ctx);
		await h.commands.get("goal-resume")!.handler("", h.ctx);
		assert.equal(h.sent.length, 0);
		assert.ok(h.notifications.includes("Goal resumed; autonomous allowance renewed."));
		assert.equal(h.core.state.goal?.status, "active");
	} finally {
		cleanupHarness(cwd, h.core);
	}
});

test("text is delivered verbatim even when resume fails (maxAutonomousRuns=0)", async () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "goal-resume-text-"));
	const h = createHarness(cwd);
	try {
		pausedGoalFixture(cwd, h.core, h.ctx);
		saveGoalSettingsFileConfig(cwd, { maxAutonomousRuns: 0 });
		await h.commands.get("goal-resume")!.handler("check the logs", h.ctx);
		assert.deepEqual(h.sent, [{ message: "check the logs", deliverAs: "followUp" }]);
		assert.ok(h.notifications.some((n) => n.includes("maxAutonomousRuns=0")), "resume failure is reported");
		assert.ok(!h.notifications.includes("Goal resumed; autonomous allowance renewed."));
	} finally {
		cleanupHarness(cwd, h.core);
	}
});

test("a throwing sendUserMessage notifies with severity error and the resume path still runs", async () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "goal-resume-text-"));
	const h = createHarness(cwd, { throwOnSend: new Error("boom") });
	try {
		await h.commands.get("goal-resume")!.handler("note for later", h.ctx);
		const errorNotice = h.notified.find((n) => n.message.startsWith("Could not deliver message to the agent:"));
		assert.ok(errorNotice, "error notification recorded");
		assert.equal(errorNotice.severity, "error");
		assert.ok(h.notifications.includes("No goal is focused."), "resume path continued after delivery failure");
	} finally {
		cleanupHarness(cwd, h.core);
	}
});
