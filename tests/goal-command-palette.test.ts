/**
 * Stage 5 command-palette tests: exactly the ten curated commands are
 * registered (no aliases), /goal and /sisyphus are the two direct creation
 * paths, and the five legacy commands are removed.
 */

import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import goalExtension from "../extensions/goal.ts";
import { parseGoalFile } from "../extensions/storage/goal-files.ts";

const CURATED_COMMANDS = [
	"goal", "sisyphus", "goal-tweak", "goal-pause", "goal-resume",
	"goal-clear", "goal-list", "goal-focus", "goal-unfocus", "goal-settings",
];

const REMOVED_COMMANDS = ["goal-status", "goals", "goals-set", "sisyphus-set", "goal-abort"];

function createHarness(cwd: string) {
	const handlers = new Map<string, Function>();
	const commands = new Map<string, any>();
	const notifications: string[] = [];
	let activeTools = ["read", "bash", "edit", "write"];
	const pi = {
		registerTool: () => {},
		registerCommand: (name: string, def: any) => { commands.set(name, def); },
		on: (event: string, handler: Function) => { handlers.set(event, handler); },
		appendEntry: () => {},
		registerMessageRenderer: () => {},
		sendMessage: () => {},
		getActiveTools: () => [...activeTools],
		setActiveTools: (names: string[]) => { activeTools = [...names]; },
		hasUI: false,
	};
	const ctx = {
		cwd,
		hasUI: false,
		sessionManager: {
			getBranch: () => [] as unknown[],
			getCwd: () => cwd,
			getSessionId: () => "palette-session",
			getRoot: () => cwd,
		},
		ui: {
			notify: (message: string) => { notifications.push(message); },
			setStatus: () => {},
			setWidget: () => {},
			onTerminalInput: () => () => {},
			select: async () => undefined,
			confirm: async () => false,
			custom: async () => undefined,
		},
		getSystemPrompt: () => "base",
		isIdle: () => true,
		hasPendingMessages: () => false,
		abort: () => {},
	} as unknown as ExtensionContext;
	goalExtension(pi as any, {});
	return { handlers, commands, ctx, notifications };
}

function activeGoalFiles(cwd: string): string[] {
	try {
		return readdirSync(path.join(cwd, ".pi", "goals")).filter((n) => n.startsWith("active_goal_"));
	} catch {
		return [];
	}
}

test("exactly the ten curated commands are registered; legacy commands are absent", () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "goal-palette-"));
	try {
		const h = createHarness(cwd);
		for (const name of CURATED_COMMANDS) {
			assert.ok(h.commands.has(name), `${name} must be registered`);
		}
		for (const name of REMOVED_COMMANDS) {
			assert.equal(h.commands.has(name), false, `${name} must NOT be registered`);
		}
		assert.equal(h.commands.size, CURATED_COMMANDS.length, "no aliases or extras");
	} finally {
		try { rmSync(cwd, { recursive: true, force: true }); } catch {}
	}
});

test("/goal <objective> creates a regular goal directly", async () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "goal-palette-create-"));
	mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
	try {
		const h = createHarness(cwd);
		await h.handlers.get("session_start")?.({ reason: "start" }, h.ctx);
		await h.commands.get("goal")!.handler("Create hello.txt with 'Hello'", h.ctx);
		const files = activeGoalFiles(cwd);
		assert.equal(files.length, 1, "goal created directly");
		const parsed = parseGoalFile(path.join(cwd, ".pi", "goals", files[0]!));
		assert.ok(parsed, "goal parses");
		assert.equal(parsed.sisyphus, false, "regular mode");
		assert.ok(parsed.objective.includes("Create hello.txt"), "objective preserved");
	} finally {
		try { rmSync(cwd, { recursive: true, force: true }); } catch {}
	}
});

test("/goal with no arguments shows status (no creation)", async () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "goal-palette-status-"));
	try {
		const h = createHarness(cwd);
		await h.handlers.get("session_start")?.({ reason: "start" }, h.ctx);
		await h.commands.get("goal")!.handler("", h.ctx);
		assert.equal(activeGoalFiles(cwd).length, 0, "no goal created");
		assert.ok(h.notifications.length >= 1, "status notification shown");
	} finally {
		try { rmSync(cwd, { recursive: true, force: true }); } catch {}
	}
});

test("/sisyphus <objective> creates a sisyphus goal directly", async () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "goal-palette-sisy-"));
	mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
	try {
		const h = createHarness(cwd);
		await h.handlers.get("session_start")?.({ reason: "start" }, h.ctx);
		await h.commands.get("sisyphus")!.handler("1) create a.txt 2) create b.txt", h.ctx);
		const files = activeGoalFiles(cwd);
		assert.equal(files.length, 1, "sisyphus goal created directly");
		const parsed = parseGoalFile(path.join(cwd, ".pi", "goals", files[0]!));
		assert.equal(parsed?.sisyphus, true, "sisyphus mode");
	} finally {
		try { rmSync(cwd, { recursive: true, force: true }); } catch {}
	}
});
