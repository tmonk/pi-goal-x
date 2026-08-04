/**
 * Stage 0 golden tests: pin the current on-disk and in-memory data contracts
 * so the interface simplification (specs/2026-08-03-codex-inspired-goal-interface)
 * cannot silently break them.
 *
 * Covered goldens:
 *   - v3 goal file format (checked-in fixture) parses to a stable record;
 *   - the prompt body remains authoritative over the JSON header objective;
 *   - serialize -> parse round-trips the fixture record;
 *   - task trees, verification contracts, statuses, and pause metadata survive;
 *   - paused + legacy autoContinue normalization (current hazard, pinned);
 *   - ledger format (checked-in fixture): every event type reads, malformed
 *     lines are counted, and reconstruction yields stable terminal state;
 *   - focus restoration from disk through resolveSessionFocus;
 *   - compaction summary golden text;
 *   - auditor verdict marker contract.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseAuditorDecision } from "../extensions/goal-auditor.ts";
import { buildCompactionSummary } from "../extensions/goal-compaction.ts";
import { readGoalLedger, reconstructGoalLedger } from "../extensions/goal-ledger.ts";
import { resolveSessionFocus } from "../extensions/goal-pool.ts";
import {
	normalizeGoalRecord,
	validateTokenBudgetInput,
	normalizeTaskList,
	normalizeTaskItem,
	nowIso,
	type GoalRecord,
} from "../extensions/goal-record.ts";
import {
	GOALS_DIR,
	parseGoalFile,
	readActiveGoalPool,
	serializeGoalFile,
	writeActiveGoalFile,
} from "../extensions/storage/goal-files.ts";

const FIXTURE_GOAL_RELPATH = `${GOALS_DIR}/active_goal_fixture.md`;

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));

function fixturePath(rel: string): string {
	return path.join(TEST_DIR, "fixtures", rel);
}

function tempCwd(): string {
	const cwd = mkdtempSync(path.join(tmpdir(), "goal-golden-"));
	mkdirSync(path.join(cwd, GOALS_DIR), { recursive: true });
	return cwd;
}

function writeFixtureGoal(cwd: string): void {
	writeFileSync(path.join(cwd, FIXTURE_GOAL_RELPATH), readFileSync(fixturePath("goals/active_goal_fixture.md"), "utf8"));
}

// ── Expected normalized record for the fixture ───────────────────────────────

function expectedFixtureRecord(now: string): GoalRecord {
	return {
		id: "golden_fixture_goal",
		objective: "Golden fixture goal objective",
		status: "active",
		autoContinue: true,
		usage: { tokensUsed: 123456, activeSeconds: 3600 },
		sisyphus: false,
		createdAt: "2026-08-03T09:00:00.000Z",
		updatedAt: "2026-08-03T10:00:00.000Z",
		activePath: ".pi/goals/active_goal_2026080317000000_golden_fixture_goal.md",
		archivedPath: undefined,
		stopReason: undefined,
		pauseReason: undefined,
		pauseSuggestedAction: undefined,
		skipAuditor: undefined,
		revision: 0,
		tokenBudget: undefined,
		taskList: {
			blockCompletion: true,
			proposedAt: "2026-08-03T09:05:00.000Z",
			tasks: [
				{
					id: "task-1",
					title: "Implement core",
					status: "complete",
					completedAt: "2026-08-03T09:30:00.000Z",
					skippedAt: undefined,
					evidence: "npm run check passes",
					skipReason: undefined,
					verificationContract: undefined,
					lightweightSubtasks: undefined,
					subtasks: [
						{
							id: "task-1a",
							title: "Design",
							status: "pending",
							completedAt: undefined,
							skippedAt: undefined,
							evidence: undefined,
							skipReason: undefined,
							verificationContract: "Design doc reviewed",
							lightweightSubtasks: undefined,
							subtasks: undefined,
						},
					],
				},
				{
					id: "task-2",
					title: "Docs",
					status: "skipped",
					completedAt: undefined,
					skippedAt: "2026-08-03T09:40:00.000Z",
					evidence: undefined,
					skipReason: "User cancelled docs work",
					verificationContract: undefined,
					lightweightSubtasks: true,
					subtasks: undefined,
				},
			],
		},
		verificationContract: "Run npm test (0 failures) and confirm every requirement is addressed.",
	};
}

// ── Goal file format golden ─────────────────────────────────────────────────

test("golden: fixture v3 goal file parses to the pinned record", () => {
	const cwd = tempCwd();
	try {
		writeFixtureGoal(cwd);
		const parsed = parseGoalFile(path.join(cwd, FIXTURE_GOAL_RELPATH));
		assert.ok(parsed, "fixture goal file must parse");
		assert.deepEqual(parsed, expectedFixtureRecord(nowIso()));
	} finally {
		// temp dir cleanup is best-effort; os tmp dir reaps on reboot.
	}
});

test("golden: prompt body is authoritative over the JSON header objective", () => {
	const cwd = tempCwd();
	try {
		writeFixtureGoal(cwd);
		const filePath = path.join(cwd, FIXTURE_GOAL_RELPATH);
		const edited = readFileSync(filePath, "utf8").replace(
			"# Goal Prompt\n\nGolden fixture goal objective",
			"# Goal Prompt\n\nEdited objective from the prompt body",
		);
		writeFileSync(filePath, edited);

		const parsed = parseGoalFile(filePath);
		assert.ok(parsed);
		assert.equal(parsed.objective, "Edited objective from the prompt body");
		// Header-driven fields are unchanged by the body edit.
		assert.equal(parsed.id, "golden_fixture_goal");
		assert.equal(parsed.status, "active");
		assert.equal(parsed.verificationContract, "Run npm test (0 failures) and confirm every requirement is addressed.");
	} finally {
		// temp dir cleanup is best-effort.
	}
});

test("golden: serialize -> parse round-trips the fixture record", () => {
	const cwd = tempCwd();
	try {
		writeFixtureGoal(cwd);
		const parsed = parseGoalFile(path.join(cwd, FIXTURE_GOAL_RELPATH));
		assert.ok(parsed);
		const written = writeActiveGoalFile({ cwd }, parsed);
		const reparsed = parseGoalFile(path.join(cwd, GOALS_DIR, path.basename(written.activePath!)));
		assert.ok(reparsed);
		assert.equal(reparsed.id, parsed.id);
		assert.equal(reparsed.objective, parsed.objective);
		assert.equal(reparsed.status, parsed.status);
		assert.equal(reparsed.verificationContract, parsed.verificationContract);
		assert.deepEqual(reparsed.usage, parsed.usage);
		assert.deepEqual(reparsed.taskList, parsed.taskList);
	} finally {
		// temp dir cleanup is best-effort.
	}
});

test("golden: normalizeTaskList preserves the recursive tree from the fixture", () => {
	const { taskList } = expectedFixtureRecord(nowIso());
	const normalized = normalizeTaskList(JSON.parse(JSON.stringify(taskList)));
	assert.ok(normalized);
	assert.equal(normalized.blockCompletion, true);
	assert.equal(normalized.tasks[0]?.id, "task-1");
	assert.equal(normalized.tasks[0]?.subtasks?.[0]?.verificationContract, "Design doc reviewed");
	assert.equal(normalized.tasks[1]?.status, "skipped");
	assert.equal(normalized.tasks[1]?.skipReason, "User cancelled docs work");
	assert.equal(normalized.tasks[1]?.lightweightSubtasks, true);
});

test("golden: malformed or duplicate task items are dropped by normalization", () => {
	assert.equal(normalizeTaskItem({ id: "", title: "x" }), undefined);
	assert.equal(normalizeTaskItem({ id: "a", title: "" }), undefined);
	assert.deepEqual(normalizeTaskList({ tasks: [] }), undefined);
	assert.equal(normalizeTaskList({}), undefined);
	assert.equal(normalizeTaskList(null), undefined);
});

test("golden: paused + legacy autoContinue:true stays paused (status authoritative)", () => {
	// TECH.md Stage 1: persisted lifecycle status is authoritative. autoContinue
	// is an execution preference and must never rewrite status during reads or
	// migration. The legacy case {status:"paused", autoContinue:true} must stay
	// paused after normalization.
	const pausedWithAutoContinue = normalizeGoalRecord({
		id: "g1",
		objective: "x",
		status: "paused",
		autoContinue: true,
	});
	assert.equal(pausedWithAutoContinue?.status, "paused");
	assert.equal(pausedWithAutoContinue?.autoContinue, true, "autoContinue normalizes independently");
});

test("golden: paused + autoContinue:false stays paused", () => {
	const paused = normalizeGoalRecord({
		id: "g1",
		objective: "x",
		status: "paused",
		autoContinue: false,
	});
	assert.equal(paused?.status, "paused");
});

test("golden: all five statuses survive normalization for both continuation flag values", () => {
	// Persisted lifecycle status is authoritative and must survive every read
	// and migration, regardless of the autoContinue execution preference.
	const statuses = ["active", "paused", "blocked", "complete", "budget_limited"] as const;
	for (const status of statuses) {
		for (const autoContinue of [true, false]) {
			const record = normalizeGoalRecord({ id: "g1", objective: "x", status, autoContinue });
			assert.ok(record, `record must normalize for ${status} / autoContinue=${autoContinue}`);
			assert.equal(record!.status, status, `${status} must survive with autoContinue=${autoContinue}`);
			assert.equal(record!.autoContinue, autoContinue, `autoContinue must survive for ${status}`);
		}
	}
});

test("golden: legacy paused+autoContinue:true record stays paused through markdown parse", () => {
	// The exact legacy on-disk case must survive the markdown-file read path,
	// not only the pure normalizer. writeActiveGoalFile serializes a v3 file;
	// parseGoalFile re-normalizes it, and the paused status must survive.
	const cwd = tempCwd();
	try {
		const legacy = normalizeGoalRecord({
			id: "legacy-paused",
			objective: "Legacy paused goal",
			status: "paused",
			autoContinue: true,
		});
		assert.ok(legacy);
		const written = writeActiveGoalFile({ cwd }, legacy);
		const parsed = parseGoalFile(path.join(cwd, written.activePath ?? "missing"));
		assert.ok(parsed, "legacy file must parse");
		assert.equal(parsed.status, "paused", "parsed legacy record must stay paused");
		assert.equal(parsed.autoContinue, true, "autoContinue flag survives as data");
	} finally {
		try { rmSync(cwd, { recursive: true, force: true }); } catch {}
	}
});

// ── Ledger format golden ─────────────────────────────────────────────────────

test("golden: fixture ledger reads every event type and counts malformed lines", () => {
	const cwd = tempCwd();
	try {
		mkdirSync(path.join(cwd, GOALS_DIR), { recursive: true });
		writeFileSync(
			path.join(cwd, ".pi/goals/goal_events.jsonl"),
			readFileSync(fixturePath("ledger/goal_events_fixture.jsonl"), "utf8"),
		);
		const { events, malformed } = readGoalLedger({ cwd });
		assert.equal(events.length, 17, "all current event types must read");
		assert.equal(malformed, 1, "the non-JSON line must be counted as malformed");

		const types = events.map((e) => e.type).sort();
		assert.deepEqual(types, [
			"audit_result", "audit_skipped", "audit_started", "completion_requested",
			"goal_aborted", "goal_completed", "goal_created", "goal_focused",
			"goal_paused", "goal_resumed", "goal_tweaked", "goal_unfocused",
			"task_complete", "task_list_set", "task_reopened", "task_skipped",
			"task_skipped",
		]);
	} finally {
		// temp dir cleanup is best-effort.
	}
});

test("golden: ledger reconstruction yields stable terminal and focus state", () => {
	const cwd = tempCwd();
	try {
		mkdirSync(path.join(cwd, GOALS_DIR), { recursive: true });
		writeFileSync(
			path.join(cwd, ".pi/goals/goal_events.jsonl"),
			readFileSync(fixturePath("ledger/goal_events_fixture.jsonl"), "utf8"),
		);
		const { events } = readGoalLedger({ cwd });
		const { focusedGoalId, goals, terminalGoals } = reconstructGoalLedger(events);

		assert.equal(focusedGoalId, null, "focus is cleared after terminal transitions");
		assert.equal(goals.size, 0);
		assert.equal(terminalGoals.size, 2);
		assert.equal(terminalGoals.get("goal-a")?.latestStatus, "complete");
		assert.equal(terminalGoals.get("goal-a")?.completedAt, "2026-08-03T09:06:00.000Z");
		assert.equal(terminalGoals.get("goal-b")?.latestStatus, "aborted");
		assert.equal(terminalGoals.get("goal-b")?.abortedAt, "2026-08-03T09:07:00.000Z");
	} finally {
		// temp dir cleanup is best-effort.
	}
});

// ── Focus restoration golden ────────────────────────────────────────────────

test("golden: focus restores from a focus entry against the on-disk pool", () => {
	const cwd = tempCwd();
	try {
		writeFixtureGoal(cwd);
		const pool = readActiveGoalPool({ cwd });

		assert.equal(resolveSessionFocus({
			pool,
			focusEntry: { version: 1, focusedGoalId: "golden_fixture_goal", reason: "created" },
		}), "golden_fixture_goal");

		// Stale focus id -> unfocused, not a crash.
		assert.equal(resolveSessionFocus({
			pool,
			focusEntry: { version: 1, focusedGoalId: "ghost-goal", reason: "selected" },
		}), null);

		// No focus entry + default settings -> unfocused.
		assert.equal(resolveSessionFocus({ pool, focusEntry: null }), null);

		// No focus entry + autoSelectSingleGoal -> single open goal is selected.
		assert.equal(resolveSessionFocus({ pool, focusEntry: null, autoSelectSingleGoal: true }), "golden_fixture_goal");
	} finally {
		// temp dir cleanup is best-effort.
	}
});

// ── Compaction summary golden ────────────────────────────────────────────────

test("golden: compaction summary text for a focused active goal", () => {
	const cwd = tempCwd();
	try {
		writeFixtureGoal(cwd);
		const pool = readActiveGoalPool({ cwd });
		const goal = pool.get("golden_fixture_goal");
		assert.ok(goal);
		const summary = buildCompactionSummary({
			goalsById: pool,
			focusedGoalId: goal.id,
			ledgerEvents: [],
		});
		assert.equal(summary, [
			"[FOCUSED GOAL]",
			"Goal golden_fixture_goal — running",
			"  Objective: Golden fixture goal objective",
			"  Usage: 123K (123,456) tokens",
			"  Time: 1h00m00s",
			"",
			"[INSTRUCTION]",
			"Continue from the focused goal above, or ask the user to run /goal-focus.",
			"Do not rely on chat memory for goal state; use the facts above.",
		].join("\n"));
	} finally {
		// temp dir cleanup is best-effort.
	}
});

test("golden: compaction summary with ledger terminal goals", () => {
	const cwd = tempCwd();
	try {
		writeFixtureGoal(cwd);
		mkdirSync(path.join(cwd, GOALS_DIR), { recursive: true });
		writeFileSync(
			path.join(cwd, ".pi/goals/goal_events.jsonl"),
			readFileSync(fixturePath("ledger/goal_events_fixture.jsonl"), "utf8"),
		);
		const { events } = readGoalLedger({ cwd });
		const pool = readActiveGoalPool({ cwd });
		const goal = pool.get("golden_fixture_goal");
		assert.ok(goal);

		const summary = buildCompactionSummary({
			goalsById: pool,
			focusedGoalId: goal.id,
			ledgerEvents: events,
		});
		assert.match(summary, /^\[FOCUSED GOAL\]\nGoal golden_fixture_goal — running\n/);
		assert.match(summary, /\[TERMINAL GOALS — 2 completed or aborted\]\n- goal-a — completed at 2026-08-03T09:06:00\.000Z\n- goal-b — aborted at 2026-08-03T09:07:00\.000Z/);
	} finally {
		// temp dir cleanup is best-effort.
	}
});

test("golden: compaction summary for an empty session", () => {
	const summary = buildCompactionSummary({
		goalsById: new Map(),
		focusedGoalId: null,
		ledgerEvents: [],
	});
	assert.equal(summary, [
		"[NO GOALS]",
		"No open or terminal goals recorded in this session.",
		"[INSTRUCTION]",
		"Continue from the focused goal above, or ask the user to run /goal-focus.",
		"Do not rely on chat memory for goal state; use the facts above.",
	].join("\n"));
});

// ── Auditor verdict marker contract ─────────────────────────────────────────

test("golden: auditor verdict marker contract is approval-disapproval exclusive", () => {
	// Pins the <approved/> / <disapproved/> marker contract that the completion
	// audit currently uses. parseAuditorDecision requires explicit approval and
	// lets disapproval win when both markers appear.
	assert.deepEqual(parseAuditorDecision("Looks good\n<approved/>"), { approved: true, disapproved: false });
	assert.deepEqual(parseAuditorDecision("Nope\n<disapproved/>"), { approved: false, disapproved: true });
	assert.deepEqual(parseAuditorDecision("confused <approved/> <disapproved/>"), { approved: false, disapproved: true });
	assert.deepEqual(parseAuditorDecision("no marker"), { approved: false, disapproved: false });
});

// ── Sanity: serializeGoalFile still emits the fixture shape ─────────────────

test("golden: serializeGoalFile emits the same header/body structure the fixture uses", () => {
	const cwd = tempCwd();
	try {
		writeFixtureGoal(cwd);
		const parsed = parseGoalFile(path.join(cwd, FIXTURE_GOAL_RELPATH));
		assert.ok(parsed);
		const serialized = serializeGoalFile(parsed);
		assert.match(serialized, /^\{/);
		assert.match(serialized, /"version": 3/);
		assert.match(serialized, /# Goal Prompt/);
		assert.match(serialized, /## Progress/);
		assert.match(serialized, /- Status: running/);
		assert.match(serialized, /## Tasks\n\n<!-- blockCompletion: true -->/);
		assert.match(serialized, /- \[x\] task-1: Implement core — evidence: npm run check passes/);
		assert.match(serialized, /- \[~\] task-2: Docs — skipped: User cancelled docs work/);
	} finally {
		// temp dir cleanup is best-effort.
	}
});

test("golden: invalid persisted token budgets normalize to absent", () => {
	// Stage 4 contract: fractional, zero, negative, infinite, and unsafe
	// persisted budgets become absent rather than silently changing meaning.
	for (const bad of [0, -5, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
		const record = normalizeGoalRecord({ id: "g1", objective: "x", status: "active", tokenBudget: bad });
		assert.equal(record?.tokenBudget, undefined, `persisted tokenBudget ${bad} must normalize to absent`);
	}
	const okRecord = normalizeGoalRecord({ id: "g1", objective: "x", status: "active", tokenBudget: 5000 });
	assert.equal(okRecord?.tokenBudget, 5000, "valid persisted budget survives");
});

test("golden: validateTokenBudgetInput rejects invalid live input with user-facing messages", () => {
	const bad = validateTokenBudgetInput(2.5);
	assert.equal(bad.ok, false);
	if (!bad.ok) assert.ok(bad.message.length > 0, "rejection carries a message");
	assert.equal(validateTokenBudgetInput(0).ok, false);
	assert.equal(validateTokenBudgetInput(-3).ok, false);
	assert.equal(validateTokenBudgetInput(Number.MAX_SAFE_INTEGER + 1).ok, false);
	const good = validateTokenBudgetInput(5000);
	assert.ok(good.ok);
	if (good.ok) assert.equal(good.value, 5000);
});
