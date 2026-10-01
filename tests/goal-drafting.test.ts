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
import { parseGoalFile, writeActiveGoalFile } from "../extensions/storage/goal-files.ts";
import { readGoalLedger } from "../extensions/goal-ledger.ts";
import { goalSettingsPath } from "../extensions/goal-settings.ts";
import { proposalText, DRAFT_ENTRY, type ActiveGoalDraft } from "../extensions/goal-drafting.ts";
import { createGoal, type GoalRecord } from "../extensions/goal-record.ts";
import { createMockTheme } from "./tui-test-utils.ts";

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
	selectResult(result: string | undefined): void;
	sessionStart(): Promise<void>;
	sessionTree(): Promise<void>;
	entries(): unknown[];
}

function createHarness(cwd: string, opts: { hasUI?: boolean } = {}): Harness {
	const handlers = new Map<string, Function>();
	const commands = new Map<string, any>();
	const notifications: string[] = [];
	const messages: string[] = [];
	const tools = new Map<string, any>();
	const toolHistory: string[][] = [];
	const entries: unknown[] = [];
	let activeTools = ["read", "bash", "edit", "write"];
	let dialogResolve: ((result: any) => void) | null = null;
	let hasDialogPending = false;
	let selectAnswer: string | undefined;
	const hasUI = opts.hasUI ?? false;
	const pi = {
		registerTool: (def: any) => { tools.set(def.name, def); },
		registerCommand: (name: string, def: any) => { commands.set(name, def); },
		on: (event: string, handler: Function) => { handlers.set(event, handler); },
		appendEntry: (customType: string, data: unknown) => { entries.push({ type: "custom", customType, data }); },
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
			getBranch: () => [...entries],
			getCwd: () => cwd,
			getSessionId: () => "draft-session",
			getRoot: () => cwd,
		},
		ui: {
			notify: (message: string) => { notifications.push(message); },
			setStatus: () => {},
			setWidget: () => {},
			onTerminalInput: () => () => {},
			select: async () => selectAnswer,
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
		selectResult: (result: string | undefined) => { selectAnswer = result; },
		sessionStart: async () => { await handlers.get("session_start")?.({ reason: "start" }, ctx); },
		sessionTree: async () => { await handlers.get("session_tree")?.({}, ctx); },
		entries: () => [...entries],
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
		assert.ok(tools.includes("create_goal") && tools.includes("get_goal") && !tools.includes("update_goal"), "unfocused execution profile restored");
		assert.equal(tools.includes("goal_questionnaire"), false, "drafting tools removed");
	} finally {
		try { rmSync(cwd, { recursive: true, force: true }); } catch {}
	}
});

test("regression: the proposal emits the complete goal presentation to the transcript before the dialog decision", async () => {
	// Reported repro: the goal draft was not presenting tasks. The complete
	// goal — every objective contract section and every task line — must be in
	// the terminal buffer while the confirmation dialog is open, so the user
	// can scroll up and read it ("the user can just scroll"). propose_goal_draft
	// renders this via renderCall, which pi displays in the transcript as soon
	// as the tool call starts — before the dialog opens.
	const cwd = mkdtempSync(path.join(tmpdir(), "goal-draft-present-"));
	mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
	try {
		const h = createHarness(cwd, { hasUI: true });
		await h.sessionStart();
		await h.commands.get("goal")!.handler("Present the complete goal in the confirmation dialog", h.ctx);
		const objective = [
			"=== Goal ===",
			"Objective: Fix the goal draft so the complete goal is presented.",
			"Success criteria: every section and every task line is readable.",
			"Boundaries: in scope: extensions; out of scope: pi-tui API changes.",
			"Constraints: the dialog frame never exceeds the terminal height.",
			"Verification contract: npm run check (0 errors); npm test (0 failures).",
			"If blocked: stop and ask the user.",
		].join("\n");
		const tasks = [
			{ id: "task-1", title: "Add the failing regression tests" },
			{ id: "task-2", title: "Fix the dialog slice" },
			{ id: "task-3", title: "Guarantee scrollback completeness" },
		];
		const params = proposalParams(objective, { tasks });
		const pending = runProposal(h, params);
		assert.ok(h.hasDialog(), "confirmation dialog must be open");

		// The tool-call renderer is what pi puts into the transcript while the
		// dialog is open; render it exactly as pi would at call time.
		const proposal = h.tools.get("propose_goal_draft");
		assert.ok(proposal, "propose_goal_draft must be registered during a draft");
		assert.ok(
			typeof proposal.renderCall === "function",
			"propose_goal_draft must render its complete presentation into the transcript (renderCall) before the dialog decision",
		);
		const theme = createMockTheme();
		const component = proposal.renderCall(params, theme, {});
		const rendered = (component as { render(w: number): string[] }).render(120).join("\n");
		for (const section of ["Objective: Fix the goal draft", "Success criteria:", "Boundaries:", "Constraints:", "Verification contract:", "If blocked:"]) {
			assert.ok(rendered.includes(section), `objective contract section must be in the transcript presentation: ${section}`);
		}
		assert.ok(rendered.includes("Tasks proposed for confirmation:"), "tasks header must be in the transcript presentation");
		for (const task of tasks) {
			assert.ok(rendered.includes(`[ ] ${task.id}: ${task.title}`), `task line must be in the transcript presentation: ${task.id}`);
		}

		h.dialogResult({ questions: [], answers: [{ id: "confirm", question: "Confirm Goal Draft", answer: CONTINUE_ANSWER, wasCustom: false }], cancelled: false });
		await pending;

		// Derived-task fallback: when the proposal carries no explicit task list,
		// the transcript presentation still shows the tasks derived from the
		// objective's ordered-step structure (F2), so the user can review them.
		const derivedObjective = "Present the complete goal.\n1. Add the failing regression tests.\n2. Fix the dialog slice.\n3. Guarantee scrollback completeness.";
		const pending2 = runProposal(h, proposalParams(derivedObjective));
		assert.ok(h.hasDialog(), "second confirmation dialog must be open");
		const proposal2 = h.tools.get("propose_goal_draft");
		const component2 = proposal2.renderCall(proposalParams(derivedObjective), theme, {});
		const rendered2 = (component2 as { render(w: number): string[] }).render(120).join("\n");
		assert.ok(rendered2.includes("Tasks derived from the objective"), "derived tasks header must be in the transcript presentation");
		for (const step of ["[ ] step-1: Add the failing regression tests", "[ ] step-2: Fix the dialog slice", "[ ] step-3: Guarantee scrollback completeness"]) {
			assert.ok(rendered2.includes(step), `derived task line must be in the transcript presentation: ${step}`);
		}
		h.dialogResult({ questions: [], answers: [{ id: "confirm", question: "Confirm Goal Draft", answer: CANCEL_ANSWER, wasCustom: false }], cancelled: false });
		await pending2;
	} finally {
		try { rmSync(cwd, { recursive: true, force: true }); } catch {}
	}
});

