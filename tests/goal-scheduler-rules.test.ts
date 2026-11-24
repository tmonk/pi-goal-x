/** Unit tests for the pure scheduling decisions; no session, timers or settings. */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { newGoalScheduler, type GoalSchedulerState } from "../extensions/goal-scheduler-state.ts";
import {
	claimDispatch, declareWait, dispatchKind, goalContentKey, idleDelay, isRepairReady, markImplicitReady, nextIdlePacing, releaseToIdle, waitHold,
} from "../extensions/goal-scheduler-rules.ts";
import { WakeTimer } from "../extensions/goal-wake-timer.ts";
import { createGoal } from "../extensions/goal-record.ts";

const NOW = 1_700_000_000_000;
const ready = (purpose: "ready" | "repair" | "kickoff" | "recovery" = "ready"): GoalSchedulerState =>
	({ ...newGoalScheduler("owner"), phase: "ready", decision: { kind: "ready", purpose } });
const waiting = (wait: Partial<NonNullable<GoalSchedulerState["wait"]>> = {}): GoalSchedulerState => ({
	...newGoalScheduler("owner"), phase: "waiting", decision: { kind: "wait" },
	wait: { id: "w", token: "t", reason: "r", deadline: NOW + 60_000, ...wait },
});
const iso = (offset: number) => new Date(NOW + offset).toISOString();

describe("idle pacing", () => {
	it("backs off 0, 30s, 60s, 120s, 240s then 300s and saturates the streak", () => {
		let idle: GoalSchedulerState["idle"];
		const delays: number[] = [];
		for (let i = 0; i < 8; i++) {
			idle = nextIdlePacing(idle, false, NOW);
			delays.push(idle!.nextAt - NOW);
		}
		assert.deepEqual(delays, [0, 30_000, 60_000, 120_000, 240_000, 300_000, 300_000, 300_000]);
		assert.equal(idle!.runs, 6);
	});

	it("resets after progress", () => {
		assert.equal(nextIdlePacing({ runs: 4, nextAt: NOW }, true, NOW), undefined);
	});

	it("only delays a plain ready state", () => {
		const paced = { ...ready(), idle: { runs: 2, nextAt: NOW + 5_000 } };
		assert.equal(idleDelay(paced, NOW), 5_000);
		assert.equal(idleDelay(paced, NOW + 9_000), 0);
		assert.equal(idleDelay({ ...paced, decision: { kind: "ready", purpose: "kickoff" } }, NOW), 0);
		assert.equal(idleDelay({ ...paced, phase: "idle" }, NOW), 0);
	});
});

describe("goal content snapshot", () => {
	it("changes with the task list and objective but not with usage", () => {
		const goal = createGoal({ objective: "Ship the feature with every check green", autoContinue: false, sisyphus: false });
		const before = goalContentKey(goal);
		assert.equal(goalContentKey({ ...goal, usage: { tokensUsed: 99, activeSeconds: 9 } }), before);
		assert.notEqual(goalContentKey({ ...goal, objective: "Something else entirely and long enough" }), before);
		assert.notEqual(goalContentKey({ ...goal, currentTaskId: "t1" }), before);
		assert.equal(goalContentKey(null), undefined);
	});
});

describe("ready and repair states", () => {
	it("recognises repair and turns it into a plain ready with a new generation", () => {
		const s = ready("repair");
		assert.equal(isRepairReady(s), true);
		assert.equal(isRepairReady(ready()), false);
		const generation = s.generation;
		markImplicitReady(s);
		assert.deepEqual({ phase: s.phase, decision: s.decision, dispatch: s.dispatch }, { phase: "ready", decision: { kind: "ready", purpose: "ready" }, dispatch: undefined });
		assert.notEqual(s.generation, generation);
	});

	it("releases to idle and clears wait, pacing and repair", () => {
		const s = { ...waiting(), repairUsed: true, idle: { runs: 3, nextAt: NOW } };
		releaseToIdle(s);
		assert.deepEqual({ phase: s.phase, decision: s.decision, wait: s.wait, repairUsed: s.repairUsed, idle: s.idle }, { phase: "idle", decision: undefined, wait: undefined, repairUsed: false, idle: undefined });
	});
});

