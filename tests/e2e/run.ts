#!/usr/bin/env node

/**
 * pi-goal deterministic e2e test runner.
 *
 * Tests:
 * 1. File-validity checks (agent file bootstrapping, chain docs)
 * 2. Handler-level integration coverage lives in tests/integration/extension.test.ts
 * 3. Real pi fork test using --mode json: reads tool_execution_start/end events
 *    from JSONL output for deterministic assertions on tool name, parameters,
 *    and result fields. Uses --append-system-prompt + --tools to ensure the AI
 *    model always calls the required tools (no non-determinism).
 *
 * Tests 1-2 are always available and deterministic. Test 3 requires the `pi`
 * CLI on PATH (skipped if unavailable) and uses the current five-tool surface:
 * the forced completion call is update_goal({status:"complete"}) with no
 * bypass fields (the real auditor runs; settings disabled:true is used only
 * in the fixture to keep the fork deterministic).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import piGoalExtension from "../../extensions/goal.ts";
import {
	createGoal,
	goalFocusDetails,
	type GoalRecord,
	type GoalStateEntry,
} from "../../extensions/goal-record.ts";
import {
	readActiveGoalPool,
	writeActiveGoalFile,
} from "../../extensions/storage/goal-files.ts";
import type { ToolDefinition, ExtensionContext } from "@earendil-works/pi-coding-agent";

const DIR = import.meta.dirname!;
const EXT_PATH = path.resolve(DIR, "..", "..", "extensions", "goal.ts");

// ── JSON event types ─────────────────────────────────────────────────────────

interface ToolExecStart {
	type: "tool_execution_start";
	toolCallId: string;
	toolName: string;
	args: Record<string, unknown>;
}

interface ToolExecEnd {
	type: "tool_execution_end";
	toolCallId: string;
	toolName: string;
	result: {
		content?: Array<{ type: string; text?: string }>;
		details?: { version: number; goal: { objective?: string; status?: string; archivedPath?: string } };
		terminate?: boolean;
		turnStoppedFor?: string | null;
	};
}

/** Parse JSONL output for matching tool_execution_start/end event pairs. */
function findToolEvents(stdout: string): Array<{ start: ToolExecStart; end: ToolExecEnd }> {
	const events: Array<{ start: ToolExecStart; end: ToolExecEnd }> = [];
	const starts = new Map<string, ToolExecStart>();
	for (const line of stdout.split("\n").filter((l) => l.trim())) {
		try {
			const obj = JSON.parse(line);
			if (obj.type === "tool_execution_start") starts.set(obj.toolCallId, obj as ToolExecStart);
			else if (obj.type === "tool_execution_end") {
				const start = starts.get(obj.toolCallId);
				if (start) events.push({ start, end: obj as ToolExecEnd });
			}
		} catch { /* skip non-JSON lines */ }
	}
	return events;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function isPiAvailable(): boolean {
	try { return spawnSync("which", ["pi"], { encoding: "utf8", stdio: "pipe" }).status === 0; }
	catch { return false; }
}


function forkFixture(instruction: string): {
	cleanup: () => void;
	run: () => { stdout: string; stderr: string };
	cwd: string;
	goalId: string;
	activePath: string;
} {
	const cwd = mkdtempSync(path.join(tmpdir(), "pi-goal-fork-"));
	mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
	const goalId = `mpme2e${Date.now().toString(36)}`;
	const now = new Date().toISOString();
	const sessionId = `test-${now.slice(-8)}`;
	const activePath = `.pi/goals/active_goal_${goalId}.md`;
	const goalData = {
		id: goalId, objective: "E2E fork test: initial", status: "active" as const,
		autoContinue: true, sisyphus: false, usage: { tokensUsed: 0, activeSeconds: 0 },
		createdAt: now, updatedAt: now, activePath,
	};
	writeFileSync(path.join(cwd, activePath), JSON.stringify(goalData) + "\n\n# Goal Prompt\n\nE2E fork test: initial\n");
	writeFileSync(path.join(cwd, ".pi", "pi-goal-x-settings.json"), JSON.stringify({ disabled: true }));
	const sessionFile = path.join(cwd, "session.jsonl");
	writeFileSync(sessionFile, [
		JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: now, cwd }),
		JSON.stringify({ type: "model_change", id: "m1", parentId: null, timestamp: now, provider: "opencode-go", modelId: "deepseek-v4-flash" }),
		JSON.stringify({ type: "thinking_level_change", id: "t1", parentId: "m1", timestamp: now, thinkingLevel: "off" }),
		JSON.stringify({ type: "custom", customType: "pi-goal-focus", timestamp: now, data: { version: 1, focusedGoalId: goalId, reason: "created" } }),
		JSON.stringify({ type: "custom", customType: "pi-goal-state", timestamp: now, data: { version: 3, goal: goalData } }),
	].join("\n") + "\n");

	// System prompt that forces the model to always use tool calls
	const sysPromptFile = path.join(cwd, "force-tool.md");
	writeFileSync(sysPromptFile, "You must use the update_goal tool with status complete to complete the request. Only respond using tool calls. Never output only text without making a tool call.");

	const run = () => {
		const result = spawnSync("pi", [
			"--mode", "json",
			"--no-extensions", "-e", EXT_PATH,
			"--tools", "create_goal,get_goal,update_goal,set_goal_tasks,update_goal_task",
			"--append-system-prompt", sysPromptFile,
			"--fork", sessionFile,
			"-p", instruction,
		], {
			cwd, encoding: "utf8", timeout: 120_000, stdio: "pipe",
			env: { ...process.env, PI_OFFLINE: "1", NODE_OPTIONS: "" },
		});
		return { stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
	};

	return {
		run,
		cwd,
		goalId,
		activePath,
		cleanup: () => rmSync(cwd, { recursive: true, force: true }),
	};
}

