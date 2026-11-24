/**
 * Modal Escape isolation (bn-l pattern).
 *
 * While any goal-owned modal is open (questionnaire, task confirmation,
 * settings select, goal picker, task-list overlay, escape dialog), the
 * terminal-input handler must not intercept keys: pi's onTerminalInput runs
 * BEFORE the focused TUI overlay, so without the guard Escape would pause the
 * goal before the dialog could process it. The guard is a depth counter
 * (enterGoalModal/exitGoalModal via try/finally) so nested goal modals stay
 * guarded.
 *
 * These tests drive the REAL extension (piGoalExtension) with the real
 * keybinding handler: Ctrl+Shift+T opens the task-list overlay through the
 * keybinding (which enters the modal), then Escape is delivered both while the
 * modal is open (must not pause) and after it closes (must pause).
 */

import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
	createGoal,
	goalFocusDetails,
	type GoalRecord,
	type GoalStateEntry,
} from "../extensions/goal-record.ts";
import { createExtensionHarness } from "./support/extension-harness.ts";
import { createMockTheme, createMockTUI } from "./support/tui-test-utils.ts";
import { tempDir } from "./support/fs.ts";

const FIXTURE_GOAL = readFileSync(new URL("./fixtures/goals/active_goal_fixture.md", import.meta.url), "utf8");
const ESCAPE = "\x1b";
const CTRL_SHIFT_T = "\x1b[116;6u"; // kitty protocol: 't' with ctrl+shift modifiers

function createHarness(cwd: string, goal: GoalRecord) {
	let resolveOverlay: (() => void) | null = null;
	let overlayShown = false;

	const h = createExtensionHarness({
		cwd,
		sessionEntries: sessionEntriesFor(goal),
		hasUI: true,
		isIdle: () => false,
		hasPendingMessages: () => true,
		systemPrompt: "",
		ui: {
			// Builds the real dialog on a mock TUI; overlayDone() closes it.
			custom: (factory: (...args: unknown[]) => unknown) => new Promise((resolve) => {
				overlayShown = true;
				resolveOverlay = () => resolve({ decision: "confirm" } as never);
				factory(createMockTUI().tui, createMockTheme(), null, resolveOverlay);
			}),
			select: async () => null,
			confirm: async () => true,
		},
	});

	// Assign rather than spread: spreading would freeze the harness getters.
	return Object.assign(h, {
		overlayDone: () => resolveOverlay?.(),
		overlayShown: () => overlayShown,
	});
}

function fixtureCwd(): { cwd: string; goal: GoalRecord } {
	const cwd = tempDir("goal-modal-escape-");
	mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
	writeFileSync(path.join(cwd, ".pi", "goals", "active_goal_fixture.md"), FIXTURE_GOAL);
	const parsed = createGoal({ objective: "Golden fixture goal objective", autoContinue: true, sisyphus: false }, Date.UTC(2026, 7, 3, 9, 0, 0));
	return { cwd, goal: { ...parsed, id: "golden_fixture_goal" } };
}

function sessionEntriesFor(goal: GoalRecord): unknown[] {
	const stateEntry: GoalStateEntry = {
		version: 3,
		goal: {
			...goal,
			activePath: ".pi/goals/active_goal_fixture.md",
			usage: { tokensUsed: 0, activeSeconds: 0 },
			taskList: undefined,
			verificationContract: undefined,
		},
	};
	return [
		{ type: "custom", customType: "pi-goal-focus", data: goalFocusDetails(goal.id, "created") },
		{ type: "custom", customType: "pi-goal-state", data: stateEntry },
	];
}