test("renderCall for a tweak without explicit tasks shows the retained current list, never a derived phantom", async () => {
	// §single-task-set regression: the scrollback presentation derived tasks
	// from the objective without knowing the draft mode, so a tweak without an
	// explicit task list showed a phantom "derived from the objective" set
	// that is never persisted (the apply retains the current list). The
	// presentation must mirror the dialog preview: the retained current list.
	const cwd = mkdtempSync(path.join(tmpdir(), "goal-draft-tweak-render-"));
	mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
	try {
		const h = createHarness(cwd, { hasUI: true });
		await h.sessionStart();
		await h.commands.get("goal")!.handler("Initial objective", h.ctx);
		const pending = runProposal(h, proposalParams("Initial objective.", {
			tasks: [{ id: "keep-1", title: "Retained task" }, { id: "keep-2", title: "Another task" }],
		}));
		h.dialogResult({ questions: [], answers: [{ id: "confirm", question: "Confirm Goal Draft", answer: CONFIRM_ANSWER, wasCustom: false }], cancelled: false });
		await pending;

		await h.commands.get("goal-tweak")!.handler("Tighten wording", h.ctx);
		const proposal = h.tools.get("propose_goal_draft");
		assert.ok(proposal, "propose_goal_draft registered during a tweak draft");
		const theme = createMockTheme();
		// A tweak proposal WITHOUT explicit tasks: the retained list is the one
		// task set that will be persisted.
		const component = proposal.renderCall(proposalParams("Tightened objective", { tasks: undefined }), theme, {});
		const rendered = (component as { render(w: number): string[] }).render(120).join("\n");
		assert.ok(rendered.includes("Current task list (retained unchanged):"), "retained list header shown in the scrollback presentation");
		assert.ok(rendered.includes("[ ] keep-1: Retained task"), "retained task line shown");
		assert.ok(rendered.includes("[ ] keep-2: Another task"), "second retained task line shown");
		assert.ok(!rendered.includes("Tasks derived from the objective"), "no derived phantom for a tweak");
		assert.ok(!rendered.includes("Tasks proposed for confirmation:"), "no explicit-tasks label without an explicit list");

		// The dialog preview agrees with the presentation (one task set).
		const pending2 = runProposal(h, proposalParams("Tightened objective"));
		h.dialogResult({ questions: [], answers: [{ id: "confirm", question: "Confirm Goal Draft", answer: CONFIRM_ANSWER, wasCustom: false }], cancelled: false });
		await pending2;
		const goal = firstGoal(cwd);
		assert.deepEqual(goal.taskList?.tasks.map((t) => t.id), ["keep-1", "keep-2"], "retained list persisted unchanged");
	} finally {
		try { rmSync(cwd, { recursive: true, force: true }); } catch {}
	}
});

test("renderCall for a new draft derives from the same objective text the apply path persists (shown == persisted)", async () => {
	// §single-task-set regression: the derived preview must equal the persisted
	// task list. The apply path derives from the extracted objective (the
	// Verification contract line removed); the presentation must derive from
	// the same input so the shown set is the persisted set.
	const cwd = mkdtempSync(path.join(tmpdir(), "goal-draft-derived-equal- "));
	mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
	try {
		const h = createHarness(cwd, { hasUI: true });
		await h.sessionStart();
		await h.commands.get("goal")!.handler("Ship the release", h.ctx);
		const objective = "Ship the release.\n1) Implement core\n2) Add tests\n3) Write docs\nVerification contract: npm test (0 failures).";
		const pending = runProposal(h, proposalParams(objective));
		const proposal = h.tools.get("propose_goal_draft");
		const theme = createMockTheme();
		const component = proposal.renderCall(proposalParams(objective), theme, {});
		const presented = (component as { render(w: number): string[] }).render(120).join("\n");
		assert.ok(presented.includes("Tasks derived from the objective"), "derived preview shown for a structured new draft");

		h.dialogResult({ questions: [], answers: [{ id: "confirm", question: "Confirm Goal Draft", answer: CONFIRM_ANSWER, wasCustom: false }], cancelled: false });
		await pending;
		const goal = firstGoal(cwd);
		assert.ok(goal.verificationContract?.includes("npm test"), "verification contract persisted");
		const persistedIds = goal.taskList?.tasks.map((t) => t.id) ?? [];
		for (const id of ["step-1", "step-2", "step-3"]) {
			assert.ok(persistedIds.includes(id), `persisted derived task ${id}`);
			assert.ok(presented.includes(`[ ] ${id}: `), `presented derived task ${id} matches persisted`);
		}
		assert.equal(persistedIds.length, 3, "no phantom task from the contract line");
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

// ── Budget provenance ─────────────────────────────────────────────────────

test("an unrequested token budget is never created: no guideline invites one, and omitting it stores no budget", async () => {
	// A drafted goal must carry no token budget unless the user explicitly asked
	// for one. Two independent guards are asserted here:
	//   1. the tool's promptGuidelines tell the model to omit token_budget unless
	//      the user asked, so the model does not invent one from objective size;
	//   2. omitting token_budget persists a goal with no budget at all.
	// Budgets stay an opt-in, user-supplied lever (see the budget provenance
	// note in specs/2026-10-01-pi-1-0-0-compatibility/MILESTONES.md).
	const cwd = mkdtempSync(path.join(tmpdir(), "goal-draft-no-budget-"));
	mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
	try {
		const h = createHarness(cwd, { hasUI: true });
		await h.sessionStart();
		await h.commands.get("goal")!.handler("Add search", h.ctx);

		const proposal = h.tools.get("propose_goal_draft");
		assert.ok(proposal, "propose_goal_draft must be registered during a draft");
		const guidelines: string[] = proposal.promptGuidelines ?? [];
		const budgetGuideline = guidelines.find((line) => /token_budget/i.test(line));
		assert.ok(budgetGuideline, "propose_goal_draft must carry a token_budget prompt guideline");
		assert.match(budgetGuideline, /only when the user explicitly asked/i, "guideline must scope budgets to explicit user requests");
		assert.match(budgetGuideline, /never invent|never.*infer/i, "guideline must forbid inventing a budget");

		// A large-sounding objective with no budget request must stay budgetless.
		const objective = "Rewrite the entire scheduling subsystem.\nSuccess criteria: behavior is preserved.";
		const pending = runProposal(h, proposalParams(objective));
		h.dialogResult({ questions: [], answers: [{ id: "confirm", question: "Confirm Goal Draft", answer: CONFIRM_ANSWER, wasCustom: false }], cancelled: false });
		await pending;

		const goal = firstGoal(cwd);
		assert.equal(goal.tokenBudget, undefined, "no budget is persisted when the user did not request one");
		const warnings = ledgerEvents(cwd).filter((e) => e.type === "goal_budget_warning" || e.type === "goal_budget_limited");
		assert.deepEqual(warnings, [], "no budget lifecycle events for an unbudgeted goal");
		assert.notEqual(goal.status, "budget_limited", "an unbudgeted goal is never budget_limited");
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

// ── Stage 5.1-A: durable draft state and /goal-cancel ─────────────────────

test("/goal-cancel clears the draft as a durable no-op", async () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "goal-draft-cancelcmd-"));
	mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
	try {
		const h = createHarness(cwd);
		await h.sessionStart();
		await h.commands.get("goal")!.handler("Build the widget", h.ctx);
		assert.ok(h.activeTools().includes("goal_questionnaire"), "drafting profile installed");
		await h.commands.get("goal-cancel")!.handler("", h.ctx);
		assert.equal(activeGoalFiles(cwd).length, 0, "cancel writes no goal file");
		assert.deepEqual(ledgerEvents(cwd).filter((e) => e.type === "goal_created"), [], "cancel writes no ledger event");
		const tools = h.activeTools();
		assert.ok(tools.includes("create_goal") && tools.includes("get_goal") && !tools.includes("update_goal"), "unfocused execution profile restored");
		assert.equal(tools.includes("goal_questionnaire"), false, "drafting tools removed");
		assert.ok(h.notifications.some((n) => n.includes("Draft cancelled")), "cancel notification");
		// The durable entry is tombstoned, not removed.
		const draftEntries = h.entries().filter((e: any) => e.customType === "pi-goal-draft");
		assert.equal(draftEntries.length, 2, "start entry plus tombstone");
		assert.ok((draftEntries[1] as any).data.clearedAt, "tombstone carries clearedAt");
		// A second cancel is a no-op with guidance.
		await h.commands.get("goal-cancel")!.handler("", h.ctx);
		assert.ok(h.notifications.some((n) => n.includes("No active draft")), "second cancel guidance");
	} finally {
		try { rmSync(cwd, { recursive: true, force: true }); } catch {}
	}
});

test("an unconfirmed draft survives session_tree rehydration", async () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "goal-draft-rehydrate-"));
	mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
	try {
		const h = createHarness(cwd);
		await h.sessionStart();
		await h.commands.get("goal")!.handler("Migrate the database", h.ctx);
		// Tree navigation reloads state; the durable draft must come back.
		await h.sessionTree();
		assert.ok(h.activeTools().includes("goal_questionnaire"), "drafting profile restored after rehydration");
		assert.ok(h.activeTools().includes("propose_goal_draft"), "proposal tool restored");
		// And the restored draft still confirms atomically.
		await runProposal(h, proposalParams("Migrate the database.\nSuccess criteria: no data loss."));
		const goal = firstGoal(cwd);
		assert.ok(goal.objective.includes("Migrate the database"), "restored draft confirms");
		// After confirmation the draft is gone and stays gone across rehydration.
		await h.sessionTree();
		const tools = h.activeTools();
		assert.ok(tools.includes("update_goal"), "execution profile after confirm");
		assert.equal(tools.includes("goal_questionnaire"), false, "no draft restored after confirm");
	} finally {
		try { rmSync(cwd, { recursive: true, force: true }); } catch {}
	}
});

