/**
 * Box drawing and text layout for the dashboard renderers. Everything that
 * fits, pads or truncates a line lives here, so the section renderers only say
 * what to show. Every helper keeps lines within the requested terminal width.
 */

import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { truncateToWidth, wrapTextWithAnsi } from "./text-cache.ts";

// mdLink is deliberately excluded: the chrome must stay neutral gray, not
// blue-tinged ("more grey than blue").
export type RenderColor = Extract<ThemeColor, "accent" | "warning" | "success" | "error" | "dim" | "muted" | "text" | "mdHeading">;

const H = "─";
const V = "│";

/** Narrowest width the dashboards lay out for; anything smaller is widened. */
export const MIN_BOX_WIDTH = 10;

/** Cut a string to `width` columns, adding an ellipsis only when it is cut. */
export function fit(value: string, width: number): string {
	return visibleWidth(value) > width ? truncateToWidth(value, width, "…") : value;
}

/** Clamp every rendered line to the terminal width (a last safety net). */
export function clampLinesToWidth(lines: string[], width: number): string[] {
	return lines.map((line) => (visibleWidth(line) > width ? truncateToWidth(line, width, "…") : line));
}

// ── colour helpers ──────────────────────────────────────────────────────────

export function muted(theme: Theme, value: string): string {
	return theme.fg("muted", value);
}

export function dim(theme: Theme, value: string): string {
	return theme.fg("dim", value);
}

export function accent(theme: Theme, value: string): string {
	return theme.fg("accent", value);
}

export function success(theme: Theme, value: string): string {
	return theme.fg("success", value);
}

/** Amber, used for pending tasks and the budget gauge. */
export function amber(theme: Theme, value: string): string {
	return theme.fg("mdHeading", value);
}

/** Box chrome: the whole frame is one tone, the theme's neutral gray. */
export function frame(theme: Theme, value: string): string {
	return theme.fg("muted", value);
}

// ── progress bars ───────────────────────────────────────────────────────────

export function progressBar(theme: Theme, pct: number, barWidth: number): string {
	const safeBar = Math.max(2, barWidth);
	const filled = Math.min(safeBar, Math.max(0, Math.round((pct / 100) * safeBar)));
	// The bar is muted like the rest of the progress info: neutral-gray fill
	// with dim empty cells, no accent teal anywhere in the progress element.
	return `[${theme.fg("muted", "█".repeat(filled))}${theme.fg("dim", "░".repeat(safeBar - filled))}]`;
}

// ── layout modes ────────────────────────────────────────────────────────────

export type LayoutMode = "wide" | "medium" | "narrow" | "minimal";

export function layoutMode(width: number): LayoutMode {
	if (width >= 100) return "wide";
	if (width >= 70) return "medium";
	if (width >= 50) return "narrow";
	return "minimal";
}

export interface LayoutSpec {
	barWidth: number;
	/** Compact progress bar width inside the Tasks header row (bar at the end). */
	headerBarWidth: number;
	/** Subtask progress bar width inside the Tasks header row, beside the task
	 * bar (minimal omits the segment, so the value is unused there). */
	subtaskBarWidth: number;
	showPath: boolean;
	showPauseAction: boolean;
	footerHint: string;
}

export function specFor(mode: LayoutMode): LayoutSpec {
	switch (mode) {
		case "wide":
			return { barWidth: 26, headerBarWidth: 8, subtaskBarWidth: 4, showPath: true, showPauseAction: true, footerHint: "Ctrl+Shift+T: expand tasks" };
		case "medium":
			return { barWidth: 18, headerBarWidth: 6, subtaskBarWidth: 3, showPath: true, showPauseAction: true, footerHint: "Ctrl+Shift+T: expand tasks" };
		case "narrow":
			return { barWidth: 12, headerBarWidth: 5, subtaskBarWidth: 2, showPath: false, showPauseAction: false, footerHint: "Ctrl+Shift+T: expand" };
		case "minimal":
			return { barWidth: 8, headerBarWidth: 4, subtaskBarWidth: 2, showPath: false, showPauseAction: false, footerHint: "Ctrl+Shift+T: expand" };
	}
}

// ── the box ─────────────────────────────────────────────────────────────────

/**
 * One box at one width. The methods return finished lines (borders, padding
 * and truncation included), so a section renderer never does width maths.
 */
