import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildGoalHistoryBlock, goalDetails, renderGoalResult } from "../extensions/goal-format.ts";
import { countOrderedSteps, sisyphusStepProgress } from "../extensions/goal-policy.ts";
import { renderGoalWidgetLines } from "../extensions/widgets/goal-widget.ts";
import { createMockTheme } from "./support/tui-test-utils.ts";
import { createGoal } from "../extensions/goal-record.ts";
import type { Theme } from "@earendil-works/pi-coding-agent";

const theme = createMockTheme() as unknown as Theme;

function makeGoalRecord(opts: { objective: string; sisyphus?: boolean } = { objective: "x" }) {
	const goal = createGoal({ objective: opts.objective, autoContinue: true, sisyphus: opts.sisyphus ?? false }, Date.UTC(2026, 8, 5));
	return goal;
}

function ledgerEvents(goalId: string) {
	return [
		{ type: "goal_created", goalId, objective: "x", sisyphus: false, autoContinue: true, at: "2026-08-05T09:00:00.000Z" },
		{ type: "audit_result", goalId, verdict: "disapproved", report: "missing evidence for criterion 3", at: "2026-08-05T10:00:00.000Z" },
		{ type: "task_complete", goalId, taskId: "t1", evidence: "verified", at: "2026-08-05T10:01:00.000Z" },
	] as Array<Record<string, unknown>>;
}

describe("goal history block", () => {
	it("surfaces the last audit verdict and recent lifecycle events", () => {
		const goal = makeGoalRecord({ objective: "History test" });
		const block = buildGoalHistoryBlock(goal, ledgerEvents(goal.id) as never);
		assert.match(block, /Last audit: disapproved/);
		assert.match(block, /missing evidence for criterion 3/);
		assert.match(block, /Recent events:/);
		assert.match(block, /task_complete/);
	});
});

describe("sisyphus step progress", () => {
	it("counts ordered steps from numbered markers", () => {
		assert.equal(countOrderedSteps("1. do this\n2. do that\n3. done"), 3);
		assert.equal(countOrderedSteps("Step 1: a\nStep 2: b"), 2);
		assert.equal(countOrderedSteps("no markers here"), 0);
	});

	it("derives the current step from completed top-level tasks", () => {
		const goal = makeGoalRecord({ objective: "1. a\n2. b\n3. c", sisyphus: true });
		goal.taskList = {
			tasks: [
				{ id: "t1", title: "a", status: "complete" },
				{ id: "t2", title: "b", status: "pending" },
				{ id: "t3", title: "c", status: "pending" },
			],
			blockCompletion: false,
			proposedAt: "2026-08-05T00:00:00.000Z",
		};
		const steps = sisyphusStepProgress(goal);
		assert.deepEqual(steps, { current: 2, total: 3 });
	});

	it("counts a skipped step as ended, so the next step becomes current", () => {
		const goal = makeGoalRecord({ objective: "1. a\n2. b\n3. c", sisyphus: true });
		goal.taskList = {
			tasks: [
				{ id: "t1", title: "a", status: "skipped" },
				{ id: "t2", title: "b", status: "pending" },
				{ id: "t3", title: "c", status: "pending" },
			],
			blockCompletion: false,
			proposedAt: "2026-08-05T00:00:00.000Z",
		};
		assert.deepEqual(sisyphusStepProgress(goal), { current: 2, total: 3 });
	});

	it("returns null for non-sisyphus goals", () => {
		const goal = makeGoalRecord({ objective: "1. a" });
		assert.equal(sisyphusStepProgress(goal), null);
	});
});

describe("expandable pause detail", () => {
	it("keeps the collapsed heading byte-identical and adds the detail when expanded", () => {
		const goal = makeGoalRecord({ objective: "Pause test" });
		const detail = "Pause reason: waiting on the user\nSuggested action: run /goal-tweak";
		const result = {
			content: [{ type: "text", text: "Goal paused by the agent: waiting on the user. Stop now." }],
			details: goalDetails(goal, detail),
		};
		const collapsed = renderGoalResult(result, undefined, theme).render(200).join("\n").trim();
		// Collapsed heading: byte-identical to the pre-E7 generic summary
		// (no resultDetail, no options.expanded).
		assert.match(collapsed, /^Goal running - Pause test$/);
		const expanded = renderGoalResult(result, { expanded: true }, theme).render(200).join("\n");
		assert.match(expanded, /Pause reason: waiting on the user/);
		assert.match(expanded, /Suggested action: run \/goal-tweak/);
	});
});

describe("budget line in the widget", () => {
	it("renders used/total with remaining when a budget is set", () => {
		const goal = makeGoalRecord({ objective: "Budget test" });
		goal.tokenBudget = 100000;
		goal.usage = { tokensUsed: 45000, activeSeconds: 0 };
		const lines = renderGoalWidgetLines(goal, theme, 100, { openGoalCount: 1 });
		const joined = lines.join("\n");
		assert.match(joined, /Budget 45K \/ 100K · 45%/);
	});

	it("omits the budget line when no budget is set", () => {
		const goal = makeGoalRecord({ objective: "No budget" });
		const lines = renderGoalWidgetLines(goal, theme, 100, { openGoalCount: 1 });
		assert.equal(lines.join("\n").includes("Budget"), false);
	});
});
