import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth, getKeybindings } from "@earendil-works/pi-tui";
import goalExtension from "../extensions/goal.ts";
import type { GoalCore } from "../extensions/goal-state.ts";
import {
	GOAL_COMMANDS, GOAL_KEY_ACTIONS, commandProblems, commandRoutes, matchCommandRoute,
	normalizeGoalKey, sameGoalKey, parseCommandPaths, parseGoalKeybinding, keybindingProblems, commandHint,
} from "../extensions/goal-controls.ts";
import { loadSettingsSnapshot, mutateSettingsLayer, SettingsMutationError, invalidateGoalSettingsCache } from "../extensions/goal-settings.ts";
import { syncTerminalInputPause } from "../extensions/goal-terminal-input.ts";
import { GoalControlsDialog, commandControlsFingerprint } from "../extensions/widgets/goal-controls-dialog.ts";
import { createMockTheme, createMockTUI } from "./support/tui-test-utils.ts";
import { goalPrompt } from "../extensions/prompts/goal-prompts.ts";
import { goalDialogControls } from "../extensions/goal-dialog-controls.ts";
import { showEscapeDialog } from "../extensions/widgets/goal-escape-dialog.ts";
import { runGoalQuestionnaire, fitDialogLines } from "../extensions/goal-questionnaire.ts";
import { detailedSummary } from "../extensions/goal-format.ts";
import { formatRecoveryReport, runRecoveryReport } from "../extensions/goal-recovery.ts";

const ESC = "\x1b", ENTER = "\r", DOWN = "\x1b[B", TAB = "\t";
const F6 = "\x1b[17~";

function fixture(settings: unknown = {}) {
	const cwd = mkdtempSync(path.join(tmpdir(), "goal-controls-"));
	mkdirSync(path.join(cwd, ".pi"));
	const file = path.join(cwd, ".pi", "pi-goal-x-settings.json");
	writeFileSync(file, JSON.stringify(settings));
	const previous = { project: process.env.PI_GOAL_SETTINGS_FILE, global: process.env.PI_GOAL_GLOBAL_SETTINGS_FILE };
	process.env.PI_GOAL_SETTINGS_FILE = file;
	process.env.PI_GOAL_GLOBAL_SETTINGS_FILE = path.join(cwd, "global.json");
	const handlers = new Map<string, Function>();
	const commands = new Map<string, any>();
	const notifications: string[] = [];
	const messages: unknown[] = [];
	const statuses = new Map<string, string | undefined>();
	let terminal: ((data: string) => unknown) | undefined;
	let busy = true, aborts = 0;
	let activeTools = ["read", "write", "bash", "edit"];
	const pi = {
		on: (event: string, fn: Function) => { handlers.set(event, fn); },
		registerCommand: (name: string, definition: any) => commands.set(name, definition),
		registerTool: () => {}, registerMessageRenderer: () => {}, appendEntry: () => {},
		getActiveTools: () => [...activeTools], setActiveTools: (names: string[]) => { activeTools = names; },
		sendMessage: (message: unknown) => messages.push(message), sendUserMessage: (message: unknown) => messages.push(message),
		getCommands: () => [...commands.keys()].map(name => ({ name, source: "extension" })),
	};
	const ctx = {
		cwd, hasUI: true, isIdle: () => !busy, abort: () => { aborts++; }, hasPendingMessages: () => false,
		getSystemPrompt: () => "base", modelRegistry: { getAvailable: () => [] },
		sessionManager: { getBranch: () => [], getSessionId: () => "controls-session", getCwd: () => cwd },
		ui: {
			notify: (message: string) => notifications.push(message),
			setStatus: (key: string, value: string | undefined) => statuses.set(key, value),
			setWidget: () => {}, setWorkingVisible: () => {},
			onTerminalInput: (callback: (data: string) => unknown) => { terminal = callback; return () => {}; },
			input: async () => undefined, select: async () => undefined, confirm: async () => true,
		},
	} as unknown as ExtensionContext;
	goalExtension(pi as never);
	const core = (pi as unknown as { _goalCore: GoalCore })._goalCore;
	const emit = (event: string, payload: unknown = {}) => handlers.get(event)?.(payload, ctx);
	const mutate = (scope: "global" | "project", op: "set" | "unset", key: string[], value?: unknown) => mutateSettingsLayer({ scope, cwd, mutation: { op, path: key, value } });
	return {
		cwd, file, core, ctx, commands, notifications, messages, statuses, emit, mutate,
		press: (data: string) => terminal?.(data), aborts: () => aborts, idle: () => { busy = false; },
		start: async () => { await core.invokeGoalCommand!("goal-direct", "Create result.txt and verify its contents.", ctx); syncTerminalInputPause(core, ctx); },
		close: () => {
			core.scheduler.shutdown(); core.runtime.clearContinuationState();
			for (const [key, value] of [["PI_GOAL_SETTINGS_FILE", previous.project], ["PI_GOAL_GLOBAL_SETTINGS_FILE", previous.global]]) {
				if (value === undefined) delete process.env[key!]; else process.env[key!] = value;
			}
			invalidateGoalSettingsCache(); rmSync(cwd, { recursive: true, force: true });
		},
	};
}

