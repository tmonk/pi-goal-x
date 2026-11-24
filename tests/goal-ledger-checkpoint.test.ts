import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import test from "node:test";

import {
	appendGoalEvent,
	goalLedgerPath,
	invalidateGoalLedgerCache,
	LEDGER_CHECKPOINT_FILE,
	LEDGER_CHECKPOINT_VERSION,
	loadLedgerState,
	readGoalLedger,
	type GoalLedgerContext,
	type GoalLedgerEvent,
} from "../extensions/goal-ledger.ts";

function tempCtx(): GoalLedgerContext {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "goal-ledger-checkpoint-test-"));
	return { cwd: dir };
}

function cleanup(ctx: GoalLedgerContext): void {
	try {
		fs.rmSync(ctx.cwd, { recursive: true, force: true });
	} catch {}
}

function checkpointPath(ctx: GoalLedgerContext): string {
	return path.join(ctx.cwd, ".pi", "goals", LEDGER_CHECKPOINT_FILE);
}

function appendGoal(ctx: GoalLedgerContext, goalId: string, extra: GoalLedgerEvent[] = []): GoalLedgerEvent[] {
	const events: GoalLedgerEvent[] = [
	{ type: "goal_created", goalId, objective: `objective ${goalId}`, sisyphus: false, autoContinue: true, at: new Date(Date.UTC(2026, 8, 1) + Math.random() * 1000).toISOString() },
	{ type: "goal_focused", goalId, reason: "created", at: new Date(Date.UTC(2026, 8, 1) + Math.random() * 1000).toISOString() },
	...extra,
	];
	for (const event of events) appendGoalEvent(ctx, event);
	return events;
}

test("checkpoint: loadLedgerState falls back to full parse and writes a fresh checkpoint", () => {
	const ctx = tempCtx();
	try {
		appendGoal(ctx, "g1");
		appendGoal(ctx, "g2");
		const ledgerBytes = fs.statSync(goalLedgerPath(ctx)).size;
		assert.ok(!fs.existsSync(checkpointPath(ctx)), "no checkpoint before first load");

		invalidateGoalLedgerCache(); // append only extends an existing cache entry
		const result = loadLedgerState(ctx);
		assert.equal(result.source, "full");
		assert.equal(result.coveredEvents, 4);
		assert.equal(result.state.goals.size, 2);
		assert.equal(result.state.focusedGoalId, "g2");
		assert.equal(result.recentEventsByGoal.get("g1")?.length, 2);
		// A fresh checkpoint is written so the next cold start is bounded.
		assert.ok(fs.existsSync(checkpointPath(ctx)), "checkpoint written after full load");

		// Second load from a cold cache serves the checkpoint.
		invalidateGoalLedgerCache();
		const hit = loadLedgerState(ctx);
		assert.equal(hit.source, "checkpoint");
		assert.equal(hit.coveredBytes, ledgerBytes);
		assert.equal(hit.state.focusedGoalId, "g2");
		assert.equal(hit.recentEventsByGoal.get("g1")?.length, 2);
		assert.equal(hit.malformed, 0);
	} finally {
		cleanup(ctx);
	}
});

test("checkpoint: warm cache serves zero-op and matches the checkpoint view", () => {
	const ctx = tempCtx();
	try {
		appendGoal(ctx, "g1");
		invalidateGoalLedgerCache();
		assert.equal(loadLedgerState(ctx).source, "full", "cold load warms the cache");
		const fromCache = loadLedgerState(ctx);
		assert.equal(fromCache.source, "cache");
		assert.equal(fromCache.state.focusedGoalId, "g1");
	} finally {
		cleanup(ctx);
	}
});

test("checkpoint: tail replay applies only the ledger bytes past the checkpoint", () => {
	const ctx = tempCtx();
	try {
		appendGoal(ctx, "g1");
		// Bootstrap a checkpoint covering the current ledger.
		invalidateGoalLedgerCache();
		const first = loadLedgerState(ctx);
		assert.equal(first.source, "full");
		const coveredBefore = first.coveredBytes;

		// Grow the ledger externally (no in-process append, so the checkpoint is
		// not maintained by the mutation path and the tail path must engage).
		const ledgerPath = goalLedgerPath(ctx);
		const external: GoalLedgerEvent = { type: "goal_created", goalId: "g2", objective: "external", sisyphus: false, autoContinue: true, at: new Date().toISOString() };
		fs.appendFileSync(ledgerPath, JSON.stringify(external) + "\n", "utf8");

		invalidateGoalLedgerCache();
		const result = loadLedgerState(ctx);
		assert.equal(result.source, "tail");
		assert.ok(result.coveredBytes > coveredBefore, "coverage advanced past the old checkpoint");
		assert.equal(result.coveredEvents, 3);
		assert.equal(result.state.goals.size, 2);
		assert.equal(result.state.focusedGoalId, "g1");
		assert.equal(result.recentEventsByGoal.get("g2")?.length, 1);

		// The refreshed checkpoint now serves cold reads directly.
		invalidateGoalLedgerCache();
		const hit = loadLedgerState(ctx);
		assert.equal(hit.source, "checkpoint");
		assert.equal(hit.state.focusedGoalId, "g1");
	} finally {
		cleanup(ctx);
	}
});

