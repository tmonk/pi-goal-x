/**
 * Stage 0 golden tests: the continuation checkpoint contract.
 *
 * Pins how the extension treats queued/injected continuation checkpoints
 * today (specs/2026-08-03-codex-inspired-goal-interface Stage 0):
 *
 *   1. A checkpoint for a goal that is no longer the focused active goal is
 *      stale: the turn is aborted and `[GOAL STALE goalId=...]` guidance is
 *      injected instead of doing goal work.
 *   2. A checkpoint that matches the focused active goal proceeds normally.
 *   3. A user-driven turn cancels any pending continuation, so a queued
 *      checkpoint is never delivered after the user takes over.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
	createGoal,
	goalFocusDetails,
	type GoalRecord,
	type GoalStateEntry,
} from "../extensions/goal-record.ts";
import { createExtensionHarness } from "./support/extension-harness.ts";
import { writeProjectSettings } from "./support/settings.ts";
import { tempDir } from "./support/fs.ts";

const FIXTURE_GOAL = readFileSync(new URL("./fixtures/goals/active_goal_fixture.md", import.meta.url), "utf8");

// ── Host ─────────────────────────────────────────────────────────────────────

/** A host that looks busy, so continuation reschedules; see idleCtx() for the idle one. */
function createHarness(cwd: string, goal: GoalRecord) {
	return createExtensionHarness({
		cwd,
		sessionEntries: sessionEntriesFor(goal),
		isIdle: () => false,
		hasPendingMessages: () => true,
		systemPrompt: "",
	});
}

type Harness = ReturnType<typeof createHarness>;

