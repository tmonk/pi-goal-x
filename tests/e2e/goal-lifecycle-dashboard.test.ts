/**
 * End-to-end goal lifecycle test (plan §19.9): guided creation → clarification
 * → confirmation → auto-start → task focus → dashboard states → completion →
 * staged audit → approval → deferred archival → reload.
 *
 * Runs the REAL extension (goalExtension) with a mock auditor; the dashboard
 * assertions derive from the persisted goal through the shared pure model
 * (the same pipeline the widget uses), so the visible dashboard is proven to
 * reflect real persisted state (§2.2).
 */

import { skipWhenRoot } from "../support/permissions.ts";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import goalExtension from "../../extensions/goal.ts";
import { readGoalLedger } from "../../extensions/goal-ledger.ts";
import type { GoalRecord } from "../../extensions/goal-record.ts";
import { parseGoalFile, readActiveGoalPool } from "../../extensions/storage/goal-files.ts";
import { deriveGoalDashboardModel } from "../../extensions/widgets/goal-dashboard-model.ts";
import { renderCompactDashboard, renderExpandedDashboard } from "../../extensions/widgets/goal-dashboard-renderer.ts";
import { deriveAuditorDashboardModel } from "../../extensions/widgets/auditor-dashboard-model.ts";

const theme = {
	fg: (_color: string, value: string) => value,
	bold: (value: string) => value,
} as never;

const CONFIRM_ANSWER = "Confirm — create this goal now";

interface StageRecord {
	label: string;
	percentage: number;
}

function createHarness(cwd: string, opts: { runCompletionAuditor?: (...args: any[]) => Promise<any> } = {}) {
	const handlers = new Map<string, Function>();
	const commands = new Map<string, any>();
	const tools = new Map<string, any>();
	const notifications: string[] = [];
	const entries: unknown[] = [];
	let dialogResolve: ((result: any) => void) | null = null;
	let hasDialogPending = false;
	const pi = {
		registerTool: (def: any) => { tools.set(def.name, def); },
		registerCommand: (name: string, def: any) => { commands.set(name, def); },
		on: (event: string, handler: Function) => { handlers.set(event, handler); },
		appendEntry: (customType: string, data: unknown) => { entries.push({ type: "custom", customType, data }); },
		registerMessageRenderer: () => {},
		sendUserMessage: () => {},
		sendMessage: () => {},
		getActiveTools: () => ["read", "bash", "edit", "write"],
		setActiveTools: () => {},
		hasUI: true,
	};
	const ctx = {
		cwd,
		hasUI: true,
		sessionManager: {
			getBranch: () => [...entries],
			getCwd: () => cwd,
			getSessionId: () => "lifecycle-e2e-session",
			getRoot: () => cwd,
		},
		ui: {
			notify: (message: string) => { notifications.push(message); },
			setStatus: () => {},
			setWidget: () => {},
			onTerminalInput: () => () => {},
			select: async () => undefined,
			confirm: async () => true,
			custom: async () => new Promise((resolve) => { dialogResolve = resolve; hasDialogPending = true; }),
		},
		getSystemPrompt: () => "base",
		isIdle: () => true,
		hasPendingMessages: () => false,
		abort: () => {},
	} as unknown as ExtensionContext;
	goalExtension(pi as any, { runCompletionAuditor: opts.runCompletionAuditor });
	return {
		ctx,
		commands,
		tools,
		handlers,
		notifications,
		get core() { return (pi as unknown as { _goalCore: any })._goalCore; },
		dialogResult: (result: unknown) => { hasDialogPending = false; dialogResolve?.(result); },
		hasDialog: () => hasDialogPending,
		sessionStart: async () => { await handlers.get("session_start")?.({ reason: "start" }, ctx); },
		beforeAgentStart: async () => { await handlers.get("before_agent_start")?.({ systemPrompt: "base", prompt: "go", systemPromptOptions: {} }, ctx); },
		turnEnd: async (message: unknown = { role: "assistant", stopReason: "stop", usage: { input: 0, output: 0 } }) => {
			await handlers.get("turn_end")?.(message, ctx);
		},
	};
}

function activeGoalFiles(cwd: string): string[] {
	try {
		return readdirSync(path.join(cwd, ".pi", "goals")).filter((n) => n.startsWith("active_goal_"));
	} catch {
		return [];
	}
}

function archivedGoalFiles(cwd: string): string[] {
	try {
		return readdirSync(path.join(cwd, ".pi", "goals", "archived")).filter((n) => n.startsWith("goal_"));
	} catch {
		return [];
	}
}

function currentGoal(cwd: string): GoalRecord | null {
	const files = activeGoalFiles(cwd);
	if (files.length === 0) return null;
	return parseGoalFile(path.join(cwd, ".pi", "goals", files[0]!));
}

