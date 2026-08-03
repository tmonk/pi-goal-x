import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import goalExtension from "../extensions/goal.ts";
import { createGoal, goalFocusDetails, type GoalRecord } from "../extensions/goal-record.ts";
import { writeActiveGoalFile } from "../extensions/storage/goal-files.ts";

interface HarnessOptions {
	cwd: string;
	sessionEntries: unknown[];
	hasUI?: boolean;
	idle?: boolean;
	custom?: () => Promise<unknown>;
	runCompletionAuditor?: (...args: any[]) => Promise<any>;
}

function createHarness(options: HarnessOptions) {
	const appendedEntries: Array<{ customType: string; data: unknown }> = [];
	const notifications: string[] = [];
	const commands = new Map<string, { handler: (args: string, ctx: ExtensionContext) => Promise<void> | void }>();
	const handlers = new Map<string, Function>();
	const tools = new Map<string, any>();
	let activeTools = ["read", "bash", "edit", "write"];
	let abortCount = 0;
	let selectCount = 0;

	const pi = {
		registerTool: (definition: any) => { tools.set(definition.name, definition); },
		registerCommand: (name: string, definition: { handler: (args: string, ctx: ExtensionContext) => Promise<void> | void }) => {
			commands.set(name, definition);
		},
		on: (event: string, handler: Function) => { handlers.set(event, handler); },
		appendEntry: (customType: string, data: unknown) => { appendedEntries.push({ customType, data }); },
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
			getSessionId: () => "unfocus-test-session",
			getRoot: () => options.cwd,
		},
		ui: {
			notify: (message: string) => { notifications.push(message); },
			setStatus: () => {},
			setWidget: () => {},
			onTerminalInput: () => () => {},
			select: async () => { selectCount += 1; return undefined; },
			confirm: async () => false,
			custom: async () => options.custom ? options.custom() : undefined,
		},
		getSystemPrompt: () => "base prompt",
		isIdle: () => options.idle ?? true,
		hasPendingMessages: () => false,
		abort: () => { abortCount += 1; },
	} as unknown as ExtensionContext;

	goalExtension(pi as any, { runCompletionAuditor: options.runCompletionAuditor });
	return {
		ctx,
		commands,
		handlers,
		tools,
		appendedEntries,
		notifications,
		get abortCount() { return abortCount; },
		get selectCount() { return selectCount; },
	};
}

function createFixture(overrides: Partial<GoalRecord> = {}, settings: Record<string, unknown> = { autoSelectSingleGoal: false, disabled: true }) {
	const cwd = mkdtempSync(path.join(tmpdir(), "goal-unfocus-"));
	mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
	writeFileSync(path.join(cwd, ".pi", "pi-goal-x-settings.json"), JSON.stringify(settings));
	const goal = createGoal({ objective: "Keep this shared goal open", autoContinue: true, sisyphus: false });
	Object.assign(goal, overrides);
	const written = writeActiveGoalFile({ cwd } as ExtensionContext, goal);
	return {
		cwd,
		goal: written,
		activePath: path.join(cwd, written.activePath!),
		cleanup: () => rmSync(cwd, { recursive: true, force: true }),
	};
}

function latestFocusEntry(entries: Array<{ customType: string; data: unknown }>) {
	return [...entries].reverse().find((entry) => entry.customType === "pi-goal-focus");
}