test("a second draft offers resume, replace, or cancel and never silently discards", async () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "goal-draft-second-"));
	mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
	try {
		// Resume keeps the first draft.
		const h1 = createHarness(cwd, { hasUI: true });
		await h1.sessionStart();
		await h1.commands.get("goal")!.handler("First topic", h1.ctx);
		const firstPromptCount = h1.messages.length;
		h1.selectResult("Resume the existing draft");
		await h1.commands.get("goal")!.handler("Second topic", h1.ctx);
		assert.equal(h1.messages.length, firstPromptCount, "no new draft prompt when resuming");
		assert.ok(h1.notifications.some((n) => n.includes("already active; resuming")), "resume notification");
		assert.ok(h1.activeTools().includes("goal_questionnaire"), "first draft still active");

		// Cancel keeps the first draft.
		h1.selectResult("Cancel");
		await h1.commands.get("goal")!.handler("Third topic", h1.ctx);
		assert.equal(h1.messages.length, firstPromptCount, "no new prompt when cancelling");
		assert.ok(h1.notifications.some((n) => n.includes("existing draft stays active")), "cancel notification");

		// Replace starts the new draft and tombstones the old one.
		h1.selectResult("Replace it with a new draft");
		await h1.commands.get("goal")!.handler("Fourth topic", h1.ctx);
		assert.ok(h1.messages.length > firstPromptCount, "replacement starts a fresh draft");
		assert.ok(h1.notifications.some((n) => n.includes("Replacing the active draft")), "replacement notification");
		const draftEntries = h1.entries().filter((e: any) => e.customType === "pi-goal-draft");
		const tombstones = draftEntries.filter((e: any) => e.data.clearedAt);
		assert.equal(tombstones.length, 1, "the replaced draft is tombstoned");
		const last = draftEntries[draftEntries.length - 1] as any;
		assert.equal(last.data.clearedAt, undefined, "the newest entry is the replacement start, not a tombstone");

		// Headless: a second draft replaces with an explicit warning (not silent).
		const h2 = createHarness(cwd);
		await h2.sessionStart();
		await h2.commands.get("goal")!.handler("Headless one", h2.ctx);
		const before = h2.messages.length;
		await h2.commands.get("goal")!.handler("Headless two", h2.ctx);
		assert.ok(h2.messages.length > before, "headless second draft proceeds");
		assert.ok(h2.notifications.some((n) => n.includes("Replacing the active draft")), "headless replacement is not silent");
	} finally {
		try { rmSync(cwd, { recursive: true, force: true }); } catch {}
	}
});

test("a stale tweak draft is invalidated on rehydration when its target is unfocused", async () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "goal-draft-staletweak-"));
	mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
	try {
		const h = createHarness(cwd);
		await h.sessionStart();
		await h.commands.get("goal-direct")!.handler("Initial objective", h.ctx);
		await h.commands.get("goal-tweak")!.handler("Revise it", h.ctx);
		await h.commands.get("goal-unfocus")!.handler("", h.ctx);
		await h.sessionTree();
		const tools = h.activeTools();
		assert.ok(tools.includes("create_goal") && tools.includes("get_goal") && !tools.includes("update_goal"), "unfocused execution profile after stale tweak invalidation");
		assert.equal(tools.includes("goal_questionnaire"), false, "stale tweak draft not restored");
		assert.ok(h.notifications.some((n) => n.includes("stale")), "stale draft warning");
		// The stale tweak draft cannot confirm anything.
		const result = await runProposal(h, proposalParams("Changed objective", { sisyphus: false }));
		assert.match(result.content[0].text, /No guided goal draft is active/);
	} finally {
		try { rmSync(cwd, { recursive: true, force: true }); } catch {}
	}
});