test("control grammar normalizes aliases/modifiers, preserves disabled lists and rejects typos", () => {
	assert.equal(normalizeGoalKey("SHIFT+Ctrl+P"), "ctrl+shift+p");
	assert.equal(normalizeGoalKey("ctrl+esc"), "ctrl+escape");
	assert.equal(normalizeGoalKey("alt+pageup"), "alt+pageUp");
	assert.equal(normalizeGoalKey("ctrl++"), "ctrl++");
	assert.equal(normalizeGoalKey("ctrl+ctrl+p"), undefined);
	assert.equal(normalizeGoalKey("control+p"), undefined);
	assert.equal(normalizeGoalKey("potato"), undefined);
	assert.deepEqual(parseGoalKeybinding([]), []);
	assert.deepEqual(parseGoalKeybinding(["esc", "escape"]), ["escape"]);
	assert.equal(parseGoalKeybinding(["ctrl+p", "bad"]), undefined);
	assert.equal(sameGoalKey("ctrl+[", "escape"), true);
	assert.equal(sameGoalKey("ctrl+[", "escape", true), false);
	assert.deepEqual(parseCommandPaths(["/goal   edit", "goal edit"]), ["goal edit"]);
	assert.equal(parseCommandPaths(["/goal edit; bash"]), undefined);
	assert.equal(commandHint("goal-settings", { "goal-settings": [] }), "/goal-settings");
});

test("routes match whole words, prefer subcommands and preserve objective whitespace", () => {
	const routes = commandRoutes({ "goal-tweak": ["goal edit", "revise"], "goal-pause": [] });
	assert.deepEqual(matchCommandRoute(routes, "goal", "edit  Keep  the spacing"), { id: "goal-tweak", args: "Keep  the spacing" });
	assert.deepEqual(matchCommandRoute(routes, "goal", "editor improvements"), { id: "goal", args: "editor improvements" });
	assert.equal(matchCommandRoute(routes, "goal-pause", ""), undefined);
	assert.equal(commandRoutes(undefined).length, GOAL_COMMANDS.length);
	assert.notEqual(commandControlsFingerprint({ goal: ["goal", "work new"] }), commandControlsFingerprint({ goal: ["work new", "goal"] }), "changing only the preferred alias still needs reload");
	assert.ok(commandProblems({ goal: ["reload"] }).length);
	assert.ok(commandProblems({ "goal-tweak": ["goal"] }).length);
	assert.ok(commandProblems({ goal: ["goal-settings"] }).length);
	assert.ok(commandProblems({ goal: ["team goal"] }, ["team"]).length);
});

test("controls inherit per leaf, explicit empty lists override and resolved arrays are caller-owned", () => {
	const h = fixture();
	try {
		h.mutate("global", "set", ["commands", "goal-tweak"], ["goal edit"]);
		h.mutate("global", "set", ["keybindings", "pause"], ["f6", "ctrl+alt+p"]);
		h.mutate("global", "set", ["pauseOrder"], "goal-first");
		h.mutate("project", "set", ["commands", "goal-tweak"], []);
		h.mutate("project", "set", ["keybindings", "pause"], []);
		let snapshot = loadSettingsSnapshot(h.cwd);
		assert.deepEqual(snapshot.value.commands?.["goal-tweak"], []);
		assert.deepEqual(snapshot.value.keybindings?.pause, []);
		assert.equal(snapshot.value.pauseOrder, "goal-first");
		assert.equal(snapshot.provenance.get("commands.goal-tweak")?.source, "project");
		h.mutate("project", "unset", ["commands", "goal-tweak"]);
		h.mutate("project", "unset", ["keybindings", "pause"]);
		snapshot = loadSettingsSnapshot(h.cwd);
		assert.deepEqual(snapshot.value.commands?.["goal-tweak"], ["goal edit"]);
		(snapshot.value.keybindings!.pause as string[]).push("f9");
		assert.deepEqual(loadSettingsSnapshot(h.cwd).value.keybindings?.pause, ["f6", "ctrl+alt+p"]);
		(snapshot.provenance.get("keybindings.pause")!.value as string[]).push("f10");
		assert.deepEqual(loadSettingsSnapshot(h.cwd).provenance.get("keybindings.pause")!.value, ["f6", "ctrl+alt+p"]);
		assert.throws(() => h.mutate("project", "set", ["keybindings", "pause"], "misspelled"), SettingsMutationError);
		assert.throws(() => h.mutate("project", "set", ["pauseOrder"], "taskMaybe"), SettingsMutationError);
		assert.throws(() => h.mutate("project", "set", ["commands", "goal"], "/goal"), SettingsMutationError);
		assert.equal(loadSettingsSnapshot(h.cwd).value.pauseOrder, "goal-first");
	} finally { h.close(); }
});

test("shortcut conflicts use overlapping contexts, preserving Escape view priority", () => {
	assert.deepEqual(keybindingProblems({}), []);
	assert.ok(keybindingProblems({ keybindings: { pause: "ctrl+shift+a" } }).length);
	assert.deepEqual(keybindingProblems({ keybindings: { dashboard: { up: "f5", scrollUp: "f5" } } }), []);
	assert.ok(keybindingProblems({ keybindings: { dashboard: { up: "f5", down: "f5" } } }).length);
});

