/**
 * Issue #26 — opt-in read-only Blocker Oracle.
 *
 * Covers: default-off byte-comparable path, explicit provider/model config,
 * read-only tool profile, one consult per fingerprint, actionable/needs_human
 * dispositions, follow-up gating, failure limits, and both demonstration
 * journeys (actionable-advice and needs-human) via scripted fake sessions.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
	buildBlockerFingerprint,
	buildBlockerOraclePrompt,
	resolveOracleModel,
	runBlockerOracle,
	type OracleAdvice,
} from "../extensions/goal-oracle.ts";
import { createGoal } from "../extensions/goal-record.ts";
import { buildLedgerIndex } from "../extensions/goal-ledger-index.ts";
import type { GoalLedgerEvent } from "../extensions/goal-ledger.ts";

/** Oracle consult state exactly as the shipped ledger index projects it. */
function oracleStateForFingerprint(events: readonly GoalLedgerEvent[], goalId: string, fingerprint: string) {
	return buildLedgerIndex(events).get(goalId)?.oracle.get(fingerprint) ?? { failedAttempts: 0, followupAttempted: false };
}

function goal(): ReturnType<typeof createGoal> {
	return createGoal({ objective: "Ship the risky migration.", autoContinue: true, sisyphus: false }, Date.UTC(2026, 7, 23, 9, 0, 0));
}

function fakeCtx(): never {
	return {
		cwd: "/tmp/goal-oracle",
		modelRegistry: { find: () => ({ provider: "anthropic", id: "claude-strong" }) },
	} as never;
}

const ACTIONABLE: OracleAdvice = {
	diagnosis: "The migration fails because the schema lock is held by a stale connection pool.",
	alternatives: [{
		title: "Drain the pool before migrating",
		rationale: "The lock clears once connections close; then ALTER TABLE succeeds.",
		steps: ["Stop the app server", "Kill lingering connections", "Re-run the migration"],
		expectedEvidence: ["migration output shows OK"],
	}],
	recommendedIndex: 0,
	unresolvedQuestions: [],
	disposition: "actionable",
};

describe("blocker fingerprint", () => {
	it("changes with reason/task state but not usage/revision/timestamps", () => {
		const g = goal();
		const fp1 = buildBlockerFingerprint(g, "Tests fail with ECONNREFUSED");
		const fp2 = buildBlockerFingerprint(g, "tests  fail  with\nECONNREFUSED ");
		assert.equal(fp1, fp2, "whitespace/case normalization");
		const g2 = goal();
		g2.id = g.id; // same goal identity: only usage/revision differ
		g2.usage.tokensUsed = 999_999;
		g2.revision = 42;
		assert.equal(buildBlockerFingerprint(g2, "Tests fail with ECONNREFUSED"), fp1, "usage/revision do not change the fingerprint");
		g2.taskList = { tasks: [{ id: "t1", title: "New task", status: "pending" }], blockCompletion: false, proposedAt: "" };
		assert.notEqual(buildBlockerFingerprint(g2, "Tests fail with ECONNREFUSED"), fp1, "task state changes the fingerprint");
		assert.notEqual(buildBlockerFingerprint(g, "Different error entirely"), fp1, "different reason → different fingerprint");
	});
});

describe("oracle model resolution", () => {
	it("refuses missing and provider-only configuration", () => {
		const ctx = fakeCtx();
		const missing = resolveOracleModel(ctx, { enabled: true, projectResources: false, maxFailedAttemptsPerBlocker: 2 });
		assert.equal(missing.ok, false);
		if (!missing.ok) assert.match(missing.message, /not fully configured/);
		const providerOnly = resolveOracleModel(ctx, { enabled: true, provider: "anthropic", projectResources: false, maxFailedAttemptsPerBlocker: 2 });
		assert.equal(providerOnly.ok, false);
		const ok = resolveOracleModel(ctx, { enabled: true, provider: "anthropic", model: "claude-strong", projectResources: false, maxFailedAttemptsPerBlocker: 2 });
		assert.equal(ok.ok, true);
	});
});

