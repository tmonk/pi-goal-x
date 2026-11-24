import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { findProposalPresentationSegments, fitDialogLines, fitOptionsInFrame } from "../goal-dialog-fit.ts";
import { truncateToWidth, wrapTextWithAnsi } from "../widgets/text-cache.ts";
import { renderContextLines } from "./context.ts";
import { allAnswered, currentQuestion, displayOptions, onSubmitTab, type QuestionnaireState } from "./state.ts";
import type { DialogControls } from "./types.ts";

/**
 * Where the last render put things. It is deliberately kept between renders:
 * a tab that draws no options leaves the previous values in place, exactly as
 * the closure-local variables used to.
 */
export interface RenderLayout {
	/** First option line, or -1 before any options were drawn. */
	optionsStartIndex: number;
	/** [first, last] line of each option. */
	optionRanges: Array<[number, number]>;
	/** Line after the question text on a select-mode tab, or -1. */
	questionBlockEnd: number;
}

export function createRenderLayout(): RenderLayout {
	return { optionsStartIndex: -1, optionRanges: [], questionBlockEnd: -1 };
}

export interface RenderArgs {
	/** Read for content; only `scrollTop` and `needsFollow` are written, when the viewport settles. */
	state: QuestionnaireState;
	layout: RenderLayout;
	theme: Theme;
	controls: DialogControls;
	editor: { render(width: number): string[] };
	width: number;
	/** Terminal-height bound for the dialog, when the host reports one. */
	maxDialogLines: number | undefined;
}

const PIPE_PREFIX = "│   ";
const PIPE_WIDTH = visibleWidth(PIPE_PREFIX);