test("custom command roots register once, complete subcommands and keep settings recovery", async () => {
	const h = fixture({ commands: { goal: ["work new"], "goal-tweak": ["work edit"], "goal-status": ["work status", "progress"], "goal-pause": [], "goal-settings": ["preferences"] } });
	try {
		assert.equal(h.commands.has("goal"), false);
		assert.equal(h.commands.has("goal-tweak"), false);
		assert.equal(h.commands.has("goal-pause"), false);
		assert.ok(h.commands.has("goal-settings"));
		assert.ok(h.commands.has("preferences"));
		assert.deepEqual(h.commands.get("work").getArgumentCompletions("e").map((item: { value: string }) => item.value), ["edit"]);
		await h.commands.get("work").handler("unknown", h.ctx);
		assert.ok(h.notifications.at(-1)?.includes("/work edit"));
		assert.equal(h.messages.length, 0);
		assert.ok(detailedSummary(null, { goal: ["work new"] }).includes("/work new"));
		const report = { ...runRecoveryReport(h.ctx), orphanedSnapshotGoals: [{ goalId: "missing", activePath: "missing.md" }] };
		assert.ok(formatRecoveryReport(report, { "goal-recovery": ["doctor"] }).includes("/doctor repair"));
		assert.ok(formatRecoveryReport(report, { "goal-recovery": [] }).includes("Enable a recovery command"));
		await h.commands.get("work").handler("new Write a poem", h.ctx);
		assert.ok(h.messages.some(message => String(message).includes("Write a poem")));
	} finally { h.close(); }
});

for (const order of ["together", "goal-first", "turn-first"] as const) test(`${order}: pause sequence during a running turn`, async () => {
	const h = fixture({ pauseOrder: order });
	try {
		await h.start();
		h.press(ESC);
		assert.equal(h.core.state.goal?.status, order === "turn-first" ? "active" : "paused");
		assert.equal(h.aborts(), order === "goal-first" ? 0 : 1);
		if (order === "turn-first") {
			assert.ok(h.core.interruption.isHeld());
			assert.equal(h.core.state.goal?.scheduler?.phase, "interrupted");
			const used = h.core.state.goal?.scheduler?.used;
			await h.emit("agent_end", { messages: [{ role: "assistant", stopReason: "aborted", usage: {} }] });
			await h.emit("agent_settled", { aborted: true });
			h.core.scheduler.schedule(h.ctx);
			assert.equal(h.core.state.goal?.status, "active");
			assert.equal(h.core.state.goal?.scheduler?.used, used);
			assert.ok(h.core.interruption.isHeld());
			h.press(ESC);
			assert.equal(h.core.state.goal?.status, "paused");
			assert.equal(h.core.interruption.isHeld(), false);
		} else if (order === "goal-first") { h.press(ESC); assert.equal(h.aborts(), 1); }
	} finally { h.close(); }
});

test("a custom pause key makes native Escape turn-only; explicit user work releases the hold", async () => {
	const h = fixture({ keybindings: { pause: ["f6"] } });
	try {
		await h.start();
		h.press(ESC);
		assert.equal(h.core.state.goal?.status, "active");
		assert.equal(h.core.interruption.isHeld(), true);
		await h.emit("agent_end", { messages: [] });
		await h.emit("agent_settled", { aborted: true });
		const used = h.core.state.goal?.scheduler?.used;
		await h.emit("before_agent_start", { prompt: "Use a different approach", messageType: "user" });
		assert.equal(h.core.interruption.isHeld(), false);
		assert.equal(h.core.state.goal?.scheduler?.phase, "idle");
		assert.equal(h.core.state.goal?.scheduler?.used, used);
		h.press(F6);
		assert.equal(h.core.state.goal?.status, "paused");
	} finally { h.close(); }
});

test("late cancellation after a held turn cannot pause a replacement goal", async () => {
	const h = fixture({ pauseOrder: "turn-first" });
	try {
		await h.start(); h.press(ESC);
		const oldId = h.core.state.goal!.id;
		h.core.runningGoalId = oldId;
		await h.emit("agent_settled", { aborted: true });
		// A cancelled checkpoint can settle after the first interrupted turn.
		h.core.runningGoalId = oldId;
		await h.emit("agent_settled", { aborted: true });
		assert.equal(h.core.state.goal?.status, "active");
		assert.ok(h.core.interruption.isHeld());
		await h.core.invokeGoalCommand!("goal-direct", "A replacement goal", h.ctx);
		h.core.runningGoalId = oldId;
		await h.emit("agent_settled", { aborted: true });
		assert.notEqual(h.core.state.goal?.id, oldId);
		assert.equal(h.core.state.goal?.status, "active");
	} finally { h.close(); }
});

test("Resume during settlement starts its saved continuation for both Pi outcomes", async () => {
	for (const settled of [{ aborted: true }, { aborted: false }]) {
		const h = fixture({ pauseOrder: "turn-first" });
		try {
			await h.start(); await h.emit("agent_start"); h.press(ESC);
			assert.equal(h.core.scheduler.resume(h.ctx), true);
			await h.emit("agent_end", { messages: [{ role: "assistant", stopReason: "aborted", usage: {} }] });
			await h.emit("agent_settled", settled);
			assert.equal(h.core.state.goal?.status, "active");
			assert.ok(h.core.scheduler.claim(h.ctx), "the explicit resume is armed after the interrupted run settles");
		} finally { h.close(); }
	}
});

