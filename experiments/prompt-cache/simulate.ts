/**
 * Prompt-cache simulation for the goal request tails.
 *
 * Replays a realistic goal session through the real prompt builders and a
 * retention strategy, then measures how much of each request is a literal
 * prefix of the one before it (what an implicit prefix cache can reuse).
 * It checks request construction only. It makes no claim about live provider
 * hit rates, TTLs or routing.
 *
 *   node --experimental-strip-types experiments/prompt-cache/simulate.ts [--json]
 */
import { LiveTailRetention } from "../../extensions/goal-live-retention.ts";
import { goalPromptParts, taskListBlock, untrustedObjectiveBlock } from "../../extensions/prompts/goal-prompts.ts";
import type { GoalRecord } from "../../extensions/goal-record.ts";

type Msg = { role: string; content: string; timestamp: number };

/** What the context hook knows for one request, split by how often it changes. */
export interface SimParts {
	/** Rules, objective, contract, mode. Changes only when the goal itself changes. */
	policy: string;
	/** Notes cleared by omission: scheduling waits, stall notes, auditor rejections. */
	steering: string;
	/** Task list. Changes when a task is started or finished. */
	tasks: string;
	/** Usage and run counters. Change every turn. */
	usage: string;
}

export interface Strategy {
	name: string;
	build(base: readonly Msg[], parts: SimParts): Msg[];
}

const live = (content: string): Msg => ({ role: "custom", content, timestamp: 0 });
const join = (...texts: string[]): string => texts.filter(Boolean).join("\n");

/**
 * What ships: the real LiveTailRetention with the production split of
 * policy block, task list and request-only text. Run against the 0.35.0 code
 * (git worktree) the same legacy call shape gives the "before" numbers.
 */
export function productionStrategy(): Strategy {
	const retention = new LiveTailRetention();
	return {
		name: "production",
		build: (base, parts) => retention.apply("s", base, {
			state: parts.policy,
			counters: parts.tasks || undefined,
			ephemeral: join(parts.steering, parts.usage),
			scope: "goal",
		} as never).messages as Msg[],
	};
}

/** Behaviour of the code the simulator runs on, using the original {state, counters} call. */
export function currentStrategy(): Strategy {
	const retention = new LiveTailRetention();
	return {
		name: "current",
		build: (base, parts) => retention.apply("s", base, {
			state: join(parts.policy, parts.steering),
			counters: parts.tasks || parts.usage ? join(parts.tasks, parts.usage) : undefined,
		}).messages as Msg[],
	};
}

interface ProtoOptions {
	name: string;
	/** Where the task list goes: retained as an append-only snapshot, or end-of-request only. */
	tasks: "retained" | "ephemeral";
	/** Steering stays in the policy block (resets on change) or rides at the end of the request. */
	steering: "policy" | "ephemeral";
	/** A changed policy resets the prefix, or is appended and supersedes older blocks. */
	policyChange: "reset" | "append";
	maxPolicyBlocks?: number;
	maxRetainedBytes?: number;
}

const SUPERSEDE = "[This block is the current goal policy. It supersedes every earlier [PI GOAL …] block above; follow only this one.]";

