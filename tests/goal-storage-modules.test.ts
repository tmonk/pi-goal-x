import assert from "node:assert/strict";
import test from "node:test";

import { parseGoalFileContent, serializeGoalFile } from "../extensions/storage/goal-file-format.ts";
import { activePathForGoal, archivedPathForGoal, isActiveGoalFileName, sanitizeGoalPaths } from "../extensions/storage/goal-paths.ts";
import { snapshotMatchesNames } from "../extensions/storage/goal-pool-snapshot.ts";
import { createGoal } from "../extensions/goal-record.ts";
import { applyLedgerEvents, cloneAccumulator, finalizeLedgerState, freshAccumulator, reconstructGoalLedger } from "../extensions/goal-ledger-reconstruct.ts";
import { isValidLedgerEvent } from "../extensions/goal-ledger-validate.ts";
import type { GoalLedgerEvent } from "../extensions/goal-ledger-events.ts";

const ctx = { cwd: "/tmp/pi-goal-storage-modules" };

test("parseGoalFileContent tells malformed text from a header with no usable goal", () => {
	const goal = createGoal({ objective: "Ship it", autoContinue: true, sisyphus: false });
	assert.equal(parseGoalFileContent(serializeGoalFile(goal))?.objective, "Ship it");
	assert.equal(parseGoalFileContent("not a goal file"), undefined);
	assert.equal(parseGoalFileContent("{ \"id\": "), undefined);
	// A readable header without any objective is valid JSON but not a goal.
	assert.equal(parseGoalFileContent("{\"id\":\"a\"}\n"), null);
});

test("parseGoalFileContent prefers the objective edited in the markdown body", () => {
	const goal = createGoal({ objective: "Original", autoContinue: true, sisyphus: false });
	// The objective also sits in the JSON header; only the body copy is edited.
	const text = serializeGoalFile(goal);
	const edited = text.slice(0, text.lastIndexOf("Original")) + "Edited by hand" + text.slice(text.lastIndexOf("Original") + "Original".length);
	assert.equal(parseGoalFileContent(edited)?.objective, "Edited by hand");
});

test("goal paths: only direct children of the goal directories are kept", () => {
	const goal = createGoal({ objective: "Paths", autoContinue: true, sisyphus: false });
	const active = activePathForGoal(ctx, goal);
	assert.match(active, /^\.pi\/goals\/active_goal_\d+_.+\.md$/);
	assert.match(archivedPathForGoal(ctx, goal), /^\.pi\/goals\/archived\/goal_\d+_.+\.md$/);
	assert.equal(activePathForGoal(ctx, { ...goal, activePath: active }), active);

	const escaped = sanitizeGoalPaths(ctx, { ...goal, activePath: "../outside/active_goal_x.md", archivedPath: ".pi/goals/active_goal_x.md" });
	assert.equal(escaped.activePath, undefined);
	assert.equal(escaped.archivedPath, undefined);
	assert.ok(isActiveGoalFileName("active_goal_1.md"));
	assert.ok(!isActiveGoalFileName("goal_1.md"));
});

test("snapshotMatchesNames compares the active goal file names only", () => {
	const goal = createGoal({ objective: "Snap", autoContinue: true, sisyphus: false });
	const snapshot = { version: 1 as const, dirMtimeMs: 1, goals: [{ ...goal, activePath: ".pi/goals/active_goal_1_a.md" }] };
	assert.ok(snapshotMatchesNames(["active_goal_1_a.md", "goal_events.jsonl", ".locks"], snapshot));
	assert.ok(!snapshotMatchesNames(["goal_events.jsonl"], snapshot));
	assert.ok(!snapshotMatchesNames(["active_goal_1_a.md", "active_goal_2_b.md"], snapshot));
});

test("replaying a ledger tail on a cloned accumulator equals one full fold", () => {
	const at = "2026-11-24T00:00:00.000Z";
	const events: GoalLedgerEvent[] = [
		{ type: "goal_created", goalId: "a", objective: "A", sisyphus: false, autoContinue: true, at },
		{ type: "goal_focused", goalId: "a", reason: "created", at },
		{ type: "goal_created", goalId: "b", objective: "B", sisyphus: false, autoContinue: true, at },
		{ type: "goal_paused", goalId: "b", reason: "wait", at },
		{ type: "goal_completed", goalId: "a", at },
	];
	const head = applyLedgerEvents(freshAccumulator(), events.slice(0, 3));
	const resumed = finalizeLedgerState(applyLedgerEvents(cloneAccumulator(head), events.slice(3)));
	const full = reconstructGoalLedger(events);
	assert.deepEqual(resumed, full);
	assert.equal(full.focusedGoalId, null);
	assert.equal(full.goals.get("b")?.latestStatus, "paused");
	assert.equal(full.terminalGoals.get("a")?.latestStatus, "complete");
});

test("isValidLedgerEvent checks the fields of each event type", () => {
	const at = "2026-11-24T00:00:00.000Z";
	assert.ok(isValidLedgerEvent({ type: "task_started", goalId: "a", taskId: "t1", at }));
	assert.ok(!isValidLedgerEvent({ type: "task_started", goalId: "a", at }));
	assert.ok(!isValidLedgerEvent({ type: "unknown_event", goalId: "a", at }));
	assert.ok(!isValidLedgerEvent({ type: "toString", at }));
	assert.ok(!isValidLedgerEvent({ type: "audit_result", goalId: "a", auditId: "", verdict: "approved", report: "r", at }));
	assert.ok(!isValidLedgerEvent(null));
});
