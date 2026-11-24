/**
 * B6 — Regression gate.
 *
 * Diffs baseline-before.json vs baseline-after.json for a campaign and
 * enforces the campaign's contract:
 *
 *   - Every numeric row must not regress beyond
 *     max(before.p50 * 1.5, before.p50 + 10)ms (no-regression rule for all
 *     rows, including the noise-floor and durable-write-floor exempt rows).
 *   - Campaign "naf" additionally enforces the ≥10x headroom invariant from
 *     classify.mjs: every HEADROOM row in the before baseline must meet its
 *     10x target in the after run on its primary metric (p50 ms, fs ops, or
 *     estimated tokens). Exempt rows are no-regression-only by design.
 *   - Campaign "extension-review-plan" keeps the original claim-specific
 *     invariants (B3 flatness, B2 ops drop, B4 tokens drop, B5 lock
 *     collapse) unchanged.
 *
 * Exit code 1 on failure; prints a summary.
 *
 * Usage: node --experimental-strip-types experiments/bench/b6-gate.mjs [campaign]
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { campaignConfig } from "./campaigns.mjs";
import { classifyRows } from "./classify.mjs";

const benchDir = fileURLToPath(new URL(".", import.meta.url));
const campaign = process.argv[2] ?? "extension-review-plan";
const cfg = campaignConfig(campaign);
// CI measures the current base on the same machine; historical 10x campaign
// targets still apply when no reference is supplied.
const reference = process.env.PI_GOAL_BENCH_REFERENCE;
const before = JSON.parse(readFileSync(reference ?? path.join(benchDir, `${cfg.jsonPrefix}before.json`), "utf8"));
const afterPath = path.join(benchDir, `${cfg.jsonPrefix}after.json`);
let after = null;
try {
	after = JSON.parse(readFileSync(afterPath, "utf8"));
} catch {
	console.error("[B6] baseline-after.json missing — nothing to gate yet. Run run-bench.mjs after first.");
	process.exit(1);
}

const byId = (rows) => new Map(rows.map((r) => [r.id, r]));
// Rows whose code was deliberately deleted. A reference run from an older base
// still produces them, so their absence afterwards is expected, not a regression.
const RETIRED_ROWS = new Set([
	"B7.render.taskOverlay", // widgets/task-list-overlay.ts removed in the 2026-11-24 cleanup
	"B7.policy.validateTasks", // validateTaskListProposal had no production caller; removed in the same cleanup
]);
const beforeMap = byId(before.rows.filter((r) => !RETIRED_ROWS.has(r.id)));
const afterMap = byId(after.rows);

const failures = [];
const regressions = [];

// 1. No-regression rule: every numeric p50 row (headroom AND exempt).
for (const [id, bRow] of beforeMap) {
	const aRow = afterMap.get(id);
	if (!aRow) {
		failures.push(`${id}: missing in after run`);
		continue;
	}
	if (typeof bRow.p50 !== "number" || typeof aRow.p50 !== "number") continue; // non-timing rows (B4 tokens) handled by their metric below
	const limit = Math.max(bRow.p50 * 1.5, bRow.p50 + 10);
	if (aRow.p50 > limit) {
		regressions.push({ id, before: bRow.p50, after: aRow.p50, limit: Math.round(limit * 10) / 10 });
	}
}

// 2. Claim-specific invariants (extension-review-plan campaign, unchanged).
if (campaign === "extension-review-plan") {
	const p = (id) => afterMap.get(id)?.p50;
	if (typeof p("B3.parse.1000") === "number" && typeof p("B3.parse.10000") === "number") {
		const ratio = p("B3.parse.10000") / p("B3.parse.1000");
		if (ratio >= 2) failures.push(`B3 ledger parse not flat after P1-2: 10k/1k ratio ${ratio.toFixed(2)} (must be < 2)`);
	}
	const b2beforeOps = beforeMap.get("B2.readturn.1g")?.ops;
	const b2afterOps = afterMap.get("B2.readturn.1g")?.ops;
	if (typeof b2beforeOps === "number" && typeof b2afterOps === "number" && b2afterOps >= b2beforeOps) {
		failures.push(`B2 read-turn fs ops not reduced after P1-1: ${b2beforeOps} -> ${b2afterOps}`);
	}
	const b4before = beforeMap.get("B4.taskListBlock.50t")?.ops;
	const b4after = afterMap.get("B4.taskListBlock.50t")?.ops;
	if (typeof b4before === "number" && typeof b4after === "number" && b4after >= b4before) {
		failures.push(`B4 taskListBlock tokens not reduced after P1-4: ${b4before} -> ${b4after}`);
	}
	const lockBefore = beforeMap.get("B5.lock.contended")?.p50;
	const lockAfter = afterMap.get("B5.lock.contended")?.p50;
	if (typeof lockBefore === "number" && typeof lockAfter === "number" && lockAfter > Math.max(200, lockBefore)) {
		failures.push(`B5 lock contended wait not collapsed after P1-5: ${lockBefore}ms -> ${lockAfter}ms`);
	}
}

// 3.5 B10 checkpoint-growth invariants (issue #30, enforced whenever the
// after run contains B10 rows — i.e. once PR A's benchmark is in place).
if (afterMap.has("B10.checkpoint.persisted.1000")) {
	const b10 = (id) => afterMap.get(id)?.ops;
	if (typeof b10("B10.checkpoint.persisted.1000") === "number" && b10("B10.checkpoint.persisted.1000") > 160_000) {
		failures.push(`B10 persisted checkpoint chars at 1000 turns ${b10("B10.checkpoint.persisted.1000")} > 160000`);
	}
	const providerVisible = b10("B10.checkpoint.provider-context.1000");
	if (typeof providerVisible === "number" && providerVisible > 1) {
		failures.push(`B10 provider-visible checkpoints ${providerVisible} > 1`);
	}
	const composed = b10("B10.checkpoint.composed-request.50t");
	if (typeof composed === "number" && composed !== 1) {
		failures.push(`B10 composed full goal blocks ${composed} != 1`);
	}
}

// 4. naf campaign: the ≥10x headroom invariant (per classify.mjs) and an
// ops/token no-regression watch for exempt rows (their metric is still
// monitored even though they carry no 10x target).
const headroomMisses = [];
const opsRegressions = [];
if (campaign === "naf") {
	for (const row of classifyRows(before)) {
		if (RETIRED_ROWS.has(row.id)) continue;
		const aRow = afterMap.get(row.id);
		if (!aRow) {
			failures.push(`${row.id}: missing in after run`);
			continue;
		}
		if (!reference && row.cls === "headroom" && row.target) {
			const { metric, limit } = row.target;
			const beforeValue = metric === "p50 ms" ? row.p50 : row.ops;
			const afterValue = metric === "p50 ms" ? aRow.p50 : aRow.ops;
			const met = metric === "p50 ms"
				? typeof aRow.p50 === "number" && aRow.p50 <= limit
				: typeof aRow.ops === "number" && aRow.ops <= limit;
			if (!met) {
				headroomMisses.push({ id: row.id, metric, before: beforeValue, after: afterValue, limit });
			}
		}
		if (typeof row.ops === "number" && typeof aRow.ops === "number") {
			const limit = Math.max(Math.ceil(row.ops * 1.5), row.ops + 10);
			if (aRow.ops > limit) {
				opsRegressions.push({ id: row.id, before: row.ops, after: aRow.ops, limit });
			}
		}
	}
}

console.log(`[B6] campaign=${campaign}: gating ${after.rows.length} after rows against ${before.rows.length} before rows${reference ? " (same-runner reference; regression checks)" : ""}`);
if (regressions.length > 0) {
	console.log("\nRegressions (after p50 > max(before*1.5, before+10)ms):");
	for (const r of regressions) console.log(`  FAIL ${r.id}: ${r.before}ms -> ${r.after}ms (limit ${r.limit}ms)`);
	failures.push(...regressions.map((r) => `${r.id} regression ${r.before} -> ${r.after}`));
}
if (headroomMisses.length > 0) {
	console.log(`\nHeadroom misses (10x target not met, campaign ${campaign}):`);
	for (const r of headroomMisses) {
		console.log(`  FAIL ${r.id}: ${r.metric} ${r.before} -> ${r.after} (target ${r.metric === "p50 ms" ? `${r.limit}ms` : `≤${r.limit}`})`);
	}
	failures.push(...headroomMisses.map((r) => `${r.id} 10x target not met (${r.before} -> ${r.after}, target ${r.limit})`));
}
if (opsRegressions.length > 0) {
	console.log(`\nOps/token regressions (exempt-row metric watch, campaign ${campaign}):`);
	for (const r of opsRegressions) console.log(`  FAIL ${r.id}: ${r.before} -> ${r.after} (limit ${r.limit})`);
	failures.push(...opsRegressions.map((r) => `${r.id} ops regression ${r.before} -> ${r.after}`));
}
if (failures.length === 0) {
	console.log("[B6] PASS: no regressions, all claim-specific invariants hold.");
	process.exit(0);
}
console.log("\n[B6] FAIL:");
for (const f of failures) console.log(`  - ${f}`);
process.exit(1);
