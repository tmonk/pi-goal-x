import {
	advanceAfterAnswer,
	allAnswered,
	currentQuestion,
	displayOptions,
	editorTextFor,
	moveSelection,
	onSubmitTab,
	saveAnswer,
	scrollBy,
	type QuestionnaireState,
	startInput,
	stashDraft,
	stepTab,
	stopInput,
	toggleAuditor,
} from "./state.ts";
import type { DialogControls } from "./types.ts";

/** The embedded answer editor, as far as key handling needs it. */
export interface EditorPort {
	/** Show the editor with this text and give it focus. */
	open(text: string): void;
	/** Hide the editor and clear its text. */
	close(): void;
	getText(): string;
	handleInput(data: string): void;
}

export interface QuestionnaireKeyDeps {
	state: QuestionnaireState;
	controls: DialogControls;
	editor: EditorPort;
	/** Terminal-height bound; sets how far PageUp/PageDown scroll. */
	maxDialogLines: number | undefined;
	/** Close the dialog with the current answers. */
	submit(cancelled: boolean): void;
	/** Drop the cached render and ask for a new one. */
	refresh(): void;
}

export interface QuestionnaireKeys {
	handleInput(data: string): void;
	/** Called by the editor when the user presses Enter. */
	submitEditor(value: string): void;
}

export function createQuestionnaireKeys(deps: QuestionnaireKeyDeps): QuestionnaireKeys {
	const { state, controls, editor, maxDialogLines, submit, refresh } = deps;

	function openEditor(qId: string) {
		startInput(state, qId);
		editor.open(editorTextFor(state, qId));
	}

	function closeEditor() {
		stopInput(state);
		editor.close();
	}

	/** Leave the editor but keep what was typed as a draft. */
	function exitEditor() {
		stashDraft(state, editor.getText());
		closeEditor();
	}

	/** Switch tab, opening the editor when the new question has no options. */
	function changeTab(delta: 1 | -1) {
		if (stepTab(state, delta)) editor.open(editorTextFor(state, state.inputQuestionId!));
		refresh();
	}

	function afterAnswer() {
		const next = advanceAfterAnswer(state);
		if (next === "submit") {
			submit(false);
			return;
		}
		if (next === "input") editor.open(editorTextFor(state, state.inputQuestionId!));
		refresh();
	}

	function submitEditor(value: string) {
		if (!state.inputQuestionId) return;
		const trimmed = value.trim();
		if (!trimmed) {
			refresh();
			return;
		}
		const qId = state.inputQuestionId;
		state.drafts.delete(qId);
		saveAnswer(state, qId, trimmed, true);
		closeEditor();
		afterAnswer();
	}

	function handleEditorKey(data: string) {
		if (controls.cancelEditing(data)) {
			const q = currentQuestion(state);
			if (q && q.options.length === 0 && !state.isMulti) submit(true);
			else {
				exitEditor();
				refresh();
			}
			return;
		}
		if (state.isMulti && (controls.matches(data, "next", true) || controls.matches(data, "previous", true))) {
			exitEditor();
			changeTab(controls.matches(data, "next", true) ? 1 : -1);
			return;
		}
		editor.handleInput(data);
		refresh();
	}

	function handleInput(data: string) {
		if (state.inputMode) {
			handleEditorKey(data);
			return;
		}

		const q = currentQuestion(state);
		const opts = displayOptions(state);

		if (state.isMulti) {
			if (controls.matches(data, "next")) {
				changeTab(1);
				return;
			}
			if (controls.matches(data, "previous")) {
				changeTab(-1);
				return;
			}
		}

		// Viewport keys work on select-mode question tabs and the submit summary:
		// page and line scroll without moving the selection. Up/down still select
		// and auto-follow into view on the next render.
		const page = Math.max(1, (maxDialogLines ?? 10) - 1);
		const scrollDelta = controls.matches(data, "pageUp") ? -page
			: controls.matches(data, "pageDown") ? page
			: controls.matches(data, "scrollUp") ? -1
			: controls.matches(data, "scrollDown") ? 1
			: 0;
		if (scrollDelta !== 0) {
			scrollBy(state, scrollDelta);
			refresh();
			return;
		}

		if (onSubmitTab(state)) {
			if (controls.matches(data, "confirm") && allAnswered(state)) submit(false);
			else if (controls.matches(data, "cancel")) submit(true);
			return;
		}

		if (controls.matches(data, "up")) {
			moveSelection(state, -1);
			refresh();
			return;
		}
		if (controls.matches(data, "down")) {
			moveSelection(state, 1);
			refresh();
			return;
		}

		if (controls.matches(data, "toggleAuditor") && state.hasAuditorToggle) {
			toggleAuditor(state);
			refresh();
			return;
		}

		if (controls.matches(data, "confirm") && q) {
			if (q.options.length === 0 || opts[state.optionIndex]?.isCustom) {
				openEditor(q.id);
				refresh();
				return;
			}
			const opt = opts[state.optionIndex];
			if (opt) {
				saveAnswer(state, q.id, opt.label, false);
				afterAnswer();
			}
			return;
		}

		if (controls.matches(data, "cancel")) submit(true);
	}

	return { handleInput, submitEditor };
}
