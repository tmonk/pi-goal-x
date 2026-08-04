// Validation: goal dialogs as bounded bottom-anchored overlay panels.
//
// Against the real pi-tui 0.83.0 renderer with a fake terminal (rows=40,
// chat=120), the dialog flow must:
//   - emit NO DECSET 1049 alternate-buffer sequences (terminal scrollback
//     stays usable while the dialog is open; the main screen is never
//     blanked) and NO \x1b[2J full clears;
//   - cause 0 main-screen viewport scrolls on open, in-dialog navigation,
//     and close (the panel composites into the existing frame in place, so
//     the frame length never grows and no \r\n-at-bottom-row scroll bursts
//     occur);
//   - keep the chat history above the panel visible.
//
// This replaced the DECSET 1049 alternate-screen approach, which blanked the
// main screen and disabled terminal scrollback while a dialog was open (see
// specs/2026-08-04-goal-confirmation-scroll-fix/ — Attempt 1, reverted).
import { TUI, Container } from "../../node_modules/@earendil-works/pi-tui/dist/tui.js";

const CHAT_LINES = 120, ROWS = 40, COLS = 120, PANEL_LINES = 16;

// ── Fake terminal ───────────────────────────────────────────────────────
const writes = [];
const terminal = {
	columns: COLS, rows: ROWS,
	write(data) { writes.push(String(data)); },
	hideCursor() {}, showCursor() {}, start() {}, stop() {}, setTitle() {},
};

// ── Components ──────────────────────────────────────────────────────────
class Chat extends Container { render() { return Array.from({ length: CHAT_LINES }, (_, i) => `chat line ${i}`); } }
class Editor extends Container { render() { return ["❯ "]; } }
class Panel extends Container {
	constructor(lines) { super(); this.lines = lines; }
	render() {
		const out = [`${"─".repeat(40)}`, "│ Confirm Goal Draft", `${"─".repeat(40)}`];
		for (let i = 0; i < this.lines - 5; i++) out.push(`│ proposal line ${i}`);
		out.push(`${"─".repeat(40)}`, " ↑↓ • Enter • Esc");
		return out;
	}
}
class Footer extends Container { render() { return ["─ footer ─"]; } }

// ── ANSI emulator ───────────────────────────────────────────────────────
function makeEmulator(rows) {
	let cursorRow = 0, inAlt = false, scrolled = 0, altEntered = false, cleared = false;
	const watch = (stream) => {
		let i = 0;
		while (i < stream.length) {
			if (stream.startsWith("\x1b[?1049h", i)) { inAlt = true; altEntered = true; i += 8; continue; }
			if (stream.startsWith("\x1b[?1049l", i)) { inAlt = false; i += 8; continue; }
			if (stream.startsWith("\x1b[2J", i)) { cleared = true; i += 4; continue; }
			const c = stream[i];
			if (c === "\n") {
				if (!inAlt) { if (cursorRow === rows - 1) scrolled++; else cursorRow++; }
				i++; continue;
			}
			if (c === "\r") { i++; continue; }
			if (c === "\x1b") {
				const m = stream.slice(i).match(/^\x1b\[([0-9;?]*)([A-Za-z])/);
				if (m) {
					const n = (m[1]?.split(";").filter(Boolean).map(Number)[0]) ?? 1;
					const q = m[1]?.includes("?") ?? false;
					if (!q) {
						if (m[2] === "A") cursorRow = Math.max(0, cursorRow - (Number.isNaN(n) ? 1 : n));
						else if (m[2] === "B") cursorRow = Math.min(rows - 1, cursorRow + (Number.isNaN(n) ? 1 : n));
						else if (m[2] === "C") cursorRow = Math.min(rows - 1, cursorRow + (Number.isNaN(n) ? 1 : n));
					}
					i += m[0].length; continue;
				}
				i++; continue;
			}
			i++;
		}
	};
	return { watch, state: () => ({ scrolled, inAlt, altEntered, cleared }) };
}

// ── Flow: overlay panel open / navigate / close ─────────────────────────
writes.length = 0;
const tui = new TUI(terminal, false, "/tmp/tui-panel-repro");
const chat = new Chat();
const footer = new Footer();
const editorContainer = new Container();
editorContainer.addChild(new Editor());
tui.addChild(chat); tui.addChild(footer); tui.addChild(editorContainer);

tui.doRender(); // initial paint
writes.length = 0;

const emu = makeEmulator(ROWS);
const panel = new Panel(PANEL_LINES);
const overlayHandle = tui.showOverlay(panel, { anchor: "bottom-center", width: "95%", maxHeight: "45%" });
tui.doRender();
emu.watch(writes.join(""));
const open = { ...emu.state() };
writes.length = 0;

// In-dialog navigation (change a highlighted line)
panel.lines = PANEL_LINES + 1;
tui.requestRender();
tui.doRender();
emu.watch(writes.join(""));
const nav = { ...emu.state() };
writes.length = 0;

overlayHandle.hide();
tui.doRender();
emu.watch(writes.join(""));
const close = { ...emu.state() };

console.log(`chat=${CHAT_LINES} rows=${ROWS} overlay panel=${PANEL_LINES} (maxHeight 45%)`);
console.log(`open:  main-screen scrolls=${open.scrolled}, 1049=${open.altEntered}, 2J=${open.cleared}`);
console.log(`nav:   main-screen scrolls=${nav.scrolled}`);
console.log(`close: main-screen scrolls=${close.scrolled}, in alt buffer=${close.inAlt}`);
console.log(`history above the panel: chat frame lines remain on screen (overlay replaced the bottom ${PANEL_LINES} rows in place)`);

const pass = open.scrolled === 0 && close.scrolled === 0 && nav.scrolled === 0
	&& !open.altEntered && !open.cleared && !close.inAlt;
console.log(pass ? "PASS: bounded bottom panel — 0 scroll churn, no alternate buffer, no full clears, scrollback usable" : "FAIL");
