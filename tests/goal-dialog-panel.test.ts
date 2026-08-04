/**
 * Bottom-panel overlay wiring tests for the task-list confirmation and the
 * audit escape dialog (extensions/goal-task-confirmation.ts and
 * extensions/widgets/goal-escape-dialog.ts).
 *
 * Both dialogs must open as bottom-anchored overlay panels in the MAIN
 * terminal screen (no alternate screen — terminal scrollback stays usable and
 * chat history stays visible above), bounded by a maxHeight, and resolve
 * through done. The hardware cursor suppression is restored on dispose.
 */
import assert from "node:assert/strict";
import test from "node:test";

import type { Component, TUI } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";

import { showTaskConfirmation } from "../extensions/goal-task-confirmation.ts";
import { showEscapeDialog } from "../extensions/widgets/goal-escape-dialog.ts";
import { createMockTheme, createMockUIContext } from "./tui-test-utils.ts";

interface PanelMock {
	requestRenderCalls: number;
	setShowHardwareCursorCalls: boolean[];
	tui: TUI;
}

function createPanelMockTUI(): PanelMock {
	const state: PanelMock = {
		requestRenderCalls: 0,
		setShowHardwareCursorCalls: [],
		tui: undefined as unknown as TUI,
	};
	const tui = {
		getShowHardwareCursor: () => false,
		setShowHardwareCursor: (enabled: boolean) => {
			state.setShowHardwareCursorCalls.push(enabled);
		},
		requestRender: () => {
			state.requestRenderCalls++;
		},
		terminal: { rows: 40 },
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
	const record = customCalls[0];
	if (record) {
		const originalFactory = record.factory;
		record.factory = ((tui: TUI, theme: Theme, kb: unknown, done: (r: T) => void) =>
			originalFactory(tui, theme, kb, (r: T) => {
				doneSpy(r);
				done(r);
			})) as typeof record.factory;
	}
	void promise;
	return { customCalls };
}

function overlayOptions(record: { options: unknown }): Record<string, unknown> {
	const opts = record.options as { overlay?: boolean; overlayOptions?: Record<string, unknown> };
	return (opts?.overlayOptions ?? {}) as Record<string, unknown>;
}

test("showTaskConfirmation opens as a bounded bottom-anchored overlay panel", () => {
	const mock = createPanelMockTUI();
	const results: string[] = [];
	const { customCalls } = runDialog<{ decision: string }>(
		(ctx) => showTaskConfirmation(ctx as never, "proposed tasks\n- t1: first\n- t2: second"),
		(r) => results.push(r.decision),
	);
	const record = customCalls[0];
	assert.ok(record, "custom() called (dialog path, hasUI=true)");
	const opts = record.options as { overlay?: boolean; overlayOptions?: Record<string, unknown> };
	assert.equal(opts.overlay, true, "overlay: true (main screen, not an alternate buffer)");
	assert.equal(opts.overlayOptions?.anchor, "bottom-center", "bottom-anchored");
	assert.equal(opts.overlayOptions?.maxHeight, "45%", "bounded");

	const component = record.factory(mock.tui, createMockTheme(), undefined, () => {}) as Component;
	const rendered = component.render(120) as string[];
	assert.ok(rendered.length <= 20, "rendered height is bounded");
	assert.ok(rendered.some((l) => l.includes("Task list confirmation")), "header rendered");

	(component as any).handleInput("\r"); // enter → confirm
	assert.deepEqual(results, ["confirm"], "done resolved with confirm");
});

test("showEscapeDialog opens as a bounded bottom-anchored overlay panel", () => {
	const mock = createPanelMockTUI();
	const results: string[] = [];
	const { customCalls } = runDialog<string>(
		(ctx) => showEscapeDialog(ctx as never, "A long objective for the escape dialog"),
		(r) => results.push(r),
	);
	const record = customCalls[0];
	assert.ok(record, "custom() called (dialog path, hasUI=true)");
	const opts = record.options as { overlay?: boolean; overlayOptions?: Record<string, unknown> };
	assert.equal(opts.overlay, true, "overlay: true");
	assert.equal(opts.overlayOptions?.anchor, "bottom-center", "bottom-anchored");
	assert.equal(opts.overlayOptions?.maxHeight, "45%", "bounded");

	const component = record.factory(mock.tui, createMockTheme(), undefined, () => {}) as Component;
	const rendered = component.render(120) as string[];
	assert.ok(rendered.length <= 20, "rendered height is bounded");
	assert.ok(rendered.some((l) => l.includes("Audit interrupted by Escape")), "header rendered");

	(component as any).handleInput("\x1b"); // escape → continue working
	assert.deepEqual(results, ["continue_working"], "done resolved with continue_working");
});

test("task confirmation and escape dialog restore the hardware cursor on dispose", () => {
	for (const [name, invoke] of [
		["task confirmation", (ctx: any, mock: PanelMock) => showTaskConfirmation(ctx, "tasks\n- t1: x")],
		["escape dialog", (ctx: any, mock: PanelMock) => showEscapeDialog(ctx, "objective")],
	] as Array<[string, (ctx: any, mock: PanelMock) => Promise<unknown>]>) {
		const mock = createPanelMockTUI();
		mock.tui = {
			getShowHardwareCursor: () => true, // cursor was shown before the dialog
			setShowHardwareCursor: (enabled: boolean) => {
				mock.setShowHardwareCursorCalls.push(enabled);
			},
			requestRender: () => {
				mock.requestRenderCalls++;
			},
			terminal: { rows: 40 },
		} as unknown as TUI;
		const { customCalls } = runDialog<unknown>(async (ctx) => invoke(ctx, mock), () => {});
		const record = customCalls[0];
		const component = record.factory(mock.tui, createMockTheme(), undefined, () => {}) as Component & { dispose?(): void };
		assert.equal(mock.setShowHardwareCursorCalls[0], false, `${name}: cursor suppressed on open`);
		component.dispose?.();
		assert.equal(mock.setShowHardwareCursorCalls.at(-1), true, `${name}: cursor restored on dispose`);
	}
});

test("showTaskConfirmation renders and submits in the default dialog path too", async () => {
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
	assert.ok(component.render(80).length > 0, "renders");
	(component as any).handleInput("\r");
	void promise;
	void overlayOptions;
});
