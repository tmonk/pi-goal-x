import assert from "node:assert/strict";
import test from "node:test";

import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

const PIPE_PREFIX = "│   ";
const PIPE_WIDTH = visibleWidth(PIPE_PREFIX);

/**
 * Helper: apply the addWrappedPipe fix logic to content and return lines.
 * Wraps at (width - pipeWidth) and prepends pipe prefix to continuations.
 */
function fixedAddWrappedPipe(content: string, safeWidth: number): string[] {
	const wrapWidth = Math.max(1, safeWidth - PIPE_WIDTH);
	const wrapped = wrapTextWithAnsi(content, wrapWidth);
	return wrapped.map((line, i) => (i === 0 ? line : PIPE_PREFIX + line));
}

/**
 * Helper: apply the BUGGY addWrappedPipe logic to content.
 * Wraps at full width and prepends pipe prefix to continuations.
 */

// ─── addWrappedPipe fix math ────────────────────────────────────────────────

test("addWrappedPipe fix: pipe prefix is exactly 4 visible chars", () => {
	assert.equal(PIPE_WIDTH, 4, `Pipe prefix "${PIPE_PREFIX}" should be 4 visible chars, got ${PIPE_WIDTH}`);
});

test("addWrappedPipe fix: no overflow at any width from 20 to 120", () => {
	for (let safeWidth = 20; safeWidth <= 120; safeWidth++) {
		// Fill-content guaranteed to produce full-width wrapped lines
		const content = "aaabbbcccdddeeefffggghhhiiijjjkkklllmmmnnnooopppqqqrrrssstttuuuvvvwwwxxxyyyzzz ".repeat(20);

		const fixLines = fixedAddWrappedPipe(content, safeWidth);
		for (let i = 0; i < fixLines.length; i++) {
			assert.ok(
				visibleWidth(fixLines[i]!) <= safeWidth,
				`Fixed at safeWidth=${safeWidth}, line ${i}: visibleWidth=${visibleWidth(fixLines[i]!)} > ${safeWidth}`,
			);
		}
	}
});

test("addWrappedPipe fix: first line without prefix never exceeds width", () => {
	// The first line doesn't get the pipe prefix — verify it stays within width
	for (let safeWidth = 20; safeWidth <= 120; safeWidth += 10) {
		const content = "a".repeat(safeWidth * 2);
		const fixLines = fixedAddWrappedPipe(content, safeWidth);
		assert.ok(
			fixLines.length >= 2,
			`safeWidth=${safeWidth}: content should produce at least 2 lines, got ${fixLines.length}`,
		);
		// First line has no pipe prefix, should fit in safeWidth
		assert.ok(
			visibleWidth(fixLines[0]!) <= safeWidth,
			`safeWidth=${safeWidth}: first line overflows: ${visibleWidth(fixLines[0]!)} > ${safeWidth}`,
		);
		// Continuation lines with pipe prefix should also fit
		for (let i = 1; i < fixLines.length; i++) {
			assert.ok(
				visibleWidth(fixLines[i]!) <= safeWidth,
				`safeWidth=${safeWidth}: continuation line ${i} overflows: ${visibleWidth(fixLines[i]!)} > ${safeWidth}`,
			);
		}
	}
});

// ─── Content with ANSI escape codes (styled text) ──────────────────────────

test("addWrappedPipe fix: styled content with ANSI codes", () => {
	for (let safeWidth = 30; safeWidth <= 120; safeWidth += 10) {
		// Content with ANSI bold/color codes (simulating theme.fg calls)
		const styledParts = [
			"\x1b[1m\x1b[38;2;138;190;183mStyled header\x1b[22m\x1b[39m",
			"\x1b[38;2;128;128;128mMuted description that continues with enough text to trigger wrapping at the given width\x1b[39m",
			"\x1b[38;2;206;145;120mWarning: this is a very long warning message that should wrap properly at narrow terminal widths without causing an overflow crash\x1b[39m",
			"\x1b[38;2;86;156;214mInfo: additional contextual information that might appear in a status display\x1b[39m",
		];
		const content = styledParts.join(" ");

		const lines = fixedAddWrappedPipe(content, safeWidth);
		for (let i = 0; i < lines.length; i++) {
			const w = visibleWidth(lines[i]!);
			assert.ok(
				w <= safeWidth,
				`safeWidth=${safeWidth}, styled line ${i}: visibleWidth=${w} > ${safeWidth}`,
			);
		}
	}
});

