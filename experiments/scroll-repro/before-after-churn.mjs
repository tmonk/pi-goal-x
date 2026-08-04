// Headless before/after measurement for the goal questionnaire's viewport churn.
//
// Drives the REAL runGoalQuestionnaire through the REAL pi-tui differential
// renderer with a fake terminal, mirroring pi's showExtensionCustom (editor
// swap for non-overlay). For each scenario it reports:
//   - open / nav / close terminal scrolls (a \n feed on the bottom row scrolls)
//   - \x1b[2J / \x1b[3J emissions (screen clear / SCROLLBACK ERASE)
//   - post-close viewport position (window-at-bottom verdict: a 2J+3J full
//     render homes the cursor to row 0 and wipes scrollback, so the terminal
//     must re-scroll ~a screenful of new content before the window returns to
//     the bottom — the "~10s instead of 1s" scroll-back delay)
//   - scrollback content: full dialog in the main buffer, chat visible above
//
// Usage:
//   node before-after-churn.mjs                 # report mode (measures current behavior)
//   node before-after-churn.mjs 40              # report mode, rows=40
//   node before-after-churn.mjs --expect-fixed  # assertion mode: no 2J/3J, no yank, fits stays 0-churn
//
// Report mode exits 0 always; --expect-fixed fails when any open/nav/close
// step emits 2J/3J, when a post-close viewport is yanked to the top, or when
// the fits scenario scrolls.

import { TUI, Container } from "../../node_modules/@earendil-works/pi-tui/dist/tui.js";
import { runGoalQuestionnaire } from "../../extensions/goal-questionnaire.ts";

const ROWS = Number(process.argv.slice(2).find((a) => !a.startsWith("--")) ?? 40);
const EXPECT_FIXED = process.argv.includes("--expect-fixed");
const COLS = 120;

function makeTerminal() {
	const writes = [];
	return {
		terminal: {
			columns: COLS, rows: ROWS,
			write(data) { writes.push(String(data)); },
			hideCursor() {}, showCursor() {}, start() {}, stop() {}, setTitle() {},
		},
		writes,
	};
}

// ANSI stream emulation: track cursor screen row + viewport scrolls (a \n feed
// while the cursor is on the bottom row scrolls the terminal), and count
// 1049 / 2J / 3J. Returns final cursor screen row too (post-close position).
function analyze(stream, rows, startRow) {
	let cursorRow = startRow;
	let scrolled = 0;
	let i = 0;
	const s = stream;
	const counts = { alt1049: 0, clear2J: 0, clear3J: 0 };
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
			if (s.startsWith("\x1b[?1049h", i)) { counts.alt1049++; i += 8; continue; }
			if (s.startsWith("\x1b[?1049l", i)) { counts.alt1049++; i += 8; continue; }
			if (s.startsWith("\x1b[2J", i)) { counts.clear2J++; i += 4; continue; }
			if (s.startsWith("\x1b[3J", i)) { counts.clear3J++; i += 4; continue; }
			const m = s.slice(i).match(/^\x1b\[([0-9;?]*)([A-Za-z])/);
			if (m) {
				const q = m[1]?.includes("?") ?? false;
				const n = (m[1]?.split(";").filter(Boolean).map(Number)[0]) ?? 1;
				if (!q) {
					if (m[2] === "A") cursorRow = Math.max(0, cursorRow - (Number.isNaN(n) ? 1 : n));
					else if (m[2] === "B" || m[2] === "C") cursorRow = Math.min(rows - 1, cursorRow + (Number.isNaN(n) ? 1 : n));
					else if (m[2] === "H") cursorRow = Math.min(rows - 1, (Number.isNaN(n) ? 1 : n) - 1);
				}
				i += m[0].length;
				continue;
			}
			const st = s.indexOf("\x07", i);
			if (st !== -1 && !s.startsWith("\x1b[", i)) { i = st + 1; continue; }
			i++;
			continue;
		}
		i++;
	}
	return { ...counts, scrolled, finalCursorRow: cursorRow };
}

const theme = { fg: (_c, s) => s, bg: (_c, s) => s, bold: (s) => s, dim: (s) => s };
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "");

const LONG_CONTEXT = [
	"● Goal draft/tweak ready for confirmation.",
	"",
	"─── Name ───",
	"│   Mode: Normal goal",
	"",
	"=== Goal ===",
	"Objective: Build a thing that does the thing.",
	...Array.from({ length: 40 }, (_, i) => `│   Detail line ${i} of the draft objective`),
	"",
	"─── Tasks ───",
	...Array.from({ length: 30 }, (_, i) => `[ ] task-${i}: do the ${i}th thing`),
].join("\n");
const SHORT_CONTEXT = "● Goal draft/tweak ready for confirmation.\n\n=== Goal ===\nObjective: Short and simple.\nSuccess criteria: It works.";

// ctx.ui.custom mirroring pi's showExtensionCustom: no overlay options -> editor
// swap (inline in the main buffer); resolve on done -> restore editor.
function makeCtx(tui, editorContainer, editor) {
	const state = { component: null, handle: null };
	const ctx = {
		hasUI: true,
		ui: {
			custom(factory, options) {
				return new Promise((res) => {
					state.component = factory(tui, theme, undefined, (result) => {
						if (state.handle) { state.handle.hide(); tui.requestRender(); }
						editorContainer.clear();
						editorContainer.addChild(editor);
						tui.requestRender();
						res(result);
					});
					if (options?.overlay) {
						state.handle = tui.showOverlay(state.component, options.overlayOptions);
					} else {
						editorContainer.clear();
						editorContainer.addChild(state.component);
					}
					tui.requestRender();
				});
			},
		},
	};
	return { ctx, state };
}

