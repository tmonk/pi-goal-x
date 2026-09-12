/**
 * Regression and lifecycle tests for goal-level provider-error recovery.
 *
 * Regression seed (user report): a 503 `server_error` payload of the shape
 *
 *     Error: 503: {"type":"server_error","message":"Error from provider
 *     (Console): Upstream request failed: Endpoint is unavailable."}
 *     Error: Retry failed after 3 attempts: 503: {...}
 *
 * was NOT classified as a network error by isNetworkErrorAssistantMessage
 * (which only matched the literal text "network error"), so Pi's built-in
 * retries exhausted and no goal-level backoff ever engaged.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import piGoalExtension from "../extensions/goal.ts";
import {
	createGoal,
	goalFocusDetails,
	type GoalRecord,
	type GoalStateEntry,
} from "../extensions/goal-record.ts";
import {
	hasNetworkErrorAssistantMessage,
	isNetworkErrorAssistantMessage,
} from "../extensions/goal-format.ts";

const FIXTURE_GOAL = readFileSync(
	new URL("./fixtures/goals/active_goal_fixture.md", import.meta.url),
	"utf8",
);

/** The exact reported failure, as Pi surfaces it in errorMessage. */
const REPORTED_503_MESSAGE =
	'503: {"type":"server_error","message":"Error from provider (Console): Upstream request failed: Endpoint is unavailable."}';
const REPORTED_503_AFTER_RETRIES = `Retry failed after 3 attempts: ${REPORTED_503_MESSAGE}`;

// ── Harness (mirrors tests/goal-stale-continuation-golden.test.ts) ──────────

interface HandlerMap {
	[key: string]: (event: any, ctx: ExtensionContext) => Promise<unknown> | unknown;
}

function createHarness(cwd: string) {
	const handlers: HandlerMap = {};
	const sentMessages: Array<{ customType?: string; details?: unknown }> = [];
	const notifications: Array<{ message: string; level?: string }> = [];
	let aborts = 0;

	const mockPi = {
		registerTool: () => {},
		registerCommand: () => {},
		on: (event: string, handler: (...args: never[]) => unknown) => {
			handlers[event] = handler as HandlerMap[string];
		},
		appendEntry: () => {},
		registerMessageRenderer: () => {},
		sendMessage: (msg: { customType?: string; details?: unknown }) => {
			sentMessages.push(msg);
		},
		sendUserMessage: () => {},
		getActiveTools: () => ["read", "bash", "edit", "write"],
		setActiveTools: () => {},
		hasUI: false,
	};

	const ctx = {
		cwd,
		hasUI: false,
		sessionManager: {
			getBranch: () => [],
			getCwd: () => cwd,
			getSessionId: () => "test-session",
			getRoot: () => cwd,
			append: () => {},
			appendModelChange: () => {},
			appendThinkingLevelChange: () => {},
			appendCompetingWriteCheck: () => {},
			buildSessionContext: () => ({ messages: [], sessionId: "test", model: null, thinkingLevel: "medium" }),
		},
		getSystemPrompt: () => "",
		isIdle: () => false,
		hasPendingMessages: () => true,
		abort: () => {
			aborts++;
		},
		ui: { notify: (message: string, level?: string) => notifications.push({ message, level }) },
	} as unknown as ExtensionContext & { abort: () => void };

	piGoalExtension(mockPi as never);

	return {
		handlers,
		sentMessages,
		notifications,
		get aborts() {
			return aborts;
		},
		ctx,
	};
}

function fixtureCwd(): { cwd: string; goal: GoalRecord } {
	const cwd = mkdtempSync(path.join(tmpdir(), "goal-network-recovery-"));
	mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
	writeFileSync(path.join(cwd, ".pi", "goals", "active_goal_fixture.md"), FIXTURE_GOAL);
	const parsed = createGoal(
		{ objective: "Golden fixture goal objective", autoContinue: true, sisyphus: false },
		Date.UTC(2026, 7, 3, 9, 0, 0),
	);
	return { cwd, goal: { ...parsed, id: "golden_fixture_goal" } };
}