function ledgerEvents(cwd: string): any[] {
	return readGoalLedger({ cwd }).events as any[];
}

async function callTool(h: ReturnType<typeof createHarness>, name: string, callId: string, params: Record<string, unknown>) {
	const tool = h.tools.get(name)!;
	assert.ok(tool, `${name} tool must be registered`);
	return tool.execute(callId, params, undefined, undefined, h.ctx);
}

function dashboardText(goal: GoalRecord, expanded: boolean, cwd: string): string {
	const events = readGoalLedger({ cwd }).events.filter((e: any) => e.goalId === goal.id);
	const model = deriveGoalDashboardModel(goal, { focused: true, otherOpenGoals: 0, ledgerEvents: events });
	assert.ok(model, "dashboard model derives from the persisted goal");
	const lines = expanded ? renderExpandedDashboard(model, theme, 100) : renderCompactDashboard(model, theme, 100);
	return lines.join("\n");
}

test("full guided lifecycle: create → focus → tasks → audit → archive (§19.9)", async () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "goal-lifecycle-e2e-"));
	mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
	const staged: StageRecord[] = [];
	const h = createHarness(cwd, {
		runCompletionAuditor: async (args: any) => {
			// §19.9 step 12: report all five audit stages through onProgress.
			const stages: StageRecord[] = [
				{ label: "Starting audit...", percentage: 0 },
				{ label: "Inspecting files...", percentage: 25 },
				{ label: "Verifying success criteria...", percentage: 50 },
				{ label: "Evaluating evidence...", percentage: 75 },
				{ label: "Producing report...", percentage: 95 },
			];
			for (const s of stages) {
				staged.push(s);
				args.onProgress?.({ recentOutput: [], phase: "running", elapsedMs: 1000, label: s.label, percentage: s.percentage });
			}
			args.onProgress?.({ recentOutput: [], phase: "done", elapsedMs: 2000, label: "Audit complete.", percentage: 100 });
			return { approved: true, disapproved: false, output: "All requirements verified.\n<approved/>", model: "mock/auditor" };
		},
	});
	try {
		await h.sessionStart();
		await h.beforeAgentStart();

		// ── Step 1: guided goal creation ────────────────────────────────────
		await h.commands.get("goal")!.handler("Add CSV export to the reports page", h.ctx);

		// ── Step 2: clarification questions ─────────────────────────────────
		const q = callTool(h, "goal_questionnaire", "q-1", {
			questions: [{ question: "Which filters apply?", options: ["Active filters", "All rows"] }],
		});
		assert.ok(h.hasDialog(), "questionnaire dialog opens");
		h.dialogResult({
			questions: [{ id: "filters", question: "Which filters apply?", options: ["Active filters", "All rows"], allowCustom: true }],
			answers: [{ id: "filters", question: "Which filters apply?", answer: "Active filters", wasCustom: false }],
			cancelled: false,
		});
		const qResult = await q;
		assert.ok(JSON.stringify(qResult.content[0].text).includes("Active filters"), "answer recorded");

		// ── Step 3: confirm a five-task plan ────────────────────────────────
		const objective = "Add CSV export to the reports page using active filters.\nSuccess criteria: exports match the visible columns.\nVerification contract: Run npm test (0 failures)";
		const tasks = [
			{ id: "t1", title: "Review reports page and data source" },
			{ id: "t2", title: "Implement filtered CSV export" },
			{ id: "t3", title: "Add the download button", subtasks: undefined as unknown as never },
			{ id: "t4", title: "Add documentation" },
			{ id: "t5", title: "Add and run tests" },
		];
		// Build the flat task list including t3's subtasks.
		const flatTasks = [
			{ id: "t1", title: "Review reports page and data source" },
			{ id: "t2", title: "Implement filtered CSV export" },
			{ id: "t3", title: "Add the download button", verification_contract: "The button downloads a CSV using the active filters." },
			{ id: "t3.1", title: "Add loading state", parent_id: "t3" },
			{ id: "t3.2", title: "Generate timestamped filename", parent_id: "t3" },
			{ id: "t3.3", title: "Add error handling", parent_id: "t3" },
			{ id: "t4", title: "Add documentation" },
			{ id: "t5", title: "Add and run tests" },
		];
		const pending = callTool(h, "propose_goal_draft", "prop-1", { objective, tasks: flatTasks });
		assert.ok(h.hasDialog(), "confirmation dialog opens");
		h.dialogResult({ questions: [], answers: [{ id: "confirm", question: "Confirm Goal Draft", answer: CONFIRM_ANSWER, wasCustom: false }], cancelled: false });
		await pending;
		void tasks;

		// ── Step 4: creation, focus, persistence, auto-continuation ─────────
		let goal = currentGoal(cwd);
		assert.ok(goal, "goal persisted to the active file");
		assert.equal(goal.status, "active");
		assert.equal(goal.autoContinue, true);
		assert.ok(goal.verificationContract?.includes("npm test"), "verification contract extracted");
		assert.equal(goal.taskList?.tasks.length, 5, "five top-level tasks");
		const t3 = goal.taskList?.tasks.find((t) => t.id === "t3");
		assert.deepEqual(t3?.subtasks?.map((s) => s.id), ["t3.1", "t3.2", "t3.3"], "nested tasks persisted");
		assert.ok(h.core.focusedGoalId === goal.id, "goal is focused");
		assert.ok(ledgerEvents(cwd).some((e) => e.type === "goal_created"), "goal_created ledger event");

		// ── Step 5: start the first task ────────────────────────────────────
		await callTool(h, "update_goal_task", "start-1", { task_id: "t1", status: "start" });
		goal = currentGoal(cwd)!;
		assert.equal(goal.currentTaskId, "t1", "start sets the persisted current task");

		// ── Step 6: complete three of five top-level tasks ──────────────────
		await callTool(h, "update_goal_task", "comp-1", { task_id: "t1", status: "complete", evidence: "Source reviewed" });
		await callTool(h, "update_goal_task", "start-2", { task_id: "t2", status: "start" });
		await callTool(h, "update_goal_task", "comp-2", { task_id: "t2", status: "complete", evidence: "Export implemented" });
		await callTool(h, "update_goal_task", "start-3", { task_id: "t3", status: "start" });
		await callTool(h, "update_goal_task", "comp-3", { task_id: "t3.1", status: "complete", evidence: "Loading state" });
		await callTool(h, "update_goal_task", "comp-4", { task_id: "t3.2", status: "complete", evidence: "Filename" });
		// §9.1: a skipped top-level task counts as done toward the main bar.
		await callTool(h, "update_goal_task", "skip-1", { task_id: "t5", status: "skipped", reason: "Covered by t2" });

		// ── Step 7: compact dashboard shows header counts + bar + current + subtasks + contract ──
		goal = currentGoal(cwd)!;
		const compact = dashboardText(goal, false, cwd);
		assert.match(compact, /Tasks · ✓3 done · 2 open/, "compact header shows done/open counts");
		assert.match(compact, /Current  t3 · Add the download button/, "current task shown");
		assert.match(compact, /· Sub 2\/3 \[.*\]/, "subtask bar sits beside the task bar in the header");
		assert.match(compact, /Verify   Run npm test \(0 failures\)/, "verification contract shown");
		assert.match(compact, /File     \.pi\/goals\/active_goal_/, "file path shown");

		// ── Steps 8-9: expanded dashboard shows the full tree + current block ──
		const expanded = dashboardText(goal, true, cwd);
		assert.match(expanded, /├─ Tasks /);
		for (const id of ["t1", "t2", "t3", "t4", "t5", "t3.1", "t3.2", "t3.3"]) {
			assert.ok(expanded.includes(id), `task tree contains ${id}`);
		}
		assert.match(expanded, /▸ t3  Add the download button/, "current task highlighted");
		assert.match(expanded, /~ t5  Add and run tests/, "skipped task marked");
		assert.match(expanded, /├─ Current task /);
		assert.match(expanded, /Subtasks \[.*\] 2\/3 · 67%/);
		assert.match(expanded, /Contract: The button downloads a CSV/, "current-task contract shown");
		assert.match(expanded, /├─ Verification /);

		// ── Step 10: complete all tasks ─────────────────────────────────────
		await callTool(h, "update_goal_task", "comp-5", { task_id: "t3.3", status: "complete", evidence: "Error handling" });
		await callTool(h, "update_goal_task", "comp-6", { task_id: "t3", status: "complete", evidence: "Button works" });
		await callTool(h, "update_goal_task", "comp-7", { task_id: "t4", status: "complete", evidence: "Docs written" });
		goal = currentGoal(cwd)!;
		assert.match(dashboardText(goal, false, cwd), /✓5 done · 0 open/, "all tasks done");

		// ── Step 11: request completion ─────────────────────────────────────
		await callTool(h, "update_goal", "complete-1", { status: "complete" });
		assert.ok(ledgerEvents(cwd).some((e) => e.type === "completion_requested"), "completion_requested ledger event");
		assert.ok(ledgerEvents(cwd).some((e) => e.type === "audit_started"), "audit_started ledger event");

		// ── Steps 12-13: staged audit + approval ────────────────────────────
		assert.equal(staged.length, 5, "all five audit stages reported");
		const lastStage = staged[staged.length - 1]!;
		assert.equal(lastStage.label, "Producing report...");
		// The structured dashboard at 72% would show workspace running (the
		// stage derivation used by the audit widget).
		const auditModel = deriveAuditorDashboardModel(
			{ recentOutput: [], phase: "running", elapsedMs: 1000, label: "Evaluating evidence...", percentage: 72 },
			{ auditorLabel: "mock/auditor" },
		);
		assert.deepEqual(auditModel.checks.map((c) => c.state), ["passed", "passed", "passed", "running", "pending"]);
		assert.equal(h.core.auditResult?.verdict, "approved", "approval sets the result card");

		// ── Step 14: deferred completion ────────────────────────────────────
		goal = currentGoal(cwd)!;
		assert.equal(goal.status, "complete", "goal marked complete but NOT archived yet");
		assert.equal(archivedGoalFiles(cwd).length, 0, "deferred: not archived yet");
		assert.ok(ledgerEvents(cwd).some((e) => e.type === "audit_result" && e.verdict === "approved"), "approved audit recorded");

		// ── Steps 15-16: archive creation + final archive path ──────────────
		await h.turnEnd();
		const archived = archivedGoalFiles(cwd);
		assert.equal(archived.length, 1, "archive created at turn_end");
		const archivePath = `.pi/goals/archived/${archived[0]}`;
		assert.ok(ledgerEvents(cwd).some((e) => e.type === "goal_archived" && e.archivePath === archivePath), "goal_archived ledger event with the real path");
		assert.ok(ledgerEvents(cwd).some((e) => e.type === "goal_completed" && e.archivePath === archivePath), "goal_completed kept for compatibility");
		assert.ok(h.notifications.some((n) => n.includes("Goal archived.") && n.includes(archivePath)), "success message emits the archive path");
		assert.equal(activeGoalFiles(cwd).length, 0, "active record retired");

		// ── Step 17: reload — the goal is no longer active ──────────────────
		const reloaded = [...readActiveGoalPool({ cwd }).values()];
		assert.equal(reloaded.length, 0, "no active goals after reload");
		const archivedRecord = parseGoalFile(path.join(cwd, ".pi", "goals", "archived", archived[0]!));
		assert.equal(archivedRecord?.status, "complete", "archived record is complete and durable");
	} finally {
		try { rmSync(cwd, { recursive: true, force: true }); } catch {}
	}
});

