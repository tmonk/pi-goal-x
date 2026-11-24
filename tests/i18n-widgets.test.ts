import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { statusLabel, displayStatusLabel } from "../extensions/goal-display.ts";
import { deriveGoalActivity } from "../extensions/goal-activity.ts";
import { buildGoalRunningNotification } from "../extensions/widgets/goal-notifications.ts";
import { registerLocale, setLocale } from "../extensions/i18n/index.ts";

afterEach(() => setLocale("en"));

test("display status labels translate while statusLabel stays English", () => {
	registerLocale("xw", { running: "XW running", "sisyphus {status}": "XW sisyphus {status}", paused: "XW paused" });
	setLocale("xw");
	const goal = { sisyphus: false, status: "active", autoContinue: true } as const;
	assert.equal(displayStatusLabel(goal), "XW running");
	assert.equal(statusLabel(goal), "running");
	assert.equal(displayStatusLabel({ ...goal, sisyphus: true, status: "paused", autoContinue: false }), "XW sisyphus XW paused");
});

test("activity items and notifications use the active catalog", () => {
	registerLocale("xw", { "Resumed the goal.": "XW resumed", "Goal running": "XW running", "Started {title}.": "XW started {title}" });
	setLocale("xw");
	const events = [
		{ type: "goal_resumed", goalId: "g", at: "2026-01-01T00:00:00Z" },
		{ type: "task_started", goalId: "g", taskId: "t1", at: "2026-01-01T00:00:01Z" },
	] as never;
	const items = deriveGoalActivity(events, "g", { taskTitles: new Map([["t1", "Do it"]]) });
	assert.deepEqual(items.map((item) => item.text), ["XW resumed", "XW started “Do it”"]);
	assert.match(buildGoalRunningNotification({ objective: "x", sisyphus: false, autoContinue: true }), /^● XW running/);
	setLocale("en");
	assert.match(buildGoalRunningNotification({ objective: "x", sisyphus: false, autoContinue: true }), /^● Goal running/);
});
