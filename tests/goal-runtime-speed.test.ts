/**
 * Guards for the runtime speed work (specs/2026-11-24-runtime-speed): how many
 * file operations a goal turn costs, what it costs to check a long history, and
 * how much code loads when Pi starts. The numbers are bounds, not targets: they
 * fail when a change makes any of these clearly worse.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

import { createExtensionHarness } from "./support/extension-harness.ts";
import { createGoal, goalFocusDetails } from "../extensions/goal-record.ts";
import { writeActiveGoalFile } from "../extensions/storage/goal-files.ts";
import { LiveTailRetention } from "../extensions/goal-live-retention.ts";
import { removeDir, tempDir } from "./support/fs.ts";

const requireFs = createRequire(import.meta.url)("node:fs");
const SYNC_OPS = ["readFileSync", "writeFileSync", "appendFileSync", "readdirSync", "statSync", "lstatSync", "existsSync", "mkdirSync", "renameSync", "unlinkSync", "openSync", "closeSync", "fsyncSync"];

/** Counts the synchronous fs calls the extension makes while `run` executes. */
async function countFsOps(run: () => Promise<void>): Promise<{ total: number; renames: string[] }> {
	const originals = new Map<string, unknown>();
	const seen = { total: 0, renames: [] as string[] };
	for (const name of SYNC_OPS) {
		const original = requireFs[name];
		originals.set(name, original);
		requireFs[name] = function (...args: unknown[]) {
			seen.total++;
			if (name === "renameSync") seen.renames.push(String(args[1]));
			return original.apply(this, args);
		};
	}
	syncBuiltinESMExports();
	try {
		await run();
	} finally {
		for (const [name, original] of originals) requireFs[name] = original;
		syncBuiltinESMExports();
	}
	return seen;
}

test("an ordinary goal turn saves the goal file once", async () => {
	const cwd = tempDir("goal-speed-turn-");
	mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
	try {
		const goal = writeActiveGoalFile({ cwd }, createGoal({ objective: "Keep the turn cheap", autoContinue: true, sisyphus: false }, Date.UTC(2026, 8, 1)));
		const h = createExtensionHarness({ cwd, sessionEntries: [{ type: "custom", customType: "pi-goal-focus", data: goalFocusDetails(goal.id, "created") }], sessionId: "speed-turn" });
		await h.sessionStart();
		const reply = { role: "assistant", content: [{ type: "text", text: "done" }], usage: { input: 1200, output: 300, totalTokens: 1500 }, stopReason: "stop", timestamp: 2 };
		const turn = async () => {
			await h.emit("before_agent_start", { systemPrompt: "base", prompt: "go", systemPromptOptions: {} });
			await h.emit("agent_start", {});
			await h.emit("turn_start", {});
			await h.emit("context_with_system", { messages: [{ role: "user", content: "go", timestamp: 1 }] });
			await h.emit("turn_end", { message: reply, toolResults: [] });
			await h.emit("agent_end", { messages: [reply] });
		};
		await turn(); // the first turn also reads the pool from disk
		const second = await countFsOps(turn);
		const goalWrites = second.renames.filter(target => path.basename(target).startsWith("active_goal_"));
		assert.equal(goalWrites.length, 1, `the goal file was written ${goalWrites.length} times in one turn`);
		assert.ok(second.total <= 26, `a goal turn used ${second.total} file operations (bound 26)`);
	} finally {
		removeDir(cwd);
	}
});

test("a task update makes no needless directory checks", async () => {
	const cwd = tempDir("goal-speed-tool-");
	mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
	try {
		const goal = writeActiveGoalFile({ cwd }, createGoal({ objective: "Pause once", autoContinue: true, sisyphus: false }, Date.UTC(2026, 8, 1)));
		const h = createExtensionHarness({ cwd, sessionEntries: [{ type: "custom", customType: "pi-goal-focus", data: goalFocusDetails(goal.id, "created") }], sessionId: "speed-tool" });
		await h.sessionStart();
		await h.emit("before_agent_start", { systemPrompt: "base", prompt: "go", systemPromptOptions: {} });
		await h.callTool("set_goal_tasks", { tasks: [{ id: "a", title: "First" }, { id: "b", title: "Second" }], block_completion: false });
		const ops = await countFsOps(async () => { await h.callTool("update_goal_task", { task_id: "a", status: "complete", evidence: "done" }); });
		assert.ok(ops.total <= 25, `update_goal_task used ${ops.total} file operations (bound 25; it was 27 before)`);
	} finally {
		removeDir(cwd);
	}
});

// ── History check ─────────────────────────────────────────────────────────

const message = (n: number, text: string) => ({ role: n % 2 ? "assistant" : "user", content: [{ type: "text", text }], timestamp: n });
/** Pi gives the hook a fresh copy of the history on every request. */
const copy = <T>(messages: T): T => structuredClone(messages);

