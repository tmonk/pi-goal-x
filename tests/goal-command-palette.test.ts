/**
 * Guided drafting is the normal entry path; the two -direct commands are the
 * explicit immediate-creation escape hatch.
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
	"goal", "sisyphus", "goal-direct", "sisyphus-direct", "goal-tweak", "goal-pause", "goal-resume",
	"goal-clear", "goal-list", "goal-status", "goal-focus", "goal-unfocus", "goal-settings", "goal-cancel",
];

const REMOVED_COMMANDS = ["goals", "goals-set", "sisyphus-set", "goal-abort"];

function createHarness(cwd: string) {
	const handlers = new Map<string, Function>();
	const commands = new Map<string, any>();
	const notifications: string[] = [];
	const messages: string[] = [];
	const tools = new Map<string, any>();
	let activeTools = ["read", "bash", "edit", "write"];
	const pi = {
		registerTool: (def: any) => { tools.set(def.name, def); },
		registerCommand: (name: string, def: any) => { commands.set(name, def); },
		on: (event: string, handler: Function) => { handlers.set(event, handler); },
		appendEntry: () => {},
		registerMessageRenderer: () => {},
		sendUserMessage: (message: string) => { messages.push(message); },
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
	return { handlers, commands, ctx, notifications, messages, tools, getActiveTools: () => [...activeTools] };
}

function activeGoalFiles(cwd: string): string[] {
	try {
		return readdirSync(path.join(cwd, ".pi", "goals")).filter((n) => n.startsWith("active_goal_"));
	} catch {
		return [];
	}
}

test("exactly the fourteen curated commands are registered; legacy commands are absent", () => {
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

test("/goal <objective> starts guided drafting without creating a goal", async () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "goal-palette-create-"));
	mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
	try {
		const h = createHarness(cwd);
		await h.handlers.get("session_start")?.({ reason: "start" }, h.ctx);
		await h.commands.get("goal")!.handler("Create hello.txt with 'Hello'", h.ctx);
		const files = activeGoalFiles(cwd);
		assert.equal(files.length, 0, "drafting does not create before confirmation");
		assert.ok(h.messages.some((message) => message.includes("GOAL CONFIRMATION")), "drafting prompt sent to agent");
		assert.deepEqual(h.getActiveTools().filter((name) => name.startsWith("goal_") || name === "propose_goal_draft"), ["goal_question", "goal_questionnaire", "propose_goal_draft"]);
	} finally {
		try { rmSync(cwd, { recursive: true, force: true }); } catch {}
	}
});

test("bare /goal begins a guided draft and asks for an objective", async () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "goal-palette-status-"));
	try {
		const h = createHarness(cwd);
		await h.handlers.get("session_start")?.({ reason: "start" }, h.ctx);
		await h.commands.get("goal")!.handler("", h.ctx);
		assert.equal(activeGoalFiles(cwd).length, 0, "no goal created");
		assert.ok(h.messages.some((message) => message.includes("ask the user what they want")), "draft prompt requests an objective");
	} finally {
		try { rmSync(cwd, { recursive: true, force: true }); } catch {}
	}
});

test("confirmed draft creates the proposed goal and agent-selected task plan together", async () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "goal-palette-confirm-"));
	mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
	try {
		const h = createHarness(cwd);
		await h.handlers.get("session_start")?.({ reason: "start" }, h.ctx);
		await h.commands.get("goal")!.handler("Ship a small feature", h.ctx);
		const proposal = h.tools.get("propose_goal_draft");
		assert.ok(proposal, "draft proposal tool registered");
		await proposal.execute("draft-1", {
			objective: "Ship a small feature.\nSuccess criteria: tests pass.",
			sisyphus: false,
			tasks: [{ id: "implement", title: "Implement the feature" }, { id: "verify", title: "Run tests" }],
			block_completion: true,
		}, new AbortController().signal, undefined, h.ctx);
		const files = activeGoalFiles(cwd);
		assert.equal(files.length, 1, "confirmed draft creates one goal");
		const goal = parseGoalFile(path.join(cwd, ".pi", "goals", files[0]!));
		assert.deepEqual(goal?.taskList?.tasks.map((task) => task.id), ["implement", "verify"]);
		assert.equal(goal?.taskList?.blockCompletion, true);
		assert.ok(h.getActiveTools().includes("update_goal"), "execution profile restored after confirmation");
	} finally {
		try { rmSync(cwd, { recursive: true, force: true }); } catch {}
	}
});

test("/goal-direct and /sisyphus-direct create goals immediately", async () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "goal-palette-sisy-"));
	mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
	try {
		const h = createHarness(cwd);
		await h.handlers.get("session_start")?.({ reason: "start" }, h.ctx);
		await h.commands.get("goal-direct")!.handler("Create hello.txt", h.ctx);
		await h.commands.get("sisyphus-direct")!.handler("1) create a.txt 2) create b.txt", h.ctx);
		const files = activeGoalFiles(cwd);
		assert.equal(files.length, 2, "direct commands create immediately");
		const parsed = files.map((file) => parseGoalFile(path.join(cwd, ".pi", "goals", file)));
		assert.ok(parsed.some((goal) => goal?.sisyphus === true), "sisyphus direct mode");
		assert.ok(parsed.some((goal) => goal?.sisyphus === false), "regular direct mode");
	} finally {
		try { rmSync(cwd, { recursive: true, force: true }); } catch {}
	}
});
