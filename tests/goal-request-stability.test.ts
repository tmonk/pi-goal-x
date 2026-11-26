/**
 * What the extension puts in every model request must be small and must not
 * change on its own. A request that differs early (tool definitions, the goal
 * policy) is a prompt-cache miss for the whole conversation after it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import path from "node:path";

import { createExtensionHarness } from "./support/extension-harness.ts";
import { createGoal } from "../extensions/goal-record.ts";
import { goalPromptParts } from "../extensions/prompts/goal-prompts.ts";
import { removeDir, tempDir } from "./support/fs.ts";

function toolDefinitions(cwd: string): string[] {
	const h = createExtensionHarness({ cwd, sessionId: "stability" });
	return [...h.tools.values()].map(tool => JSON.stringify({ name: tool.name, description: tool.description, promptSnippet: tool.promptSnippet, promptGuidelines: tool.promptGuidelines, parameters: tool.parameters }));
}

test("tool definitions are the same bytes in every session and stay small", () => {
	const a = tempDir("goal-stable-a-");
	const b = tempDir("goal-stable-b-");
	try {
		const first = toolDefinitions(a);
		const second = toolDefinitions(b);
		assert.deepEqual(second, first, "a second session registered different tool definitions");
		const chars = first.reduce((sum, definition) => sum + definition.length, 0);
		// About 2,100 tokens today, sent with every request. Raise the bound on
		// purpose, not by accident (goal_control added ~1,100 characters).
		assert.ok(chars <= 9_000, `tool definitions are ${chars} characters (bound 9000)`);
	} finally {
		removeDir(a);
		removeDir(b);
	}
});

function goalWithTasks(count: number) {
	const goal = createGoal({ objective: "Ship the feature.\nSuccess criteria: tests pass.", autoContinue: true, sisyphus: false }, Date.UTC(2026, 8, 1));
	goal.id = "stable-goal";
	goal.taskList = {
		blockCompletion: true,
		proposedAt: "2026-09-01T00:00:00.000Z",
		tasks: Array.from({ length: count }, (_, i) => ({ id: `t${i}`, title: `Task ${i}`, status: i < count / 2 ? "complete" as const : "pending" as const, ...(i < count / 2 ? { evidence: "verified" } : { verificationContract: "check it" }) })),
	};
	return goal;
}

test("the goal policy and task list do not change with the clock, usage or revision", () => {
	const goal = goalWithTasks(10);
	const first = goalPromptParts(goal, { maxAutonomousRuns: 5 });
	const later = structuredClone(goal);
	later.updatedAt = "2027-01-01T00:00:00.000Z";
	later.revision = (later.revision ?? 0) + 40;
	later.usage = { ...later.usage, activeSeconds: later.usage.activeSeconds + 7200, tokensUsed: later.usage.tokensUsed + 900_000 };
	if (later.scheduler) later.scheduler = { ...later.scheduler, used: later.scheduler.used + 3 };
	const second = goalPromptParts(later, { maxAutonomousRuns: 5 });
	assert.equal(second.state, first.state);
	assert.equal(second.counters, first.counters);
	assert.notEqual(second.ephemeral, first.ephemeral, "usage belongs in the part that is sent once and never kept");
});

test("the goal policy block and a ten-task list stay within their size budget", () => {
	const parts = goalPromptParts(goalWithTasks(10), { maxAutonomousRuns: 0 });
	// About 650 tokens for the policy and 170 for the list today.
	assert.ok(parts.state.length <= 3_000, `policy block is ${parts.state.length} characters (bound 3000)`);
	assert.ok((parts.counters ?? "").length <= 900, `task list is ${(parts.counters ?? "").length} characters (bound 900)`);
});

test("pausing, resuming and changing tasks never change the advertised tools", async () => {
	const cwd = tempDir("goal-stable-tools-");
	mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
	try {
		const h = createExtensionHarness({ cwd, sessionId: "stability-tools", hasUI: false });
		await h.sessionStart();
		await h.emit("before_agent_start", { systemPrompt: "base", prompt: "go", systemPromptOptions: {} });
		await h.callTool("create_goal", { objective: "Keep the tool list still" });
		const listed = () => JSON.stringify(h.activeTools);
		const start = listed();
		await h.emit("before_agent_start", { systemPrompt: "base", prompt: "go", systemPromptOptions: {} });
		await h.callTool("set_goal_tasks", { tasks: [{ id: "a", title: "First" }], block_completion: false });
		await h.callTool("update_goal_task", { task_id: "a", status: "complete", evidence: "done" });
		await h.callTool("update_goal", { status: "paused", reason: "check" });
		await h.emit("before_agent_start", { systemPrompt: "base", prompt: "go", systemPromptOptions: {} });
		assert.equal(listed(), start, "the active tool list changed");
		assert.ok(h.toolHistory.length <= 1, `the tool list was set ${h.toolHistory.length} times`);
	} finally {
		removeDir(cwd);
	}
});
