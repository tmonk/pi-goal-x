/**
 * Regression tests for the alternate-screen modal support
 * (extensions/tui-alt-screen.ts) against the real pi-tui TUI.
 *
 * Contract under test: opening a goal confirmation dialog must not write to
 * the main terminal screen. The dialog renders in the alternate screen
 * buffer (DECSET 1049); on close the terminal restores the main screen
 * byte-for-byte, so a user reading scrollback keeps their position. The
 * identity re-render pi triggers after close must write NOTHING (even the
 * cosmetic cursor-positioning write would yank a scrolled-up user).
 */
import assert from "node:assert/strict";
import test from "node:test";

import { Container, TUI } from "@earendil-works/pi-tui";

import { installTuiAltScreenSupport, supportsAltScreen } from "../extensions/tui-alt-screen.ts";

interface FakeTerminal {
	columns: number;
	rows: number;
	writes: string[];
	write(data: string): void;
	hideCursor(): void;
	showCursor(): void;
	start(): void;
	stop(): void;
	setTitle(): void;
}

function createFakeTerminal(columns = 120, rows = 40): FakeTerminal {
	const writes: string[] = [];
	return {
		columns,
		rows,
		writes,
		write(data: string) {
			writes.push(String(data));
		},
		hideCursor() {},
		showCursor() {},
		start() {},
		stop() {},
		setTitle() {},
	};
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyTui = any;

class Chat extends Container {
	render() {
		return ["chat line 0", "chat line 1", "chat line 2"];
	}
}

class Editor extends Container {
	render() {
		return ["❯ "];
	}
}

class Modal extends Container {
	render() {
		return ["┌─ Confirm Goal Draft ──┐", "└───────────────────────┘"];
	}
}

function freshTui(rows = 40): { tui: AnyTui; terminal: FakeTerminal } {
	const terminal = createFakeTerminal(120, rows);
	const tui = new TUI(terminal, false, "/tmp/pi-goal-alt-screen-test") as AnyTui;
	const chat = new Chat();
	const footer = new Container();
	footer.render = () => ["─ footer ─"];
	const editorContainer = new Container();
	editorContainer.addChild(new Editor());
	tui.addChild(chat);
	tui.addChild(footer);
	tui.addChild(editorContainer);
	return { tui, terminal };
}

function tail(terminal: FakeTerminal): string {
	return terminal.writes.join("");
}

test("installTuiAltScreenSupport is idempotent and exposes the alt-screen surface", () => {
	installTuiAltScreenSupport();
	installTuiAltScreenSupport();
	const proto = TUI.prototype as unknown as Record<string, unknown>;
	assert.equal(typeof proto.enterAlternateScreen, "function");
	assert.equal(typeof proto.exitAlternateScreen, "function");
	assert.equal(typeof proto.isAlternateScreenActive, "function");
	assert.equal(typeof proto.positionHardwareCursor, "function", "cursor suppression wrapper installed");
});

test("enterAlternateScreen emits smcup, isolates render, and resets buffer state", () => {
	const { tui, terminal } = freshTui();
	tui.doRender(); // initial paint of the main screen
	terminal.writes.length = 0;

	const modal = new Modal();
	assert.equal(tui.isAlternateScreenActive(), false);
	tui.enterAlternateScreen(modal);

	assert.ok(tail(terminal).includes("\x1b[?1049h"), "smcup written on enter");
	assert.equal(tui.isAlternateScreenActive(), true);

	// render() must produce ONLY the modal while active (chat/footer/editor hidden)
	const lines = tui.render(120);
	assert.deepEqual(lines, ["┌─ Confirm Goal Draft ──┐", "└───────────────────────┘"]);

	// The dialog paints the clean alternate buffer without clearing the main screen
	terminal.writes.length = 0;
	tui.doRender();
	const painted = tail(terminal);
	assert.ok(painted.length > 0, "dialog content painted");
	assert.ok(!painted.includes("\x1b[2J") && !painted.includes("\x1b[3J"), "no screen/scrollback clears during dialog");
	assert.ok(!painted.includes("chat line"), "chat content never rendered into the alt screen");
});

test("exitAlternateScreen emits rmcup, restores state, and the follow-up render writes nothing", () => {
	const { tui, terminal } = freshTui();
	tui.doRender(); // initial paint
	terminal.writes.length = 0;

	tui.enterAlternateScreen(new Modal());
	terminal.writes.length = 0;
	tui.doRender(); // paint the dialog
	terminal.writes.length = 0;

	tui.exitAlternateScreen();
	assert.ok(tail(terminal).includes("\x1b[?1049l"), "rmcup written on exit");
	assert.equal(tui.isAlternateScreenActive(), false);
	terminal.writes.length = 0;

	// render() returns the children again (main-screen content restored)
	const lines = tui.render(120);
	assert.ok(lines.some((l: string) => l.includes("chat line 0")), "children restored in render");

	// The identity re-render after close must write ZERO bytes: the terminal
	// restored the main screen, and any write (even cursor positioning) would
	// yank a scrolled-up user out of scrollback.
	tui.doRender();
	const afterClose = tail(terminal);
	assert.equal(afterClose, "", "no bytes written by the post-close identity render");
});

test("enterAlternateScreen is re-entrancy guarded", () => {
	const { tui, terminal } = freshTui();
	tui.doRender();
	terminal.writes.length = 0;

	const first = new Modal();
	const second = new Modal();
	tui.enterAlternateScreen(first);
	tui.enterAlternateScreen(second);
	assert.equal(tui.isAlternateScreenActive(), true);
	assert.equal((tail(terminal).match(/\x1b\[\?1049h/g) ?? []).length, 1, "smcup emitted exactly once");

	tui.exitAlternateScreen();
	tui.exitAlternateScreen(); // second exit is a no-op
	assert.equal(tui.isAlternateScreenActive(), false);
	assert.equal((tail(terminal).match(/\x1b\[\?1049l/g) ?? []).length, 1, "rmcup emitted exactly once");
});

test("supportsAltScreen detects the installed surface", () => {
	installTuiAltScreenSupport();
	const { tui } = freshTui();
	assert.equal(supportsAltScreen(tui), true);
});
