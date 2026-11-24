/**
 * Shared benchmark helpers: fixtures, measurement, baseline rows, and the
 * agent-free integration harness (mirrors tests/integration/extension.test.ts
 * but with an fs-op counter + latency injection from the B8 guard layer).
 *
 * All benches import extension modules directly (node --experimental-strip-types)
 * with the bench adapter hooks installed, so the pi packages are the test
 * stubs (no live agents, createAgentSession throws) and node:fs is the
 * counting/latency wrapper.
 */

import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { beginFsCount, endFsCount, setLatency, withLatency, sleepMs } from "./guard-state.mjs";

import goalExtension from "../../extensions/goal.ts";
import { createGoal, goalFocusDetails } from "../../extensions/goal-record.ts";
import { writeActiveGoalFile } from "../../extensions/storage/goal-files.ts";
import { appendGoalEvent, goalLedgerPath, readGoalLedger } from "../../extensions/goal-ledger.ts";
import { loadGoalSettings } from "../../extensions/settings/resolve.ts";
import { acquireGoalLock } from "../../extensions/storage/goal-lock.ts";
import { readActiveGoalPool } from "../../extensions/storage/goal-files.ts";
import { createGoalCore } from "../../extensions/goal-state.ts";

export { beginFsCount, endFsCount, setLatency, withLatency, sleepMs };

// ── fixtures --------------------------------------------------------------

export function makeFixtureCwd(prefix = "goal-bench-") {
	const cwd = mkdtempSync(path.join(tmpdir(), prefix));
	mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
	return cwd;
}

export function cleanupFixture(cwd) {
	try { rmSync(cwd, { recursive: true, force: true }); } catch {}
}

let fixtureSeq = 0;

export function makeGoalRecord(opts = {}) {
	fixtureSeq += 1;
	return createGoal({
		objective: opts.objective ?? `Benchmark goal ${fixtureSeq} — implement the thing end to end.`,
		autoContinue: opts.autoContinue ?? true,
		sisyphus: opts.sisyphus ?? false,
	}, Date.UTC(2026, 8, 1, 0, 0, 0));
}

/** Write n active goal files into cwd; returns the written records. */
export function makeGoalFiles(cwd, n, opts = {}) {
	const records = [];
	for (let i = 0; i < n; i++) {
		const goal = makeGoalRecord({ objective: `Benchmark goal ${i} — ${opts.objective ?? "long objective with enough text to exercise parse + prompt paths"}` });
		records.push(writeActiveGoalFile({ cwd }, goal));
	}
	return records;
}

/** Append n ledger events into cwd (returns the event array). */
export function makeLedger(cwd, n) {
	const events = [];
	const ctx = { cwd };
	for (let i = 0; i < n; i++) {
		const event = i % 4 === 0
			? { type: "goal_created", goalId: `g${i}`, objective: "fixture objective", sisyphus: false, autoContinue: true, at: new Date(Date.UTC(2026, 8, 1) + i * 1000).toISOString() }
			: i % 4 === 1
				? { type: "goal_focused", goalId: `g${i}`, reason: "created", at: new Date(Date.UTC(2026, 8, 1) + i * 1000).toISOString() }
				: i % 4 === 2
					? { type: "task_complete", goalId: `g${i % 10}`, taskId: `t${i}`, evidence: "verified by test", at: new Date(Date.UTC(2026, 8, 1) + i * 1000).toISOString() }
					: { type: "audit_result", goalId: `g${i % 10}`, verdict: "approved", report: "all checks passed", at: new Date(Date.UTC(2026, 8, 1) + i * 1000).toISOString() };
		events.push(event);
		appendGoalEvent(ctx, event);
	}
	return events;
}

// ── measurement -----------------------------------------------------------

export function percentile(sorted, p) {
	if (sorted.length === 0) return NaN;
	const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
	return sorted[index];
}

/** Time fn n times (after warmup); returns {p50, p95, max, mean, n}. */
export function measure(fn, { n = 20, warmup = 2 } = {}) {
	for (let i = 0; i < warmup; i++) fn();
	const samples = [];
	for (let i = 0; i < n; i++) {
		const t0 = performance.now();
		fn();
		samples.push(performance.now() - t0);
	}
	samples.sort((a, b) => a - b);
	return {
		p50: round1(percentile(samples, 50)),
		p95: round1(percentile(samples, 95)),
		max: round1(samples[samples.length - 1]),
		mean: round1(samples.reduce((a, b) => a + b, 0) / samples.length),
		n,
	};
}

