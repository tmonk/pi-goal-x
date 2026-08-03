import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import goalExtension from "../extensions/goal.ts";
import { createGoal, goalFocusDetails } from "../extensions/goal-record.ts";
import { writeActiveGoalFile } from "../extensions/storage/goal-files.ts";

test("/goal-unfocus clears only session focus and leaves the shared goal open", async () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "goal-unfocus-"));
	mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
	writeFileSync(
		path.join(cwd, ".pi", "pi-goal-x-settings.json"),
		JSON.stringify({ autoSelectSingleGoal: false, disabled: true }),
	);

	const goal = createGoal({ objective: "Keep this shared goal open", autoContinue: true, sisyphus: false });
	const written = writeActiveGoalFile({ cwd } as ExtensionContext, goal);
	const activePath = path.join(cwd, written.activePath!);
	const originalGoalFile = readFileSync(activePath);
	const sessionEntries = [
		{ type: "custom", customType: "pi-goal-focus", data: goalFocusDetails(goal.id, "created") },
	];
	const appendedEntries: Array<{ customType: string; data: unknown }> = [];
	const notifications: string[] = [];
	const commands = new Map<string, { handler: (args: string, ctx: ExtensionContext) => Promise<void> | void }>();
	const handlers = new Map<string, Function>();
	let activeTools = ["read", "bash", "edit", "write"];

	const pi = {
		registerTool: () => {},
		registerCommand: (name: string, definition: { handler: (args: string, ctx: ExtensionContext) => Promise<void> | void }) => {
			commands.set(name, definition);
		},
		on: (event: string, handler: Function) => { handlers.set(event, handler); },
		appendEntry: (customType: string, data: unknown) => { appendedEntries.push({ customType, data }); },
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
			getBranch: () => sessionEntries,
			getCwd: () => cwd,
			getSessionId: () => "unfocus-test-session",
			getRoot: () => cwd,
		},
		ui: {
			notify: (message: string) => { notifications.push(message); },
		},
		getSystemPrompt: () => "base prompt",
		isIdle: () => true,
		hasPendingMessages: () => false,
		abort: () => {},
	} as unknown as ExtensionContext;

	try {
		goalExtension(pi as any);
		await handlers.get("session_start")?.({ reason: "start" }, ctx);

		const command = commands.get("goal-unfocus");
		assert.ok(command, "/goal-unfocus must be registered");
		await command.handler("", ctx);

		const focusEntry = [...appendedEntries].reverse().find((entry) => entry.customType === "pi-goal-focus");
		assert.deepEqual(focusEntry?.data, {
			version: 1,
			focusedGoalId: null,
			reason: "unfocused",
		});
		assert.equal(existsSync(activePath), true, "shared active goal file must remain");
		assert.deepEqual(readFileSync(activePath), originalGoalFile, "shared active goal file must remain unchanged");
		assert.match(notifications.at(-1) ?? "", /remains open in \.pi\/goals/);

		const focusEntryCount = appendedEntries.filter((entry) => entry.customType === "pi-goal-focus").length;
		await command.handler("", ctx);
		const repeatedFocusEntries = appendedEntries.filter((entry) => entry.customType === "pi-goal-focus");
		assert.equal(repeatedFocusEntries.length, focusEntryCount + 1, "repeated unfocus must persist explicit null focus");
		assert.deepEqual(repeatedFocusEntries.at(-1)?.data, {
			version: 1,
			focusedGoalId: null,
			reason: "unfocused",
		});
		assert.deepEqual(readFileSync(activePath), originalGoalFile, "repeated unfocus must not modify the shared goal");

		const promptResult = await handlers.get("before_agent_start")?.(
			{ systemPrompt: "base prompt", prompt: "ordinary user request" },
			ctx,
		);
		assert.match(promptResult?.systemPrompt ?? "", /\[PI GOAL UNFOCUSED\]/);
		assert.doesNotMatch(promptResult?.systemPrompt ?? "", /\[PI GOAL ACTIVE/);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});