describe("wait declaration", () => {
	it("needs a strict contract", () => {
		assert.throws(() => declareWait(newGoalScheduler("o"), { kind: "wait", reason: "r", deadline: iso(1000) }, false, NOW), /strictExecutionContract=true/);
	});

	it("rejects an empty or oversized reason and a past or zoneless deadline", () => {
		const s = () => newGoalScheduler("o");
		assert.throws(() => declareWait(s(), { kind: "wait", reason: "  ", deadline: iso(1000) }, true, NOW), /nonempty reason/);
		assert.throws(() => declareWait(s(), { kind: "wait", reason: "x".repeat(2001), deadline: iso(1000) }, true, NOW), /nonempty reason/);
		assert.throws(() => declareWait(s(), { kind: "wait", reason: "r", deadline: iso(-1) }, true, NOW), /future ISO deadline/);
		assert.throws(() => declareWait(s(), { kind: "wait", reason: "r", deadline: "2999-01-01T00:00:00" }, true, NOW), /future ISO deadline/);
	});

	it("starts a wait with polling and enters the waiting phase", () => {
		const s = newGoalScheduler("o");
		declareWait(s, { kind: "wait", reason: " build ", deadline: iso(60_000), polling: { interval_seconds: 10, max_checks: 3 } }, true, NOW);
		assert.equal(s.phase, "waiting");
		assert.deepEqual(s.decision, { kind: "wait" });
		assert.deepEqual({ reason: s.wait!.reason, intervalMs: s.wait!.intervalMs, remainingChecks: s.wait!.remainingChecks, nextCheckAt: s.wait!.nextCheckAt }, { reason: "build", intervalMs: 10_000, remainingChecks: 3, nextCheckAt: NOW + 10_000 });
	});

	it("rejects an unknown wait id and bad polling", () => {
		const s = () => newGoalScheduler("o");
		assert.throws(() => declareWait(s(), { kind: "wait", reason: "r", deadline: iso(1000), wait_id: "x" }, true, NOW), /Unknown wait_id/);
		assert.throws(() => declareWait(s(), { kind: "wait", reason: "r", deadline: iso(1000), polling: { interval_seconds: 0, max_checks: 1 } }, true, NOW), /Polling requires/);
		assert.throws(() => declareWait(s(), { kind: "wait", reason: "r", deadline: iso(1000), polling: { interval_seconds: 1, max_checks: 0 } }, true, NOW), /Polling requires/);
	});

	it("re-declares the current wait with a fresh token and keeps its checks", () => {
		const s = newGoalScheduler("o");
		const deadline = iso(60_000);
		declareWait(s, { kind: "wait", reason: "r", deadline, polling: { interval_seconds: 10, max_checks: 3 } }, true, NOW);
		const first = s.wait!;
		const token = first.token;
		first.signalled = true;
		declareWait(s, { kind: "wait", reason: "r", deadline, wait_id: first.id }, true, NOW + 4_000);
		assert.notEqual(s.wait!.token, token);
		assert.equal(s.wait!.signalled, false);
		assert.equal(s.wait!.nextCheckAt, NOW + 14_000);
		assert.equal(s.wait!.remainingChecks, 3);
	});

	it("refuses to move the deadline or reset polling of the current wait", () => {
		const s = newGoalScheduler("o");
		declareWait(s, { kind: "wait", reason: "r", deadline: iso(60_000), polling: { interval_seconds: 10, max_checks: 3 } }, true, NOW);
		const id = s.wait!.id;
		assert.throws(() => declareWait(s, { kind: "wait", reason: "r", deadline: iso(90_000), wait_id: id }, true, NOW), /original deadline/);
		assert.throws(() => declareWait(s, { kind: "wait", reason: "r", deadline: iso(60_000), wait_id: id, polling: { interval_seconds: 5, max_checks: 3 } }, true, NOW), /cannot be reset/);
	});
});

