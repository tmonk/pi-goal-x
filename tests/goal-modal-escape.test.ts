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
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import piGoalExtension from "../extensions/goal.ts";
import {
	createGoal,
	goalFocusDetails,
	type GoalRecord,
	type GoalStateEntry,
} from "../extensions/goal-record.ts";
import { createMockTheme, createMockTUI } from "./tui-test-utils.ts";

const FIXTURE_GOAL = readFileSync(new URL("./fixtures/goals/active_goal_fixture.md", import.meta.url), "utf8");
const ESCAPE = "\x1b";
const CTRL_SHIFT_T = "\x1b[116;6u"; // kitty protocol: 't' with ctrl+shift modifiers

interface Harness {
	handlers: Record<string, (event: unknown, ctx: ExtensionContext) => unknown>;
	sentMessages: Array<{ customType?: string; details?: unknown }>;
	notifyCalls: string[];
	ctx: ExtensionContext;
	terminalInput: (data: string) => unknown;
	overlayDone: () => void;
	overlayShown: () => boolean;
}

function createHarness(cwd: string): Harness {
	const handlers: Harness["handlers"] = {};
	const sentMessages: Array<{ customType?: string; details?: unknown }> = [];
	const notifyCalls: string[] = [];
	let terminalInputHandler: ((data: string) => unknown) | null = null;
	let resolveOverlay: (() => void) | null = null;
	let overlayShown = false;

	const mockPi = {
		registerTool: () => {},
		registerCommand: () => {},
		on: (event: string, handler: (...args: never[]) => unknown) => {
			handlers[event] = handler as Harness["handlers"][string];
		},
		appendEntry: () => {},
		registerMessageRenderer: () => {},
		sendMessage: (msg: { customType?: string; details?: unknown }) => { sentMessages.push(msg); },
		sendUserMessage: () => {},
		getActiveTools: () => ["read", "bash", "edit", "write"],
		setActiveTools: () => {},
		hasUI: false,
	};

	const ctx = {
		cwd,
		hasUI: true,
		sessionManager: {
			getBranch: () => [],
			getCwd: () => cwd,
			getSessionId: () => "test-session",
			getRoot: () => cwd,
			append: () => {},
			appendModelChange: () => {},
			appendThinkingLevelChange: () => {},
			appendCompetingWriteCheck: () => {},
			buildSessionContext: () => ({ messages: [], sessionId: "test", model: null, thinkingLevel: "medium" }),
		},
		getSystemPrompt: () => "",
		isIdle: () => false,
		hasPendingMessages: () => true,
		abort: () => {},
		ui: {
			notify: (message: string) => { notifyCalls.push(message); },
			onTerminalInput: (handler: (data: string) => unknown) => {
				terminalInputHandler = handler;
				return () => { terminalInputHandler = null; };
			},
			setStatus: () => {},
			setWidget: () => {},
			setWorkingVisible: () => {},
			custom: (factory: (...args: unknown[]) => unknown) => new Promise((resolve) => {
				overlayShown = true;
				resolveOverlay = () => resolve(undefined);
				factory(createMockTUI().tui, createMockTheme(), null, resolveOverlay);
			}),
			select: async () => null,
			confirm: async () => true,
			input: async () => undefined,
		},
	} as unknown as ExtensionContext;

	piGoalExtension(mockPi as never);

	return {
		handlers,
		sentMessages,
		notifyCalls,
		ctx,
		terminalInput: (data: string) => terminalInputHandler ? terminalInputHandler(data) : undefined,
		overlayDone: () => resolveOverlay?.(),
		overlayShown: () => overlayShown,
	};
}

function fixtureCwd(): { cwd: string; goal: GoalRecord } {
	const cwd = mkdtempSync(path.join(tmpdir(), "goal-modal-escape-"));
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

async function startSession(h: Harness) {
	const ss = h.handlers["session_start"];
	assert.ok(ss, "session_start handler must be registered");
	await ss({ reason: "start" }, {
		...h.ctx,
		sessionManager: { ...h.ctx.sessionManager, getBranch: () => sessionEntriesFor({ id: "golden_fixture_goal", objective: "x", autoContinue: true } as GoalRecord) },
	} as unknown as ExtensionContext);
}

test("Escape while a goal modal is open never pauses the goal; Escape after it closes does", async () => {
	const { cwd } = fixtureCwd();
	const h = createHarness(cwd);
	try {
		await startSession(h);
		assert.ok(h.ctx.hasUI);

		// Ctrl+Shift+T opens the task-list overlay through the real keybinding:
		// the widget enters the goal modal (depth counter) before showing it.
		const openResult = h.terminalInput(CTRL_SHIFT_T);
		assert.deepEqual(openResult, { consume: true }, "ctrl+shift+t must be consumed by the widget");
		assert.ok(h.overlayShown(), "task-list overlay must be shown");

		// Escape while the modal is open: the handler must yield to the dialog
		// (return undefined) and never pause the goal.
		const escapeInModal = h.terminalInput(ESCAPE);
		assert.equal(escapeInModal, undefined, "handler must not consume Escape while a goal modal is open");
		assert.ok(!h.notifyCalls.includes("Goal paused."), "goal must not be paused while a goal modal is open");

		// Close the overlay via its done callback -> the modal exits (finally).
		h.overlayDone();
		await new Promise((resolve) => setTimeout(resolve, 10));

		// Escape with no goal modal open: the normal pause path must work.
		h.terminalInput(ESCAPE);
		assert.ok(h.notifyCalls.includes("Goal paused."), "Escape without a goal modal pauses the goal");
	} finally {
		// temp dir cleanup is best-effort.
	}
});

test("Escape with no goal modal open pauses the goal (regression guard)", async () => {
	const { cwd } = fixtureCwd();
	const h = createHarness(cwd);
	try {
		await startSession(h);

		h.terminalInput(ESCAPE);
		assert.ok(h.notifyCalls.includes("Goal paused."), "Escape must pause the goal when no modal is open");
	} finally {
		// temp dir cleanup is best-effort.
	}
});