test("a refused resume preserves the hold; switching sessions clears its transient state", async () => {
	const h = fixture({ pauseOrder: "turn-first" });
	try {
		await h.start(); h.press(ESC);
		h.mutate("project", "set", ["maxAutonomousRuns"], 0);
		assert.equal(h.core.scheduler.resume(h.ctx), false);
		assert.equal(h.core.interruption.isHeld(), true);
		const id = h.core.state.goal!.id;
		await h.emit("session_start", { reason: "new" });
		assert.equal(h.core.interruption.isHeld(id), false);
		assert.equal(h.core.interruption.ignoreAbort(id), false);
	} finally { h.close(); }
});

test("explicit Pause stops a turn left running by goal-first, even when the goal is already paused", async () => {
	const h = fixture({ pauseOrder: "goal-first" });
	try {
		await h.start(); h.press(ESC); assert.equal(h.aborts(), 0);
		await h.core.invokeGoalCommand!("goal-pause", "", h.ctx);
		assert.equal(h.aborts(), 1);
	} finally { h.close(); }
});

test("goal-first stops at the turn boundary; a user resume cancels that pending stop", async () => {
	const h = fixture({ pauseOrder: "goal-first" });
	try {
		await h.start(); h.press(ESC); assert.equal(h.aborts(), 0);
		h.core.interruption.finishTurn(h.ctx); assert.equal(h.aborts(), 1);
		h.core.interruption.finishTurn(h.ctx); assert.equal(h.aborts(), 1);
		h.core.scheduler.resume(h.ctx); h.press(ESC);
		h.core.scheduler.resume(h.ctx); h.core.interruption.finishTurn(h.ctx);
		assert.equal(h.aborts(), 1, "an explicit resume cancels the pending goal-first stop");
	} finally { h.close(); }
});

test("preferred command spellings reach the policy without changing user objective text", async () => {
	const h = fixture({ commands: { "goal-resume": ["work continue"], "goal-tweak": ["goal edit"] } });
	try {
		await h.core.invokeGoalCommand!("goal-direct", "Document the literal /goal-resume command in a fixture.", h.ctx);
		const text = goalPrompt(h.core.state.goal!, loadSettingsSnapshot(h.cwd).value);
		assert.ok(text.includes("Only creation or user /work continue renews usage"));
		assert.ok(text.includes("ask the user to run /goal edit"));
		assert.ok(text.includes("Document the literal /goal-resume command in a fixture."));
	} finally { h.close(); }
});

test("dialog bindings are independent of live shortcuts and expose the configured hints", async () => {
	const h = fixture({ keybindings: { pause: "f6", dialog: { confirm: "f6", cancel: "f7", down: "j", up: "k" } } });
	try {
		assert.deepEqual(keybindingProblems(loadSettingsSnapshot(h.cwd).value), []);
		const controls = goalDialogControls(h.cwd);
		assert.equal(controls.matches(F6, "confirm"), true);
		assert.equal(controls.matches(ENTER, "confirm"), false);
		assert.equal(controls.matches("j", "down"), true);
		assert.equal(controls.hint("cancel"), "F7");
		assert.equal(controls.navigationHint(), "K / J");
		let result: unknown;
		let component: { handleInput?(data: string): void; render(width: number): string[] } | undefined;
		const ctx = { ...h.ctx, ui: { ...h.ctx.ui, custom: async (factory: Function) => {
			factory(createMockTUI().tui, createMockTheme(), null, (value: unknown) => { result = value; });
			return result;
		} } };
		ctx.ui.custom = async (factory: Function) => {
			component = factory(createMockTUI().tui, createMockTheme(), null, (value: unknown) => { result = value; });
			assert.match(component!.render(100).join("\n"), /F6 to select/);
			component!.handleInput!(ENTER); assert.equal(result, undefined);
			component!.handleInput!("\x1b[18~");
			return result;
		};
		await showEscapeDialog(ctx as ExtensionContext, "Custom dialog keys");
		assert.equal(result, "continue_working");
	} finally { h.close(); }
});

test("modal key capture and Kitty repeats cannot pause a goal; live key edits take effect", async () => {
	const h = fixture();
	try {
		await h.start();
		h.core.enterGoalModal(); assert.equal(h.press(ESC), undefined); h.core.exitGoalModal();
		h.mutate("project", "set", ["keybindings", "pause"], "f6");
		h.press("\x1b[57369;1:2u");
		assert.equal(h.core.state.goal?.status, "active");
		h.press(F6); assert.equal(h.core.state.goal?.status, "paused");
	} finally { h.close(); }
});

test("every command action can have a shortcut independent of its slash names", async () => {
	const h = fixture({ commands: { "goal-pause": [] }, keybindings: { commands: { "goal-pause": "f6" } }, pauseOrder: "goal-first" });
	try {
		await h.start(); h.press(F6); await Promise.resolve();
		assert.equal(h.core.state.goal?.status, "paused");
		assert.equal(h.aborts(), 1, "explicit Pause stops both, regardless of the pause-order preference");
	} finally { h.close(); }
});

