/**
 * Unit tests for GoalService — the sole goal mutation boundary.
 *
 * Verifies the ordered pipeline from TECH.md Stage 1:
 *   1. reconcile → 2. expected id / focus revision check → 3. mutate on clone
 *   → 4. active-file write → 5. ledger append → 6. memory commit → 7. effects
 */

import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { GoalService, type GoalServiceRef } from "../extensions/goal-service.ts";
import { createGoal, type GoalRecord } from "../extensions/goal-record.ts";
import { writeActiveGoalFile, parseGoalFile, serializeGoalFile } from "../extensions/storage/goal-files.ts";
import { goalLedgerPath } from "../extensions/goal-ledger.ts";

// ── Fake ref: in-memory pool + focus mirroring the extension's closure state ─

interface HookLog {
	goalLost: string[];
	reconciled: string[];
	focusChanges: Array<{ from: string | null; to: string | null }>;
	diagnostics: Array<{ source: string; eventType?: string; message: string }>;
}

function makeRef(goal: GoalRecord): { ref: GoalServiceRef; log: HookLog } {
	let pool = new Map<string, GoalRecord>([[goal.id, goal]]);
	let focusedId: string | null = goal.id;
	let revision = 0;
	const log: HookLog = { goalLost: [], reconciled: [], focusChanges: [], diagnostics: [] };
	const ref: GoalServiceRef = {
		getFocused: () => (focusedId ? pool.get(focusedId) ?? null : null),
		setFocused: (next) => {
			if (next) {
				pool.set(next.id, next);
				focusedId = next.id;
				return;
			}
			if (focusedId) pool.delete(focusedId);
			focusedId = null;
		},
		getPool: () => pool,
		replacePool: (next) => {
			pool = next;
		},
		getFocusedGoalId: () => focusedId,
		assignFocusedGoalId: (id) => {
			if (focusedId !== id) {
				revision += 1;
				focusedId = id;
			}
		},
		focusToken: (goalId) => ({ goalId, revision }),
		isTokenCurrent: (token) => focusedId === token.goalId && revision === token.revision,
		appendFocusEntry: () => {},
		onFocusedGoalLost: (lostGoalId) => {
			log.goalLost.push(lostGoalId ?? "");
		},
		onReconciled: (g) => {
			log.reconciled.push(g.id);
		},
		onFocusChanged: (from, to) => {
			log.focusChanges.push({ from, to });
		},
		onDiagnostic: (diagnostic) => {
			log.diagnostics.push({ source: diagnostic.source, eventType: diagnostic.eventType, message: diagnostic.message });
		},
	};
	return { ref, log };
}

function fixture() {
	const cwd = mkdtempSync(path.join(tmpdir(), "goal-service-"));
	mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
	const goal = createGoal({
		objective: "=== Goal ===\nObjective: Service test",
		autoContinue: true,
		sisyphus: false,
	}, Date.UTC(2026, 7, 1, 9, 0, 0));
	const written = writeActiveGoalFile({ cwd }, goal);
	const { ref, log } = makeRef(written);
	const service = new GoalService(ref);
	const cleanup = () => {
		try { rmSync(cwd, { recursive: true, force: true }); } catch {}
	};
	return { cwd, written, ref, log, service, cleanup };
}

function activeFiles(cwd: string): string[] {
	try {
		return readdirNames(path.join(cwd, ".pi", "goals")).filter((n) => n.startsWith("active_goal_"));
	} catch {
		return [];
	}
}

function readdirNames(dir: string): string[] {
	try {
		return readdirSync(dir);
	} catch {
		return [];
	}
}

function ledgerEvents(cwd: string): unknown[] {
	try {
		const raw = readFileSync(goalLedgerPath({ cwd }), "utf8");
		return raw.split("\n").filter(Boolean).map((line) => JSON.parse(line) as unknown);
	} catch {
		return [];
	}
}