test("an unchanged history, including long tool output, keeps the retained goal text", () => {
	const retention = new LiveTailRetention();
	const history = [message(0, "start"), message(1, "x".repeat(50_000)), message(2, "y".repeat(500))];
	retention.apply("s", copy(history), { state: "POLICY", counters: "TASKS" });
	const again = retention.apply("s", copy([...history, message(3, "next")]), { state: "POLICY", counters: "TASKS" });
	const live = again.messages.map((m: any, i: number) => (m.customType === "pi-goal-live-context" ? i : -1)).filter(i => i >= 0);
	assert.deepEqual(live, [3, 4], "policy and tasks stay where they were added, and nothing is added twice");
});

test("an edit anywhere earlier in the history starts the retained text over", () => {
	for (const edit of [
		(history: any[]) => { history[1].content[0].text = "x".repeat(49_999) + "z"; }, // long text, same length
		(history: any[]) => { history[2].content[0].text = "y".repeat(499) + "z"; }, // short text, same length
		(history: any[]) => { history[1].timestamp = 99; },
		(history: any[]) => { history[2].content.push({ type: "text", text: "extra" }); },
		(history: any[]) => { history[0].extra = true; },
	]) {
		const retention = new LiveTailRetention();
		const history = [message(0, "start"), message(1, "x".repeat(50_000)), message(2, "y".repeat(500)), message(3, "last")];
		retention.apply("s", copy(history), { state: "POLICY", counters: "TASKS" });
		const edited = copy(history);
		edit(edited);
		const next = retention.apply("s", edited, { state: "POLICY", counters: "TASKS" });
		const live = next.messages.map((m: any, i: number) => (m.customType === "pi-goal-live-context" ? i : -1)).filter(i => i >= 0);
		assert.deepEqual(live, [edited.length, edited.length + 1], "the retained text moved to the end of the edited history");
	}
});

test("a message that cannot be compared never counts as unchanged", () => {
	const retention = new LiveTailRetention();
	const cyclic: any = { role: "user", content: "loop", timestamp: 1 };
	cyclic.self = cyclic;
	const odd = { role: "user", content: new Map([["a", 1]]), timestamp: 2 };
	for (const bad of [cyclic, odd]) {
		retention.clear("s");
		retention.apply("s", [bad], { state: "POLICY" });
		const next = retention.apply("s", [bad, message(3, "later")], { state: "POLICY" });
		const live = next.messages.filter((m: any) => m.customType === "pi-goal-live-context");
		assert.equal(live.length, 1, "no stale copy is left behind");
	}
});

test("checking a long history stays cheap", () => {
	const retention = new LiveTailRetention();
	const history = Array.from({ length: 1500 }, (_, i) => message(i, `turn ${i} ${"result text ".repeat(i % 3 === 0 ? 400 : 20)}`));
	retention.apply("s", copy(history), { state: "POLICY" });
	const requests = Array.from({ length: 20 }, () => copy(history));
	const started = performance.now();
	for (const request of requests) retention.apply("s", request, { state: "POLICY" });
	const perRequest = (performance.now() - started) / requests.length;
	// About 1 ms on a laptop for 1,500 messages and 2 MB. Hashing every message
	// took about 6 ms. The bound is loose so a slow runner does not fail it.
	assert.ok(perRequest < 25, `checking the history took ${perRequest.toFixed(1)} ms per request`);
});

// ── Startup ───────────────────────────────────────────────────────────────

/** Files the extension loads at startup: every static import that is not type-only. */
function startupFiles(entry: string): Map<string, number> {
	const seen = new Map<string, number>();
	const visit = (file: string) => {
		if (seen.has(file)) return;
		const text = readFileSync(file, "utf8");
		seen.set(file, text.length);
		const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
		for (const statement of source.statements) {
			let specifier: string | undefined;
			if (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) {
				if (!statement.moduleSpecifier || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
				specifier = statement.moduleSpecifier.text;
				if (ts.isImportDeclaration(statement)) {
					const clause = statement.importClause;
					const named = clause?.namedBindings;
					const onlyTypes = clause?.isTypeOnly === true
						|| (clause !== undefined && !clause.name && named !== undefined && ts.isNamedImports(named) && named.elements.length > 0 && named.elements.every(element => element.isTypeOnly));
					if (onlyTypes) continue;
				} else if (statement.isTypeOnly) continue;
			}
			if (specifier?.startsWith(".")) visit(path.resolve(path.dirname(file), specifier));
		}
	};
	visit(entry);
	return seen;
}

test("code only used by commands and dialogs is not loaded at startup", () => {
	const root = path.resolve(import.meta.dirname, "../extensions");
	const loaded = startupFiles(path.join(root, "goal.ts"));
	const names = new Set([...loaded.keys()].map(file => path.relative(root, file)));
	for (const lazy of ["goal-settings-menu.ts", "goal-status.ts", "goal-recovery.ts", path.join("widgets", "goal-controls-dialog.ts")]) {
		assert.ok(!names.has(lazy), `${lazy} loads at startup; load it from the command that needs it`);
	}
	const bytes = [...loaded.values()].reduce((sum, size) => sum + size, 0);
	assert.ok(bytes < 830_000, `${(bytes / 1024).toFixed(0)} KiB of source loads at startup (bound 810 KiB)`);
});
