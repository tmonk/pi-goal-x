import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import goalExtension from "../extensions/goal.ts";

const GOAL_EVENT_ENTRY = "pi-goal-event";
const GOAL_STATE_ENTRY = "pi-goal-state";

interface RecordedEntry {
	customType: string;
	data: unknown;
}

interface RecordedMessage {
	message: {
		customType?: string;
		content?: unknown;
		details?: unknown;
		display?: boolean;
	};
	options: { triggerTurn?: boolean; deliverAs?: string };
}

interface GoalSnapshot {
	id: string;
	status: "active" | "paused" | "complete";
	objective: string;
	autoContinue: boolean;
	activePath?: string;
}

interface TestContext {
	cwd: string;
	hasUI: boolean;
	sessionManager: { getBranch(): RecordedEntry[] };
	ui: {
		notify(message: string, level: string): void;
		setStatus(key: string, value: string | undefined): void;
		setWidget(key: string, widget: unknown, options?: { placement?: string }): void;
		onTerminalInput(cb: (data: string) => { consume?: boolean } | undefined): () => void;
		confirm(prompt: string, body?: string): Promise<boolean>;
		select(prompt: string, options: string[]): Promise<string | undefined>;
		input(prompt: string, placeholder?: string): Promise<string | undefined>;
	};
	getSystemPrompt(): string;
	abort(): void;
	signal: AbortSignal;
	hasPendingMessages(): boolean;
	isIdle(): boolean;
}

interface RegisteredCommand {
	handler(rawArgs: string, ctx: TestContext): Promise<void> | void;
}

interface Harness {
	ctx: TestContext;
	commands: Map<string, RegisteredCommand>;
	handlers: Map<string, (...args: unknown[]) => unknown>;
	entries: RecordedEntry[];
	messages: RecordedMessage[];
	setIdle(next: boolean): void;
	setPendingMessages(next: boolean): void;
	aborted(): boolean;
	cleanup(): void;
}

function makeHarness(initial = { idle: true, pendingMessages: false }): Harness {
	const cwd = mkdtempSync(path.join(tmpdir(), "pi-goal-x-extension-test-"));
	const commands = new Map<string, RegisteredCommand>();
	const handlers = new Map<string, (...args: unknown[]) => unknown>();
	const entries: RecordedEntry[] = [];
	const messages: RecordedMessage[] = [];
	const activeTools: string[] = [];
	let idle = initial.idle;
	let pendingMessages = initial.pendingMessages;
	let aborted = false;
	const abortController = new AbortController();

	const pi = {
		getActiveTools: () => [...activeTools],
		setActiveTools: (tools: string[]) => {
			activeTools.splice(0, activeTools.length, ...tools);
		},
		appendEntry: (customType: string, data: unknown) => {
			entries.push({ customType, data });
		},
		registerCommand: (name: string, command: unknown) => {
			commands.set(name, command as RegisteredCommand);
		},
		registerTool: (_tool: unknown) => {},
		registerMessageRenderer: (_name: string, _renderer: unknown) => {},
		on: (eventName: string, handler: unknown) => {
			handlers.set(eventName, handler as (...args: unknown[]) => unknown);
		},
		sendMessage: async (message: unknown, options: { triggerTurn?: boolean; deliverAs?: string } = {}) => {
			messages.push({ message: message as RecordedMessage["message"], options });
		},
		sendUserMessage: async (message: unknown, options: { deliverAs?: string } = {}) => {
			messages.push({
				message: { content: message } as RecordedMessage["message"],
				options: { deliverAs: options.deliverAs },
			});
		},
	};

	const extensionApi: unknown = pi;
	goalExtension(extensionApi as Parameters<typeof goalExtension>[0]);

	const ctx: TestContext = {
		cwd,
		hasUI: false,
		sessionManager: {
			getBranch: () => entries,
		},
		ui: {
			notify: () => {},
			setStatus: () => {},
			setWidget: () => {},
			onTerminalInput: () => () => {},
			confirm: async () => false,
			select: async () => undefined,
			input: async () => undefined,
		},
		getSystemPrompt: () => "BASE",
		abort: () => {
			aborted = true;
			abortController.abort();
		},
		signal: abortController.signal,
		hasPendingMessages: () => pendingMessages,
		isIdle: () => idle,
	};

	return {
		ctx,
		commands,
		handlers,
		entries,
		messages,
		setIdle: (next: boolean) => {
			idle = next;
		},
		setPendingMessages: (next: boolean) => {
			pendingMessages = next;
		},
		aborted: () => aborted,
		cleanup: () => {
			rmSync(cwd, { recursive: true, force: true });
		},
	};
}

