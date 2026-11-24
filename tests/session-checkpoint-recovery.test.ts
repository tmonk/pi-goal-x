/**
 * Issue #30 — offline session recovery CLI (scripts/recover-session-checkpoints.mjs).
 *
 * Acceptance criteria under test: dry-run writes nothing; apply creates a
 * backup before replacement; ids/parentIds/line-count/header preserved;
 * non-goal and malformed lines byte-identical; idempotent; symlinks refused;
 * --apply without --confirm-pi-closed fails.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { tempDir } from "./support/fs.ts";

const CLI = new URL("../scripts/recover-session-checkpoints.mjs", import.meta.url).pathname;

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

interface Fixture {
	dir: string;
	file: string;
	legacyContent: string;
}

function makeSessionFixture(): Fixture {
	const dir = tempDir("goal-recover-");
	const file = path.join(dir, "session.jsonl");
	const legacyContent = `[GOAL CHECKPOINT goalId=g1]\nContinue working toward the active pi goal.\n${"x".repeat(6000)}`;
	const lines = [
		JSON.stringify({ type: "session", version: 3, id: "sess-1", timestamp: "2026-08-23T00:00:00.000Z", cwd: dir }),
	];
	let parent = "root";
	for (let i = 0; i < 5; i += 1) {
		const id = `cp-${i}`;
		lines.push(JSON.stringify(entry({ id, parentId: parent === "root" ? null : parent, content: legacyContent, details: { kind: "checkpoint", goalId: "g1", objective: "the whole objective" } })));
		parent = id;
	}
	// Non-goal entries that must stay byte-identical.
	lines.push(JSON.stringify({ type: "custom", id: "cust-1", parentId: parent, timestamp: "2026-08-23T00:00:01.000Z", customType: "pi-goal-focus", data: { focusedGoalId: "g1" } }));
	lines.push("{broken json line");
	writeFileSync(file, lines.join("\n") + "\n");
	return { dir, file, legacyContent };
}

function runCli(args: string[], options?: { expectFailure?: boolean }): string {
	try {
		return execFileSync(process.execPath, [CLI, ...args], { encoding: "utf8" });
	} catch (error) {
		if (options?.expectFailure) {
			const err = error as { stdout?: string; stderr?: string; status?: number };
			return `__exit_${err.status}__\n${err.stdout ?? ""}${err.stderr ?? ""}`;
		}
		throw error;
	}
}

describe("pi-goal-x-recover", () => {
	it("dry-run reports changes and writes nothing", () => {
		const fx = makeSessionFixture();
		const before = readFileSync(fx.file, "utf8");
		const out = runCli(["--session", fx.file]);
		assert.match(out, /5 legacy checkpoint\(s\) rewriteable/);
		assert.match(out, /dry-run: no changes written/);
		assert.equal(readFileSync(fx.file, "utf8"), before, "dry-run must not modify the file");
		assert.equal(readdirSync(fx.dir).filter((f) => f.includes("backup")).length, 0);
	});

	it("apply rewrites only checkpoint content/details and preserves the graph", () => {
		const fx = makeSessionFixture();
		const originalLines = readFileSync(fx.file, "utf8").split("\n");
		runCli(["--session", fx.file, "--apply", "--confirm-pi-closed"]);

		const afterLines = readFileSync(fx.file, "utf8").split("\n");
		assert.equal(afterLines.length, originalLines.length, "line count unchanged");

		const backups = readdirSync(fx.dir).filter((f) => f.startsWith("session.jsonl.backup-"));
		assert.equal(backups.length, 1, "exactly one backup created");
		const backupText = readFileSync(path.join(fx.dir, backups[0]!), "utf8");
		const originalRaw = originalLines.join("\n");
		assert.ok(originalRaw.length > 0);
		// Backup preserves the pre-repair content.
		assert.match(backupText, /GOAL CHECKPOINT goalId=g1/);

		let checkpoints = 0;
		for (let i = 0; i < afterLines.length; i += 1) {
			const after = afterLines[i]!;
			const beforeLine = originalLines[i]!;
			if (!after.trim()) continue;
			// Malformed lines: byte comparison only.
			let parsedAfter;
			let parsedBefore;
			try {
				parsedAfter = JSON.parse(after);
				parsedBefore = JSON.parse(beforeLine);
			} catch {
				assert.equal(after, beforeLine, `malformed line ${i + 1} byte-identical`);
				continue;
			}
			if (!after.includes('"pi-goal-event"') || parsedBefore.type !== "custom_message") {
				assert.equal(after, beforeLine, `non-goal line ${i + 1} byte-identical`);
				continue;
			}
			checkpoints += 1;
			// Graph identity preserved.
			assert.equal(parsedAfter.id, parsedBefore.id);
			assert.equal(parsedAfter.parentId, parsedBefore.parentId);
			// Content is now the bounded v2 marker.
			assert.equal(parsedAfter.content, '<pi_goal_continuation goal_id="g1" kind="checkpoint" v="2"/>');
			assert.equal(parsedAfter.details.version, 2);
			assert.equal(parsedAfter.details.objective, undefined, "objective stripped from details");
			// Idempotency: a second dry-run reports zero further changes.
		}
		assert.equal(checkpoints, 5);

		const secondRun = runCli(["--session", fx.file]);
		assert.match(secondRun, /0 legacy checkpoint\(s\) rewriteable/);
	});

	it("is idempotent after apply (file bytes stable)", () => {
		const fx = makeSessionFixture();
		runCli(["--session", fx.file, "--apply", "--confirm-pi-closed"]);
		const once = readFileSync(fx.file, "utf8");
		runCli(["--session", fx.file, "--apply", "--confirm-pi-closed"]);
		assert.equal(readFileSync(fx.file, "utf8"), once);
	});

	it("refuses --apply without --confirm-pi-closed", () => {
		const fx = makeSessionFixture();
		const before = readFileSync(fx.file, "utf8");
		const out = runCli(["--session", fx.file, "--apply"], { expectFailure: true });
		assert.match(out, /__exit_1__/);
		assert.match(out, /confirm-pi-closed/);
		assert.equal(readFileSync(fx.file, "utf8"), before, "refused apply must not modify the file");
	});

	it("refuses a symlink target", () => {
		const fx = makeSessionFixture();
		const link = path.join(fx.dir, "linked.jsonl");
		symlinkSync(fx.file, link);
		const out = runCli(["--session", link], { expectFailure: true });
		assert.match(out, /__exit_1__/);
		assert.match(out, /symbolic link/);
	});

	it("preserves malformed unrelated lines byte-identically", () => {
		const fx = makeSessionFixture();
		runCli(["--session", fx.file, "--apply", "--confirm-pi-closed"]);
		const text = readFileSync(fx.file, "utf8");
		assert.ok(text.includes("{broken json line"), "malformed line preserved verbatim");
	});

	it("accepts POSIX-style relative paths resolved from cwd", () => {
		const fx = makeSessionFixture();
		const out = execFileSync(process.execPath, [CLI, "--session", path.basename(fx.file)], {
			encoding: "utf8",
			cwd: fx.dir,
		});
		assert.match(out, /5 legacy checkpoint\(s\) rewriteable/);
	});
});