test("direct goal creation interrupts and clears an active draft", async () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "goal-draft-interrupt-"));
	mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
	try {
		const h = createHarness(cwd);
		await h.sessionStart();
		await h.commands.get("goal")!.handler("Drafted topic", h.ctx);
		assert.ok(h.activeTools().includes("goal_questionnaire"), "drafting active");
		await h.commands.get("goal-direct")!.handler("Immediate goal", h.ctx);
		const files = activeGoalFiles(cwd);
		assert.equal(files.length, 1, "direct creation proceeds");
		const tools = h.activeTools();
		assert.ok(tools.includes("update_goal"), "active execution profile restored after direct creation");
		assert.equal(tools.includes("goal_questionnaire"), false, "draft cleared by direct creation");
		// The tombstoned draft must not resurrect across rehydration.
		await h.sessionTree();
		assert.equal(h.activeTools().includes("goal_questionnaire"), false, "draft stays cleared after rehydration");
	} finally {
		try { rmSync(cwd, { recursive: true, force: true }); } catch {}
	}
});

// ── Stage 5.1-B: /goal-status and per-draft auditor selection ─────────────

test("/goal-status reports state without initiating drafting", async () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "goal-status-"));
	mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
	try {
		const h = createHarness(cwd);
		await h.sessionStart();
		await h.commands.get("goal-direct")!.handler("Status target", h.ctx);
		const messagesBefore = h.messages.length;
		await h.commands.get("goal-status")!.handler("", h.ctx);
		assert.equal(h.messages.length, messagesBefore, "status must not initiate a draft or agent turn");
		assert.ok(h.notifications.some((n) => n.includes("Status target")), "focused goal reported");
		assert.equal(h.activeTools().includes("goal_questionnaire"), false, "no drafting profile");
		// Unfocused with open goals: reports the pool without mutating.
		await h.commands.get("goal-unfocus")!.handler("", h.ctx);
		await h.commands.get("goal-status")!.handler("", h.ctx);
		assert.ok(h.notifications.some((n) => n.includes("open goal") && n.includes("/goal-focus")), "unfocused panel reported");
	} finally {
		try { rmSync(cwd, { recursive: true, force: true }); } catch {}
	}
});

test("the auditor choice persists on create and through continue refining", async () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "goal-auditor-create-"));
	mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
	try {
		const h = createHarness(cwd, { hasUI: true });
		await h.sessionStart();
		await h.commands.get("goal")!.handler("Audited work", h.ctx);

		// First proposal: user disables the auditor but keeps refining.
		const p1 = runProposal(h, proposalParams("Audited work.\nSuccess criteria: done."));
		h.dialogResult({ questions: [], answers: [{ id: "confirm", question: "Confirm Goal Draft", answer: CONTINUE_ANSWER, wasCustom: false }], cancelled: false, auditorEnabled: false });
		await p1;
		assert.equal(activeGoalFiles(cwd).length, 0, "no goal while refining");
		// The choice is preserved in the durable session entry.
		const draftEntries = h.entries().filter((e: any) => e.customType === "pi-goal-draft");
		const latest = draftEntries[draftEntries.length - 1] as any;
		assert.equal(latest.data.auditorEnabled, false, "auditor choice preserved through continue");

		// Second proposal: confirm with the same (disabled) auditor choice.
		const p2 = runProposal(h, proposalParams("Audited work.\nSuccess criteria: done."));
		h.dialogResult({ questions: [], answers: [{ id: "confirm", question: "Confirm Goal Draft", answer: CONFIRM_ANSWER, wasCustom: false }], cancelled: false, auditorEnabled: false });
		await p2;
		const goal = firstGoal(cwd);
		assert.equal(goal.skipAuditor, true, "skipAuditor persisted on create");

		// A third goal created with the auditor enabled has no skipAuditor.
		await h.commands.get("goal")!.handler("Enabled work", h.ctx);
		const p3 = runProposal(h, proposalParams("Enabled work."));
		h.dialogResult({ questions: [], answers: [{ id: "confirm", question: "Confirm Goal Draft", answer: CONFIRM_ANSWER, wasCustom: false }], cancelled: false, auditorEnabled: true });
		await p3;
		const goals = activeGoalFiles(cwd).map((f) => parseGoalFile(path.join(cwd, ".pi", "goals", f))!);
		const enabled = goals.find((g) => g.objective.includes("Enabled work"))!;
		assert.equal(enabled.skipAuditor, undefined, "auditor enabled means no skipAuditor");
	} finally {
		try { rmSync(cwd, { recursive: true, force: true }); } catch {}
	}
});

test("headless confirmation uses effective settings for the auditor", async () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "goal-auditor-headless-"));
	mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
	try {
		// Default settings: auditor enabled.
		const h1 = createHarness(cwd);
		await h1.sessionStart();
		await h1.commands.get("goal")!.handler("Headless audited", h1.ctx);
		await runProposal(h1, proposalParams("Headless audited."));
		const g1 = firstGoal(cwd);
		assert.equal(g1.skipAuditor, undefined, "auditor enabled by default in headless");

		// settings.disabled: auditor off at draft start.
		writeSettings(cwd, { disabled: true });
		const h2 = createHarness(cwd);
		await h2.sessionStart();
		await h2.commands.get("goal")!.handler("Headless unaudited", h2.ctx);
		await runProposal(h2, proposalParams("Headless unaudited."));
		const goals = activeGoalFiles(cwd).map((f) => parseGoalFile(path.join(cwd, ".pi", "goals", f))!);
		const g2 = goals.find((g) => g.objective.includes("Headless unaudited"))!;
		assert.equal(g2.skipAuditor, true, "disabled settings default the auditor off");
	} finally {
		try { rmSync(cwd, { recursive: true, force: true }); } catch {}
	}
});

test("a tweak confirmation persists the auditor choice in the same transaction", async () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "goal-auditor-tweak-"));
	mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
	try {
		const h = createHarness(cwd, { hasUI: true });
		await h.sessionStart();
		await h.commands.get("goal-direct")!.handler("Initial objective", h.ctx);
		const before = firstGoal(cwd);
		assert.equal(before.skipAuditor, undefined);
		await h.commands.get("goal-tweak")!.handler("Revise the scope", h.ctx);
		const pending = runProposal(h, proposalParams("Revised objective", { sisyphus: false }));
		h.dialogResult({ questions: [], answers: [{ id: "confirm", question: "Confirm Goal Draft", answer: CONFIRM_ANSWER, wasCustom: false }], cancelled: false, auditorEnabled: false });
		await pending;
		const after = firstGoal(cwd);
		assert.equal(after.id, before.id, "same goal");
		assert.ok(after.objective.includes("Revised objective"), "objective updated");
		assert.equal(after.skipAuditor, true, "skipAuditor mutated in the tweak transaction");
		assert.ok(ledgerEvents(cwd).some((e) => e.type === "goal_tweaked"), "tweak recorded");
	} finally {
		try { rmSync(cwd, { recursive: true, force: true }); } catch {}
	}
});

// ── §tweak-resume: a confirmed tweak revives a stalled goal ──────────────

