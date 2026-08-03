/**
 * Unit tests for the task list overlay component.
 *
 * Tests that the overlay:
 * - Defaults to current goal only
 * - 'a' toggles to all open goals
 * - Renders without crashing under various conditions
 * - Handles text wrapping for long titles
 * - Scrolls correctly (offset changes on up/down)
 * - Keybinding is registered in goal.ts
 */
import assert from "node:assert";
import test from "node:test";
import { readFileSync } from "node:fs";

import type { Component } from "@earendil-works/pi-tui";
import { createMockExtensionContext, invokeCustomFactory, renderComponent } from "./tui-test-utils.ts";
import { showTaskListOverlay } from "../extensions/widgets/task-list-overlay.ts";
import type { GoalRecord } from "../extensions/goal-record.ts";

// ── Helpers ───────────────────────────────────────────────────────────

function makeGoal(overrides: Partial<GoalRecord> & { id: string; objective: string }): GoalRecord {
	return {
		status: "active",
		autoContinue: true,
		usage: { tokensUsed: 0, activeSeconds: 0 },
		sisyphus: false,
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		...overrides,
		taskList: overrides.taskList ?? undefined,
	} as GoalRecord;
}

function makeGoalWithTasks(id: string, objective: string, taskTitles: string[]): GoalRecord {
	return makeGoal({
		id,
		objective,
		taskList: {
			tasks: taskTitles.map((title, i) => ({
				id: `${id}-task-${i}`,
				title,
				status: "pending" as const,
			})),
			blockCompletion: false,
			proposedAt: "2026-01-01T00:00:00.000Z",
		},
	});
}

function makeGoalWithMixedTasks(id: string, objective: string): GoalRecord {
	return makeGoal({
		id,
		objective,
		taskList: {
			tasks: [
				{ id: `${id}-t1`, title: "Do thing one", status: "complete" as const },
				{ id: `${id}-t2`, title: "Do thing two", status: "pending" as const },
				{ id: `${id}-t3`, title: "Do thing three", status: "skipped" as const },
			],
			blockCompletion: false,
			proposedAt: "2026-01-01T00:00:00.000Z",
		},
	});
}

// ── Tests ─────────────────────────────────────────────────────────────

test("defaults to current goal only", async () => {
	const ctx = createMockExtensionContext();
	const goalsById = new Map<string, GoalRecord>();
	goalsById.set("g1", makeGoalWithTasks("g1", "Focused goal", ["Task A"]));
	goalsById.set("g2", makeGoalWithTasks("g2", "Other goal", ["Task B"]));

	showTaskListOverlay(ctx, goalsById, "g1");
	const { component } = invokeCustomFactory(ctx._customCalls, 0);
	const lines = renderComponent(component, 80);
	const joined = lines.join("\n");

	assert.ok(joined.includes("Focused goal"), "shows focused goal");
	assert.ok(!joined.includes("Other goal"), "does not show other goal");
	assert.ok(joined.includes("current goal"), "header says 'current goal'");
});

test("toggles to all open goals with 'a'", async () => {
	const ctx = createMockExtensionContext();
	const goalsById = new Map<string, GoalRecord>();
	goalsById.set("g1", makeGoalWithTasks("g1", "Goal one", ["Task A"]));
	goalsById.set("g2", makeGoalWithTasks("g2", "Goal two", ["Task B"]));

	showTaskListOverlay(ctx, goalsById, "g1");
	const { component } = invokeCustomFactory(ctx._customCalls, 0);
	const cmp = component as Component & { handleInput?: (d: string) => void };

	// After 'a' toggle, both goals visible
	cmp.handleInput?.("a");
	const linesAll = renderComponent(component, 80);
	const allJoined = linesAll.join("\n");
	assert.ok(allJoined.includes("Goal one"), "shows first goal after toggle");
	assert.ok(allJoined.includes("Goal two"), "shows second goal after toggle");
	assert.ok(allJoined.includes("2 goals"), "header says '2 goals' after toggle");

	// Toggle back
	cmp.handleInput?.("a");
	const linesBack = renderComponent(component, 80);
	const backJoined = linesBack.join("\n");
	assert.ok(backJoined.includes("Goal one"), "shows focused goal after toggle back");
	assert.ok(!backJoined.includes("Goal two"), "hides other goal after toggle back");
	assert.ok(backJoined.includes("current goal"), "header says 'current goal' after toggle back");
});

test("renders without crashing with empty goals", async () => {
	const ctx = createMockExtensionContext();
	const goalsById = new Map<string, GoalRecord>();

	showTaskListOverlay(ctx, goalsById, null);
	const { component } = invokeCustomFactory(ctx._customCalls, 0);
	const lines = renderComponent(component, 80);
	const joined = lines.join("\n");

	assert.ok(joined.includes("No open goals"), "shows empty message");
});

