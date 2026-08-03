/**
 * Source-level contract: GoalService is the sole mutation boundary.
 *
 * Stage 1 exit criterion: `extensions/goal.ts` no longer writes goal files
 * directly and appends no ledger events directly — every mutation routes
 * through `GoalService` (extensions/goal-service.ts), which owns the ordered
 * write→ledger→archive→memory pipeline.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const here = path.dirname(fileURLToPath(import.meta.url));
const goalTs = readFileSync(path.join(here, "..", "extensions", "goal.ts"), "utf8");

// Mutation primitives that must NOT be invoked from goal.ts directly.
const FORBIDDEN_CALL_SITES = [
	"writeActiveGoalFile(",
	"archiveGoalFile(",
	"atomicWriteGoalFile(",
	"appendGoalEvent(",
	"ensureDirectory(",
	"safeUnlinkGoalFile(",
];

describe("goal.ts mutation boundary", () => {
	it("routes every goal-file write and ledger append through GoalService", () => {
		const hits = FORBIDDEN_CALL_SITES.filter((primitive) => goalTs.includes(primitive));
		assert.deepEqual(hits, [], `goal.ts must not call mutation primitives directly; found: ${hits.join(", ")}`);
	});

	it("does not import the mutation primitives from storage/goal-ledger", () => {
		const imports = goalTs.match(/import\s*\{[^}]*\} from ["']\.\/(?:storage\/)?goal-(?:files|ledger)\.ts["']/g) ?? [];
		for (const block of imports) {
			for (const primitive of FORBIDDEN_CALL_SITES.map((p) => p.replace("(", ""))) {
				assert.equal(block.includes(primitive), false, `goal.ts must not import ${primitive}`);
			}
		}
	});

	it("instantiates the GoalService and uses it for persistence", () => {
		assert.ok(goalTs.includes("new GoalService("), "goal.ts must construct the GoalService");
		assert.ok(goalTs.includes("goalService.persist("), "goal.ts must persist through the service");
		assert.ok(goalTs.includes("goalService.apply("), "goal.ts must mutate through the service");
		assert.ok(goalTs.includes("goalService.appendEvents("), "goal.ts must append ledger events through the service");
	});

	it("keeps pure serializers and readers importable (no mutation)", () => {
		// serializeGoalFile is a pure content builder (used for the debug widget);
		// mergeGoalPromptFromDisk / readActiveGoalPool / readGoalLedger are reads.
		assert.ok(goalTs.includes("serializeGoalFile"), "goal.ts may use the pure serializer");
		assert.ok(goalTs.includes("mergeGoalPromptFromDisk"), "goal.ts may merge prompt bodies from disk");
		assert.ok(goalTs.includes("readGoalLedger"), "goal.ts may read the ledger");
	});
});