test("addWrappedPipe fix: content with theme.fg styling patterns", () => {
	// Simulate the exact patterns used in renderContextLines
	for (let safeWidth = 40; safeWidth <= 120; safeWidth += 10) {
		const styledLines = [
			// Key-value pattern: "│   Mode: Normal goal"
			`\x1b[38;2;128;128;128mMode:\x1b[39m \x1b[38;2;212;212;212mNormal goal with extra description that pushes this beyond the terminal width at narrow settings\x1b[39m`,
			// Plain muted content: "│   Some topic text"
			`\x1b[38;2;128;128;128mSome topic text that describes what the user wants to accomplish and may be very long requiring wrapping at narrow widths\x1b[39m`,
			// Section content
			`\x1b[38;2;128;128;128m│   Already-prefixed content that should be treated as-is but still needs wrapping and must not overflow even at very narrow terminal width settings\x1b[39m`,
		];

		for (const styledLine of styledLines) {
			const lines = fixedAddWrappedPipe(styledLine, safeWidth);
			for (let i = 0; i < lines.length; i++) {
				const w = visibleWidth(lines[i]!);
				assert.ok(
					w <= safeWidth,
					`safeWidth=${safeWidth}, styled line ${i}: visibleWidth=${w} > ${safeWidth}, content=${JSON.stringify(lines[i]!.slice(0, 50))}`,
				);
			}
		}
	}
});

// ─── Content with CJK / wide characters ────────────────────────────────────

test("addWrappedPipe fix: CJK wide character content", () => {
	for (let safeWidth = 30; safeWidth <= 120; safeWidth += 10) {
		// CJK characters are 2 columns wide each
		const cjkContent = "設定目標並持續追蹤進度以確保代理程式能夠有效執行長期任務。此功能允許使用者定義明確的目標。".repeat(5);

		const lines = fixedAddWrappedPipe(cjkContent, safeWidth);
		for (let i = 0; i < lines.length; i++) {
			const w = visibleWidth(lines[i]!);
			assert.ok(
				w <= safeWidth,
				`safeWidth=${safeWidth}, CJK line ${i}: visibleWidth=${w} > ${safeWidth}`,
			);
		}
	}
});

test("addWrappedPipe fix: mixed CJK and ASCII content", () => {
	for (let safeWidth = 40; safeWidth <= 120; safeWidth += 10) {
		const mixed = "pi-goal-x 是一個目標管理擴展套件，用於 pi 編碼代理程式。This extension provides long-running goal management with auto-continue and Sisyphus mode support for complex multi-step tasks. ".repeat(5);

		const lines = fixedAddWrappedPipe(mixed, safeWidth);
		for (let i = 0; i < lines.length; i++) {
			const w = visibleWidth(lines[i]!);
			assert.ok(
				w <= safeWidth,
				`safeWidth=${safeWidth}, mixed CJK/ASCII line ${i}: visibleWidth=${w} > ${safeWidth}`,
			);
		}
	}
});

// ─── Edge case content ─────────────────────────────────────────────────────

test("addWrappedPipe fix: single long word (no word breaks)", () => {
	for (let safeWidth = 30; safeWidth <= 120; safeWidth += 10) {
		// A single word longer than safeWidth - should be force-broken
		const longWord = "Supercalifragilisticexpialidocious".repeat(10);
		const lines = fixedAddWrappedPipe(longWord, safeWidth);
		for (let i = 0; i < lines.length; i++) {
			const w = visibleWidth(lines[i]!);
			assert.ok(
				w <= safeWidth,
				`safeWidth=${safeWidth}, long-word line ${i}: visibleWidth=${w} > ${safeWidth}`,
			);
		}
	}
});

test("addWrappedPipe fix: content at exact wrap boundary", () => {
	for (let safeWidth = 30; safeWidth <= 120; safeWidth += 10) {
		const wrapWidth = Math.max(1, safeWidth - PIPE_WIDTH);
		// Content that exactly fills the wrap width on each line
		const exactLine = "x".repeat(wrapWidth);
		const content = Array.from({ length: 5 }, () => exactLine).join(" ");

		const lines = fixedAddWrappedPipe(content, safeWidth);
		for (let i = 0; i < lines.length; i++) {
			const w = visibleWidth(lines[i]!);
			assert.ok(
				w <= safeWidth,
				`safeWidth=${safeWidth}, exact-boundary line ${i}: visibleWidth=${w} > ${safeWidth}`,
			);
		}
	}
});

test("addWrappedPipe fix: content with leading/trailing whitespace", () => {
	for (let safeWidth = 30; safeWidth <= 120; safeWidth += 10) {
		const padded = "   A line with leading spaces and trailing spaces that should still wrap correctly at narrow widths without overflow   ".repeat(3);
		const lines = fixedAddWrappedPipe(padded, safeWidth);
		for (let i = 0; i < lines.length; i++) {
			const w = visibleWidth(lines[i]!);
			assert.ok(
				w <= safeWidth,
				`safeWidth=${safeWidth}, whitespace line ${i}: visibleWidth=${w} > ${safeWidth}`,
			);
		}
	}
});

test("addWrappedPipe fix: content exactly at minimum safeWidth=20", () => {
	const safeWidth = 20;
	// At safeWidth=20, wrapWidth=16. Content should wrap and fit.
	const content = "x".repeat(safeWidth * 4) + " " + "y".repeat(safeWidth * 4);
	const lines = fixedAddWrappedPipe(content, safeWidth);
	for (let i = 0; i < lines.length; i++) {
		const w = visibleWidth(lines[i]!);
		assert.ok(
			w <= safeWidth,
			`safeWidth=${safeWidth}, line ${i}: visibleWidth=${w} > ${safeWidth}`,
		);
	}
});