test("checkpoint: version mismatch falls back to the full parse", () => {
	const ctx = tempCtx();
	try {
		appendGoal(ctx, "g1");
		invalidateGoalLedgerCache();
		loadLedgerState(ctx); // writes checkpoint
		// Corrupt the version to simulate a future format.
		const raw = JSON.parse(fs.readFileSync(checkpointPath(ctx), "utf8"));
		raw.version = LEDGER_CHECKPOINT_VERSION + 1;
		fs.writeFileSync(checkpointPath(ctx), JSON.stringify(raw));

		invalidateGoalLedgerCache();
		const result = loadLedgerState(ctx);
		assert.equal(result.source, "full");
		assert.equal(result.state.focusedGoalId, "g1");
	} finally {
		cleanup(ctx);
	}
});

test("checkpoint: malformed checkpoint body falls back to the full parse", () => {
	const ctx = tempCtx();
	try {
		appendGoal(ctx, "g1");
		fs.writeFileSync(checkpointPath(ctx), "{not json at all");
		invalidateGoalLedgerCache();
		const result = loadLedgerState(ctx);
		assert.equal(result.source, "full");
		assert.equal(result.state.goals.size, 1);
	} finally {
		cleanup(ctx);
	}
});

test("checkpoint: ledger truncated below checkpoint coverage falls back to the full parse", () => {
	const ctx = tempCtx();
	try {
		appendGoal(ctx, "g1");
		appendGoal(ctx, "g2");
		invalidateGoalLedgerCache();
		loadLedgerState(ctx); // checkpoint covers 4 events
		// Truncate the ledger (external rewrite).
		const ledgerPath = goalLedgerPath(ctx);
		const lines = fs.readFileSync(ledgerPath, "utf8").split("\n").filter(Boolean);
		fs.writeFileSync(ledgerPath, lines.slice(0, 2).join("\n") + "\n");

		invalidateGoalLedgerCache();
		const result = loadLedgerState(ctx);
		assert.equal(result.source, "full");
		assert.equal(result.state.goals.size, 1);
		assert.equal(result.coveredEvents, 2);
	} finally {
		cleanup(ctx);
	}
});

test("checkpoint: external ledger growth beyond a cold checkpoint is replayed", () => {
	const ctx = tempCtx();
	try {
		appendGoal(ctx, "g1");
		invalidateGoalLedgerCache();
		loadLedgerState(ctx); // checkpoint covers g1's events only
		// External process appends g2 without going through this module's cache.
		const ledgerPath = goalLedgerPath(ctx);
		const external: GoalLedgerEvent = { type: "goal_created", goalId: "g2", objective: "external", sisyphus: false, autoContinue: true, at: new Date().toISOString() };
		fs.appendFileSync(ledgerPath, JSON.stringify(external) + "\n", "utf8");

		invalidateGoalLedgerCache();
		const result = loadLedgerState(ctx);
		assert.equal(result.source, "tail");
		assert.equal(result.state.goals.size, 2);
		assert.equal(result.state.focusedGoalId, "g1");
		assert.equal(result.recentEventsByGoal.get("g2")?.length, 1);
	} finally {
		cleanup(ctx);
	}
});

test("checkpoint: mutation-path maintenance keeps the checkpoint current without a cold load", () => {
	const ctx = tempCtx();
	try {
		appendGoal(ctx, "g1");
		// Bootstrap via a full load, then append with the cache warm. The disk
		// checkpoint write is throttled (32 appends / 2s) to hold the NAF append
		// headroom, so drive 16 goal appends (32 events) past the boundary.
		invalidateGoalLedgerCache();
		loadLedgerState(ctx);
		for (let i = 2; i <= 17; i++) appendGoal(ctx, `g${i}`);
		const cpRaw = JSON.parse(fs.readFileSync(checkpointPath(ctx), "utf8"));
		assert.equal(cpRaw.version, LEDGER_CHECKPOINT_VERSION);
		assert.ok(cpRaw.coveredEvents >= 2 + 32, `disk checkpoint advanced past the throttle boundary (${cpRaw.coveredEvents})`);

		// A cold read (fresh cache) now hits the checkpoint with all events.
		invalidateGoalLedgerCache();
		const result = loadLedgerState(ctx);
		assert.equal(result.source, "checkpoint");
		assert.equal(result.state.goals.size, 17);
		assert.equal(result.state.focusedGoalId, "g17");
	} finally {
		cleanup(ctx);
	}
});

test("checkpoint: readGoalLedger (full-events API) is untouched and consistent", () => {
	const ctx = tempCtx();
	try {
		appendGoal(ctx, "g1");
		const full = readGoalLedger(ctx);
		assert.equal(full.events.length, 2);
		assert.equal(full.malformed, 0);
		// The checkpoint file lives next to the ledger and does not change the
		// JSONL event stream.
		const ledgerPath = goalLedgerPath(ctx);
		const lines = fs.readFileSync(ledgerPath, "utf8").split("\n").filter(Boolean);
		assert.equal(lines.length, 2);
	} finally {
		cleanup(ctx);
	}
});
