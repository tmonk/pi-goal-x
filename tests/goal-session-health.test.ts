/**
 * Issue #30 — checkpoint health diagnostics (extensions/goal-session-health.ts).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
	inspectCheckpointHealth,
	projectedContentCharsAfterRecovery,
	formatCheckpointHealthReport,
	readSessionCheckpointHealth,
} from "../extensions/goal-session-health.ts";
import { checkpointTriggerPrompt } from "../extensions/prompts/goal-prompts.ts";
import { writeFileSync } from "node:fs";
import * as path from "node:path";
import { tempDir } from "./support/fs.ts";

function entry(overrides: Record<string, unknown>): Record<string, unknown> {
	return {
		type: "custom_message",
		id: `e${Math.random().toString(36).slice(2, 8)}`,
		parentId: null,
		timestamp: "2026-08-23T00:00:00.000Z",
		customType: "pi-goal-event",
		content: "",
		display: false,
		details: {},
		...overrides,
	};
}

describe("inspectCheckpointHealth", () => {
	it("counts only pi-goal-event custom messages", () => {
		const health = inspectCheckpointHealth([
			entry({ content: checkpointTriggerPrompt("g1"), details: { version: 2, kind: "checkpoint", goalId: "g1" } }),
			entry({ customType: "pi-goal-audit-event", content: "audit stuff" }),
			entry({ customType: "other", content: "x".repeat(5000) }),
			{ type: "message", message: { role: "user" } },
			null,
			"junk",
		]);
		assert.equal(health.total, 1);
		assert.equal(health.v2Minimal, 1);
		assert.equal(health.legacyFull, 0);
	});

	it("classifies legacy full checkpoints as recoverable", () => {
		const legacy = "[GOAL CHECKPOINT goalId=g1]\n" + "x".repeat(6000);
		const health = inspectCheckpointHealth([entry({ content: legacy, details: { kind: "checkpoint", goalId: "g1", objective: "big" } })]);
		assert.equal(health.total, 1);
		assert.equal(health.legacyFull, 1);
		assert.equal(health.recoverableChars, legacy.length);
		assert.equal(health.largestCheckpointChars, legacy.length);
	});

	it("requires both marker shape and version 2 for v2 classification", () => {
		// Right shape but missing details.version → treated as legacy.
		const health = inspectCheckpointHealth([
			entry({ content: checkpointTriggerPrompt("g1"), details: { kind: "checkpoint", goalId: "g1" } }),
		]);
		assert.equal(health.v2Minimal, 0);
		assert.equal(health.legacyFull, 1);
	});

	it("returns zeros for an entry list without checkpoints", () => {
		const health = inspectCheckpointHealth([{ type: "message" }]);
		assert.equal(health.total, 0);
		assert.equal(health.recoverableChars, 0);
	});
});

describe("readSessionCheckpointHealth", () => {
	it("reads a session JSONL including header and malformed lines", () => {
		const dir = tempDir("goal-health-");
		const file = path.join(dir, "session.jsonl");
		const header = JSON.stringify({ type: "session", id: "s1", cwd: dir });
		const v2 = JSON.stringify(entry({ content: checkpointTriggerPrompt("g1"), details: { version: 2, kind: "checkpoint", goalId: "g1" } }));
		const legacy = JSON.stringify(entry({ content: `[GOAL CHECKPOINT goalId=g2]\n${"y".repeat(300)}`, details: { kind: "checkpoint", goalId: "g2", objective: "old" } }));
		writeFileSync(file, [header, "{broken json", v2, legacy].join("\n") + "\n");
		const health = readSessionCheckpointHealth(file);
		assert.ok(health);
		assert.equal(health.total, 2);
		assert.equal(health.v2Minimal, 1);
		assert.equal(health.legacyFull, 1);
	});

	it("returns null for a missing file", () => {
		assert.equal(readSessionCheckpointHealth("/nonexistent/session.jsonl"), null);
	});
});

describe("projection and report", () => {
	it("projects post-recovery size to the repaired-marker floor", () => {
		const legacy = "z".repeat(6400);
		const health = inspectCheckpointHealth([entry({ content: legacy, details: {} }), entry({ content: legacy, details: {} })]);
		const projected = projectedContentCharsAfterRecovery(health);
		assert.ok(projected < health.recoverableChars * 0.05, `projected ${projected} must be under 5% of ${health.recoverableChars}`);
	});

	it("report includes totals and the recovery hint only when repair is possible", () => {
		const health = inspectCheckpointHealth([entry({ content: "x".repeat(100), details: {} })]);
		const report = formatCheckpointHealthReport(health, "/tmp/session.jsonl");
		assert.match(report, /Session checkpoints:/);
		assert.match(report, /legacy full checkpoints: 1/);
		assert.match(report, /pi-goal-x-recover --session <path> --dry-run/);

		const clean = inspectCheckpointHealth([]);
		assert.doesNotMatch(formatCheckpointHealthReport(clean), /pi-goal-x-recover/);
	});
});