test("argument-taking command shortcuts ask for input and release modal isolation on cancel or failure", async () => {
	const h = fixture({ keybindings: { commands: { "goal-direct": "f6" } } });
	try {
		let answer: string | undefined = "Create the file requested through a shortcut.";
		h.ctx.ui.input = async () => { assert.ok(h.core.goalModalDepth > 0); return answer; };
		syncTerminalInputPause(h.core, h.ctx);
		h.press(F6); await new Promise(resolve => setTimeout(resolve, 0));
		assert.equal(h.core.state.goal?.objective, answer);
		assert.equal(h.core.goalModalDepth, 0);
		const id = h.core.state.goal!.id;
		answer = undefined; h.press(F6); await new Promise(resolve => setTimeout(resolve, 0));
		assert.equal(h.core.state.goal?.id, id);
		assert.equal(h.core.goalModalDepth, 0);
		h.ctx.ui.input = async () => { throw new Error("Input closed"); };
		h.press(F6); await new Promise(resolve => setTimeout(resolve, 0));
		assert.equal(h.core.goalModalDepth, 0);
		assert.ok(h.notifications.some(message => message.includes("Input closed")));
	} finally { h.close(); }
});

function dialog(h: ReturnType<typeof fixture>, rows = 32, scope: "global" | "project" = "project") {
	const { tui } = createMockTUI({ terminalRows: rows });
	let result: "reload" | undefined, closed = false;
	const component = new GoalControlsDialog(h.core, h.ctx, tui, createMockTheme(), getKeybindings() as never, value => { result = value; closed = true; }, scope);
	const press = (...keys: string[]) => keys.forEach(key => component.handleInput(key));
	return { component, press, text: (width = 110) => component.render(width).join("\n"), result: () => result, closed: () => closed };
}

test("controls UI edits aliases without a model call, preserves cancelled input and marks reload pending", () => {
	const h = fixture();
	try {
		const d = dialog(h);
		d.press("Revise", ENTER, DOWN, ENTER, "/goal edit", ENTER);
		assert.deepEqual(loadSettingsSnapshot(h.cwd).value.commands?.["goal-tweak"], ["goal-tweak", "goal edit"]);
		assert.match(d.text(), /applies command changes/);
		const before = readFileSync(h.file, "utf8");
		d.press(ENTER, ENTER, "\x15", "/changed", ESC, ESC);
		assert.equal(readFileSync(h.file, "utf8"), before);
		assert.equal(h.messages.length, 0);
	} finally { h.close(); }
});

test("editing a prefilled command starts at its end and can replace it with Ctrl+U", () => {
	const h = fixture();
	try {
		const d = dialog(h); d.press("Resume", ENTER, ENTER, "\x15", "work continue", ENTER);
		assert.deepEqual(loadSettingsSnapshot(h.cwd).value.commands?.["goal-resume"], ["work continue"]);
	} finally { h.close(); }
});

test("controls UI records keys, blocks conflicts and supports scoped inheritance", () => {
	const h = fixture();
	try {
		const inheritedScope = dialog(h, 32, "global");
		assert.match(inheritedScope.text(), /All projects/);
		inheritedScope.component.dispose();
		const d = dialog(h);
		d.press(TAB, "Pause /", ENTER, ENTER, F6, ENTER);
		assert.deepEqual(loadSettingsSnapshot(h.cwd).value.keybindings?.pause, ["f6"]);
		d.press(ENTER, ENTER, "\x1b[65;6u", ENTER);
		assert.match(d.text(), /also assigned/);
		assert.deepEqual(loadSettingsSnapshot(h.cwd).value.keybindings?.pause, ["f6"]);
		d.press(ESC, ESC, "\x13");
		assert.match(d.text(), /All projects/);
		d.press(ENTER, ENTER, "\x1b[18~", ENTER);
		assert.match(d.text(), /Project overrides still apply/);
		assert.deepEqual(loadSettingsSnapshot(h.cwd).global.layer.keybindings?.pause, ["f7"]);
		assert.deepEqual(loadSettingsSnapshot(h.cwd).value.keybindings?.pause, ["f6"]);
		d.press("\x13", ENTER, DOWN, DOWN, DOWN, DOWN, DOWN, ENTER);
		assert.deepEqual(loadSettingsSnapshot(h.cwd).value.keybindings?.pause, ["f7"]);
		assert.equal(loadSettingsSnapshot(h.cwd).provenance.get("keybindings.pause")?.source, "global");
		// Editing a value can remove its row from the current search results.
		h.mutate("project", "set", ["keybindings", "dashboard", "scrollUp"], "f8");
		h.mutate("project", "set", ["keybindings", "dashboard", "up"], "f8");
		const filtered = dialog(h);
		filtered.press(TAB, "F8", DOWN, ENTER, DOWN, DOWN, ENTER, "\x15", "f9", ENTER);
		filtered.press(ENTER);
		assert.match(filtered.text(), /Record a replacement key/, "Enter edits the row currently highlighted after filtering");
	} finally { h.close(); }
});

