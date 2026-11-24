import assert from "node:assert/strict";
import test from "node:test";

import { buildCompactionSummary, buildGoalCompactSummary } from "../extensions/goal-compaction.ts";
import { type GoalLedgerEvent } from "../extensions/goal-ledger.ts";
import { type GoalRecord } from "../extensions/goal-record.ts";

function goal(overrides: Partial<GoalRecord> = {}): GoalRecord {
	return {
		id: "g-test",
		objective: "=== Goal ===\nObjective: Build tests",
		status: "active",
		autoContinue: true,
		usage: { activeSeconds: 120, tokensUsed: 5000 },
		sisyphus: false,
		createdAt: "2024-01-01T00:00:00.000Z",
		updatedAt: "2024-01-01T00:00:00.000Z",
		...overrides,
		};
}

test("buildGoalCompactSummary includes status, objective, usage, and recent events", () => {
	const g = goal({ id: "g1" });
	const events: GoalLedgerEvent[] = [
	{ type: "goal_created", goalId: "g1", objective: "o1", sisyphus: false, autoContinue: true, at: "2024-01-01T00:00:00.000Z" },
	{ type: "goal_paused", goalId: "g1", reason: "missing tests", at: "2024-01-01T00:00:01.000Z" },
	{ type: "goal_resumed", goalId: "g1", reason: "user", at: "2024-01-01T00:00:02.000Z" },
	];

	const summary = buildGoalCompactSummary(g, events);
	assert.match(summary, /g1/);
	assert.match(summary, /running/);
	assert.match(summary, /Build tests/);
	assert.match(summary, /5K \(5,000\) tokens/);
	assert.match(summary, /paused: missing tests/);
	assert.match(summary, /resumed: user/);
});

test("buildGoalCompactSummary includes auditor rejection", () => {
	const g = goal({ id: "g1" });
	const events: GoalLedgerEvent[] = [
	{ type: "completion_requested", goalId: "g1", summary: "done", at: "2024-01-01T00:00:00.000Z" },
	{ type: "audit_result", goalId: "g1", verdict: "disapproved", report: "Tests are missing. Coverage is 0%.", at: "2024-01-01T00:00:01.000Z" },
	];

	const summary = buildGoalCompactSummary(g, events);
	assert.match(summary, /Auditor rejection/);
	assert.match(summary, /Tests are missing/);
});

test("buildGoalCompactSummary does not include approved auditor result", () => {
	const g = goal({ id: "g1" });
	const events: GoalLedgerEvent[] = [
	{ type: "audit_result", goalId: "g1", verdict: "approved", report: "All good", at: "2024-01-01T00:00:00.000Z" },
		];

	const summary = buildGoalCompactSummary(g, events);
	assert.doesNotMatch(summary, /Auditor rejection/);
});

test("buildCompactionSummary produces full session snapshot", () => {
	const g1 = goal({ id: "g1", objective: "Goal A", status: "active" });
	const g2 = goal({ id: "g2", objective: "Goal B", status: "paused", pauseReason: "blocked" });
	const goalsById = new Map<string, GoalRecord>([
		["g1", g1],
		["g2", g2],
		]);
	const events: GoalLedgerEvent[] = [
	{ type: "goal_created", goalId: "g1", objective: "Goal A", sisyphus: false, autoContinue: true, at: "2024-01-01T00:00:00.000Z" },
	{ type: "goal_created", goalId: "g2", objective: "Goal B", sisyphus: false, autoContinue: true, at: "2024-01-01T00:00:01.000Z" },
	{ type: "goal_created", goalId: "g3", objective: "Goal C", sisyphus: false, autoContinue: true, at: "2024-01-01T00:00:02.000Z" },
	{ type: "goal_completed", goalId: "g3", at: "2024-01-01T00:00:03.000Z" },
	];

	const summary = buildCompactionSummary({ goalsById, focusedGoalId: "g1", ledgerEvents: events });
	assert.match(summary, /FOCUSED GOAL/);
	assert.match(summary, /Goal A/);
	assert.match(summary, /OTHER OPEN GOALS/);
	assert.match(summary, /Goal B/);
	assert.match(summary, /TERMINAL GOALS/);
	assert.match(summary, /g3/);
	assert.match(summary, /Continue from the focused goal/);
});

test("buildCompactionSummary handles no goals", () => {
	const summary = buildCompactionSummary({ goalsById: new Map(), focusedGoalId: null, ledgerEvents: [] });
	assert.match(summary, /NO GOALS/);
});

test("buildCompactionSummary caps open goals and events", () => {
	const goalsById = new Map<string, GoalRecord>();
	const events: GoalLedgerEvent[] = [];
	for (let i = 0; i < 25; i++) {
		const g = goal({ id: `g${i}`, objective: `Goal ${i}`, status: "active" });
		goalsById.set(g.id, g);
		events.push({ type: "goal_created", goalId: g.id, objective: g.objective, sisyphus: false, autoContinue: true, at: "2024-01-01T00:00:00.000Z" });
	}

	const summary = buildCompactionSummary({ goalsById, focusedGoalId: "g0", ledgerEvents: events, capOpenGoals: 5, capEventsPerGoal: 2 });
	// Should show focused goal + 5 other open + "and 19 more"
	assert.match(summary, /and 19 more/);
});

test("buildCompactionSummary handles focused goal with pause reason", () => {
	const g = goal({ id: "g1", status: "paused", pauseReason: "missing dependency", pauseSuggestedAction: "install libfoo" });
	const events: GoalLedgerEvent[] = [
	{ type: "goal_paused", goalId: "g1", reason: "missing dependency", suggestedAction: "install libfoo", at: "2024-01-01T00:00:00.000Z" },
		];

	const summary = buildGoalCompactSummary(g, events);
	assert.match(summary, /Pause reason: missing dependency/);
	assert.match(summary, /Suggested action: install libfoo/);
});