test("a tweak confirmation resumes a paused goal (active, pause metadata cleared, goal_resumed event)", async () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "goal-tweak-resume-paused-"));
	mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
	try {
		const h = createHarness(cwd, { hasUI: true });
		await h.sessionStart();
		await h.commands.get("goal-direct")!.handler("Initial objective", h.ctx);
		await h.commands.get("goal-pause")!.handler("", h.ctx);
		const paused = firstGoal(cwd);
		assert.equal(paused.status, "paused", "goal paused before the tweak");
		assert.equal(paused.stopReason, "user", "pause records the stop reason");
		await h.commands.get("goal-tweak")!.handler("Revise scope", h.ctx);
		const pending = runProposal(h, proposalParams("Revised objective after pause", { sisyphus: false }));
		h.dialogResult({ questions: [], answers: [{ id: "confirm", question: "Confirm Goal Draft", answer: CONFIRM_ANSWER, wasCustom: false }], cancelled: false });
		const result = await pending;
		assert.match(result.content[0].text, /tweak confirmed/);
		const after = firstGoal(cwd);
		assert.equal(after.id, paused.id, "same goal revised");
		assert.equal(after.status, "active", "paused goal resumed by the tweak");
		assert.equal(after.autoContinue, true, "resume re-arms auto-continuation");
		assert.equal(after.stopReason, undefined, "stopReason cleared");
		assert.equal(after.pauseReason, undefined, "pauseReason cleared");
		assert.equal(after.pauseSuggestedAction, undefined, "pauseSuggestedAction cleared");
		assert.ok(after.objective.includes("Revised objective after pause"), "objective updated");
		const events = ledgerEvents(cwd);
		assert.ok(events.some((e) => e.type === "goal_tweaked"), "goal_tweaked recorded");
		const resumed = events.filter((e) => e.type === "goal_resumed");
		assert.equal(resumed.length, 1, "exactly one goal_resumed event");
		assert.equal((resumed[0] as any).reason, "tweak", "resume reason is the tweak");
		assert.equal(h.activeTools().includes("goal_questionnaire"), false, "tweak draft cleared after confirmation");
	} finally {
		try { rmSync(cwd, { recursive: true, force: true }); } catch {}
	}
});

test("a tweak confirmation resumes a blocked goal", async () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "goal-tweak-resume-blocked-"));
	mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
	try {
		const h = createHarness(cwd, { hasUI: true });
		await h.sessionStart();
		await h.commands.get("goal-direct")!.handler("Initial objective", h.ctx);
		const update = h.tools.get("update_goal")!;
		const blockedResult = await (update.execute as any)("update-b", { status: "blocked", reason: "test blocker" }, undefined, undefined, h.ctx);
		assert.ok(blockedResult?.terminate === true, "blocked terminates the turn");
		assert.equal(firstGoal(cwd).status, "blocked", "goal blocked before the tweak");
		await h.commands.get("goal-tweak")!.handler("Revise scope", h.ctx);
		const pending = runProposal(h, proposalParams("Revised objective after block", { sisyphus: false }));
		h.dialogResult({ questions: [], answers: [{ id: "confirm", question: "Confirm Goal Draft", answer: CONFIRM_ANSWER, wasCustom: false }], cancelled: false });
		await pending;
		const after = firstGoal(cwd);
		assert.equal(after.status, "active", "blocked goal resumed by the tweak");
		assert.equal(after.autoContinue, true, "resume re-arms auto-continuation");
		assert.equal(after.stopReason, undefined, "stopReason cleared");
		const resumed = ledgerEvents(cwd).filter((e) => e.type === "goal_resumed");
		assert.equal(resumed.length, 1, "exactly one goal_resumed event");
		assert.equal((resumed[0] as any).reason, "tweak", "resume reason is the tweak");
	} finally {
		try { rmSync(cwd, { recursive: true, force: true }); } catch {}
	}
});

test("a tweak confirmation leaves a budget_limited goal behind its hard budget gate", async () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "goal-tweak-resume-budget-"));
	mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
	try {
		const seeded = { ...createGoal({ objective: "Seed budget-limited objective", autoContinue: true, sisyphus: false }), status: "budget_limited" as const };
		writeActiveGoalFile({ cwd }, seeded);
		const h = createHarness(cwd, { hasUI: true });
		await h.sessionStart();
		assert.equal(firstGoal(cwd).status, "budget_limited", "seeded budget_limited goal focused");
		await h.commands.get("goal-tweak")!.handler("Revise scope", h.ctx);
		const pending = runProposal(h, proposalParams("Revised while budget-limited", { sisyphus: false }));
		h.dialogResult({ questions: [], answers: [{ id: "confirm", question: "Confirm Goal Draft", answer: CONFIRM_ANSWER, wasCustom: false }], cancelled: false });
		await pending;
		const after = firstGoal(cwd);
		assert.equal(after.status, "budget_limited", "budget_limited is a hard gate: the tweak must not resume it");
		assert.ok(after.objective.includes("Revised while budget-limited"), "objective still revised");
		assert.equal(ledgerEvents(cwd).filter((e) => e.type === "goal_resumed").length, 0, "no resume event for a budget_limited goal");
	} finally {
		try { rmSync(cwd, { recursive: true, force: true }); } catch {}
	}
});

test("a tweak confirmation on an active goal stays active without a resume event", async () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "goal-tweak-resume-active-"));
	mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
	try {
		const h = createHarness(cwd, { hasUI: true });
		await h.sessionStart();
		await h.commands.get("goal-direct")!.handler("Initial objective", h.ctx);
		await h.commands.get("goal-tweak")!.handler("Revise scope", h.ctx);
		const pending = runProposal(h, proposalParams("Revised while active", { sisyphus: false }));
		h.dialogResult({ questions: [], answers: [{ id: "confirm", question: "Confirm Goal Draft", answer: CONFIRM_ANSWER, wasCustom: false }], cancelled: false });
		await pending;
		const after = firstGoal(cwd);
		assert.equal(after.status, "active", "active goal stays active");
		assert.equal(ledgerEvents(cwd).filter((e) => e.type === "goal_resumed").length, 0, "no resume event when the goal was already active");
	} finally {
		try { rmSync(cwd, { recursive: true, force: true }); } catch {}
	}
});

// ── §tweak-persist: the auditor toggle defaults to the goal's own setting ─

test("tweak drafting defaults the auditor toggle to the goal's persisted skipAuditor", async () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "goal-tweak-auditor-default-off-"));
	mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
	try {
		const seeded = createGoal({ objective: "Auditor-off seed objective", autoContinue: true, sisyphus: false, skipAuditor: true });
		writeActiveGoalFile({ cwd }, seeded);
		const h = createHarness(cwd, { hasUI: true });
		await h.sessionStart();
		await h.commands.get("goal-tweak")!.handler("Revise scope", h.ctx);
		const drafts = h.entries().filter((e) => (e as any).customType === DRAFT_ENTRY);
		assert.ok(drafts.length > 0, "draft session entry recorded");
		const last = drafts[drafts.length - 1] as any;
		assert.equal(last?.data?.auditorEnabled, false, "tweak draft defaults to the goal's persisted auditor-off setting");
	} finally {
		try { rmSync(cwd, { recursive: true, force: true }); } catch {}
	}
});

