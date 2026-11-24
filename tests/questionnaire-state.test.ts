import assert from "node:assert/strict";
import test from "node:test";

import {
	advanceAfterAnswer,
	allAnswered,
	createQuestionnaireState,
	displayOptions,
	editorTextFor,
	enterQuestion,
	goToTab,
	moveSelection,
	orderedAnswers,
	saveAnswer,
	scrollBy,
	stashDraft,
	startInput,
	stepTab,
} from "../extensions/questionnaire/state.ts";
import type { GoalQuestionnaireQuestion } from "../extensions/questionnaire/types.ts";

const questions: GoalQuestionnaireQuestion[] = [
	{ id: "a", question: "A?", options: ["x", "y", "z"], recommended: 1 },
	{ id: "b", question: "B?", options: [], allowCustom: true },
	{ id: "c", question: "C?", options: ["p", "q"], allowCustom: false },
];

test("a new state starts on the first tab with no answers", () => {
	const state = createQuestionnaireState(questions);
	assert.equal(state.isMulti, true);
	assert.equal(state.currentTab, 0);
	assert.equal(state.hasAuditorToggle, false);
	assert.equal(state.auditorEnabled, true);
	assert.equal(allAnswered(state), false);
	assert.equal(createQuestionnaireState(questions, { defaultEnabled: false }).auditorEnabled, false);
});

test("displayOptions adds the custom row unless the question forbids it", () => {
	const state = createQuestionnaireState(questions);
	assert.deepEqual(displayOptions(state).map((o) => o.label), ["x", "y", "z", "Write your own answer..."]);
	goToTab(state, 2);
	assert.deepEqual(displayOptions(state).map((o) => o.label), ["p", "q"]);
	goToTab(state, 3);
	assert.deepEqual(displayOptions(state), []);
});

test("entering a question selects the existing answer, else the recommended option", () => {
	const state = createQuestionnaireState(questions);
	enterQuestion(state, questions[0]!);
	assert.equal(state.optionIndex, 1);
	saveAnswer(state, "a", "z", false);
	enterQuestion(state, questions[0]!);
	assert.equal(state.optionIndex, 2);
	saveAnswer(state, "a", "my own", true);
	enterQuestion(state, questions[0]!);
	assert.equal(state.optionIndex, 3);
});

test("entering a question restarts the viewport", () => {
	const state = createQuestionnaireState(questions);
	scrollBy(state, 7);
	state.needsFollow = true;
	enterQuestion(state, questions[0]!);
	assert.equal(state.scrollTop, 0);
	assert.equal(state.needsFollow, false);
});

test("a question without options opens the editor", () => {
	const state = createQuestionnaireState(questions);
	assert.equal(goToTab(state, 1), true);
	assert.equal(state.inputMode, true);
	assert.equal(state.inputQuestionId, "b");
});

test("stepTab wraps through the submit tab", () => {
	const state = createQuestionnaireState([questions[0]!, questions[2]!]);
	stepTab(state, -1);
	assert.equal(state.currentTab, 2);
	stepTab(state, 1);
	assert.equal(state.currentTab, 0);
	stepTab(state, 1);
	assert.equal(state.currentTab, 1);
});

test("advanceAfterAnswer submits a single question and moves on in a set", () => {
	const single = createQuestionnaireState([questions[0]!]);
	assert.equal(advanceAfterAnswer(single), "submit");

	const state = createQuestionnaireState(questions);
	assert.equal(advanceAfterAnswer(state), "input");
	assert.equal(state.currentTab, 1);
	state.inputMode = false;
	assert.equal(advanceAfterAnswer(state), "select");
	assert.equal(state.currentTab, 2);
	assert.equal(advanceAfterAnswer(state), "select");
	assert.equal(state.currentTab, 3);
	assert.equal(state.optionIndex, 0);
});

test("moveSelection clamps to the options and asks the viewport to follow", () => {
	const state = createQuestionnaireState(questions);
	moveSelection(state, -1);
	assert.equal(state.optionIndex, 0);
	assert.equal(state.needsFollow, true);
	for (let i = 0; i < 10; i++) moveSelection(state, 1);
	assert.equal(state.optionIndex, 3);
});

test("scrollBy moves the viewport and stops following the selection", () => {
	const state = createQuestionnaireState(questions);
	state.needsFollow = true;
	scrollBy(state, 5);
	scrollBy(state, -2);
	assert.equal(state.scrollTop, 3);
	assert.equal(state.needsFollow, false);
});

test("drafts are kept when non-blank and dropped when blank", () => {
	const state = createQuestionnaireState(questions);
	stashDraft(state, "ignored: no question is being edited");
	assert.equal(state.drafts.size, 0);
	startInput(state, "b");
	stashDraft(state, "half typed");
	assert.equal(editorTextFor(state, "b"), "half typed");
	stashDraft(state, "   ");
	assert.equal(editorTextFor(state, "b"), "");
});

test("the editor reopens with a previous custom answer but not a picked option", () => {
	const state = createQuestionnaireState(questions);
	saveAnswer(state, "b", "mine", true);
	assert.equal(editorTextFor(state, "b"), "mine");
	saveAnswer(state, "a", "x", false);
	assert.equal(editorTextFor(state, "a"), "");
});

test("orderedAnswers follows question order, not answer order", () => {
	const state = createQuestionnaireState(questions);
	saveAnswer(state, "c", "q", false);
	saveAnswer(state, "a", "x", false);
	assert.deepEqual(orderedAnswers(state).map((a) => a.id), ["a", "c"]);
	assert.equal(orderedAnswers(state)[0]!.question, "A?");
	assert.equal(allAnswered(state), false);
});
