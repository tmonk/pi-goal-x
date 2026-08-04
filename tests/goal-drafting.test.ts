/**
 * Handler-level guided-drafting coverage (follow-up Stage 5, TECH §6):
 * confirmation decisions (confirm / continue / cancel), atomic creation with
 * verification contract and nested task tree, Sisyphus mode fidelity and
 * structural sufficiency, tasks/contracts-disabled variants, /goal-tweak
 * guided refinement under focus races, and headless auto-confirm semantics.
 */

import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import goalExtension from "../extensions/goal.ts";
import { parseGoalFile } from "../extensions/storage/goal-files.ts";
import { readGoalLedger } from "../extensions/goal-ledger.ts";
import { goalSettingsPath } from "../extensions/goal-settings.ts";

interface Harness {
	ctx: ExtensionContext;
	commands: Map<string, any>;
	tools: Map<string, any>;
	messages: string[];
	notifications: string[];
	activeTools(): string[];
	toolHistory(): string[][];
	dialogResult(result: unknown): void;
	hasDialog: () => boolean;
	sessionStart(): Promise<void>;
}

function createHarness(cwd: string, opts: { hasUI?: boolean } = {}): Harness {
	const handlers = new Map<string, Function>();
	const commands = new Map<string, any>();
	const notifications: string[] = [];
	const messages: string[] = [];
	const tools = new Map<string, any>();
	const toolHistory: string[][] = [];
	let activeTools = ["read", "bash", "edit", "write"];
	let dialogResolve: ((result: any) => void) | null = null;
	let hasDialogPending = false;
	const hasUI = opts.hasUI ?? false;
	const pi = {
		registerTool: (def: any) => { tools.set(def.name, def); },
		registerCommand: (name: string, def: any) => { commands.set(name, def); },
		on: (event: string, handler: Function) => { handlers.set(event, handler); },
		appendEntry: () => {},
		registerMessageRenderer: () => {},
		sendUserMessage: (message: string) => { messages.push(message); },
		sendMessage: () => {},
		getActiveTools: () => [...activeTools],
		setActiveTools: (names: string[]) => { activeTools = [...names]; toolHistory.push([...names]); },
		hasUI,
	};
	const ctx = {
		cwd,
		hasUI,
		sessionManager: {
			getBranch: () => [] as unknown[],
			getCwd: () => cwd,
			getSessionId: () => "draft-session",
			getRoot: () => cwd,
		},
		ui: {
			notify: (message: string) => { notifications.push(message); },
			setStatus: () => {},
			setWidget: () => {},
			onTerminalInput: () => () => {},
			select: async () => undefined,
			confirm: async () => false,
			custom: async () => new Promise((resolve) => { dialogResolve = resolve; hasDialogPending = true; }),
		},
		getSystemPrompt: () => "base",
		isIdle: () => true,
		hasPendingMessages: () => false,
		abort: () => {},
	} as unknown as ExtensionContext;
	goalExtension(pi as any, {});
	return {
		ctx,
		commands,
		tools,
		messages,
		notifications,
		activeTools: () => [...activeTools],
		toolHistory: () => toolHistory.map((t) => [...t]),
		dialogResult: (result: unknown) => { hasDialogPending = false; dialogResolve?.(result); },
		hasDialog: () => hasDialogPending,
		sessionStart: async () => { await handlers.get("session_start")?.({ reason: "start" }, ctx); },
	};
}

function activeGoalFiles(cwd: string): string[] {
	try {
		return readdirSync(path.join(cwd, ".pi", "goals")).filter((n) => n.startsWith("active_goal_"));
	} catch {
		return [];
	}
}

function ledgerEvents(cwd: string) {
	return readGoalLedger({ cwd }).events;
}

function writeSettings(cwd: string, settings: Record<string, unknown>): void {
	mkdirSync(path.dirname(goalSettingsPath(cwd)), { recursive: true });
	writeFileSync(goalSettingsPath(cwd), JSON.stringify(settings), "utf8");
}

function firstGoal(cwd: string) {
	const files = activeGoalFiles(cwd);
	assert.equal(files.length, 1, "exactly one active goal expected");
	return parseGoalFile(path.join(cwd, ".pi", "goals", files[0]!))!;
}