async function runCommand(harness: Harness, name: string, rawArgs = ""): Promise<void> {
	const command = harness.commands.get(name);
	assert.ok(command, `missing command: ${name}`);
	await command.handler(rawArgs, harness.ctx);
}

async function emit(harness: Harness, eventName: string, ...args: unknown[]): Promise<unknown> {
	const handler = harness.handlers.get(eventName);
	assert.ok(handler, `missing handler: ${eventName}`);
	return await Promise.resolve(handler(...args));
}

async function sleep(ms: number): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, ms));
}

function latestGoalSnapshot(entries: RecordedEntry[]): GoalSnapshot | null {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (!entry || entry.customType !== GOAL_STATE_ENTRY) continue;
		const data = entry.data as { version?: number; goal?: { id?: unknown; status?: unknown; objective?: unknown; autoContinue?: unknown; activePath?: unknown } | null };
		const goal = data.goal;
		if (!goal) return null;
		if (typeof goal.id !== "string" || typeof goal.objective !== "string" || typeof goal.autoContinue !== "boolean") return null;
		const status = goal.status === "paused" || goal.status === "complete" ? goal.status : "active";
		return {
			id: goal.id,
			status,
			objective: goal.objective,
			autoContinue: goal.autoContinue,
			activePath: typeof goal.activePath === "string" ? goal.activePath : undefined,
		};
	}
	return null;
}

function checkpointPrompt(goalId: string): string {
	return [
		`<pi_goal_continuation goal_id="${goalId}" kind="checkpoint">`,
		`[GOAL CHECKPOINT goalId=${goalId}]`,
		"Continue working toward the active pi goal.",
	].join("\n");
}

function checkpointMessage(goalId: string, objective: string): {
	customType: string;
	content: string;
	display: boolean;
	details: { kind: "checkpoint"; goalId: string; status: "active"; objective: string; timestamp: number };
} {
	return {
		customType: GOAL_EVENT_ENTRY,
		content: checkpointPrompt(goalId),
		display: true,
		details: {
			kind: "checkpoint",
			goalId,
			status: "active",
			objective,
			timestamp: Date.now(),
		},
	};
}

async function createGoal(harness: Harness, objective: string, mode: "goal" | "sisyphus" = "sisyphus"): Promise<GoalSnapshot> {
	await runCommand(harness, mode === "sisyphus" ? "sisyphus-set" : "goals-set", objective);
	const snapshot = latestGoalSnapshot(harness.entries);
	assert.ok(snapshot, "goal snapshot missing");
	return snapshot;
}

function writePausedGoalFile(harness: Harness, goal: GoalSnapshot): void {
	assert.ok(goal.activePath, "goal activePath missing");
	const filePath = path.join(harness.ctx.cwd, goal.activePath);
	const content = readFileSync(filePath, "utf8");
	const splitAt = content.indexOf("\n\n# Goal Prompt");
	assert.ok(splitAt > 0, "goal file metadata split missing");
	const metadata = JSON.parse(content.slice(0, splitAt)) as Record<string, unknown>;
	metadata.status = "paused";
	metadata.autoContinue = false;
	metadata.stopReason = "agent";
	metadata.pauseReason = "persisted pause wins over stale memory";
	writeFileSync(filePath, `${JSON.stringify(metadata, null, 2)}${content.slice(splitAt)}`, "utf8");
}

