import assert from "node:assert/strict";
import test from "node:test";

import { visibleWidth } from "@earendil-works/pi-tui";
import { Box, clampLinesToWidth, fit, layoutMode, MIN_BOX_WIDTH } from "../extensions/widgets/dashboard-box.ts";
import { formatBudget, formatCompactTokens, percentageOf } from "../extensions/widgets/dashboard-format.ts";
import { TaskScroll, scrollBy } from "../extensions/widgets/task-scroll.ts";
import { deriveGoalDashboardModel } from "../extensions/widgets/goal-dashboard-model.ts";
import type { GoalRecord, GoalTask } from "../extensions/goal-record.ts";

const plain = { fg: (_color: string, value: string) => value, bold: (value: string) => value } as never;

test("every box row is exactly the box width, however long the content", () => {
	// Below about 20 columns a header with right-side meta cannot fit; the widget clamps those lines.
	for (const width of [24, 60]) {
		const box = new Box(plain, width);
		const rows = [
			box.header("title ".repeat(30), "meta"),
			box.line("content ".repeat(30)),
			box.line(""),
			box.rule("label ".repeat(30), "right"),
			box.footer("hint ".repeat(30), "●"),
			box.footer(""),
			...box.wrapped("Contract", "word ".repeat(60)),
		];
		for (const row of rows) assert.equal(visibleWidth(row), width, `width ${width}: ${JSON.stringify(row)}`);
	}
});

test("a box never goes narrower than the minimum width", () => {
	const box = new Box(plain, 3);
	assert.equal(box.width, MIN_BOX_WIDTH);
	assert.equal(box.inner, MIN_BOX_WIDTH - 2);
});

test("fit only adds an ellipsis when it cuts", () => {
	assert.equal(fit("short", 10), "short");
	assert.equal(visibleWidth(fit("a longer string than that", 10)), 10);
	assert.ok(fit("a longer string than that", 10).includes("…"));
});

test("clampLinesToWidth cuts only the lines that are too wide", () => {
	assert.deepEqual(clampLinesToWidth(["ok", "x".repeat(20)], 8).map((l) => visibleWidth(l)), [2, 8]);
});

test("layout modes switch at 100, 70 and 50 columns", () => {
	assert.deepEqual([100, 99, 70, 69, 50, 49].map(layoutMode), ["wide", "medium", "medium", "narrow", "narrow", "minimal"]);
});

test("percentages and token counts format the same everywhere", () => {
	assert.equal(percentageOf(1, 3), 33);
	assert.equal(percentageOf(5, 0), 0);
	assert.equal(percentageOf(9, 3), 100);
	assert.equal(formatCompactTokens(18_200), "18.2K");
	assert.equal(formatCompactTokens(2_000_000), "2M");
	assert.equal(formatBudget(18_200, 50_000), "18.2K / 50K · 36%");
});

function goalWithTasks(count: number, done: number): GoalRecord {
	const tasks: GoalTask[] = Array.from({ length: count }, (_, i) => ({
		id: `t${i + 1}`,
		title: `Task ${i + 1}`,
		status: i < done ? "complete" : "pending",
		completedAt: i < done ? `2026-01-01T00:00:${String(10 + i).padStart(2, "0")}Z` : undefined,
	}));
	return {
		id: "g1", objective: "Do it", status: "active", autoContinue: true, sisyphus: false,
		usage: { tokensUsed: 0, activeSeconds: 0 },
		createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
		taskList: { tasks, blockCompletion: false, proposedAt: "2026-01-01T00:00:00.000Z" },
	};
}

test("scrollBy clamps at both ends and pages by one viewport", () => {
	assert.equal(scrollBy("up", 0, 10, 4), 0);
	assert.equal(scrollBy("down", 6, 10, 4), 6);
	assert.equal(scrollBy("pageDown", 0, 10, 4), 4);
	assert.equal(scrollBy("end", 0, 10, 4), 6);
	assert.equal(scrollBy("home", 5, 10, 4), 0);
});

test("TaskScroll anchors to the latest completion and keeps manual scrolling until the next one", () => {
	const scroll = new TaskScroll();
	const model = deriveGoalDashboardModel(goalWithTasks(12, 8), { focused: true, otherOpenGoals: 0 });
	scroll.reanchor(model, 100);
	assert.equal(scroll.compactOffset, 3, "compact window of 5 ends on the 8th task");
	assert.equal(scroll.scrollCompact("up", model, 100), true);
	assert.equal(scroll.compactOffset, 2);
	scroll.reanchor(model, 100);
	assert.equal(scroll.compactOffset, 2, "same completion: manual position survives");
	scroll.reanchor(deriveGoalDashboardModel(goalWithTasks(12, 9), { focused: true, otherOpenGoals: 0 }), 100);
	assert.equal(scroll.compactOffset, 4, "a new completion re-anchors");
});

test("TaskScroll ignores the compact keys for a short list and reports a held expanded tree", () => {
	const scroll = new TaskScroll();
	const short = deriveGoalDashboardModel(goalWithTasks(3, 1), { focused: true, otherOpenGoals: 0 });
	assert.equal(scroll.scrollCompact("down", short, 100), false);
	assert.equal(scroll.scrollExpanded("down", short, 100), "held");
	assert.equal(scroll.scrollExpanded("down", null, 100), "ignored");
	const long = deriveGoalDashboardModel(goalWithTasks(40, 0), { focused: true, otherOpenGoals: 0 });
	assert.equal(scroll.scrollExpanded("pageDown", long, 100), "scrolled");
	assert.equal(scroll.expandedOffset, 20);
});