test("controls reject a conflicting concurrent edit and a conflicting inherited value", () => {
	const h = fixture();
	try {
		let d = dialog(h); d.press(TAB, "Pause /", ENTER, ENTER, F6);
		h.mutate("project", "set", ["keybindings", "toggleAuditor"], "f6");
		d.press(ENTER); assert.match(d.text(), /also assigned/);
		assert.equal(loadSettingsSnapshot(h.cwd).value.keybindings?.pause, undefined);
		h.mutate("project", "unset", ["keybindings", "toggleAuditor"]);
		h.mutate("global", "set", ["keybindings", "pause"], "f6");
		h.mutate("project", "set", ["keybindings", "pause"], "f7");
		h.mutate("project", "set", ["keybindings", "toggleAuditor"], "f6");
		d = dialog(h); d.press(TAB, "Pause /", ENTER, DOWN, DOWN, DOWN, DOWN, DOWN, ENTER);
		assert.match(d.text(), /also assigned/);
		assert.equal(loadSettingsSnapshot(h.cwd).value.keybindings?.pause, "f7");
	} finally { h.close(); }
});

test("manual key editing accepts the comma key and native Pi conflicts keep input available", () => {
	const h = fixture();
	try {
		const d = dialog(h); d.press(TAB, "Pause /", ENTER, DOWN, DOWN, ENTER, "\x15", '["ctrl+,", "f6"]', ENTER);
		assert.deepEqual(loadSettingsSnapshot(h.cwd).value.keybindings?.pause, ["ctrl+,", "f6"]);
		d.press(ENTER, DOWN, DOWN, ENTER);
		assert.match(d.text(), /JSON key list/);
		d.press(ENTER);
		assert.deepEqual(loadSettingsSnapshot(h.cwd).value.keybindings?.pause, ["ctrl+,", "f6"], "an unchanged comma binding can be saved again");
		d.press(ENTER, ENTER, "\x01", ENTER);
		assert.match(d.text(), /used by Pi/);
		assert.deepEqual(loadSettingsSnapshot(h.cwd).value.keybindings?.pause, ["ctrl+,", "f6"]);
	} finally { h.close(); }
});

test("reopening pause order keeps the saved choice selected, including inherited choices", () => {
	for (const order of ["goal-first", "turn-first"] as const) {
		const h = fixture();
		try {
			h.mutate("global", "set", ["pauseOrder"], order);
			const d = dialog(h); d.press(TAB, TAB, ENTER);
			assert.match(d.text(), new RegExp(`› ${order === "goal-first" ? "Goal first" : "Turn first"}`));
			d.press(ENTER);
			assert.equal(loadSettingsSnapshot(h.cwd).value.pauseOrder, order);
		} finally { h.close(); }
	}
});

test("all command editors support replacement, aliases, disable, default and inheritance", () => {
	for (const [id, label] of GOAL_COMMANDS) {
		const h = fixture();
		try {
			h.mutate("global", "set", ["commands", id], [`custom ${id}`]);
			const d = dialog(h); d.press(label, ENTER, ENTER, "\x15", `local ${id}`, ENTER);
			assert.deepEqual(loadSettingsSnapshot(h.cwd).value.commands?.[id], [`local ${id}`], id);
			d.press(ENTER, DOWN, ENTER, `alias ${id}`, ENTER);
			assert.deepEqual(loadSettingsSnapshot(h.cwd).value.commands?.[id], [`local ${id}`, `alias ${id}`], id);
			d.press(ENTER, DOWN, DOWN, ENTER);
			assert.deepEqual(loadSettingsSnapshot(h.cwd).value.commands?.[id], [], id);
			if (id === "goal-settings") assert.match(d.text(), /recovery only/);
			d.press(ENTER, DOWN, DOWN, DOWN, ENTER);
			assert.deepEqual(loadSettingsSnapshot(h.cwd).value.commands?.[id], [id], id);
			d.press(ENTER, DOWN, DOWN, DOWN, DOWN);
			assert.match(d.text(), new RegExp(`Inherited: /custom ${id}`));
			d.press(ENTER);
			assert.deepEqual(loadSettingsSnapshot(h.cwd).value.commands?.[id], [`custom ${id}`], id);
			assert.equal(loadSettingsSnapshot(h.cwd).project.layer.commands?.[id], undefined);
			d.component.dispose();
		} finally { h.close(); }
	}
});

test("all key editors support recording, adding, manual edits, disable, default and inheritance", () => {
	for (const action of GOAL_KEY_ACTIONS) {
		const h = fixture();
		try {
			const d = dialog(h); d.press(TAB, action.path[1] === "commands" ? `Command: ${action.label}` : action.label);
			d.press(ENTER, ENTER, F6, ENTER);
			assert.deepEqual(loadSettingsSnapshot(h.cwd).provenance.get(action.path.join("."))?.value, ["f6"], action.label);
			d.press(ENTER, DOWN, ENTER, "\x1b[18~", ENTER);
			assert.deepEqual(loadSettingsSnapshot(h.cwd).provenance.get(action.path.join("."))?.value, ["f6", "f7"], action.label);
			d.press(ENTER, DOWN, DOWN, ENTER, "\x15", "f8, f9", ENTER);
			assert.deepEqual(loadSettingsSnapshot(h.cwd).provenance.get(action.path.join("."))?.value, ["f8", "f9"], action.label);
			d.press(ENTER, DOWN, DOWN, DOWN, ENTER);
			assert.deepEqual(loadSettingsSnapshot(h.cwd).provenance.get(action.path.join("."))?.value, [], action.label);
			d.press(ENTER, DOWN, DOWN, DOWN, DOWN, ENTER);
			assert.deepEqual(loadSettingsSnapshot(h.cwd).provenance.get(action.path.join("."))?.value, action.defaults, action.label);
			d.press(ENTER, DOWN, DOWN, DOWN, DOWN, DOWN, ENTER);
			assert.equal(loadSettingsSnapshot(h.cwd).provenance.get(action.path.join("."))?.source, "default", action.label);
			d.component.dispose();
		} finally { h.close(); }
	}
});

