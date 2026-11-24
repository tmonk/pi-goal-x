import assert from "node:assert/strict";
import test from "node:test";

import { extractVerificationContract, promptSafeObjective, sisyphusObjectiveSufficient } from "../extensions/goal-contract.ts";
import { goalDraftingPrompt } from "../extensions/prompts/goal-draft-prompts.ts";
import { renderConfirmationTasks } from "../extensions/goal-task-confirmation.ts";

test("extractVerificationContract splits contract line from objective", () => {
	const { objective, verificationContract } = extractVerificationContract("Do the thing.\nVerification contract: Run npm test (0 failures)");
	assert.ok(objective.includes("Do the thing"));
	assert.ok(verificationContract?.includes("npm test"));
	const plain = extractVerificationContract("Just a plain objective");
	assert.equal(plain.verificationContract, undefined);
	assert.equal(plain.objective, "Just a plain objective");
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

test("sisyphusObjectiveSufficient accepts inline and block ordered steps", () => {
	assert.equal(sisyphusObjectiveSufficient("Refactor the auth flow: 1) extract token validation. 2) wire it into login. 3) update tests."), true, "inline numbered items");
	assert.equal(sisyphusObjectiveSufficient("Step 1: extract\nStep 2: wire\nStep 3: test"), true, "Step N blocks");
	assert.equal(sisyphusObjectiveSufficient("1. extract token validation\n2. wire it into login"), true, "numbered block");
	assert.equal(sisyphusObjectiveSufficient("Just do the thing cleanly"), false, "no step markers");
	assert.equal(sisyphusObjectiveSufficient(""), false, "empty objective");
});

test("goalDraftingPrompt routes the complete presentation through the tool renderer (PR E §57)", () => {
	// PR F: the structured propose_goal_draft arguments are supplied ONCE and
	// the tool call renderer is the scrollable complete human presentation.
	// Duplicating the full proposal in prose is explicitly forbidden.
	for (const focus of ["goal" as const, "sisyphus" as const]) {
		const prompt = goalDraftingPrompt("some topic", focus);
		assert.ok(prompt.includes("do NOT duplicate the full proposal in a preceding prose message"), `${focus} prompt must forbid the prose duplication`);
		assert.ok(prompt.includes("The tool call renderer is the scrollable, complete human presentation"), `${focus} prompt must name the renderer as the complete presentation`);
		assert.ok(prompt.includes("tasks` parameter of `propose_goal_draft"), `${focus} prompt must still require the full task list via the tool`);
		// Models otherwise pass the section headings as extra arguments, which
		// the tool's schema rejects (#122).
		assert.ok(prompt.includes("Put this whole block, headings included, in the objective argument"), `${focus} prompt must say where the block goes`);
		assert.ok(prompt.includes("the tool takes only objective, tasks, token_budget, auto_continue, sisyphus and block_completion"), `${focus} prompt must list the real arguments`);
		assert.ok(!prompt.includes("autoContinue="), `${focus} prompt must use the real argument name`);
	}
});
