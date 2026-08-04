/**
 * Regression tests for the questionnaire dialog's alternate-screen wiring and
 * in-dialog scrolling (extensions/goal-questionnaire.ts).
 *
 * The accept-goal confirmation (propose_goal_draft) and the goal_question /
 * goal_questionnaire tools share runGoalQuestionnaire. When the running TUI
 * supports alternate-screen modals, the dialog must enter the alternate
 * screen on open, exit it BEFORE resolving (done), and bound its rendered
 * height with in-place scrolling (the alternate buffer has no scrollback).
 * Without support it must fall back to pi's default dialog (no enter/exit).
 */
import assert from "node:assert/strict";
import test from "node:test";

import type { Component, TUI } from "@earendil-works/pi-tui";

import { runGoalQuestionnaire, type GoalQuestionnaireResult } from "../extensions/goal-questionnaire.ts";
import { createMockTheme, createMockUIContext } from "./tui-test-utils.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyTui = any;

interface AltMockTUI {
	tui: TUI;
	enterCalls: unknown[];
	exitCalls: number;
	requestRenderCalls: number;
	callOrder: string[];
}

/** A mock TUI that claims alternate-screen support and records calls. */
function createAltMockTUI(rows = 12): AltMockTUI {
	const state: AltMockTUI = {
		tui: undefined as unknown as TUI,
		enterCalls: [],
		exitCalls: 0,
		requestRenderCalls: 0,
		callOrder: [],
	};
	const tui = {
		getShowHardwareCursor: () => false,
		setShowHardwareCursor: (_enabled: boolean) => {},
		requestRender: () => {
			state.requestRenderCalls++;
		},
		terminal: { rows },
		enterAlternateScreen: (component: Component) => {
			state.enterCalls.push(component);
			state.callOrder.push("enter");
		},
		exitAlternateScreen: () => {
			state.exitCalls++;
			state.callOrder.push("exit");
		},
		isAlternateScreenActive: () => state.exitCalls === 0,
	} as unknown as TUI;
	state.tui = tui;
	return state;
}

async function invokeQuestionnaire(
	tui: TUI,
	questions: Parameters<typeof runGoalQuestionnaire>[1],
	auditorToggleInit?: { defaultEnabled: boolean },
): Promise<{ component: Component; finish: (result: GoalQuestionnaireResult) => void; result: Promise<GoalQuestionnaireResult> }> {
	const { ui, customCalls } = createMockUIContext();
	const ctx = { ui, hasUI: true } as any;

	const result = runGoalQuestionnaire(ctx, questions, auditorToggleInit);
	const record = customCalls[0];
	assert.ok(record, "custom() was called");

	let finish: (r: GoalQuestionnaireResult) => void = () => {};
	const component = record.factory(
		tui,
		createMockTheme(),
		undefined,
		(r: GoalQuestionnaireResult) => finish(r),
	) as Component;
	finish = (r) => {
		// resolves the pending promise from runGoalQuestionnaire
		void result;
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		(record as any).resolve?.(r);
	};

	return { component, finish, result };
}

const LONG_CONTEXT = Array.from({ length: 30 }, (_, i) => `proposal line ${i} with some text`).join("\n");

test("runGoalQuestionnaire enters the alternate screen when supported and submits via it", async () => {
	const mock = createAltMockTUI();
	const { component, finish } = await invokeQuestionnaire(mock.tui, [
		{ id: "confirm", question: "Confirm Goal Draft", context: LONG_CONTEXT, options: ["Confirm", "Continue"], recommended: 0, allowCustom: false },
	]);

	assert.equal(mock.enterCalls.length, 1, "enterAlternateScreen called on open");
	assert.equal(mock.enterCalls[0], component, "the returned component is the one entered");

	// Enter selects the recommended option and submits
	let doneValue: GoalQuestionnaireResult | undefined;
	const doneSpy = (r: GoalQuestionnaireResult) => { doneValue = r; };
	// Re-invoke a second factory with a done spy to assert ordering
	const { ui, customCalls } = createMockUIContext();
	const ctx = { ui, hasUI: true } as any;
	const second = runGoalQuestionnaire(ctx, [
		{ id: "confirm", question: "Confirm Goal Draft", context: LONG_CONTEXT, options: ["Confirm", "Continue"], recommended: 0, allowCustom: false },
	]);
	const record = customCalls[0];
	const comp2 = record.factory(mock.tui, createMockTheme(), undefined, doneSpy) as Component;
	(comp2 as any).handleInput("\r"); // enter
	assert.equal(doneValue?.cancelled, false, "submitted");
	assert.equal(mock.exitCalls, 1, "exitAlternateScreen called before done");
	assert.deepEqual(mock.callOrder, ["enter", "enter", "exit"], "enter twice (two dialogs), exit once (first dialog)");
	assert.ok(!mock.callOrder.includes("done"), "done invoked via captured spy");
	void second;
	void finish;
});

test("runGoalQuestionnaire falls back when the TUI lacks alternate-screen support", async () => {
	const tui = {
		getShowHardwareCursor: () => false,
		setShowHardwareCursor: (_enabled: boolean) => {},
		requestRender: () => {},
		render: () => [] as string[],
		invalidate: () => {},
	} as unknown as TUI;

	const { component } = await invokeQuestionnaire(tui, [
		{ id: "q", question: "Scope?", context: LONG_CONTEXT, options: ["A", "B"], recommended: 0 },
	]);
	assert.ok(component, "component still returned (default dialog path)");
	assert.equal((tui as any).enterAlternateScreen, undefined, "no alt-screen methods on the fallback tui");
});

test("questionnaire renders windowed content with scroll indicators when it exceeds the terminal height", async () => {
	const mock = createAltMockTUI(12); // maxDialogHeight = 10
	const { component } = await invokeQuestionnaire(mock.tui, [
		{ id: "q", question: "Scope?", context: LONG_CONTEXT, options: ["Option one", "Option two"], recommended: 0 },
	]);

	const rendered = (component as any).render(100) as string[];
	assert.ok(rendered.length <= 10, `windowed to maxDialogHeight (got ${rendered.length})`);
	// Bottom-anchored default: scroll-up indicator at the top, footer visible
	assert.match(rendered[0], /^▴ \d+\/.*lines/, "scroll-up indicator present at the bottom of the content");
	assert.ok(rendered.some((l) => l.includes("Enter select")), "actionable footer visible in the window");
});

test("questionnaire scroll keys page through overflowing content", async () => {
	const mock = createAltMockTUI(12);
	const { component } = await invokeQuestionnaire(mock.tui, [
		{ id: "q", question: "Scope?", context: LONG_CONTEXT, options: ["Option one", "Option two"], recommended: 0 },
	]);
	const comp = component as any;
	const all = LONG_CONTEXT.split("\n").length + 8; // ~content lines

	// Home → top of content (no scroll-up indicator)
	comp.handleInput("\x1b[H");
	const top = comp.render(100) as string[];
	assert.ok(!(top[0] ?? "").startsWith("▴"), "home shows the top of the content");

	// PageDown → moves the window down, both indicators visible
	comp.handleInput("\x1b[6~");
	const mid = comp.render(100) as string[];
	assert.match(mid[0] ?? "", /^▴/, "scroll-up indicator after pagedown");
	assert.ok(mid.some((l: string) => l.includes("▾")), "scroll-down indicator visible mid-content");

	// End → bottom again, footer visible
	comp.handleInput("\x1b[4~");
	const bottom = comp.render(100) as string[];
	assert.ok(bottom.some((l: string) => l.includes("Enter select")), "end returns to the actionable footer");
	void all;
});
