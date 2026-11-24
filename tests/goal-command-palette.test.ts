/**
 * Guided drafting is the normal entry path; the two -direct commands are the
 * explicit immediate-creation escape hatch.
 */

import { createExtensionHarness } from "./support/extension-harness.ts";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { parseGoalFile } from "../extensions/storage/goal-files.ts";
import { activeGoalFiles, removeDir, tempDir } from "./support/fs.ts";

const CURATED_COMMANDS = [
	"goal", "sisyphus", "goal-direct", "sisyphus-direct", "goal-tweak", "goal-pause", "goal-resume",
	"goal-clear", "goal-list", "goal-status", "goal-refresh", "goal-recovery", "goal-focus", "goal-unfocus", "goal-settings", "goal-cancel",
];

const REMOVED_COMMANDS = ["goals", "goals-set", "sisyphus-set", "goal-abort"];

function createHarness(cwd: string) {
	const h = createExtensionHarness({ cwd, sessionEntries: [], sessionId: "palette-session" });
	return Object.assign(h, { messages: h.userMessages as string[], getActiveTools: () => h.activeTools });
}

test("exactly the fourteen curated commands are registered; legacy commands are absent", () => {
	const cwd = tempDir("goal-palette-");
	try {
		const h = createHarness(cwd);
		for (const name of CURATED_COMMANDS) {
			assert.ok(h.commands.has(name), `${name} must be registered`);
		}
		for (const name of REMOVED_COMMANDS) {
			assert.equal(h.commands.has(name), false, `${name} must NOT be registered`);
		}
		assert.equal(h.commands.size, CURATED_COMMANDS.length, "no aliases or extras");
	} finally {
		removeDir(cwd);
	}
});

test("/goal <objective> starts guided drafting without creating a goal", async () => {
	const cwd = tempDir("goal-palette-create-");
	mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
	try {
		const h = createHarness(cwd);
		await h.handlers.get("session_start")?.({ reason: "start" }, h.ctx);
		await h.commands.get("goal")!.handler("Create hello.txt with 'Hello'", h.ctx);
		const files = activeGoalFiles(cwd);
		assert.equal(files.length, 0, "drafting does not create before confirmation");
		assert.ok(h.messages.some((message) => message.includes("GOAL CONFIRMATION")), "drafting prompt sent to agent");
		assert.deepEqual(h.getActiveTools().filter((name) => name.startsWith("goal_") || name === "propose_goal_draft"), ["goal_questionnaire", "propose_goal_draft"]);
	} finally {
		removeDir(cwd);
	}
});

test("bare /goal begins a guided draft and asks for an objective", async () => {
	const cwd = tempDir("goal-palette-status-");
	try {
		const h = createHarness(cwd);
		await h.handlers.get("session_start")?.({ reason: "start" }, h.ctx);
		await h.commands.get("goal")!.handler("", h.ctx);
		assert.equal(activeGoalFiles(cwd).length, 0, "no goal created");
		assert.ok(h.messages.some((message) => message.includes("ask the user what they want")), "draft prompt requests an objective");
	} finally {
		removeDir(cwd);
	}
});

test("confirmed draft creates the proposed goal and agent-selected task plan together", async () => {
	const cwd = tempDir("goal-palette-confirm-");
	mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
	try {
		const h = createHarness(cwd);
		await h.handlers.get("session_start")?.({ reason: "start" }, h.ctx);
		await h.commands.get("goal")!.handler("Ship a small feature", h.ctx);
		const proposal = h.tools.get("propose_goal_draft");
		assert.ok(proposal, "draft proposal tool registered");
		await proposal.execute("draft-1", {
			objective: "Ship a small feature.\nSuccess criteria: tests pass.",
			sisyphus: false,
			tasks: [{ id: "implement", title: "Implement the feature" }, { id: "verify", title: "Run tests" }],
			block_completion: true,
		}, new AbortController().signal, undefined, h.ctx);
		const files = activeGoalFiles(cwd);
		assert.equal(files.length, 1, "confirmed draft creates one goal");
		const goal = parseGoalFile(path.join(cwd, ".pi", "goals", files[0]!));
		assert.deepEqual(goal?.taskList?.tasks.map((task) => task.id), ["implement", "verify"]);
		assert.equal(goal?.taskList?.blockCompletion, true);
		assert.ok(h.getActiveTools().includes("update_goal"), "execution profile restored after confirmation");
	} finally {
		removeDir(cwd);
	}
});