const CONFIRM_ANSWER = "Confirm — create this goal now";
const CONTINUE_ANSWER = "Continue chatting — keep refining";
const CANCEL_ANSWER = "Cancel — discard this draft";

function proposalParams(objective: string, extra: Record<string, unknown> = {}) {
	return { objective, sisyphus: false, ...extra };
}

async function runProposal(h: Harness, params: Record<string, unknown>): Promise<any> {
	const proposal = h.tools.get("propose_goal_draft");
	assert.ok(proposal, "propose_goal_draft must be registered during a draft");
	return proposal.execute("draft-1", params, new AbortController().signal, undefined, h.ctx);
}

// ── Confirmation decisions ────────────────────────────────────────────────

test("dialog cancel is a durable no-op and clears the draft", async () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "goal-draft-cancel-"));
	mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
	try {
		const h = createHarness(cwd, { hasUI: true });
		await h.sessionStart();
		await h.commands.get("goal")!.handler("Ship a small feature", h.ctx);
		const pending = runProposal(h, proposalParams("Ship a small feature.\nSuccess criteria: tests pass."));
		assert.ok(h.hasDialog(), "confirmation dialog must open");
		h.dialogResult({ questions: [], answers: [{ id: "confirm", question: "Confirm Goal Draft", answer: CANCEL_ANSWER, wasCustom: false }], cancelled: false });
		const result = await pending;
		assert.match(result.content[0].text, /Draft cancelled/);
		assert.equal(activeGoalFiles(cwd).length, 0, "cancel must not create a goal");
		assert.deepEqual(ledgerEvents(cwd).filter((e) => e.type === "goal_created"), [], "cancel must not write a goal_created event");
		// Drafting tools removed; execution profile restored.
		const tools = h.activeTools();
		assert.ok(tools.includes("update_goal"), "execution profile restored");
		assert.equal(tools.includes("goal_questionnaire"), false, "drafting tools removed");
	} finally {
		try { rmSync(cwd, { recursive: true, force: true }); } catch {}
	}
});

test("continue refining keeps the draft alive and a second proposal confirms", async () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "goal-draft-refine-"));
	mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
	try {
		const h = createHarness(cwd, { hasUI: true });
		await h.sessionStart();
		await h.commands.get("goal")!.handler("Build a tiny app", h.ctx);
		const tasks = [{ id: "setup", title: "Set up" }, { id: "verify", title: "Verify" }];
		const pending1 = runProposal(h, proposalParams("Build a tiny app.\nSuccess criteria: it runs.", { tasks }));
		h.dialogResult({ questions: [], answers: [{ id: "confirm", question: "Confirm Goal Draft", answer: CONTINUE_ANSWER, wasCustom: false }], cancelled: false });
		const result1 = await pending1;
		assert.match(result1.content[0].text, /refinement requested/);
		assert.equal(activeGoalFiles(cwd).length, 0, "refining must not create a goal");
		assert.ok(h.activeTools().includes("goal_questionnaire"), "drafting tools remain while refining");
		// Second proposal confirms with the same task plan.
		const pending2 = runProposal(h, proposalParams("Build a tiny app.\nSuccess criteria: it runs.", { tasks }));
		h.dialogResult({ questions: [], answers: [{ id: "confirm", question: "Confirm Goal Draft", answer: CONFIRM_ANSWER, wasCustom: false }], cancelled: false });
		await pending2;
		const goal = firstGoal(cwd);
		assert.deepEqual(goal.taskList?.tasks.map((t) => t.id), ["setup", "verify"], "answers and proposed tasks survive refining");
	} finally {
		try { rmSync(cwd, { recursive: true, force: true }); } catch {}
	}
});

