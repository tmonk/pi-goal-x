import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { goalLedgerPath } from "../../extensions/goal-ledger.ts";

/** A fresh directory under the system temp dir. The prefix only helps people find leftovers. */
export function tempDir(prefix: string): string {
	return mkdtempSync(path.join(tmpdir(), prefix));
}

/** Remove a directory made by `tempDir`. A missing or busy directory is not a test failure. */
export function removeDir(dir: string): void {
	try {
		rmSync(dir, { recursive: true, force: true });
	} catch {
		// ignore
	}
}

/** File names of the open goals in `<cwd>/.pi/goals`; empty when the directory is missing. */
export function activeGoalFiles(cwd: string): string[] {
	try {
		return readdirSync(path.join(cwd, ".pi", "goals")).filter((name) => name.startsWith("active_goal_"));
	} catch {
		return [];
	}
}

/** Every line of the goal ledger parsed as JSON, with no validation; empty when there is no ledger. */
export function ledgerEvents(cwd: string): Array<Record<string, unknown>> {
	try {
		return readFileSync(goalLedgerPath({ cwd }), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
	} catch {
		return [];
	}
}