test("archive failure never reports success; the complete record stays recoverable (§16.6)", skipWhenRoot, async () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "goal-archive-fail-"));
	mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
	const h = createHarness(cwd, {
		runCompletionAuditor: async () => ({ approved: true, disapproved: false, output: "ok\n<approved/>", model: "mock/auditor" }),
	});
	try {
		await h.sessionStart();
		await h.beforeAgentStart();
		await h.commands.get("goal-direct")!.handler("Ship the report feature.\nVerification contract: Run npm test (0 failures)", h.ctx);
		let goal = currentGoal(cwd);
		assert.ok(goal);
		// Complete it through the normal deferred flow (approval).
		await callTool(h, "update_goal", "c-1", { status: "complete" });
		goal = currentGoal(cwd)!;
		assert.equal(goal.status, "complete", "deferred completion before archive");

		// Make the archive directory unwritable so the archive write fails.
		const archiveDir = path.join(cwd, ".pi", "goals", "archived");
				await import("node:fs/promises").then(async (fs) => { await fs.chmod(archiveDir, 0o555); });

		await h.turnEnd();

		// Failure behavior (§16.6): never claim success, keep the record
		// recoverable at its active path, and write a diagnostic ledger event.
		assert.equal(h.notifications.some((n) => n.includes("Goal archived.")), false, "failure must never report success");
		assert.ok(
			h.notifications.some((n) => n.includes("Failed to archive completed goal") && n.includes("remains at")),
			"failure reports the remaining active path",
		);
		const events = ledgerEvents(cwd);
		assert.ok(events.some((e) => e.type === "goal_archive_failed"), "diagnostic goal_archive_failed ledger event");
		assert.equal(events.some((e) => e.type === "goal_archived"), false, "no goal_archived on failure");
		// The complete record stays recoverable in the active directory.
		const remaining = currentGoal(cwd);
		assert.ok(remaining, "complete record remains recoverable");
		assert.equal(remaining.status, "complete");
	} finally {
				await import("node:fs/promises").then(async (fs) => { await fs.chmod(path.join(cwd, ".pi", "goals", "archived"), 0o755).catch(() => {}); });
		try { rmSync(cwd, { recursive: true, force: true }); } catch {}
	}
});
