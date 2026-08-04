// Headless reproduction of the TUI differential renderer around the
// goal confirmation dialog (non-overlay ctx.ui.custom replacing the editor).
//
// Correct scroll signal: the differential render writes lines from
// firstChanged..lastChanged at screen rows [firstChanged - viewportTop ..
// lastChanged - viewportTop]. If the LAST written line lands at/below the
// terminal's bottom row AND a trailing feed pushes past it, the terminal
// scrolls (viewport yanks). A trailing "\r\n" before each subsequent line
// scrolls whenever the cursor is on the bottom row. We approximate the real
// effect by tracking the cursor's screen row after the write: if the write
// region extends past the screen bottom, the terminal MUST have scrolled.
//
// Usage: node repro-dialog-render.mjs [chatLines] [dialogLines] [rows]

import { TUI, Container } from "../../node_modules/@earendil-works/pi-tui/dist/tui.js";

const CHAT_LINES = Number(process.argv[2] ?? 60);
const DIALOG_LINES = Number(process.argv[3] ?? 34);
const ROWS = Number(process.argv[4] ?? 40);
const COLS = 120;

const writes = [];
const terminal = {
	columns: COLS, rows: ROWS,
	write(data) { writes.push(String(data)); },
	hideCursor() {}, showCursor() {}, start() {}, stop() {}, setTitle() {},
};

class Chat extends Container {
	render() { return Array.from({ length: CHAT_LINES }, (_, i) => `chat line ${i}`); }
}
class Editor extends Container {
	render() { return ["❯ "]; }
}
class Dialog extends Container {
	constructor(lines) { super(); this.lines = lines; }
	render() {
		const out = ["┌─ Confirm Goal Draft ──┐"];
		for (let i = 0; i < this.lines - 4; i++) out.push(`│ proposal line ${i}`);
		out.push("└───────────────────────┘", " ↑↓ • Enter • Esc");
		return out;
	}
}

// True terminal emulation of the ANSI stream: track the cursor row and the
// terminal's scroll count. A feed (\n) while the cursor is on the bottom row
// scrolls the viewport by one. `startRow` is the cursor's screen row before
// the write begins (the renderer's model: hardwareCursorRow - viewportTop).
function emulateTerminal(stream, rows, startRow) {
	let cursorRow = startRow; // 0-indexed
	let scrolled = 0;
	let i = 0;
	const s = stream;
	while (i < s.length) {
		const c = s[i];
		if (c === "\r") { i++; continue; }
		if (c === "\n") {
			if (cursorRow === rows - 1) scrolled++;
			else cursorRow++;
			i++;
			continue;
		}
		if (c === "\x1b") {
			const m = s.slice(i).match(/^\x1b\[([0-9;?]*)([A-Za-z])/);
			if (m) {
				const params = m[1].split(";").filter(Boolean).map(Number);
				const n = params[0] ?? 1;
				switch (m[2]) {
					case "A": cursorRow = Math.max(0, cursorRow - (Number.isNaN(n) ? 1 : n)); break;
					case "B": cursorRow = Math.min(rows - 1, cursorRow + (Number.isNaN(n) ? 1 : n)); break;
					case "G": break; // column only
					case "K": case "J": case "H": break; // no row movement
					default: break;
				}
				i += m[0].length;
				continue;
			}
			// Skip other escapes (OSC etc.) up to BEL/ST
			const st = s.indexOf("\x07", i);
			if (st !== -1 && s.slice(i, i + 2) !== "\x1b[") { i = st + 1; continue; }
			i++;
			continue;
		}
		i++;
	}
	return scrolled;
}

function classify(buffer, label, rows, startRow) {
	const scrolled = emulateTerminal(buffer, rows, startRow);
	const hasFullClear = buffer.includes("\x1b[2J") || buffer.includes("\x1b[3J");
	console.log(`--- ${label} ---`);
	console.log(`  bytes: ${buffer.length}, terminal scrolls caused: ${scrolled}${hasFullClear ? ", FULL CLEAR (2J/3J)" : ""}${buffer.includes("\x1b[3J") ? " <-- SCROLLBACK ERASE" : ""}`);
	return { scrolled, hasFullClear };
}

// ── Scenario A: current behavior — non-overlay dialog replacing the editor ──
{
	const tui = new TUI(terminal, false, "/tmp/tui-repro");
	const chat = new Chat();
	const footer = new Container(); footer.render = () => ["─ footer ─"];
	const editorContainer = new Container();
	const editor = new Editor();
	const dialog = new Dialog(DIALOG_LINES);
	editorContainer.addChild(editor);
	tui.addChild(chat); tui.addChild(footer); tui.addChild(editorContainer);
	tui.doRender();
	writes.length = 0;
	// Starting cursor row on screen = (hardwareCursorRow - previousViewportTop)
	const startRowA = () => tui.hardwareCursorRow - tui.previousViewportTop;

	editorContainer.clear();
	editorContainer.addChild(dialog);
	const openStartA = startRowA();
	tui.doRender();
	const open = classify(writes.join(""), "A) CURRENT: DIALOG OPEN (editor swap)", ROWS, openStartA);
	writes.length = 0;

	editorContainer.clear();
	editorContainer.addChild(editor);
	const closeStartA = startRowA();
	tui.doRender();
	const close = classify(writes.join(""), "A) CURRENT: DIALOG CLOSE (restore editor)", ROWS, closeStartA);
	writes.length = 0;
	console.log(`  A) open scrolls: ${open.scrolled}, close scrolls: ${close.scrolled}\n`);
}

// ── Scenario B: overlay dialog (composited in place) ──
{
	const tui = new TUI(terminal, false, "/tmp/tui-repro");
	const chat = new Chat();
	const footer = new Container(); footer.render = () => ["─ footer ─"];
	const editorContainer = new Container();
	editorContainer.addChild(new Editor());
	tui.addChild(chat); tui.addChild(footer); tui.addChild(editorContainer);
	tui.doRender();
	writes.length = 0;
	const startRowB = () => tui.hardwareCursorRow - tui.previousViewportTop;

	const handle = tui.showOverlay(new Dialog(DIALOG_LINES), { anchor: "bottom-center", maxHeight: "80%", width: "60%" });
	const openStartB = startRowB();
	tui.doRender();
	const open = classify(writes.join(""), "B) OVERLAY: DIALOG OPEN", ROWS, openStartB);
	writes.length = 0;

	handle.hide();
	const closeStartB = startRowB();
	tui.doRender();
	const close = classify(writes.join(""), "B) OVERLAY: DIALOG CLOSE", ROWS, closeStartB);
	writes.length = 0;
	console.log(`  B) open scrolls: ${open.scrolled}, close scrolls: ${close.scrolled}\n`);
}
