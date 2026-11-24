/**
 * Prints the filesystem operations behind one tool call, to see where the
 * time goes on slow storage.
 *
 *   node --import ./experiments/bench/bench-adapter-hooks.mjs --experimental-strip-types experiments/bench/trace-ops.mjs
 */
import { beginFsCount, endFsCount, createHarness, startHarness, focusedFixture, cleanupFixture } from "./bench-common.mjs";
import { state } from "./guard-state.mjs";

process.env.PI_GOAL_BENCH_TRACE = "1";
const tasks = n => Array.from({ length: n }, (_, i) => ({ id: `t${i}`, title: `Task ${i} with a descriptive title` }));

async function trace(name, tool, params, prepare) {
	const f = focusedFixture();
	try {
		const h = createHarness({ cwd: f.cwd, sessionEntries: f.sessionEntries, runCompletionAuditor: async () => ({ approved: true, disapproved: false, output: "ok\n<approved/>", model: "fixture" }) });
		await startHarness(h);
		if (prepare) await prepare(h);
		beginFsCount();
		await h.tools.get(tool).execute("x", params, new AbortController().signal, undefined, h.ctx);
		const ops = state.trace;
		console.log(`\n${name}: ${endFsCount()} ops`);
		for (const op of ops ?? []) console.log("  ", op);
	} finally {
		cleanupFixture(f.cwd);
	}
}

await trace("create_goal", "create_goal", { objective: "Create a benchmark goal with a concrete objective." });
await trace("update_goal_task", "update_goal_task", { task_id: "t1", status: "complete", evidence: "ok" },
	h => h.tools.get("set_goal_tasks").execute("s", { tasks: tasks(20), block_completion: false }, new AbortController().signal, undefined, h.ctx));
await trace("update_goal paused", "update_goal", { status: "paused", reason: "pause" });