function sessionEntriesFor(goal: GoalRecord) {
	const stateEntry: GoalStateEntry = {
		version: 3,
		goal: {
			...goal,
			activePath: ".pi/goals/active_goal_fixture.md",
			usage: { tokensUsed: 0, activeSeconds: 0 },
			taskList: undefined,
			verificationContract: undefined,
		},
	};
	return [
		{ type: "custom", customType: "pi-goal-focus", data: goalFocusDetails(goal.id, "created") },
		{ type: "custom", customType: "pi-goal-state", data: stateEntry },
	];
}

async function startSession(handlers: HandlerMap, ctx: ExtensionContext, entries: unknown[]) {
	const ss = handlers["session_start"];
	assert.ok(ss, "session_start handler must be registered");
	await ss({ reason: "start" }, {
		...ctx,
		sessionManager: { ...ctx.sessionManager, getBranch: () => entries },
	} as unknown as ExtensionContext);
}

/** Idle ctx: continuation fires immediately instead of rescheduling. */
function idleCtx(ctx: ExtensionContext): ExtensionContext {
	return {
		...ctx,
		isIdle: () => true,
		hasPendingMessages: () => false,
	} as unknown as ExtensionContext;
}

async function countCheckpoints(h: ReturnType<typeof createHarness>): Promise<number> {
	await new Promise((resolve) => setTimeout(resolve, 20));
	return h.sentMessages.filter(
		(m) => m.customType === "pi-goal-event" && (m.details as { kind?: string } | undefined)?.kind === "checkpoint",
	).length;
}

async function markGoalWork(h: ReturnType<typeof createHarness>): Promise<void> {
	await h.handlers["turn_start"]!({}, h.ctx);
	await h.handlers["tool_call"]!({ toolName: "bash", args: { command: "ls" } }, h.ctx);
	await h.handlers["tool_execution_end"]!({}, h.ctx);
}

// ── Classification unit coverage ─────────────────────────────────────────────

test("classification: exact reported 503 server_error payload is a network error", () => {
	assert.equal(
		isNetworkErrorAssistantMessage({
			role: "assistant",
			stopReason: "error",
			errorMessage: REPORTED_503_MESSAGE,
		}),
		true,
		"the raw 503 server_error payload must classify as recoverable",
	);
	assert.equal(
		isNetworkErrorAssistantMessage({
			role: "assistant",
			stopReason: "error",
			errorMessage: REPORTED_503_AFTER_RETRIES,
		}),
		true,
		"the payload after Pi exhausts its own retries must still classify",
	);
	assert.equal(
		hasNetworkErrorAssistantMessage([
			{ role: "assistant", stopReason: "error", errorMessage: REPORTED_503_AFTER_RETRIES },
		]),
		true,
	);
});

test("classification: 429 rate-limit payloads are transient", () => {
	assert.equal(
		isNetworkErrorAssistantMessage({
			role: "assistant",
			stopReason: "error",
			errorMessage: '429 status code (no body)',
		}),
		true,
		"pi's compact 429 formatter must classify",
	);
	const reported = JSON.stringify({
		message: "Provider returned error",
		code: 429,
		metadata: {
			raw: "stealth/ox-alpha is temporarily rate-limited upstream. Please retry shortly.",
			provider_name: "Stealth",
			limit_source: "upstream_provider_shared_pool",
		},
	});
	assert.equal(
		isNetworkErrorAssistantMessage({
			role: "assistant",
			stopReason: "error",
			errorMessage: `Retry failed after 3 attempts: 429: ${reported}`,
		}),
		true,
		"the exact field-reported 429 payload must classify",
	);
	assert.equal(
		isNetworkErrorAssistantMessage({
			role: "assistant",
			stopReason: "error",
			errorMessage: "429: quota exceeded for this billing period",
		}),
		false,
		"quota/billing exhaustion stays non-transient even with a 429 code",
	);
});

