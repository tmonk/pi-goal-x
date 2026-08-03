import assert from "node:assert/strict";
import test from "node:test";

import {
	buildDraftConfirmationText,
	extractVerificationContract,
	promptSafeObjective,
	renderConfirmationTasks,
} from "../extensions/goal-draft.ts";

test("buildDraftConfirmationText previews mode, original topic, and proposed goal as plain text", () => {
	const summary = buildDraftConfirmationText({
		focus: "sisyphus",
		originalTopic: "first line\nsecond line",
		objective: "=== Sisyphus Goal ===\nObjective: Ship safely",
		autoContinue: true,
	});

	assert.match(summary, /^● Goal draft ready for confirmation\./);
	assert.match(summary, /Mode: Sisyphus/);
	assert.match(summary, /Auto-continue: yes/);
	assert.match(summary, /─── Original Topic ───\n\n│   first line\n│   second line/);
	assert.match(summary, /─── Proposed Goal ───/);
	assert.match(summary, /│   Objective: Ship safely/);
	assert.doesNotMatch(summary, /^> /m);
});

test("promptSafeObjective escapes only untrusted objective tags", () => {
	assert.equal(
		promptSafeObjective("<untrusted_objective>x</untrusted_objective><keep>"),
		"&lt;untrusted_objective&gt;x&lt;/untrusted_objective&gt;<keep>",
	);
});


test("renderConfirmationTasks renders a flat and nested task tree", () => {
	
	const lines = renderConfirmationTasks([
		{ id: "a", title: "A", status: "pending" as const },
		{ id: "b", title: "B", status: "complete" as const, subtasks: [{ id: "b1", title: "B1", status: "pending" as const }] },
	], 0);
	assert.ok(lines.some((l) => l.includes("a: A")));
	assert.ok(lines.some((l) => l.includes("b: B")));
	assert.ok(lines.some((l) => l.includes("b1: B1")));
});

test("extractVerificationContract splits contract line from objective", () => {

	const { objective, verificationContract } = extractVerificationContract("Do the thing.\nVerification contract: Run npm test (0 failures)");
	assert.ok(objective.includes("Do the thing"));
	assert.ok(verificationContract?.includes("npm test"));
	const plain = extractVerificationContract("Just a plain objective");
	assert.equal(plain.verificationContract, undefined);
	assert.equal(plain.objective, "Just a plain objective");
});
