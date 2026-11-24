/**
 * Height rules for the above-editor widget. The widget must never fill the
 * terminal, and its height must not wobble from frame to frame, or pi-tui
 * scrolls the terminal to the bottom (or wipes the scrollback on a shrink).
 */

import type { Component, TUI } from "@earendil-works/pi-tui";

/**
 * Minimum rows reserved below/around the widget so pi's frame stays usable
 * when the widget is at its cap: status line (1) + editor minimum (3) +
 * footer (1) + a chat row (1). With the widget capped at
 * `terminalRows - WIDGET_HEIGHT_RESERVE`, the widget never fills the terminal:
 * the chat row stays in the frame, the widget's top lines stay within the
 * viewport (no pi-tui full-render scrollback wipe), and the editor/footer
 * stay visible. Kept at the minimum that still guarantees the chat row: a
 * larger reserve would slice dashboards that genuinely fit (e.g. the expanded
 * 24-line dashboard on a 30-row terminal renders unchanged at 24 + 5 chrome +
 * 1 chat = 30).
 */
export const WIDGET_HEIGHT_RESERVE = 6;

/**
 * Deterministic height guard: cap rendered lines to the terminal height minus
 * the reserved chrome. Head slice, because the dashboard's content priority
 * is top-down (identity, status, progress, tasks, details, hints). Pure index
 * function, no-op (unbounded) when terminalRows is missing (mock TUI,
 * headless contexts, /goal-status text).
 *
 * This is the terminal bound for direct callers. The live component also
 * applies the stable-height bound, see applyStableHeightBound.
 */
export function boundWidgetRenderLines(lines: string[], terminalRows: number | undefined): string[] {
	if (!terminalRows || terminalRows <= 0) return lines;
	const cap = Math.max(1, terminalRows - WIDGET_HEIGHT_RESERVE);
	if (lines.length <= cap) return lines;
	return lines.slice(0, cap);
}

/** The latch that applyStableHeightBound keeps between renders. */
export interface StableHeightState {
	stickyCap: number | undefined;
	stickyRegime: string | undefined;
	stickyTerminalRows: number | undefined;
	stickyReserve?: number;
}

export function newStableHeightState(): StableHeightState {
	return { stickyCap: undefined, stickyRegime: undefined, stickyTerminalRows: undefined, stickyReserve: undefined };
}

/**
 * Stable rendered height per regime.
 *
 * The widget's natural height varies with goal state (activity feed growth,
 * contract and evidence wrapping, budget, task growth). Every change would
 * alter the dock height, so the terminal would scroll to the bottom and the
 * user could not hold a scroll position to read the chat. The latch makes the
 * rendered height invariant to goal-state changes:
 *
 * - the first render of each regime commits the rendered height
 *   (min(natural, cap)) and every later render of that regime renders exactly
 *   that many lines: growth is head-sliced, shrink is blank-padded;
 * - resizing the terminal clears the latch and re-evaluates;
 * - a regime change (goal id/status, widget state kind, compact or expanded,
 *   tasks disabled, first task appearing) clears the latch so the new mode
 *   starts from its own natural height.
 *
 * Pure given the latch state: no timers, no randomness.
 */
export function applyStableHeightBound(
	lines: string[],
	terminalRows: number | undefined,
	state: StableHeightState,
	regime: string,
	reserve: number = WIDGET_HEIGHT_RESERVE,
): string[] {
	if (!terminalRows || terminalRows <= 0) return lines;
	const cap = Math.max(1, terminalRows - reserve);
	if (state.stickyTerminalRows !== terminalRows) {
		// Terminal resized: adapt to the new height (grow/shrink to fit).
		state.stickyCap = undefined;
		state.stickyTerminalRows = terminalRows;
	}
	if (state.stickyReserve !== reserve) {
		// The chrome below the widget changed (editor grew/shrunk, status,
		// footer, pending): re-evaluate so the widget's block plus the chrome
		// never exceeds the terminal. Otherwise the chat's appended lines and
		// the status line land above pi-tui's viewport top and every agent
		// write triggers a 2J+3J scrollback wipe.
		state.stickyCap = undefined;
		state.stickyReserve = reserve;
	}
	if (state.stickyRegime !== regime) {
		// Mode/state changed: the latch belongs to one regime.
		state.stickyCap = undefined;
		state.stickyRegime = regime;
	}
	if (state.stickyCap === undefined) {
		// First render of the regime: latch the natural height when it fits,
		// else the cap. Constant from here on.
		state.stickyCap = Math.min(lines.length, cap);
	}
	if (lines.length > state.stickyCap) {
		// Growth past the committed height: head-slice, so the buffer line
		// count never changes.
		return lines.slice(0, state.stickyCap);
	}
	if (lines.length < state.stickyCap) {
		// Natural dipped below the committed height: pad with blank rows after
		// the box footer, so the buffer line count never changes.
		const padded = lines.slice();
		while (padded.length < state.stickyCap) padded.push("");
		return padded;
	}
	return lines;
}

type DockChild = { children?: DockChild[]; render?: (w: number) => string[] };

/**
 * Measure the rendered height of the dock chrome around the widget (pending +
 * status + editor + widgetBelow + footer) at `width`, so the widget can size
 * itself so its block plus the chrome never exceeds the terminal: pi-tui
 * full-renders (2J+3J, scrollback wipe) whenever the first changed line is
 * above its tracked viewport top. Returns undefined (the caller falls back to
 * WIDGET_HEIGHT_RESERVE) when the TUI exposes no measurable dock (mock TUIs,
 * headless) or a sibling fails to render.
 */
export function measureDockReserve(tuiLike: TUI, self: Component, width: number): number | undefined {
	const top = (tuiLike as unknown as { children?: DockChild[] }).children;
	if (!Array.isArray(top) || top.length < 2) return undefined;
	// Locate the dock list and the widget's own container:
	// regular mode: top-level [document, pending, status, widgetAbove, editor,
	//   widgetBelow, footer] with the widget directly inside widgetContainerAbove;
	// fullscreen mode: top-level [transcript, dock] with the widget inside
	//   widgetContainerAbove inside the dock VStack.
	const selfNode = self as unknown as DockChild;
	let dockList: DockChild[] | undefined;
	let widgetContainer: DockChild | undefined;
	for (const c of top) {
		const kids = Array.isArray(c.children) ? c.children : undefined;
		if (kids?.includes(selfNode)) {
			dockList = top;
			widgetContainer = c;
			break;
		}
		const nested = kids?.find((cc) => Array.isArray(cc.children) && cc.children.includes(selfNode));
		if (nested) {
			dockList = kids!;
			widgetContainer = nested;
			break;
		}
	}
	if (!dockList || !widgetContainer) return undefined;
	let total = 0;
	for (let i = 0; i < dockList.length; i++) {
		const c = dockList[i]!;
		// Skip the document container / transcript (its height cancels out of
		// the viewport math: it sits above both the chat's append point and the
		// viewport top) and the widget's own container.
		if (dockList === top && i === 0) continue;
		if (c === widgetContainer) continue;
		if (typeof c?.render !== "function") continue;
		try {
			const lines = c.render(width);
			if (Array.isArray(lines)) total += lines.length;
		} catch {
			// A sibling render failure must never break the widget.
			return undefined;
		}
	}
	// +1 slack so the strictest safety condition (chat append point below the
	// viewport top) holds even at the boundary.
	return total + 1;
}
