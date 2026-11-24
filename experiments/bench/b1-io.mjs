/**
 * B1 — I/O hot-path micro-bench harness with slow-storage emulation.
 * Paths: settings load, pool scan, ledger parse, lock acquire, ledger append.
 * Every case runs at latency 0 (local SSD) and under 25ms/op injected latency
 * (NFS/iCloud-style round trips) via the node:fs wrapper.
 */

import {
	makeFixtureCwd,
	makeGoalFiles,
	makeLedger,
	measure,
	Baseline,
	withLatency,
	setLatency,
	beginFsCount,
	endFsCount,
	cleanupFixture,
} from "./bench-common.mjs";
import { loadGoalSettings } from "../../extensions/settings/resolve.ts";
import { readActiveGoalPool } from "../../extensions/storage/goal-files.ts";
import { readGoalLedger, appendGoalEvent, appendGoalEvents } from "../../extensions/goal-ledger.ts";
import { acquireGoalLock } from "../../extensions/storage/goal-lock.ts";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";

/** measure() plus the per-call fs op count (min over samples — steady-state). */
function measureOps(fn, opts) {
	const ops = [];
	const wrapped = () => {
		beginFsCount();
		const out = fn();
		ops.push(endFsCount());
		return out;
	};
	const r = measure(wrapped, opts);
	ops.sort((a, b) => a - b);
	return { ...r, ops: ops[0] };
}

export function run(baseline) {
	const cwd = makeFixtureCwd("b1-");
	try {
		// settings file present
		mkdirSync(path.join(cwd, ".pi"), { recursive: true });
		writeFileSync(path.join(cwd, ".pi", "pi-goal-x-settings.json"), JSON.stringify({ subtaskDepth: 2, provider: "anthropic", model: "m", thinking_level: "medium" }));

		// ── settings load ────────────────────────────────────────────────
		let r = measureOps(() => loadGoalSettings(cwd), { n: 200 });
		baseline.add({ id: "B1.settings.present", label: "settings load (file present)", modules: "goal-settings", fixture: "1 settings file", n: r.n, p50: r.p50, p95: r.p95, max: r.max, ops: r.ops, notes: `mean ${r.mean}ms` });
		r = measureOps(() => withLatency(25, () => loadGoalSettings(cwd)), { n: 100 });
		baseline.add({ id: "B1.settings.present.lat25", label: "settings load (file present, +25ms/op)", modules: "goal-settings", fixture: "1 settings file", n: r.n, p50: r.p50, p95: r.p95, max: r.max, ops: r.ops, latency: "25ms/op", notes: `mean ${r.mean}ms` });

		const emptyCwd = makeFixtureCwd("b1-empty-");
		r = measureOps(() => loadGoalSettings(emptyCwd), { n: 200 });
		baseline.add({ id: "B1.settings.missing", label: "settings load (file missing)", modules: "goal-settings", fixture: "no file", n: r.n, p50: r.p50, p95: r.p95, max: r.max, ops: r.ops, notes: `mean ${r.mean}ms` });
		cleanupFixture(emptyCwd);

		// ── pool scan at 1 / 10 / 50 goals ───────────────────────────────
		for (const [count, label] of [[1, "1 goal"], [10, "10 goals"], [50, "50 goals"]]) {
			const scanCwd = makeFixtureCwd("b1-pool-");
			makeGoalFiles(scanCwd, count);
			r = measureOps(() => readActiveGoalPool({ cwd: scanCwd }), { n: 30 });
			baseline.add({ id: `B1.pool.${count}g`, label: `pool scan (${label})`, modules: "storage/goal-files", fixture: `${count} active goal files`, n: r.n, p50: r.p50, p95: r.p95, max: r.max, ops: r.ops, notes: `mean ${r.mean}ms` });
			r = measureOps(() => withLatency(25, () => readActiveGoalPool({ cwd: scanCwd })), { n: 10 });
			baseline.add({ id: `B1.pool.${count}g.lat25`, label: `pool scan (${label}, +25ms/op)`, modules: "storage/goal-files", fixture: `${count} active goal files`, n: r.n, p50: r.p50, p95: r.p95, max: r.max, ops: r.ops, latency: "25ms/op", notes: `mean ${r.mean}ms` });
			cleanupFixture(scanCwd);
		}

		// ── ledger parse (1k events) ─────────────────────────────────────
		const ledgerCwd = makeFixtureCwd("b1-ledger-");
		makeLedger(ledgerCwd, 1000);
		r = measureOps(() => readGoalLedger({ cwd: ledgerCwd }), { n: 20 });
		baseline.add({ id: "B1.ledger.1k", label: "ledger full parse (1k events)", modules: "goal-ledger", fixture: "1000 ledger events", n: r.n, p50: r.p50, p95: r.p95, max: r.max, ops: r.ops, notes: `mean ${r.mean}ms` });
		r = measureOps(() => withLatency(25, () => readGoalLedger({ cwd: ledgerCwd })), { n: 5 });
		baseline.add({ id: "B1.ledger.1k.lat25", label: "ledger full parse (1k, +25ms/op)", modules: "goal-ledger", fixture: "1000 ledger events", n: r.n, p50: r.p50, p95: r.p95, max: r.max, ops: r.ops, latency: "25ms/op", notes: `mean ${r.mean}ms` });

		// ── lock acquire (uncontended) ───────────────────────────────────
		r = measureOps(() => {
			const lock = acquireGoalLock({ cwd: ledgerCwd }, "uncontended-goal");
			lock.release();
		}, { n: 50 });
		baseline.add({ id: "B1.lock.uncontended", label: "lock acquire+release (uncontended)", modules: "storage/goal-lock", fixture: "fresh lock dir", n: r.n, p50: r.p50, p95: r.p95, max: r.max, ops: r.ops, notes: `mean ${r.mean}ms` });

		// ── ledger append: single, and batched x4 (the service's real flow) ──
		const event = { type: "goal_focused", goalId: "g", reason: "created", at: new Date().toISOString() };
		r = measureOps(() => appendGoalEvent({ cwd: ledgerCwd }, event), { n: 50 });
		baseline.add({ id: "B1.append.single", label: "ledger append (single event)", modules: "goal-ledger", fixture: "1k-event ledger file", n: r.n, p50: r.p50, p95: r.p95, max: r.max, ops: r.ops, notes: `mean ${r.mean}ms` });
		r = measureOps(() => appendGoalEvents({ cwd: ledgerCwd }, [event, event, event, event]), { n: 20 });
		baseline.add({ id: "B1.append.x4", label: "ledger append x4 (batched, one write)", modules: "goal-ledger", fixture: "1k-event ledger file", n: r.n, p50: r.p50, p95: r.p95, max: r.max, ops: r.ops, notes: `mean ${r.mean}ms; one appendFileSync for 4 events (was 4×5 ops)` });

		cleanupFixture(ledgerCwd);
	} finally {
		setLatency(0);
		cleanupFixture(cwd);
	}
	return baseline;
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const baseline = new Baseline();
	run(baseline);
	process.stdout.write(baseline.markdown());
}
