import assert from "node:assert/strict";
import test from "node:test";

import { extractVerificationContract, promptSafeObjective } from "../extensions/goal-contract.ts";
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
