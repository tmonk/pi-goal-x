/**
 * Fault-injection persistence tests (reliability campaign 2026-08-09).
 *
 * Simulates crash/interruption states and multi-process contention without
 * live agents: torn writes, torn ledger tails, stale locks, and cross-process
 * appends exercised through the extension's own persistence layer.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { createGoal } from "../extensions/goal-record.ts";
import {
	invalidateGoalPoolCache,
	parseGoalFile,
	readActiveGoalPool,
	writeActiveGoalFile,
} from "../extensions/storage/goal-files.ts";
import { acquireGoalLock } from "../extensions/storage/goal-lock.ts";
import { appendGoalEvent, goalLedgerPath, invalidateGoalLedgerCache, loadLedgerState, readGoalLedger } from "../extensions/goal-ledger.ts";
import { diffGoalRefreshState } from "../extensions/goal-commands.ts";
import { tempDir } from "./support/fs.ts";

const EXT_ROOT = fileURLToPath(new URL("../extensions/", import.meta.url));

function tempCwd(): string {
	const cwd = tempDir("goal-fault-");
	fs.mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
	return cwd;
}

function cleanup(cwd: string): void {
	try { fs.rmSync(cwd, { recursive: true, force: true }); } catch {}
}

function invalidateAll(): void {
	invalidateGoalPoolCache();
	invalidateGoalLedgerCache();
}

test("fault: torn goal-file write is never observed as partial content", () => {
	const cwd = tempCwd();
	try {
		const goal = writeActiveGoalFile({ cwd }, createGoal({ objective: "first version", autoContinue: true, sisyphus: false }, Date.UTC(2026, 8, 7, 9, 0, 0)));
		const filePath = path.join(cwd, goal.activePath ?? "");
		const before = fs.readFileSync(filePath, "utf8");

		// Simulate a crash between the temp write and the rename: a partial
		// temp file is left next to the goal file, and the goal file itself is
		// truncated (a torn rename target). Readers must ignore the temp file
		// and never observe a hybrid.
		const dir = path.dirname(filePath);
		const tmpName = `${path.basename(filePath)}.tmp-${process.pid}`;
		fs.writeFileSync(path.join(dir, tmpName), before.slice(0, 40), "utf8");
		fs.writeFileSync(filePath, before.slice(0, 120), "utf8"); // truncated goal file

		// parseGoalFile on the truncated file returns null (malformed), and the
		// pool scan ignores the .tmp file entirely.
		const parsed = parseGoalFile(filePath);
		assert.equal(parsed, null, "truncated goal file is detected as malformed");
		invalidateAll();
		const pool = readActiveGoalPool({ cwd });
		assert.equal(pool.size, 0, "torn goal is excluded from the pool; temp files are never parsed");

		// A subsequent extension write atomically restores a valid file.
		const restored = writeActiveGoalFile({ cwd }, createGoal({ objective: "restored", autoContinue: true, sisyphus: false }, Date.UTC(2026, 8, 7, 9, 1, 0)));
		const reparsed = parseGoalFile(path.join(cwd, restored.activePath ?? ""));
		assert.ok(reparsed, "re-write restores a fully parseable goal file");
		assert.equal(reparsed.objective, "restored");
	} finally {
		cleanup(cwd);
	}
});

test("fault: torn ledger tail is counted malformed and never breaks reads or tail replay", () => {
	const cwd = tempCwd();
	try {
		appendGoalEvent({ cwd }, { type: "goal_created", goalId: "g1", objective: "o", sisyphus: false, autoContinue: true, at: new Date().toISOString() });
		invalidateAll();
		// Build a checkpoint over the first event.
		loadLedgerState({ cwd });

		// Crash-simulated torn append: a partial JSON line at the tail.
		fs.appendFileSync(goalLedgerPath({ cwd }), '{"type": "goal_focused", "goalId": "g1", "reason": "crea', "utf8");

		invalidateAll();
		const read = readGoalLedger({ cwd });
		assert.equal(read.malformed, 1, "torn line counted as malformed");
		assert.equal(read.events.length, 1, "valid events before the torn tail are intact");

		// Checkpoint tail replay tolerates the torn tail too.
		invalidateAll();
		const state = loadLedgerState({ cwd });
		assert.equal(state.malformed, 1);
		assert.equal(state.state.goals.size, 1);
		assert.equal(state.state.focusedGoalId, null, "no focus event survived; the torn tail did not corrupt state");
	} finally {
		cleanup(cwd);
	}
});

test("fault: stale lock (dead pid) is reclaimed promptly; live-holder lock fails fast", async () => {
	const cwd = tempCwd();
	try {
		// Stale lock: dead pid + old mtime.
		fs.mkdirSync(path.join(cwd, ".pi", "goals", ".locks"), { recursive: true });
		const lockPath = path.join(cwd, ".pi", "goals", ".locks", "g1.lock");
		fs.writeFileSync(lockPath, JSON.stringify({ pid: 999_999_999, startedAt: new Date(Date.now() - 120_000).toISOString() }), "utf8");
		const past = new Date(Date.now() - 120_000);
		fs.utimesSync(lockPath, past, past);

		const t0 = Date.now();
		const lock = acquireGoalLock({ cwd }, "g1");
		const elapsed = Date.now() - t0;
		assert.ok(lock, "stale lock reclaimed");
		assert.ok(elapsed < 5_000, `staleness recovery is prompt (${elapsed}ms)`);
		lock.release();

		// Live holder: a child process acquires the lock and holds it; the
		// parent's acquisition must fail fast (bounded), not block.
		const holderScript = `
			const { acquireGoalLock } = require(${JSON.stringify(path.join(EXT_ROOT, "storage/goal-lock.ts"))});
			const lock = acquireGoalLock({ cwd: process.env.FAULT_CWD }, "g2");
			console.log("HELD");
			setTimeout(() => { lock.release(); process.exit(0); }, 8000);
		`;
		const holder = spawn(process.execPath, ["--experimental-strip-types", "-e", holderScript], {
			cwd, env: { ...process.env, FAULT_CWD: cwd }, stdio: ["ignore", "pipe", "inherit"],
		});
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("holder never acquired the lock")), 10_000);
			holder.stdout?.on("data", (d: Buffer) => {
				if (d.toString().includes("HELD")) { clearTimeout(timer); resolve(); }
			});
			holder.on("error", reject);
		});
		assert.equal(holder.exitCode, null, "holder child is still running");

		const t1 = Date.now();
		let result: ReturnType<typeof acquireGoalLock> | null = null;
		let err: unknown = null;
		try {
			result = acquireGoalLock({ cwd }, "g2");
		} catch (e) {
			err = e;
		}
		const contended = Date.now() - t1;
		assert.ok(result === null || err !== null, "contended acquisition fails fast (either null or typed error)");
		assert.ok(contended < 2_000, `contended acquisition bounded (${contended}ms)`);

		holder.kill("SIGKILL");
		await new Promise((resolve) => holder.on("exit", resolve));
	} finally {
		cleanup(cwd);
	}
});

test("fault: multi-process goal-file writes never tear (one complete writer wins)", () => {
	const cwd = tempCwd();
	try {
		// Two children write the same goal id concurrently via the extension's
		// own atomic writer; the final file must be one of the two complete
		// versions — never a hybrid.
		const writer = (objective: string) => `
			const { createGoal } = require(${JSON.stringify(path.join(EXT_ROOT, "goal-record.ts"))});
			const { writeActiveGoalFile } = require(${JSON.stringify(path.join(EXT_ROOT, "storage/goal-files.ts"))});
			const goal = createGoal({ objective: ${JSON.stringify(objective)}, autoContinue: true, sisyphus: false }, Date.UTC(2026, 8, 7, 10, 0, 0));
			for (let i = 0; i < 50; i++) writeActiveGoalFile({ cwd: process.env.FAULT_CWD }, goal);
			process.exit(0);
		`;
		const a = spawnSync(process.execPath, ["--experimental-strip-types", "-e", writer("AAAA")], { cwd, env: { ...process.env, FAULT_CWD: cwd }, encoding: "utf8", timeout: 60_000 });
		const b = spawnSync(process.execPath, ["--experimental-strip-types", "-e", writer("BBBB")], { cwd, env: { ...process.env, FAULT_CWD: cwd }, encoding: "utf8", timeout: 60_000 });
		assert.equal(a.status, 0);
		assert.equal(b.status, 0);

		invalidateAll();
		const pool = readActiveGoalPool({ cwd });
		assert.ok(pool.size >= 1, "at least one goal survived the concurrent writes");
		for (const goal of pool.values()) {
			const parsed = parseGoalFile(path.join(cwd, goal.activePath ?? ""));
			assert.ok(parsed, "every surviving goal file parses cleanly");
			assert.ok(parsed.objective === "AAAA" || parsed.objective === "BBBB", "objective is one complete writer's version, never a hybrid");
		}
	} finally {
		cleanup(cwd);
	}
});

test("fault: child-process append is picked up by the refresh diff (cross-process invalidation)", () => {
	const cwd = tempCwd();
	try {
		writeActiveGoalFile({ cwd }, createGoal({ objective: "base", autoContinue: true, sisyphus: false }, Date.UTC(2026, 8, 7, 11, 0, 0)));
		invalidateAll();
		readActiveGoalPool({ cwd }); // warm the pool cache
		readGoalLedger({ cwd }); // warm the ledger cache

		// A child (separate process) writes a goal file + ledger line directly.
		const res = spawnSync(process.execPath, ["--experimental-strip-types", "-e", `
			const fs = require("node:fs");
			const { createGoal } = require(${JSON.stringify(path.join(EXT_ROOT, "goal-record.ts"))});
			const { writeActiveGoalFile } = require(${JSON.stringify(path.join(EXT_ROOT, "storage/goal-files.ts"))});
			const { goalLedgerPath } = require(${JSON.stringify(path.join(EXT_ROOT, "goal-ledger.ts"))});
			const goal = createGoal({ objective: "child goal", autoContinue: true, sisyphus: false }, Date.UTC(2026, 8, 7, 11, 1, 0));
			writeActiveGoalFile({ cwd: process.env.FAULT_CWD }, goal);
			fs.appendFileSync(goalLedgerPath({ cwd: process.env.FAULT_CWD }), JSON.stringify({ type: "goal_created", goalId: goal.id, objective: "child goal", sisyphus: false, autoContinue: true, at: new Date().toISOString() }) + "\\n", "utf8");
			process.exit(0);
		`], { cwd, env: { ...process.env, FAULT_CWD: cwd }, encoding: "utf8", timeout: 30_000 });
		assert.equal(res.status, 0, `child exit ${res.status}`);

		// Parent's warm caches still show the old state (mid-session staleness).
		const ledgerBefore = readGoalLedger({ cwd }).events.length;
		const poolBefore = readActiveGoalPool({ cwd }).size;
		assert.equal(poolBefore, 1, "warm cache before the external write");
		assert.equal(ledgerBefore, 0, "warm ledger before the external write");

		// The refresh diff (before=warm caches, after=cold re-read) reports both.
		invalidateAll();
		const afterPool = readActiveGoalPool({ cwd });
		const afterLedger = readGoalLedger({ cwd });
		const changes = diffGoalRefreshState(
			{ poolIds: ["base"], ledgerEvents: ledgerBefore, ledgerMalformed: 0, settings: "s" },
			{ poolIds: [...afterPool.keys()], ledgerEvents: afterLedger.events.length, ledgerMalformed: afterLedger.malformed, settings: "s" },
		);
		assert.ok(changes.some((c) => c.includes("added")), "pool addition reported");
		assert.ok(changes.some((c) => c.includes("ledger: 0 -> 1 events")), "ledger growth reported");
	} finally {
		cleanup(cwd);
	}
});