describe("GoalService mutation pipeline", () => {
	it("apply writes the file, appends the ledger, then commits memory", () => {
		const f = fixture();
		try {
			const result = f.service.apply({ cwd: f.cwd }, {
				reconcile: false,
				mutate: (g) => ({ ...g, objective: "=== Goal ===\nObjective: Mutated" }),
				ledger: [{ type: "goal_paused", goalId: f.written.id, reason: "test", status: "paused", at: new Date().toISOString() }],
			});
			assert.ok(result.ok, "apply should succeed");
			if (!result.ok) return;

			// 4. file write landed
			const active = activeFiles(f.cwd);
			assert.equal(active.length, 1, "one active goal file should exist");
			const parsed = parseGoalFile(path.join(f.cwd, ".pi", "goals", active[0]!));
			assert.ok(parsed, "written file must parse");
			assert.ok(parsed.objective.includes("Mutated"), "file must contain the mutated objective");

			// 5. ledger append landed
			const events = ledgerEvents(f.cwd);
			assert.equal(events.length, 1, "one ledger event should exist");
			assert.equal((events[0] as { type: string }).type, "goal_paused");

			// 6. memory commit landed
			const focused = f.ref.getFocused();
			assert.ok(focused, "focused goal must exist");
			assert.ok(focused.objective.includes("Mutated"), "memory goal must reflect the mutation");
		} finally {
			f.cleanup();
		}
	});

	it("ledger factory failure does not roll back the write or the memory commit", () => {
		const f = fixture();
		try {
			const result = f.service.apply({ cwd: f.cwd }, {
				reconcile: false,
				mutate: (g) => ({ ...g, objective: "=== Goal ===\nObjective: Ledger-broken" }),
				ledger: () => {
					throw new Error("ledger boom");
				},
			});
			assert.ok(result.ok, "apply must still succeed when the ledger factory throws");
			assert.ok(f.ref.getFocused()?.objective.includes("Ledger-broken"), "memory must be committed");
		} finally {
			f.cleanup();
		}
	});

	it("expected goal id mismatch rejects without writing or appending", () => {
		const f = fixture();
		try {
			const before = serializeGoalFile(f.written);
			const result = f.service.apply({ cwd: f.cwd }, {
				reconcile: false,
				expectedGoalId: "some-other-goal",
				mutate: (g) => ({ ...g, objective: "=== Goal ===\nObjective: Nope" }),
				ledger: [{ type: "goal_paused", goalId: f.written.id, reason: "x", status: "paused", at: new Date().toISOString() }],
			});
			assert.equal(result.ok, false, "expected id mismatch must reject");
			const active = activeFiles(f.cwd);
			assert.equal(active.length, 1);
			const after = readFileSync(path.join(f.cwd, ".pi", "goals", active[0]!), "utf8");
			assert.equal(after, before, "file must be unchanged");
			assert.equal(ledgerEvents(f.cwd).length, 0, "no ledger event appended");
		} finally {
			f.cleanup();
		}
	});

	it("stale focus revision rejects without writing", () => {
		const f = fixture();
		try {
			const token = f.ref.focusToken(f.written.id);
			// Simulate a focus change that bumps the revision.
			f.ref.assignFocusedGoalId(null);
			f.ref.assignFocusedGoalId(f.written.id);
			const result = f.service.apply({ cwd: f.cwd }, {
				reconcile: false,
				focusToken: token,
				mutate: (g) => ({ ...g, objective: "=== Goal ===\nObjective: Stale" }),
			});
			assert.equal(result.ok, false, "stale focus token must reject");
			const focused = f.ref.getFocused();
			assert.ok(focused && !focused.objective.includes("Stale"), "memory must be unchanged");
		} finally {
			f.cleanup();
		}
	});

	it("reconcile runs first: a focused goal deleted on disk aborts the mutation", () => {
		const f = fixture();
		try {
			const active = activeFiles(f.cwd);
			assert.equal(active.length, 1);
			rmSync(path.join(f.cwd, ".pi", "goals", active[0]!));
			const result = f.service.apply({ cwd: f.cwd }, {
				mutate: (g) => ({ ...g, objective: "=== Goal ===\nObjective: Should not land" }),
			});
			assert.equal(result.ok, false, "mutation must be rejected after the goal is lost");
			assert.equal(f.log.goalLost.length, 1, "onFocusedGoalLost hook must fire");
		} finally {
			f.cleanup();
		}
	});

	it("persist merges the authoritative objective from disk before writing", () => {
		const f = fixture();
		try {
			// Simulate an external user edit of the prompt body.
			const active = activeFiles(f.cwd);
			const filePath = path.join(f.cwd, ".pi", "goals", active[0]!);
			const current = readFileSync(filePath, "utf8");
			const edited = current.replace("=== Goal ===\nObjective: Service test", "=== Goal ===\nObjective: User-edited objective");
			writeFileSync(filePath, edited, "utf8");

			const persisted = f.service.persist({ cwd: f.cwd });
			assert.ok(persisted, "persist must return the written goal");
			assert.ok(persisted.objective.includes("User-edited objective"), "persist must adopt the user edit");
			assert.ok(f.ref.getFocused()?.objective.includes("User-edited objective"), "memory must adopt the user edit");
		} finally {
			f.cleanup();
		}
	});

	it("create writes the active file, appends goal_created, and commits focus", () => {
		const f = fixture();
		try {
			const next = createGoal({
				objective: "=== Goal ===\nObjective: Second goal",
				autoContinue: false,
				sisyphus: false,
			}, Date.UTC(2026, 7, 1, 10, 0, 0));
			const result = f.service.create({ cwd: f.cwd }, {
				goal: next,
				ledger: [{ type: "goal_created", goalId: next.id, objective: next.objective, sisyphus: false, autoContinue: false, at: next.createdAt }],
			});
			assert.ok(result.ok);
			assert.equal(activeFiles(f.cwd).length, 2, "both active files must exist");
			assert.equal(ledgerEvents(f.cwd).length, 1, "goal_created event appended");
			assert.equal(f.ref.getFocused()?.id, next.id, "focus must move to the new goal");
			assert.equal(f.log.focusChanges.length, 1, "focus change effect must fire");
		} finally {
			f.cleanup();
		}
	});

	it("archive mode writes the archived file and does not commit focus", () => {
		const f = fixture();
		try {
			const result = f.service.apply({ cwd: f.cwd }, {
				reconcile: false,
				archive: true,
				commitFocused: false,
				mutate: (g) => ({ ...g, status: "paused" as const, stopReason: "user" as const }),
				ledger: [{ type: "goal_completed", goalId: f.written.id, at: new Date().toISOString() }],
			});
			assert.ok(result.ok);
			if (!result.ok) return;
			assert.equal(activeFiles(f.cwd).length, 0, "active file must be removed on archive");
			const archivedDir = path.join(f.cwd, ".pi", "goals", "archived");
			const archived = readdirNames(archivedDir).filter((n) => n.startsWith("goal_"));
			assert.equal(archived.length, 1, "archived file must exist");
			assert.equal(f.ref.getFocused()?.id, f.written.id, "memory focus must be untouched (commitFocused: false)");
		} finally {
			f.cleanup();
		}
	});

// ── Stage 4: ledger failure injection ────────────────────────────────────────

it("ledger append failure after the authoritative write keeps the state transition and emits a diagnostic", async () => {
	const f = fixture();
	try {
		// Make the ledger path unwritable: a directory blocks appendFileSync.
		mkdirSync(goalLedgerPath({ cwd: f.cwd }), { recursive: true });

		const result = f.service.apply({ cwd: f.cwd }, {
			reconcile: false,
			mutate: (g) => ({ ...g, pauseReason: "updated despite ledger failure", updatedAt: new Date().toISOString() }),
			ledger: (written) => [{ type: "goal_paused", goalId: written.id, reason: "test", status: "paused", at: written.updatedAt }],
		});
		assert.ok(result.ok, "state write must not be rolled back by a ledger failure");
		if (!result.ok) return;
		// The authoritative write landed on disk.
		const files = activeFiles(f.cwd);
		assert.equal(files.length, 1, "active file still present");
		const diskContent = readFileSync(path.join(f.cwd, ".pi", "goals", files[0]!), "utf8");
		assert.ok(diskContent.includes("updated despite ledger failure"), "mutation persisted despite ledger failure");
		// The failure is observable through the onDiagnostic hook.
		assert.ok(f.log.diagnostics.length >= 1, "ledger failure must emit a diagnostic");
		const diag = f.log.diagnostics[0]!;
		assert.equal(diag.source, "ledger");
		assert.equal(diag.eventType, "goal_paused");
	} finally {
		f.cleanup();
	}
});

});
