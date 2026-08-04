/**
 * Alternate-screen wiring tests for the task-list confirmation and the audit
 * escape dialog (extensions/goal-task-confirmation.ts and
 * extensions/widgets/goal-escape-dialog.ts).
 *
 * Both dialogs must enter the alternate screen when the running TUI supports
 * it (isolating rendering from the main screen so open/close cannot scroll
 * the viewport or yank a user out of scrollback), exit it BEFORE resolving
 * done, and fall back to pi's default dialog path otherwise.
 */
import assert from "node:assert/strict";
import test from "node:test";

import type { Component, TUI } from "@earendil-works/pi-tui";

import { showTaskConfirmation } from "../extensions/goal-task-confirmation.ts";
import { showEscapeDialog } from "../extensions/widgets/goal-escape-dialog.ts";
import { createMockTheme, createMockUIContext } from "./tui-test-utils.ts";

interface AltMock {
	enterCalls: unknown[];
	exitCalls: number;
	requestRenderCalls: number;
	callOrder: string[];
	tui: TUI;
}

function createAltMockTUI(): AltMock {
	const state: AltMock = {
		enterCalls: [],
		exitCalls: 0,
		requestRenderCalls: 0,
		callOrder: [],
		tui: undefined as unknown as TUI,
	};
	const tui = {
		getShowHardwareCursor: () => false,
		setShowHardwareCursor: (_enabled: boolean) => {},
		requestRender: () => {
			state.requestRenderCalls++;
		},
		terminal: { rows: 40 },
		enterAlternateScreen: (component: Component) => {
			state.enterCalls.push(component);
			state.callOrder.push("enter");
		},
		exitAlternateScreen: () => {
			state.exitCalls++;
			state.callOrder.push("exit");
		},
	} as unknown as TUI;
	state.tui = tui;
	return state;
}

function runDialog<T>(
	invoke: (ctx: { ui: ReturnType<typeof createMockUIContext>["ui"]; hasUI: boolean }) => Promise<T>,
	doneSpy: (result: T) => void,
): { customCalls: ReturnType<typeof createMockUIContext>["customCalls"] } {
	const { ui, customCalls } = createMockUIContext();
	const ctx = { ui, hasUI: true };
	const promise = invoke(ctx);
	// capture done for the first custom() call so tests can drive it
	const record = customCalls[0];
	if (record) {
		const originalFactory = record.factory;
		record.factory = ((tui: TUI, theme: unknown, kb: unknown, done: (r: T) => void) =>
			originalFactory(tui, theme, kb, (r: T) => {
				doneSpy(r);
				done(r);
			})) as typeof record.factory;
	}
	void promise;
	return { customCalls };
}

test("showTaskConfirmation enters the alternate screen and exits before done", () => {
	const mock = createAltMockTUI();
	const results: string[] = [];
	const { customCalls } = runDialog<{ decision: string }>(
		(ctx) => showTaskConfirmation(ctx as never, "proposed tasks\n- t1: first\n- t2: second"),
		(r) => results.push(r.decision),
	);
	const record = customCalls[0];
	assert.ok(record, "custom() called (dialog path, hasUI=true)");
	const component = record.factory(mock.tui, createMockTheme(), undefined, () => {}) as Component;

	assert.equal(mock.enterCalls.length, 1, "enterAlternateScreen called on open");
	assert.equal(mock.enterCalls[0], component, "the returned component is entered");

	(component as any).handleInput("\r"); // enter → confirm
	assert.equal(mock.exitCalls, 1, "exitAlternateScreen called on close");
	assert.deepEqual(mock.callOrder, ["enter", "exit"], "exit happens after enter, before done");
	assert.deepEqual(results, ["confirm"], "done resolved after exit");
});

test("showEscapeDialog enters the alternate screen and exits before done", () => {
	const mock = createAltMockTUI();
	const results: string[] = [];
	const { customCalls } = runDialog<string>(
		(ctx) => showEscapeDialog(ctx as never, "A long objective for the escape dialog"),
		(r) => results.push(r),
	);
	const record = customCalls[0];
	assert.ok(record, "custom() called (dialog path, hasUI=true)");
	const component = record.factory(mock.tui, createMockTheme(), undefined, () => {}) as Component;

	assert.equal(mock.enterCalls.length, 1, "enterAlternateScreen called on open");
	(component as any).handleInput("\x1b"); // escape → continue working
	assert.equal(mock.exitCalls, 1, "exitAlternateScreen called on close");
	assert.deepEqual(mock.callOrder, ["enter", "exit"], "exit happens before done");
	assert.deepEqual(results, ["continue_working"], "done resolved after exit");
});

test("showTaskConfirmation falls back to the default dialog without alt-screen support", async () => {
	const tui = {
		getShowHardwareCursor: () => false,
		setShowHardwareCursor: (_enabled: boolean) => {},
		requestRender: () => {},
		render: () => [] as string[],
		invalidate: () => {},
	} as unknown as TUI;
	const { ui, customCalls } = createMockUIContext();
	const ctx = { ui, hasUI: true };
	const promise = showTaskConfirmation(ctx as never, "tasks");
	const record = customCalls[0];
	assert.ok(record, "custom() called");
	const component = record.factory(tui, createMockTheme(), undefined, () => {}) as Component;
	assert.ok(component.render(80).length > 0, "renders in the fallback path");
	(component as any).handleInput("\r");
	void promise;
});
