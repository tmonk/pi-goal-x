import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createGoalCore } from "../extensions/goal-state.ts";
import { syncTerminalInputPause } from "../extensions/goal-terminal-input.ts";
import { mutateSettingsLayer } from "../extensions/goal-settings.ts";
import { createGoal, goalFocusDetails } from "../extensions/goal-record.ts";
import { writeActiveGoalFile } from "../extensions/storage/goal-files.ts";

for (const focused of [false, true]) test(`deferred widget render survives stale context (focused=${focused})`, async t => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "goal-widget-lifetime-"));
	t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
	const goal = writeActiveGoalFile({ cwd }, createGoal({ objective: "Keep working", autoContinue: true, sisyphus: false }));
	let stale = false;
	const factories: Function[] = [];
	const core = createGoalCore({ getActiveTools: () => [], setActiveTools: () => {}, appendEntry: () => {} } as any);
	const ctx = new Proxy({
		cwd, hasUI: true,
		ui: { setStatus: () => {}, setWidget: (_key: string, factory: unknown) => { if (typeof factory === "function") factories.push(factory); } },
		sessionManager: { getSessionId: () => "test", getBranch: () => focused ? [{ type: "custom", customType: "pi-goal-focus", data: goalFocusDetails(goal.id, "created") }] : [] },
	}, { get(target, property) { if (stale) throw new Error(`stale context access: ${String(property)}`); return Reflect.get(target, property); } }) as unknown as ExtensionContext;
	await core.loadState(ctx);
	core.updateUI(ctx);
	await Promise.resolve();
	assert.ok(factories.length > 0);
	const component = factories.at(-1)!({ requestRender() {}, terminal: { rows: 40, columns: 100 } }, { fg: (_: string, text: string) => text, bold: (text: string) => text });
	core.updateUI(ctx);
	core.clearGoalWidget(ctx);
	stale = true;
	await Promise.resolve();
	core.toggleDashboardExpanded();
	assert.doesNotThrow(() => component.render(100));
	const nextCwd = fs.mkdtempSync(path.join(os.tmpdir(), "goal-widget-replacement-"));
	t.after(() => fs.rmSync(nextCwd, {recursive: true, force: true}));
	const nextGoal = writeActiveGoalFile({cwd: nextCwd}, createGoal({objective: "Replacement objective", autoContinue: true, sisyphus: false}));
	const nextCtx = {cwd: nextCwd, hasUI: true, ui: {setStatus() {}, setWidget: (_key: string, factory: unknown) => { if (typeof factory === "function") factories.push(factory); }}, sessionManager: {getSessionId: () => "replacement", getBranch: () => [{type: "custom", customType: "pi-goal-focus", data: goalFocusDetails(nextGoal.id, "created")}]}} as unknown as ExtensionContext;
	const count = factories.length;
	await core.loadState(nextCtx);
	core.updateUI(nextCtx);
	await Promise.resolve();
	assert.ok(factories.length > count, "replacement re-registers the widget");
	assert.equal(core.state.goal?.id, nextGoal.id);
	const nextComponent = factories.at(-1)!({requestRender() {}, terminal: {rows: 40, columns: 100}}, {fg: (_: string, text: string) => text, bold: (text: string) => text});
	assert.match(nextComponent.render(100).join("\n"), /Replacement objective/);
});

test("registered dashboard widget receives scroll keys and releases its reference", async t => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "goal-widget-scroll-"));
	t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
	const goal = createGoal({ objective: "Scroll tasks", autoContinue: false, sisyphus: false });
	goal.taskList = {
		tasks: Array.from({ length: 30 }, (_, index) => ({ id: `task-${index}`, title: `Task ${index}`, status: "pending" as const })),
		blockCompletion: false,
		proposedAt: goal.createdAt,
	};
	writeActiveGoalFile({ cwd }, goal);

	let onInput: ((data: string) => { consume?: boolean } | undefined) | undefined;
	const core = createGoalCore({ getActiveTools: () => [], setActiveTools: () => {}, appendEntry: () => {} } as any);
	const ctx = {
		cwd, hasUI: true,
		ui: {
			setStatus() {},
			setWidget(_key: string, factory: unknown) {
				if (typeof factory === "function") factory({ requestRender() {} }, { fg: (_: string, text: string) => text, bold: (text: string) => text });
			},
			onTerminalInput(callback: typeof onInput) { onInput = callback; return () => {}; },
		},
		sessionManager: { getSessionId: () => "scroll-test", getBranch: () => [{ type: "custom", customType: "pi-goal-focus", data: goalFocusDetails(goal.id, "created") }] },
	} as unknown as ExtensionContext;
	await core.loadState(ctx);
	core.updateUI(ctx);
	await Promise.resolve();
	const component = core.goalWidgetComponentRef.current;
	assert.ok(component, "setWidget factory must expose the live component to the input handler");
	component.render(100);
	syncTerminalInputPause(core, ctx);
	assert.equal(onInput?.("\x1b[1;6B")?.consume, true);
	assert.match(component.render(100).join("\n"), /↑ 1 more task/);
	assert.equal(onInput?.("\x1b[116;6u")?.consume, true);
	assert.equal(core.isDashboardExpanded(), true);
	assert.equal(onInput?.("\x1b[B")?.consume, true);
	assert.match(component.render(100).join("\n"), /↑ 1 more task/);
	mutateSettingsLayer({ scope: "project", cwd, mutation: { op: "set", path: ["keybindings", "dashboard", "toggleExpand"], value: "ctrl+alt+t" } });
	assert.equal(onInput?.("\x1b[116;6u")?.consume, undefined, "the previous binding must stop toggling after a settings edit");
	assert.equal(onInput?.("\x1b[116;7u")?.consume, true, "the new binding must work without restarting the session");
	assert.equal(core.isDashboardExpanded(), false);

	core.clearGoalWidget(ctx);
	assert.equal(core.goalWidgetComponentRef.current, null);
	assert.equal(onInput?.("\x1b[1;6B")?.consume, undefined);
});
