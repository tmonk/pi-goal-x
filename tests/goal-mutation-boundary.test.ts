/**
 * Source-level contract: GoalService is the sole mutation boundary.
 *
 * Stage 1 exit criterion: no extension module writes goal files directly or
 * appends ledger events directly — every mutation routes through `GoalService`
 * (extensions/goal-service.ts), which owns the ordered write→ledger→archive→memory
 * pipeline. The thin installer (goal.ts) delegates all state to the GoalCore
 * (goal-state.ts); handlers live in the tools/commands/events/widget modules.
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const here = path.dirname(fileURLToPath(import.meta.url));
const extensionsDir = path.join(here, "..", "extensions");

// Every extension module except the storage owners: GoalService is the only
// mutation boundary, and goal-files/goal-ledger implement the primitives.
const MUTATION_OWNERS = new Set(["goal-service.ts", "goal-ledger.ts", path.join("storage", "goal-files.ts")]);
const implementationSources = (readdirSync(extensionsDir, { recursive: true }) as string[])
	.filter((name) => name.endsWith(".ts") && !MUTATION_OWNERS.has(name))
	.map((name) => readFileSync(path.join(extensionsDir, name), "utf8"))
	.join("\n");

// Mutation primitives that must NOT be invoked from implementation modules directly.
const FORBIDDEN_CALL_SITES = [
	"writeActiveGoalFile(",
	"archiveGoalFile(",
	"atomicWriteGoalFile(",
	"appendGoalEvent(",
	"ensureDirectory(",
	"safeUnlinkGoalFile(",
];

describe("goal mutation boundary", () => {
	it("routes every goal-file write and ledger append through GoalService", () => {
		const hits = FORBIDDEN_CALL_SITES.filter((primitive) => implementationSources.includes(primitive));
		assert.deepEqual(hits, [], `implementation modules must not call mutation primitives directly; found: ${hits.join(", ")}`);
	});

	it("does not import the mutation primitives from storage/goal-ledger", () => {
		const imports = implementationSources.match(/import\s*\{[^}]*\} from ["']\.\/(?:storage\/)?goal-(?:files|ledger)\.ts["']/g) ?? [];
		for (const block of imports) {
			for (const primitive of FORBIDDEN_CALL_SITES.map((p) => p.replace("(", ""))) {
				assert.equal(block.includes(primitive), false, `implementation modules must not import ${primitive}`);
			}
		}
	});

	it("instantiates the GoalService and uses it for persistence", () => {
		const coreSource = readFileSync(path.join(extensionsDir, "goal-state.ts"), "utf8");
		assert.ok(coreSource.includes("new GoalService("), "goal-state.ts must construct the GoalService");
		assert.ok(coreSource.includes("goalService.persist("), "goal-state.ts must persist through the service");
		assert.ok(coreSource.includes("goalService.apply("), "goal-state.ts must mutate through the service");
		assert.ok(coreSource.includes("goalService.appendEvents("), "goal-state.ts must append ledger events through the service");
	});

	it("goal.ts is a thin installer with no direct mutation or ledger calls", () => {
		const goalTs = readFileSync(path.join(extensionsDir, "goal.ts"), "utf8");
		for (const primitive of FORBIDDEN_CALL_SITES) {
			assert.equal(goalTs.includes(primitive), false, `goal.ts must not call ${primitive}`);
		}
		assert.equal(goalTs.includes("goalService."), false, "goal.ts must not reference the service directly");
		assert.equal(goalTs.includes("appendEvents"), false, "goal.ts must not append ledger events");
	});

	it("goal.ts installs the shared core", () => {
		const goalTs = readFileSync(path.join(extensionsDir, "goal.ts"), "utf8");
		assert.ok(goalTs.includes("createGoalCore("), "goal.ts must install the core");
	});
});
