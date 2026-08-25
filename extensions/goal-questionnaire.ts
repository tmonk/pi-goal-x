import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Editor, type EditorTheme, Key, matchesKey, Text, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";


export type GoalDraftingFocus = "goal" | "sisyphus";

export interface GoalQuestionnaireQuestion {
	id: string;
	question: string;
	context?: string;
	options: string[];
	recommended?: number;
	allowCustom?: boolean;
}

export interface GoalQuestionnaireAnswer {
	id: string;
	question: string;
	answer: string;
	wasCustom: boolean;
}

export interface GoalQuestionnaireResult {
	questions: GoalQuestionnaireQuestion[];
	answers: GoalQuestionnaireAnswer[];
	cancelled: boolean;
	auditorEnabled?: boolean;
	/**
	 * The host could not present the dialog at all, so `cancelled` reflects an
	 * absent UI rather than a decision the user made. Hosts that expose a
	 * non-terminal UI keep `ctx.hasUI` true while `ctx.ui.custom` stays the
	 * SDK's headless default, which resolves to `undefined`.
	 */
	unavailable?: boolean;
}

export type ProposalDecision = "confirm" | "continue" | "cancel";

/**
 * Bound a custom dialog using the regular renderer's frame cache when
 * available. The pi 0.84 fullscreen renderer does not expose that cache, so
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
export interface ProposalPresentationSegments {
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
		if (lines[i]!.includes("press 'a' to toggle")) {
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
): string[] {
	if (maxDialogLines <= 0 || lines.length <= maxDialogLines) return lines;
	const keepHead = Math.min(protectedHead, maxDialogLines);
	if (proposal) {
		return fitProposalPresentation(lines, maxDialogLines, keepHead, proposal);
	}
	if (scroll) {
		return fitDialogViewport(lines, maxDialogLines, scroll, dimStyle);
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
		viewport[0] = dimStyle(`▲ ${hiddenAbove} more`);
	}
	if (hiddenBelow > 0) {
		// The reserved bottom edge row advertises the scroll affordance — it
		// replaces the border while content is clipped below (mirrors the
		// dashboard's `… +N more task` rows) and gives way to the border at the
		// end. The footer hint sits directly above the border, so it is only
		// visible when the end is reached (never while clipped — geometry).
		viewport.push(dimStyle(`… +${hiddenBelow} more · PgUp/PgDn scroll`));
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
	const hasAuditor = tail.length > 0 && tail[0]!.includes("press 'a' to toggle");
	const restTail = hasAuditor ? tailNoBlanks.slice(1) : tailNoBlanks;
	const keepRest = Math.min(restTail.length, Math.max(0, maxDialogLines - keepHead - (hasAuditor ? 1 : 0)));
	const tailKept = [...(hasAuditor ? [tail[0]!] : []), ...restTail.slice(restTail.length - keepRest)];
	const keepTasks = Math.min(tasks.length, Math.max(0, maxDialogLines - keepHead - tailKept.length));
	return [...head, ...tasks.slice(0, keepTasks), ...tailKept];
}

export function normalizeQuestionnaireQuestions(rawQuestions: GoalQuestionnaireQuestion[]): GoalQuestionnaireQuestion[] {
	const seenIds = new Set<string>();
	return rawQuestions.map((q, i) => {
		let id = q.id.trim() || `q${i + 1}`;
		if (seenIds.has(id)) id = `${id}-${i + 1}`;
		seenIds.add(id);
		const options = q.options.filter((option) => option.trim().length > 0);
		const recommended = q.recommended !== undefined && q.recommended >= 0 && q.recommended < options.length
			? q.recommended
			: undefined;
		return { ...q, id, options, recommended, allowCustom: q.allowCustom ?? true };
	});
}

export function formatQuestionnaireAnswers(result: GoalQuestionnaireResult): string {
	return result.answers.map((answer) => {
		const question = result.questions.find((q) => q.id === answer.id);
		const lines = [`**Q:** ${answer.question}`];
		if (question?.context) lines.push(`\n${question.context}`);
		if (question && question.options.length > 0) lines.push(`\nOptions: ${question.options.join(" / ")}`);
		lines.push(`\n**A:** ${answer.answer}`);
		return lines.join("");
	}).join("\n\n---\n\n");
}

export function shouldAutoConfirmProposal(args: { hasUI: boolean; autoConfirmEnv?: string }): boolean {
	if (args.autoConfirmEnv === "0") return false; // explicit opt-out (benchmarking)
	return !args.hasUI || args.autoConfirmEnv === "1";
}

export function proposalDecisionFromQuestionnaireResult(args: { cancelled: boolean; answer?: string }): ProposalDecision {
	if (args.cancelled) return "continue"; // never trapped; escape keeps refining
	if ((args.answer ?? "").startsWith("Confirm")) return "confirm";
	if ((args.answer ?? "").startsWith("Cancel")) return "cancel";
	return "continue";
}

export function isHeadlessQuestionSufficientForDraft(args: { topic: string; questionText: string }): boolean {
	const topic = args.topic.toLowerCase();
	void args;
	const vagueTopic = topic.trim().length < 20 || /(整理笔记|organize notes|notes|笔记)$/.test(topic.trim());
	return !vagueTopic;
}

export const DIALOG_UNAVAILABLE_HINT = "This host cannot display goal-drafting dialogs (ui.custom is unavailable outside pi's terminal UI). Set PI_GOAL_AUTO_CONFIRM=1 to confirm proposals without a dialog, or run the draft from the pi TUI.";

export function proposalDialogFailureMessage(error: unknown): string {
	const detail = error instanceof Error ? error.message : String(error);
	return `Goal draft confirmation failed: ${detail}. The goal was NOT created; drafting remains active.`;
}

/**
 * Shared question UI used by both the agent-callable goal_questionnaire tool and
 * the internal draft-confirm prompt. This keeps pi-goal self-contained and
 * avoids depending on external question/questionnaire packages.
 */