test("section reset, Back and cancellation preserve other scopes and sections", () => {
	const h = fixture();
	try {
		h.mutate("global", "set", ["commands", "goal-pause"], ["global pause"]);
		h.mutate("project", "set", ["commands", "goal-pause"], ["local pause"]);
		h.mutate("project", "set", ["keybindings", "pause"], "f6");
		h.mutate("project", "set", ["pauseOrder"], "turn-first");
		const d = dialog(h); d.press("\x1b[F", ENTER, DOWN, ENTER);
		assert.deepEqual(loadSettingsSnapshot(h.cwd).project.layer.commands?.["goal-pause"], ["local pause"], "Back does not reset");
		d.press(ENTER, ESC);
		assert.deepEqual(loadSettingsSnapshot(h.cwd).project.layer.commands?.["goal-pause"], ["local pause"], "Escape does not reset");
		d.press(ENTER, ENTER);
		assert.equal(loadSettingsSnapshot(h.cwd).project.layer.commands, undefined);
		assert.deepEqual(loadSettingsSnapshot(h.cwd).value.commands?.["goal-pause"], ["global pause"]);
		assert.equal(loadSettingsSnapshot(h.cwd).value.keybindings?.pause, "f6");
		d.press(TAB, "\x1b[F", ENTER, ENTER);
		assert.equal(loadSettingsSnapshot(h.cwd).project.layer.keybindings, undefined);
		assert.equal(loadSettingsSnapshot(h.cwd).value.pauseOrder, "turn-first");
		d.press(TAB, "\x1b[F", ENTER, ENTER);
		assert.equal(loadSettingsSnapshot(h.cwd).project.layer.pauseOrder, undefined);
		d.component.dispose();
	} finally { h.close(); }
});

test("narrow controls keep the source, selected action and navigation visible, with paging", () => {
	const h = fixture();
	try {
		for (const rows of [16, 20, 32]) for (const width of [40, 72, 110]) {
			const d = dialog(h, rows); d.press(TAB);
			assert.match(d.text(width), /Source: Default/);
			assert.match(d.text(width), /Ctrl\+S scope/);
			d.press("\x1b[6~"); assert.doesNotMatch(d.text(width), /› Pause \/ interrupt/);
			d.press("\x1b[F"); assert.match(d.text(width), /› Reset keys overrides/);
			d.press("\x1b[H"); assert.match(d.text(width), /› Pause \/ interrupt/);
			d.press(ENTER, DOWN, DOWN, DOWN, DOWN, DOWN);
			assert.match(d.text(width), /› Use inherited value/);
			d.component.dispose();
		}
	} finally { h.close(); }
});

test("every remapped slash action and command shortcut reaches its stable handler", async () => {
	for (const [id] of GOAL_COMMANDS) {
		const h = fixture({ commands: { [id]: [`work ${id}`] }, keybindings: { commands: { [id]: "f6" } } });
		try {
			const calls: unknown[] = [];
			h.core.invokeGoalCommand = async (action, args) => { calls.push([action, args]); };
			h.ctx.ui.input = async () => "From shortcut";
			await h.commands.get("work").handler(`${id}  Preserve  spaces`, h.ctx);
			assert.deepEqual(calls.shift(), [id, "Preserve  spaces"]);
			syncTerminalInputPause(h.core, h.ctx); h.press(F6);
			await new Promise(resolve => setTimeout(resolve, 0));
			assert.deepEqual(calls.shift(), [id, ["goal-direct", "sisyphus-direct", "goal-tweak"].includes(id) ? "From shortcut" : ""]);
			assert.equal(h.core.goalModalDepth, 0);
		} finally { h.close(); }
	}
});

test("custom dashboard, audit and dialog keys dispatch every advertised action", () => {
	const navigation: Record<string, string> = { scrollUp: "up", scrollDown: "down", scrollPageUp: "pageUp", scrollPageDown: "pageDown", scrollFirst: "home", scrollLast: "end", up: "up", down: "down", pageUp: "pageUp", pageDown: "pageDown", first: "home", last: "end" };
	for (const action of GOAL_KEY_ACTIONS.filter(action => action.path[1] !== "commands" && action.path[1] !== "pause")) {
		const h = fixture();
		try {
			h.mutate("project", "set", action.path, "f6");
			if (action.context === "dialog") {
				const controls = goalDialogControls(h.cwd);
				assert.equal(controls.matches(F6, action.path[2] as never), true, action.label);
				continue;
			}
			let called: string | undefined;
			h.core.isDashboardExpanded = () => action.context === "expanded";
			h.core.toggleDashboardExpanded = () => { called = "toggleExpand"; };
			h.core.toggleGoalAuditor = () => { called = "toggleAuditor"; };
			h.core.abortAudit = () => { called = "interruptAudit"; };
			if (action.context === "audit") h.core.auditProgress = {} as never;
			h.core.goalWidgetComponentRef.current = {
				handleNavigationKey: (key: string) => { called = key; return true; },
				handleCompactScrollKey: (key: string) => { called = key; return true; }, invalidate() {},
			} as never;
			syncTerminalInputPause(h.core, h.ctx);
			assert.deepEqual(h.press(F6), { consume: true }, action.label);
			const id = action.path.at(-1)!;
			assert.equal(called, id === "collapse" ? "toggleExpand" : navigation[id] ?? id, action.label);
		} finally { h.close(); }
	}
});