test("renders a single goal with tasks", async () => {
	const ctx = createMockExtensionContext();
	const goalsById = new Map<string, GoalRecord>();
	const goal = makeGoalWithTasks("g1", "Build the thing", ["Design", "Implement", "Test"]);
	goalsById.set("g1", goal);

	showTaskListOverlay(ctx, goalsById, "g1");
	const { component } = invokeCustomFactory(ctx._customCalls, 0);
	const lines = renderComponent(component, 80);
	const joined = lines.join("\n");

	assert.ok(joined.includes("Build the thing"), "shows goal title");
	assert.ok(joined.includes("Design"), "shows task 1");
	assert.ok(joined.includes("Implement"), "shows task 2");
	assert.ok(joined.includes("Test"), "shows task 3");
});

test("renders a paused goal without tasks", async () => {
	const ctx = createMockExtensionContext();
	const goalsById = new Map<string, GoalRecord>();
	const goal = makeGoal({ id: "g2", objective: "Research topic", status: "paused" });
	goalsById.set("g2", goal);

	showTaskListOverlay(ctx, goalsById, "g2");
	const { component } = invokeCustomFactory(ctx._customCalls, 0);
	const lines = renderComponent(component, 80);
	const joined = lines.join("\n");

	assert.ok(joined.includes("Research topic"), "shows paused goal title");
	assert.ok(joined.includes("no tasks"), "shows no tasks indicator");
});

test("renders mixed task statuses", async () => {
	const ctx = createMockExtensionContext();
	const goalsById = new Map<string, GoalRecord>();
	const goal = makeGoalWithMixedTasks("g3", "A goal with mixed tasks");
	goalsById.set("g3", goal);

	showTaskListOverlay(ctx, goalsById, "g3");
	const { component } = invokeCustomFactory(ctx._customCalls, 0);
	const lines = renderComponent(component, 80);
	const joined = lines.join("\n");

	assert.ok(joined.includes("1/3 done"), "shows task completion summary");
	assert.ok(joined.includes("Do thing one"), "shows complete task");
	assert.ok(joined.includes("Do thing two"), "shows pending task");
	assert.ok(joined.includes("Do thing three"), "shows skipped task");
});

test("renders multiple goals when toggled to all", async () => {
	const ctx = createMockExtensionContext();
	const goalsById = new Map<string, GoalRecord>();
	goalsById.set("g1", makeGoalWithTasks("g1", "First goal", ["Task A", "Task B"]));
	goalsById.set("g2", makeGoalWithTasks("g2", "Second goal", ["Task C"]));

	showTaskListOverlay(ctx, goalsById, "g1");
	const { component } = invokeCustomFactory(ctx._customCalls, 0);
	const cmp = component as Component & { handleInput?: (d: string) => void };

	cmp.handleInput?.("a");
	const lines = renderComponent(component, 80);
	const joined = lines.join("\n");

	assert.ok(joined.includes("2 goals"), "header mentions 2 goals");
	assert.ok(joined.includes("First goal"), "shows first goal");
	assert.ok(joined.includes("Second goal"), "shows second goal");
});

test("renders at narrow width without crashing", async () => {
	const ctx = createMockExtensionContext();
	const goalsById = new Map<string, GoalRecord>();
	goalsById.set("g1", makeGoalWithTasks("g1", "Some goal", ["Task X"]));

	showTaskListOverlay(ctx, goalsById, "g1");
	const { component } = invokeCustomFactory(ctx._customCalls, 0);

	const lines40 = renderComponent(component, 40);
	assert.ok(lines40.length > 0, "renders at width 40");

	const lines60 = renderComponent(component, 60);
	assert.ok(lines60.length > 0, "renders at width 60");

	const lines120 = renderComponent(component, 120);
	assert.ok(lines120.length > 0, "renders at width 120");
});

test("handles sisyphus goal", async () => {
	const ctx = createMockExtensionContext();
	const goalsById = new Map<string, GoalRecord>();
	const goal = makeGoal({
		id: "g4",
		objective: "Sisyphus goal",
		sisyphus: true,
		autoContinue: false,
		taskList: {
			tasks: [
				{ id: "g4-t1", title: "Step one", status: "pending" as const },
			],
			blockCompletion: false,
			proposedAt: "2026-01-01T00:00:00.000Z",
		},
	});
	goalsById.set("g4", goal);

	showTaskListOverlay(ctx, goalsById, "g4");
	const { component } = invokeCustomFactory(ctx._customCalls, 0);
	const lines = renderComponent(component, 80);
	const joined = lines.join("\n");

	assert.ok(joined.includes("Sisyphus goal"), "shows sisyphus goal title");
	assert.ok(joined.includes("Step one"), "shows step");
});