test("Escape while a goal modal is open never pauses the goal; Escape after it closes does", async () => {
	const { cwd, goal } = fixtureCwd();
	const h = createHarness(cwd, goal);
	try {
		await h.sessionStart();
		assert.ok(h.ctx.hasUI);

		// Ctrl+Shift+T now toggles the unified dashboard expansion (the separate
		// task-list overlay registration is removed; §10/§19.5). It must be
		// consumed and must NOT open an overlay or enter a goal modal.
		const openResult = h.terminalInput(CTRL_SHIFT_T);
		assert.deepEqual(openResult, { consume: true }, "ctrl+shift+t must be consumed by the widget");
		assert.equal(h.overlayShown(), false, "ctrl+shift+t must not open the task-list overlay anymore");
		// Toggle back to compact so the final Escape exercises the pause path
		// rather than collapsing the expanded dashboard.
		h.terminalInput(CTRL_SHIFT_T);

		// Open a real goal modal through the real wiring: set_goal_tasks shows
		// the task-confirmation dialog (ui.custom), entering the goal modal
		// (depth counter) before showing it.
		assert.ok(h.tools.get("set_goal_tasks"), "set_goal_tasks tool registered");
		const toolPromise = h.callTool("set_goal_tasks", {
			tasks: [{ id: "t1", title: "Task one" }],
		}, "set-1");
		await new Promise((resolve) => setTimeout(resolve, 10));
		assert.ok(h.overlayShown(), "task confirmation modal must be shown");

		// Escape while the modal is open: the handler must yield to the dialog
		// (return undefined) and never pause the goal.
		const escapeInModal = h.terminalInput(ESCAPE);
		assert.equal(escapeInModal, undefined, "handler must not consume Escape while a goal modal is open");
		assert.ok(!h.notifications.includes("Goal paused."), "goal must not be paused while a goal modal is open");

		// Close the modal via its done callback -> the modal exits (finally).
		h.overlayDone();
		await toolPromise;
		await new Promise((resolve) => setTimeout(resolve, 10));

		// Escape with no goal modal open: the normal pause path must work.
		h.terminalInput(ESCAPE);
		assert.ok(h.notifications.includes("Goal paused."), "Escape without a goal modal pauses the goal");
	} finally {
		// temp dir cleanup is best-effort.
	}
});

test("Escape with no goal modal open pauses the goal (regression guard)", async () => {
	const { cwd, goal } = fixtureCwd();
	const h = createHarness(cwd, goal);
	try {
		await h.sessionStart();

		h.terminalInput(ESCAPE);
		assert.ok(h.notifications.includes("Goal paused."), "Escape must pause the goal when no modal is open");
	} finally {
		// temp dir cleanup is best-effort.
	}
});

test("Escape on a live goal pauses AND passes the key back to pi (stops the working)", async () => {
	const { cwd, goal } = fixtureCwd();
	const h = createHarness(cwd, goal);
	try {
		await h.sessionStart();

		// The fixture goal is active + autoContinue. Escape must pause it AND
		// return undefined (not { consume: true }) so pi also receives the key
		// and aborts the running tool execution / current turn — pausing without
		// stopping the "working" is the reported bug.
		const result = h.terminalInput(ESCAPE);
		assert.equal(result, undefined, "Escape on a live goal must pass back to pi so the current turn stops");
		assert.ok(h.notifications.includes("Goal paused."), "Escape on a live goal must still pause the goal");
	} finally {
		// temp dir cleanup is best-effort.
	}
});

test("Escape while the goal is paused passes through to pi without any goal state change", async () => {
	const { cwd, goal } = fixtureCwd();
	const h = createHarness(cwd, goal);
	try {
		await h.sessionStart();

		// First Escape pauses the live goal (one notification).
		h.terminalInput(ESCAPE);
		assert.equal(h.notifications.filter((m) => m === "Goal paused.").length, 1, "first Escape pauses the live goal");

		// Second Escape: the goal is now paused, so the handler must not pause
		// again (no state change) and must pass the key back to pi (undefined),
		// which stops the current turn.
		const result = h.terminalInput(ESCAPE);
		assert.equal(result, undefined, "Escape while paused must pass back to pi (stop the current turn)");
		assert.equal(
			h.notifications.filter((m) => m === "Goal paused.").length,
			1,
			"Escape while paused must not re-pause or otherwise change goal state",
		);
	} finally {
		// temp dir cleanup is best-effort.
	}
});
