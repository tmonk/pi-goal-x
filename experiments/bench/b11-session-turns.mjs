/**
 * B11: a whole goal session through the real hooks.
 *
 * Each turn runs what Pi runs: before_agent_start, turn_start, a tool loop
 * (context_with_system, tool_call, tool_execution_end), turn_end and agent_end.
 * The history grows every turn, so a hook that gets slower as the session
 * grows shows up. Every few turns the agent also completes a task.
 *
 * Rows: milliseconds per turn at the start and at the end of the session, the
 * slowest hook, and filesystem operations per turn.
 */
import { makeFixtureCwd, focusedFixture, createHarness, startHarness, beginFsCount, endFsCount, cleanupFixture } from "./bench-common.mjs";

const ABORT = () => new AbortController().signal;
const TURNS = 240;
const LOOP_REQUESTS = 3;

const user = (n) => ({ role: "user", content: [{ type: "text", text: `user message ${n}: please keep going and report the result` }], timestamp: 1000 + n });
const assistant = (n) => ({ role: "assistant", content: [{ type: "text", text: `assistant reply ${n}: ${"working through the next step ".repeat(20)}` }], usage: { input: 1200, output: 300, cacheRead: 900, cacheWrite: 0, totalTokens: 1500 }, stopReason: "stop", timestamp: 2000 + n });
const toolResult = (n) => ({ role: "toolResult", toolCallId: `c${n}`, toolName: "read", content: [{ type: "text", text: "file contents ".repeat(200) }], isError: false, timestamp: 3000 + n });

export async function run(baseline) {
	const f = focusedFixture();
	try {
		const h = createHarness({ cwd: f.cwd, sessionEntries: f.sessionEntries });
		await startHarness(h);
		const tasks = Array.from({ length: 20 }, (_, i) => ({ id: `t${i}`, title: `Task ${i} with a descriptive title` }));
		await h.tools.get("set_goal_tasks").execute("s", { tasks, block_completion: false }, ABORT(), undefined, h.ctx);

		const emit = async (name, event) => {
			const t0 = performance.now();
			const out = await h.handlers.get(name)?.(event, h.ctx);
			const ms = performance.now() - t0;
			perHook.set(name, (perHook.get(name) ?? 0) + ms);
			return out;
		};
		const perHook = new Map();
		const history = [];
		const turnMs = [];
		const turnOps = [];
		for (let n = 0; n < TURNS; n++) {
			perHook.clear();
			beginFsCount();
			const t0 = performance.now();
			history.push(user(n));
			await emit("before_agent_start", { systemPrompt: "base", prompt: `go ${n}`, systemPromptOptions: {} });
			await emit("agent_start", {});
			await emit("turn_start", {});
			for (let r = 0; r < LOOP_REQUESTS; r++) {
				await emit("context_with_system", { messages: history.slice(), systemPrompt: "base" });
				await emit("tool_call", { toolName: "read", input: { path: "a.ts" }, toolCallId: `c${n}-${r}` });
				await emit("tool_execution_end", { toolName: "read", toolCallId: `c${n}-${r}` });
				history.push(assistant(n * 10 + r), toolResult(n * 10 + r));
			}
			if (n % 8 === 0 && n / 8 < tasks.length) {
				await h.tools.get("update_goal_task").execute(`u${n}`, { task_id: `t${n / 8}`, status: "complete", evidence: "done" }, ABORT(), undefined, h.ctx);
			}
			const last = assistant(n);
			history.push(last);
			await emit("turn_end", { message: last, toolResults: [] });
			await emit("agent_end", { messages: [last] });
			turnMs.push(performance.now() - t0);
			turnOps.push(endFsCount());
		}
		const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
		const first = median(turnMs.slice(0, 20));
		const lastMed = median(turnMs.slice(-20));
		const r1 = (x) => Math.round(x * 100) / 100;
		const bytes = JSON.stringify(history).length;
		baseline.add({ id: "B11.session.turn.early", label: "goal turn, first 20 turns", modules: "all hooks", fixture: `${LOOP_REQUESTS} requests per turn`, n: 20, p50: r1(first), p95: r1(first), max: r1(Math.max(...turnMs.slice(0, 20))), ops: median(turnOps.slice(0, 20)), notes: `fs ops/turn ${median(turnOps.slice(0, 20))}` });
		baseline.add({ id: "B11.session.turn.late", label: `goal turn, last 20 of ${TURNS} turns`, modules: "all hooks", fixture: `${history.length} messages, ${Math.round(bytes / 1024)} KiB history`, n: 20, p50: r1(lastMed), p95: r1(lastMed), max: r1(Math.max(...turnMs.slice(-20))), ops: median(turnOps.slice(-20)), notes: `fs ops/turn ${median(turnOps.slice(-20))}; growth x${r1(lastMed / Math.max(first, 0.01))}` });
		const slow = [...perHook].sort((a, b) => b[1] - a[1])[0];
		baseline.add({ id: "B11.session.hook.slowest", label: `slowest hook in the last turn (${slow[0]})`, modules: "goal-events", fixture: `${history.length} messages`, n: 1, p50: r1(slow[1]), p95: r1(slow[1]), max: r1(slow[1]), ops: null, notes: [...perHook].map(([k, v]) => `${k} ${r1(v)}`).join("; ") });
	} finally {
		cleanupFixture(f.cwd);
	}
}

if (process.argv[1]?.endsWith("b11-session-turns.mjs")) {
	const { Baseline } = await import("./bench-common.mjs");
	const b = new Baseline();
	await run(b);
	for (const r of b.rows) console.log(r.id, r.p50, "ms", r.notes);
}
