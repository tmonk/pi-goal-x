import assert from "node:assert/strict";
import test from "node:test";

import {
	formatQuestionnaireAnswers,
	isHeadlessQuestionSufficientForDraft,
	normalizeQuestionnaireQuestions,
	proposalDialogFailureMessage,
	proposalDecisionFromQuestionnaireResult,
	shouldAutoConfirmProposal,
	type GoalQuestionnaireResult,
} from "../extensions/goal-questionnaire.ts";

test("normalizeQuestionnaireQuestions trims ids, de-duplicates, filters options, and validates recommended", () => {
	assert.deepEqual(
		normalizeQuestionnaireQuestions([
			{ id: " scope ", question: "Scope?", options: [" A ", "", "B"], recommended: 1 },
			{ id: "scope", question: "Again?", options: ["X"], recommended: 2, allowCustom: false },
			{ id: "  ", question: "Empty id?", options: [], recommended: 0 },
		]),
		[
			{ id: "scope", question: "Scope?", options: [" A ", "B"], recommended: 1, allowCustom: true },
			{ id: "scope-2", question: "Again?", options: ["X"], recommended: undefined, allowCustom: false },
			{ id: "q3", question: "Empty id?", options: [], recommended: undefined, allowCustom: true },
		],
	);
});

test("formatQuestionnaireAnswers emits stable Q/A records with context and options", () => {
	const result: GoalQuestionnaireResult = {
		cancelled: false,
		questions: [
			{ id: "scope", question: "Scope?", context: "Pick one", options: ["A", "B"], allowCustom: true },
			{ id: "notes", question: "Notes?", options: [], allowCustom: true },
		],
		answers: [
			{ id: "scope", question: "Scope?", answer: "A", wasCustom: false },
			{ id: "notes", question: "Notes?", answer: "Custom", wasCustom: true },
		],
	};

	assert.equal(
		formatQuestionnaireAnswers(result),
		"**Q:** Scope?\nPick one\nOptions: A / B\n**A:** A\n\n---\n\n**Q:** Notes?\n**A:** Custom",
	);
});

test("headless question sufficiency blocks vague-topic default fabrication", () => {
	assert.equal(isHeadlessQuestionSufficientForDraft({
		topic: "整理笔记",
		questionText: "你的笔记目前存放在哪里，是什么格式？输出为什么形式？",
	}), false);
	assert.equal(isHeadlessQuestionSufficientForDraft({
		topic: "在 sandbox 当前目录创建 hello.txt，内容为 Hello, Goal!，不要修改其他文件。",
		questionText: "如果 hello.txt 已存在，应该覆盖还是停止？",
	}), true);
});

test("proposal confirmation helpers keep headless and cancel semantics stable", () => {
	assert.equal(shouldAutoConfirmProposal({ hasUI: false }), true);
	assert.equal(shouldAutoConfirmProposal({ hasUI: true, autoConfirmEnv: "1" }), true);
	assert.equal(shouldAutoConfirmProposal({ hasUI: true, autoConfirmEnv: "0" }), false);
	assert.equal(proposalDecisionFromQuestionnaireResult({ cancelled: true, answer: "Confirm — create this goal now" }), "continue");
	assert.equal(proposalDecisionFromQuestionnaireResult({ cancelled: false, answer: "Confirm — create this goal now" }), "confirm");
	assert.equal(proposalDecisionFromQuestionnaireResult({ cancelled: false, answer: "Continue chatting — keep refining" }), "continue");
	assert.equal(proposalDecisionFromQuestionnaireResult({ cancelled: false, answer: "Cancel — discard this draft" }), "cancel");
	assert.match(proposalDialogFailureMessage(new Error("boom")), /NOT created/);
	assert.match(proposalDialogFailureMessage(new Error("boom")), /drafting remains active/);
});
