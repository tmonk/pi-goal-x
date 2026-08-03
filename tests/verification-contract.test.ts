/**
 * Tests for the verification contract system.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { extractVerificationContract } from "../extensions/goal-draft.ts";
import { validateVerificationSummary } from "../extensions/goal-policy.ts";
import { verificationContractBlock } from "../extensions/prompts/goal-prompts.ts";
import type { GoalRecord } from "../extensions/goal-record.ts";

// ── extractVerificationContract ─────────────────────────────────────────

test("extractVerificationContract: no contract section returns objective unchanged", () => {
	const objective = "=== Goal ===\nObjective: Test\nSuccess criteria: Nothing";
	const result = extractVerificationContract(objective);
	assert.equal(result.objective, objective);
	assert.equal(result.verificationContract, undefined);
});

test("extractVerificationContract: extracts contract from objective", () => {
	const objective = `=== Goal ===
Objective: Test
Success criteria: Do the thing
Verification contract: Run npm test (0 failures), grep for remaining references`;
	const result = extractVerificationContract(objective);
	assert.equal(result.verificationContract, "Run npm test (0 failures), grep for remaining references");
	assert.ok(!result.objective.includes("Verification contract:"), "contract line should be removed from objective");
	assert.ok(result.objective.includes("Objective: Test"), "objective should still contain other sections");
	assert.ok(result.objective.includes("Success criteria: Do the thing"), "success criteria should be preserved");
});

test("extractVerificationContract: handles multi-line objective with contract at end", () => {
	const objective = [
		"=== Goal ===",
		"Objective: Refactor STP module",
		"Success criteria:",
		"- Remove dead code",
		"- All tests pass",
		"Boundaries: src/ only",
		"Verification contract: npm test passes, no remaining STP references in grep",
	].join("\n");
	const result = extractVerificationContract(objective);
	assert.equal(result.verificationContract, "npm test passes, no remaining STP references in grep");
	assert.ok(!result.objective.includes("Verification contract:"));
	assert.ok(result.objective.includes("Objective: Refactor STP module"));
	assert.ok(result.objective.includes("Boundaries: src/ only"));
});

test("extractVerificationContract: contract with empty value returns undefined", () => {
	const objective = "=== Goal ===\nObjective: Test\nVerification contract:   \nSuccess criteria: OK";
	const result = extractVerificationContract(objective);
	// Empty/whitespace-only value is not a valid contract
	assert.equal(result.verificationContract, undefined);
	// The line stays in the objective when the value is empty (regex requires non-whitespace content)
	assert.ok(result.objective.includes("Verification contract:"));
});

test("extractVerificationContract: handles Sisyphus goal format", () => {
	const objective = `=== Sisyphus Goal ===
Objective: Clean up STP
Ordered steps:
1. Remove dead code
2. Update tests
Verification contract: All tests pass (npm test, 0 failures), codebase has no references to removed methods`;
	const result = extractVerificationContract(objective);
	assert.equal(result.verificationContract, "All tests pass (npm test, 0 failures), codebase has no references to removed methods");
	assert.ok(!result.objective.includes("Verification contract:"));
	assert.ok(result.objective.includes("Ordered steps:"));
});

// ── validateVerificationSummary ─────────────────────────────────────────

test("validateVerificationSummary: no contract passes", () => {
	const result = validateVerificationSummary({});
	assert.deepEqual(result, { ok: true });
});

test("validateVerificationSummary: contract with non-empty summary passes", () => {
	const result = validateVerificationSummary({
		verificationContract: "Check tests and references",
		verificationSummary: "npm test passed, grep found no remaining references",
	});
	assert.deepEqual(result, { ok: true });
});

test("validateVerificationSummary: contract with empty summary rejects", () => {
	const result = validateVerificationSummary({
		verificationContract: "Check tests and references",
		verificationSummary: "",
	});
	assert.equal(result.ok, false);
	if (!result.ok) assert.match(result.message, /verification contract/);
});

test("validateVerificationSummary: contract with undefined summary rejects", () => {
	const result = validateVerificationSummary({
		verificationContract: "Must verify",
		verificationSummary: undefined,
	});
	assert.equal(result.ok, false);
	if (!result.ok) assert.match(result.message, /verification contract/);
});

test("validateVerificationSummary: contract with whitespace-only summary rejects", () => {
	const result = validateVerificationSummary({
		verificationContract: "Must verify",
		verificationSummary: "   ",
	});
	assert.equal(result.ok, false);
});

test("validateVerificationSummary: null contract passes even with empty summary", () => {
	const result = validateVerificationSummary({
		verificationContract: null,
		verificationSummary: "",
	});
	assert.deepEqual(result, { ok: true });
});

// ── verificationContractBlock ───────────────────────────────────────────

function goal(overrides: Partial<GoalRecord> = {}): GoalRecord {
	return {
		id: "g1",
		objective: "Test goal",
		status: "active",
		autoContinue: true,
		usage: { tokensUsed: 0, activeSeconds: 0 },
		sisyphus: false,
		createdAt: "2026-05-12T00:00:00.000Z",
		updatedAt: "2026-05-12T00:00:00.000Z",
		...overrides,
	};
}

test("verificationContractBlock: returns empty string when no contract", () => {
	const block = verificationContractBlock(goal());
	assert.equal(block, "");
});

test("verificationContractBlock: includes contract text and rules", () => {
	const block = verificationContractBlock(goal({
		verificationContract: "Run npm test (0 failures), search for remaining references",
	}));
	assert.ok(block.includes("VERIFICATION CONTRACT"));
	assert.ok(block.includes("goalId=g1"));
	assert.ok(block.includes("Run npm test (0 failures), search for remaining references"));
	assert.ok(block.includes("independent completion auditor derives the requirements"));
	assert.ok(block.includes("Do NOT mark sub-items or tasks as complete"));
});

test("verificationContractBlock: mentions per-task contracts", () => {
	const block = verificationContractBlock(goal({
		verificationContract: "Check all tests pass",
	}));
	assert.ok(block.includes("independent completion auditor derives the requirements"));
	assert.ok(block.includes("sub-items or tasks"));
});