test("confirmed proposal persists verification contract and nested tasks, then restores the profile", async () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "goal-draft-nested-"));
	mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
	try {
		const h = createHarness(cwd, { hasUI: true });
		await h.sessionStart();
		await h.commands.get("goal")!.handler("Add search", h.ctx);
		const objective = "Add search.\nSuccess criteria: queries return results.\nVerification contract: Run npm test (0 failures)";
		const tasks = [
			{ id: "index", title: "Index documents" },
			{ id: "rank", title: "Rank results", parent_id: "index" },
			{ id: "surface", title: "Surface in UI", parent_id: "index" },
		];
		const pending = runProposal(h, proposalParams(objective, { tasks, block_completion: true }));
		h.dialogResult({ questions: [], answers: [{ id: "confirm", question: "Confirm Goal Draft", answer: CONFIRM_ANSWER, wasCustom: false }], cancelled: false });
		await pending;
		const goal = firstGoal(cwd);
		assert.ok(goal.verificationContract?.includes("npm test"), "verification contract persisted");
		assert.ok(!goal.objective.includes("Verification contract"), "contract line removed from objective");
		assert.equal(goal.taskList?.blockCompletion, true);
		const ids = goal.taskList?.tasks.map((t) => t.id) ?? [];
		assert.deepEqual(ids, ["index"], "parent task is the root");
		const index = goal.taskList?.tasks.find((t) => t.id === "index");
		assert.deepEqual(index?.subtasks?.map((t) => t.id), ["rank", "surface"], "children become subtasks");
		// Execution profile restored: drafting tools gone, five-tool profile back.
		const tools = h.activeTools();
		for (const name of ["update_goal", "set_goal_tasks", "update_goal_task"]) assert.ok(tools.includes(name), name);
		assert.equal(tools.includes("propose_goal_draft"), false, "drafting tools removed after confirmation");
	} finally {
		try { rmSync(cwd, { recursive: true, force: true }); } catch {}
	}
});

// ── Sisyphus fidelity and validation ──────────────────────────────────────

test("sisyphus mode mismatch and structural sufficiency are validated before confirmation", async () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "goal-draft-sisy-"));
	mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
	try {
		const h = createHarness(cwd);
		await h.sessionStart();
		await h.commands.get("sisyphus")!.handler("Refactor auth", h.ctx);
		const wrong = await runProposal(h, proposalParams("Refactor auth cleanly.", { sisyphus: false }));
		assert.match(wrong.content[0].text, /mode does not match/);
		const noSteps = await runProposal(h, proposalParams("Refactor auth cleanly.", { sisyphus: true }));
		assert.match(noSteps.content[0].text, /ordered steps/);
		assert.equal(activeGoalFiles(cwd).length, 0, "no goal created for invalid proposals");
		const ok = await runProposal(h, proposalParams("Refactor auth: 1) extract token validation. 2) wire it into login. 3) update tests.", { sisyphus: true }));
		assert.ok(ok.content[0].text.includes("Goal created") || ok.terminate === true);
		const goal = firstGoal(cwd);
		assert.equal(goal.sisyphus, true, "sisyphus mode preserved");
	} finally {
		try { rmSync(cwd, { recursive: true, force: true }); } catch {}
	}
});

test("/sisyphus-direct rejects structurally insufficient objectives", async () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "goal-draft-sisydirect-"));
	mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
	try {
		const h = createHarness(cwd);
		await h.sessionStart();
		await h.commands.get("sisyphus-direct")!.handler("Just do the thing", h.ctx);
		assert.equal(activeGoalFiles(cwd).length, 0, "insufficient sisyphus objective rejected");
		assert.ok(h.notifications.some((n) => n.includes("ordered steps")), "guidance notification emitted");
		await h.commands.get("sisyphus-direct")!.handler("Refactor: 1) extract. 2) wire. 3) test.", h.ctx);
		const goal = firstGoal(cwd);
		assert.equal(goal.sisyphus, true);
	} finally {
		try { rmSync(cwd, { recursive: true, force: true }); } catch {}
	}
});

// ── Disabled variants ─────────────────────────────────────────────────────

test("tasks-disabled settings reject task proposals and confirm without a task list", async () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "goal-draft-notasks-"));
	mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
	try {
		writeSettings(cwd, { disableTasks: true });
		const h = createHarness(cwd);
		await h.sessionStart();
		await h.commands.get("goal")!.handler("Write a guide", h.ctx);
		const withTasks = await runProposal(h, proposalParams("Write a guide.", { tasks: [{ id: "a", title: "A" }] }));
		assert.match(withTasks.content[0].text, /disabled by settings/);
		const ok = await runProposal(h, proposalParams("Write a guide."));
		assert.equal(activeGoalFiles(cwd).length, 1, "task-free proposal confirms");
		const goal = firstGoal(cwd);
		assert.equal(goal.taskList, undefined, "no task list created when tasks disabled");
	} finally {
		try { rmSync(cwd, { recursive: true, force: true }); } catch {}
	}
});

