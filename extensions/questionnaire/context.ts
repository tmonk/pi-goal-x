import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";

/** Where the context renderer sends its lines; the dialog renderer supplies one that wraps and truncates for its width. */
export interface ContextOutput {
	/** One line, truncated to the dialog width. */
	line(text: string): void;
	/** A line wrapped to the dialog width. */
	wrapped(text: string): void;
	/** A "│"-prefixed line whose wrapped continuations keep the box edge. */
	wrappedPipe(text: string): void;
	blank(): void;
}

/** Render a question's context block with per-line styling. No truncation. */
export function renderContextLines(context: string, out: ContextOutput, theme: Theme, safeWidth: number): void {
	const rawLines = context.split("\n");
	for (const rawLine of rawLines) {
		const trimmed = rawLine.trim();
		// Empty line — preserve as spacing
		if (!trimmed) {
			out.blank();
			continue;
		}

		// 1. Announcement header — "● Goal draft/tweak ready for confirmation."
		if (/^● Goal (draft|tweak) ready for confirmation\.$/.test(trimmed)) {
			out.wrapped(theme.fg("accent", rawLine));
			continue;
		}

		// 2. Section marker — "─── Name ───" → full-width box-drawing header
		const sectionMatch = trimmed.match(/^───\s+(.+?)\s+───$/);
		if (sectionMatch) {
			const sectionName = sectionMatch[1];
			const namePart = ` ${sectionName} `;
			const left = "┌─";
			const right = "─┐";
			const fill = Math.max(0, safeWidth - 2 - visibleWidth(left + namePart + right));
			out.line(theme.fg("accent", left + namePart + "─".repeat(fill) + right));
			continue;
		}

		// 3. Lines with │ prefix come from buildDraftConfirmationText / buildTweakConfirmationText.
		if (trimmed.startsWith("│")) {
			const afterPipe = trimmed.slice(1).trim();
			// 3a. Task checkbox under │ prefix — detect before key-value to avoid
			// "[x] t1: ..." being misinterpreted as a key-value pair.
			const pipeTaskMatch = afterPipe.match(/^(\[.\])(\s+)(.+)$/);
			if (pipeTaskMatch) {
				const bracket = pipeTaskMatch[1]!;
				const sep = pipeTaskMatch[2]!;
				const rest = pipeTaskMatch[3]!;
				// Preserve inner whitespace between │ and the task marker (e.g. "   " in "│   [x]...")
				const pipeContent = trimmed.slice(1);
				const innerWs = pipeContent.slice(0, pipeContent.length - pipeContent.trimStart().length);
				const linePrefix = "│" + innerWs;
				const color = bracket === "[x]" ? "success" : "warning";
				out.wrappedPipe(linePrefix + theme.fg(color, bracket) + sep + theme.fg("muted", rest));
				continue;
			}
			// 3b. Key-value content (e.g. "│   Mode: Normal goal", "│   Auto-continue: yes")
			if (afterPipe.includes(": ")) {
				const colonIdx = afterPipe.indexOf(": ");
				const val = afterPipe.slice(colonIdx + 2).trim();
				const keyPart = rawLine.slice(0, rawLine.indexOf(afterPipe) + colonIdx + 2);
				if (val === "yes" || val === "no") {
					out.wrappedPipe(theme.fg("muted", keyPart) + theme.fg(val === "yes" ? "success" : "warning", val));
					continue;
				}
				out.wrappedPipe(theme.fg("muted", rawLine));
				continue;
			}
			// 3c. Generic content under │ prefix (topic, goal text, etc.)
			out.wrappedPipe(theme.fg("muted", rawLine));
			continue;
		}

		// 4. Goal objective structure lines — detected before task checkboxes
		// because === Goal could overlap with ─── markers but we already checked those.
		const GOAL_SECTION_RE = /^(=== (Goal|Sisyphus Goal) ===|Objective:|Success criteria:|Boundaries:|Constraints:|Verification contract:|If blocked:)/;
		if (GOAL_SECTION_RE.test(trimmed)) {
			out.wrapped(theme.fg("accent", rawLine));
			continue;
		}

		// 5. Actual box-drawing borders (┌ └ ├ └ ┐ ┤ ┘ ─) — NOT │ which is handled above
		if (/^[┌├└┐┤┘─]/.test(trimmed)) {
			out.wrapped(theme.fg("dim", rawLine));
			continue;
		}

		// 6. Task checkbox item — "[ ] ...", "[x] ...", or "[~] ..." (with optional indent)
		const checkMatch = trimmed.match(/^(\[.\])(\s+)(.+)$/);
		if (checkMatch) {
			const bracket = checkMatch[1]!;
			const sep = checkMatch[2]!;
			const rest = checkMatch[3]!;
			const indent = rawLine.slice(0, rawLine.length - trimmed.length);
			const color = bracket === "[x]" ? "success" : "warning";
			out.wrapped(indent + theme.fg(color, bracket) + sep + theme.fg("muted", rest));
			continue;
		}

		// 7. Default: any remaining content (fallback)
		out.wrapped(theme.fg("muted", rawLine));
	}
}