test("classification: non-transient errors stay non-recoverable", () => {
	for (const message of [
		"401: {\"type\":\"authentication_error\",\"message\":\"invalid api key\"}",
		"400: invalid_request_error: malformed payload",
		"Provider finish_reason: content_filter",
	]) {
		assert.equal(
			isNetworkErrorAssistantMessage({ role: "assistant", stopReason: "error", errorMessage: message }),
			false,
			`must not classify as network error: ${message}`,
		);
	}
});

// ── Regression through the real agent_end → agent_settled lifecycle ─────────

test("regression: reported 503 payload schedules goal-level recovery after settle", async () => {
	const { cwd, goal } = fixtureCwd();
	const h = createHarness(cwd);
	try {
		await startSession(h.handlers, h.ctx, sessionEntriesFor(goal));
		await h.handlers["before_agent_start"]!({
			systemPrompt: "base",
			prompt: "user typed: continue",
			systemPromptOptions: {},
		}, h.ctx);

		await h.handlers["agent_end"]!({
			messages: [{ role: "assistant", stopReason: "error", errorMessage: REPORTED_503_AFTER_RETRIES }],
		}, idleCtx(h.ctx));
		assert.equal(await countCheckpoints(h), 0, "agent_end must not race Pi's built-in retries");

		await h.handlers["agent_settled"]!({}, idleCtx(h.ctx));
		assert.match(
			h.notifications.at(-1)?.message ?? "",
			/Retrying the goal in 5s/,
			"the reported 503 outage must engage the bounded goal-level recovery",
		);
		assert.equal(await countCheckpoints(h), 0, "the first recovery is delayed by the backoff policy");
	} finally {
		// The delayed timer is unref'd and needs no test teardown.
	}
});

test("lifecycle: provider-initiated abort routes into recovery instead of pausing", async () => {
	process.env.PI_GOAL_NETWORK_RECOVERY_MAX_DELAY_MS = "25";
	const { cwd, goal } = fixtureCwd();
	const h = createHarness(cwd);
	try {
		await startSession(h.handlers, h.ctx, sessionEntriesFor(goal));
		await h.handlers["before_agent_start"]!({
			systemPrompt: "base",
			prompt: "user typed: continue",
			systemPromptOptions: {},
		}, h.ctx);

		await h.handlers["agent_end"]!({
			messages: [{ role: "assistant", stopReason: "aborted", errorMessage: "Aborted after 3 retry attempts" }],
		}, idleCtx(h.ctx));
		await h.handlers["agent_settled"]!({}, idleCtx(h.ctx));

		assert.match(
			h.notifications.at(-1)?.message ?? "",
			/Retrying the goal in \d+s \(recovery 1, unbounded\)/,
			"a provider-initiated abort without a user abort signal must engage recovery",
		);
	} finally {
		delete process.env.PI_GOAL_NETWORK_RECOVERY_MAX_DELAY_MS;
	}
});

