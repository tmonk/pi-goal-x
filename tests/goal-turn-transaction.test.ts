/**
 * P1-3: per-turn transaction buffer.
 *
 * During a turn (turn_start … turn_end), task/status/usage mutations
 * accumulate in memory and flush ONCE at turn end — one lock acquire, one
 * goal-file write, one batched ledger append. The tests assert:
 *   - mid-turn: in-memory state is current but the disk file is NOT yet written;
 *   - turn_end: disk + ledger catch up in one flush;
 *   - update_goal(complete) flushes the buffer BEFORE the auditor runs so the
 *     auditor (a separate session) reads fresh task state.
 */

import { createExtensionHarness } from "./support/extension-harness.ts";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { writeActiveGoalFile } from "../extensions/storage/goal-files.ts";
import { createGoal, goalFocusDetails } from "../extensions/goal-record.ts";

function makeHarness(cwd: string, runCompletionAuditor?: (...args: any[]) => Promise<any>, sessionEntries: unknown[] = []) {
	return createExtensionHarness({ cwd, sessionEntries, sessionId: "s", systemPrompt: "", runCompletionAuditor, ui: { confirm: async () => true } });
}

function fixture(): { cwd: string; goal: { activePath?: string; id: string }; sessionEntries: unknown[]; cleanup: () => void } {
	const cwd = mkdtempSync(path.join(tmpdir(), "goal-turn-txn-"));
	mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
	const goal = writeActiveGoalFile({ cwd }, createGoal({
		objective: "=== Goal ===\nObjective: Turn transaction test",
		autoContinue: true,
		sisyphus: false,
	}, Date.UTC(2026, 8, 4, 9, 0, 0)));
	return { cwd, goal, sessionEntries: [{ type: "custom", customType: "pi-goal-focus", data: goalFocusDetails(goal.id, "created") }], cleanup: () => { try { rmSync(cwd, { recursive: true, force: true }); } catch {} } };
}

function goalFileText(cwd: string, goal: { activePath?: string }) {
	return readFileSync(path.join(cwd, goal.activePath ?? ""), "utf8");
}

function ledgerText(cwd: string) {
	try {
		return readFileSync(path.join(cwd, ".pi", "goals", "goal_events.jsonl"), "utf8");
	} catch {
		return "";
	}
}

describe("P1-3 per-turn transaction buffer", () => {
	it("buffers in-turn task mutations and flushes once at turn_end", async () => {
		const f = fixture();
		try {
			const h = makeHarness(f.cwd, undefined, f.sessionEntries);
			await h.handlers.get("session_start")?.({ reason: "start" }, h.ctx);
			await h.handlers.get("before_agent_start")?.({ systemPrompt: "p", prompt: "p", systemPromptOptions: {} }, h.ctx);
			const setTasks = h.tools.get("set_goal_tasks");
			await setTasks.execute("st", { tasks: [{ id: "t1", title: "T1" }, { id: "t2", title: "T2" }, { id: "t3", title: "T3" }], block_completion: false }, new AbortController().signal, undefined, h.ctx);
			// set_goal_tasks stops the turn: close it, then open the buffered turn.
			await h.handlers.get("turn_end")?.({ message: { role: "assistant", stopReason: "stop", usage: { input: 0, output: 0 } } }, h.ctx);
			await h.handlers.get("turn_start")?.({}, h.ctx);

			const update = h.tools.get("update_goal_task");
			for (const id of ["t1", "t2", "t3"]) {
				await update.execute("u", { task_id: id, status: "complete", evidence: `done ${id}` }, new AbortController().signal, undefined, h.ctx);
			}

			// Mid-turn: in-memory state is current, disk is NOT yet written.
			const before = goalFileText(f.cwd, f.goal);
			assert.match(before, /\[ \] t1: T1/, "disk still shows pending mid-turn");
			assert.match(before, /\[ \] t2: T2/, "disk still shows pending mid-turn");
			const ledgerBefore = ledgerText(f.cwd);
			assert.equal((ledgerBefore.match(/task_complete/g) ?? []).length, 0, "no task_complete ledger events mid-turn");

			// turn_end: one flush writes the goal + batches the ledger.
			await h.handlers.get("turn_end")?.({ message: { role: "assistant", stopReason: "stop", usage: { input: 0, output: 0 } } }, h.ctx);
			const after = goalFileText(f.cwd, f.goal);
			assert.match(after, /\[x\] t1: T1/, "disk catches up after flush");
			assert.match(after, /\[x\] t3: T3/, "disk catches up after flush");
			const ledgerAfter = ledgerText(f.cwd);
			assert.equal((ledgerAfter.match(/task_complete/g) ?? []).length, 3, "three task_complete events after flush");
		} finally {
			f.cleanup();
		}
	});

	it("flushes the buffer before update_goal(complete) dispatches the auditor", async () => {
		const f = fixture();
		try {
			let auditArgs = null;
			const h = makeHarness(f.cwd, async (args) => {
				auditArgs = args;
				// The auditor (a separate session) reads the goal FILE: it must
				// already contain the completed task.
				const disk = goalFileText(f.cwd, f.goal);
				assert.match(disk, /\[x\] t1: T1/, "auditor sees the flushed task state on disk");
				return { approved: true, disapproved: false, output: "ok\n<approved/>", model: "fixture" };
			}, f.sessionEntries);
			await h.handlers.get("session_start")?.({ reason: "start" }, h.ctx);
			await h.handlers.get("before_agent_start")?.({ systemPrompt: "p", prompt: "p", systemPromptOptions: {} }, h.ctx);
			const setTasks = h.tools.get("set_goal_tasks");
			await setTasks.execute("st", { tasks: [{ id: "t1", title: "T1" }], block_completion: false }, new AbortController().signal, undefined, h.ctx);
			await h.handlers.get("turn_end")?.({ message: { role: "assistant", stopReason: "stop", usage: { input: 0, output: 0 } } }, h.ctx);
			await h.handlers.get("turn_start")?.({}, h.ctx);
			const update = h.tools.get("update_goal_task");
			await update.execute("u", { task_id: "t1", status: "complete", evidence: "done t1" }, new AbortController().signal, undefined, h.ctx);

			const complete = h.tools.get("update_goal");
			await complete.execute("c", { status: "complete" }, new AbortController().signal, undefined, h.ctx);
			assert.ok(auditArgs, "auditor was dispatched");
		} finally {
			f.cleanup();
		}
	});

	it("keeps a paused goal persisted immediately (user Esc mid-turn)", async () => {
		const f = fixture();
		try {
			const h = makeHarness(f.cwd, undefined, f.sessionEntries);
			await h.handlers.get("session_start")?.({ reason: "start" }, h.ctx);
			await h.handlers.get("before_agent_start")?.({ systemPrompt: "p", prompt: "p", systemPromptOptions: {} }, h.ctx);
			await h.handlers.get("turn_start")?.({}, h.ctx);
			// User Esc → the session abort signal fires → message_end aborted
			// arrives with the signal set → pauseActiveGoal.
			const controller = new AbortController();
			controller.abort(); // user Esc fires the session abort signal
			const escCtx = { ...h.ctx, signal: controller.signal } as typeof h.ctx;
			await h.handlers.get("message_end")?.({ message: { role: "assistant", stopReason: "aborted", usage: { input: 0, output: 0 } } }, escCtx);
			const disk = goalFileText(f.cwd, f.goal);
			assert.match(disk, /Status: paused/, "pause persists immediately, not at turn end");
		} finally {
			f.cleanup();
		}
	});
});
