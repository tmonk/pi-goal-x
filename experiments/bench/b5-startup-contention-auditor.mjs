/**
 * B5 — Startup, contention, and auditor timing.
 *  - startup: createGoalCore + loadState over 1/10/50 open goal files (P1-7).
 *  - contention: two-process lock acquire wait (P1-5) — child holds the lock
 *    3s, parent measures how long acquireGoalLock blocks.
 *  - auditor: completion dispatch to the pre-audit gate with an injected
 *    auditor stub (no live agent); cold (first) vs warm (subsequent) calls.
 */

import { performance } from "node:perf_hooks";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	makeFixtureCwd,
	makeGoalFiles,
	Baseline,
	measure,
	createHarness,
	startHarness,
	focusedFixture,
	cleanupFixture,
	beginFsCount,
	endFsCount,
} from "./bench-common.mjs";
import { allowChildProcess, withLatency } from "./guard-state.mjs";
import { spawnContention } from "./node-child-process.mjs";
import { acquireGoalLock } from "../../extensions/storage/goal-lock.ts";
import { createGoalCore } from "../../extensions/goal-state.ts";
import { sleepMs } from "./guard-state.mjs";

function makePi() {
	const handlers = new Map();
	return {
		registerTool: () => {},
		registerCommand: () => {},
		on: (event, handler) => handlers.set(event, handler),
		appendEntry: () => {},
		registerMessageRenderer: () => {},
		sendMessage: () => {},
		getActiveTools: () => ["read", "bash", "edit", "write"],
		setActiveTools: () => {},
		hasUI: false,
	};
}

function makeCtx(cwd) {
	return {
		cwd,
		hasUI: false,
		sessionManager: { getBranch: () => [], getCwd: () => cwd, getSessionId: () => "b5", getRoot: () => cwd },
		ui: { notify: () => {}, setStatus: () => {}, setWidget: () => {}, onTerminalInput: () => () => {}, select: async () => undefined, confirm: async () => true, custom: async () => undefined },
		getSystemPrompt: () => "", isIdle: () => true, hasPendingMessages: () => false, abort: () => {},
	};
}

export async function run(baseline) {
	// ── startup: loadState at 1 / 10 / 50 goals ─────────────────────────
	for (const [count, label] of [[1, "1 goal"], [10, "10 goals"], [50, "50 goals"]]) {
		const cwd = makeFixtureCwd("b5-start-");
		try {
			makeGoalFiles(cwd, count);
			const core = createGoalCore(makePi(), {});
			const ctx = makeCtx(cwd);
			const samples = [];
			const opSamples = [];
			for (let i = 0; i < 6; i++) {
				beginFsCount();
				const t0 = performance.now();
				await core.focus.load(ctx);
				samples.push(performance.now() - t0);
				opSamples.push(endFsCount());
			}
			samples.sort((a, b) => a - b);
			opSamples.sort((a, b) => a - b);
			const p50 = Math.round(samples[3] * 10) / 10;
			const p95 = Math.round(samples[5] * 10) / 10;
			// Slow-storage variant (25ms/op latency injection, P1-7 claim).
			const latSamples = [];
			const latOps = [];
			for (let i = 0; i < 3; i++) {
				beginFsCount();
				const t0 = performance.now();
				await withLatency(25, () => core.focus.load(ctx));
				latSamples.push(performance.now() - t0);
				latOps.push(endFsCount());
			}
			latSamples.sort((a, b) => a - b);
			latOps.sort((a, b) => a - b);
			const latP50 = Math.round(latSamples[1] * 10) / 10;
			baseline.add({
				id: `B5.startup.${count}g`, label: `session startup loadState (${label}, parallel reads)`, ops: opSamples[0],
				modules: "goal-state + storage/goal-files + goal-settings", fixture: `${count} open goals`, n: 6,
				p50, p95, max: p95, notes: `mean ${Math.round(samples.reduce((a, b) => a + b, 0) / 6 * 10) / 10}ms; P1-7 parallel + cached`,
			});
			baseline.add({
				id: `B5.startup.${count}g.lat25`, label: `session startup loadState (${label}, +25ms/op)`, ops: latOps[0],
				modules: "goal-state + storage/goal-files + goal-settings", fixture: `${count} open goals`, n: 3,
				p50: latP50, p95: latP50, max: latP50, latency: "25ms/op",
				notes: `P1-7 parallel reads amortise the per-op latency`,
			});
		} finally {
			cleanupFixture(cwd);
		}
	}

	// ── contention: two-process lock wait (child holds 3s) ──────────────
	{
		const cwd = makeFixtureCwd("b5-lock-");
		try {
			const goalId = "contended-goal";
			const childPath = path.join(fileURLToPath(new URL(".", import.meta.url)), "bench-child-hold-lock.mjs");
			const child = await allowChildProcess(() => spawnContention(process.execPath, [
				"--import", path.join(fileURLToPath(new URL(".", import.meta.url)), "bench-adapter-hooks.mjs"),
				"--experimental-strip-types",
				childPath, cwd, goalId, "3000",
			], { stdio: "ignore" }));
			// Give the child a moment to acquire first.
			sleepMs(300);
			const t0 = performance.now();
			let waitMs;
			let outcome;
			try {
				const lock = acquireGoalLock({ cwd }, goalId); // DEFAULT bounds (P1-5)
				waitMs = Math.round((performance.now() - t0) * 10) / 10;
				lock.release();
				outcome = "acquired";
			} catch (err) {
				waitMs = Math.round((performance.now() - t0) * 10) / 10;
				outcome = "fail-fast";
			}
			await new Promise((resolve) => child.on("exit", resolve));
			baseline.add({
				id: "B5.lock.contended", label: "lock acquire under two-process contention (child holds 3s, DEFAULT bounds)",
				modules: "storage/goal-lock", fixture: "2 processes, 1 goal lock", n: 1,
				p50: waitMs, p95: waitMs, max: waitMs, notes: `${outcome} in ${waitMs}ms; P1-5 bounded window ≈200ms (was ~2.8s frozen)`,
			});
		} finally {
			cleanupFixture(cwd);
		}
	}

	// ── auditor: completion dispatch with stubbed auditor ───────────────
	{
		const times = [];
		const ops = [];
		for (let i = 0; i < 5; i++) {
			const f = focusedFixture();
			try {
				const h = createHarness({ cwd: f.cwd, sessionEntries: f.sessionEntries, runCompletionAuditor: async () =>
					({ approved: true, disapproved: false, output: "All good\n<approved/>", model: "fixture" }) });
				await startHarness(h);
				const update = h.tools.get("update_goal");
				const t0 = performance.now();
				await update.execute("c-1", { status: "complete" }, new AbortController().signal, undefined, h.ctx);
				times.push(performance.now() - t0);
			} finally {
				f.cleanup();
			}
		}
		times.sort((a, b) => a - b);
		baseline.add({
			id: "B5.auditor.dispatch", label: "update_goal(complete) dispatch to pre-audit gate (auditor stubbed)",
			modules: "goal-core-tools + goal-completion + goal-state + goal-service + goal-ledger",
			fixture: "1 active goal each, 5 fixtures", n: 5,
			p50: Math.round(times[2] * 10) / 10, p95: Math.round(times[4] * 10) / 10, max: Math.round(times[4] * 10) / 10,
			notes: `cold=${Math.round(times[0] * 10) / 10}ms warm=${Math.round(times[times.length - 1] * 10) / 10}ms; P1-6 seeds the auditor session warm`,
		});
	}
	return baseline;
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const baseline = new Baseline();
	await run(baseline);
	process.stdout.write(baseline.markdown());
}