export class Box {
	/** Total box width, never below MIN_BOX_WIDTH. */
	readonly width: number;
	/** Columns between the left and right edges. */
	readonly inner: number;

	readonly theme: Theme;

	constructor(theme: Theme, width: number) {
		this.theme = theme;
		this.width = Math.max(MIN_BOX_WIDTH, width);
		this.inner = this.width - 2;
	}

	/** Top border with a title on the left and optional meta on the right. */
	header(left: string, right = ""): string {
		const theme = this.theme;
		const inner = Math.max(4, this.width - 2);
		// One-tone frame line: corners, leading/trailing dashes and fill all carry
		// the frame color; only the brand inside stays accent.
		const l = `${frame(theme, H)} ${left}`;
		const r = right ? ` ${right} ${frame(theme, H)}` : "";
		const fixed = visibleWidth(l) + visibleWidth(r);
		if (fixed > inner - 2) {
			// Too tight: truncate the title so the right-side meta survives.
			const budget = Math.max(4, inner - visibleWidth(r) - 4);
			const l2 = `${frame(theme, H)} ${fit(left, budget)}`;
			const fill = Math.max(1, inner - visibleWidth(l2) - visibleWidth(r));
			return `${frame(theme, "╭")}${l2}${frame(theme, H.repeat(fill))}${r}${frame(theme, "╮")}`;
		}
		const fill = Math.max(1, inner - fixed);
		return `${frame(theme, "╭")}${l}${frame(theme, H.repeat(fill))}${r}${frame(theme, "╮")}`;
	}

	/** One content row between the side edges, truncated and padded to fit. */
	line(content: string): string {
		const inner = Math.max(2, this.width - 2);
		const contentFit = fit(content, inner - 1);
		const pad = Math.max(0, inner - 1 - visibleWidth(contentFit));
		return `${frame(this.theme, V)} ${contentFit}${" ".repeat(pad)}${frame(this.theme, V)}`;
	}

	/**
	 * Section separator with a label and optional right-side content:
	 * `├─ Tasks ──── [████░] · Sub 2/3 [██░░] ┤`. The right content always
	 * survives; the label truncates when tight, leaving room for the `─ `
	 * prefix and trailing space.
	 */
	rule(label: string, right = ""): string {
		const theme = this.theme;
		const inner = Math.max(4, this.width - 2);
		const left = frame(theme, `${H} ${label} `);
		const r = right ? ` ${right} ` : "";
		let l = left;
		if (visibleWidth(left) + visibleWidth(r) > inner) {
			const budget = Math.max(4, inner - visibleWidth(r) - 3);
			l = frame(theme, `${H} ${fit(label, budget)} `);
		}
		const fill = Math.max(0, inner - visibleWidth(l) - visibleWidth(r));
		return `${frame(theme, "├")}${l}${frame(theme, H.repeat(fill))}${r}${frame(theme, "┤")}`;
	}

	/**
	 * Bottom border with a hint on the left. The optional right slot mirrors
	 * the header's right meta (` ● ─` before the corner): it survives, and the
	 * hint truncates when tight.
	 */
	footer(content: string, right = ""): string {
		const theme = this.theme;
		const inner = Math.max(4, this.width - 2);
		const r = right ? ` ${right} ${frame(theme, H)}` : "";
		if (!content && !r) {
			return frame(theme, `╰${H.repeat(inner)}╯`);
		}
		// The footer is one frame tone: leading dash, hint text and trailing fill
		// all carry the frame color.
		const l = content ? frame(theme, `${H} ${fit(content, Math.max(0, inner - 4 - visibleWidth(r)))}`) : "";
		const fill = Math.max(1, inner - visibleWidth(l) - visibleWidth(r));
		return `${frame(theme, "╰")}${l}${frame(theme, H.repeat(fill))}${r}${frame(theme, "╯")}`;
	}

	/** Wrap long contract or evidence text to the inner width, label on the first row. */
	wrapped(label: string, text: string): string[] {
		const inner = Math.max(4, this.width - 2);
		const prefix = label ? `${label}: ` : "";
		const indent = " ".repeat(visibleWidth(prefix));
		const segments = wrapTextWithAnsi(text.replace(/\s+/g, " ").trim(), Math.max(8, inner - visibleWidth(prefix)));
		return segments.map((segment, index) => this.line(muted(this.theme, index === 0 ? `${prefix}${segment}` : `${indent}${segment}`)));
	}
}