test("goal extension queues active auto-continue checkpoint and keeps it actionable", async () => {
	const harness = makeHarness({ idle: true, pendingMessages: false });
	try {
		const goal = await createGoal(harness, "Ship active checkpoint guard regression", "sisyphus");
		await sleep(20);

		assert.equal(harness.messages.length, 1);
		const queued = harness.messages[0];
		assert.equal(queued.message.customType, GOAL_EVENT_ENTRY);
		assert.equal(queued.options.triggerTurn, true);
		assert.equal(queued.options.deliverAs, "followUp");
		const queuedPrompt = queued.message.content;
		if (typeof queuedPrompt !== "string") throw new Error("queued prompt missing");
		assert.match(queuedPrompt, new RegExp(`^<pi_goal_continuation goal_id="${goal.id}"`));

		const activeContext = await emit(harness, "context", { messages: [queued.message] }) as { messages?: Array<{ content?: unknown; details?: unknown; display?: boolean }> } | undefined;
		assert.equal(activeContext, undefined);

		const before = await emit(harness, "before_agent_start", {
			prompt: queuedPrompt,
			systemPrompt: "BASE",
		}, harness.ctx) as { systemPrompt?: string } | undefined;
		assert.equal(typeof before?.systemPrompt, "string");
		assert.ok(before?.systemPrompt?.includes(`[PI GOAL ACTIVE goalId=${goal.id}]`));

		await emit(harness, "turn_start", "", harness.ctx);
		const toolResult = await emit(harness, "tool_call", { toolName: "read", args: { path: "README.md" } }, harness.ctx) as { block?: boolean } | undefined;
		assert.equal(toolResult, undefined);
	} finally {
		harness.cleanup();
	}
});

test("paused goal on session_start resume does not queue continuation", async () => {
	const harness = makeHarness({ idle: true, pendingMessages: false });
	try {
		await createGoal(harness, "Stay paused on session resume", "sisyphus");
		await sleep(20);
		harness.messages.splice(0);

		await runCommand(harness, "goal-pause");
		await emit(harness, "session_start", { reason: "resume" }, harness.ctx);
		await sleep(20);

		const current = latestGoalSnapshot(harness.entries);
		assert.equal(current?.status, "paused");
		assert.equal(current?.autoContinue, false);
		assert.equal(harness.messages.length, 0);
	} finally {
		harness.cleanup();
	}
});

test("paused goal on session_tree does not queue continuation", async () => {
	const harness = makeHarness({ idle: true, pendingMessages: false });
	try {
		await createGoal(harness, "Stay paused on tree restore", "sisyphus");
		await sleep(20);
		harness.messages.splice(0);

		await runCommand(harness, "goal-pause");
		await emit(harness, "session_tree", {}, harness.ctx);
		await sleep(20);

		const current = latestGoalSnapshot(harness.entries);
		assert.equal(current?.status, "paused");
		assert.equal(current?.autoContinue, false);
		assert.equal(harness.messages.length, 0);
	} finally {
		harness.cleanup();
	}
});