test("/goal-unfocus is idempotent, session-local, and leaves the active goal byte-for-byte unchanged", async () => {
	const fixture = createFixture();
	const originalGoalFile = readFileSync(fixture.activePath);
	const harness = createHarness({
		cwd: fixture.cwd,
		sessionEntries: [{ type: "custom", customType: "pi-goal-focus", data: goalFocusDetails(fixture.goal.id, "created") }],
	});

	try {
		await harness.handlers.get("session_start")?.({ reason: "startup" }, harness.ctx);
		const command = harness.commands.get("goal-unfocus");
		assert.ok(command, "/goal-unfocus must be registered");
		await command.handler("", harness.ctx);

		assert.deepEqual(latestFocusEntry(harness.appendedEntries)?.data, {
			version: 1,
			focusedGoalId: null,
			reason: "unfocused",
		});
		assert.equal(existsSync(fixture.activePath), true);
		assert.deepEqual(readFileSync(fixture.activePath), originalGoalFile);
		assert.equal(existsSync(path.join(fixture.cwd, ".pi", "goals", "goal_events.jsonl")), false, "unfocus must not write the shared ledger");
		assert.equal(readdirSync(path.join(fixture.cwd, ".pi", "goals", "archived")).length, 0);
		assert.match(harness.notifications.at(-1) ?? "", /remains open in \.pi\/goals/);

		const focusEntryCount = harness.appendedEntries.filter((entry) => entry.customType === "pi-goal-focus").length;
		await command.handler("", harness.ctx);
		const repeatedFocusEntries = harness.appendedEntries.filter((entry) => entry.customType === "pi-goal-focus");
		assert.equal(repeatedFocusEntries.length, focusEntryCount + 1);
		assert.deepEqual(repeatedFocusEntries.at(-1)?.data, {
			version: 1,
			focusedGoalId: null,
			reason: "unfocused",
		});
		assert.deepEqual(readFileSync(fixture.activePath), originalGoalFile);

		const promptResult = await harness.handlers.get("before_agent_start")?.(
			{ systemPrompt: "base prompt", prompt: "ordinary user request" },
			harness.ctx,
		);
		assert.match(promptResult?.systemPrompt ?? "", /\[PI GOAL UNFOCUSED\]/);
		assert.doesNotMatch(promptResult?.systemPrompt ?? "", /\[PI GOAL ACTIVE/);
	} finally {
		fixture.cleanup();
	}
});

test("/goal-unfocus aborts a busy goal turn, blocks later tools, and prevents abort handlers from pausing it", async () => {
	const fixture = createFixture();
	const originalGoalFile = readFileSync(fixture.activePath);
	const harness = createHarness({
		cwd: fixture.cwd,
		idle: false,
		sessionEntries: [{ type: "custom", customType: "pi-goal-focus", data: goalFocusDetails(fixture.goal.id, "created") }],
	});
	try {
		await harness.handlers.get("session_start")?.({ reason: "startup" }, harness.ctx);
		await harness.commands.get("goal-unfocus")!.handler("", harness.ctx);
		assert.equal(harness.abortCount, 1);
		const gate = await harness.handlers.get("tool_call")?.({ toolName: "write", input: { path: "late.txt", content: "late" } }, harness.ctx);
		assert.equal(gate?.block, true);
		assert.match(gate?.reason ?? "", /already stopped earlier in this turn/);
		const abortedMessage = { role: "assistant", stopReason: "aborted", usage: { input: 0, output: 0 } };
		await harness.handlers.get("message_end")?.({ message: abortedMessage }, harness.ctx);
		await harness.handlers.get("turn_end")?.({ message: abortedMessage }, harness.ctx);
		await harness.handlers.get("agent_end")?.({ messages: [abortedMessage] }, harness.ctx);
		assert.deepEqual(readFileSync(fixture.activePath), originalGoalFile);
		assert.equal(readdirSync(path.join(fixture.cwd, ".pi", "goals", "archived")).length, 0);
	} finally {
		fixture.cleanup();
	}
});

test("/goal-unfocus preserves a paused goal and does not archive it", async () => {
	const fixture = createFixture({ status: "paused", autoContinue: false, pauseReason: "waiting" });
	const originalGoalFile = readFileSync(fixture.activePath);
	const harness = createHarness({
		cwd: fixture.cwd,
		sessionEntries: [{ type: "custom", customType: "pi-goal-focus", data: goalFocusDetails(fixture.goal.id, "created") }],
	});
	try {
		await harness.handlers.get("session_start")?.({ reason: "startup" }, harness.ctx);
		await harness.commands.get("goal-unfocus")!.handler("", harness.ctx);
		assert.deepEqual(readFileSync(fixture.activePath), originalGoalFile);
		assert.equal(readdirSync(path.join(fixture.cwd, ".pi", "goals", "archived")).length, 0);
	} finally {
		fixture.cleanup();
	}
});

test("/goal-unfocus records explicit null focus when the active goal file disappeared", async () => {
	const fixture = createFixture();
	const harness = createHarness({
		cwd: fixture.cwd,
		sessionEntries: [{ type: "custom", customType: "pi-goal-focus", data: goalFocusDetails(fixture.goal.id, "selected") }],
	});
	try {
		await harness.handlers.get("session_start")?.({ reason: "startup" }, harness.ctx);
		rmSync(fixture.activePath);
		await harness.commands.get("goal-unfocus")!.handler("", harness.ctx);
		assert.deepEqual(latestFocusEntry(harness.appendedEntries)?.data, {
			version: 1,
			focusedGoalId: null,
			reason: "unfocused",
		});
	} finally {
		fixture.cleanup();
	}
});

test("busy missing-file detachment still aborts and blocks the former goal turn", async () => {
	const fixture = createFixture();
	const harness = createHarness({
		cwd: fixture.cwd,
		idle: false,
		sessionEntries: [{ type: "custom", customType: "pi-goal-focus", data: goalFocusDetails(fixture.goal.id, "selected") }],
	});
	try {
		await harness.handlers.get("session_start")?.({ reason: "startup" }, harness.ctx);
		rmSync(fixture.activePath);
		await harness.commands.get("goal-unfocus")!.handler("", harness.ctx);
		assert.equal(harness.abortCount, 1);
		const gate = await harness.handlers.get("tool_call")?.({ toolName: "bash", input: { command: "echo late" } }, harness.ctx);
		assert.equal(gate?.block, true);
	} finally {
		fixture.cleanup();
	}
});

test("already-unfocused command does not abort unrelated busy work", async () => {
	const fixture = createFixture();
	const harness = createHarness({
		cwd: fixture.cwd,
		idle: false,
		sessionEntries: [{ type: "custom", customType: "pi-goal-focus", data: goalFocusDetails(null, "unfocused") }],
	});
	try {
		await harness.handlers.get("session_start")?.({ reason: "startup" }, harness.ctx);
		await harness.commands.get("goal-unfocus")!.handler("", harness.ctx);
		assert.equal(harness.abortCount, 0);
		assert.deepEqual(latestFocusEntry(harness.appendedEntries)?.data, {
			version: 1,
			focusedGoalId: null,
			reason: "unfocused",
		});
	} finally {
		fixture.cleanup();
	}
});

test("one session can unfocus while another remains focused on the shared goal", async () => {
	const fixture = createFixture();
	const focusEntry = { type: "custom", customType: "pi-goal-focus", data: goalFocusDetails(fixture.goal.id, "selected") };
	const first = createHarness({ cwd: fixture.cwd, sessionEntries: [focusEntry] });
	const second = createHarness({ cwd: fixture.cwd, sessionEntries: [focusEntry] });
	try {
		await first.handlers.get("session_start")?.({ reason: "startup" }, first.ctx);
		await second.handlers.get("session_start")?.({ reason: "startup" }, second.ctx);
		await first.commands.get("goal-unfocus")!.handler("", first.ctx);

		const firstPrompt = await first.handlers.get("before_agent_start")?.({ systemPrompt: "base", prompt: "hello" }, first.ctx);
		const secondPrompt = await second.handlers.get("before_agent_start")?.({ systemPrompt: "base", prompt: "continue" }, second.ctx);
		assert.match(firstPrompt?.systemPrompt ?? "", /\[PI GOAL UNFOCUSED\]/);
		assert.match(secondPrompt?.systemPrompt ?? "", new RegExp(`\\[PI GOAL ACTIVE goalId=${fixture.goal.id}\\]`));
		assert.equal(existsSync(path.join(fixture.cwd, ".pi", "goals", "goal_events.jsonl")), false);
	} finally {
		fixture.cleanup();
	}
});

test("autoSelectSingleGoal opt-in focuses one goal on resume when no focus entry exists", async () => {
	const fixture = createFixture({}, { autoSelectSingleGoal: true, disabled: true });
	const harness = createHarness({ cwd: fixture.cwd, hasUI: true, sessionEntries: [] });
	try {
		await harness.handlers.get("session_start")?.({ reason: "resume" }, harness.ctx);
		assert.equal(harness.selectCount, 0);
		const prompt = await harness.handlers.get("before_agent_start")?.({ systemPrompt: "base", prompt: "continue" }, harness.ctx);
		assert.match(prompt?.systemPrompt ?? "", new RegExp(`\\[PI GOAL ACTIVE goalId=${fixture.goal.id}\\]`));
	} finally {
		fixture.cleanup();
	}
});

test("the null entry produced by unfocus survives resume/tree and suppresses opt-in auto-selection", async () => {
	const fixture = createFixture({}, { autoSelectSingleGoal: true, disabled: true });
	const producer = createHarness({
		cwd: fixture.cwd,
		sessionEntries: [{ type: "custom", customType: "pi-goal-focus", data: goalFocusDetails(fixture.goal.id, "selected") }],
	});
	try {
		await producer.handlers.get("session_start")?.({ reason: "startup" }, producer.ctx);
		await producer.commands.get("goal-unfocus")!.handler("", producer.ctx);
		const producedEntry = latestFocusEntry(producer.appendedEntries);
		assert.ok(producedEntry);
		const sessionEntries = [{ type: "custom", customType: producedEntry.customType, data: producedEntry.data }];

		const resumed = createHarness({ cwd: fixture.cwd, hasUI: true, sessionEntries });
		await resumed.handlers.get("session_start")?.({ reason: "resume" }, resumed.ctx);
		let prompt = await resumed.handlers.get("before_agent_start")?.({ systemPrompt: "base", prompt: "hello" }, resumed.ctx);
		assert.match(prompt?.systemPrompt ?? "", /\[PI GOAL UNFOCUSED\]/, "one open goal must not auto-select despite opt-in setting");

		sessionEntries.splice(0, sessionEntries.length, {
			type: "custom",
			customType: "pi-goal-focus",
			data: goalFocusDetails(fixture.goal.id, "selected"),
		});
		await resumed.handlers.get("session_tree")?.({ newLeafId: "focused-branch", oldLeafId: "unfocused-branch" }, resumed.ctx);
		prompt = await resumed.handlers.get("before_agent_start")?.({ systemPrompt: "base", prompt: "focused branch" }, resumed.ctx);
		assert.match(prompt?.systemPrompt ?? "", new RegExp(`\\[PI GOAL ACTIVE goalId=${fixture.goal.id}\\]`));

		sessionEntries.splice(0, sessionEntries.length, {
			type: "custom",
			customType: producedEntry.customType,
			data: producedEntry.data,
		});
		await resumed.handlers.get("session_tree")?.({ newLeafId: "unfocused-branch", oldLeafId: "focused-branch" }, resumed.ctx);
		prompt = await resumed.handlers.get("before_agent_start")?.({ systemPrompt: "base", prompt: "after tree" }, resumed.ctx);
		assert.match(prompt?.systemPrompt ?? "", /\[PI GOAL UNFOCUSED\]/);

		const secondGoal = createGoal({ objective: "Second shared goal", autoContinue: true, sisyphus: false });
		const writtenSecondGoal = writeActiveGoalFile({ cwd: fixture.cwd } as ExtensionContext, secondGoal);
		sessionEntries.splice(0, sessionEntries.length, {
			type: "custom",
			customType: "pi-goal-focus",
			data: goalFocusDetails(writtenSecondGoal.id, "selected"),
		});
		await resumed.handlers.get("session_tree")?.({ newLeafId: "second-goal-branch", oldLeafId: "unfocused-branch" }, resumed.ctx);
		prompt = await resumed.handlers.get("before_agent_start")?.({ systemPrompt: "base", prompt: "second goal" }, resumed.ctx);
		assert.match(prompt?.systemPrompt ?? "", new RegExp(`\\[PI GOAL ACTIVE goalId=${writtenSecondGoal.id}\\]`));

		sessionEntries.splice(0, sessionEntries.length, {
			type: "custom",
			customType: producedEntry.customType,
			data: producedEntry.data,
		});
		const multiGoalResume = createHarness({ cwd: fixture.cwd, hasUI: true, sessionEntries });
		await multiGoalResume.handlers.get("session_start")?.({ reason: "resume" }, multiGoalResume.ctx);
		assert.equal(multiGoalResume.selectCount, 0, "resume must not prompt to replace an explicit null focus");
	} finally {
		fixture.cleanup();
	}
});

test("an approved completion audit cannot complete or archive a goal after unfocus", async () => {
	const fixture = createFixture({}, { autoSelectSingleGoal: false });
	const originalGoalFile = readFileSync(fixture.activePath);
	let resolveAudit!: (value: unknown) => void;
	let auditSignal: AbortSignal | undefined;
	let auditStarted!: () => void;
	const started = new Promise<void>((resolve) => { auditStarted = resolve; });
	const audit = new Promise<unknown>((resolve) => { resolveAudit = resolve; });
	const harness = createHarness({
		cwd: fixture.cwd,
		idle: false,
		runCompletionAuditor: async (args: { signal?: AbortSignal }) => {
			auditSignal = args.signal;
			auditStarted();
			return audit;
		},
		sessionEntries: [{ type: "custom", customType: "pi-goal-focus", data: goalFocusDetails(fixture.goal.id, "created") }],
	});
	try {
		await harness.handlers.get("session_start")?.({ reason: "startup" }, harness.ctx);
		await harness.handlers.get("before_agent_start")?.({ systemPrompt: "base", prompt: "finish" }, harness.ctx);
		const complete = harness.tools.get("update_goal");
		const completionPromise = complete.execute("complete-1", {
			status: "complete",
		}, undefined, undefined, harness.ctx);
		await started;
		await harness.commands.get("goal-unfocus")!.handler("", harness.ctx);
		assert.equal(auditSignal?.aborted, true);
		resolveAudit({ approved: true, disapproved: false, output: "Looks good\n<approved/>", model: "mock" });
		const result = await completionPromise;
		assert.match(result.content[0]?.text ?? "", /Goal completion cancelled because goal .* is no longer focused/);
		await harness.handlers.get("turn_end")?.({ message: { role: "assistant", stopReason: "stop", usage: { input: 0, output: 0 } } }, harness.ctx);
		assert.deepEqual(readFileSync(fixture.activePath), originalGoalFile);
		assert.equal(readdirSync(path.join(fixture.cwd, ".pi", "goals", "archived")).length, 0);
		const ledger = readFileSync(path.join(fixture.cwd, ".pi", "goals", "goal_events.jsonl"), "utf8");
		assert.doesNotMatch(ledger, /"type":"audit_result"/);
		assert.doesNotMatch(ledger, /"type":"goal_completed"/);
	} finally {
		fixture.cleanup();
	}
});

test("an async task-list confirmation cannot mutate the goal after unfocus", async () => {
	const fixture = createFixture();
	const originalGoalFile = readFileSync(fixture.activePath);
	let resolveDialog!: (value: unknown) => void;
	const dialog = new Promise<unknown>((resolve) => { resolveDialog = resolve; });
	const harness = createHarness({
		cwd: fixture.cwd,
		hasUI: true,
		idle: false,
		custom: () => dialog,
		sessionEntries: [{ type: "custom", customType: "pi-goal-focus", data: goalFocusDetails(fixture.goal.id, "created") }],
	});
	try {
		await harness.handlers.get("session_start")?.({ reason: "startup" }, harness.ctx);
		const proposal = harness.tools.get("set_goal_tasks");
		assert.ok(proposal);
		const proposalPromise = proposal.execute("call-1", {
			tasks: [{ id: "t1", title: "Must not be applied" }],
			block_completion: false,
		}, undefined, undefined, harness.ctx);
		await new Promise((resolve) => setImmediate(resolve));
		await harness.commands.get("goal-unfocus")!.handler("", harness.ctx);
		resolveDialog({
			cancelled: false,
			questions: [],
			answers: [{ id: "confirm", question: "Confirm Goal Draft", answer: "Confirm — create this goal now", wasCustom: false }],
			auditorEnabled: true,
		});
		const result = await proposalPromise;
		assert.match(result.content[0]?.text ?? "", /cancelled because goal .* is no longer focused/);
		assert.deepEqual(readFileSync(fixture.activePath), originalGoalFile);
	} finally {
		fixture.cleanup();
	}
});
