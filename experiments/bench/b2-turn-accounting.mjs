/**
 * B2 — Real-session per-turn I/O accounting (synthetic turn over real
 * functions). A read turn performs the same sync reads the pipeline performs
 * (settings + pool + focused-goal parse + ledger + prompt build); a mutation
 * turn performs one real task mutation through the tool surface. Reports fs
 * op counts and wall ms per turn — the top-line user-felt number.
 */

import { performance } from "node:perf_hooks";
import {
	makeFixtureCwd,
	makeGoalFiles,
	makeLedger,
	Baseline,
	beginFsCount,
	endFsCount,
	createHarness,
	startHarness,
	focusedFixture,
	cleanupFixture,
} from "./bench-common.mjs";
import { loadGoalSettings } from "../../extensions/settings/resolve.ts";
import { readActiveGoalPool } from "../../extensions/storage/goal-files.ts";
import { readGoalLedger } from "../../extensions/goal-ledger.ts";
import { checkpointTriggerPrompt } from "../../extensions/prompts/goal-prompts.ts";

function readTurn(cwd, goals, goal) {
	beginFsCount();
	const t0 = performance.now();
	const settings = loadGoalSettings(cwd);
	const pool = readActiveGoalPool({ cwd });
	const ledger = readGoalLedger({ cwd });
	const focused = pool.get(goal.id) ?? goal;
	checkpointTriggerPrompt(focused.id);
	const ms = performance.now() - t0;
	const ops = endFsCount();
	return { ms, ops };
}

export async function run(baseline) {
	// ── read turns at 1 and 10 open goals, ledger 1k ────────────────────
	for (const [goalCount, label] of [[1, "1 goal"], [10, "10 goals"]]) {
		const cwd = makeFixtureCwd("b2-");
		try {
			const goals = makeGoalFiles(cwd, goalCount);
			makeLedger(cwd, 1000);
			const samples = [];
			const opSamples = [];
			for (let i = 0; i < 20; i++) {
				const { ms, ops } = readTurn(cwd, goalCount, goals[0]);
				samples.push(ms);
				opSamples.push(ops);
			}
			samples.sort((a, b) => a - b);
			opSamples.sort((a, b) => a - b);
			const p50 = Math.round(samples[Math.floor(samples.length / 2)] * 10) / 10;
			const p95 = Math.round(samples[Math.min(samples.length - 1, Math.ceil(0.95 * samples.length))] * 10) / 10;
			baseline.add({
				id: `B2.readturn.${goalCount}g`, label: `per-turn read pipeline (${label}, 1k ledger)`,
				modules: "goal-settings + storage/goal-files + goal-ledger + prompts/goal-prompts",
				fixture: `${goalCount} goals, 1000 events`, n: 20, p50, p95, max: Math.round(samples[samples.length - 1] * 10) / 10,
				ops: opSamples[0], notes: `fs ops/turn ${opSamples[0]} (p50), mean ${Math.round(samples.reduce((a, b) => a + b, 0) / samples.length * 10) / 10}ms`,
			});
		} finally {
			cleanupFixture(cwd);
		}
	}

	// ── mutation turn: one update_goal_task through the real tool ───────
	{
		const f = focusedFixture();
		try {
			const h = createHarness({ cwd: f.cwd, sessionEntries: f.sessionEntries });
			await startHarness(h);
			// give the goal a task list first
			const setTasks = h.tools.get("set_goal_tasks");
			await setTasks.execute("st-1", { tasks: [{ id: "t1", title: "Do the thing" }], block_completion: false }, new AbortController().signal, undefined, h.ctx);
			beginFsCount();
			const t0 = performance.now();
			const update = h.tools.get("update_goal_task");
			await update.execute("ut-1", { task_id: "t1", status: "complete", evidence: "benchmark evidence" }, new AbortController().signal, undefined, h.ctx);
			const ms = performance.now() - t0;
			const ops = endFsCount();
			baseline.add({
				id: "B2.mutationturn.task", label: "per-turn mutation (one update_goal_task)",
				modules: "goal-task-tools + goal-service + storage/goal-files + goal-ledger + storage/goal-lock",
				fixture: "1 goal, 1 task", n: 1, p50: Math.round(ms * 10) / 10, p95: Math.round(ms * 10) / 10, max: Math.round(ms * 10) / 10,
				ops, notes: `fs ops for one task mutation: ${ops} (P1-3 batches to one lock+write+append)`,
			});
		} finally {
			f.cleanup();
		}
	}
	return baseline;
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const baseline = new Baseline();
	await run(baseline);
	process.stdout.write(baseline.markdown());
}
