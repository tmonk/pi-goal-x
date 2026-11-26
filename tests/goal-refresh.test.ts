import assert from "node:assert/strict";
import test from "node:test";

import { diffGoalRefreshState, type GoalRefreshState } from "../extensions/goal-commands.ts";

const settings = JSON.stringify({ subtaskDepth: 2, provider: "anthropic" });

function state(overrides: Partial<GoalRefreshState> = {}): GoalRefreshState {
	return {
		poolIds: ["g1", "g2"],
		ledgerEvents: 10,
		ledgerMalformed: 0,
		settings,
		...overrides,
	};
}

test("diffGoalRefreshState: unchanged state reports no changes", () => {
	assert.deepEqual(diffGoalRefreshState(state(), state()), []);
});

test("diffGoalRefreshState: pool additions and removals are reported", () => {
	const changes = diffGoalRefreshState(state(), state({ poolIds: ["g1", "g2", "g3"] }));
	assert.deepEqual(changes, ["pool: 1 goal(s) added — g3"]);

	const removed = diffGoalRefreshState(state({ poolIds: ["g1", "g2"] }), state({ poolIds: ["g2"] }));
	assert.deepEqual(removed, ["pool: 1 goal(s) removed — g1"]);

	const both = diffGoalRefreshState(state({ poolIds: ["g1", "g2"] }), state({ poolIds: ["g2", "g4"] }));
	assert.deepEqual(both, ["pool: 1 goal(s) added — g4", "pool: 1 goal(s) removed — g1"]);
});

test("diffGoalRefreshState: ledger growth and malformed-entry changes are reported", () => {
	const grown = diffGoalRefreshState(state(), state({ ledgerEvents: 13 }));
	assert.deepEqual(grown, ["ledger: 10 -> 13 events"]);

	const malformed = diffGoalRefreshState(state(), state({ ledgerMalformed: 2 }));
	assert.deepEqual(malformed, ["ledger: malformed entries 0 -> 2"]);
});

test("diffGoalRefreshState: settings fingerprint changes are reported", () => {
	const touched = diffGoalRefreshState(state(), state({ settings: JSON.stringify({ subtaskDepth: 3 }) }));
	assert.deepEqual(touched, ["settings: effective settings changed (external edit)"]);
});

test("diffGoalRefreshState: combined changes are reported in order", () => {
	const changes = diffGoalRefreshState(state(), state({ poolIds: ["g1", "g3"], ledgerEvents: 12, ledgerMalformed: 1, settings: JSON.stringify({ subtaskDepth: 9 }) }));
	assert.deepEqual(changes, [
		"pool: 1 goal(s) added — g3",
		"pool: 1 goal(s) removed — g2",
		"ledger: 10 -> 12 events",
		"ledger: malformed entries 0 -> 1",
		"settings: effective settings changed (external edit)",
	]);
});

test("diffGoalRefreshState: an edit that keeps the same ids is reported by revision", () => {
	const changes = diffGoalRefreshState(
		state({ revisions: new Map([["g1", 1], ["g2", 1]]) }),
		state({ revisions: new Map([["g1", 4], ["g2", 1]]) }),
	);
	assert.deepEqual(changes, ["pool: g1 changed on disk (revision 1 -> 4)"]);
});