test("contracts-disabled settings strip the verification contract from a confirmed proposal", async () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "goal-draft-nocontract-"));
	mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
	try {
		writeSettings(cwd, { disableContracts: true });
		const h = createHarness(cwd);
		await h.sessionStart();
		await h.commands.get("goal")!.handler("Polish the docs", h.ctx);
		await runProposal(h, proposalParams("Polish the docs.\nVerification contract: Run npm test (0 failures)"));
		const goal = firstGoal(cwd);
		assert.equal(goal.verificationContract, undefined, "contract not persisted when contracts disabled");
		// The line is left as plain objective prose; it is never promoted to
		// the structured contract field.
		assert.ok(goal.objective.includes("Verification contract: Run npm test"), "contract line retained as prose");
	} finally {
		try { rmSync(cwd, { recursive: true, force: true }); } catch {}
	}
});

// ── /goal-tweak guided refinement ─────────────────────────────────────────

test("/goal-tweak confirms a revision under focus validation", async () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "goal-draft-tweak-"));
	mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
	try {
		const h = createHarness(cwd, { hasUI: true });
		await h.sessionStart();
		await h.commands.get("goal-direct")!.handler("Initial objective", h.ctx);
		const goalBefore = firstGoal(cwd);
		await h.commands.get("goal-tweak")!.handler("Make it better", h.ctx);
		const pending = runProposal(h, proposalParams("Revised objective with clarity.", { sisyphus: false }));
		h.dialogResult({ questions: [], answers: [{ id: "confirm", question: "Confirm Goal Draft", answer: CONFIRM_ANSWER, wasCustom: false }], cancelled: false });
		const result = await pending;
		assert.match(result.content[0].text, /tweak confirmed/);
		const goalAfter = parseGoalFile(path.join(cwd, ".pi", "goals", activeGoalFiles(cwd)[0]!))!;
		assert.equal(goalAfter.id, goalBefore.id, "same goal revised");
		assert.ok(goalAfter.objective.includes("Revised objective"), "objective updated");
		assert.ok(ledgerEvents(cwd).some((e) => e.type === "goal_tweaked"), "goal_tweaked event recorded");
		assert.equal(h.activeTools().includes("goal_questionnaire"), false, "tweak draft cleared after confirmation");
	} finally {
		try { rmSync(cwd, { recursive: true, force: true }); } catch {}
	}
});

test("tweak against a changed focus is rejected without mutation", async () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "goal-draft-tweakrace-"));
	mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
	try {
		const h = createHarness(cwd);
		await h.sessionStart();
		await h.commands.get("goal-direct")!.handler("Initial objective", h.ctx);
		const goalBefore = firstGoal(cwd);
		await h.commands.get("goal-tweak")!.handler("Revise it", h.ctx);
		await h.commands.get("goal-unfocus")!.handler("", h.ctx);
		const result = await runProposal(h, proposalParams("Changed objective", { sisyphus: false }));
		assert.match(result.content[0].text, /goal changed while drafting/);
		const goalAfter = parseGoalFile(path.join(cwd, ".pi", "goals", activeGoalFiles(cwd)[0]!))!;
		assert.equal(goalAfter.objective, goalBefore.objective, "no mutation on stale tweak target");
	} finally {
		try { rmSync(cwd, { recursive: true, force: true }); } catch {}
	}
});

// ── Headless semantics ────────────────────────────────────────────────────