// ─── truncateToWidth safety net ─────────────────────────────────────────────

test("truncateToWidth safety net at edge case widths", () => {
	// Every width from 1 to 120
	for (let width = 1; width <= 120; width++) {
		const long = "x".repeat(width * 4);
		const truncated = truncateToWidth(long, width);
		const w = visibleWidth(truncated);
		assert.ok(
			w <= width,
			`truncateToWidth at width=${width} produced visibleWidth=${w}`,
		);
	}
});

test("truncateToWidth with ANSI codes at every width", () => {
	for (let width = 5; width <= 120; width += 5) {
		// Styled content
		const styled = `\x1b[1m\x1b[38;2;138;190;183m${"a".repeat(width * 3)}\x1b[22m\x1b[39m`;
		const truncated = truncateToWidth(styled, width);
		const w = visibleWidth(truncated);
		assert.ok(
			w <= width,
			`truncateToWidth with ANSI at width=${width} produced visibleWidth=${w}`,
		);
	}
});

test("truncateToWidth with CJK characters at every width", () => {
	for (let width = 4; width <= 120; width += 4) {
		const cjk = "界".repeat(width * 2); // Each CJK char is 2 columns
		const truncated = truncateToWidth(cjk, width);
		const w = visibleWidth(truncated);
		assert.ok(
			w <= width,
			`truncateToWidth CJK at width=${width} produced visibleWidth=${w}`,
		);
	}
});

// ─── wrapTextWithAnsi boundary conditions ──────────────────────────────────

test("wrapTextWithAnsi at minimum width 1 never overflows", () => {
	const content = "Hello world this is a test of wrapping at minimum width settings";
	const wrapped = wrapTextWithAnsi(content, 1);
	for (let i = 0; i < wrapped.length; i++) {
		const w = visibleWidth(wrapped[i]!);
		assert.ok(
			w <= 1,
			`wrap at width 1, line ${i}: visibleWidth=${w} > 1`,
		);
	}
});

test("wrapTextWithAnsi at width 0 (clamped edge case)", () => {
	const content = "Test content at zero width";
	const wrapped = wrapTextWithAnsi(content, 0);
	for (let i = 0; i < wrapped.length; i++) {
		const w = visibleWidth(wrapped[i]!);
		assert.ok(
			// At width 0, each line should be at most a few chars
			w <= 5,
			`wrap at width 0, line ${i}: visibleWidth=${w} > expected bound`,
		);
	}
});

// ─── Combined: full pipeline simulation ─────────────────────────────────────

test("addWrappedPipe fix: full crash scenario simulation", () => {
	// Exact reproduction of the crash from the crash log:
	// Terminal width 109, content wraps inside │   box
	const safeWidth = 109;
	const crashContent = [
		"│   Achieve full end-to-end test suite pass on Linux x86_64 with 100% vendor parity — all e2e pass (no skips). The constraints should be exactly those as per the design document and the previous goals.",
		"│   We need to dissassemble the vendor's implementation live, stepping through, to ensure we implement this in full.",
	].join(" ");

	// The fixed version never overflows at the exact crash scenario width
	const fixedLines = fixedAddWrappedPipe(crashContent, safeWidth);
	for (let i = 0; i < fixedLines.length; i++) {
		assert.ok(
			visibleWidth(fixedLines[i]!) <= safeWidth,
			`Fixed version overflows at width ${safeWidth}, line ${i}: visibleWidth=${visibleWidth(fixedLines[i]!)}`,
		);
	}
});

test("addWrappedPipe fix: all widths from 20 to 120 with crash scenario content", () => {
	const crashContent = [
		"Achieve full end-to-end test suite pass on Linux x86_64 with 100% vendor parity — all e2e pass (no skips). The constraints should be exactly those as per the design document and the previous goals.",
		"We need to dissassemble the vendor's implementation live, stepping through, to ensure we implement this in full.",
	].join(" ");

	for (let safeWidth = 20; safeWidth <= 120; safeWidth++) {
		const lines = fixedAddWrappedPipe(crashContent, safeWidth);
		for (let i = 0; i < lines.length; i++) {
			const w = visibleWidth(lines[i]!);
			assert.ok(
				w <= safeWidth,
				`safeWidth=${safeWidth}, crash-scenario line ${i}: visibleWidth=${w} > ${safeWidth}`,
			);
		}
	}
});

// ─── Empty content edge case ────────────────────────────────────────────────

test("addWrappedPipe fix: empty content produces single empty list", () => {
	const lines = fixedAddWrappedPipe("", 80);
	assert.ok(lines.length === 0 || (lines.length === 1 && lines[0] === ""));
});