test("/goal-direct and /sisyphus-direct create goals immediately", async () => {
	const cwd = tempDir("goal-palette-sisy-");
	mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
	try {
		const h = createHarness(cwd);
		await h.handlers.get("session_start")?.({ reason: "start" }, h.ctx);
		await h.commands.get("goal-direct")!.handler("Create hello.txt", h.ctx);
		await h.commands.get("sisyphus-direct")!.handler("1) create a.txt 2) create b.txt", h.ctx);
		const files = activeGoalFiles(cwd);
		assert.equal(files.length, 2, "direct commands create immediately");
		const parsed = files.map((file) => parseGoalFile(path.join(cwd, ".pi", "goals", file)));
		assert.ok(parsed.some((goal) => goal?.sisyphus === true), "sisyphus direct mode");
		assert.ok(parsed.some((goal) => goal?.sisyphus === false), "regular direct mode");
	} finally {
		removeDir(cwd);
	}
});

test("goal-settings renders sectioned rows with clearer auditor wording", async () => {
	const cwd = tempDir("goal-settings-");
	mkdirSync(path.join(cwd, ".pi"), { recursive: true });
	const h = createHarness(cwd);
	try {
		// The settings menu is interactive: give the harness ctx a TUI.
		(h.ctx as { hasUI: boolean }).hasUI = true;
		// Capture the options list passed to ctx.ui.select; answer "Done" on the
		// first call so the menu closes immediately.
		let captured: string[] | null = null;
		const ui = h.ctx.ui as unknown as { select: (title: string, options: string[]) => Promise<string | undefined> };
		ui.select = async (_title: string, options: string[]) => {
			if (captured === null) captured = options;
			return "Done";
		};

		await h.commands.get("goal-settings")!.handler("", h.ctx);

		assert.ok(captured, "settings menu must call ui.select");
		const opts: string[] = captured ?? [];
		assert.ok(opts.some((l) => l.startsWith("─── Editing: project (")), "scope header names the edited layer");
		assert.ok(opts.some((l) => l.startsWith("Scope: project")), "scope switch is selectable");
		assert.ok(opts.includes("─── Advanced execution ───"));
		assert.ok(opts.includes("─── Goal behavior ───"), "Goal behavior section header");
		assert.ok(opts.includes("─── Task tracking ───"), "Task tracking section header");
		assert.ok(opts.includes("─── Completion auditor ───"), "Completion auditor section header");
		assert.ok(opts.some((l) => l.includes("auditor disabled:")), "clearer auditor wording row");
		assert.ok(opts.some((l) => l.includes("provider:")) && opts.some((l) => l.includes("model:")), "provider/model rows");
		assert.equal(opts.filter((l) => l.startsWith("───")).length, 6, "editing header + five settings sections");
		assert.ok(opts.includes("─── Blocker Oracle ───"), "Blocker Oracle section header");
		assert.ok(opts.includes("Done"));
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

// ── #19: positive-integer rows use a row-driven lower bound ──────────────────
// The stall timeout row defaults to 0 ("no stall timeout") and must accept 0;
// subtaskDepth is a nesting depth and must keep rejecting 0 and non-integers.

test("goal-settings: stall timeout row accepts 0 (row-driven lower bound)", async () => {
	const cwd = tempDir("goal-settings-bound-");
	mkdirSync(path.join(cwd, ".pi"), { recursive: true });
	const h = createHarness(cwd);
	try {
		(h.ctx as { hasUI: boolean }).hasUI = true;
		const ui = h.ctx.ui as unknown as {
			select: (title: string, options: string[]) => Promise<string | undefined>;
			input: (prompt: string, defaultValue?: string) => Promise<string | undefined>;
		};
		let selectCalls = 0;
		ui.select = async (_title: string, options: string[]) => {
			selectCalls++;
			if (selectCalls === 1) {
				const stallRow = options.find((o) => o.includes("stall timeout (minutes)"));
				assert.ok(stallRow, "stall timeout row must be listed");
				return stallRow;
			}
			return "Done";
		};
		ui.input = async (_prompt: string) => "0";

		await h.commands.get("goal-settings")!.handler("", h.ctx);

		const saved = JSON.parse(readFileSync(path.join(cwd, ".pi", "pi-goal-x-settings.json"), "utf8"));
		assert.equal(saved.stallTimeoutMinutes, 0, "stallTimeoutMinutes must accept 0");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("goal-settings: autonomous allowance accepts an explicit zero override", async () => {
	const cwd = tempDir("goal-settings-zero-");
	const h = createHarness(cwd);
	try {
		(h.ctx as { hasUI: boolean }).hasUI = true;
		let selectCalls = 0;
		h.ctx.ui.select = async (_title, options) => {
			selectCalls++;
			if (selectCalls === 1) {
				const row = options.find(o => o.includes("autonomous run allowance"));
				assert.ok(row);
				return row;
			}
			if (selectCalls === 2) return options.find(o => o === "Set project override...");
			assert.ok(options.some(o => o.includes("autonomous run allowance: 0 (disabled) (project override)")));
			return "Done";
		};
		h.ctx.ui.input = async () => "0";
		await h.commands.get("goal-settings")!.handler("", h.ctx);
		const saved = JSON.parse(readFileSync(path.join(cwd, ".pi", "pi-goal-x-settings.json"), "utf8"));
		assert.equal(saved.maxAutonomousRuns, 0);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("goal-settings: subtaskDepth rejects 0 (min 1) and never saves it", async () => {
	const cwd = tempDir("goal-settings-bound-");
	mkdirSync(path.join(cwd, ".pi"), { recursive: true });
	const h = createHarness(cwd);
	try {
		(h.ctx as { hasUI: boolean }).hasUI = true;
		const ui = h.ctx.ui as unknown as {
			select: (title: string, options: string[]) => Promise<string | undefined>;
			input: (prompt: string, defaultValue?: string) => Promise<string | undefined>;
		};
		let selectCalls = 0;
		ui.select = async (_title: string, options: string[]) => {
			selectCalls++;
			if (selectCalls === 1) {
				const depthRow = options.find((o) => o.includes("subtaskDepth"));
				assert.ok(depthRow, "subtaskDepth row must be listed");
				return depthRow;
			}
			return "Done";
		};
		ui.input = async (_prompt: string) => "0";

		await h.commands.get("goal-settings")!.handler("", h.ctx);

		assert.ok(h.notifications.some((n) => n.includes("subtaskDepth must be an integer >= 1")),
			`expected subtaskDepth bound warning, got notifications: ${h.notifications.join(" | ")}`);
		const settingsPath = path.join(cwd, ".pi", "pi-goal-x-settings.json");
		// A rejected input never persists: the file is either absent or lacks the key.
		if (readFileSyncSafe(settingsPath)) {
			assert.ok(!readFileSyncSafe(settingsPath)!.includes("subtaskDepth"), "subtaskDepth must not be written");
		}
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("goal-settings: max objective length row defaults to 0 and accepts a configured limit", async () => {
	const cwd = tempDir("goal-settings-objective-max-");
	mkdirSync(path.join(cwd, ".pi"), { recursive: true });
	const h = createHarness(cwd);
	try {
		(h.ctx as { hasUI: boolean }).hasUI = true;
		const ui = h.ctx.ui as unknown as {
			select: (title: string, options: string[]) => Promise<string | undefined>;
			input: (prompt: string, defaultValue?: string) => Promise<string | undefined>;
		};
		let selectCalls = 0;
		let inputValue = "0";
		ui.select = async (_title: string, options: string[]) => {
			selectCalls++;
			if (selectCalls === 1) {
				const row = options.find((o) => o.includes("max objective length"));
				assert.ok(row, "max objective length row must be listed");
				assert.ok(row!.includes(": 0"), "row defaults to 0 = no limit");
				return row;
			}
			return "Done";
		};
		ui.input = async (_prompt: string, defaultValue?: string) => {
			assert.equal(defaultValue, "0", "input defaults to 0");
			return inputValue;
		};

		await h.commands.get("goal-settings")!.handler("", h.ctx);

		let saved = JSON.parse(readFileSync(path.join(cwd, ".pi", "pi-goal-x-settings.json"), "utf8"));
		assert.equal(saved.objectiveMaxChars, 0, "0 = no limit persists explicitly");

		// A configured limit persists too.
		inputValue = "6000";
		selectCalls = 0;
		await h.commands.get("goal-settings")!.handler("", h.ctx);
		saved = JSON.parse(readFileSync(path.join(cwd, ".pi", "pi-goal-x-settings.json"), "utf8"));
		assert.equal(saved.objectiveMaxChars, 6000, "configured limit persists");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

function readFileSyncSafe(p: string): string | null {
	try {
		return readFileSync(p, "utf8");
	} catch {
		return null;
	}
}

for (const [key, label] of [["strictExecutionContract", "explicit execution contracts (opt-in)"], ["idleContinuationBackoff", "slow repeated idle replies (opt-in)"]] as const) test(`goal-settings: ${key} can be set and removed through the menu`, async () => {
	const cwd = tempDir("goal-settings-contract-");
	mkdirSync(path.join(cwd, ".pi"), {recursive: true});
	const h = createHarness(cwd);
	try {
		(h.ctx as {hasUI: boolean}).hasUI = true;
		const ui = h.ctx.ui as unknown as {select: (title: string, options: string[]) => Promise<string | undefined>};
		for (const action of ["Set project override to true", "Set project override to false", "Use inherited value"]) {
			let step = 0;
			ui.select = async (_title, options) => {
				step++;
				if (step === 1) return options.find(option => option.includes(`${label}:`));
				if (step === 2) { assert.ok(options.includes(action)); return action; }
				return "Done";
			};
			await h.commands.get("goal-settings")!.handler("", h.ctx);
			const saved = JSON.parse(readFileSync(path.join(cwd, ".pi", "pi-goal-x-settings.json"), "utf8"));
			assert.equal(saved[key], action === "Use inherited value" ? undefined : action.endsWith("true"));
		}
	} finally { rmSync(cwd, {recursive: true, force: true}); }
});

test("/goal-resume sends any text after the command to the agent", async () => {
	const cwd = tempDir("goal-resume-text-");
	try {
		let idle = true;
		const h = createExtensionHarness({ cwd, isIdle: () => idle });
		await h.sessionStart();
		await h.runCommand("goal-resume", "  focus on the failing test first  ");
		assert.deepEqual(h.userMessages, ["focus on the failing test first"], "text is trimmed and sent even with no goal focused");
		assert.deepEqual(h.userMessageModes, ["followUp"], "an idle agent gets it as a follow-up");

		idle = false;
		await h.runCommand("goal-resume", "check the logs");
		assert.equal(h.userMessageModes.at(-1), "steer", "a busy agent gets it as a steer");

		await h.runCommand("goal-resume", "   ");
		assert.equal(h.userMessages.length, 2, "blank text sends nothing");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});