test("paused checkpoint reconciles from disk and aborts before work starts", async () => {
	const harness = makeHarness({ idle: true, pendingMessages: false });
	try {
		const goal = await createGoal(harness, "Persisted pause beats stale memory", "sisyphus");
		const checkpoint = checkpointMessage(goal.id, goal.objective);
		writePausedGoalFile(harness, goal);

		const before = await emit(harness, "before_agent_start", {
			prompt: checkpoint.content,
			systemPrompt: "BASE",
		}, harness.ctx) as { systemPrompt?: string } | undefined;
		assert.ok(before?.systemPrompt, "stale checkpoint prompt missing");
		assert.ok(before?.systemPrompt.includes(`[GOAL STALE goalId=${goal.id}]`));
		assert.equal(harness.aborted(), true);

		const contextResult = await emit(harness, "context", { messages: [checkpoint] }) as { messages?: Array<{ content?: unknown; display?: boolean; details?: { kind?: string; goalId?: string; currentGoalId?: string | null; currentStatus?: string | null } }> } | undefined;
		assert.ok(contextResult?.messages, "context result missing");
		const stale = contextResult.messages[0];
		assert.equal(stale?.display, false);
		assert.equal(stale?.details?.kind, "stale");
		assert.equal(stale?.details?.goalId, goal.id);
		assert.equal(stale?.details?.currentGoalId, goal.id);
		assert.equal(stale?.details?.currentStatus, "paused");

		await emit(harness, "turn_start", "", harness.ctx);
		const blockedBash = await emit(harness, "tool_call", { toolName: "bash", args: { command: "echo BAD" } }, harness.ctx) as { block?: boolean; reason?: string } | undefined;
		assert.equal(blockedBash?.block, true);
		assert.match(blockedBash?.reason ?? "", /goal was already stopped earlier in this turn/);
		const blockedQuestion = await emit(harness, "tool_call", { toolName: "goal_question", args: { question: "Should I keep going?" } }, harness.ctx) as { block?: boolean; reason?: string } | undefined;
		assert.equal(blockedQuestion?.block, true);
		assert.match(blockedQuestion?.reason ?? "", /goal was already stopped earlier in this turn/);
		const blockedSubagent = await emit(harness, "tool_call", { toolName: "subagent", args: { task: "delegate stale work" } }, harness.ctx) as { block?: boolean; reason?: string } | undefined;
		assert.equal(blockedSubagent?.block, true);
		assert.match(blockedSubagent?.reason ?? "", /goal was already stopped earlier in this turn/);
		const blockedUnknown = await emit(harness, "tool_call", { toolName: "unknown_extension_tool", args: { payload: "delegate stale work" } }, harness.ctx) as { block?: boolean; reason?: string } | undefined;
		assert.equal(blockedUnknown?.block, true);
		assert.match(blockedUnknown?.reason ?? "", /goal was already stopped earlier in this turn/);
		const allowedGetGoal = await emit(harness, "tool_call", { toolName: "get_goal", args: {} }, harness.ctx) as { block?: boolean } | undefined;
		assert.equal(allowedGetGoal, undefined);
	} finally {
		harness.cleanup();
	}
});

test("explicit goal-resume returns paused goal to active continuation", async () => {
	const harness = makeHarness({ idle: true, pendingMessages: false });
	try {
		const goal = await createGoal(harness, "Resume only on explicit command", "sisyphus");
		await sleep(20);
		harness.messages.splice(0);

		await runCommand(harness, "goal-pause");
		await runCommand(harness, "goal-resume");
		await sleep(20);

		const current = latestGoalSnapshot(harness.entries);
		assert.equal(current?.id, goal.id);
		assert.equal(current?.status, "active");
		assert.equal(current?.autoContinue, true);
		assert.equal(harness.messages.length, 1);
		const queued = harness.messages[0];
		assert.equal(queued.message.customType, GOAL_EVENT_ENTRY);
		assert.equal(queued.options.triggerTurn, true);
		assert.equal(queued.options.deliverAs, "followUp");
		const queuedPrompt = queued.message.content;
		if (typeof queuedPrompt !== "string") throw new Error("queued prompt missing");
		assert.match(queuedPrompt, new RegExp(`^<pi_goal_continuation goal_id="${goal.id}"`));

		const before = await emit(harness, "before_agent_start", {
			prompt: queuedPrompt,
			systemPrompt: "BASE",
		}, harness.ctx) as { systemPrompt?: string } | undefined;
		assert.equal(typeof before?.systemPrompt, "string");
		assert.ok(before?.systemPrompt?.includes(`[PI GOAL ACTIVE goalId=${goal.id}]`));

		const toolResultBeforeTurnStart = await emit(harness, "tool_call", { toolName: "read", args: { path: "README.md" } }, harness.ctx) as { block?: boolean } | undefined;
		assert.equal(toolResultBeforeTurnStart, undefined);

		await emit(harness, "turn_start", "", harness.ctx);
		const toolResultAfterTurnStart = await emit(harness, "tool_call", { toolName: "read", args: { path: "README.md" } }, harness.ctx) as { block?: boolean } | undefined;
		assert.equal(toolResultAfterTurnStart, undefined);
	} finally {
		harness.cleanup();
	}
});

