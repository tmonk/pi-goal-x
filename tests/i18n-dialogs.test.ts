import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { registerLocale, setLocale } from "../extensions/i18n/index.ts";
import { proposalDecisionFromQuestionnaireResult, showProposalDialog } from "../extensions/goal-questionnaire.ts";
import { runQuestionnaireWithBasicDialogs } from "../extensions/questionnaire/basic-dialogs.ts";

afterEach(() => setLocale("en"));

test("basic dialogs show translated text and still return the picked option", async () => {
	registerLocale("xx", { "(Recommended)": "XX rec" });
	setLocale("xx");
	const seen: string[][] = [];
	const ctx = { ui: { select: async (_p: string, o: string[]) => { seen.push(o); return o[0]; }, input: async () => "" } };
	const result = await runQuestionnaireWithBasicDialogs(ctx as never, [{ id: "a", question: "Q?", options: ["One"], recommended: 0, allowCustom: false }]);
	assert.equal(seen[0]![0], "1. One XX rec");
	assert.equal(result.answers[0]!.answer, "One");
});

test("a translated proposal option still maps to its decision", async () => {
	registerLocale("xx", { "Continue chatting — keep refining": "XX keep going" });
	setLocale("xx");
	const ctx = { hasUI: true, ui: { select: async (_p: string, o: string[]) => o[1], input: async () => "" } };
	const { decision } = await showProposalDialog(ctx as never, "text", "goal");
	assert.equal(decision, "continue");
	assert.equal(proposalDecisionFromQuestionnaireResult({ cancelled: false, answer: "Confirm — x" }), "confirm");
});