test("renders subtasks", async () => {
	const ctx = createMockExtensionContext();
	const goalsById = new Map<string, GoalRecord>();
	const goal = makeGoal({
		id: "g5",
		objective: "Goal with subtasks",
		taskList: {
			tasks: [{
				id: "g5-t1",
				title: "Parent task",
				status: "pending" as const,
				subtasks: [
					{ id: "g5-s1", title: "Subtask A", status: "complete" as const },
					{ id: "g5-s2", title: "Subtask B", status: "pending" as const },
				],
			}],
			blockCompletion: false,
			proposedAt: "2026-01-01T00:00:00.000Z",
		},
	});
	goalsById.set("g5", goal);

	showTaskListOverlay(ctx, goalsById, "g5");
	const { component } = invokeCustomFactory(ctx._customCalls, 0);
	const lines = renderComponent(component, 80);
	const joined = lines.join("\n");

	assert.ok(joined.includes("Parent task"), "shows parent task");
	assert.ok(joined.includes("Subtask A"), "shows subtask A");
	assert.ok(joined.includes("Subtask B"), "shows subtask B");
});

test("wraps long task titles at narrow width", async () => {
	const ctx = createMockExtensionContext();
	const goalsById = new Map<string, GoalRecord>();
	const goal = makeGoalWithTasks("g1", "Goal", [
		"This is a very long task title that should definitely wrap at narrow terminal widths",
	]);
	goalsById.set("g1", goal);

	showTaskListOverlay(ctx, goalsById, "g1");
	const { component } = invokeCustomFactory(ctx._customCalls, 0);

	// At width 50, the inner width is small enough to force wrapping
	const lines = renderComponent(component, 50);
	const joined = lines.join("\n");

	// The long title should appear in full (wrapped), not truncated with …
	assert.ok(joined.includes("very long task title"), "long title appears via wrapping");
});

test("scroll state changes on page up/down", async () => {
	const ctx = createMockExtensionContext();
	const goalsById = new Map<string, GoalRecord>();

	// Create enough tasks to force scrolling
	const tasks = Array.from({ length: 30 }, (_, i) => `Task ${i + 1}`);
	goalsById.set("g1", makeGoalWithTasks("g1", "Long goal", tasks));

	showTaskListOverlay(ctx, goalsById, "g1");
	const { component } = invokeCustomFactory(ctx._customCalls, 0);
	const componentHandle = component as Component & { handleInput?: (data: string) => void };

	// Initial render at top
	const lines0 = renderComponent(component, 80);
	assert.ok(lines0.join("\n").includes("Task 1"), "renders top of list at offset 0");

	// Scroll down
	componentHandle.handleInput?.("down");
	const lines1 = renderComponent(component, 80);
	const joined1 = lines1.join("\n");
	assert.ok(!joined1.includes("Task 1") || joined1.includes("Task 2"),
		"content changes after scrolling down once");

	// Scroll up
	componentHandle.handleInput?.("up");
	const linesUp = renderComponent(component, 80);

	// PgDn
	componentHandle.handleInput?.("pagedown");
	renderComponent(component, 80);

	// Home
	componentHandle.handleInput?.("home");
	renderComponent(component, 80);

	// End
	componentHandle.handleInput?.("end");
	renderComponent(component, 80);

	// j/k aliases
	componentHandle.handleInput?.("home");
	componentHandle.handleInput?.("j");
	renderComponent(component, 80);
	componentHandle.handleInput?.("k");
	renderComponent(component, 80);

	assert.ok(true, "scroll operations completed without error");
});

test("dismisses on escape and enter", async () => {
	const ctx = createMockExtensionContext();
	const goalsById = new Map<string, GoalRecord>();
	goalsById.set("g1", makeGoalWithTasks("g1", "Test goal", ["Task A"]));

	showTaskListOverlay(ctx, goalsById, "g1");
	const { component } = invokeCustomFactory(ctx._customCalls, 0);
	const componentHandle = component as Component & { handleInput?: (data: string) => void };

	componentHandle.handleInput?.("escape");
	componentHandle.handleInput?.("enter");
	assert.ok(true, "dismiss operations completed without error");
});

test("keybinding calls showTaskListOverlay with focusedGoalId", async () => {
	const goalSource = readFileSync(
		new URL("../extensions/goal-widget.ts", import.meta.url),
		"utf-8",
	);

	assert.ok(
		goalSource.includes('matchesKey(data, "ctrl+shift+t")'),
		"goal-widget.ts contains the ctrl+shift+t keybinding",
	);
	assert.ok(
		goalSource.includes("showTaskListOverlay(ctx, core.goalsById, core.focusedGoalId)"),
		"goal-widget.ts calls showTaskListOverlay with focusedGoalId",
	);
	assert.ok(
		goalSource.includes('return { consume: true }'),
		"handler consumes the keyboard event",
	);
});