describe("wait hold", () => {
	it("pauses at the deadline even outside the waiting phase", () => {
		const s = { ...waiting({ deadline: NOW }), phase: "ready" as const };
		assert.deepEqual(waitHold(s, NOW), { action: "pause", reason: "Wait deadline reached.", releaseAccounting: false });
	});

	it("lets a state with no wait through", () => {
		assert.deepEqual(waitHold(ready(), NOW), { action: "proceed", releaseAccounting: false });
	});

	it("proceeds on a signalled wait and releases accounting", () => {
		assert.deepEqual(waitHold(waiting({ signalled: true }), NOW), { action: "proceed", releaseAccounting: true });
	});

	it("pauses when polling has no checks left", () => {
		const hold = waitHold(waiting({ intervalMs: 1000, remainingChecks: 0, nextCheckAt: NOW - 1 }), NOW);
		assert.deepEqual(hold, { action: "pause", reason: "Wait check allowance exhausted.", releaseAccounting: true });
	});

	it("sleeps until the next check, or the deadline when it comes first", () => {
		assert.deepEqual(waitHold(waiting({ intervalMs: 1000, remainingChecks: 2, nextCheckAt: NOW + 5_000 }), NOW), { action: "timer", delay: 5_000, releaseAccounting: true });
		assert.deepEqual(waitHold(waiting({ intervalMs: 1000, remainingChecks: 2, nextCheckAt: NOW + 90_000 }), NOW), { action: "timer", delay: 60_000, releaseAccounting: true });
		assert.deepEqual(waitHold(waiting(), NOW), { action: "timer", delay: 60_000, releaseAccounting: true });
	});

	it("proceeds once a check is due", () => {
		assert.deepEqual(waitHold(waiting({ intervalMs: 1000, remainingChecks: 2, nextCheckAt: NOW }), NOW), { action: "proceed", releaseAccounting: true });
	});
});

describe("dispatch", () => {
	it("authorizes the purpose of a ready decision and nothing for idle", () => {
		assert.equal(dispatchKind(ready("kickoff"), NOW), "kickoff");
		assert.equal(dispatchKind(newGoalScheduler("o"), NOW), undefined);
	});

	it("wakes on a signalled wait", () => {
		assert.equal(dispatchKind(waiting({ signalled: true }), NOW), "wake");
	});

	it("spends a check only when one is due and left", () => {
		const due = waiting({ intervalMs: 1000, remainingChecks: 2, nextCheckAt: NOW });
		assert.equal(dispatchKind(due, NOW), "check");
		assert.equal(due.wait!.remainingChecks, 1);
		const early = waiting({ intervalMs: 1000, remainingChecks: 2, nextCheckAt: NOW + 1 });
		assert.equal(dispatchKind(early, NOW), undefined);
		assert.equal(early.wait!.remainingChecks, 2);
		const spent = waiting({ intervalMs: 1000, remainingChecks: 0, nextCheckAt: NOW });
		assert.equal(dispatchKind(spent, NOW), undefined);
	});

	it("claims one run and returns the ids the checkpoint carries", () => {
		const s = ready("kickoff");
		const ids = claimDispatch(s, "kickoff", NOW);
		assert.equal(s.used, 1);
		assert.equal(s.phase, "claimed");
		assert.deepEqual(s.dispatch, { id: ids.dispatchId, kind: "kickoff", claimedAt: NOW });
		assert.equal(ids.generation, s.generation);
	});

	it("tracks repair use: set by repair, kept by recovery, cleared by anything else", () => {
		const repair = ready("repair");
		claimDispatch(repair, "repair", NOW);
		assert.equal(repair.repairUsed, true);
		const recovery = { ...ready("recovery"), repairUsed: true };
		claimDispatch(recovery, "recovery", NOW);
		assert.equal(recovery.repairUsed, true);
		const plain = { ...ready(), repairUsed: true };
		claimDispatch(plain, "ready", NOW);
		assert.equal(plain.repairUsed, false);
	});

	it("rotates a wait's token and clears its signal when claimed", () => {
		const s = waiting({ signalled: true });
		const token = s.wait!.token;
		claimDispatch(s, "wake", NOW);
		assert.notEqual(s.wait!.token, token);
		assert.equal(s.wait!.signalled, false);
	});
});

describe("wake timer", () => {
	it("fires once, and a later arm replaces an earlier one", async () => {
		const timer = new WakeTimer();
		const fired: string[] = [];
		timer.arm(5, () => fired.push("first"));
		timer.arm(5, () => fired.push("second"));
		await new Promise(resolve => setTimeout(resolve, 30));
		assert.deepEqual(fired, ["second"]);
	});

	it("does not fire after cancel", async () => {
		const timer = new WakeTimer();
		let fired = false;
		timer.arm(5, () => { fired = true; });
		timer.cancel();
		await new Promise(resolve => setTimeout(resolve, 30));
		assert.equal(fired, false);
	});
});