test("questionnaire submit, text cancellation and paging hints match remapped keys", async () => {
	const h = fixture({ keybindings: { dialog: { confirm: "f6", cancel: "f7", pageUp: "f8", pageDown: "f9" } } });
	try {
		let component: { render(width: number): string[]; handleInput(data: string): void } | undefined;
		h.ctx.ui.custom = (factory => new Promise(resolve => {
			component = factory(createMockTUI({ terminalRows: 32 }).tui, createMockTheme(), getKeybindings() as never, resolve) as typeof component;
		})) as typeof h.ctx.ui.custom;
		const question = { id: "one", question: "First?", options: ["Yes"], allowCustom: false };
		const result = runGoalQuestionnaire(h.ctx, [question, { ...question, id: "two", question: "Second?" }]);
		component!.handleInput(F6); component!.handleInput(F6);
		assert.match(component!.render(100).join("\n"), /Press F6 to submit/);
		component!.handleInput(F6); assert.equal((await result).cancelled, false);
		const textResult = runGoalQuestionnaire(h.ctx, [{ ...question, options: [] }]);
		assert.match(component!.render(100).join("\n"), /Enter to submit • Esc \/ F7 to cancel/);
		component!.handleInput("\x1b[18~"); assert.equal((await textResult).cancelled, true);
		const lines = Array.from({ length: 30 }, (_, i) => `Line ${i}`);
		const fitted = fitDialogLines(lines, 8, 1, null, { scrollTop: 0, needsFollow: false, optionRanges: [], followIndex: 0 }, value => value, "F8/F9");
		assert.match(fitted.at(-1)!, /F8\/F9 scroll/);
	} finally { h.close(); }
});

test("letter-based dialog controls preserve answer text, cursor keys and native Escape", async () => {
	const h = fixture({ keybindings: { dialog: { next: ["n", "ctrl+a"], previous: "p", cancel: "q" } } });
	try {
		const controls = goalDialogControls(h.cwd);
		assert.equal(controls.matches("n", "next"), true);
		assert.equal(controls.matches("n", "next", true), false);
		assert.equal(controls.matches("\x01", "next", true), false);
		assert.equal(controls.cancelEditing("q"), false);
		assert.equal(controls.cancelEditing(ESC), true);
		let component: { render(width: number): string[]; handleInput(data: string): void } | undefined;
		h.ctx.ui.custom = (factory => new Promise(resolve => {
			component = factory(createMockTUI({ terminalRows: 32 }).tui, createMockTheme(), getKeybindings() as never, resolve) as typeof component;
		})) as typeof h.ctx.ui.custom;
		const result = runGoalQuestionnaire(h.ctx, [{ id: "first", question: "First answer?", options: [] }, { id: "second", question: "Second answer?", options: [] }]);
		for (const letter of "qnp") component!.handleInput(letter);
		assert.match(component!.render(100).join("\n"), /qnp/);
		component!.handleInput("\x01"); component!.handleInput("a"); component!.handleInput("\x05");
		assert.match(component!.render(100).join("\n"), /aqnp/);
		component!.handleInput(ENTER);
		assert.match(component!.render(100).join("\n"), /Second answer/);
		component!.handleInput(ESC); component!.handleInput("q");
		assert.equal((await result).cancelled, true);
	} finally { h.close(); }
});

test("controls UI previews pause order and remains bounded throughout editing", () => {
	const h = fixture();
	try {
		for (const rows of [16, 20, 32]) for (const width of [40, 72, 110]) {
			const d = dialog(h, rows);
			for (const keys of [[], [TAB], [TAB], [ENTER], [DOWN], [ESC], [TAB], [ENTER], [ENTER]]) {
				d.press(...keys);
				const rendered = d.component.render(width);
				assert.ok(rendered.length <= Math.max(12, rows - 7), `${width}x${rows}: ${rendered.length} lines`);
				assert.ok(rendered.every(line => visibleWidth(line) <= width), `${width}x${rows}: width overflow`);
			}
			d.component.dispose();
		}
		const d = dialog(h); d.press(TAB, TAB, ENTER, DOWN, DOWN, ENTER);
		assert.equal(loadSettingsSnapshot(h.cwd).value.pauseOrder, "turn-first");
		assert.match(d.text(), /First: stop the turn/);
	} finally { h.close(); }
});

test("all advertised public shortcut paths are parsed and resolved", () => {
	const h = fixture();
	try {
		for (const action of GOAL_KEY_ACTIONS) {
			h.mutate("project", "set", action.path, ["f10"]);
			assert.deepEqual(loadSettingsSnapshot(h.cwd).provenance.get(action.path.join("."))?.value, ["f10"]);
			h.mutate("project", "unset", action.path);
		}
	} finally { h.close(); }
});