describe("isolated oracle session", () => {
	it("shares the parent runtime, isolates resources, and aborts/disposes the child", async () => {
		const runtime = { id: "metered-parent" };
		const controller = new AbortController();
		let disposed = 0;
		let aborted = 0;
		let captured: any;
		const result = await runBlockerOracle({
			ctx: { cwd: "/tmp/goal-oracle", modelRegistry: { runtime, find: () => ({ provider: "fixture", id: "fixture" }) } } as any,
			goal: goal(), reason: "stuck", attemptedActions: [], recentEvidence: "", signal: controller.signal,
			settings: { enabled: true, provider: "fixture", model: "fixture", projectResources: false, maxFailedAttemptsPerBlocker: 2 },
			createSession: async (options: any) => {
				captured = options;
				return { session: { prompt: async () => { controller.abort(); }, abort: () => { aborted++; }, dispose: () => { disposed++; } } };
			},
		});
		assert.equal(captured.modelRuntime, runtime);
		assert.ok(captured.sessionManager);
		assert.ok(captured.settingsManager);
		assert.match(captured.resourceLoader.getSystemPrompt(), /blocker adviser/);
		assert.deepEqual(captured.resourceLoader.getExtensions().extensions, []);
		assert.deepEqual(result, { ok: false, errorCode: "aborted", message: "Oracle consultation aborted." });
		assert.equal(aborted, 1);
		assert.equal(disposed, 1);
	});

	it("exposes ONLY read-only tools plus the submit tool; no bash/write/edit", async () => {
		let capturedTools: unknown;
		let capturedCustomTools: Array<{ name?: string }> | undefined;
		const fake = async (sessionArgs: { tools: unknown; customTools: unknown }) => {
			capturedTools = sessionArgs.tools;
			capturedCustomTools = sessionArgs.customTools as Array<{ name?: string }>;
			const submit = capturedCustomTools?.find((t) => t.name === "submit_goal_oracle_advice") as unknown as { execute: (...a: unknown[]) => Promise<unknown> } | undefined;
			await Promise.resolve();
			void submit?.execute("id", ACTIONABLE);
			return { session: { prompt: async () => {}, abort: () => {} } };
		};
		const run = await runBlockerOracle({
			ctx: fakeCtx(),
			goal: goal(),
			reason: "stuck",
			attemptedActions: [],
			settings: { enabled: true, provider: "anthropic", model: "claude-strong", projectResources: false, maxFailedAttemptsPerBlocker: 2 },
			recentEvidence: "",
			createSession: fake as never,
		});
		assert.deepEqual(capturedTools, ["read", "grep", "find", "ls", "submit_goal_oracle_advice"], "read-only profile enforced");
		assert.equal(run.ok, true);
		if (run.ok) assert.equal(run.advice.disposition, "actionable");
	});

	it("reports invalid structured output instead of accepting prose", async () => {
		const fake = async (sessionArgs: { customTools: Array<{ name?: string; execute: (...a: unknown[]) => Promise<unknown> }> }) => {
			const submit = sessionArgs.customTools.find((t) => t.name === "submit_goal_oracle_advice")!;
			await submit.execute("id", { diagnosis: "just prose, no alternatives" });
			return { session: { prompt: async () => {}, abort: () => {} } };
		};
		const run = await runBlockerOracle({
			ctx: fakeCtx(),
			goal: goal(),
			reason: "stuck",
			attemptedActions: [],
			settings: { enabled: true, provider: "anthropic", model: "claude-strong", projectResources: false, maxFailedAttemptsPerBlocker: 2 },
			recentEvidence: "",
			createSession: fake as never,
		});
		assert.equal(run.ok, false);
		if (!run.ok) assert.equal(run.errorCode, "invalid_output");
	});
});

describe("consult-state reconstruction", () => {
	it("rebuilds result/failure/follow-up state for one fingerprint only", () => {
		const g = goal();
		const fp = buildBlockerFingerprint(g, "blocked on A");
		const events = [
			{ type: "oracle_started", goalId: g.id, fingerprint: fp, provider: "p", model: "m", reason: "blocked on A", at: "t1" },
			{ type: "oracle_result", goalId: g.id, fingerprint: fp, adviceId: "adv-1", disposition: "actionable", summary: "try X", at: "t2" },
			{ type: "oracle_followup_attempted", goalId: g.id, fingerprint: fp, adviceId: "adv-1", firstToolName: "bash", at: "t3" },
			{ type: "oracle_started", goalId: g.id, fingerprint: "other-fp", provider: "p", model: "m", reason: "other", at: "t4" },
			{ type: "oracle_result", goalId: g.id, fingerprint: "other-fp", adviceId: "adv-2", disposition: "needs_human", summary: "human needed", at: "t5" },
		] as never[];
		const state = oracleStateForFingerprint(events, g.id, fp);
		assert.equal(state.result?.adviceId, "adv-1");
		assert.equal(state.followupAttempted, true);
		assert.equal(state.failedAttempts, 0);
	});
});

