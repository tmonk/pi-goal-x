import assert from "node:assert/strict";
import test from "node:test";

import {
	displayObjectiveTitle,
	footerStatus,
	formatDuration,
	formatTokenValue,
	statusLabel,
	truncateText,
	type GoalDisplayRecordLike,
} from "../extensions/goal-core.ts";

test("displayObjectiveTitle strips goal block boilerplate", () => {
	assert.equal(
		displayObjectiveTitle("=== Goal ===\nObjective: Build tests first\nSuccess criteria: pass"),
		"Build tests first",
	);
	assert.equal(
		displayObjectiveTitle("=== Sisyphus Goal ===\n目标：严格执行三步\nSteps:\n1. x"),
		"严格执行三步",
	);
	assert.equal(displayObjectiveTitle("Just a plain objective"), "Just a plain objective");
});

test("formatters preserve existing compact duration/token/status behavior", () => {
	assert.equal(formatDuration(-10), "0s");
	assert.equal(formatDuration(65), "1m05s");
	assert.equal(formatDuration(3661), "1h01m01s");
	assert.equal(formatTokenValue(999), "999 tokens");
	assert.equal(formatTokenValue(1200), "1.2K (1,200) tokens");
	assert.equal(formatTokenValue(12000), "12K (12,000) tokens");
	assert.equal(formatTokenValue(2_500_000), "2.5M (2,500,000) tokens");
	assert.equal(truncateText(" a\n b\t c ", 20), "a b c");
	assert.equal(truncateText("abcdefghij", 8), "abcde...");
});

test("goal display helpers derive labels and footer", () => {
	const goal: GoalDisplayRecordLike = {
		objective: "=== Goal ===\nObjective: Build test scaffolding and split helpers",
		status: "active",
		autoContinue: true,
		usage: { activeSeconds: 125, tokensUsed: 4_500 },
		sisyphus: false,
	};
	assert.equal(statusLabel(goal), "running");
	assert.match(footerStatus(goal), /^goal: running \[2m05s 4.5K\] - === Goal === Objective:/);

	assert.equal(statusLabel({ ...goal, sisyphus: true }), "sisyphus running");
	assert.equal(statusLabel({ ...goal, status: "paused", stopReason: "agent" }), "paused (agent)");
});
