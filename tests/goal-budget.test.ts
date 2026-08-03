/**
 * Budget integration tests (Stage 2): when accounted usage reaches tokenBudget,
 * the runtime marks the goal budget_limited exactly once, emits the
 * goal_budget_limited ledger event, and arms one-time wrap-up steering.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import goalExtension from "../extensions/goal.ts";
import { createGoal, goalFocusDetails } from "../extensions/goal-record.ts";
import { parseGoalFile, writeActiveGoalFile } from "../extensions/storage/goal-files.ts";
import { goalLedgerPath } from "../extensions/goal-ledger.ts";

function createHarness(cwd: string, sessionEntries: unknown[]) {
	const handlers = new Map<string, Function>();
	const commands = new Map<string, any>();
	let activeTools = ["read", "bash", "edit", "write"];
	const pi = {
		registerTool: () => {},
		registerCommand: (name: string, def: any) => { commands.set(name, def); },
		on: (event: string, handler: Function) => { handlers.set(event, handler); },
		appendEntry: () => {},
		registerMessageRenderer: () => {},
		sendMessage: () => {},
		getActiveTools: () => [...activeTools],
		setActiveTools: (names: string[]) => { activeTools = [...names]; },
		hasUI: false,
	};
	const ctx = {
		cwd,
		hasUI: false,
		sessionManager: {
			getBranch: () => sessionEntries,
			getCwd: () => cwd,
			getSessionId: () => "budget-test-session",
			getRoot: () => cwd,
		},
		ui: {
			notify: () => {},
			setStatus: () => {},
			setWidget: () => {},
			onTerminalInput: () => () => {},
			select: async () => undefined,
			confirm: async () => false,
			custom: async () => undefined,
		},
		getSystemPrompt: () => "base prompt",
		isIdle: () => true,
		hasPendingMessages: () => false,
		abort: () => {},
	} as unknown as ExtensionContext;
	goalExtension(pi as any, {});
	return { handlers, commands, ctx };
}

function fixture() {
	const cwd = mkdtempSync(path.join(tmpdir(), "goal-budget-"));
	mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
	const goal = createGoal({
		objective: "=== Goal ===\nObjective: Budgeted goal",
		autoContinue: true,
		sisyphus: false,
	}, Date.UTC(2026, 7, 3, 9, 0, 0));
	goal.tokenBudget = 100;
	goal.usage.tokensUsed = 80;
	const written = writeActiveGoalFile({ cwd }, goal);
	const sessionEntries = [
		{ type: "custom", customType: "pi-goal-focus", data: goalFocusDetails(goal.id, "created") },
	];
	const cleanup = () => { try { rmSync(cwd, { recursive: true, force: true }); } catch {} };
	return { cwd, goal: written, sessionEntries, cleanup };
}

function activeGoalFiles(cwd: string): string[] {
	try {
		return readdirSync(path.join(cwd, ".pi", "goals")).filter((n) => n.startsWith("active_goal_"));
	} catch {
		return [];
	}
}

function ledgerEvents(cwd: string): Array<Record<string, unknown>> {
	if (!existsSync(goalLedgerPath({ cwd }))) return [];
	return readFileSync(goalLedgerPath({ cwd }), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
}

function turnEndMessage(tokens: number) {
	return { role: "assistant", stopReason: "stop", usage: { input: tokens, output: 0 } };
}

test("budget reached marks the goal budget_limited exactly once with ledger + one-time steering", async () => {
	const f = fixture();
	try {
		const { handlers, ctx } = createHarness(f.cwd, f.sessionEntries);
		await handlers.get("session_start")?.({ reason: "start" }, ctx);

		// First turn_end charges 30 tokens: 80 + 30 = 110 >= budget 100 → transition.
		await handlers.get("turn_end")?.({ message: turnEndMessage(30) }, ctx);

		// Status flipped on disk to budget_limited.
		const active = activeGoalFiles(f.cwd);
		assert.equal(active.length, 1, "goal stays in the active dir (not archived)");
		const disk = parseGoalFile(path.join(f.cwd, ".pi", "goals", active[0]!));
		assert.ok(disk, "goal file must parse");
		assert.equal(disk.status, "budget_limited");

		// Ledger event written with budget + usage snapshot.
		const events = ledgerEvents(f.cwd);
		const budgetEvents = events.filter((e) => e.type === "goal_budget_limited");
		assert.equal(budgetEvents.length, 1, "exactly one goal_budget_limited event");
		assert.equal(budgetEvents[0]!.goalId, f.goal.id);
		assert.equal(budgetEvents[0]!.budget, 100);
		assert.ok(Number(budgetEvents[0]!.tokensUsed) >= 100);

		// One-time wrap-up steering is injected on the next agent start.
		const result = await handlers.get("before_agent_start")?.({
			systemPrompt: "base",
			prompt: "",
			systemPromptOptions: {},
		}, ctx);
		const promptText = result?.systemPrompt ?? "";
		assert.ok(promptText.includes("BUDGET LIMITED"), "budget-limited block injected");
		assert.ok(promptText.includes("TOKEN BUDGET REACHED"), "one-time wrap-up steering injected");

		// A second agent start must NOT re-inject the one-time steering.
		const second = await handlers.get("before_agent_start")?.({
			systemPrompt: "base",
			prompt: "",
			systemPromptOptions: {},
		}, ctx);
		assert.ok(!(second?.systemPrompt ?? "").includes("TOKEN BUDGET REACHED"), "steering fires exactly once");

		// A further turn_end cannot re-fire the transition (status not active).
		await handlers.get("turn_end")?.({ message: turnEndMessage(50) }, ctx);
		const budgetEvents2 = ledgerEvents(f.cwd).filter((e) => e.type === "goal_budget_limited");
		assert.equal(budgetEvents2.length, 1, "transition fires exactly once");
	} finally {
		f.cleanup();
	}
});

test("goal without a budget never transitions", async () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "goal-nobudget-"));
	mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
	try {
		const goal = createGoal({ objective: "No budget", autoContinue: true, sisyphus: false }, Date.UTC(2026, 7, 3, 10, 0, 0));
		const written = writeActiveGoalFile({ cwd }, goal);
		const sessionEntries = [{ type: "custom", customType: "pi-goal-focus", data: goalFocusDetails(goal.id, "created") }];
		const { handlers, ctx } = createHarness(cwd, sessionEntries);
		await handlers.get("session_start")?.({ reason: "start" }, ctx);
		await handlers.get("turn_end")?.({ message: turnEndMessage(5000) }, ctx);
		const active = activeGoalFiles(cwd);
		assert.equal(active.length, 1);
		const disk = parseGoalFile(path.join(cwd, ".pi", "goals", active[0]!));
		assert.ok(disk, "goal file must parse");
		assert.equal(disk.status, "active", "no budget → no transition");
		assert.equal(ledgerEvents(cwd).filter((e) => e.type === "goal_budget_limited").length, 0);
	} finally {
		try { rmSync(cwd, { recursive: true, force: true }); } catch {}
	}
});
