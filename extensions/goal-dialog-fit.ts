import { t } from "./i18n/index.ts";


/**
 * Bound a custom dialog using the regular renderer's frame cache when
 * available. When the fullscreen renderer does not expose that cache,
 * reserve four rows for host chrome and use the remaining terminal height.
 */
export function computeDialogLineLimit(args: { terminalRows?: number; baseFrameLines?: number }): number | undefined {
	const rows = args.terminalRows;
	if (!rows || rows <= 0) return undefined;
	if (args.baseFrameLines && args.baseFrameLines > 0) {
		return Math.min(rows, Math.max(10, rows - args.baseFrameLines + 1));
	}
	return Math.min(rows, Math.max(4, rows - 4));
}

/**
 * Proposal-confirmation segment descriptor: absolute line indices of the
 * tasks section (header + every task line) and the start of the options tail
 * inside a rendered questionnaire dialog.
 */
interface ProposalPresentationSegments {
	tasksStart: number;
	tasksEnd: number;
	tailStart: number;
}

/** Strip ANSI SGR sequences so structural scans see the plain text. */
function stripAnsiCodes(value: string): string {
	// eslint-disable-next-line no-control-regex -- deliberate ANSI SGR escape-sequence matching
	return value.replace(/\x1b\[[0-9;]*m/g, "");
}

/**
 * Locate the proposal tasks segment and the options tail in a rendered dialog.
 * Returns null when the dialog is not a proposal-style confirmation (no
 * "Tasks proposed for confirmation:" header / "┌─ TASKS ─" box).
 *
 * The scan is ANSI-aware: every rendered line carries `theme.fg(...)` escape
 * sequences in the real TUI (the mock theme does not), so plain-text regexes
 * must be run against the stripped line or the tasks section collapses to its
 * header and every styled task line is sliced out of the bounded frame. The
 * box-drawn bottom border (`└───┘`) after the last task line is kept so the
 * `┌─ TASKS ─┐` box renders complete.
 *
 * The interactive auditor toggle line ("press 'a' to toggle") renders between
 * the context and the options; `tailStart` is pulled back to it so the bounded
 * fit always keeps the auditor status visible (its status text is the only
 * visible toggle feedback in the dialog).
 */
export function findProposalPresentationSegments(lines: string[], tailStart: number): ProposalPresentationSegments | null {
	if (tailStart < 0) return null;
	const tasksStart = lines.findIndex((l) => l.includes("Tasks proposed for confirmation:") || l.includes("┌─ TASKS ─"));
	if (tasksStart < 0 || tasksStart >= tailStart) return null;
	let tasksEnd = tasksStart;
	for (let i = tasksStart + 1; i < tailStart; i++) {
		const plain = stripAnsiCodes(lines[i]!);
		if (/^\s*\[[ x~]\]/.test(plain)) {
			tasksEnd = i;
			continue;
		}
		// Box-drawn TASKS section bottom border after the last task line.
		if (tasksEnd > tasksStart && /^[└┐┤┘─]/.test(plain.trim())) tasksEnd = i;
		break;
	}
	// Protect the auditor toggle line: it renders between context and options,
	// so pull the tail start back to it when present.
	let effectiveTail = tailStart;
	for (let i = tailStart - 1; i > tasksEnd; i--) {
		// The toggle line is "● <label>  (press ...)"; its words are translated, so match the bullet.
		if (/^\s*[●○] /.test(stripAnsiCodes(lines[i]!))) {
			effectiveTail = i;
			break;
		}
	}
	return { tasksStart, tasksEnd, tailStart: effectiveTail };
}

/**
 * Fit a rendered dialog to the terminal-height bound without ever hiding the
 * question. The protected head (top border + tabs + question line) is always
 * kept; the remaining budget is spent on the tail — options/footer/bottom
 * border — so long context blocks (proposal confirmations) are sliced from
 * their head exactly as the pre-fix tail-slice did (383ae52 surface). The
 * footer hint and bottom border are always the last rendered lines. Never
 * returns more than maxDialogLines.
 *
 * Proposal confirmations (proposal segments given) keep the head, the tasks
 * section (header + every task line), and the options/footer/bottom border in
 * frame; only the objective-box middle is sacrificed in-frame — the full
 * objective is always present in the scrollable transcript presentation
 * (propose_goal_draft renderCall), so nothing of the goal is ever omitted.
 *
 * §options-scroll: when a `scroll` state is given (select-mode question tabs
 * and the submit summary), the dialog becomes a `less`-style viewport over the
 * FULL content — nothing is truncated, nothing is sliced away — and the
 * options are always reachable by scrolling (PageUp/PageDown, Ctrl+↑/↓, and
 * ↑/↓ selection auto-follow). See fitDialogViewport.
 */
export interface DialogScrollState {
	/** Current viewport offset over the full content lines. */
	scrollTop: number;
	/** When true, the fitter nudges scrollTop so the selection range is visible. */
	needsFollow: boolean;
	/** Line ranges [start, end] of each selectable option in the full content. */
	optionRanges: Array<[number, number]>;
	/** Index of the current selection in optionRanges. */
	followIndex: number;
}

export function fitDialogLines(
	lines: string[],
	maxDialogLines: number,
	protectedHead: number,
	proposal: ProposalPresentationSegments | null = null,
	scroll: DialogScrollState | null = null,
	dimStyle: (s: string) => string = (s) => s,
	scrollHint = "PgUp/PgDn",
): string[] {
	if (maxDialogLines <= 0 || lines.length <= maxDialogLines) return lines;
	const keepHead = Math.min(protectedHead, maxDialogLines);
	if (proposal) {
		return fitProposalPresentation(lines, maxDialogLines, keepHead, proposal);
	}
	if (scroll) {
		return fitDialogViewport(lines, maxDialogLines, scroll, dimStyle, scrollHint);
	}
	// Context-heavy / input / submit dialogs without a scroll state: keep the
	// head and the tail (options/footer/bottom border) exactly as the pre-fix
	// tail-slice did.
	const budget = maxDialogLines - keepHead;
	if (budget <= 0) return lines.slice(0, keepHead);
	const rest = lines.slice(protectedHead);
	if (rest.length <= budget) return [...lines.slice(0, keepHead), ...rest];
	return [...lines.slice(0, keepHead), ...rest.slice(rest.length - budget)];
}

/**
 * §options-scroll viewport fit: never truncate or drop content — window the
 * full dialog lines with a scrollTop offset so every line (question, context,
 * options, footer, border) stays reachable. The last viewport row is reserved
 * as the bottom edge: the bottom border when the end is reached, otherwise a
 * themed `… +N more · PgUp/PgDn scroll` indicator (mirrors the dashboard's
 * `… +N more task` rows). A themed `▲ N more` indicator replaces the first
 * content row when scrolled down. Selection auto-follow (needsFollow) nudges
 * the window so the selected option's line range is inside it. Output length
 * is exactly maxDialogLines when clipped, never more (churn-guard invariant).
 */
function fitDialogViewport(
	lines: string[],
	maxDialogLines: number,
	scroll: DialogScrollState,
	dimStyle: (s: string) => string,
	scrollHint: string,
): string[] {
	const contentWindow = Math.max(0, maxDialogLines - 1);
	const contentEnd = Math.max(0, lines.length - 1);
	// Selection auto-follow: nudge scrollTop so the selected option's range is
	// inside the content window (minimal scroll; clamp below).
	if (scroll.needsFollow && scroll.optionRanges[scroll.followIndex]) {
		const [os, oe] = scroll.optionRanges[scroll.followIndex]!;
		if (os < scroll.scrollTop || oe >= scroll.scrollTop + contentWindow) {
			scroll.scrollTop = oe >= scroll.scrollTop + contentWindow
				? Math.min(os, Math.max(0, oe - contentWindow + 1))
				: os;
		}
		scroll.needsFollow = false;
	}
	scroll.scrollTop = Math.max(0, Math.min(scroll.scrollTop, Math.max(0, contentEnd - contentWindow)));
	const s = scroll.scrollTop;
	const hiddenAbove = s;
	const hiddenBelow = contentEnd - (s + contentWindow);
	const viewport = lines.slice(s, s + contentWindow);
	if (hiddenAbove > 0 && viewport.length > 0) {
		viewport[0] = dimStyle(t("▲ {count} more", { count: hiddenAbove }));
	}
	if (hiddenBelow > 0) {
		// The reserved bottom edge row advertises the scroll affordance — it
		// replaces the border while content is clipped below (mirrors the
		// dashboard's `… +N more task` rows) and gives way to the border at the
		// end. The footer hint sits directly above the border, so it is only
		// visible when the end is reached (never while clipped — geometry).
		viewport.push(dimStyle(t("… +{count} more · {hint} scroll", { count: hiddenBelow, hint: scrollHint })));
	} else {
		viewport.push(lines[lines.length - 1]!);
	}
	return viewport;
}

/**
 * Proposal confirmation fit: keep the protected head, the tasks section, the
 * interactive auditor toggle line (when present), and the options/footer/
 * bottom border; the objective-box middle is sacrificed in-frame (it stays
 * fully readable in the scrollback presentation). Interior blank spacing lines
 * are dropped first when room is short; task lines are only dropped after
 * that, from the end, when the bound is exhausted (those lines remain in the
 * scrollback presentation). Never exceeds maxDialogLines.
 */
function fitProposalPresentation(
	lines: string[],
	maxDialogLines: number,
	keepHead: number,
	proposal: ProposalPresentationSegments,
): string[] {
	const { tasksStart, tasksEnd, tailStart } = proposal;
	const head = lines.slice(0, keepHead);
	const tasks = lines.slice(Math.max(tasksStart, keepHead), Math.min(tasksEnd, tailStart) + 1);
	const tail = lines.slice(Math.max(tailStart, keepHead));
	const candidate = [...head, ...tasks, ...tail];
	if (candidate.length <= maxDialogLines) return candidate;
	// Tight: drop blank spacing lines below the head (e.g. the blank between
	// the options and the footer hint) before touching any content line.
	const stripped = candidate.filter((l, i) => i < keepHead || l.trim() !== "");
	if (stripped.length <= maxDialogLines) return stripped;
	// Bound still exhausted: keep the head, then the auditor toggle line (the
	// actionable status control — its feedback must stay visible), then spend
	// the room on the tail (options/footer/bottom border — the decision
	// surface — kept from its end so the border and footer never drop), then on
	// the tasks from the start. The dropped task lines remain fully readable in
	// the scrollback presentation. Never exceeds maxDialogLines.
	const tailNoBlanks = tail.filter((l) => l.trim() !== "");
	const hasAuditor = tail.length > 0 && /Auditor (enabled|disabled).*to toggle/.test(stripAnsiCodes(tail[0]!));
	const restTail = hasAuditor ? tailNoBlanks.slice(1) : tailNoBlanks;
	const keepRest = Math.min(restTail.length, Math.max(0, maxDialogLines - keepHead - (hasAuditor ? 1 : 0)));
	const tailKept = [...(hasAuditor ? [tail[0]!] : []), ...restTail.slice(restTail.length - keepRest)];
	const keepTasks = Math.min(tasks.length, Math.max(0, maxDialogLines - keepHead - tailKept.length));
	return [...head, ...tasks.slice(0, keepTasks), ...tailKept];
}

/**
 * Options-first fit: every option line always stays in frame. When the
 * question + context + options exceed the bound, the question/context
 * section yields first (it remains in the agent transcript): middle lines
 * (blanks, auditor, "Current:", context) drop before the question block
 * and the footer hint, and the tail slack (blank/footer) gives way before
 * the question. Returns null when even the option block + borders cannot
 * fit (pathological) so the caller falls back to the scroll viewport.
 */
export function fitOptionsInFrame(
	lines: string[],
	maxDialogLines: number,
	questionBlockEnd: number,
	optionsStart: number,
	lastOptionLine: number,
): string[] | null {
	if (maxDialogLines <= 0 || lines.length <= maxDialogLines) return lines;
	if (optionsStart < 0 || lastOptionLine < optionsStart) return null;
	const head = lines.slice(0, Math.max(questionBlockEnd, 1));
	const middle = lines.slice(Math.max(questionBlockEnd, 1), optionsStart);
	const tail = lines.slice(optionsStart);
	const optionsBlockLen = lastOptionLine - optionsStart + 1;
	// The option block + bottom border must fit on their own; otherwise the
	// scroll viewport is the last resort (nothing is ever hidden).
	if (optionsBlockLen + 1 > maxDialogLines) return null;
	// Shrink the middle from its end: blanks first, then auditor/Current/
	// context lines — the question block is untouched.
	const mid = middle.slice();
	while (head.length + mid.length + tail.length > maxDialogLines && mid.length > 0) {
		let blankIdx = -1;
		for (let i = mid.length - 1; i >= 0; i--) {
			if (mid[i]!.trim() === "") { blankIdx = i; break; }
		}
		if (blankIdx >= 0) mid.splice(blankIdx, 1);
		else mid.pop();
	}
	// Still over: the tail gives its slack (blank between options and
	// footer, then the footer hint) before the question block does. Never
	// drop the option block or the bottom border.
	const tailKept = tail.slice();
	while (head.length + mid.length + tailKept.length > maxDialogLines && tailKept.length > optionsBlockLen + 1) {
		// Prefer removing a blank line (never the options or the border),
		// then the line just above the bottom border (the footer hint).
		let tailBlank = -1;
		for (let i = tailKept.length - 2; i >= 1; i--) {
			if (tailKept[i]!.trim() === "") { tailBlank = i; break; }
		}
		if (tailBlank >= 1) tailKept.splice(tailBlank, 1);
		else tailKept.splice(tailKept.length - 2, 1);
	}
	// Still over: give the question block's trailing wrap lines (then the
	// question itself) before giving up — options + borders always stay.
	const headKept = head.slice();
	while (head.length + mid.length + tailKept.length > maxDialogLines && headKept.length > 1) {
		headKept.pop();
	}
	if (headKept.length + mid.length + tailKept.length > maxDialogLines) return null;
	return [...headKept, ...mid, ...tailKept];
}
