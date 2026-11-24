import type { GoalQuestionnaireAnswer, GoalQuestionnaireQuestion } from "./types.ts";
import { t } from "../i18n/index.ts";

/**
 * Everything the dialog remembers between key presses: answers, drafts, which
 * tab and option are selected, and the options scroll position. Plain data plus
 * the functions below, so it can be tested without a terminal.
 *
 * Tabs run 0..questions.length - 1 for questions; the last tab is the submit summary.
 */
export interface QuestionnaireState {
	questions: GoalQuestionnaireQuestion[];
	isMulti: boolean;
	/** Whether the dialog offers the auditor toggle at all. */
	hasAuditorToggle: boolean;
	auditorEnabled: boolean;
	currentTab: number;
	optionIndex: number;
	/** True while the free-text answer editor is open for `inputQuestionId`. */
	inputMode: boolean;
	inputQuestionId: string | null;
	/** Options viewport (select-mode and submit tabs only). */
	scrollTop: number;
	needsFollow: boolean;
	answers: Map<string, GoalQuestionnaireAnswer>;
	/** Unsent editor text, kept per question when the editor is left. */
	drafts: Map<string, string>;
}

export interface DisplayOption {
	label: string;
	isCustom?: boolean;
}

/** What the dialog should do after an answer is recorded. */
export type AfterAnswer = "submit" | "input" | "select";

export function createQuestionnaireState(questions: GoalQuestionnaireQuestion[], auditorToggleInit?: { defaultEnabled: boolean }): QuestionnaireState {
	return {
		questions,
		isMulti: questions.length > 1,
		hasAuditorToggle: auditorToggleInit !== undefined,
		auditorEnabled: auditorToggleInit?.defaultEnabled ?? true,
		currentTab: 0,
		optionIndex: 0,
		inputMode: false,
		inputQuestionId: null,
		scrollTop: 0,
		needsFollow: false,
		answers: new Map(),
		drafts: new Map(),
	};
}

export function totalTabs(state: QuestionnaireState): number {
	return state.questions.length + 1;
}

export function onSubmitTab(state: QuestionnaireState): boolean {
	return state.currentTab === state.questions.length;
}

export function currentQuestion(state: QuestionnaireState): GoalQuestionnaireQuestion | undefined {
	return state.questions[state.currentTab];
}

export function displayOptions(state: QuestionnaireState): DisplayOption[] {
	const q = currentQuestion(state);
	if (!q) return [];
	const opts: DisplayOption[] = q.options.map((label) => ({ label }));
	if (q.allowCustom !== false) opts.push({ label: t("Write your own answer..."), isCustom: true });
	return opts;
}

export function allAnswered(state: QuestionnaireState): boolean {
	return state.questions.every((q) => state.answers.has(q.id));
}

/** Answers in question order, as the result reports them. */
export function orderedAnswers(state: QuestionnaireState): GoalQuestionnaireAnswer[] {
	return state.questions.map((q) => state.answers.get(q.id)).filter((a): a is GoalQuestionnaireAnswer => !!a);
}

export function saveAnswer(state: QuestionnaireState, qId: string, value: string, wasCustom: boolean): void {
	const q = state.questions.find((qq) => qq.id === qId);
	state.answers.set(qId, { id: qId, question: q?.question ?? qId, answer: value, wasCustom });
}

/** Text the answer editor starts with: an unsent draft, else a previous custom answer. */
export function editorTextFor(state: QuestionnaireState, qId: string): string {
	const existing = state.answers.get(qId);
	return state.drafts.get(qId) ?? (existing?.wasCustom ? existing.answer : "");
}

export function startInput(state: QuestionnaireState, qId: string): void {
	state.inputMode = true;
	state.inputQuestionId = qId;
}

export function stopInput(state: QuestionnaireState): void {
	state.inputMode = false;
	state.inputQuestionId = null;
}

/** Keep (or drop, when blank) the editor text for the question being edited. */
export function stashDraft(state: QuestionnaireState, text: string): void {
	if (!state.inputQuestionId) return;
	if (text.trim()) state.drafts.set(state.inputQuestionId, text);
	else state.drafts.delete(state.inputQuestionId);
}

/**
 * Land on a question tab: restart the viewport and pick the starting option
 * (the existing answer, else the recommended one). Returns true when the
 * question has no options, so the answer editor opened instead.
 */
export function enterQuestion(state: QuestionnaireState, q: GoalQuestionnaireQuestion): boolean {
	const existing = state.answers.get(q.id);
	// Start each question tab from the top.
	state.scrollTop = 0;
	state.needsFollow = false;
	if (q.options.length === 0) {
		startInput(state, q.id);
		return true;
	}
	if (existing?.wasCustom) {
		state.optionIndex = q.options.length;
	} else if (existing) {
		const idx = q.options.indexOf(existing.answer);
		state.optionIndex = idx >= 0 ? idx : 0;
	} else {
		state.optionIndex = q.recommended ?? 0;
	}
	return false;
}

/** The submit summary also opens from the top. */
export function enterSubmitTab(state: QuestionnaireState): void {
	state.optionIndex = 0;
	state.scrollTop = 0;
	state.needsFollow = false;
}

/** Switch to a tab (question or submit). Returns true when the answer editor opened. */
export function goToTab(state: QuestionnaireState, tab: number): boolean {
	state.currentTab = tab;
	const q = currentQuestion(state);
	if (!q) {
		enterSubmitTab(state);
		return false;
	}
	return enterQuestion(state, q);
}

/** Move to the next (+1) or previous (-1) tab, wrapping around. */
export function stepTab(state: QuestionnaireState, delta: 1 | -1): boolean {
	const total = totalTabs(state);
	return goToTab(state, (state.currentTab + delta + total) % total);
}

/** After an answer: finish a single question, else move on without wrapping past the submit tab. */
export function advanceAfterAnswer(state: QuestionnaireState): AfterAnswer {
	if (!state.isMulti) return "submit";
	const last = state.questions.length - 1;
	return goToTab(state, state.currentTab < last ? state.currentTab + 1 : state.questions.length) ? "input" : "select";
}

/** Move the viewport without touching the selection; the selection stops following. */
export function scrollBy(state: QuestionnaireState, delta: number): void {
	state.scrollTop += delta;
	state.needsFollow = false;
}

/** Move the selected option up (-1) or down (+1); the viewport follows it on the next render. */
export function moveSelection(state: QuestionnaireState, delta: 1 | -1): void {
	const count = displayOptions(state).length;
	state.optionIndex = delta < 0 ? Math.max(0, state.optionIndex - 1) : Math.min(count - 1, state.optionIndex + 1);
	state.needsFollow = true;
}

export function toggleAuditor(state: QuestionnaireState): void {
	state.auditorEnabled = !state.auditorEnabled;
}
