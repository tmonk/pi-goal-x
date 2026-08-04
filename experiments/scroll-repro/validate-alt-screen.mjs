// Validation: with installTuiAltScreenSupport applied and the dialog running
// in the alternate screen, opening/closing the dialog must cause ZERO
// viewport scrolls on the MAIN screen (vs. ~32-120 with the old editor swap).
//
// The emulator tracks smcup/rmcup: writes between them land in the alternate
// buffer (isolated from the main screen, no scrollback there), so only writes
// before smcup and after rmcup count toward main-screen scrolling.
import { TUI, Container } from "../../node_modules/@earendil-works/pi-tui/dist/tui.js";
import { installTuiAltScreenSupport } from "../../extensions/tui-alt-screen.ts";

const CHAT_LINES = 120, DIALOG_LINES = 80, ROWS = 40, COLS = 120;
const writes = [];
const terminal = {
	columns: COLS, rows: ROWS,
	write(data) { writes.push(String(data)); },
	hideCursor() {}, showCursor() {}, start() {}, stop() {}, setTitle() {},
};

class Chat extends Container { render() { return Array.from({ length: CHAT_LINES }, (_, i) => `chat line ${i}`); } }
class Editor extends Container { render() { return ["❯ "]; } }
class Dialog extends Container {
	constructor(lines) { super(); this.lines = lines; }
	render() {
		const out = ["┌─ Confirm Goal Draft ──┐"];
		for (let i = 0; i < this.lines - 4; i++) out.push(`│ proposal line ${i}`);
		out.push("└───────────────────────┘", " ↑↓ • Enter • Esc");
		return out;
	}
}

// Count viewport scrolls (\n while the cursor is on the bottom row), skipping
// segments that land in the alternate buffer (between smcup and rmcup).
function mainScreenScrolls(stream, rows, startRow) {
	let cursorRow = startRow, scrolled = 0, i = 0, inAlt = false;
	while (i < stream.length) {
		if (stream.startsWith("\x1b[?1049h", i)) { inAlt = true; i += 8; continue; }
		if (stream.startsWith("\x1b[?1049l", i)) { inAlt = false; i += 8; continue; }
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
				if (m[2] === "A") cursorRow = Math.max(0, cursorRow - (Number.isNaN(n) ? 1 : n));
				else if (m[2] === "B") cursorRow = Math.min(rows - 1, cursorRow + (Number.isNaN(n) ? 1 : n));
				i += m[0].length; continue;
			}
			const st = stream.indexOf("\x07", i);
			if (st !== -1 && stream.slice(i, i + 2) !== "\x1b[") { i = st + 1; continue; }
			i++; continue;
		}
		i++;
	}
	return scrolled;
}

installTuiAltScreenSupport();
const tui = new TUI(terminal, false, "/tmp/tui-repro");
const chat = new Chat();
const footer = new Container(); footer.render = () => ["─ footer ─"];
const editorContainer = new Container();
editorContainer.addChild(new Editor());
tui.addChild(chat); tui.addChild(footer); tui.addChild(editorContainer);
const startRow = () => tui.hardwareCursorRow - tui.previousViewportTop;

tui.doRender(); // initial paint
writes.length = 0;

// Dialog open via the alt screen (mirrors the extension's factory flow)
tui.enterAlternateScreen(new Dialog(DIALOG_LINES));
tui.doRender();
const openScrolls = mainScreenScrolls(writes.join(""), ROWS, startRow());
writes.length = 0;

// Dialog close: exit first, then pi's identity re-render
tui.exitAlternateScreen();
writes.length = 0;
tui.doRender();
const closeBytes = writes.join("");
const closeScrolls = mainScreenScrolls(closeBytes, ROWS, startRow());

console.log(`chat=${CHAT_LINES} dialog=${DIALOG_LINES} rows=${ROWS}`);
console.log(`alt-screen OPEN main-screen scrolls: ${openScrolls}   (was 78 with the editor swap)`);
console.log(`alt-screen CLOSE main-screen scrolls: ${closeScrolls}, post-close bytes: ${closeBytes.length} (was 121 with the editor swap)`);
console.log(openScrolls === 0 && closeScrolls === 0 && closeBytes.length === 0 ? "PASS: dialog is fully isolated from the main screen" : "FAIL");
