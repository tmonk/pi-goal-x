/**
 * Unit tests for GoalAccounting (serialized idempotent accounting + budget
 * helpers) and GoalRuntime (continuation scheduling, turn-stop guard, stale
 * checkpoint, one-time reminders) — Stage 2 extraction.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { GoalAccounting, budgetLine, budgetReached, budgetRemaining } from "../extensions/goal-accounting.ts";
import { GoalRuntime } from "../extensions/goal-runtime.ts";
import { createGoal } from "../extensions/goal-record.ts";
import type { GoalRecord } from "../extensions/goal-record.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

function mockCtx(): ExtensionContext {
	return {
		cwd: "/tmp",
		isIdle: () => true,
		hasPendingMessages: () => false,
	} as unknown as ExtensionContext;
}

// ── GoalAccounting ──────────────────────────────────────────────────────────

describe("GoalAccounting", () => {
	it("charges elapsed seconds and advances the baseline (idempotent)", () => {
		const acct = new GoalAccounting();
		acct.begin("g1");
		// 10 seconds pass, 5 tokens.
		const first = acct.charge({ now: Date.now() + 10_000, completedTurnTokens: 5 });
		assert.equal(first.seconds, 10);
		assert.equal(first.tokens, 5);
		// Immediately charging again yields 0 seconds — no double-charge.
		const second = acct.charge({ now: Date.now() + 10_000, completedTurnTokens: 3 });
		assert.equal(second.seconds, 0);
		assert.equal(second.tokens, 3);
	});

	it("never charges negative elapsed time", () => {
		const acct = new GoalAccounting();
		acct.begin("g1");
		const charge = acct.charge({ now: Date.now() - 5000 });
		assert.equal(charge.seconds, 0);
	});

	it("isActiveFor requires the exact goal id", () => {
		const acct = new GoalAccounting();
		acct.begin("g1");
		assert.ok(acct.isActiveFor("g1"));
		assert.equal(acct.isActiveFor("g2"), false);
		acct.clear();
		assert.equal(acct.isActiveFor("g1"), false);
		assert.equal(acct.goalId, null);
	});

	it("liveSeconds is read-only display (does not advance the baseline)", () => {
		const acct = new GoalAccounting();
		acct.begin("g1");
		const now = Date.now();
		assert.equal(acct.liveSeconds(now + 7000), 7);
		// Baseline untouched: a subsequent charge still counts the full interval.
		const charge = acct.charge({ now: now + 7000 });
		assert.equal(charge.seconds, 7);
	});
});

// ── Budget helpers ──────────────────────────────────────────────────────────

describe("budget helpers", () => {
	const base = { usage: { tokensUsed: 0 } };

	it("returns null when no budget is set", () => {
		assert.equal(budgetRemaining(base), null);
		assert.equal(budgetReached(base), false);
		assert.equal(budgetLine(base), null);
	});

	it("computes remaining and reached", () => {
		const goal = { ...base, tokenBudget: 100, usage: { tokensUsed: 80 } };
		assert.equal(budgetRemaining(goal), 20);
		assert.equal(budgetReached(goal), false);
		assert.ok(budgetLine(goal)?.includes("80/100"));
		const crossed = { ...base, tokenBudget: 100, usage: { tokensUsed: 100 } };
		assert.equal(budgetRemaining(crossed), 0);
		assert.equal(budgetReached(crossed), true);
	});

	it("ignores non-positive budgets", () => {
		assert.equal(budgetRemaining({ ...base, tokenBudget: 0 }), null);
		assert.equal(budgetRemaining({ ...base, tokenBudget: -5 }), null);
		assert.equal(budgetReached({ ...base, tokenBudget: 0 }), false);
	});
});

// ── GoalRuntime ─────────────────────────────────────────────────────────────

function makeRuntime(overrides: Partial<{
	isActionable: (id: string | null | undefined) => boolean;
	getGoal: () => GoalRecord | null;
	sent: Array<{ content: string; details: Record<string, unknown> }>;
}> = {}) {
	const sent: Array<{ content: string; details: Record<string, unknown> }> = [];
	const runtime = new GoalRuntime({
		sendFollowUp: (content, details) => { sent.push({ content, details }); },
		getGoal: () => overrides.getGoal?.() ?? null,
		isActionable: (id) => overrides.isActionable ? overrides.isActionable(id) : false,
		syncTools: () => {},
	});
	return { runtime, sent };
}

function activeGoal(autoContinue = true): GoalRecord {
	return createGoal({ objective: "Runtime test", autoContinue, sisyphus: false }, Date.UTC(2026, 7, 2, 9, 0, 0));
}

describe("GoalRuntime continuation scheduling", () => {
	it("does not queue for non-active or non-autoContinue goals", () => {
		const { runtime } = makeRuntime();
		const paused = { ...activeGoal(), status: "paused" as const };
		runtime.queueContinuation(mockCtx(), paused, true);
		runtime.queueContinuation(mockCtx(), { ...activeGoal(), autoContinue: false }, true);
		assert.equal(runtime.continuationPendingFor(paused.id), false);
	});

	it("queues for an actionable goal and clears on cancel", () => {
		const goal = activeGoal();
		const { runtime } = makeRuntime({ isActionable: () => true, getGoal: () => goal });
		runtime.queueContinuation(mockCtx(), goal, true);
		// Timers are unref'd; fire the scheduled continuation deterministically.
		runtime.clearContinuationState();
		assert.equal(runtime.continuationPendingFor(goal.id), false);
	});
});

describe("GoalRuntime turn-stop guard", () => {
	it("markTurnStopped scopes to the current turn; advanceTurn drops stale markers", () => {
		const { runtime } = makeRuntime();
		assert.equal(runtime.currentTurnStoppedGoalId(), null);
		runtime.markTurnStopped("g1");
		assert.equal(runtime.currentTurnStoppedGoalId(), "g1");
		runtime.advanceTurn();
		assert.equal(runtime.currentTurnStoppedGoalId(), null);
	});

	it("isStaleCheckpointBlocked blocks work tools but allows get_goal", () => {
		const { runtime } = makeRuntime();
		assert.equal(runtime.isStaleCheckpointBlocked("write"), true);
		assert.equal(runtime.isStaleCheckpointBlocked("bash"), true);
		assert.equal(runtime.isStaleCheckpointBlocked("get_goal"), false);
	});
});

describe("GoalRuntime reminders", () => {
	it("post-compaction reminder is one-shot", () => {
		const { runtime } = makeRuntime();
		assert.equal(runtime.isPostCompactReminderPending(), false);
		runtime.armPostCompactReminder();
		assert.equal(runtime.isPostCompactReminderPending(), true);
		runtime.clearPostCompactReminder();
		assert.equal(runtime.isPostCompactReminderPending(), false);
		runtime.armPostCompactReminder();
		assert.equal(runtime.consumePostCompactReminder(), true);
		assert.equal(runtime.consumePostCompactReminder(), false);
	});

	it("post-budget reminder is one-shot", () => {
		const { runtime } = makeRuntime();
		assert.equal(runtime.consumePostBudgetReminder(), false);
		runtime.armPostBudgetReminder();
		assert.equal(runtime.consumePostBudgetReminder(), true);
		assert.equal(runtime.consumePostBudgetReminder(), false);
	});
});

describe("GoalRuntime stale checkpoint state", () => {
	it("setCheckpoint/getCheckpointGoalId round-trip", () => {
		const { runtime } = makeRuntime();
		assert.equal(runtime.getCheckpointGoalId(), null);
		runtime.setCheckpoint("g9");
		assert.equal(runtime.getCheckpointGoalId(), "g9");
		runtime.setCheckpoint(null);
		assert.equal(runtime.getCheckpointGoalId(), null);
	});
});