test("tweak drafting defaults the auditor toggle on when the goal has no per-goal setting", async () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "goal-tweak-auditor-default-on-"));
	mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
	try {
		const h = createHarness(cwd, { hasUI: true });
		await h.sessionStart();
		await h.commands.get("goal-direct")!.handler("Initial objective", h.ctx);
		await h.commands.get("goal-tweak")!.handler("Revise scope", h.ctx);
		const drafts = h.entries().filter((e) => (e as any).customType === DRAFT_ENTRY);
		const last = drafts[drafts.length - 1] as any;
		assert.equal(last?.data?.auditorEnabled, true, "tweak draft defaults the auditor on without a per-goal or global disable");
	} finally {
		try { rmSync(cwd, { recursive: true, force: true }); } catch {}
	}
});

test("tweak drafting falls back to global settings when the goal has no per-goal auditor setting", async () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "goal-tweak-auditor-global-fallback-"));
	mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
	try {
		writeSettings(cwd, { disabled: true });
		const h = createHarness(cwd, { hasUI: true });
		await h.sessionStart();
		await h.commands.get("goal-direct")!.handler("Initial objective", h.ctx);
		await h.commands.get("goal-tweak")!.handler("Revise scope", h.ctx);
		const drafts = h.entries().filter((e) => (e as any).customType === DRAFT_ENTRY);
		const last = drafts[drafts.length - 1] as any;
		assert.equal(last?.data?.auditorEnabled, false, "tweak draft falls back to the global auditor-disabled setting");
	} finally {
		try { rmSync(cwd, { recursive: true, force: true }); } catch {}
	}
});

// ── §objective-limit: the objective length limit is a configurable setting ─

test("propose_goal_draft accepts long objectives by default (no hard 4000 limit)", async () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "goal-draft-long-objective-"));
	mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
	try {
		const h = createHarness(cwd, { hasUI: true });
		await h.sessionStart();
		await h.commands.get("goal-direct")!.handler("Initial objective", h.ctx);
		await h.commands.get("goal-tweak")!.handler("Revise scope", h.ctx);
		const long = "x".repeat(5000);
		const pending = runProposal(h, proposalParams(long, { sisyphus: false }));
		h.dialogResult({ questions: [], answers: [{ id: "confirm", question: "Confirm Goal Draft", answer: CONFIRM_ANSWER, wasCustom: false }], cancelled: false });
		const result = await pending;
		assert.match(result.content[0].text, /tweak confirmed/);
		assert.equal(firstGoal(cwd).objective.length, long.length, "long objective survives without a configured limit");
	} finally {
		try { rmSync(cwd, { recursive: true, force: true }); } catch {}
	}
});

test("propose_goal_draft enforces the configured max objective length setting", async () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "goal-draft-limit-"));
	mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
	try {
		writeSettings(cwd, { objectiveMaxChars: 20 });
		const h = createHarness(cwd, { hasUI: true });
		await h.sessionStart();
		await h.commands.get("goal-direct")!.handler("Initial objective", h.ctx);
		await h.commands.get("goal-tweak")!.handler("Revise scope", h.ctx);
		const pending = runProposal(h, proposalParams("x".repeat(21), { sisyphus: false }));
		const result = await pending;
		assert.match(result.content[0].text, /at most 20 characters \(21 given\)/);
		assert.equal(firstGoal(cwd).objective, "Initial objective", "oversized proposal must not mutate the goal");
		// An at-limit objective is accepted.
		const okPending = runProposal(h, proposalParams("y".repeat(20), { sisyphus: false }));
		h.dialogResult({ questions: [], answers: [{ id: "confirm", question: "Confirm Goal Draft", answer: CONFIRM_ANSWER, wasCustom: false }], cancelled: false });
		const ok = await okPending;
		assert.match(ok.content[0].text, /tweak confirmed/);
		assert.equal(firstGoal(cwd).objective.length, 20, "at-limit objective is accepted");
	} finally {
		try { rmSync(cwd, { recursive: true, force: true }); } catch {}
	}
});

test("/goal-tweak command rejects an oversized replacement per the configured limit", async () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "goal-tweak-limit-"));
	mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
	try {
		writeSettings(cwd, { objectiveMaxChars: 30 });
		const h = createHarness(cwd, { hasUI: true });
		await h.sessionStart();
		await h.commands.get("goal-direct")!.handler("Initial objective", h.ctx);
		await h.commands.get("goal-tweak")!.handler("x".repeat(31), h.ctx);
		assert.equal(h.activeTools().includes("goal_questionnaire"), false, "no draft starts for an oversized replacement");
		assert.equal(firstGoal(cwd).objective, "Initial objective", "goal unchanged");
	} finally {
		try { rmSync(cwd, { recursive: true, force: true }); } catch {}
	}
});

// ── §14 durable proposal summary and confirmation polish ──────────────────

test("confirmed proposal writes the durable summary and the richer confirmation report", async () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "goal-draft-summary-"));
	mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
	try {
		const h = createHarness(cwd, { hasUI: true });
		await h.sessionStart();
		await h.commands.get("goal")!.handler("Add CSV export", h.ctx);
		const objective = "Add CSV export to the reports page.\nSuccess criteria: exports use active filters.\nVerification contract: Run npm test (0 failures)";
		const tasks = [
			{ id: "review", title: "Review the reports page and data source" },
			{ id: "export", title: "Implement filtered CSV export" },
			{ id: "download", title: "Add the download control" },
		];
		const pending = runProposal(h, proposalParams(objective, { tasks }));
		h.dialogResult({ questions: [], answers: [{ id: "confirm", question: "Confirm Goal Draft", answer: CONFIRM_ANSWER, wasCustom: false }], cancelled: false });
		const result = await pending;
		const text = result.content[0].text;
		// Durable proposal summary in the transcript (§14).
		assert.match(text, /Proposed objective:/);
		assert.match(text, /Add CSV export to the reports page\./);
		assert.match(text, /Proposed plan:/);
		assert.match(text, /1\. Review the reports page and data source/);
		assert.match(text, /2\. Implement filtered CSV export/);
		assert.match(text, /Verification:/);
		assert.match(text, /Run npm test \(0 failures\)/);
		assert.match(text, /Automatic continuation: enabled/);
		assert.match(text, /Independent auditor: enabled/);
		// Richer confirmation output (§14).
		assert.match(text, /✓ Goal created and focused\./);
		assert.match(text, /Continuing automatically with the confirmed plan\./);
		assert.match(text, /Goal id: /);
		assert.match(text, /File: \.pi\/goals\/active_goal_/);
		assert.match(text, /Tasks: 3/);
		assert.match(text, /Verification: Run npm test \(0 failures\)/);
		assert.match(text, /Auditor: enabled/);
	} finally {
		try { rmSync(cwd, { recursive: true, force: true }); } catch {}
	}
});