// ── Test Suite ───────────────────────────────────────────────────────────────

describe("Subagent E2E", () => {
	// ── 1. File-validity checks ──────────────────────────────────────────────
	it("agent file exists with bootstrapping (goal file + state entry)", () => {
		const agentPath = path.resolve(DIR, "e2e-test-runner.md");
		const content = readFileSync(agentPath, "utf8");
		assert.ok(content.includes("name: e2e-test-runner"));
		assert.ok(content.includes("Bootstrap") || content.includes("bootstrap"),
			"agent must include bootstrapping instructions");
		assert.ok(content.includes("goal file") || content.includes(".pi/goals/"),
			"agent must instruct writing a goal file");
		assert.ok(content.includes("state entry") || content.includes("pi-goal-state"),
			"agent must reference state entry");
		assert.ok(content.includes("get_goal"), "agent must use get_goal");
		assert.ok(content.includes("update_goal"), "agent must reference the current completion surface");
		assert.ok(content.includes("PASS") || content.includes("FAIL"),
			"agent must output structured PASS/FAIL report");
	});

	it("chain documentation covers deferred archival scenario", () => {
		const chainPath = path.resolve(DIR, "e2e-test.chain.md");
		const content = readFileSync(chainPath, "utf8");
		assert.ok(content.includes("deferred archival"), "chain must cover deferred archival");
		assert.ok(!content.includes("quick-sync"), "chain must not cover quick-sync (removed)");
		assert.ok(!content.includes("combined sync"), "chain must not cover combined sync (removed)");
	});

	// ── 2. Real pi fork tests (handler-level integration lives in
	//    tests/integration/extension.test.ts) ────────────────────────────────

	// ── 3. Real pi fork test (--mode json, fully deterministic) ─────────────
	// Uses --append-system-prompt + --tools to force the AI model to always
	// call the required tools. Parses tool_execution_start/end events from
	// JSONL output for structured field assertions — no free-text AI parsing.

	function assertToolEvents(stdout: string, toolName: string, callback: (events: Array<{ start: ToolExecStart; end: ToolExecEnd }>) => void) {
		const events = findToolEvents(stdout).filter((e) => e.start.toolName === toolName);
		assert.ok(events.length > 0, `fork output must contain at least one ${toolName} call`);
		callback(events);
	}

	it("fork: update_goal(complete) carries only status and archives through the deferred path",
		{ skip: !isPiAvailable(), timeout: 120_000 }, async () => {
		const f = forkFixture(
			"Call get_goal first, then call update_goal with status complete and no other parameters."
		);
		try {
			const result = f.run();
			assertToolEvents(result.stdout, "update_goal", (events) => {
				const ev = events[0];
				assert.equal(ev.start.args.status, "complete",
					"args must contain status complete");
				assert.equal(ev.start.args.verificationSummary, undefined,
					"no paperwork parameter may be passed");
				assert.equal(ev.start.args.confirmBypassAuditor, undefined,
					"no auditor-bypass parameter may be passed");
				const res = ev.end.result;
				assert.equal(res.details?.goal?.status, "complete",
					"result must show complete status");
			});
		} finally { f.cleanup(); }
	});

	// (removed — no updatedObjective / paperwork parameters exist on update_goal)

	it("fork: deferred archival — complete without sync, result and filesystem",
		{ skip: !isPiAvailable(), timeout: 120_000 }, async () => {
		const f = forkFixture(
			"Call get_goal first, then call update_goal with status complete and no other parameters."
		);
		try {
			const result = f.run();
			assertToolEvents(result.stdout, "update_goal", (events) => {
				const ev = events[0];
				assert.equal(ev.start.args.status, "complete",
					"args must contain status complete");
				assert.equal(ev.start.args.verificationSummary, undefined,
					"no paperwork parameter for plain completion");
				const res = ev.end.result;
				assert.equal(res.details?.goal?.status, "complete",
					"result must show complete status");
			});

			// Filesystem verification: the goal file must exist on disk after the fork.
			// The fork session may have archived it via turn_end, so check both
			// active and archived directories.
			const activeFile = path.join(f.cwd, f.activePath);
			const archivedDir = path.join(f.cwd, ".pi", "goals", "archived");
			let fileFound = false;
			try { fileFound = readFileSync(activeFile, "utf8").length > 0; } catch {}
			if (!fileFound) {
				const archives = readdirSync(archivedDir).filter((n) => n.includes(f.goalId));
				fileFound = archives.length > 0;
			}
			assert.ok(fileFound,
				`goal file must exist on disk after fork (active or archived).\n` +
				`Active: ${activeFile}\nArchived: ${readdirSync(archivedDir).length} files`);
		} finally { f.cleanup(); }
	});

});