export async function runGoalQuestionnaire(ctx: ExtensionContext, rawQuestions: GoalQuestionnaireQuestion[], auditorToggleInit?: { defaultEnabled: boolean }): Promise<GoalQuestionnaireResult> {
	if (!ctx.hasUI) {
		return { questions: [], answers: [], cancelled: true };
	}

	const questions = normalizeQuestionnaireQuestions(rawQuestions);
	const isMulti = questions.length > 1;
	const totalTabs = questions.length + 1;

	const result = await ctx.ui.custom<GoalQuestionnaireResult>((tui, theme, _kb, done) => {
		// Suppress hardware cursor during dialog to reduce TUI auto-scroll
		// (the TUI render loop runs at ~60fps and writes ANSI cursor positioning
		// sequences every cycle, which can cause terminal viewport snapping).
		const wasHardwareCursorShown = tui.getShowHardwareCursor();
		tui.setShowHardwareCursor(false);
		// Pause pi's working spinner for the dialog duration: its ~80ms
		// re-renders write output while the user is scrolled up reading the
		// proposal, which snaps the terminal viewport back to the bottom
		// ("terminal scrolls back down after X seconds"). Restored on close.
		ctx.ui.setWorkingVisible(false);
		// Terminal-height bound: the dialog renders in the editor slot, so the opened
		// frame height is (pre-dialog frame - 1) + dialog lines. Bound the dialog so
		// the frame never exceeds the terminal height — without this, closing a dialog
		// taller than the terminal triggers pi-tui's generic shrink full-render
		// (\x1b[2J\x1b[H\x1b[3J), erasing terminal scrollback and yanking the viewport
		// so the window takes ~10s to scroll back to the bottom. The slice keeps
		// the question and the actionable options/footer in view (see
		// fitDialogLines); content that fits renders exactly as the
		// pre-regression (383ae52) UI. Only applies with real TUI dimensions.
		const tuiInfo = tui as unknown as { terminal?: { rows?: number }; previousLines?: string[] };
		const terminalRows = tuiInfo.terminal?.rows;
		const baseFrame = tuiInfo.previousLines?.length;
		const maxDialogLines = computeDialogLineLimit({ terminalRows, baseFrameLines: baseFrame });
		let currentTab = 0;
		let optionIndex = 0;
		let inputMode = false;
		let inputQuestionId: string | null = null;
		// Focusable container state: the TUI sets `focused` when the dialog has
		// focus; we propagate it to the embedded Editor while in input mode so
		// the editor emits CURSOR_MARKER and the hardware cursor is positioned
		// for IME input (pi docs/tui.md — Focusable Interface).
		let dialogFocused = false;
		let cachedLines: string[] | undefined;
		let optionsStartIndex = -1;
		// §options-scroll viewport state (select-mode + submit tabs only).
		let scrollTop = 0;
		let needsFollow = false;
		let optionRanges: Array<[number, number]> = [];
		let questionBlockEnd = -1;
		let auditorEnabled = auditorToggleInit?.defaultEnabled ?? true;
		const answers = new Map<string, GoalQuestionnaireAnswer>();
		const drafts = new Map<string, string>();

		const editorTheme: EditorTheme = {
			borderColor: (s) => theme.fg("accent", s),
			selectList: {
				selectedPrefix: (t) => theme.fg("accent", t),
				selectedText: (t) => theme.fg("accent", t),
				description: (t) => theme.fg("muted", t),
				scrollInfo: (t) => theme.fg("dim", t),
				noMatch: (t) => theme.fg("warning", t),
			},
		};
		const editor = new Editor(tui, editorTheme);

		function refresh() {
			cachedLines = undefined;
			tui.requestRender();
		}

		function submit(cancelled: boolean) {
			// Restore hardware cursor now that the dialog is closing
			tui.setShowHardwareCursor(wasHardwareCursorShown);
			// Resume pi's working spinner (the agent run is still active until agent_end).
			ctx.ui.setWorkingVisible(true);
			const ordered = questions.map((q) => answers.get(q.id)).filter((a): a is GoalQuestionnaireAnswer => !!a);
			done({ questions, answers: ordered, cancelled, auditorEnabled: auditorToggleInit ? auditorEnabled : undefined });
		}

		function currentQuestion(): GoalQuestionnaireQuestion | undefined {
			return questions[currentTab];
		}

		function displayOptions(): Array<{ label: string; isCustom?: boolean }> {
			const q = currentQuestion();
			if (!q) return [];
			const opts: Array<{ label: string; isCustom?: boolean }> = q.options.map((label) => ({ label }));
			if (q.allowCustom !== false) opts.push({ label: "Write your own answer...", isCustom: true });
			return opts;
		}

		function allAnswered(): boolean {
			return questions.every((q) => answers.has(q.id));
		}

		function enterQuestion(q: GoalQuestionnaireQuestion) {
			const existing = answers.get(q.id);
			const draft = drafts.get(q.id);
			// §options-scroll: start each question tab from the top.
			scrollTop = 0;
			needsFollow = false;
			if (q.options.length === 0) {
				inputMode = true;
				inputQuestionId = q.id;
				editor.setText(draft ?? (existing?.wasCustom ? existing.answer : ""));
				// Anchor the editor while the dialog has focus (see enterInputMode).
				editor.focused = dialogFocused;
				tui.setShowHardwareCursor(dialogFocused);
			} else if (existing?.wasCustom) {
				optionIndex = q.options.length;
			} else if (existing && !existing.wasCustom) {
				const idx = q.options.indexOf(existing.answer);
				optionIndex = idx >= 0 ? idx : 0;
			} else {
				optionIndex = q.recommended ?? 0;
			}
		}

		function enterSubmitTab() {
	// §options-scroll: the submit summary also opens from the top.
	optionIndex = 0;
	scrollTop = 0;
	needsFollow = false;
}

function advanceAfterAnswer() {
			if (!isMulti) {
				submit(false);
				return;
			}
			if (currentTab < questions.length - 1) currentTab++;
			else currentTab = questions.length;
			const nextQ = currentQuestion();
			if (nextQ) enterQuestion(nextQ);
			else enterSubmitTab();
			refresh();
		}

		function saveAnswer(qId: string, value: string, wasCustom: boolean) {
			const q = questions.find((qq) => qq.id === qId);
			answers.set(qId, { id: qId, question: q?.question ?? qId, answer: value, wasCustom });
		}

		/**
		 * Activate the answer editor for a question: position the hardware
		 * cursor and mark the Editor focused (emits CURSOR_MARKER for IME).
		 */
		/**
	 * §options-first fit: every option line always stays in frame. When the
	 * question + context + options exceed the bound, the question/context
	 * section yields first (it remains in the agent transcript): middle lines
	 * (blanks, auditor, "Current:", context) drop before the question block
	 * and the footer hint, and the tail slack (blank/footer) gives way before
	 * the question. Returns null when even the option block + borders cannot
	 * fit (pathological) so the caller falls back to the scroll viewport.
	 */
	function fitOptionsInFrame(
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

	function enterInputMode(qId: string) {
			inputMode = true;
			inputQuestionId = qId;
			const draft = drafts.get(qId);
			const existing = answers.get(qId);
			editor.setText(draft ?? (existing?.wasCustom ? existing.answer : ""));
			editor.focused = dialogFocused;
			tui.setShowHardwareCursor(dialogFocused);
		}

		/** Deactivate the answer editor: release the cursor and clear the editor. */
		function leaveInputMode() {
			inputMode = false;
			inputQuestionId = null;
			editor.focused = false;
			tui.setShowHardwareCursor(false);
			editor.setText("");
		}

		editor.onSubmit = (value) => {
			if (!inputQuestionId) return;
			const trimmed = value.trim();
			if (!trimmed) {
				refresh();
				return;
			}
			drafts.delete(inputQuestionId);
			saveAnswer(inputQuestionId, trimmed, true);
			leaveInputMode();
			advanceAfterAnswer();
		};

		function exitEditor() {
			if (inputQuestionId) {
				const text = editor.getText();
				if (text.trim()) drafts.set(inputQuestionId, text);
				else drafts.delete(inputQuestionId);
			}
			leaveInputMode();
		}

		enterQuestion(questions[0]!);

		function handleInput(data: string) {
			if (inputMode) {
				if (matchesKey(data, Key.escape)) {
					const q = currentQuestion();
					if (q && q.options.length === 0 && !isMulti) submit(true);
					else {
						exitEditor();
						refresh();
					}
					return;
				}
				if (isMulti && (matchesKey(data, Key.tab) || matchesKey(data, Key.shift("tab")))) {
					exitEditor();
					currentTab = matchesKey(data, Key.tab) ? (currentTab + 1) % totalTabs : (currentTab - 1 + totalTabs) % totalTabs;
					const nextQ = currentQuestion();
					if (nextQ) enterQuestion(nextQ);
					else enterSubmitTab();
					refresh();
					return;
				}
				editor.handleInput(data);
				refresh();
				return;
			}

			const q = currentQuestion();
			const opts = displayOptions();

			if (isMulti) {
				if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
					currentTab = (currentTab + 1) % totalTabs;
					const nextQ = currentQuestion();
					if (nextQ) enterQuestion(nextQ);
					else enterSubmitTab();
					refresh();
					return;
				}
				if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
					currentTab = (currentTab - 1 + totalTabs) % totalTabs;
					const nextQ = currentQuestion();
					if (nextQ) enterQuestion(nextQ);
					else enterSubmitTab();
					refresh();
					return;
				}
			}

			// §options-scroll viewport keys (select-mode question tabs AND the
			// submit summary): page and line scroll without moving the selection.
			// Handled before the submit-tab early return so the summary scrolls
			// too. ↑/↓ still select and auto-follow into view on the next render.
			if (matchesKey(data, Key.pageUp)) {
				scrollTop -= Math.max(1, (maxDialogLines ?? 10) - 1);
				needsFollow = false;
				refresh();
				return;
			}
			if (matchesKey(data, Key.pageDown)) {
				scrollTop += Math.max(1, (maxDialogLines ?? 10) - 1);
				needsFollow = false;
				refresh();
				return;
			}
			if (matchesKey(data, Key.ctrl("up"))) {
				scrollTop -= 1;
				needsFollow = false;
				refresh();
				return;
			}
			if (matchesKey(data, Key.ctrl("down"))) {
				scrollTop += 1;
				needsFollow = false;
				refresh();
				return;
			}

			if (currentTab === questions.length) {
				if (matchesKey(data, Key.enter) && allAnswered()) submit(false);
				else if (matchesKey(data, Key.escape)) submit(true);
				return;
			}

			if (matchesKey(data, Key.up)) {
				optionIndex = Math.max(0, optionIndex - 1);
				needsFollow = true; // §options-scroll: keep the selection visible
				refresh();
				return;
			}
			if (matchesKey(data, Key.down)) {
				optionIndex = Math.min(opts.length - 1, optionIndex + 1);
				needsFollow = true;
				refresh();
				return;
			}

			// Auditor toggle hotkey
			if (matchesKey(data, "a") && auditorToggleInit) {
				auditorEnabled = !auditorEnabled;
				refresh();
				return;
			}

			if (matchesKey(data, Key.enter) && q) {
				if (q.options.length === 0 || opts[optionIndex]?.isCustom) {
					enterInputMode(q.id);
					refresh();
					return;
				}
				const opt = opts[optionIndex];
				if (opt) {
					saveAnswer(q.id, opt.label, false);
					advanceAfterAnswer();
				}
				return;
			}

			if (matchesKey(data, Key.escape)) submit(true);
		}

			function render(width: number): string[] {
			if (cachedLines) return cachedLines;
			const safeWidth = Math.max(20, width);
			let lines: string[] = [];
			const q = currentQuestion();
			const opts = displayOptions();
			const add = (s: string) => lines.push(truncateToWidth(s, safeWidth, "…", true));
			const addWrapped = (s: string) => lines.push(...wrapTextWithAnsi(s, safeWidth));
			/**
			 * Wraps a pipe-prefixed line and prepends "│   " to continuation lines
			 * so wrapped content stays within the ASCII box.
			 */
			const PIPE_PREFIX = "│   ";
			const PIPE_WIDTH = visibleWidth(PIPE_PREFIX);
			const addWrappedPipe = (styledLine: string) => {
				const wrapWidth = Math.max(1, safeWidth - PIPE_WIDTH);
				const wrapped = wrapTextWithAnsi(styledLine, wrapWidth);
				for (let i = 0; i < wrapped.length; i++) {
					lines.push(i === 0 ? wrapped[i]! : PIPE_PREFIX + wrapped[i]!);
				}
			};

			/** Render context lines with per-line styling. No truncation. */
			const renderContextLines = (context: string): void => {
				const rawLines = context.split("\n");
				for (const rawLine of rawLines) {
					const trimmed = rawLine.trim();
					// Empty line — preserve as spacing
					if (!trimmed) {
						lines.push("");
						continue;
					}

					// 1. Announcement header — "● Goal draft/tweak ready for confirmation."
					if (/^● Goal (draft|tweak) ready for confirmation\.$/.test(trimmed)) {
						addWrapped(theme.fg("accent", rawLine));
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
						add(theme.fg("accent", left + namePart + "─".repeat(fill) + right));
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
							addWrappedPipe(linePrefix + theme.fg(color, bracket) + sep + theme.fg("muted", rest));
							continue;
						}
						// 3b. Key-value content (e.g. "│   Mode: Normal goal", "│   Auto-continue: yes")
						if (afterPipe.includes(": ")) {
							const colonIdx = afterPipe.indexOf(": ");
							const val = afterPipe.slice(colonIdx + 2).trim();
							const keyPart = rawLine.slice(0, rawLine.indexOf(afterPipe) + colonIdx + 2);
							if (val === "yes" || val === "no") {
								addWrappedPipe(theme.fg("muted", keyPart) + theme.fg(val === "yes" ? "success" : "warning", val));
								continue;
							}
							addWrappedPipe(theme.fg("muted", rawLine));
							continue;
						}
						// 3c. Generic content under │ prefix (topic, goal text, etc.)
						addWrappedPipe(theme.fg("muted", rawLine));
						continue;
					}

					// 4. Goal objective structure lines — detected before task checkboxes
					// because === Goal could overlap with ─── markers but we already checked those.
					const GOAL_SECTION_RE = /^(=== (Goal|Sisyphus Goal) ===|Objective:|Success criteria:|Boundaries:|Constraints:|Verification contract:|If blocked:)/;
					if (GOAL_SECTION_RE.test(trimmed)) {
						addWrapped(theme.fg("accent", rawLine));
						continue;
					}

					// 5. Actual box-drawing borders (┌ └ ├ └ ┐ ┤ ┘ ─) — NOT │ which is handled above
					if (/^[┌├└┐┤┘─]/.test(trimmed)) {
						addWrapped(theme.fg("dim", rawLine));
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
						addWrapped(indent + theme.fg(color, bracket) + sep + theme.fg("muted", rest));
						continue;
					}

					// 7. Default: any remaining content (fallback)
					addWrapped(theme.fg("muted", rawLine));
				}
			};

			add(theme.fg("accent", "─".repeat(safeWidth)));
			// Lines up to the question line (top border, tabs, question incl.
			// wraps) are the protected head — the slice below must never hide them.
			let protectedCount = lines.length;
			if (isMulti) {
				const tabs: string[] = ["← "];
				for (let i = 0; i < questions.length; i++) {
					const isActive = i === currentTab;
					const isAnswered = answers.has(questions[i]!.id);
					const label = ` ${isAnswered ? "■" : "□"} ${questions[i]!.id} `;
					tabs.push(isActive ? theme.bg("selectedBg", theme.fg("text", label)) : theme.fg(isAnswered ? "success" : "muted", label));
					tabs.push(" ");
				}
				const submitText = " ✓ Submit ";
				tabs.push(currentTab === questions.length ? theme.bg("selectedBg", theme.fg("text", submitText)) : theme.fg(allAnswered() ? "success" : "dim", submitText));
				tabs.push(" →");
				add(` ${tabs.join("")}`);
				lines.push("");
				protectedCount = lines.length;
			}

			function renderOptions() {
				optionsStartIndex = lines.length;
				for (let i = 0; i < opts.length; i++) {
					const start = lines.length;
					const opt = opts[i]!;
					const selected = i === optionIndex;
					const prefix = selected ? theme.fg("accent", "> ") : "  ";
					const recTag = !opt.isCustom && q?.recommended === i ? theme.fg("success", " ★") : "";
					addWrapped(prefix + theme.fg(selected ? "accent" : "text", `${i + 1}. ${opt.label}`) + recTag);
					optionRanges[i] = [start, lines.length - 1];
				}
			}

			if (inputMode && q) {
				addWrapped(theme.fg("text", ` ${q.question}`));
				protectedCount = lines.length;
				if (q.context) renderContextLines(q.context);
				lines.push("");
				if (q.options.length > 0) {
					renderOptions();
					lines.push("");
				}
				add(theme.fg("muted", " Your answer:"));
				for (const line of editor.render(safeWidth - 2)) add(` ${line}`);
				lines.push("");
				add(theme.fg("dim", " Enter to submit • Esc to cancel"));
			} else if (currentTab === questions.length) {
				add(theme.fg("accent", theme.bold(" Ready to submit")));
				protectedCount = lines.length;
				lines.push("");
				for (const question of questions) {
					const answer = answers.get(question.id);
					add(`${theme.fg("muted", ` ${question.id}: `)}${answer ? theme.fg("text", `${answer.wasCustom ? "(wrote) " : ""}${answer.answer}`) : theme.fg("warning", "(unanswered)")}`);
				}
				lines.push("");
				add(allAnswered() ? theme.fg("success", " Press Enter to submit") : theme.fg("warning", ` Unanswered: ${questions.filter((qq) => !answers.has(qq.id)).map((qq) => qq.id).join(", ")}`));
			} else if (q) {
				addWrapped(theme.fg("text", ` ${q.question}`));
				questionBlockEnd = lines.length;
				protectedCount = lines.length;
				if (q.context) renderContextLines(q.context);
				// Auditor toggle line between context and options
				if (auditorToggleInit) {
					const circle = auditorEnabled ? "●" : "○";
					const label = auditorEnabled ? "Auditor enabled" : "Auditor disabled";
					const color = auditorEnabled ? "success" : "warning";
					add(theme.fg(color, ` ${circle} ${label}`) + theme.fg("dim", "  (press 'a' to toggle)"));
					lines.push("");
				}
				const existing = answers.get(q.id);
				if (existing) add(theme.fg("dim", ` Current: ${existing.wasCustom ? "(wrote) " : ""}${existing.answer}`));
				lines.push("");
				if (opts.length > 0) renderOptions();
				else add(theme.fg("muted", " Press Enter to write your answer"));
			}

			lines.push("");
			if (!inputMode) {
				const auditorHint = auditorToggleInit ? " • a toggle auditor" : "";
				add(theme.fg("dim", isMulti ? " Tab/←→ navigate • ↑↓ select • Enter confirm • Esc cancel" + auditorHint : " ↑↓ navigate • Enter select • Esc cancel" + auditorHint));
			}
			add(theme.fg("accent", "─".repeat(safeWidth)));
			// Safety net: ensure no returned line exceeds the terminal width
			for (let i = 0; i < lines.length; i++) {
				const line = lines[i];
				if (line && visibleWidth(line) > safeWidth) {
					lines[i] = truncateToWidth(line, safeWidth);
				}
			}
			// Churn guard: bound to the terminal height (see factory top) so the
			// opened frame never exceeds the screen. Never slice the question:
			// keep the protected head, then spend the rest of the budget on the
			// tail (options/footer/bottom border) — or, for plain select-mode
			// questions where the options start right after the head, keep the
			// top options so the recommended one stays visible. Proposal
			// confirmations additionally keep the tasks section in frame; the
			// objective-box middle is sacrificed there because the full objective
			// is always in the scrollable transcript presentation (renderCall).
			if (maxDialogLines !== undefined && lines.length > maxDialogLines) {
				const proposalSegments = !inputMode && currentTab !== questions.length && !!q && q.context
					? findProposalPresentationSegments(lines, optionsStartIndex)
					: null;
				if (proposalSegments) {
					// Proposal confirmations keep their segment protection (tasks +
					// auditor + options within the bound; the objective-box middle
					// stays in the scrollback presentation).
					lines = fitDialogLines(lines, maxDialogLines, protectedCount, proposalSegments);
				} else if (!inputMode && currentTab !== questions.length && questionBlockEnd >= 0) {
					// Plain select-mode question tab: all options in frame;
					// question/context yields first (it stays in the transcript).
					const fitted = fitOptionsInFrame(lines, maxDialogLines, questionBlockEnd, optionsStartIndex, optionRanges[optionRanges.length - 1]?.[1] ?? -1);
					if (fitted) {
						lines = fitted;
						scrollTop = 0;
						needsFollow = false;
					} else {
						// Pathological: options alone overflow the bound — scroll
						// viewport is the last resort (nothing ever hidden).
						const scrollState = { scrollTop, needsFollow, optionRanges, followIndex: optionIndex };
						lines = fitDialogLines(lines, maxDialogLines, protectedCount, null, scrollState, (s) => theme.fg("dim", s));
						scrollTop = scrollState.scrollTop;
						needsFollow = scrollState.needsFollow;
					}
				} else {
					// Input mode, submit tab: legacy tail-keep / viewport behavior.
					const scrollState = !inputMode ? { scrollTop, needsFollow, optionRanges, followIndex: optionIndex } : null;
					lines = fitDialogLines(lines, maxDialogLines, protectedCount, null, scrollState, (s) => theme.fg("dim", s));
					if (scrollState) {
						scrollTop = scrollState.scrollTop;
						needsFollow = scrollState.needsFollow;
					}
				}
			}
			cachedLines = lines;
			return lines;
		}

		return {
			render,
			invalidate: () => { cachedLines = undefined; },
			handleInput,
			// Focusable (pi docs/tui.md): propagate focus to the embedded Editor
			// so it emits CURSOR_MARKER and the hardware cursor is positioned
			// correctly for IME input while the answer editor is active.
			get focused(): boolean { return dialogFocused; },
			set focused(v: boolean) {
				dialogFocused = v;
				editor.focused = v && inputMode;
				tui.setShowHardwareCursor(v && inputMode);
			},
		};
	});
	// `ctx.hasUI` only reports that a UI context is installed, not that it can
	// render a TUI component. Hosts embedding pi behind a non-terminal UI (a
	// browser, for one) install a real UI context - so `hasUI` is true - while
	// `ui.custom` remains the SDK's headless default and resolves to undefined.
	// Reading `.cancelled` off that crashed every drafting tool on those hosts.
	return result ?? { questions: [], answers: [], cancelled: true, unavailable: true };
}

/**
 * Confirm a proposed draft through the shared questionnaire UI. Escape / cancel
 * maps to "continue" so the user is never trapped.
 */
export async function showProposalDialog(
	ctx: ExtensionContext,
	confirmationText: string,
	focus: GoalDraftingFocus,
	defaultAuditorEnabled?: boolean,
): Promise<{ decision: ProposalDecision; auditorEnabled: boolean; unavailable: boolean }> {
	const headerTitle = focus === "sisyphus" ? "Confirm Sisyphus Goal Draft" : "Confirm Goal Draft";
	const result = await runGoalQuestionnaire(ctx, [{
		id: "confirm",
		question: headerTitle,
		context: confirmationText,
		options: ["Confirm — create this goal now", "Continue chatting — keep refining", "Cancel — discard this draft"],
		recommended: 0,
		allowCustom: false,
	}], defaultAuditorEnabled !== undefined ? { defaultEnabled: defaultAuditorEnabled } : undefined);
	const decision = proposalDecisionFromQuestionnaireResult({
		cancelled: result.cancelled,
		answer: result.answers[0]?.answer,
	});
	return { decision, auditorEnabled: result.auditorEnabled ?? true, unavailable: result.unavailable === true };
}