test("active checkpoint prep tools do not poison same turn", async () => {
	const harness = makeHarness({ idle: true, pendingMessages: false });
	try {
		const goal = await createGoal(harness, "Prep tools must not stop active checkpoint", "sisyphus");
		const checkpoint = checkpointMessage(goal.id, goal.objective);

		const before = await emit(harness, "before_agent_start", {
			prompt: checkpoint.content,
			systemPrompt: "BASE",
		}, harness.ctx) as { systemPrompt?: string } | undefined;
		assert.equal(typeof before?.systemPrompt, "string");
		assert.ok(before?.systemPrompt?.includes(`[PI GOAL ACTIVE goalId=${goal.id}]`));

		await emit(harness, "turn_start", "", harness.ctx);
		const recall = await emit(harness, "tool_call", { toolName: "session_recall", args: { query: "active goal" } }, harness.ctx) as { block?: boolean } | undefined;
		assert.equal(recall, undefined);
		const grep = await emit(harness, "tool_call", { toolName: "fff_multi_grep", args: { pattern: "turnStoppedFor" } }, harness.ctx) as { block?: boolean } | undefined;
		assert.equal(grep, undefined);
		const read = await emit(harness, "tool_call", { toolName: "read", args: { path: "README.md" } }, harness.ctx) as { block?: boolean } | undefined;
		assert.equal(read, undefined);
	} finally {
		harness.cleanup();
	}
});

test("post-stop marker from prior agent generation does not block active goal tools", async () => {
	const harness = makeHarness({ idle: true, pendingMessages: false });
	try {
		const oldGoal = await createGoal(harness, "Prior turn marker must self-heal", "sisyphus");
		await runCommand(harness, "sisyphus-set", "Replacement active goal after stop marker");
		const goal = latestGoalSnapshot(harness.entries);
		assert.ok(goal, "replacement goal missing");
		assert.notEqual(goal.id, oldGoal.id);

		const before = await emit(harness, "before_agent_start", {
			prompt: "User resumed normal work",
			systemPrompt: "BASE",
		}, harness.ctx) as { systemPrompt?: string } | undefined;
		assert.equal(typeof before?.systemPrompt, "string");
		assert.ok(before?.systemPrompt?.includes(`[PI GOAL ACTIVE goalId=${goal.id}]`));

		const allowedFff = await emit(harness, "tool_call", { toolName: "fff_multi_grep", args: { pattern: "turnStoppedFor" } }, harness.ctx) as { block?: boolean } | undefined;
		assert.equal(allowedFff, undefined);
	} finally {
		harness.cleanup();
	}
});