export function round1(v) {
	return Math.round(v * 10) / 10;
}

/** Estimate tokens from characters (chars/4; labeled an estimate, not a model count). */
export function estimateTokens(text) {
	return Math.ceil(text.length / 4);
}

// ── baseline rows ---------------------------------------------------------

export class Baseline {
	constructor() {
		this.rows = [];
	}
	add(row) {
		this.rows.push(row);
	}
	json() {
		return JSON.stringify({ generatedAt: new Date().toISOString(), bench: "pi-goal-x extension", agentFree: true, rows: this.rows }, null, 2) + "\n";
	}
	markdown() {
		const header = "| id | label | modules | fixture | ops | n | p50 ms | p95 ms | max ms | latency | notes |";
		const sep = "|---|---|---|---|---|---|---|---|---|---|---|";
		const lines = [header, sep];
		for (const r of this.rows) {
			const cells = [r.id, r.label, r.modules, r.fixture ?? "-", r.ops ?? "-", r.n, r.p50, r.p95, r.max, r.latency ?? "0ms", r.notes ?? "-"];
			lines.push("| " + cells.map((c) => String(c).replaceAll("|", "/")).join(" | ") + " |");
		}
		return lines.join("\n") + "\n";
	}
}

// ── agent-free integration harness (B7/B5) --------------------------------

export function createHarness(options = {}) {
	const handlers = new Map();
	const tools = new Map();
	const commands = new Map();
	const notifies = [];
	const activeToolsHistory = [];
	let activeTools = ["read", "bash", "edit", "write"];
	let terminalInputHandler = null;
	const pi = {
		registerTool: (def) => { tools.set(def.name, def); },
		registerCommand: (name, def) => { commands.set(name, def); },
		on: (event, handler) => { handlers.set(event, handler); },
		appendEntry: () => {},
		registerMessageRenderer: () => {},
		sendMessage: () => {},
		getActiveTools: () => [...activeTools],
		setActiveTools: (next) => { activeTools = [...next]; activeToolsHistory.push([...next]); },
		hasUI: options.hasUI ?? false,
	};
	const ctx = {
		cwd: options.cwd,
		hasUI: options.hasUI ?? false,
		sessionManager: {
			getBranch: () => options.sessionEntries ?? [],
			getCwd: () => options.cwd,
			getSessionId: () => "bench-session",
			getRoot: () => options.cwd,
		},
		ui: {
			notify: (msg, level) => { notifies.push({ msg, level }); },
			setStatus: () => {},
			setWidget: () => {},
			onTerminalInput: (cb) => { terminalInputHandler = cb; return () => {}; },
			select: options.select ?? (async () => undefined),
			input: options.input ?? (async () => undefined),
			confirm: options.confirm ?? (async () => true),
			custom: options.uiCustom ?? (async () => undefined),
		},
		getSystemPrompt: () => "base",
		isIdle: () => true,
		hasPendingMessages: () => false,
		abort: () => {},
	};
	goalExtension(pi, options.runCompletionAuditor ? { runCompletionAuditor: options.runCompletionAuditor } : {});
	return { handlers, tools, commands, ctx, notifies, activeToolsHistory, get terminalInputHandler() { return terminalInputHandler; } };
}

export async function startHarness(h) {
	await h.handlers.get("session_start")?.({ reason: "start" }, h.ctx);
	await h.handlers.get("before_agent_start")?.({ systemPrompt: "base", prompt: "go", systemPromptOptions: {} }, h.ctx);
}

/** One focused active goal fixture wired into a started harness. */
export function focusedFixture() {
	const cwd = makeFixtureCwd();
	const goal = writeActiveGoalFile({ cwd }, makeGoalRecord());
	const sessionEntries = [
		{ type: "custom", customType: "pi-goal-focus", data: goalFocusDetails(goal.id, "created") },
	];
	return { cwd, goal, sessionEntries, cleanup: () => cleanupFixture(cwd) };
}