test("lifecycle: full real event ordering (message_end → turn_end → agent_end → settled) routes provider-side aborts into recovery", async () => {
	// The auditor-verified gap: message_end and turn_end fire BEFORE agent_end
	// in real pi runs. All three must agree: without a user abort signal, an
	// aborted assistant message never pauses the goal and recovery engages.
	process.env.PI_GOAL_NETWORK_RECOVERY_MAX_DELAY_MS = "25";
	const { cwd, goal } = fixtureCwd();
	const h = createHarness(cwd);
	try {
		await startSession(h.handlers, h.ctx, sessionEntriesFor(goal));
		await h.handlers["before_agent_start"]!({
			systemPrompt: "base",
			prompt: "user typed: continue",
			systemPromptOptions: {},
		}, h.ctx);

		const abortedMessage = {
			role: "assistant",
			stopReason: "aborted",
			usage: { input: 0, output: 0 },
		};

		await h.handlers["message_end"]?.({ message: abortedMessage }, idleCtx(h.ctx));
		assert.equal(
			h.notifications.some((n) => /Goal paused/.test(n.message)),
			false,
			"message_end must not pause without a user abort signal",
		);
		await h.handlers["turn_end"]?.({ message: abortedMessage }, idleCtx(h.ctx));
		assert.equal(
			h.notifications.some((n) => /Goal paused/.test(n.message)),
			false,
			"turn_end must not pause without a user abort signal",
		);
		await h.handlers["agent_end"]!({ messages: [abortedMessage] }, idleCtx(h.ctx));
		await h.handlers["agent_settled"]!({}, idleCtx(h.ctx));

		assert.match(
			h.notifications.at(-1)?.message ?? "",
			/Retrying the goal in \d+s \(recovery 1, unbounded\)/,
			"recovery must engage through the full real event ordering",
		);
	} finally {
		delete process.env.PI_GOAL_NETWORK_RECOVERY_MAX_DELAY_MS;
	}
});

test("lifecycle: genuine user abort still pauses the goal", async () => {
	const { cwd, goal } = fixtureCwd();
	const h = createHarness(cwd);
	try {
		await startSession(h.handlers, h.ctx, sessionEntriesFor(goal));
		await h.handlers["before_agent_start"]!({
			systemPrompt: "base",
			prompt: "user typed: continue",
			systemPromptOptions: {},
		}, h.ctx);

		const signalCtx = {
			...idleCtx(h.ctx),
			signal: { aborted: true },
		} as unknown as ExtensionContext;
		await h.handlers["agent_end"]!({
			messages: [{ role: "assistant", stopReason: "aborted", errorMessage: "Aborted after 2 retry attempts" }],
		}, signalCtx);

		assert.match(
			h.notifications.at(-1)?.message ?? "",
			/Goal paused\./,
			"a user abort signal must keep pausing the goal",
		);
		assert.equal(
			h.notifications.some((n) => /Retrying the goal/.test(n.message)),
			false,
			"user-initiated pauses never schedule recovery",
		);
	} finally {
		// nothing to clean
	}
});

// ── Full lifecycle: escalation, plateau, bounded override, reset ────────────

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function lastNotification(h: ReturnType<typeof createHarness>): string {
	return h.notifications.at(-1)?.message ?? "";
}

test("lifecycle: unbounded recovery keeps retrying past the old 5-attempt cap", async () => {
	process.env.PI_GOAL_NETWORK_RECOVERY_MAX_DELAY_MS = "25";
	const { cwd, goal } = fixtureCwd();
	const h = createHarness(cwd);
	try {
		await startSession(h.handlers, h.ctx, sessionEntriesFor(goal));
		await h.handlers["before_agent_start"]!({
			systemPrompt: "base",
			prompt: "user typed: continue",
			systemPromptOptions: {},
		}, h.ctx);

		for (let attempt = 1; attempt <= 7; attempt++) {
			await h.handlers["agent_end"]!({
				messages: [{ role: "assistant", stopReason: "error", errorMessage: REPORTED_503_MESSAGE }],
			}, idleCtx(h.ctx));
			await h.handlers["agent_settled"]!({}, idleCtx(h.ctx));
			assert.match(
				lastNotification(h),
				new RegExp(`Retrying the goal in 0s \\(recovery ${attempt}, unbounded\\)`),
				`cycle ${attempt} must keep scheduling recovery`,
			);
			// Let the (25ms) recovery timer fire and clear before the next cycle.
			await sleep(80);
		}
	} finally {
		delete process.env.PI_GOAL_NETWORK_RECOVERY_MAX_DELAY_MS;
	}
});