/** Prototype strategies. The real module will mirror whichever one wins. */
export function protoStrategy(options: ProtoOptions): Strategy {
	const maxPolicy = options.maxPolicyBlocks ?? 8;
	const maxBytes = options.maxRetainedBytes ?? 65536;
	let tails: Array<{ anchor: number; content: string; kind: "policy" | "tasks" }> = [];
	let lastPolicy: string | undefined;
	let lastTasks: string | undefined;
	return {
		name: options.name,
		build(base, parts) {
			const policy = options.steering === "policy" ? join(parts.policy, parts.steering) : parts.policy;
			const retainedBytes = () => tails.reduce((n, tail) => n + tail.content.length, 0);
			const reset = () => { tails = []; lastPolicy = undefined; lastTasks = undefined; };
			if (lastPolicy !== undefined && lastPolicy !== policy
				&& (options.policyChange === "reset" || tails.filter(t => t.kind === "policy").length >= maxPolicy)) reset();
			if (retainedBytes() + (options.tasks === "retained" ? parts.tasks.length : 0) > maxBytes) reset();
			const messages: Msg[] = [...base];
			for (let i = tails.length - 1; i >= 0; i--) messages.splice(tails[i]!.anchor, 0, live(tails[i]!.content));
			if (lastPolicy !== policy) {
				const content = lastPolicy !== undefined && options.policyChange === "append" ? `${SUPERSEDE}\n${policy}` : policy;
				messages.push(live(content));
				tails.push({ anchor: base.length, content, kind: "policy" });
				lastPolicy = policy;
			}
			if (options.tasks === "retained" && parts.tasks && lastTasks !== parts.tasks) {
				messages.push(live(parts.tasks));
				tails.push({ anchor: base.length, content: parts.tasks, kind: "tasks" });
				lastTasks = parts.tasks;
			}
			const tail = join(options.steering === "ephemeral" ? parts.steering : "", options.tasks === "ephemeral" ? parts.tasks : "", parts.usage);
			if (tail) messages.push(live(tail));
			return messages;
		},
	};
}

// ── session generator ──────────────────────────────────────────────────────