for (const scenario of [
	{ name: "pause", stop: async (h: Harness) => runCommand(h, "goal-pause") },
	{ name: "clear", stop: async (h: Harness) => runCommand(h, "goal-clear") },
	{ name: "replace", stop: async (h: Harness) => runCommand(h, "sisyphus-set", "Replacement objective") },
] as const) {
	test(`goal extension stales queued checkpoint after ${scenario.name} before turn start`, async () => {
		const harness = makeHarness({ idle: true, pendingMessages: false });
		try {
			const goal = await createGoal(harness, `Queued checkpoint ${scenario.name}`, "sisyphus");
			const checkpoint = checkpointMessage(goal.id, goal.objective);

			await scenario.stop(harness);
			await sleep(20);

			const current = latestGoalSnapshot(harness.entries);
			if (scenario.name === "replace") {
				assert.ok(current, "replacement goal missing");
				assert.ok(harness.messages.length > 0, "replacement should queue new checkpoint");
				for (const queued of harness.messages) {
					const details = queued.message.details as { goalId?: unknown } | undefined;
					assert.equal(details?.goalId, current.id);
				}
			} else {
				assert.equal(harness.messages.length, 0);
			}

			const contextResult = await emit(harness, "context", { messages: [checkpoint] }) as { messages?: Array<{ content?: unknown; display?: boolean; details?: { kind?: string; goalId?: string; currentGoalId?: string | null; currentStatus?: string | null } }> } | undefined;
			assert.ok(contextResult && contextResult.messages, "context result missing");
			const stale = contextResult.messages[0];
			assert.ok(stale, "stale message missing");
			assert.equal(stale.display, false);
			assert.equal(stale.details?.kind, "stale");
			assert.equal(stale.details?.goalId, goal.id);
			assert.equal(stale.details?.currentGoalId, latestGoalSnapshot(harness.entries)?.id ?? null);
			assert.equal(stale.details?.currentStatus, latestGoalSnapshot(harness.entries)?.status ?? null);
			assert.ok(String(stale.content ?? "").startsWith(`[GOAL STALE goalId=${goal.id}]`));

			const before = await emit(harness, "before_agent_start", {
				prompt: checkpoint.content,
				systemPrompt: "BASE",
			}, harness.ctx) as { systemPrompt?: string } | undefined;
			assert.ok(before?.systemPrompt, "stale checkpoint prompt missing");
			assert.ok(before?.systemPrompt.includes(`[GOAL STALE goalId=${goal.id}]`));
			assert.equal(harness.aborted(), true);
		} finally {
			harness.cleanup();
		}
	});
}

for (const scenario of ["pause", "clear", "replace"] as const) {
	test(`goal extension blocks work tools if ${scenario} happens after checkpoint turn starts`, async () => {
		const harness = makeHarness({ idle: false, pendingMessages: false });
		try {
			const goal = await createGoal(harness, `Mid-turn checkpoint ${scenario}`, "sisyphus");
			const checkpoint = checkpointMessage(goal.id, goal.objective);

			const before = await emit(harness, "before_agent_start", {
				prompt: checkpoint.content,
				systemPrompt: "BASE",
			}, harness.ctx) as { systemPrompt?: string } | undefined;
			assert.equal(typeof before?.systemPrompt, "string");
			assert.ok(before?.systemPrompt?.includes(`[PI GOAL ACTIVE goalId=${goal.id}]`));

			await emit(harness, "turn_start", "", harness.ctx);

			if (scenario === "pause") {
				await runCommand(harness, "goal-pause");
			} else if (scenario === "clear") {
				await runCommand(harness, "goal-clear");
			} else {
				await runCommand(harness, "sisyphus-set", "Replacement objective");
			}

			const contextResult = await emit(harness, "context", { messages: [checkpoint] }) as { messages?: Array<{ content?: unknown; display?: boolean; details?: { kind?: string; goalId?: string; currentGoalId?: string | null; currentStatus?: string | null } }> } | undefined;
			assert.ok(contextResult && contextResult.messages, "context result missing");
			const stale = contextResult.messages[0];
			assert.ok(stale, "stale message missing");
			assert.equal(stale.details?.kind, "stale");
			assert.equal(stale.details?.goalId, goal.id);
			assert.equal(stale.details?.currentGoalId, latestGoalSnapshot(harness.entries)?.id ?? null);
			assert.equal(stale.details?.currentStatus, latestGoalSnapshot(harness.entries)?.status ?? null);

			const blockedQuestion = await emit(harness, "tool_call", { toolName: "goal_question", args: { question: "Should I keep going?" } }, harness.ctx) as { block?: boolean; reason?: string } | undefined;
			assert.equal(blockedQuestion?.block, true);
			assert.match(blockedQuestion?.reason ?? "", /goal was already stopped earlier in this turn/);
			assert.match(blockedQuestion?.reason ?? "", new RegExp(`goalId=${goal.id}`));

			const blockedSubagent = await emit(harness, "tool_call", { toolName: "subagent", args: { task: "delegate stale work" } }, harness.ctx) as { block?: boolean; reason?: string } | undefined;
			assert.equal(blockedSubagent?.block, true);
			assert.match(blockedSubagent?.reason ?? "", /goal was already stopped earlier in this turn/);
			assert.match(blockedSubagent?.reason ?? "", new RegExp(`goalId=${goal.id}`));

			const blockedUnknown = await emit(harness, "tool_call", { toolName: "unknown_extension_tool", args: { payload: "delegate stale work" } }, harness.ctx) as { block?: boolean; reason?: string } | undefined;
			assert.equal(blockedUnknown?.block, true);
			assert.match(blockedUnknown?.reason ?? "", /goal was already stopped earlier in this turn/);
			assert.match(blockedUnknown?.reason ?? "", new RegExp(`goalId=${goal.id}`));

			const allowedGetGoal = await emit(harness, "tool_call", { toolName: "get_goal", args: {} }, harness.ctx) as { block?: boolean } | undefined;
			assert.equal(allowedGetGoal, undefined);

			const blocked = await emit(harness, "tool_call", { toolName: "read", args: { path: "README.md" } }, harness.ctx) as { block?: boolean; reason?: string } | undefined;
			assert.equal(blocked?.block, true);
			assert.match(blocked?.reason ?? "", /goal was already stopped earlier in this turn/);
			assert.match(blocked?.reason ?? "", new RegExp(`goalId=${goal.id}`));
		} finally {
			harness.cleanup();
		}
	});
}

