/**
 * goal_control: revise and archive the focused goal from a tool call.
 *
 * Both actions must reach the same confirmation the /goal-tweak and
 * /goal-clear commands use, and must change nothing before that confirmation.
 * Revising keeps the SAME goal (no replacement goal, so plan, progress and
 * usage survive); archiving files the goal out of the active pool.
 */

import assert from "node:assert/strict";
import { mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { hasActiveDraft } from "../extensions/goal-drafting.ts";
import { parseGoalFile } from "../extensions/storage/goal-files.ts";
import { createExtensionHarness } from "./support/extension-harness.ts";
import { activeGoalFiles, ledgerEvents, removeDir, tempDir } from "./support/fs.ts";

const CONFIRM_ANSWER = "Confirm — create this goal now";
const CONTINUE_ANSWER = "Continue chatting — keep refining";
const CANCEL_ANSWER = "Cancel — discard this draft";

function createHarness(cwd: string, options: { hasUI?: boolean; confirm?: boolean } = {}) {
	let confirmAnswer = options.confirm ?? true;
	const h = createExtensionHarness({
		cwd,
		hasUI: options.hasUI ?? true,
		sessionId: "control-session",
		custom: "dialog",
		ui: {
			select: async () => undefined,
			confirm: async () => confirmAnswer,
		},
	});
	return Object.assign(h, { setConfirm: (value: boolean) => { confirmAnswer = value; } });
}

type Harness = ReturnType<typeof createHarness>;

function control(h: Harness, params: Record<string, unknown>) {
	const tool = h.tools.get("goal_control");
	assert.ok(tool, "goal_control must be registered at extension load");
	return tool.execute("control-1", params, new AbortController().signal, undefined, h.ctx);
}

/** Answer the proposal confirmation the revise action opens. */
function answerDialog(h: Harness, answer: string): void {
	h.resolveDialog({ questions: [], answers: [{ id: "confirm", question: "Confirm Goal Draft", answer, wasCustom: false }], cancelled: false });
}

function goalPath(cwd: string): string {
	const files = activeGoalFiles(cwd);
	assert.equal(files.length, 1, "exactly one active goal expected");
	return path.join(cwd, ".pi", "goals", files[0]!);
}

function firstGoal(cwd: string) {
	return parseGoalFile(goalPath(cwd))!;
}

function archivedFiles(cwd: string): string[] {
	try {
		return readdirSync(path.join(cwd, ".pi", "goals", "archived"));
	} catch {
		return [];
	}
}

async function startGoal(h: Harness, objective = "Initial objective") {
	await h.sessionStart();
	await h.runCommand("goal-direct", objective);
	return firstGoal(h.ctx.cwd);
}

function setup(prefix: string) {
	const cwd = tempDir(prefix);
	mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
	return cwd;
}

// ── revise ────────────────────────────────────────────────────────────────

test("revise confirms a revision of the same goal and keeps its progress", async () => {
	const cwd = setup("goal-control-revise-");
	try {
		const h = createHarness(cwd);
		const before = await startGoal(h);
		const pending = control(h, { action: "revise", change: "Tighten the wording", objective: "Revised objective with clarity." });
		answerDialog(h, CONFIRM_ANSWER);
		const result = await pending;
		assert.match(result.content[0].text, /tweak confirmed/);
		const after = firstGoal(cwd);
		assert.equal(after.id, before.id, "the same goal is revised, not replaced");
		assert.ok(after.objective.includes("Revised objective"), "objective updated");
		assert.equal(activeGoalFiles(cwd).length, 1, "no replacement goal file");
		assert.ok(ledgerEvents(cwd).some((event) => event.type === "goal_tweaked"), "goal_tweaked recorded");
		assert.equal(hasActiveDraft(h.core), false, "the temporary tweak draft is cleared");
		assert.equal(result.terminate, true, "the turn ends after a confirmed revision");
	} finally {
		removeDir(cwd);
	}
});

test("revise without an objective keeps it and applies a budget-only change", async () => {
	const cwd = setup("goal-control-budget-");
	try {
		const h = createHarness(cwd);
		const before = await startGoal(h);
		const pending = control(h, { action: "revise", change: "Raise the budget to 50000", token_budget: 50_000 });
		answerDialog(h, CONFIRM_ANSWER);
		await pending;
		const after = firstGoal(cwd);
		assert.equal(after.objective, before.objective, "objective retained when none is proposed");
		assert.equal(after.tokenBudget, 50_000, "budget revised");
		assert.ok(ledgerEvents(cwd).some((event) => event.type === "goal_budget_changed"), "budget change recorded");
	} finally {
		removeDir(cwd);
	}
});

test("revise cancel leaves the goal untouched", async () => {
	const cwd = setup("goal-control-revise-cancel-");
	try {
		const h = createHarness(cwd);
		const before = await startGoal(h);
		const pending = control(h, { action: "revise", change: "Rewrite it", objective: "Unwanted objective." });
		answerDialog(h, CANCEL_ANSWER);
		const result = await pending;
		assert.match(result.content[0].text, /cancelled/);
		assert.equal(firstGoal(cwd).objective, before.objective, "no mutation after cancel");
		assert.equal(hasActiveDraft(h.core), false, "cancel discards the temporary draft");
	} finally {
		removeDir(cwd);
	}
});

test("revise 'continue chatting' keeps the draft open for refinement", async () => {
	const cwd = setup("goal-control-revise-continue-");
	try {
		const h = createHarness(cwd);
		const before = await startGoal(h);
		const pending = control(h, { action: "revise", change: "Rewrite it", objective: "Draft objective." });
		answerDialog(h, CONTINUE_ANSWER);
		const result = await pending;
		assert.match(result.content[0].text, /refinement requested/);
		assert.equal(firstGoal(cwd).objective, before.objective, "nothing applied while refining");
		assert.equal(hasActiveDraft(h.core), true, "the draft stays open so the agent can refine it");
	} finally {
		removeDir(cwd);
	}
});

test("revise requires a change description and creates no draft", async () => {
	const cwd = setup("goal-control-revise-nochange-");
	try {
		const h = createHarness(cwd);
		const before = await startGoal(h);
		const result = await control(h, { action: "revise", objective: "Unannounced rewrite." });
		assert.match(result.content[0].text, /needs a "change"/);
		assert.equal(firstGoal(cwd).objective, before.objective, "no mutation without a change request");
		assert.equal(hasActiveDraft(h.core), false, "validation happens before a draft exists");
		assert.equal(h.hasDialog(), false, "no dialog is opened for an invalid call");
	} finally {
		removeDir(cwd);
	}
});

test("revise refuses a second revision while a goal draft is active", async () => {
	const cwd = setup("goal-control-revise-draft-");
	try {
		const h = createHarness(cwd);
		await startGoal(h);
		await h.runCommand("goal-tweak", "Existing tweak draft");
		const result = await control(h, { action: "revise", change: "Second revision", objective: "Other objective." });
		assert.match(result.content[0].text, /draft is in progress/);
	} finally {
		removeDir(cwd);
	}
});

test("revise without a focused goal explains how to start one", async () => {
	const cwd = setup("goal-control-revise-nogoal-");
	try {
		const h = createHarness(cwd);
		await h.sessionStart();
		const result = await control(h, { action: "revise", change: "Anything", objective: "Objective." });
		assert.match(result.content[0].text, /No goal is focused/);
	} finally {
		removeDir(cwd);
	}
});

test("revise revives a paused goal like the tweak flow", async () => {
	const cwd = setup("goal-control-revise-paused-");
	try {
		const h = createHarness(cwd);
		await startGoal(h);
		await h.runCommand("goal-pause");
		assert.equal(firstGoal(cwd).status, "paused", "goal paused before the revision");
		const pending = control(h, { action: "revise", change: "Give it another go", objective: "Revised and runnable." });
		answerDialog(h, CONFIRM_ANSWER);
		await pending;
		assert.equal(firstGoal(cwd).status, "active", "a confirmed revision resumes an owned paused goal");
		assert.ok(ledgerEvents(cwd).some((event) => event.type === "goal_resumed"), "resume recorded");
	} finally {
		removeDir(cwd);
	}
});

test("revise refuses a host that cannot show the confirmation dialog", async () => {
	const cwd = setup("goal-control-revise-headless-");
	try {
		const h = createHarness(cwd, { hasUI: false });
		const before = await startGoal(h);
		const result = await control(h, { action: "revise", change: "Silent rewrite", objective: "Unconfirmed objective." });
		assert.match(result.content[0].text, /NOT revised/);
		assert.equal(firstGoal(cwd).objective, before.objective, "a headless call never rewrites the objective");
		assert.equal(hasActiveDraft(h.core), false, "the refusal leaves no draft behind");
	} finally {
		removeDir(cwd);
	}
});

test("revise honours the explicit PI_GOAL_AUTO_CONFIRM=1 opt-in", async () => {
	const cwd = setup("goal-control-revise-autoconfirm-");
	try {
		const h = createHarness(cwd, { hasUI: false });
		await startGoal(h);
		process.env.PI_GOAL_AUTO_CONFIRM = "1";
		try {
			const result = await control(h, { action: "revise", change: "Benchmarked revision", objective: "Revised without a dialog." });
			assert.match(result.content[0].text, /tweak confirmed/);
			assert.ok(firstGoal(cwd).objective.includes("Revised without a dialog"));
			assert.equal(h.hasDialog(), false, "the opt-in confirms without a dialog");
		} finally {
			delete process.env.PI_GOAL_AUTO_CONFIRM;
		}
	} finally {
		removeDir(cwd);
	}
});

// ── archive ───────────────────────────────────────────────────────────────

test("archive asks for confirmation and files the goal out of the active pool", async () => {
	const cwd = setup("goal-control-archive-");
	try {
		const h = createHarness(cwd, { confirm: true });
		await startGoal(h);
		const result = await control(h, { action: "archive" });
		assert.match(result.content[0].text, /cleared and archived/);
		assert.equal(activeGoalFiles(cwd).length, 0, "the goal leaves the active pool");
		assert.equal(archivedFiles(cwd).length, 1, "the goal file is archived");
		assert.equal(h.core.state.goal, null, "nothing stays focused");
		assert.equal(result.terminate, true, "the turn ends after archiving");
	} finally {
		removeDir(cwd);
	}
});

test("archive cancel changes nothing", async () => {
	const cwd = setup("goal-control-archive-cancel-");
	try {
		const h = createHarness(cwd, { confirm: false });
		await startGoal(h);
		const result = await control(h, { action: "archive" });
		assert.match(result.content[0].text, /cancelled/);
		assert.equal(activeGoalFiles(cwd).length, 1, "the goal stays active");
		assert.equal(archivedFiles(cwd).length, 0, "nothing was archived");
		assert.ok(h.core.state.goal, "the goal stays focused");
	} finally {
		removeDir(cwd);
	}
});

test("archive refuses a host that cannot ask for confirmation", async () => {
	const cwd = setup("goal-control-archive-headless-");
	try {
		const h = createHarness(cwd, { hasUI: false });
		await startGoal(h);
		const result = await control(h, { action: "archive" });
		assert.match(result.content[0].text, /goal-clear/);
		assert.equal(activeGoalFiles(cwd).length, 1, "a headless call never archives");
		assert.equal(archivedFiles(cwd).length, 0, "nothing was archived");
	} finally {
		removeDir(cwd);
	}
});

test("archive aborts when the focus moved while confirming", async () => {
	const cwd = setup("goal-control-archive-race-");
	try {
		const h = createHarness(cwd, { confirm: true });
		await startGoal(h);
		let unfocused = false;
		const ctx = h.createContext({
			ui: {
				notify: () => {},
				confirm: async () => {
					unfocused = true;
					await h.runCommand("goal-unfocus");
					return true;
				},
			},
		});
		const result = await h.callTool("goal_control", { action: "archive" }, "race", ctx);
		assert.equal(unfocused, true, "the dialog ran before the focus moved");
		assert.match(result.content[0].text, /changed while confirming/);
		assert.equal(activeGoalFiles(cwd).length, 1, "the goal was not archived");
		assert.equal(archivedFiles(cwd).length, 0, "nothing was archived");
	} finally {
		removeDir(cwd);
	}
});

test("archive with no focused goal reports it", async () => {
	const cwd = setup("goal-control-archive-nogoal-");
	try {
		const h = createHarness(cwd, { confirm: true });
		await h.sessionStart();
		const result = await control(h, { action: "archive" });
		assert.match(result.content[0].text, /No goal is set/);
	} finally {
		removeDir(cwd);
	}
});

test("/goal-clear and goal_control archive share one confirmation path", async () => {
	const cwd = setup("goal-control-clear-command-");
	try {
		const h = createHarness(cwd, { confirm: true });
		await startGoal(h);
		await h.runCommand("goal-clear");
		assert.equal(activeGoalFiles(cwd).length, 0, "the command archives the goal");
		assert.equal(archivedFiles(cwd).length, 1, "one archived file");
		assert.ok(h.notifications.some((message) => /cleared and archived/.test(message)), "the command reports the archive");
	} finally {
		removeDir(cwd);
	}
});

test("renderCall names the action without throwing", async () => {
	const cwd = setup("goal-control-render-");
	try {
		const h = createHarness(cwd);
		await startGoal(h);
		const tool = h.tools.get("goal_control")!;
		const theme = {
			fg: (_color: string, text: string) => text,
			bold: (text: string) => text,
		};
		const revise = tool.renderCall({ action: "revise", change: "Shorten it" }, theme);
		const archive = tool.renderCall({ action: "archive" }, theme);
		assert.ok(typeof revise === "object" && typeof archive === "object", "renderCall returns a renderable");
	} finally {
		removeDir(cwd);
	}
});
