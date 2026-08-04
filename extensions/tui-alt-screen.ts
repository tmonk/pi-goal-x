/**
 * Alternate-screen modal support for the pi TUI (DECSET 1049).
 *
 * Problem: goal confirmation/questionnaire dialogs are opened via
 * `ctx.ui.custom()` without an overlay, so pi replaces the editor inside the
 * main TUI buffer with a tall dialog. The differential renderer then writes
 * the appended region at the terminal's bottom row, scrolling the viewport
 * (measured at up to ~120 scrolls for a long proposal) and yanking a user who
 * is reading scrollback out of their position.
 *
 * Fix: render the dialog in the terminal's ALTERNATE screen buffer. Entering
 * it (`\x1b[?1049h`) saves the main screen (content + scrollback view)
 * untouched; all dialog rendering is isolated in the alternate buffer; exiting
 * (`\x1b[?1049l`) restores the main screen exactly, preserving the user's
 * reading position "as if the dialog never ran".
 *
 * This module augments the pi TUI class at extension load time (idempotent,
 * feature-detected) so the extension works against unpatched pi installs and
 * serves as the reference implementation for an upstream pi-tui addition. It
 * is deliberately inert unless a caller invokes `enterAlternateScreen()` —
 * pi's own dialogs and rendering are untouched.
 */
import { TUI, type Component } from "@earendil-works/pi-tui";

const ALT_SCREEN_ENTER = "\x1b[?1049h";
const ALT_SCREEN_EXIT = "\x1b[?1049l";

/** Symbol-keyed per-instance state so we never collide with pi-tui fields. */
const ALT_STATE = Symbol("pi-goal-alt-screen-state");

interface AltScreenState {
	previousLines: string[];
	previousKittyImageIds: Set<number>;
	previousWidth: number;
	previousHeight: number;
	cursorRow: number;
	hardwareCursorRow: number;
	maxLinesRendered: number;
	previousViewportTop: number;
}

interface AltScreenInstanceState {
	active: boolean;
	component: Component | null;
	saved: AltScreenState | null;
}

/** The alt-screen surface callers rely on (present on the real TUI after install). */
export interface AltScreenTUI {
	enterAlternateScreen(component: Component): void;
	exitAlternateScreen(): void;
	isAlternateScreenActive(): boolean;
	readonly terminal: { rows: number };
}

/** Type guard: the TUI supports alternate-screen modals (installed or native). */
export function supportsAltScreen(tui: TUI): tui is TUI & AltScreenTUI {
	return typeof (tui as unknown as AltScreenTUI).enterAlternateScreen === "function";
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyTui = any;

function stateOf(tui: AnyTui): AltScreenInstanceState {
	if (!tui[ALT_STATE]) tui[ALT_STATE] = { active: false, component: null, saved: null };
	return tui[ALT_STATE] as AltScreenInstanceState;
}

/**
 * Install alternate-screen support on the pi TUI prototype. Idempotent and
 * safe to call from extension load; skipped when the running pi-tui already
 * provides the methods natively.
 */
export function installTuiAltScreenSupport(): void {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const proto = (TUI.prototype as any) as AnyTui;
	if (typeof proto.enterAlternateScreen === "function") return;

	const originalRender = proto.render;
	const originalInvalidate = proto.invalidate;

	proto.render = function render(width: number): string[] {
		const st = stateOf(this);
		if (st.active && st.component) return st.component.render(width);
		return originalRender.call(this, width);
	};

	proto.invalidate = function invalidate(): void {
		const st = stateOf(this);
		if (st.active && st.component) {
			st.component.invalidate?.();
			return;
		}
		return originalInvalidate.call(this);
	};

	proto.enterAlternateScreen = function enterAlternateScreen(component: Component): void {
		const st = stateOf(this);
		if (st.active) return; // re-entrancy guard
		this.terminal.write(ALT_SCREEN_ENTER);
		st.saved = {
			previousLines: this.previousLines,
			previousKittyImageIds: this.previousKittyImageIds,
			previousWidth: this.previousWidth,
			previousHeight: this.previousHeight,
			cursorRow: this.cursorRow,
			hardwareCursorRow: this.hardwareCursorRow,
			maxLinesRendered: this.maxLinesRendered,
			previousViewportTop: this.previousViewportTop,
		};
		// Reset the differential state so the first render fully paints the
		// (clean) alternate buffer.
		this.previousLines = [];
		this.previousKittyImageIds = new Set();
		this.previousWidth = 0;
		this.previousHeight = 0;
		this.cursorRow = 0;
		this.hardwareCursorRow = 0;
		this.maxLinesRendered = 0;
		this.previousViewportTop = 0;
		if (this.renderTimer) {
			clearTimeout(this.renderTimer);
			this.renderTimer = undefined;
		}
		this.renderRequested = false;
		st.active = true;
		st.component = component;
		this.requestRender();
	};

	proto.exitAlternateScreen = function exitAlternateScreen(): void {
		const st = stateOf(this);
		if (!st.active) return;
		this.terminal.write(ALT_SCREEN_EXIT); // terminal repaints the saved main screen
		const saved = st.saved;
		if (saved) {
			this.previousLines = saved.previousLines;
			this.previousKittyImageIds = saved.previousKittyImageIds;
			this.previousWidth = saved.previousWidth;
			this.previousHeight = saved.previousHeight;
			this.cursorRow = saved.cursorRow;
			this.hardwareCursorRow = saved.hardwareCursorRow;
			this.maxLinesRendered = saved.maxLinesRendered;
			this.previousViewportTop = saved.previousViewportTop;
		}
		if (this.renderTimer) {
			clearTimeout(this.renderTimer);
			this.renderTimer = undefined;
		}
		this.renderRequested = false;
		st.active = false;
		st.component = null;
		st.saved = null;
		// The main screen was restored byte-for-byte by the terminal. The very
		// next render pi triggers after closing the dialog is an identity diff
		// against the restored content; suppress its cosmetic cursor-positioning
		// write so NO bytes reach the main screen after the dialog closes (any
		// write would yank a user who is reading scrollback out of their
		// position). The flag is cleared after the first suppressed call.
		this.__suppressCursorWrite = true;
	};

	proto.isAlternateScreenActive = function isAlternateScreenActive(): boolean {
		return stateOf(this).active;
	};

	// Suppress the cosmetic hardware-cursor write of the identity re-render
	// that immediately follows exitAlternateScreen (see above).
	const originalPositionHardwareCursor = proto.positionHardwareCursor;
	proto.positionHardwareCursor = function positionHardwareCursor(
		cursorPos: { row: number; col: number } | null,
		totalLines: number,
	): void {
		if (this.__suppressCursorWrite) {
			this.__suppressCursorWrite = false;
			if (!cursorPos || totalLines <= 0) {
				this.terminal.hideCursor();
				return;
			}
			const targetRow = Math.max(0, Math.min(cursorPos.row, totalLines - 1));
			const targetCol = Math.max(0, cursorPos.col);
			const rowDelta = targetRow - this.hardwareCursorRow;
			this.hardwareCursorRow = rowDelta === 0 ? this.hardwareCursorRow : targetRow;
			// Skip writing the cursor-positioning escape sequence entirely; the
			// terminal already restored the correct cursor with the main screen.
			return;
		}
		return originalPositionHardwareCursor.call(this, cursorPos, totalLines);
	};
}