test("goal extension stales queued checkpoint after unfocus before turn start", async () => {
	const harness = makeHarness({ idle: true, pendingMessages: false });
	try {
		const goal = await createGoal(harness, "Queued checkpoint unfocus", "sisyphus");
		const checkpoint = checkpointMessage(goal.id, goal.objective);
		await sleep(20);

		rmSync(path.join(harness.ctx.cwd, ".pi", "goals"), { recursive: true, force: true });
		await emit(harness, "session_tree", {}, harness.ctx);

		const contextResult = await emit(harness, "context", { messages: [checkpoint] }) as { messages?: Array<{ content?: unknown; display?: boolean; details?: { kind?: string; goalId?: string; currentGoalId?: string | null; currentStatus?: string | null } }> } | undefined;
		assert.ok(contextResult && contextResult.messages, "context result missing");
		const stale = contextResult.messages[0];
		assert.ok(stale, "stale message missing");
		assert.equal(stale.display, false);
		assert.equal(stale.details?.kind, "stale");
		assert.equal(stale.details?.goalId, goal.id);
		assert.equal(stale.details?.currentGoalId, null);
		assert.equal(stale.details?.currentStatus, null);
		assert.ok(String(stale.content ?? "").startsWith(`[GOAL STALE goalId=${goal.id}]`));

		const before = await emit(harness, "before_agent_start", {
			prompt: checkpoint.content,
			systemPrompt: "BASE",
		}, harness.ctx) as { systemPrompt?: string } | undefined;
		assert.ok(before?.systemPrompt, "stale checkpoint prompt missing");
		assert.ok(before?.systemPrompt.includes(`[GOAL STALE goalId=${goal.id}]`));
		assert.equal(harness.aborted(), true);

		await emit(harness, "turn_start", "", harness.ctx);
		const blockedQuestion = await emit(harness, "tool_call", { toolName: "goal_question", args: { question: "Should I keep going?" } }, harness.ctx) as { block?: boolean; reason?: string } | undefined;
		assert.equal(blockedQuestion?.block, true);
		assert.match(blockedQuestion?.reason ?? "", /goal was already stopped earlier in this turn/);
		assert.match(blockedQuestion?.reason ?? "", new RegExp(`goalId=${goal.id}`));

		const allowedGetGoal = await emit(harness, "tool_call", { toolName: "get_goal", args: {} }, harness.ctx) as { block?: boolean } | undefined;
		assert.equal(allowedGetGoal, undefined);
	} finally {
		harness.cleanup();
	}
});