async function runScenario(chatLines, context, label, expectsFits) {
	const { terminal, writes } = makeTerminal();
	const tui = new TUI(terminal, false, "/tmp/tui-before-after-churn");
	const chat = new Container();
	chat.render = () => Array.from({ length: chatLines }, (_, i) => `chat line ${i} ${"x".repeat(20)}`);
	const footer = new Container();
	footer.render = () => ["─ footer ─"];
	const editorContainer = new Container();
	const editor = new Container();
	editor.render = () => ["❯ "];
	editorContainer.addChild(editor);
	tui.addChild(chat); tui.addChild(footer); tui.addChild(editorContainer);
	tui.doRender();
	writes.length = 0;

	const { ctx, state } = makeCtx(tui, editorContainer, editor);
	const resultPromise = runGoalQuestionnaire(ctx, [{
		id: "confirm", question: "Confirm Goal Draft",
		context,
		options: ["Confirm — create this goal now", "Continue chatting", "Cancel — discard this draft"],
		recommended: 0, allowCustom: false,
	}], undefined);

	const openStartRow = tui.hardwareCursorRow - tui.previousViewportTop;
	tui.doRender();
	const openStream = writes.join("");
	writes.length = 0;
	const open = analyze(openStream, ROWS, openStartRow);
	const openLines = (tui.previousLines ?? []).map(stripAnsi);

	// nav: move selection down once
	const component = state.component;
	if (component?.handleInput) component.handleInput("\x1b[B");
	const navStartRow = tui.hardwareCursorRow - tui.previousViewportTop;
	tui.doRender();
	const navStream = writes.join("");
	writes.length = 0;
	const nav = analyze(navStream, ROWS, navStartRow);

	// close: escape (cancel)
	if (component?.handleInput) component.handleInput("\x1b");
	await resultPromise;
	const closeStartRow = tui.hardwareCursorRow - tui.previousViewportTop;
	tui.doRender();
	const closeStream = writes.join("");
	const close = analyze(closeStream, ROWS, closeStartRow);

	const detailCount = (context.match(/Detail line \d+/g) ?? []).length;
	const taskCount = (context.match(/\[ \] task-\d+/g) ?? []).length;
	// Dialog content is written into the main buffer during OPEN (readable via
	// scrollback while the dialog is up); check the open frame, not post-close.
	const fullDialogInBuffer = detailCount === 0 ? openLines.some((l) => /Objective:/.test(l)) : openLines.some((l) => l.includes(`Detail line ${detailCount - 1}`));
	const fullTasksInBuffer = taskCount === 0 ? true : openLines.some((l) => l.includes(`task-${taskCount - 1}`));
	const chatVisible = openLines.slice(0, chatLines).some((l) => l.startsWith("chat line"));
	const yanked = close.clear2J + close.clear3J > 0;

	console.log(`[${label}] chat=${chatLines} rows=${ROWS} ${expectsFits ? "(fits)" : ""}`);
	console.log(`  open : scrolls=${open.scrolled} 1049=${open.alt1049} 2J=${open.clear2J} 3J=${open.clear3J}`);
	console.log(`  nav  : scrolls=${nav.scrolled} 2J=${nav.clear2J} 3J=${nav.clear3J}`);
	console.log(`  close: scrolls=${close.scrolled} 2J=${close.clear2J} 3J=${close.clear3J} cursorRow=${close.finalCursorRow}/${ROWS}${yanked ? "  <-- FULL RENDER (2J+3J): SCROLLBACK ERASED + VIEWPORT DISTURBED" : ""}`);
	console.log(`  scrollback: full dialog ${fullDialogInBuffer && fullTasksInBuffer ? "✓" : "✗"}, chat visible above ${chatVisible ? "✓" : "✗"}`);
	console.log("");

	const failures = [];
	if (EXPECT_FIXED) {
		if (open.clear2J + open.clear3J > 0 || nav.clear2J + nav.clear3J > 0 || close.clear2J + close.clear3J > 0) {
			failures.push(`${label}: 2J/3J emitted during open/nav/close`);
		}
		if (yanked) failures.push(`${label}: viewport yanked to top on close`);
		if (expectsFits) {
			if (open.scrolled !== 0 || nav.scrolled !== 0 || close.scrolled !== 0) {
				failures.push(`${label}: viewport scrolled (content fits)`);
			}
			if (!fullDialogInBuffer || !fullTasksInBuffer || !chatVisible) failures.push(`${label}: fits content lost from buffer`);
		}
	}
	return failures;
}

// Scenario A: content fits -> must stay 0-churn, no clears.
// Scenario B: proposal taller than the terminal -> the churn bug (2J+3J on close).
// Scenario C: chat taller than the terminal + tall proposal -> same close bug.
const scenarios = [
	["A fits: short chat + short proposal", 10, SHORT_CONTEXT, true],
	["B tall dialog: short chat + long proposal", 10, LONG_CONTEXT, false],
	["C tall chat + tall dialog: long chat + long proposal", 120, LONG_CONTEXT, false],
];

const allFailures = [];
for (const [label, chat, ctx, fits] of scenarios) {
	allFailures.push(...(await runScenario(chat, ctx, label, fits)));
}

if (EXPECT_FIXED) {
	if (allFailures.length > 0) {
		console.error("FAIL — churn not fixed:");
		for (const f of allFailures) console.error(`  ✗ ${f}`);
		process.exit(1);
	}
	console.log("PASS — no 2J/3J, no viewport yank, fits scenario stays 0-churn.");
} else {
	console.log(`Measured ${scenarios.length} scenarios (report mode). Run with --expect-fixed after applying the fix to assert the after-state.`);
}
process.exit(0);