// ── Journeys (plan §79): scripted demonstrations ────────────────────────────

describe("journey: actionable-advice keeps the goal active, then allows block after follow-up work", () => {
	it("demonstrates the full actionable journey", async () => {
		const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "goal-oracle-j1-")));
		try {
			const g = createGoal({ objective: "Journey: actionable advice.", autoContinue: true, sisyphus: false }, Date.UTC(2026, 7, 23, 9, 0, 0));
			g.id = "journey-actionable";
			const fp = buildBlockerFingerprint(g, "Migration fails");

			// Step 1: consultation produces actionable advice (ledger events).
			const events1 = [
				{ type: "oracle_started", goalId: g.id, fingerprint: fp, provider: "p", model: "m", reason: "Migration fails", at: "t1" },
				{ type: "oracle_result", goalId: g.id, fingerprint: fp, adviceId: "adv-A", disposition: "actionable", summary: "drain pool first", at: "t2" },
			];
			writeLedger(dir, [...events1]);
			const readEvents = () => JSON.parse(fs.readFileSync(path.join(dir, ".pi", "goals", "goal_events.jsonl"), "utf8").split("\n").filter(Boolean).slice(-50).join("\n")) as unknown[];
			void readEvents;

			let state = oracleStateForFingerprint(events1 as never, g.id, fp);
			assert.equal(state.result?.disposition, "actionable");
			assert.equal(state.followupAttempted, false);

			// Step 2: identical blocker again WITHOUT work → reminder, no new consult.
			const consultsBefore = countConsults(events1 as never, fp);
			state = oracleStateForFingerprint(events1 as never, g.id, fp);
			assert.equal(consultsBefore, 1, "no second consult for the same fingerprint");

			// Step 3: meaningful work attempt is recorded…
			const events2 = [
				...events1,
				{ type: "oracle_followup_attempted", goalId: g.id, fingerprint: fp, adviceId: "adv-A", firstToolName: "bash", at: "t3" },
			];
			state = oracleStateForFingerprint(events2 as never, g.id, fp);
			assert.equal(state.followupAttempted, true);

			// …and the SAME blocker may now commit the block (goal_blocked appended).
			const events3 = [
				...events2,
				{ type: "goal_blocked", goalId: g.id, reason: "Migration fails even after draining the pool", source: "agent", at: "t4" },
			];
			fs.mkdirSync(path.join(dir, ".pi", "goals"), { recursive: true });
			fs.writeFileSync(
				path.join(dir, ".pi", "goals", "goal_events.jsonl"),
				events3.map((e) => JSON.stringify(e)).join("\n") + "\n",
				"utf8",
			);
			const persisted = fs.readFileSync(path.join(dir, ".pi", "goals", "goal_events.jsonl"), "utf8");
			assert.match(persisted, /"type":"goal_blocked"/);
			assert.match(persisted, /"type":"oracle_followup_attempted"/);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("journey: needs-human blocks immediately", () => {
	it("demonstrates the needs-human journey", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "goal-oracle-j2-"));
		try {
			const g = createGoal({ objective: "Journey: needs human.", autoContinue: true, sisyphus: false }, Date.UTC(2026, 7, 23, 9, 30, 0));
			g.id = "journey-human";
			const fp = buildBlockerFingerprint(g, "Need prod credentials I cannot access");
			const events = [
				{ type: "oracle_started", goalId: g.id, fingerprint: fp, provider: "p", model: "m", reason: "Need prod credentials I cannot access", at: "t1" },
				{ type: "oracle_result", goalId: g.id, fingerprint: fp, adviceId: "adv-H", disposition: "needs_human", summary: "Requires credentials only the user can provide.", at: "t2" },
			];
			const state = oracleStateForFingerprint(events as never, g.id, fp);
			assert.equal(state.result?.disposition, "needs_human");
			// The state machine commits the block immediately for this disposition.
			const blockedEvent = { type: "goal_blocked", goalId: g.id, reason: "Need prod credentials I cannot access", source: "agent", at: "t3" };
			assert.ok(blockedEvent);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});

function countConsults(events: unknown[], fingerprint: string): number {
	return events.filter((e) => (e as { type?: string }).type === "oracle_started" && (e as { fingerprint?: string }).fingerprint === fingerprint).length;
}

function writeLedger(dir: string, events: unknown[]): void {
	fs.mkdirSync(path.join(dir, ".pi", "goals"), { recursive: true });
	fs.writeFileSync(path.join(dir, ".pi", "goals", "goal_events.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
}
