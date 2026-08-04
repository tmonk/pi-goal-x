/**
 * Regression tests for the questionnaire dialog's bounded bottom-panel
 * rendering (extensions/goal-questionnaire.ts).
 *
 * The accept-goal confirmation (propose_goal_draft) and the goal_question /
 * goal_questionnaire tools share runGoalQuestionnaire. Per the reworked
 * contract the dialog must open as a bottom-anchored OVERLAY panel in the
 * main terminal screen (no alternate screen — terminal scrollback stays
 * usable and history stays visible above), bound its rendered height to a
 * fraction of the terminal with in-place scrolling (▴/▾ + PgUp/PgDn/Home/End),
 * and resolve through done.
 */
import assert from "node:assert/strict";
import test from "node:test";

import type { Component, TUI } from "@earendil-works/pi-tui";

import { runGoalQuestionnaire, type GoalQuestionnaireResult } from "../extensions/goal-questionnaire.ts";
import { createMockTheme, createMockUIContext } from "./tui-test-utils.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyTui = any;

interface PanelMockTUI {
	tui: TUI;
	requestRenderCalls: number;
	setShowHardwareCursorCalls: boolean[];
}

/** A mock TUI shaped like pi's (terminal rows exposed for the panel bound). */
function createPanelMockTUI(rows = 40): PanelMockTUI {
	const state: PanelMockTUI = {
		tui: undefined as unknown as TUI,
		requestRenderCalls: 0,
		setShowHardwareCursorCalls: [],
	};
	const tui = {
		getShowHardwareCursor: () => false,
		setShowHardwareCursor: (enabled: boolean) => {
			state.setShowHardwareCursorCalls.push(enabled);
		},
		requestRender: () => {
			state.requestRenderCalls++;
		},
		terminal: { rows },
	} as unknown as TUI;
	state.tui = tui;
	return state;
}

async function invokeQuestionnaire(
	tui: TUI,
	questions: Parameters<typeof runGoalQuestionnaire>[1],
	auditorToggleInit?: { defaultEnabled: boolean },
): Promise<{
	component: Component;
	options: unknown;
	submit: (result: GoalQuestionnaireResult) => void;
	result: Promise<GoalQuestionnaireResult>;
}> {
	const { ui, customCalls } = createMockUIContext();
	const ctx = { ui, hasUI: true } as any;

	const result = runGoalQuestionnaire(ctx, questions, auditorToggleInit);
	const record = customCalls[0];
	assert.ok(record, "custom() was called");

	let submit: (r: GoalQuestionnaireResult) => void = () => {};
	const component = record.factory(
		tui,
		createMockTheme(),
		undefined,
		(r: GoalQuestionnaireResult) => submit(r),
	) as Component;
	submit = (r) => {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		(record as any).resolve?.(r);
	};

	return { component, options: record.options, submit, result };
}

const LONG_CONTEXT = Array.from({ length: 30 }, (_, i) => `proposal line ${i} with some text`).join("\n");

test("runGoalQuestionnaire custom() options request a bottom-anchored bounded overlay", async () => {
	const mock = createPanelMockTUI();
	const { options } = await invokeQuestionnaire(mock.tui, [
		{ id: "q", question: "Scope?", context: LONG_CONTEXT, options: ["A", "B"], recommended: 0 },
	]);
	const opts = options as { overlay?: boolean; overlayOptions?: Record<string, unknown> };
	assert.equal(opts.overlay, true, "overlay: true (main screen, not an alternate buffer)");
	assert.ok(opts.overlayOptions, "overlayOptions provided");
	assert.equal(opts.overlayOptions!.anchor, "bottom-center", "bottom-anchored panel");
	assert.equal(opts.overlayOptions!.maxHeight, "45%", "bounded to 45% of the terminal height");
});

test("questionnaire renders windowed content within the panel bound with scroll indicators", async () => {
	const mock = createPanelMockTUI(40); // maxDialogHeight = floor(40 * 0.45) = 18
	const { component } = await invokeQuestionnaire(mock.tui, [
		{ id: "q", question: "Scope?", context: LONG_CONTEXT, options: ["Option one", "Option two"], recommended: 0 },
	]);

	const rendered = (component as any).render(100) as string[];
	assert.ok(rendered.length <= 18, `windowed to the panel bound (got ${rendered.length})`);
	// Bottom-anchored default: scroll-up indicator at the top, footer visible
	assert.match(rendered[0], /^▴ \d+\/.*lines/, "scroll-up indicator present (content overflows the panel)");
	assert.ok(rendered.some((l) => l.includes("Enter select")), "actionable footer visible in the window");
});

test("questionnaire scroll keys page through overflowing content within the panel", async () => {
	const mock = createPanelMockTUI(40);
	const { component } = await invokeQuestionnaire(mock.tui, [
		{ id: "q", question: "Scope?", context: LONG_CONTEXT, options: ["Option one", "Option two"], recommended: 0 },
	]);
	const comp = component as any;

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
});

test("questionnaire submits the recommended option through done", async () => {
	const mock = createPanelMockTUI();
	const { component } = await invokeQuestionnaire(mock.tui, [
		{ id: "confirm", question: "Confirm Goal Draft", context: "short context", options: ["Confirm — create this goal now", "Continue chatting"], recommended: 0, allowCustom: false },
	]);

	let doneValue: GoalQuestionnaireResult | undefined;
	const { ui, customCalls } = createMockUIContext();
	const ctx = { ui, hasUI: true } as any;
	void runGoalQuestionnaire(ctx, [
		{ id: "confirm", question: "Confirm Goal Draft", context: "short context", options: ["Confirm — create this goal now", "Continue chatting"], recommended: 0, allowCustom: false },
	]);
	const record = customCalls[0];
	const comp = record.factory(mock.tui, createMockTheme(), undefined, (r: GoalQuestionnaireResult) => { doneValue = r; }) as Component;
	(comp as any).handleInput("\r"); // enter selects the recommended option
	assert.equal(doneValue?.cancelled, false, "submitted, not cancelled");
	assert.equal(doneValue?.answers[0]?.answer, "Confirm — create this goal now", "recommended option selected");
	assert.equal(doneValue?.answers[0]?.wasCustom, false);
});
