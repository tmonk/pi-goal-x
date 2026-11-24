/**
 * Test utilities for mocking the TUI rendering path.
 *
 * Provides mock implementations of TUI, Theme, and ExtensionContext
 * so that widget components can be tested without a real terminal.
 */
import type { Theme, ExtensionContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { Component, TUI, KeybindingsManager } from "@earendil-works/pi-tui";

// ── Mock Theme ─────────────────────────────────────────────────────────

export function createMockTheme(): Theme {
	return {
		fg: (_color: string, value: string) => value,
		bold: (value: string) => value,
		bg: () => "",
		dim: (value: string) => value,
	} as unknown as Theme;
}

// ── Mock TUI builder ────────────────────────────────────────────────────

export interface MockTUIState {
	getShowHardwareCursor: boolean;
	setShowHardwareCursorCalls: boolean[];
	requestRenderCalls: number;
}

export function createMockTUI(options: { terminalRows?: number } = {}): { tui: TUI; state: MockTUIState } {
	const state: MockTUIState = {
		getShowHardwareCursor: false,
		setShowHardwareCursorCalls: [],
		requestRenderCalls: 0,
	};

	const tui = {
		getShowHardwareCursor: () => state.getShowHardwareCursor,
		setShowHardwareCursor: (enabled: boolean) => {
			state.setShowHardwareCursorCalls.push(enabled);
		},
		requestRender: () => {
			state.requestRenderCalls++;
		},
		render: (_width: number) => [] as string[],
		invalidate: () => {},
		// Real pi TUIs expose `terminal.rows`; the widget's terminal-height
		// bound (spec 2026-08-10) reads it at render time. Absent by default so
		// existing tests keep rendering unbounded; pass `terminalRows` to
		// exercise the bound.
		...(options.terminalRows !== undefined ? { terminal: { rows: options.terminalRows } } : {}),
	} as unknown as TUI;

	return { tui, state };
}

// ── Mock ctx.ui.custom() ────────────────────────────────────────────────

export type CustomFactory = (tui: TUI, theme: Theme, keybindings: unknown, done: (result: any) => void) => Component | Promise<Component>;

export interface CustomCallRecord {
	factory: CustomFactory;
	options: unknown;
}

/**
 * Create a mock ExtensionUIContext that records calls to `custom()`.
 * The `done` callback from each `custom()` call is captured so tests
 * can trigger completion and inspect the result.
 */
export function createMockUIContext(): {
	ui: ExtensionUIContext;
	customCalls: CustomCallRecord[];
} {
	const customCalls: CustomCallRecord[] = [];

	const ui = {
		custom: <T>(
			factory: (
				tui: TUI,
				theme: Theme,
				keybindings: unknown,
				done: (result: T) => void,
			) => Component | Promise<Component>,
			options?: unknown,
		): Promise<T> => {
			const record: CustomCallRecord = { factory: factory as CustomFactory, options };
			customCalls.push(record);

			return new Promise<T>((resolve) => {
				// The promise resolves when the test calls done
			});
		},
		select: async () => undefined,
		confirm: async () => true,
		input: async () => undefined,
		notify: () => {},
		onTerminalInput: () => () => {},
		setStatus: () => {},
		setWorkingMessage: () => {},
		setWorkingVisible: () => {},
		setWorkingIndicator: () => {},
		setHiddenThinkingLabel: () => {},
		setWidget: () => {},
		setFooter: () => {},
		setHeader: () => {},
		setTitle: () => {},
		pasteToEditor: () => {},
		setEditorText: () => {},
		getEditorText: () => "",
		editor: async () => undefined,
		addAutocompleteProvider: () => {},
		theme: createMockTheme(),
		getAllThemes: () => [],
		getTheme: () => undefined,
		setTheme: () => ({ success: true }),
		getToolsExpanded: () => false,
		setToolsExpanded: () => {},
		setEditorComponent: () => {},
		getEditorComponent: () => undefined,
	} as unknown as ExtensionUIContext;

	return { ui, customCalls };
}

export interface MockExtensionContext extends ExtensionContext {
	_customCalls: CustomCallRecord[];
}

/**
 * Create a mock ExtensionContext configured for TUI rendering (hasUI = true).
 * The returned context has a `_customCalls` array recording every `custom()` call.
 */
export function createMockExtensionContext(): MockExtensionContext {
	const { ui, customCalls } = createMockUIContext();

	const ctx = {
		ui,
		hasUI: true,
		cwd: "/test",
		sessionManager: {} as any,
		modelRegistry: {} as any,
		model: undefined,
		isIdle: () => true,
		signal: undefined,
		abort: () => {},
		hasPendingMessages: () => false,
		shutdown: () => {},
		getContextUsage: () => undefined,
		compact: () => {},
		getSystemPrompt: () => "",
		_customCalls: customCalls,
	} as unknown as MockExtensionContext;

	return ctx;
}

// ── Invoke a captured factory ───────────────────────────────────────────

/**
 * Given a mock UI context that has captured a `custom()` call,
 * invoke the factory with mock TUI/Theme and return the created component.
 */
export function invokeCustomFactory(
	customCalls: CustomCallRecord[],
	index = 0,
): {
	component: Component;
	tui: TUI;
	theme: Theme;
} {
	const record = customCalls[index];
	if (!record) {
		throw new Error(`No custom() call at index ${index}`);
	}

	const { tui } = createMockTUI();
	const theme = createMockTheme();
	const _keybindings = {} as unknown as KeybindingsManager;

	const component = record.factory(
		tui,
		theme,
		_keybindings,
		() => {},
	);

	return {
		component: component as Component,
		tui,
		theme,
	};
}

/**
 * Convenience: renders a component at a given width and returns the lines.
 */
export function renderComponent(component: Component, width = 100): string[] {
	return component.render(width);
}