test("questionnaire answers are captured in the confirmed-goal report (E5 §14)", async () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "goal-draft-qa-echo-"));
	mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
	try {
		const h = createHarness(cwd, { hasUI: true });
		await h.sessionStart();
		await h.commands.get("goal")!.handler("Scope the migration", h.ctx);
		const questionnaire = h.tools.get("goal_questionnaire");
		const pendingQ = questionnaire.execute("q-echo", {
			questions: [{ id: "scope", question: "Which systems?", options: ["A", "B"] }],
		}, new AbortController().signal, undefined, h.ctx);
		assert.ok(h.hasDialog());
		h.dialogResult({
			questions: [{ id: "scope", question: "Which systems?", options: ["A", "B"], allowCustom: true }],
			answers: [{ id: "scope", question: "Which systems?", answer: "A", wasCustom: false }],
			cancelled: false,
		});
		await pendingQ;
		const pending = runProposal(h, proposalParams("Migrate systems A.\nSuccess criteria: all services moved."));
		h.dialogResult({ questions: [], answers: [{ id: "confirm", question: "Confirm Goal Draft", answer: CONFIRM_ANSWER, wasCustom: false }], cancelled: false });
		const result = await pending;
		// The Q&A echo survives draft clearing and appears in the report.
		assert.match(result.content[0].text, /Which systems\?/);
		assert.match(result.content[0].text, /A/);
	} finally {
		try { rmSync(cwd, { recursive: true, force: true }); } catch {}
	}
});

test("cancel and refine outcomes still carry the durable proposal summary", async () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "goal-draft-summary-cancel-"));
	mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
	try {
		const h = createHarness(cwd, { hasUI: true });
		await h.sessionStart();
		await h.commands.get("goal")!.handler("Ship a feature", h.ctx);
		// Cancel carries the summary.
		const pendingCancel = runProposal(h, proposalParams("Ship a feature.\nSuccess criteria: tests pass."));
		h.dialogResult({ questions: [], answers: [{ id: "confirm", question: "Confirm Goal Draft", answer: CANCEL_ANSWER, wasCustom: false }], cancelled: false });
		const cancelled = await pendingCancel;
		assert.match(cancelled.content[0].text, /Proposed objective:/);
		assert.match(cancelled.content[0].text, /Draft cancelled/);
		assert.equal(activeGoalFiles(cwd).length, 0, "cancel must not create a goal");
		// Refine carries the summary and keeps the draft.
		await h.commands.get("goal")!.handler("Ship a feature", h.ctx);
		const pendingRefine = runProposal(h, proposalParams("Ship a feature.\nSuccess criteria: tests pass."));
		h.dialogResult({ questions: [], answers: [{ id: "confirm", question: "Confirm Goal Draft", answer: CONTINUE_ANSWER, wasCustom: false }], cancelled: false });
		const refined = await pendingRefine;
		assert.match(refined.content[0].text, /Proposed objective:/);
		assert.match(refined.content[0].text, /Automatic continuation: enabled/);
		assert.match(refined.content[0].text, /refinement requested/);
		assert.equal(activeGoalFiles(cwd).length, 0, "refining must not create a goal");
	} finally {
		try { rmSync(cwd, { recursive: true, force: true }); } catch {}
	}
});

// ── F2 regression: proposals always show the task list exactly once ──────

function testDraft(mode: ActiveGoalDraft["mode"], originalTopic: string): ActiveGoalDraft {
	return { mode, originalTopic, startedAt: "2026-08-05T00:00:00.000Z", auditorEnabled: true };
}

function taskList(tasks: Array<{ id: string; title: string; status?: string }>) {
	return {
		tasks: tasks.map((t) => ({ id: t.id, title: t.title, status: (t.status ?? "pending") as "pending" })),
		blockCompletion: false,
		proposedAt: "2026-08-05T00:00:00.000Z",
	};
}

function currentGoal(objective: string, tasks: Array<{ id: string; title: string; status?: string }>): GoalRecord {
	return {
		id: "g1",
		objective,
		status: "active",
		autoContinue: true,
		sisyphus: false,
		taskList: taskList(tasks),
	} as unknown as GoalRecord;
}

test("a numbered-step objective with no explicit tasks previews the derived task list in the confirmation", () => {
	// Regression: the F2 preview derived from the boxed confirmation text
	// (every line prefixed with "│   ") so the ordered-marker regex never
	// matched and numbered objectives showed NO task list. Deriving from the
	// raw objective must surface the derived tree in the confirmation.
	const objective = "Ship the release.\n1) Implement core\n2) Add tests\n3) Write docs";
	const text = proposalText(testDraft("goal", "Ship the release"), objective, true, undefined, undefined);
	assert.match(text, /Tasks derived from the objective \(confirm or ask the agent to adjust\):/);
	assert.match(text, /\[ \] step-1: Implement core/);
	assert.match(text, /\[ \] step-2: Add tests/);
	assert.match(text, /\[ \] step-3: Write docs/);
	assert.doesNotMatch(text, /Tasks proposed for confirmation/);
	assert.doesNotMatch(text, /Tasks derived from the objective[\s\S]*Tasks derived from the objective/, "derived preview appears exactly once");
});

test("a new-draft proposal with explicit tasks shows them once and never adds a derived block", () => {
	const text = proposalText(
		testDraft("goal", "Build a tool"),
		"Build a tool.\n1) wire it\n2) test it",
		true,
		taskList([{ id: "t1", title: "Explicit task" }]),
		undefined,
	);
	assert.equal((text.match(/Tasks proposed for confirmation:/g) ?? []).length, 1, "explicit list shown exactly once");
	assert.equal((text.match(/Tasks derived from the objective/g) ?? []).length, 0, "no derived block when tasks are explicit");
	assert.match(text, /\[ \] t1: Explicit task/);
});

test("a tweak confirmation renders the explicit task list exactly once", () => {
	// Regression: buildTweakConfirmationText already renders tasks inside its
	// ┌─ TASKS ─┐ box; appending a second "Tasks proposed" block duplicated it.
	const current = currentGoal("Old objective.", [{ id: "old", title: "Old task", status: "complete" }]);
	const text = proposalText(
		testDraft("tweak", "Revise the plan"),
		"New objective.",
		true,
		taskList([{ id: "new-1", title: "New task" }]),
		current,
	);
	assert.equal((text.match(/┌─ TASKS ─/g) ?? []).length, 1, "the task box renders exactly once");
	assert.equal((text.match(/Tasks proposed for confirmation:/g) ?? []).length, 0, "no duplicated appended list");
	assert.match(text, /\[ \] new-1: New task/);
	assert.doesNotMatch(text, /Current task list \(retained unchanged\):/, "explicit tasks replace the retained preview");
});