function rng(seed: number): () => number {
	return () => {
		seed = (seed + 0x6d2b79f5) | 0;
		let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const TASK_TITLES = [
	"Read the existing settings code", "Write the failing test", "Implement the change", "Update the callers",
	"Run the full suite", "Fix lint and types", "Update the docs", "Final review of the diff",
];

function makeGoal(): GoalRecord {
	return {
		id: "goal-sim", status: "active", autoContinue: true, sisyphus: false, currentTaskId: "t0",
		objective: "Move the settings code into small modules, keep behavior identical, update the tests and docs, and make sure the full suite and type checks pass before finishing. ".repeat(3).trim(),
		verificationContract: "The full test suite passes, tsc reports no errors, and the public exports are unchanged.",
		usage: { tokensUsed: 0, activeSeconds: 0 },
		createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
		taskList: {
			blockCompletion: true, proposedAt: "2026-01-01T00:00:00.000Z",
			tasks: TASK_TITLES.map((title, i) => ({ id: `t${i}`, title, status: i === 0 ? "in_progress" : "pending" })),
		},
	} as unknown as GoalRecord;
}

export interface Scenario {
	name: string;
	turns: number;
	/** Average tool requests per turn. */
	toolRequests: number;
	/** Average tool-result size in characters. */
	toolChars: number;
	/** A task finishes every N turns. */
	taskEvery: number;
	/** Turns where the user pauses the goal; it resumes two turns later. */
	pauses: number[];
	/** Turns where the agent declares a scheduling wait (steering for two turns). */
	waits: number[];
	/** Turns where a stall note is shown. */
	stalls: number[];
}

export const SCENARIOS: Scenario[] = [
	{ name: "steady: 60 turns, no interruptions", turns: 60, toolRequests: 5, toolChars: 1200, taskEvery: 8, pauses: [], waits: [], stalls: [] },
	{ name: "typical: tasks, one pause, scheduling waits", turns: 60, toolRequests: 5, toolChars: 1200, taskEvery: 6, pauses: [30], waits: [12, 25, 41, 52], stalls: [47] },
	{ name: "interrupted: three pauses", turns: 60, toolRequests: 5, toolChars: 1200, taskEvery: 6, pauses: [15, 30, 45], waits: [20, 38], stalls: [] },
	{ name: "heavy: big tool outputs, two pauses", turns: 80, toolRequests: 6, toolChars: 6000, taskEvery: 8, pauses: [25, 55], waits: [10, 35, 60], stalls: [45] },
	{ name: "long: 150 turns", turns: 150, toolRequests: 4, toolChars: 800, taskEvery: 12, pauses: [60], waits: [20, 50, 90, 120], stalls: [100] },
];

const SYSTEM_CHARS = 32_000; // about 8k tokens of host prompt and tool schemas

export interface Result {
	requests: number;
	totalTokens: number;
	cachedTokens: number;
	/** Requests after the first whose cached prefix lost more than half the previous request. */
	bigBreaks: number;
	cacheShare: number;
	/** Cost in input-token units, with cached reads at one tenth of the price. */
	cost: number;
}

function commonPrefixChars(a: readonly string[], b: readonly string[]): number {
	let n = 0;
	for (let i = 0; i < Math.min(a.length, b.length); i++) {
		if (a[i] === b[i]) { n += a[i]!.length; continue; }
		const x = a[i]!, y = b[i]!;
		let k = 0;
		while (k < x.length && k < y.length && x[k] === y[k]) k++;
		return n + k;
	}
	return n;
}

export function run(strategy: Strategy, scenario: Scenario, seed = 7): Result {
	const random = rng(seed);
	const goal = makeGoal();
	const history: Msg[] = [{ role: "user", content: "Please carry out the goal.", timestamp: 1 }];
	let time = 2;
	let previous: string[] = [];
	let requests = 0, totalChars = 0, cachedChars = 0, bigBreaks = 0, previousLen = 0, cost = 0;
	let paused = 0, finished = 0, steeringTurns = 0, stallTurns = 0;
	const system = "S".repeat(SYSTEM_CHARS);
	const request = (parts: SimParts | null) => {
		const messages = parts ? strategy.build(history, parts) : [...history];
		const wire = [system, ...messages.map(m => JSON.stringify(m))];
		const length = wire.reduce((n, s) => n + s.length, 0);
		const common = requests === 0 ? 0 : commonPrefixChars(previous, wire);
		const cached = Math.floor(common / 4 / 128) * 128 * 4; // 128-token blocks
		requests++; totalChars += length; cachedChars += Math.min(cached, length);
		cost += (length - Math.min(cached, length)) / 4 + Math.min(cached, length) / 4 * 0.1;
		if (requests > 1 && cached < previousLen * 0.5) bigBreaks++;
		previous = wire; previousLen = length;
		return length;
	};
	for (let turn = 0; turn < scenario.turns; turn++) {
		if (scenario.pauses.includes(turn)) { paused = 2; goal.status = "paused"; }
		if (paused === 0 && goal.status === "paused") goal.status = "active";
		if (scenario.waits.includes(turn)) steeringTurns = 2;
		if (scenario.stalls.includes(turn)) stallTurns = 1;
		history.push({ role: "user", content: turn === 0 ? "Start." : "[goal checkpoint]", timestamp: time++ });
		const toolRequests = goal.status === "paused" ? 1 : Math.max(1, Math.round(scenario.toolRequests * (0.4 + random() * 1.2)));
		let lastLength = 0;
		for (let k = 0; k < toolRequests; k++) {
			const steering = join(
				steeringTurns > 0 ? "Scheduling: a wait is declared (reason: CI). Do not poll; resume when the condition is met. Use update_goal to change it." : "",
				stallTurns > 0 ? "\n\n[GOAL STALLED] No continuation or tool activity for several minutes. Decide whether to continue, pause, or report a blocker." : "",
			);
			const tasks = taskListBlock(goal);
			const usageText = `Goal snapshot: ${Math.floor(goal.usage.activeSeconds / 60)}m${goal.usage.activeSeconds % 60}s · ${goal.usage.tokensUsed} tokens\nRuns: ${turn + 1}`;
			const parts: SimParts | null = goal.status === "paused"
				? { policy: pausedPolicy(goal), steering: "", tasks: "", usage: "" }
				: { policy: activePolicy(goal), steering, tasks, usage: usageText };
			lastLength = request(parts);
			if (k < toolRequests - 1) {
				history.push({ role: "assistant", content: `I will inspect the next file (${turn}.${k}). `.repeat(8), timestamp: time++ });
				history.push({ role: "toolResult", content: "x".repeat(Math.round(scenario.toolChars * (0.2 + random() * 1.6))), timestamp: time++ });
			}
		}
		history.push({ role: "assistant", content: `Turn ${turn} done. `.repeat(20), timestamp: time++ });
		goal.usage.tokensUsed += Math.round(lastLength / 4);
		goal.usage.activeSeconds += 20 + Math.floor(random() * 70);
		if (goal.status === "active" && (turn + 1) % scenario.taskEvery === 0 && finished < TASK_TITLES.length) {
			const tasks = goal.taskList!.tasks;
			tasks[finished]!.status = "complete";
			finished++;
			const next = tasks[finished];
			if (next) { goal.currentTaskId = next.id; }
		}
		if (paused > 0) paused--;
		if (steeringTurns > 0) steeringTurns--;
		if (stallTurns > 0) stallTurns--;
	}
	return {
		requests, totalTokens: Math.round(totalChars / 4), cachedTokens: Math.round(cachedChars / 4),
		bigBreaks, cacheShare: cachedChars / totalChars, cost: Math.round(cost),
	};
}

function activePolicy(goal: GoalRecord): string {
	return goalPromptParts(goal).state;
}

function pausedPolicy(goal: GoalRecord): string {
	return `[PI GOAL PAUSED goalId=${goal.id}]\n${untrustedObjectiveBlock(goal)}\n\nThe goal is paused. Do not autonomously continue substantive work unless the user resumes it with /goal-resume. If the user explicitly asks to finish the paused goal and the objective is already satisfied based on available evidence, you may call update_goal({status: "complete"}). To abandon a goal, the user runs /goal-clear. Do not report the goal blocked in response to a pause.`;
}

/** Reference floor: no goal text at all, so only new history is ever uncached. */
function floorStrategy(): Strategy {
	return { name: "floor: no goal text (not shippable)", build: base => [...base] };
}

export const STRATEGIES: Array<() => Strategy> = [
	floorStrategy,
	currentStrategy,
	productionStrategy,
	() => protoStrategy({ name: "A: counters at the end only", tasks: "ephemeral", steering: "policy", policyChange: "reset" }),
	() => protoStrategy({ name: "B: A + steering at the end", tasks: "ephemeral", steering: "ephemeral", policyChange: "reset" }),
	() => protoStrategy({ name: "C: B + policy appended, not reset", tasks: "ephemeral", steering: "ephemeral", policyChange: "append" }),
	() => protoStrategy({ name: "D: C + task list kept as snapshots", tasks: "retained", steering: "ephemeral", policyChange: "append" }),
];

if (process.argv[1]?.endsWith("simulate.ts")) {
	const rows: Array<Record<string, unknown>> = [];
	for (const scenario of SCENARIOS) {
		for (const make of STRATEGIES) {
			const strategy = make();
			const r = run(strategy, scenario);
			rows.push({ scenario: scenario.name, strategy: strategy.name, ...r });
		}
	}
	if (process.argv.includes("--json")) console.log(JSON.stringify(rows, null, 2));
	else {
		let last = "";
		for (const row of rows) {
			if (row.scenario !== last) { console.log(`\n### ${row.scenario}\n\n| strategy | requests | cache share | uncached tokens | cost (input units) | big breaks |\n|---|---|---|---|---|---|`); last = String(row.scenario); }
			const r = row as unknown as Result & { strategy: string };
			console.log(`| ${r.strategy} | ${r.requests} | ${(r.cacheShare * 100).toFixed(1)}% | ${(r.totalTokens - r.cachedTokens).toLocaleString()} | ${r.cost.toLocaleString()} | ${r.bigBreaks} |`);
		}
	}
}
