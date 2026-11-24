import assert from "node:assert/strict";
import test from "node:test";

import { createGoal, type GoalRecord } from "../extensions/goal-record.ts";
import {
	buildGoalListText,
	buildUnfocusedOpenGoalsSummary,
	focusedGoalFromPool,
	goalSelectorLabel,
	mergeFocusedGoalWithDisk,
	openGoalsFromPool,
	otherOpenGoalCount,
	resolveSessionFocus,
} from "../extensions/goal-pool.ts";

function goal(id: string, overrides: Partial<GoalRecord> = {}): GoalRecord {
	return {
		...createGoal({ objective: `=== Goal ===\nObjective: ${id}`, autoContinue: true, sisyphus: false }, Date.UTC(2026, 0, Number(id.replace(/\D/g, "")) || 1, 3, 4, 5)),
		id,
		activePath: `.pi/goals/active_goal_${id}.md`,
		...overrides,
	};
}

function goalPoolFromGoals(goals: GoalRecord[]): Map<string, GoalRecord> {
	return new Map(goals.filter(goal => goal.status !== "complete").map(goal => [goal.id, goal]));
}

test("goal pool helpers sort open goals and resolve focused records", () => {
	const pool = goalPoolFromGoals([
		goal("g2"),
		goal("done", { status: "complete" }),
		goal("g1", { sisyphus: true }),
	]);

	assert.deepEqual(openGoalsFromPool(pool).map((item) => item.id), ["g1", "g2"]);
	assert.equal(focusedGoalFromPool(pool, "g1")?.id, "g1");
	assert.equal(focusedGoalFromPool(pool, "missing"), null);
	assert.equal(otherOpenGoalCount(pool, "g1"), 1);
});

test("mergeFocusedGoalWithDisk uses disk lifecycle but preserves monotonic usage", () => {
	const merged = mergeFocusedGoalWithDisk({
		memoryGoal: goal("g1", { status: "active", autoContinue: true, usage: { tokensUsed: 80, activeSeconds: 10 } }),
		diskGoal: goal("g1", { status: "paused", autoContinue: false, usage: { tokensUsed: 50, activeSeconds: 20 }, pauseReason: "paused elsewhere" }),
	});
	assert.equal(merged.status, "paused");
	assert.equal(merged.autoContinue, false);
	assert.equal(merged.pauseReason, "paused elsewhere");
	assert.deepEqual(merged.usage, { tokensUsed: 80, activeSeconds: 20 });
});

test("resolveSessionFocus prefers valid branch focus, then legacy goal, then single open goal", () => {
	const pool = goalPoolFromGoals([goal("g1"), goal("g2")]);
	assert.equal(resolveSessionFocus({ pool, focusEntry: { version: 1, focusedGoalId: "g2", reason: "selected" } }), "g2");
	assert.equal(resolveSessionFocus({ pool, focusEntry: { version: 1, focusedGoalId: "missing", reason: "selected" } }), null);
	assert.equal(resolveSessionFocus({ pool, focusEntry: { version: 1, focusedGoalId: null, reason: "cleared" }, legacyGoal: goal("legacy") }), null);
	assert.equal(resolveSessionFocus({ pool: goalPoolFromGoals([goal("only")]), focusEntry: { version: 1, focusedGoalId: null, reason: "completed" } }), null);
	assert.equal(resolveSessionFocus({ pool: goalPoolFromGoals([goal("only")]), focusEntry: { version: 1, focusedGoalId: "missing", reason: "selected" } }), null);

	const legacyPool = goalPoolFromGoals([goal("g1")]);
	assert.equal(resolveSessionFocus({ pool: legacyPool, legacyGoal: goal("legacy") }), "legacy");
	assert.equal(legacyPool.has("legacy"), true);
	const diskWinsPool = goalPoolFromGoals([goal("g1", { objective: "disk wins", usage: { tokensUsed: 50, activeSeconds: 3 } })]);
	assert.equal(resolveSessionFocus({ pool: diskWinsPool, legacyGoal: goal("g1", { objective: "stale legacy" }) }), "g1");
	assert.equal(diskWinsPool.get("g1")?.objective, "disk wins");
	assert.equal(diskWinsPool.get("g1")?.usage.tokensUsed, 50);

	const singlePool = goalPoolFromGoals([goal("only")]);
	// Default (autoSelectSingleGoal unset/false): no auto-focus — sessions start unfocused.
	assert.equal(resolveSessionFocus({ pool: singlePool }), null);
	assert.equal(resolveSessionFocus({ pool: singlePool, autoSelectSingleGoal: false }), null);
	// Opt-in: auto-focus the single open goal when explicitly enabled.
	assert.equal(resolveSessionFocus({ pool: singlePool, autoSelectSingleGoal: true }), "only");
});

test("goal list and selector labels expose focus without storing it in goals", () => {
	const pool = goalPoolFromGoals([goal("g1"), goal("g2", { status: "paused", autoContinue: false })]);
	const label = goalSelectorLabel(goal("g1"), "g1");
	assert.match(label, /^\* g1 \| running \| goal \| g1/);
	assert.match(label, /\.pi\/goals\/active_goal_g1\.md/);

	const list = buildGoalListText(pool, "g2");
	assert.match(list, /^Open goals: 2/);
	assert.match(list, /^\* g2/m);
	assert.match(buildUnfocusedOpenGoalsSummary(2), /No goal is focused/);
	assert.match(buildUnfocusedOpenGoalsSummary(2), /\/goal-focus/);
});