/** Build the dialog's lines for the current state, bounded to the terminal height. */
export function renderQuestionnaire(args: RenderArgs): string[] {
	const { state, layout, theme, controls, editor, width, maxDialogLines } = args;
	const { questions, currentTab, inputMode, answers } = state;
	const safeWidth = Math.max(20, width);
	let lines: string[] = [];
	const q = currentQuestion(state);
	const opts = displayOptions(state);
	const add = (s: string) => lines.push(truncateToWidth(s, safeWidth, "…", true));
	const addWrapped = (s: string) => lines.push(...wrapTextWithAnsi(s, safeWidth));
	// Wraps a pipe-prefixed line and prepends "│   " to continuation lines
	// so wrapped content stays within the ASCII box.
	const addWrappedPipe = (styledLine: string) => {
		const wrapWidth = Math.max(1, safeWidth - PIPE_WIDTH);
		const wrapped = wrapTextWithAnsi(styledLine, wrapWidth);
		for (let i = 0; i < wrapped.length; i++) {
			lines.push(i === 0 ? wrapped[i]! : PIPE_PREFIX + wrapped[i]!);
		}
	};
	const context = (text: string) => renderContextLines(text, {
		line: add,
		wrapped: addWrapped,
		wrappedPipe: addWrappedPipe,
		blank: () => lines.push(""),
	}, theme, safeWidth);

	add(theme.fg("accent", "─".repeat(safeWidth)));
	// Lines up to the question line (top border, tabs, question incl.
	// wraps) are the protected head — the slice below must never hide them.
	let protectedCount = lines.length;
	if (state.isMulti) {
		const tabs: string[] = ["← "];
		for (let i = 0; i < questions.length; i++) {
			const isActive = i === currentTab;
			const isAnswered = answers.has(questions[i]!.id);
			const label = ` ${isAnswered ? "■" : "□"} ${questions[i]!.id} `;
			tabs.push(isActive ? theme.bg("selectedBg", theme.fg("text", label)) : theme.fg(isAnswered ? "success" : "muted", label));
			tabs.push(" ");
		}
		const submitText = " ✓ Submit ";
		tabs.push(onSubmitTab(state) ? theme.bg("selectedBg", theme.fg("text", submitText)) : theme.fg(allAnswered(state) ? "success" : "dim", submitText));
		tabs.push(" →");
		add(` ${tabs.join("")}`);
		lines.push("");
		protectedCount = lines.length;
	}

	function renderOptions() {
		layout.optionsStartIndex = lines.length;
		for (let i = 0; i < opts.length; i++) {
			const start = lines.length;
			const opt = opts[i]!;
			const selected = i === state.optionIndex;
			const prefix = selected ? theme.fg("accent", "> ") : "  ";
			const recTag = !opt.isCustom && q?.recommended === i ? theme.fg("success", " ★") : "";
			addWrapped(prefix + theme.fg(selected ? "accent" : "text", `${i + 1}. ${opt.label}`) + recTag);
			layout.optionRanges[i] = [start, lines.length - 1];
		}
	}

	if (inputMode && q) {
		addWrapped(theme.fg("text", ` ${q.question}`));
		protectedCount = lines.length;
		if (q.context) context(q.context);
		lines.push("");
		if (q.options.length > 0) {
			renderOptions();
			lines.push("");
		}
		add(theme.fg("muted", " Your answer:"));
		for (const line of editor.render(safeWidth - 2)) add(` ${line}`);
		lines.push("");
		add(theme.fg("dim", ` Enter to submit • ${controls.editorCancelHint()} to cancel`));
	} else if (onSubmitTab(state)) {
		add(theme.fg("accent", theme.bold(" Ready to submit")));
		protectedCount = lines.length;
		lines.push("");
		for (const question of questions) {
			const answer = answers.get(question.id);
			add(`${theme.fg("muted", ` ${question.id}: `)}${answer ? theme.fg("text", `${answer.wasCustom ? "(wrote) " : ""}${answer.answer}`) : theme.fg("warning", "(unanswered)")}`);
		}
		lines.push("");
		add(allAnswered(state) ? theme.fg("success", ` Press ${controls.hint("confirm")} to submit`) : theme.fg("warning", ` Unanswered: ${questions.filter((qq) => !answers.has(qq.id)).map((qq) => qq.id).join(", ")}`));
	} else if (q) {
		addWrapped(theme.fg("text", ` ${q.question}`));
		layout.questionBlockEnd = lines.length;
		protectedCount = lines.length;
		if (q.context) context(q.context);
		// Auditor toggle line between context and options
		if (state.hasAuditorToggle) {
			const circle = state.auditorEnabled ? "●" : "○";
			const label = state.auditorEnabled ? "Auditor enabled" : "Auditor disabled";
			const color = state.auditorEnabled ? "success" : "warning";
			add(theme.fg(color, ` ${circle} ${label}`) + theme.fg("dim", `  (press '${controls.hint("toggleAuditor")}' to toggle)`));
			lines.push("");
		}
		const existing = answers.get(q.id);
		if (existing) add(theme.fg("dim", ` Current: ${existing.wasCustom ? "(wrote) " : ""}${existing.answer}`));
		lines.push("");
		if (opts.length > 0) renderOptions();
		else add(theme.fg("muted", ` Press ${controls.hint("confirm")} to write your answer`));
	}

	lines.push("");
	if (!inputMode) {
		const auditorHint = state.hasAuditorToggle ? ` • ${controls.hint("toggleAuditor")} toggle auditor` : "";
		add(theme.fg("dim", state.isMulti ? ` ${controls.hint("next")}/${controls.hint("previous")} navigate • ${controls.navigationHint()} select • ${controls.hint("confirm")} confirm • ${controls.hint("cancel")} cancel` + auditorHint : ` ${controls.navigationHint()} navigate • ${controls.hint("confirm")} select • ${controls.hint("cancel")} cancel` + auditorHint));
	}
	add(theme.fg("accent", "─".repeat(safeWidth)));
	// Safety net: ensure no returned line exceeds the terminal width
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (line && visibleWidth(line) > safeWidth) {
			lines[i] = truncateToWidth(line, safeWidth);
		}
	}
	// Churn guard: bound to the terminal height so the opened frame never
	// exceeds the screen. Never slice the question: keep the protected head,
	// then spend the rest of the budget on the tail (options/footer/bottom
	// border) — or, for plain select-mode questions where the options start
	// right after the head, keep the top options so the recommended one stays
	// visible. Proposal confirmations additionally keep the tasks section in
	// frame; the objective-box middle is sacrificed there because the full
	// objective is always in the scrollable transcript presentation
	// (renderCall).
	if (maxDialogLines !== undefined && lines.length > maxDialogLines) {
		const hint = (s: string) => theme.fg("dim", s);
		const proposalSegments = !inputMode && !onSubmitTab(state) && !!q && q.context
			? findProposalPresentationSegments(lines, layout.optionsStartIndex)
			: null;
		if (proposalSegments) {
			// Proposal confirmations keep their segment protection (tasks +
			// auditor + options within the bound; the objective-box middle
			// stays in the scrollback presentation).
			lines = fitDialogLines(lines, maxDialogLines, protectedCount, proposalSegments);
		} else if (!inputMode && !onSubmitTab(state) && layout.questionBlockEnd >= 0) {
			// Plain select-mode question tab: all options in frame;
			// question/context yields first (it stays in the transcript).
			const fitted = fitOptionsInFrame(lines, maxDialogLines, layout.questionBlockEnd, layout.optionsStartIndex, layout.optionRanges[layout.optionRanges.length - 1]?.[1] ?? -1);
			if (fitted) {
				lines = fitted;
				state.scrollTop = 0;
				state.needsFollow = false;
			} else {
				// Pathological: options alone overflow the bound — scroll
				// viewport is the last resort (nothing ever hidden).
				const scrollState = { scrollTop: state.scrollTop, needsFollow: state.needsFollow, optionRanges: layout.optionRanges, followIndex: state.optionIndex };
				lines = fitDialogLines(lines, maxDialogLines, protectedCount, null, scrollState, hint, controls.pagingHint());
				state.scrollTop = scrollState.scrollTop;
				state.needsFollow = scrollState.needsFollow;
			}
		} else {
			// Input mode, submit tab: legacy tail-keep / viewport behavior.
			const scrollState = !inputMode ? { scrollTop: state.scrollTop, needsFollow: state.needsFollow, optionRanges: layout.optionRanges, followIndex: state.optionIndex } : null;
			lines = fitDialogLines(lines, maxDialogLines, protectedCount, null, scrollState, hint, controls.pagingHint());
			if (scrollState) {
				state.scrollTop = scrollState.scrollTop;
				state.needsFollow = scrollState.needsFollow;
			}
		}
	}
	return lines;
}