test("a tweak without explicit tasks previews the retained current list exactly once", () => {
	const current = currentGoal("Old objective.", [{ id: "keep", title: "Retained task", status: "complete" }]);
	const text = proposalText(testDraft("tweak", "Clarify wording"), "Clarified objective.", true, undefined, current);
	assert.equal((text.match(/Current task list \(retained unchanged\):/g) ?? []).length, 1, "retained list shown exactly once");
	assert.match(text, /\[ \] keep: Retained task/);
	assert.equal((text.match(/┌─ TASKS ─/g) ?? []).length, 0, "no empty explicit task box");
	assert.doesNotMatch(text, /Tasks proposed for confirmation:/);
	assert.doesNotMatch(text, /Tasks derived from the objective/);
});

// ── §7.5 regression: a tweak never changes the status of persisting steps ─

test("a tweak merges the proposed task list by id, preserving statuses of surviving steps", async () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "goal-tweak-merge-"));
	mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
	try {
		const h = createHarness(cwd, { hasUI: true });
		await h.sessionStart();
		await h.commands.get("goal-direct")!.handler("Initial objective", h.ctx);
		// Seed a task list on disk with a completed step, a removable step, and
		// the current task. /goal-tweak reconciles from disk before drafting.
		const goal = firstGoal(cwd);
		writeActiveGoalFile({ cwd }, {
			...goal,
			currentTaskId: "ct",
			taskList: {
				tasks: [
					{ id: "keep", title: "Surviving task", status: "complete", evidence: "Done it.", completedAt: "2026-08-05T10:00:00.000Z", verificationContract: "tests pass" },
					{ id: "drop", title: "Removed task", status: "pending" },
					{ id: "ct", title: "Current task", status: "pending" },
				],
				blockCompletion: false,
				proposedAt: "2026-08-05T09:00:00.000Z",
			},
		});
		await h.commands.get("goal-tweak")!.handler("Revise the scope", h.ctx);
		const pending = runProposal(h, proposalParams("Revised objective", {
			sisyphus: false,
			tasks: [
				{ id: "keep", title: "Surviving task (retitled)", verification_contract: "contract v2" },
				{ id: "fresh", title: "Brand new task" },
			],
		}));
		h.dialogResult({ questions: [], answers: [{ id: "confirm", question: "Confirm Goal Draft", answer: CONFIRM_ANSWER, wasCustom: false }], cancelled: false });
		await pending;
		const after = firstGoal(cwd);
		const byId = new Map(after.taskList?.tasks.map((t) => [t.id, t]) ?? []);
		const keep = byId.get("keep");
		assert.equal(keep?.status, "complete", "persisting step keeps its status across the tweak");
		assert.equal(keep?.evidence, "Done it.", "evidence preserved");
		assert.equal(keep?.completedAt, "2026-08-05T10:00:00.000Z", "completedAt preserved");
		assert.equal(keep?.verificationContract, "contract v2", "structural fields (contract) follow the proposal");
		assert.equal(keep?.title, "Surviving task (retitled)", "structural fields follow the proposal");
		assert.equal(byId.has("drop"), false, "removed step is dropped");
		assert.equal(byId.has("ct"), false, "removed current task is dropped");
		assert.equal(byId.get("fresh")?.status, "pending", "new step starts pending");
		assert.equal(after.currentTaskId, undefined, "currentTaskId cleared when its task no longer survives pending");
		const setEvent = ledgerEvents(cwd).find((e) => e.type === "task_list_set");
		assert.equal(setEvent?.taskCount, 2, "ledger records the merged task count");
	} finally {
		try { rmSync(cwd, { recursive: true, force: true }); } catch {}
	}
});

test("a tweak with no task list retains the current list and keeps its statuses", async () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "goal-tweak-retain-"));
	mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
	try {
		const h = createHarness(cwd, { hasUI: true });
		await h.sessionStart();
		await h.commands.get("goal-direct")!.handler("Initial objective", h.ctx);
		const goal = firstGoal(cwd);
		writeActiveGoalFile({ cwd }, {
			...goal,
			currentTaskId: "do",
			taskList: {
				tasks: [
					{ id: "do", title: "In progress", status: "pending" },
					{ id: "done", title: "Already done", status: "complete", evidence: "Shipped.", completedAt: "2026-08-05T08:00:00.000Z" },
				],
				blockCompletion: false,
				proposedAt: "2026-08-05T09:00:00.000Z",
			},
		});
		await h.commands.get("goal-tweak")!.handler("Clarify the wording", h.ctx);
		// No tasks in the proposal: the current list is retained unchanged.
		const pending = runProposal(h, proposalParams("Clarified objective", { sisyphus: false }));
		h.dialogResult({ questions: [], answers: [{ id: "confirm", question: "Confirm Goal Draft", answer: CONFIRM_ANSWER, wasCustom: false }], cancelled: false });
		await pending;
		const after = firstGoal(cwd);
		const byId = new Map(after.taskList?.tasks.map((t) => [t.id, t]) ?? []);
		assert.equal(byId.get("do")?.status, "pending", "pending task untouched");
		assert.equal(byId.get("done")?.status, "complete", "completed task untouched");
		assert.equal(after.currentTaskId, "do", "currentTaskId retained when its task is still pending");
		assert.equal(ledgerEvents(cwd).some((e) => e.type === "task_list_set"), false, "no task_list_set event when the list is retained");
	} finally {
		try { rmSync(cwd, { recursive: true, force: true }); } catch {}
	}
});

for (const unavailable of [false, true]) {
	test(`all drafting tools preserve the draft when dialogs are ${unavailable ? "unavailable" : "failing"}`, async () => {
		const cwd = mkdtempSync(path.join(tmpdir(), "goal-draft-dialog-failure-"));
		try {
			const h = createHarness(cwd, { hasUI: true });
			await h.sessionStart();
			await h.commands.get("goal")!.handler("Ship a tested feature", h.ctx);
			h.ctx.ui.custom = (async () => { if (!unavailable) throw new Error("Host disconnected"); return undefined; }) as typeof h.ctx.ui.custom;
			delete (h.ctx.ui as Partial<ExtensionContext["ui"]>).select;
			for (const [name, params] of [
				["goal_question", { question: "Scope?", options: ["A"] }],
				["goal_questionnaire", { questions: [{ id: "scope", question: "Scope?", options: ["A"] }] }],
				["propose_goal_draft", proposalParams("Ship a tested feature. Success criteria: tests pass.")],
			] as const) {
				const result = await h.tools.get(name).execute("test", params, new AbortController().signal, undefined, h.ctx);
				assert.match(result.content[0].text, unavailable ? /cannot display/ : /Host disconnected/);
				assert.doesNotMatch(result.content[0].text, /user cancelled|refinement requested/);
				assert.equal(activeGoalFiles(cwd).length, 0);
				assert.ok(h.activeTools().includes("propose_goal_draft"));
			}
		} finally { rmSync(cwd, { recursive: true, force: true }); }
	});
}