function fixtureCwd(): { cwd: string; goal: GoalRecord } {
	const cwd = tempDir("goal-stale-");
	mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
	writeFileSync(path.join(cwd, ".pi", "goals", "active_goal_fixture.md"), FIXTURE_GOAL);

	// The fixture's JSON header is authoritative here: read it back through the
	// extension's own parser path so the goal record matches what loadState sees.
	const parsed = createGoal({ objective: "Golden fixture goal objective", autoContinue: true, sisyphus: false }, Date.UTC(2026, 7, 3, 9, 0, 0));
	// Overwrite the fixture with a record whose id we know, then write via the
	// extension's serializer so the activePath is correct.
	writeFileSync(path.join(cwd, ".pi", "goals", "active_goal_fixture.md"), FIXTURE_GOAL);
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

// ── Tests ────────────────────────────────────────────────────────────────────

for (const custom of [false, true]) test(`golden: stale ${custom ? "custom" : "prompt"} checkpoint for a non-focused goal aborts the turn and injects GOAL STALE`, async () => {
	const { cwd, goal } = fixtureCwd();
	const h = createHarness(cwd, goal);
	try {
		await h.sessionStart();

		// A checkpoint claims a goal that is not focused/active in this session.
		await h.emit("before_agent_start", {
			systemPrompt: "base",
			...(custom ? { messageType: "custom", message: { customType: "pi-goal-event", details: { goalId: "ghost-goal" }, content: "Checkpoint" } }
				: { prompt: '<pi_goal_continuation goal_id="ghost-goal" kind="checkpoint">continue' }),
			systemPromptOptions: {},
		}, h.ctx);

		assert.equal(h.abortCount, 1, "stale checkpoint must abort the turn");
		const result = await h.emit("context_with_system", { messages: [] }, h.ctx);
		const systemPrompt = (result as { messages?: {content: string}[] } | undefined)?.messages?.at(-1)?.content ?? "";
		assert.match(systemPrompt, /\[GOAL STALE goalId=ghost-goal\]/);
		assert.match(systemPrompt, /Do not perform task work for this stale checkpoint/);
	} finally {
		// temp dir cleanup is best-effort.
	}
});

for (const custom of [false, true]) test(`golden: matching ${custom ? "custom" : "prompt"} checkpoint proceeds without stale handling`, async () => {
	const { cwd, goal } = fixtureCwd();
	const h = createHarness(cwd, goal);
	try {
		await h.sessionStart();

		await h.emit("before_agent_start", {
			systemPrompt: "base",
			...(custom ? { messageType: "custom", message: { customType: "pi-goal-event", details: { goalId: goal.id }, content: "Checkpoint" } }
				: { prompt: `<pi_goal_continuation goal_id="${goal.id}" kind="checkpoint">continue` }),
			systemPromptOptions: {},
		}, h.ctx);

		assert.equal(h.abortCount, 0, "matching checkpoint must not abort");
		const result = await h.emit("context_with_system", { messages: [] }, h.ctx);
		const systemPrompt = (result as { messages?: {content: string}[] } | undefined)?.messages?.at(-1)?.content ?? "";
		assert.doesNotMatch(systemPrompt, /GOAL STALE/);
	} finally {
		// temp dir cleanup is best-effort.
	}
});

test("golden: user-driven turn cancels a pending continuation", async () => {
	const { cwd, goal } = fixtureCwd();
	const h = createHarness(cwd, goal);
	try {
		await h.sessionStart();

		// Simulate a work turn that queues a continuation: turn_start, a bash
		// tool call, then a non-tool-use assistant message at turn_end.
		await h.emit("turn_start", {}, h.ctx);
		await h.emit("tool_call", { toolName: "bash", args: { command: "ls" } }, h.ctx);
		await h.emit("tool_execution_end", {}, h.ctx);
		await h.emit("turn_end", { message: { role: "assistant", content: [{ type: "text", text: "done" }] } }, h.ctx);

		// The continuation timer is pending (non-idle ctx keeps it scheduled).
		// A user-driven turn must cancel it before it fires.
		await h.emit("before_agent_start", {
			systemPrompt: "base",
			prompt: "user typed a new instruction",
			systemPromptOptions: {},
		}, h.ctx);

		// Wait beyond the idle retry delay; the queued continuation must not fire.
		await new Promise((resolve) => setTimeout(resolve, 120));

		const checkpoints = h.sentMessages.filter(
			(m) => m.customType === "pi-goal-event" && (m.details as { kind?: string } | undefined)?.kind === "checkpoint",
		);
		assert.equal(checkpoints.length, 0, "user turn must cancel the pending continuation");
	} finally {
		// temp dir cleanup is best-effort.
	}
});

// ── Provider-error guard (danim47c pattern) ─────────────────────────────────
// A turn/run whose assistant message has stopReason "error" is failed work:
// it must never queue an auto-continuation, or a provider outage turns into
// an unbounded retry storm. Normal turns must still queue.

/** Idle ctx: continuation fires immediately instead of rescheduling. */
function idleCtx(ctx: ExtensionContext): ExtensionContext {
	return {
		...ctx,
		isIdle: () => true,
		hasPendingMessages: () => false,
	} as unknown as ExtensionContext;
}

async function countCheckpoints(h: Harness): Promise<number> {
	await new Promise((resolve) => setTimeout(resolve, 20));
	return h.sentMessages.filter(
		(m) => m.customType === "pi-goal-event" && (m.details as { kind?: string } | undefined)?.kind === "checkpoint",
	).length;
}

/** Mark this agent run as having done goal work (empty-turn gate). */
async function declareNextRun(h: Harness): Promise<void> {
	await h.emit("turn_start", {}, h.ctx);
	await h.emit("tool_call", { toolName: "bash", args: { command: "ls" } }, h.ctx);
	await h.emit("tool_execution_end", {}, h.ctx);
	writeProjectSettings(h.ctx.cwd, { maxAutonomousRuns: 5 });
	assert.equal(h.core.scheduler.declare(h.ctx, { kind: "ready" }).terminate, true);
}

test("provider-error guard: turn_end with stopReason=error never queues a continuation", async () => {
	const { cwd, goal } = fixtureCwd();
	const h = createHarness(cwd, goal);
	try {
		await h.sessionStart();

		// Cancel the continuation session_start armed (non-idle ctx keeps it
		// scheduled) so the turn itself owns the queue decision.
		await h.emit("before_agent_start", {
			systemPrompt: "base",
			prompt: "user typed: continue",
			systemPromptOptions: {},
		}, h.ctx);

		// A work turn that ends in a provider error (work tool ran, then error).
		await h.emit("turn_start", {}, h.ctx);
		await h.emit("tool_call", { toolName: "bash", args: { command: "ls" } }, h.ctx);
		await h.emit("tool_execution_end", {}, h.ctx);
		await h.emit("turn_end", { message: { role: "assistant", stopReason: "error" } }, idleCtx(h.ctx));

		assert.equal(await countCheckpoints(h), 0, "error turn must not queue a continuation");
	} finally {
		// temp dir cleanup is best-effort.
	}
});

test("ordinary work without a disposition does not queue a continuation", async () => {
	const { cwd, goal } = fixtureCwd();
	const h = createHarness(cwd, goal);
	try {
		await h.sessionStart();

		// Cancel the continuation session_start armed (see above).
		await h.emit("before_agent_start", {
			systemPrompt: "base",
			prompt: "user typed: continue",
			systemPromptOptions: {},
		}, h.ctx);

		await h.emit("turn_start", {}, h.ctx);
		await h.emit("tool_call", { toolName: "bash", args: { command: "ls" } }, h.ctx);
		await h.emit("tool_execution_end", {}, h.ctx);
		await h.emit("turn_end", { message: { role: "assistant", content: [{ type: "text", text: "done" }] } }, idleCtx(h.ctx));

		assert.equal(await countCheckpoints(h), 0, "work tools alone must not authorize continuation");
	} finally {
		// temp dir cleanup is best-effort.
	}
});

test("provider-error guard: agent_end with an error message never queues a continuation", async () => {
	const { cwd, goal } = fixtureCwd();
	const h = createHarness(cwd, goal);
	try {
		await h.sessionStart();

		await h.emit("agent_end", { messages: [{ role: "assistant", stopReason: "error" }] }, idleCtx(h.ctx));
		await h.emit("agent_settled", {}, idleCtx(h.ctx));

		assert.equal(await countCheckpoints(h), 0, "agent_end with an error message must not queue a continuation");
	} finally {
		// temp dir cleanup is best-effort.
	}
});

test("network-error recovery waits for agent_settled before scheduling its backoff", async () => {
	const { cwd, goal } = fixtureCwd();
	const h = createHarness(cwd, goal);
	try {
		await h.sessionStart();
		await h.emit("before_agent_start", {
			systemPrompt: "base",
			prompt: "user typed: continue",
			systemPromptOptions: {},
		}, h.ctx);

		await h.emit("agent_end", {
			messages: [{ role: "assistant", stopReason: "error", errorMessage: "Provider finish_reason: network_error" }],
		}, idleCtx(h.ctx));
		assert.equal(await countCheckpoints(h), 0, "agent_end must not race Pi's built-in retries");

		await h.emit("agent_settled", {}, idleCtx(h.ctx));
		assert.equal(await countCheckpoints(h), 0, "the first recovery is delayed by the backoff policy");
		assert.match(h.notices.at(-1)?.message ?? "", /Retrying the goal in 5s \(recovery 1, unbounded\)/);
	} finally {
		// The delayed timer is unref'd and needs no test teardown.
	}
});

test("a successful Pi retry clears the pending network-error recovery", async () => {
	const { cwd, goal } = fixtureCwd();
	const h = createHarness(cwd, goal);
	try {
		await h.sessionStart();
		await h.emit("before_agent_start", {
			systemPrompt: "base",
			prompt: "user typed: continue",
			systemPromptOptions: {},
		}, h.ctx);

		await h.emit("agent_end", {
			messages: [{ role: "assistant", stopReason: "error", errorMessage: "Provider finish_reason: network_error" }],
		}, idleCtx(h.ctx));
		await declareNextRun(h);
		await h.emit("agent_end", {
			messages: [{ role: "assistant", stopReason: "end_turn" }],
		}, idleCtx(h.ctx));
		await h.emit("agent_settled", {}, idleCtx(h.ctx));

		assert.equal(await countCheckpoints(h), 1, "the successful Pi retry uses the normal continuation path");
		assert.equal(h.notices.length, 0, "no goal-level recovery is announced after Pi retries successfully");
	} finally {
		// No delayed timer should exist after the successful retry.
	}
});

test("successful agent_end waits for agent_settled before queuing a continuation", async () => {
	const { cwd, goal } = fixtureCwd();
	const h = createHarness(cwd, goal);
	try {
		await h.sessionStart();
		await declareNextRun(h);

		await h.emit("agent_end", { messages: [{ role: "assistant", stopReason: "end_turn" }] }, idleCtx(h.ctx));
		assert.equal(await countCheckpoints(h), 0, "agent_end runs before pi is truly idle");

		await h.emit("agent_settled", {}, idleCtx(h.ctx));
		assert.equal(await countCheckpoints(h), 1, "agent_settled queues the continuation without idle polling");
	} finally {
		// temp dir cleanup is best-effort.
	}
});

for (const optIn of [false, true]) test(`empty no-tool runs continue implicitly; pacing opt-in=${optIn}`, async () => {
	const { cwd, goal } = fixtureCwd();
	writeProjectSettings(cwd, { idleContinuationBackoff: optIn });
	const h = createHarness(cwd, goal);
	try {
		await h.sessionStart();
		await h.emit("before_agent_start", {
			systemPrompt: "base",
			prompt: "Continue the fixture goal.",
			systemPromptOptions: {},
		}, h.ctx);
		await h.emit("agent_start", {}, idleCtx(h.ctx));

		await h.emit("agent_end", { messages: [{ role: "assistant", stopReason: "end_turn", content: [{ type: "text", text: "Paused. No action." }] }] }, idleCtx(h.ctx));
		await h.emit("agent_settled", {}, idleCtx(h.ctx));

		assert.equal(await countCheckpoints(h), 1, "a successful no-tool execution continues");
		assert.equal(h.core.state.goal?.scheduler?.dispatch?.kind, "ready");
		await h.emit("agent_start", {}, idleCtx(h.ctx));
		await h.emit("message_start", { message: { ...h.sentMessages.at(-1), role: "custom" } }, idleCtx(h.ctx));
		await h.emit("agent_end", { messages: [{ role: "assistant", stopReason: "end_turn", content: [{ type: "text", text: "Still no action." }] }] }, idleCtx(h.ctx));
		await h.emit("agent_settled", {}, idleCtx(h.ctx));
		assert.equal(await countCheckpoints(h), optIn ? 1 : 2, "only an explicit opt-in defers repeated idle replies");
		assert.equal(h.core.state.goal?.status, "active");
		assert.equal(h.core.state.goal?.scheduler?.phase, optIn ? "ready" : "claimed", "continuation stays authorized without a declaration");
		assert.equal(h.core.state.goal?.scheduler?.repairUsed, false, "default mode does not require repair");
		if (optIn) {
			assert.equal(h.core.state.goal?.scheduler?.idle?.runs, 2);
			assert.ok(h.core.state.goal!.scheduler!.idle!.nextAt > Date.now());
		} else assert.equal(h.core.state.goal?.scheduler?.idle, undefined);
	} finally {
		h.core.scheduler.shutdown();
		h.core.runtime.clearContinuationState();
	}
});

// Explicit decision invalidation and actual SDK run-boundary coverage live in goal-scheduler.test.ts and goal-scheduler-sdk.test.ts.