test("lifecycle: configured bounded cap exhausts with a resume hint instead of retrying", async () => {
	process.env.PI_GOAL_NETWORK_RECOVERY_MAX_ATTEMPTS = "2";
	process.env.PI_GOAL_NETWORK_RECOVERY_MAX_DELAY_MS = "25";
	const { cwd, goal } = fixtureCwd();
	const h = createHarness(cwd);
	try {
		await startSession(h.handlers, h.ctx, sessionEntriesFor(goal));
		await h.handlers["before_agent_start"]!({
			systemPrompt: "base",
			prompt: "user typed: continue",
			systemPromptOptions: {},
		}, h.ctx);

		for (let attempt = 1; attempt <= 2; attempt++) {
			await h.handlers["agent_end"]!({
				messages: [{ role: "assistant", stopReason: "error", errorMessage: REPORTED_503_MESSAGE }],
			}, idleCtx(h.ctx));
			await h.handlers["agent_settled"]!({}, idleCtx(h.ctx));
			assert.match(lastNotification(h), new RegExp(`recovery ${attempt}/2`), `bounded cycle ${attempt}`);
			await sleep(80);
		}

		const checkpointsBeforeExhaustion = await countCheckpoints(h);
		await h.handlers["agent_end"]!({
			messages: [{ role: "assistant", stopReason: "error", errorMessage: REPORTED_503_MESSAGE }],
		}, idleCtx(h.ctx));
		await h.handlers["agent_settled"]!({}, idleCtx(h.ctx));
		assert.match(
			lastNotification(h),
			/persisted after all recovery attempts\. The goal remains active/,
			"exhaustion must stop the loop with a resume hint",
		);
		assert.equal(await countCheckpoints(h), checkpointsBeforeExhaustion, "exhausted recovery must not deliver a continuation");
	} finally {
		delete process.env.PI_GOAL_NETWORK_RECOVERY_MAX_ATTEMPTS;
		delete process.env.PI_GOAL_NETWORK_RECOVERY_MAX_DELAY_MS;
	}
});

test("lifecycle: a successful turn resets the recovery counter and clears pending backoff", async () => {
	process.env.PI_GOAL_NETWORK_RECOVERY_MAX_DELAY_MS = "25";
	const { cwd, goal } = fixtureCwd();
	const h = createHarness(cwd);
	try {
		await startSession(h.handlers, h.ctx, sessionEntriesFor(goal));
		await h.handlers["before_agent_start"]!({
			systemPrompt: "base",
			prompt: "user typed: continue",
			systemPromptOptions: {},
		}, h.ctx);

		// Two failed cycles advance the counter.
		for (const _ of [1, 2]) {
			await h.handlers["agent_end"]!({
				messages: [{ role: "assistant", stopReason: "error", errorMessage: REPORTED_503_MESSAGE }],
			}, idleCtx(h.ctx));
			await h.handlers["agent_settled"]!({}, idleCtx(h.ctx));
			await sleep(80);
		}

		// A successful turn uses the normal continuation path.
		const checkpointsFromRecoveryTimers = await countCheckpoints(h);
		const notificationsBeforeSuccess = h.notifications.length;
		await markGoalWork(h);
		await h.handlers["agent_end"]!({ messages: [{ role: "assistant", stopReason: "end_turn" }] }, idleCtx(h.ctx));
		await h.handlers["agent_settled"]!({}, idleCtx(h.ctx));
		assert.equal(await countCheckpoints(h), checkpointsFromRecoveryTimers + 1, "success queues the normal continuation");
		assert.equal(h.notifications.length, notificationsBeforeSuccess, "success announces no recovery");

		// The next failure starts over at recovery 1.
		await h.handlers["agent_end"]!({
			messages: [{ role: "assistant", stopReason: "error", errorMessage: REPORTED_503_MESSAGE }],
		}, idleCtx(h.ctx));
		await h.handlers["agent_settled"]!({}, idleCtx(h.ctx));
		assert.match(lastNotification(h), /\(recovery 1, unbounded\)/, "counter restarted");
	} finally {
		delete process.env.PI_GOAL_NETWORK_RECOVERY_MAX_DELAY_MS;
	}
});