test("headless proposal auto-confirm semantics are explicit", async () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "goal-draft-headless-"));
	mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
	try {
		// Headless with no override: proposal auto-confirms (harness-friendly).
		const h1 = createHarness(cwd);
		await h1.sessionStart();
		await h1.commands.get("goal")!.handler("One thing", h1.ctx);
		await runProposal(h1, proposalParams("One thing."));
		assert.equal(activeGoalFiles(cwd).length, 1, "headless auto-confirms by default");

		// Explicit opt-out keeps the draft pending and creates nothing.
		const h2 = createHarness(cwd);
		process.env.PI_GOAL_AUTO_CONFIRM = "0";
		try {
			await h2.sessionStart();
			await h2.commands.get("goal")!.handler("Another thing", h2.ctx);
			const result = await runProposal(h2, proposalParams("Another thing."));
			assert.match(result.content[0].text, /refinement requested/);
			assert.equal(activeGoalFiles(cwd).length, 1, "opt-out must not create a second goal");
		} finally {
			delete process.env.PI_GOAL_AUTO_CONFIRM;
		}

		// UI present + explicit override: confirm without the dialog.
		const h3 = createHarness(cwd, { hasUI: true });
		process.env.PI_GOAL_AUTO_CONFIRM = "1";
		try {
			await h3.sessionStart();
			await h3.commands.get("goal")!.handler("Third thing", h3.ctx);
			await runProposal(h3, proposalParams("Third thing."));
			assert.equal(h3.hasDialog(), false, "override confirms without opening the dialog");
			assert.equal(activeGoalFiles(cwd).length, 2);
		} finally {
			delete process.env.PI_GOAL_AUTO_CONFIRM;
		}
	} finally {
		try { rmSync(cwd, { recursive: true, force: true }); } catch {}
	}
});

// ── Questionnaire tools ───────────────────────────────────────────────────

test("questionnaire tools require an active draft and return structured answers", async () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "goal-draft-question-"));
	mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
	try {
		const h = createHarness(cwd, { hasUI: true });
		await h.sessionStart();
		const questionnaire = h.tools.get("goal_questionnaire");
		assert.ok(questionnaire, "goal_questionnaire registered");
		const noDraft = await questionnaire.execute("q-1", { questions: [] }, new AbortController().signal, undefined, h.ctx);
		assert.match(noDraft.content[0].text, /No guided goal draft is active/);
		await h.commands.get("goal")!.handler("Plan a migration", h.ctx);
		const pending = questionnaire.execute("q-2", {
			questions: [
				{ id: "scope", question: "Which systems?", options: ["A", "B"] },
				{ id: "deadline", question: "When?", options: [] },
			],
		}, new AbortController().signal, undefined, h.ctx);
		assert.ok(h.hasDialog(), "batch questionnaire opens the dialog");
		h.dialogResult({
			questions: [
				{ id: "scope", question: "Which systems?", options: ["A", "B"], allowCustom: true },
				{ id: "deadline", question: "When?", options: [], allowCustom: true },
			],
			answers: [
				{ id: "scope", question: "Which systems?", answer: "A", wasCustom: false },
				{ id: "deadline", question: "When?", answer: "Next week", wasCustom: true },
			],
			cancelled: false,
		});
		const result = await pending;
		assert.match(result.content[0].text, /\*\*Q:\*\* Which systems\?/);
		assert.match(result.content[0].text, /\*\*A:\*\* A/);
		assert.match(result.content[0].text, /\*\*A:\*\* Next week/);
	} finally {
		try { rmSync(cwd, { recursive: true, force: true }); } catch {}
	}
});

test("single dependent follow-up question returns a structured answer", async () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "goal-draft-singleq-"));
	mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
	try {
		const h = createHarness(cwd, { hasUI: true });
		await h.sessionStart();
		await h.commands.get("goal")!.handler("Automate deploys", h.ctx);
		const question = h.tools.get("goal_question");
		assert.ok(question, "goal_question registered");
		const pending = question.execute("q-1", { question: "Which environment first?", options: ["staging", "production"] }, new AbortController().signal, undefined, h.ctx);
		assert.ok(h.hasDialog(), "single question opens the dialog");
		h.dialogResult({
			questions: [{ id: "question", question: "Which environment first?", options: ["staging", "production"], allowCustom: true }],
			answers: [{ id: "question", question: "Which environment first?", answer: "staging", wasCustom: false }],
			cancelled: false,
		});
		const result = await pending;
		assert.match(result.content[0].text, /\*\*Q:\*\* Which environment first\?/);
		assert.match(result.content[0].text, /\*\*A:\*\* staging/);
	} finally {
		try { rmSync(cwd, { recursive: true, force: true }); } catch {}
	}
});
