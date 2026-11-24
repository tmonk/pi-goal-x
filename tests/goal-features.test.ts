/**
 * F1–F6 feature tests (task 5).
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildGoalTaskDetailBlock } from "../extensions/goal-format.ts";
import { deriveTasksFromObjective } from "../extensions/goal-task-derive.ts";
import { createGoalCore } from "../extensions/goal-state.ts";
import { createGoal } from "../extensions/goal-record.ts";
import { readGoalLedger } from "../extensions/goal-ledger.ts";
import { parseGoalFile, writeActiveGoalFile } from "../extensions/storage/goal-files.ts";
import { renderGoalWidgetLines } from "../extensions/widgets/goal-widget.ts";
import { createMockTheme } from "./tui-test-utils.ts";
import type { Theme } from "@earendil-works/pi-coding-agent";

const theme = createMockTheme() as unknown as Theme;

function makeGoal(opts: { objective: string; sisyphus?: boolean; budget?: number } = { objective: "x" }) {
	const goal = createGoal({ objective: opts.objective, autoContinue: true, sisyphus: opts.sisyphus ?? false }, Date.UTC(2026, 8, 5));
	if (opts.budget) goal.tokenBudget = opts.budget;
	return goal;
}

function coreHarness(cwd: string) {
	const handlers = new Map();
	const tools = new Map();
	const notifies: Array<{ msg: string; level: string }> = [];
	const pi = {
		registerTool: (def: unknown) => tools.set((def as { name: string }).name, def),
		registerCommand: () => {},
		on: (event: string, handler: unknown) => handlers.set(event, handler),
		appendEntry: () => {},
		registerMessageRenderer: () => {},
		sendMessage: () => {},
		getActiveTools: () => ["read", "bash", "edit", "write"],
		setActiveTools: () => {},
		hasUI: true,
	};
	const ctx = {
		cwd, hasUI: true,
		sessionManager: { getBranch: () => [], getCwd: () => cwd, getSessionId: () => "s", getRoot: () => cwd },
		ui: {
			notify: (msg: string, level: string) => notifies.push({ msg, level }),
			setStatus: () => {}, setWidget: () => {},
			onTerminalInput: (cb: unknown) => cb,
			select: async () => undefined,
			input: async () => "evidence from test",
			confirm: async () => true,
			custom: async () => undefined,
		},
		getSystemPrompt: () => "", isIdle: () => true, hasPendingMessages: () => false, abort: () => {},
	};
	const core = createGoalCore(pi as never, {});
	return { core, ctx, handlers, notifies };
}

function fixtureCwd(prefix = "goal-feat-") {
	const cwd = mkdtempSync(path.join(tmpdir(), prefix));
	mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
	return cwd;
}

function ledgerText(cwd: string): string {
	try {
		return readFileSync(path.join(cwd, ".pi", "goals", "goal_events.jsonl"), "utf8");
	} catch {
		return "";
	}
}

describe("F1 task detail block (get_goal mirror)", () => {
	it("shows counts, next pending with contracts, and recent completions", () => {
		const goal = makeGoal({ objective: "F1 test" });
		goal.taskList = {
			tasks: [
				{ id: "t1", title: "Done task", status: "complete", evidence: "verified green" },
				{ id: "t2", title: "Next task", status: "pending", verificationContract: "run the suite" },
			],
			blockCompletion: false,
			proposedAt: "2026-08-05T00:00:00.000Z",
		};
		const block = buildGoalTaskDetailBlock(goal);
		assert.match(block, /1\/2 tasks complete/);
		assert.match(block, /\[ \] t2: Next task/);
		assert.match(block, /contract: run the suite/);
		assert.match(block, /\[x\] t1: Done task — verified green/);
	});
});

describe("F2 objective→task bootstrap", () => {
	it("derives tasks from checklist markers", () => {
		const tasks = deriveTasksFromObjective("- [ ] first\n- [ ] second\n- [ ] third");
		assert.equal(tasks?.length, 3);
		assert.equal(tasks?.[0]?.title, "first");
	});

	it("derives tasks from numbered steps (2+)", () => {
		const tasks = deriveTasksFromObjective("1. extract\n2. wire\n3. test");
		assert.equal(tasks?.length, 3);
		assert.equal(tasks?.[2]?.title, "test");
	});

	it("returns null without structure or with a lone numbered line", () => {
		assert.equal(deriveTasksFromObjective("just an objective"), null);
		assert.equal(deriveTasksFromObjective("1. lone step"), null);
	});
});

describe("F7 auditor toggle (Ctrl+Shift+A)", () => {
	it("toggleGoalAuditor flips per-goal skipAuditor, persists it, records the event, and notifies", async () => {
		const cwd = fixtureCwd();
		try {
			const goal = writeActiveGoalFile({ cwd }, makeGoal({ objective: "Auditor toggle test" }));
			const h = coreHarness(cwd);
			await h.core.loadState(h.ctx as never);
			h.core.setFocusedGoalId(goal.id, h.ctx as never, "selected", { recordLedger: false });
			assert.equal(h.core.state.goal?.skipAuditor, undefined, "auditor on by default");

			h.core.toggleGoalAuditor(h.ctx as never);
			assert.equal(h.core.state.goal?.skipAuditor, true, "toggle disables the auditor in memory");
			let toggled = readGoalLedger({ cwd }).events.filter((e) => e.type === "auditor_toggled");
			assert.equal(toggled.length, 1, "one auditor_toggled event");
			assert.equal((toggled[0] as any).enabled, false, "event records the new disabled state");
			assert.ok(h.notifies.some((n) => n.msg.includes("Auditor disabled")), "disabling is announced");
			const onDisk = parseGoalFile(path.join(cwd, h.core.state.goal!.activePath!))!;
			assert.equal(onDisk.skipAuditor, true, "skipAuditor persisted to the goal file");

			h.core.toggleGoalAuditor(h.ctx as never);
			assert.equal(h.core.state.goal?.skipAuditor, undefined, "toggling again enables the auditor");
			toggled = readGoalLedger({ cwd }).events.filter((e) => e.type === "auditor_toggled");
			assert.equal(toggled.length, 2, "second event recorded");
			assert.equal((toggled[1] as any).enabled, true, "second event records the enabled state");
			const onDisk2 = parseGoalFile(path.join(cwd, h.core.state.goal!.activePath!))!;
			assert.equal(onDisk2.skipAuditor, undefined, "enabling clears the persisted skipAuditor");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("toggleGoalAuditor is inert with no focused goal", async () => {
		const cwd = fixtureCwd();
		try {
			const h = coreHarness(cwd);
			await h.core.loadState(h.ctx as never);
			h.core.toggleGoalAuditor(h.ctx as never);
			assert.ok(h.notifies.some((n) => n.msg.includes("No focused goal")), "no-goal guard announces");
			assert.equal(readGoalLedger({ cwd }).events.filter((e) => e.type === "auditor_toggled").length, 0, "no event without a goal");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("toggleGoalAuditor is inert for a complete goal", async () => {
		const cwd = fixtureCwd();
		try {
			const goal = makeGoal({ objective: "Complete toggle test" });
			const h = coreHarness(cwd);
			await h.core.loadState(h.ctx as never);
			h.core.setGoal({ ...goal, status: "complete" }, h.ctx as never, true);
			h.core.toggleGoalAuditor(h.ctx as never);
			assert.ok(h.notifies.some((n) => n.msg.includes("complete; the auditor no longer applies")), "complete-goal guard announces");
			assert.equal(h.core.state.goal?.skipAuditor, undefined, "no mutation on a complete goal");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});

describe("F4 sisyphus ordered-step widget", () => {
	it("renders the Step N/M badge and current-step highlight", () => {
		const goal = makeGoal({ objective: "1. a\n2. b\n3. c", sisyphus: true });
		goal.taskList = {
			tasks: [
				{ id: "t1", title: "a", status: "complete" },
				{ id: "t2", title: "b", status: "pending" },
				{ id: "t3", title: "c", status: "pending" },
			],
			blockCompletion: false,
			proposedAt: "2026-08-05T00:00:00.000Z",
		};
		const lines = renderGoalWidgetLines(goal, theme, 100, { openGoalCount: 1 });
		const joined = lines.join("\n");
		// The unified dashboard derives progress from the task tree (§9.1): the
		// ordered-step detector stays in prompts; the widget shows task progress.
		assert.match(joined, /Tasks · ✓1 done · 2 open/);
		assert.match(joined, /Current  t2 · b/);
	});
});

describe("F5 stall detector", () => {
	it("emits a [GOAL STALLED] note + ledger event after the timeout; off by default", async () => {
		const cwd = fixtureCwd();
		try {
			writeFileSync(path.join(cwd, ".pi", "pi-goal-x-settings.json"), JSON.stringify({ stallTimeoutMinutes: 1 }));
			const goal = writeActiveGoalFile({ cwd }, makeGoal({ objective: "F5 test" }));
			const h = coreHarness(cwd);
			await h.core.loadState(h.ctx as never);
			h.core.setFocusedGoalId(goal.id, h.ctx as never, "selected", { recordLedger: false });

			// no activity for >1 minute: age Date.now for the check
			const realNow = Date.now;
			(Date as unknown as { now: () => number }).now = () => realNow() + 70_000;
			try {
				const note = h.core.checkStall(h.ctx as never);
				assert.match(note, /\[GOAL STALLED/);
				assert.match(note, /No continuation or tool activity for 1 minute/);
			} finally {
				(Date as unknown as { now: () => number }).now = realNow;
			}
			assert.ok(h.notifies.some((n) => n.msg.includes("Goal stalled")), "stall notification fired");
			assert.match(ledgerText(cwd), /goal_stalled/);
			// second call: one-shot (stallNotified)
			(Date as unknown as { now: () => number }).now = () => realNow() + 70_000;
			try {
				assert.equal(h.core.checkStall(h.ctx as never), "", "stall note fires once");
			} finally {
				(Date as unknown as { now: () => number }).now = realNow;
			}
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("returns nothing when the detector is off", async () => {
		const cwd = fixtureCwd();
		try {
			const goal = writeActiveGoalFile({ cwd }, makeGoal({ objective: "F5 off" }));
			const h = coreHarness(cwd);
			await h.core.loadState(h.ctx as never);
			h.core.setFocusedGoalId(goal.id, h.ctx as never, "selected", { recordLedger: false });
			assert.equal(h.core.checkStall(h.ctx as never), "");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});

describe("F6 token-budget threshold alerts", () => {
	it("emits goal_budget_warning events at 50/75/90%", async () => {
		const cwd = fixtureCwd();
		try {
			const goal = writeActiveGoalFile({ cwd }, makeGoal({ objective: "F6 test", budget: 100000 }));
			const h = coreHarness(cwd);
			await h.core.loadState(h.ctx as never);
			h.core.setFocusedGoalId(goal.id, h.ctx as never, "selected", { recordLedger: false });
			h.core.beginAccounting();
			h.core.accountProgress(h.ctx as never, { completedTurnTokens: 60000 }); // 60% → 50% warning
			h.core.accountProgress(h.ctx as never, { completedTurnTokens: 20000 }); // 80% → 75% warning
			h.core.accountProgress(h.ctx as never, { completedTurnTokens: 20000 }); // 100% → 90% warning + budget_limited
			const ledger = ledgerText(cwd);
			const warnings = (ledger.match(/"type":"goal_budget_warning"/g) ?? []).length;
			assert.equal(warnings, 3, "one warning per crossed threshold (50/75/90)");
			assert.match(ledger, /"pct":60/); // first charge crossed 50%
			assert.match(ledger, /"pct":80/); // second crossed 75%
			assert.match(ledger, /"pct":100/); // third crossed 90%
			assert.match(ledger, /goal_budget_limited/);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});
