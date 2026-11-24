import assert from "node:assert/strict";
import test from "node:test";

import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { renderGoalWidgetLines, renderAuditorWidgetLines, renderAuditResultCardView, GoalWidgetComponent, applyStableHeightBound, type GoalWidgetRecord, type AuditorWidgetProgress } from "../extensions/widgets/goal-widget.ts";
import type { GoalTask } from "../extensions/goal-record.ts";
import { createMockTUI, createMockTheme } from "./tui-test-utils.ts";
import { createGoal } from "../extensions/goal-record.ts";
import { newGoalScheduler } from "../extensions/goal-scheduler-state.ts";
import { deriveGoalDashboardModel } from "../extensions/widgets/goal-dashboard-model.ts";

const theme = {
	fg: (_color: string, value: string) => value,
	bold: (value: string) => value,
} as Theme;

function goal(overrides: Partial<GoalWidgetRecord> = {}): GoalWidgetRecord {
	return {
		id: "test-goal-001",
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		objective: "=== Goal ===\nObjective: Componentize the goal widget\nSuccess criteria: tests pass",
		status: "active",
		autoContinue: true,
		usage: { activeSeconds: 65, tokensUsed: 2500 },
		sisyphus: true,
		activePath: ".pi/goals/active_goal.md",
		...overrides,
	};
}

function auditorProgress(overrides: Partial<AuditorWidgetProgress> = {}): AuditorWidgetProgress {
	return {
		currentTool: "read",
		currentToolArgs: '{"path":"test.txt"}',
		currentToolStartedAt: Date.now() - 5000,
		recentOutput: ["checking file exists...", "confirming test coverage..."],
		phase: "tool_executing",
		elapsedMs: 5000,
		...overrides,
	};
}

test("renderGoalWidgetLines renders the unified compact dashboard", () => {
	const lines = renderGoalWidgetLines(goal(), theme, 100);
	assert.match(lines[0]!, /^╭─ pi-goal-x ─ Componentize the goal widget/);
	assert.doesNotMatch(lines[0]!, /1m05s/, "usage moved from the header into the status line");
	assert.match(lines[1]!, /goal: sisyphus running \[1m05s 2\.5K\]/);
	assert.match(lines.at(-1) ?? "", /^╰─ .*Ctrl\+Shift\+T: expand/);
});

for (const width of [72, 110]) test(`idle pacing preserves compact height and controls at ${width} columns`, () => {
	const current = createGoal({ objective: "Finish the report", autoContinue: true, sisyphus: false });
	current.activePath = ".pi/goals/report.md";
	const state = { stickyCap: undefined as number | undefined, stickyRegime: undefined as string | undefined, stickyTerminalRows: undefined as number | undefined };
	const model = () => deriveGoalDashboardModel(current, { focused: true, otherOpenGoals: 0, idleContinuationBackoff: true });
	const initial = renderGoalWidgetLines(current, theme, width, { model: model() });
	const first = applyStableHeightBound(initial, 32, state, "same-goal");
	current.scheduler = { ...newGoalScheduler("test"), phase: "ready", decision: { kind: "ready", purpose: "ready" }, idle: { runs: 2, nextAt: Date.now() + 30000 } };
	const paced = renderGoalWidgetLines(current, theme, width, { model: model() });
	const visible = applyStableHeightBound(paced, 32, state, "same-goal");
	assert.equal(visible.length, first.length);
	assert.match(visible.join("\n"), /Next automatic attempt in .*\/goal-resume/);
	assert.match(visible.at(-1)!, /^╰─ .*Ctrl\+Shift\+T/);
	assert.ok(visible.every(line => visibleWidth(line) <= width));
});

test("renderGoalWidgetLines shows the complete state", () => {
	const lines = renderGoalWidgetLines(goal({
		status: "complete",
		autoContinue: false,
		sisyphus: false,
		archivedPath: ".pi/goals/archived/goal.md",
	}), theme, 100);
	assert.match(lines.join("\n"), /All required work is complete/);
});


test("renderGoalWidgetLines highlights blocked state with reason and action", () => {
	const lines = renderGoalWidgetLines(goal({
		status: "blocked",
		autoContinue: false,
		pauseReason: "Missing API token",
		pauseSuggestedAction: "Set TOKEN and run /goal-resume",
	}), theme, 100);
	assert.match(lines.join("\n"), /goal: sisyphus blocked/);
	assert.match(lines.join("\n"), /Blocker  Missing API token/);
	assert.match(lines.join("\n"), /Action   Set TOKEN and run \/goal-resume/);
});

test("renderGoalWidgetLines shows paused reason and who paused", () => {
	const lines = renderGoalWidgetLines(goal({
		status: "paused",
		autoContinue: false,
		stopReason: "agent",
		pauseReason: "waiting on the user",
	}), theme, 100);
	assert.match(lines.join("\n"), /goal: sisyphus paused \(agent\)/);
	assert.match(lines.join("\n"), /Reason   waiting on the user/);
});

test("renderGoalWidgetLines shows other open goals and unfocused multi-goal guidance", () => {
	const focused = renderGoalWidgetLines(goal(), theme, 100, { openGoalCount: 3 });
	assert.match(focused[1]!, /goal: sisyphus running \[1m05s 2\.5K\] \(\+2 open\)/);

	const unfocused = renderGoalWidgetLines(null, theme, 100, { openGoalCount: 2 });
	assert.match(unfocused[0]!, /^╭─ pi-goal-x ─ Goal focus required/);
	assert.match(unfocused.join("\n"), /2 open goals are available/);
	assert.match(unfocused.join("\n"), /\/goal-focus/);
});

test("renderAuditorWidgetLines shows the structured audit dashboard (§15.3)", () => {
	const progress = auditorProgress({ auditorLabel: "anthropic/claude" });
	const lines = renderAuditorWidgetLines(progress, theme, 100);
	assert.match(lines[0]!, /Independent completion audit ─ anthropic\/claude/);
	// Five check stages in order.
	const text = lines.join("\n");
	assert.ok(text.indexOf("Objective and success criteria") < text.indexOf("Verification contracts"));
	assert.ok(text.indexOf("Verification contracts") < text.indexOf("Tasks and recorded evidence"));
	assert.ok(text.indexOf("Tasks and recorded evidence") < text.indexOf("Workspace inspection"));
	assert.ok(text.indexOf("Workspace inspection") < text.indexOf("Final decision"));
	// Active audit footer.
	assert.match(lines.at(-1) ?? "", /Esc: stop audit/);
	// Tool + output details are hidden by default (shown only in expanded/debug).
	assert.doesNotMatch(text, /tool read/);
	assert.doesNotMatch(text, /checking file exists/);
});

test("renderAuditorWidgetLines shows tool and output details in expanded/debug mode", () => {
	const progress = auditorProgress();
	const lines = renderAuditorWidgetLines(progress, theme, 100, { showToolDetails: true });
	const text = lines.join("\n");
	assert.match(text, /tool read/);
	assert.match(text, /test\.txt/);
	assert.match(text, /checking file exists/);
});

test("renderAuditorWidgetLines drives check states from percentage bands (§15.2)", () => {
	const progress = auditorProgress({ phase: "running", percentage: 72, recentOutput: [] });
	const lines = renderAuditorWidgetLines(progress, theme, 100);
	const text = lines.join("\n");
	assert.match(text, /✓ Objective and success criteria/);
	assert.match(text, /✓ Verification contracts/);
	assert.match(text, /✓ Tasks and recorded evidence/);
	assert.match(text, /◌ Workspace inspection/);
	assert.match(text, /· Final decision/);
	assert.match(text, /72%/);
});

test("renderAuditorWidgetLines shows the progress bar at 0% and 100%", () => {
	const zero = renderAuditorWidgetLines(auditorProgress({ phase: "running", percentage: 0, recentOutput: [] }), theme, 100).join("\n");
	assert.match(zero, /0%/);
	const hundred = renderAuditorWidgetLines(auditorProgress({ phase: "running", percentage: 100, recentOutput: [] }), theme, 100).join("\n");
	assert.match(hundred, /100%/);
});

test("renderAuditorWidgetLines shows no percentage when undefined", () => {
	const progress = auditorProgress({ phase: "running", label: "Working..." });
	const lines = renderAuditorWidgetLines(progress, theme, 100);
	assert.match(lines.join("\n"), /Working/);
	assert.doesNotMatch(lines.join("\n"), /\d+%/);
});

test("renderAuditorWidgetLines shows the done phase without the stop hint", () => {
	const progress = auditorProgress({ phase: "done", currentTool: undefined, currentToolArgs: undefined, recentOutput: [] });
	const lines = renderAuditorWidgetLines(progress, theme, 100);
	assert.doesNotMatch(lines.join("\n"), /Esc: stop audit/);
});

test("audit progress overrides normal goal display when provided", () => {
	const progress = auditorProgress();
	const lines = renderGoalWidgetLines(goal(), theme, 100, { auditorProgress: progress });
	assert.match(lines[0]!, /Independent completion audit/);
	assert.doesNotMatch(lines[0]!, /pi-goal-x ─/);
});

test("finished audit shows the result card view (§15.4)", () => {
	const approved = renderAuditResultCardView({ verdict: "approved", report: "ok" }, theme, 100);
	assert.match(approved[0]!, /Audit result ─ APPROVED/);
	const approvedText = approved.join("\n");
	assert.match(approvedText, /✓ Objective satisfied\./);
	assert.match(approvedText, /✓ Verification requirements satisfied\./);
	assert.match(approvedText, /✓ Required tasks and evidence accepted\./);

	const rejected = renderAuditResultCardView({ verdict: "disapproved", report: "- Tests were not run after the final change.\n- Task \"docs\" has no evidence." }, theme, 100);
	const rejectedText = rejected.join("\n");
	assert.match(rejectedText, /Audit result ─ CHANGES REQUIRED/);
	assert.match(rejectedText, /✗ Tests were not run after the final change\./);
	assert.match(rejectedText, /✗ Task "docs" has no evidence\./);
});

const testProposedAt = "2026-01-01T00:00:00.000Z";

test("renderGoalWidgetLines shows top-level task progress (§9.1, skipped counts as done)", () => {
	const lines = renderGoalWidgetLines(goal({
		taskList: {
			tasks: [
				{ id: "t1", title: "Task 1", status: "complete" },
				{ id: "t2", title: "Task 2", status: "pending" },
				{ id: "t3", title: "Task 3", status: "skipped" },
			],
			blockCompletion: false,
			proposedAt: testProposedAt,
		},
	}), theme, 100);
	assert.match(lines.join("\n"), /Tasks · ✓2 done · 1 open/);
});

test("renderGoalWidgetLines shows the current task (first pending, inferred)", () => {
	const lines = renderGoalWidgetLines(goal({
		taskList: {
			tasks: [
				{ id: "t1", title: "Task 1", status: "complete" },
				{ id: "t2", title: "Task 2", status: "pending" },
				{ id: "t3", title: "Task 3", status: "pending" },
			],
			blockCompletion: false,
			proposedAt: testProposedAt,
		},
	}), theme, 100);
	const body = lines.join("\n");
	assert.match(body, /Tasks · ✓1 done · 2 open/);
	assert.match(body, /Current  t2 · Task 2/);
});

test("renderGoalWidgetLines shows 'All tasks complete' when all done (§9.4)", () => {
	const lines = renderGoalWidgetLines(goal({
		taskList: {
			tasks: [
				{ id: "t1", title: "Task 1", status: "complete" },
				{ id: "t2", title: "Task 2", status: "skipped" },
			],
			blockCompletion: false,
			proposedAt: testProposedAt,
		},
	}), theme, 100);
	assert.match(lines.join("\n"), /Tasks · ✓2 done · 0 open/);
	assert.match(lines.join("\n"), /Current  All tasks complete/);
});

test("renderGoalWidgetLines omits task rows when no taskList", () => {
	const lines = renderGoalWidgetLines(goal(), theme, 100);
	const body = lines.join("\n");
	assert.equal(body.includes("Tasks"), false);
	assert.equal(body.includes("Current"), false);
});

// ── Subtask widget display ──────────────────────────────────────────────

test("renderGoalWidgetLines shows subtask progress for the current parent task (§9.3)", () => {
	const lines = renderGoalWidgetLines(goal({
		currentTaskId: "t1",
		taskList: {
			tasks: [{
				id: "t1", title: "Parent", status: "pending",
				subtasks: [
					{ id: "t1a", title: "Child", status: "complete" },
					{ id: "t1b", title: "Child2", status: "complete" },
				],
			}],
			blockCompletion: false,
			proposedAt: testProposedAt,
		},
	}), theme, 100);
	assert.match(lines.join("\n"), /· Sub 2\/2 \[.*\]/, "subtask bar sits beside the task bar in the header");
});

test("renderGoalWidgetLines infers a pending subtask as current at any depth", () => {
	const lines = renderGoalWidgetLines(goal({
		taskList: {
			tasks: [{
				id: "t1", title: "Parent", status: "complete",
				subtasks: [
					{ id: "t1a", title: "Child", status: "pending" },
				],
			}],
			blockCompletion: false,
			proposedAt: testProposedAt,
		},
	}), theme, 100);
	const body = lines.join("\n");
	assert.match(body, /Current  t1a · Child/);
});

test("renderGoalWidgetLines shows all complete when subtasks are done", () => {
	const lines = renderGoalWidgetLines(goal({
		taskList: {
			tasks: [{
				id: "t1", title: "Parent", status: "complete",
				subtasks: [
					{ id: "t1a", title: "Child", status: "complete" },
				],
			}],
			blockCompletion: false,
			proposedAt: testProposedAt,
		},
	}), theme, 100);
	const body = lines.join("\n");
	assert.match(body, /Current  All tasks complete/);
});

test("renderGoalWidgetLines suppresses task info when disableTasks is true with subtasks (§9.5)", () => {
	const lines = renderGoalWidgetLines(goal({
		taskList: {
			tasks: [{
				id: "t1", title: "Parent", status: "pending",
				subtasks: [{ id: "t1a", title: "Child", status: "pending" }],
			}],
			blockCompletion: false,
			proposedAt: testProposedAt,
		},
	}), theme, 100, { disableTasks: true });
	const body = lines.join("\n");
	assert.equal(body.includes("Tasks"), false);
	assert.equal(body.includes("t1a"), false);
	assert.equal(body.includes("Current"), false);
});

// ── TUI rendering path: GoalWidgetComponent ───────────────────────────

test("GoalWidgetComponent renders through mock TUI path", () => {
	const { tui } = createMockTUI();
	const component = new GoalWidgetComponent({
		tui,
		theme: createMockTheme(),
		getGoal: () => goal(),
		getOpenGoalCount: () => 1,
		getSettings: () => ({}),
	});

	const lines = component.render(100);
	assert.ok(lines.length > 0, "Component renders lines");
	assert.match(lines[0]!, /^╭─ pi-goal-x ─ Componentize the goal widget/);
	assert.match(lines[1]!, /goal: sisyphus running \[1m05s 2\.5K\]/);
});

test("GoalWidgetComponent shows open goal count when > 1", () => {
	const { tui } = createMockTUI();
	const component = new GoalWidgetComponent({
		tui,
		theme: createMockTheme(),
		getGoal: () => goal(),
		getOpenGoalCount: () => 3,
		getSettings: () => ({}),
	});

	const lines = component.render(100);
	const text = lines.join("\n");
	assert.match(text, /goal: sisyphus running \[1m05s 2\.5K\] \(\+2 open\)/);
});

test("GoalWidgetComponent update triggers requestRender", () => {
	const { tui, state } = createMockTUI();
	const component = new GoalWidgetComponent({
		tui,
		theme: createMockTheme(),
		getGoal: () => goal(),
		getOpenGoalCount: () => 1,
		getSettings: () => ({}),
	});

	const before = state.requestRenderCalls;
	component.update();
	assert.ok(state.requestRenderCalls > before, "update() triggers requestRender");
});

test("GoalWidgetComponent invalidate triggers requestRender", () => {
	const { tui, state } = createMockTUI();
	const component = new GoalWidgetComponent({
		tui,
		theme: createMockTheme(),
		getGoal: () => goal(),
		getOpenGoalCount: () => 1,
		getSettings: () => ({}),
	});

	const before = state.requestRenderCalls;
	component.invalidate();
	assert.ok(state.requestRenderCalls > before, "invalidate() triggers requestRender");
});

test("GoalWidgetComponent renders the audit dashboard when audit progress is present", () => {
	const { tui } = createMockTUI();
	const component = new GoalWidgetComponent({
		tui,
		theme: createMockTheme(),
		getGoal: () => goal(),
		getOpenGoalCount: () => 1,
		getAuditorProgress: () => ({
			currentTool: "read",
			currentToolArgs: '{"path":"test.txt"}',
			currentToolStartedAt: Date.now() - 5000,
			recentOutput: ["checking..."],
			phase: "tool_executing",
			elapsedMs: 5000,
		}),
		getSettings: () => ({}),
	});

	const lines = component.render(100);
	const text = lines.join("\n");
	assert.match(text, /Independent completion audit/);
	assert.match(text, /Objective and success criteria/);
	// Tool details are hidden unless the dashboard is expanded (debug/audit mode).
	assert.doesNotMatch(text, /tool read/);
});

test("GoalWidgetComponent renders with disableTasks setting", () => {
	const { tui } = createMockTUI();
	const component = new GoalWidgetComponent({
		tui,
		theme: createMockTheme(),
getGoal: () => goal({
			taskList: {
				tasks: [{ id: "t1", title: "Task 1", status: "pending" }],
				blockCompletion: false,
				proposedAt: "2026-01-01T00:00:00.000Z",
			},
		}),
		getOpenGoalCount: () => 1,
		getSettings: () => ({ disableTasks: true }),
	});

	const lines = component.render(100);
	const text = lines.join("\n");
	assert.equal(text.includes("Tasks"), false, "Tasks hidden when disableTasks is true");
	assert.equal(text.includes("Current"), false, "Current hidden when disableTasks is true");
});

test("GoalWidgetComponent shows completed goal status", () => {
	const { tui } = createMockTUI();
	const component = new GoalWidgetComponent({
		tui,
		theme: createMockTheme(),
		getGoal: () => goal({ status: "complete", archivedPath: ".pi/goals/archived/g.md", sisyphus: false }),
		getOpenGoalCount: () => 1,
		getSettings: () => ({}),
	});

	const lines = component.render(100);
	assert.match(lines.join("\n"), /All required work is complete/);
});

for (const width of [50, 70, 100, 109, 120]) {
	test(`GoalWidgetComponent safety net at width ${width} with long content`, () => {
		const { tui } = createMockTUI();
		const component = new GoalWidgetComponent({
			tui,
			theme: createMockTheme(),
			getGoal: () => goal({
				objective: "x".repeat(500),
				activePath: "/very/long/path/that/should/definitely/be/truncated/because/it/exceeds/the/available/width/by/a/lot/and/would/cause/a/crash/if/not/truncated".repeat(3),
			}),
			getOpenGoalCount: () => 8,
			getSettings: () => ({}),
		});

		const lines = component.render(width);
		for (let i = 0; i < lines.length; i++) {
			assert.ok(
				visibleWidth(lines[i]!) <= width,
				`Line ${i} has visible width ${visibleWidth(lines[i]!)} > ${width}: ${JSON.stringify(lines[i]!.slice(0, 80))}`,
			);
		}
	});
}

test("GoalWidgetComponent with auditor progress at width 109 (crash regression)", () => {
	const { tui } = createMockTUI();
	const width = 109; // Matches the crash terminal width
	const component = new GoalWidgetComponent({
		tui,
		theme: createMockTheme(),
		getGoal: () => goal({
			objective: "Achieve full end-to-end test suite pass on Linux x86_64 with 100% vendor parity — all e2e pass (no skips). The constraints should be exactly those as per the design document and the previous goals. We need to dissassemble the vendor's implementation live, stepping through, to ensure we implement this in full.".repeat(2),
			activePath: "/Users/tom/projects/some-very-long-project-path-that-exceeds-terminal-width/when-combined-with-prefix-characters/and-wrapping-scenarios/src/extremely/nested/deeply/nested/module/that/makes/this/really/long/really/long/really/long.ts".repeat(2),
		}),
		getOpenGoalCount: () => 1,
		getSettings: () => ({}),
		getAuditorProgress: () => ({
			phase: "thinking" as const,
			label: "Very long auditor label that should not cause an overflow even when rendered at narrow terminal width with all the prefixes and padding",
			percentage: 45,
			recentOutput: [],
			elapsedMs: 5000,
		}),
	});

	const lines = component.render(width);
	for (let i = 0; i < lines.length; i++) {
		assert.ok(
			lines[i] === "" || visibleWidth(lines[i]!) <= width,
			`Line ${i} has visible width ${visibleWidth(lines[i]!)} > ${width}: ${JSON.stringify(lines[i]!.slice(0, 80))}`,
		);
	}
});

test("GoalWidgetComponent unfocused with 38 open goals at width 109", () => {
	const { tui } = createMockTUI();
	const width = 109;
	const component = new GoalWidgetComponent({
		tui,
		theme: createMockTheme(),
		getGoal: () => null,
		getOpenGoalCount: () => 38,
		getSettings: () => ({}),
	});

	const lines = component.render(width);
	for (let i = 0; i < lines.length; i++) {
		assert.ok(
			lines[i] === "" || visibleWidth(lines[i]!) <= width,
			`Line ${i} has visible width ${visibleWidth(lines[i]!)} > ${width}: ${JSON.stringify(lines[i]!.slice(0, 80))}`,
		);
	}
});

// ── §19.5 dashboard interaction tests ────────────────────────────────────────

import { syncTerminalInputPause } from "../extensions/goal-terminal-input.ts";

const CTRL_SHIFT_T = "\u001b[27;6;84~";
const CTRL_SHIFT_A = "\u001b[27;6;65~";

function keybindingHarness(initialExpanded = false) {
	let expanded = initialExpanded;
	const consumed: string[] = [];
	let inputCb: ((data: string) => unknown) | undefined;
	const subscriptions = new Set<(data: string) => unknown>();
	const ctx = {
		hasUI: true,
		ui: {
			onTerminalInput: (cb: unknown) => {
				inputCb = cb as (data: string) => unknown;
				subscriptions.add(inputCb);
				return () => { subscriptions.delete(cb as (data: string) => unknown); };
			},
			notify: () => {},
		},
	} as never;
	const core = {
		goalModalDepth: 0,
		auditProgress: null,
		state: { goal: null },
		pauseActiveGoal: () => { consumed.push("pause"); },
		interruption: { pause: () => { consumed.push("pause"); } },
		abortAudit: () => { consumed.push("abort-audit"); },
		isDashboardExpanded: () => expanded,
		toggleDashboardExpanded: () => { expanded = !expanded; consumed.push("toggle"); },
		toggleGoalAuditor: () => { consumed.push("toggle-auditor"); },
		goalWidgetComponentRef: { current: { invalidate: () => { consumed.push("invalidate"); } } },
		terminalInputUnsubscribe: null,
	} as never;
	syncTerminalInputPause(core as never, ctx as never);
	return {
		core,
		fire: (data: string) => inputCb?.(data),
		resync: () => syncTerminalInputPause(core as never, ctx as never),
		listenerCount: () => subscriptions.size,
		expanded: () => expanded,
		consumed,
	};
}

test("re-registering terminal input replaces the old listener", () => {
	const h = keybindingHarness();
	assert.equal(h.listenerCount(), 1);
	h.resync();
	assert.equal(h.listenerCount(), 1);
	h.fire(CTRL_SHIFT_T);
	assert.deepEqual(h.consumed, ["toggle"]);
});

test("compact mode is the default and the task shortcut expands and collapses", () => {
	const h = keybindingHarness();
	const compact = renderGoalWidgetLines(goal({ taskList: { tasks: [{ id: "t1", title: "T1", status: "pending" }], blockCompletion: false, proposedAt: testProposedAt } }), theme, 100);
	assert.match(compact.join("\n"), /Ctrl\+Shift\+T: expand tasks/);

	h.fire(CTRL_SHIFT_T);
	assert.equal(h.expanded(), true, "ctrl+shift+t expands the dashboard");
	h.fire(CTRL_SHIFT_T);
	assert.equal(h.expanded(), false, "the same shortcut collapses it");
	assert.deepEqual(h.consumed, ["toggle", "toggle"]);
});

test("one Kitty key press toggles the dashboard once despite repeat and release events", () => {
	const h = keybindingHarness();
	assert.deepEqual(h.fire("\x1b[116;6:1u"), { consume: true });
	assert.equal(h.expanded(), true);
	h.fire("\x1b[116;6:2u");
	h.fire("\x1b[116;6:3u");
	assert.equal(h.expanded(), true);
	assert.deepEqual(h.consumed, ["toggle"]);
});

test("one Kitty scroll key press advances one task despite repeat and release events", () => {
	const h = scrollHarness(false);
	h.component.render(100);
	h.fire("\x1b[1;6:1B");
	h.fire("\x1b[1;6:2B");
	h.fire("\x1b[1;6:3B");
	assert.match(h.component.render(100).join("\n"), /↑ 16 more tasks/);
});

test("escape collapses the expanded dashboard instead of pausing", () => {
	const h = keybindingHarness(true);
	h.fire("\u001b");
	assert.equal(h.expanded(), false, "escape collapses the expanded dashboard");
	assert.deepEqual(h.consumed, ["toggle"]);
	assert.equal(h.consumed.includes("pause"), false, "escape while expanded must not pause the goal");
});

test("repeated Escape after collapsing does not pause the goal", () => {
	const h = keybindingHarness(true);
	(h.core as unknown as { state: { goal: unknown } }).state.goal = { status: "active", autoContinue: true };
	h.fire("\x1b[27;1:1u");
	h.fire("\x1b[27;1:2u");
	h.fire("\x1b[27;1:3u");
	assert.deepEqual(h.consumed, ["toggle"]);
});

test("escape still pauses a running goal when the dashboard is compact", () => {
	const h = keybindingHarness(false);
	(h.core as unknown as { state: { goal: unknown } }).state.goal = { status: "active", autoContinue: true };
	h.fire("\u001b");
	assert.deepEqual(h.consumed, ["pause"]);
});

test("ctrl+shift+a toggles the focused goal's auditor and refreshes the widget", () => {
	const h = keybindingHarness();
	(h.core as unknown as { state: { goal: unknown } }).state.goal = { status: "active", autoContinue: true };
	h.fire(CTRL_SHIFT_A);
	assert.deepEqual(h.consumed, ["toggle-auditor", "invalidate"], "auditor toggle + widget refresh");
	assert.equal(h.expanded(), false, "auditor toggle must not expand the dashboard");
});

test("ctrl+shift+a is inert while a goal modal is open", () => {
	const h = keybindingHarness();
	(h.core as unknown as { goalModalDepth: number }).goalModalDepth = 1;
	(h.core as unknown as { state: { goal: unknown } }).state.goal = { status: "active", autoContinue: true };
	h.fire(CTRL_SHIFT_A);
	assert.deepEqual(h.consumed, [], "modal depth guard swallows the chord");
});

test("expanded mode renders the full dashboard without mutating editor state", () => {
	const { tui } = createMockTUI();
	const g = goal({ taskList: { tasks: [{ id: "t1", title: "T1", status: "pending" }], blockCompletion: false, proposedAt: testProposedAt } });
	const expanded = { current: false };
	const component = new GoalWidgetComponent({
		tui,
		theme: createMockTheme(),
		getGoal: () => g,
		getOpenGoalCount: () => 1,
		getExpanded: () => expanded.current,
		getSettings: () => ({}),
	});
	const compactLines = component.render(100);
	expanded.current = true;
	const expandedLines = component.render(100);
	const text = expandedLines.join("\n");
	assert.match(text, /├─ Tasks /);
	assert.match(text, /Esc\/Ctrl\+Shift\+T: collapse/);
	// Rendering is pure: re-rendering returns identical lines.
	assert.deepEqual(component.render(100), expandedLines);
	expanded.current = false;
	assert.deepEqual(component.render(100), compactLines, "collapsing returns the compact view");
});

test("goal state updates are visible in both modes", () => {
	const { tui } = createMockTUI();
	let current = goal({ objective: "=== Goal ===\nObjective: First objective" });
	const expanded = { current: false };
	const component = new GoalWidgetComponent({
		tui,
		theme: createMockTheme(),
		getGoal: () => current,
		getOpenGoalCount: () => 1,
		getExpanded: () => expanded.current,
		getSettings: () => ({}),
	});
	assert.match(component.render(100).join("\n"), /First objective/);
	current = goal({ objective: "=== Goal ===\nObjective: Second objective" });
	assert.match(component.render(100).join("\n"), /Second objective/);
	expanded.current = true;
	assert.match(component.render(100).join("\n"), /Second objective/, "expanded mode sees updated state");
});

test("audit mode temporarily replaces the normal view and returns after", () => {
	const { tui } = createMockTUI();
	let audit: AuditorWidgetProgress | null = auditorProgress();
	const component = new GoalWidgetComponent({
		tui,
		theme: createMockTheme(),
		getGoal: () => goal(),
		getOpenGoalCount: () => 1,
		getAuditorProgress: () => audit,
		getSettings: () => ({}),
	});
	const during = component.render(100).join("\n");
	assert.match(during, /Independent completion audit/);
	assert.doesNotMatch(during, /pi-goal-x ─/);
	audit = null;
	const after = component.render(100).join("\n");
	assert.match(after, /pi-goal-x ─/);
	assert.doesNotMatch(after, /audit complete|auditing/);
});

test("ledger events flow into the dashboard recent-activity feed", () => {
	const { tui } = createMockTUI();
	const events = [
		{ type: "goal_created", goalId: "g1", objective: "x", sisyphus: false, autoContinue: true, at: "2026-01-01T09:00:00.000Z" },
		{ type: "task_started", goalId: "g1", taskId: "t1", at: "2026-01-01T09:01:00.000Z" },
	] as never;
	const component = new GoalWidgetComponent({
		tui,
		theme: createMockTheme(),
		getGoal: () => goal({ id: "g1", taskList: { tasks: [{ id: "t1", title: "T1", status: "pending" }], blockCompletion: false, proposedAt: testProposedAt } }),
		getOpenGoalCount: () => 1,
		getExpanded: () => true,
		getLedgerEvents: () => events as never,
		getSettings: () => ({}),
	});
	const text = component.render(100).join("\n");
	assert.match(text, /Started “T1”\./, "ledger task_started maps to readable activity with the task title");
});

// ── §9.6 task-list scrolling ─────────────────────────────────────────────────

const UP = "\x1b[A";
const DOWN = "\x1b[B";
const PGUP = "\x1b[5~";
const PGDN = "\x1b[6~";
const HOME = "\x1b[H";
const END = "\x1b[F";
// Ctrl+Shift chords (free in pi — the editor owns the plain arrows).
const CS_UP = "\x1b[1;6A";
const CS_DOWN = "\x1b[1;6B";
const CS_HOME = "\x1b[1;6H";
const CS_END = "\x1b[1;6F";
const CS_PGUP = "\x1b[5;6~";
const CS_PGDN = "\x1b[6;6~";

/** 30 top-level tasks with t5 and t20 completed (t20 latest, mid-list): both
 * the compact (5 rows @100) and expanded (20 rows @100) views overflow, the
 * anchored window is a middle slice that can scroll in BOTH directions, and
 * the earliest task row is hidden by default. */
function manyTasksGoal(): GoalWidgetRecord {
	const tasks: GoalTask[] = Array.from({ length: 30 }, (_, i) => ({
		id: `t${i + 1}`,
		title: `Task number ${i + 1}`,
		status: "pending" as const,
	}));
	tasks[4] = { ...tasks[4]!, status: "complete", completedAt: "2026-01-01T10:00:00.000Z" };
	tasks[19] = { ...tasks[19]!, status: "complete", completedAt: "2026-01-01T11:00:00.000Z" };
	return goal({ taskList: { tasks, blockCompletion: false, proposedAt: testProposedAt } });
}

function scrollHarness(initialExpanded = false, g: GoalWidgetRecord = manyTasksGoal()) {
	let expanded = initialExpanded;
	const consumed: string[] = [];
	let inputCb: ((data: string) => unknown) | undefined;
	const { tui } = createMockTUI();
	const component = new GoalWidgetComponent({
		tui,
		theme: createMockTheme(),
		getGoal: () => g,
		getOpenGoalCount: () => 1,
		getExpanded: () => expanded,
		getSettings: () => ({}),
	});
	const ctx = {
		hasUI: true,
		ui: {
			onTerminalInput: (cb: unknown) => { inputCb = cb as (data: string) => unknown; return () => {}; },
			notify: () => {},
		},
	} as never;
	const core = {
		goalModalDepth: 0,
		auditProgress: null,
		state: { goal: null },
		pauseActiveGoal: () => { consumed.push("pause"); },
		interruption: { pause: () => { consumed.push("pause"); } },
		abortAudit: () => { consumed.push("abort-audit"); },
		isDashboardExpanded: () => expanded,
		toggleDashboardExpanded: () => { expanded = !expanded; consumed.push("toggle"); },
		goalWidgetComponentRef: { current: component },
		terminalInputUnsubscribe: null,
	} as never;
	syncTerminalInputPause(core as never, ctx as never);
	return {
		fire: (data: string) => {
			const result = inputCb?.(data);
			if (result && typeof result === "object" && (result as { consume?: boolean }).consume) {
				consumed.push(`c:${data}`);
			}
			return result;
		},
		expanded: () => expanded,
		consumed,
		component,
	};
}

test("compact default viewport is anchored to the most recently completed tasks", () => {
	const lines = renderGoalWidgetLines(manyTasksGoal(), theme, 100);
	const text = lines.join("\n");
	assert.match(text, /↑ 15 more tasks/, "earliest tasks are hidden above the anchored window");
	assert.match(text, /Task number 20/, "the latest completion is the last visible row");
	assert.match(text, /Task number 16/, "the window is a middle slice around the anchor");
	assert.doesNotMatch(text, /[✓▸·~] t1\s/, "the earliest task row is not shown");
	assert.match(text, /… \+10 more tasks/, "pending tasks after the anchor stay reachable below");
});

test("plain arrows are never consumed in compact mode; the editor keeps them", () => {
	const h = scrollHarness(false);
	h.component.render(100);
	h.fire(UP);
	h.fire(DOWN);
	h.fire(PGUP);
	h.fire(PGDN);
	assert.deepEqual(h.consumed, [], "plain arrow/page keys belong to the editor in compact mode");
});

test("Ctrl+Shift+↑/↓ scroll the compact list one row; Esc is untouched", () => {
	const h = scrollHarness(false);
	h.component.render(100);
	assert.match(h.component.render(100).join("\n"), /↑ 15 more tasks/, "anchored window hides the earliest tasks");
	h.fire(CS_UP);
	assert.ok(h.consumed.includes("c:" + CS_UP), "Ctrl+Shift+↑ is consumed");
	assert.match(h.component.render(100).join("\n"), /↑ 14 more tasks/, "up scrolls the compact window");
	h.fire(CS_DOWN);
	assert.match(h.component.render(100).join("\n"), /↑ 15 more tasks/, "down scrolls the compact window back");
	// plain arrows and Esc still reach the editor afterwards — nothing to disengage
	h.fire(UP);
	h.fire("\u001b");
	assert.equal(h.consumed.filter((c) => c === "c:" + UP).length, 0, "plain ↑ is never consumed");
	assert.equal(h.consumed.includes("c:\u001b"), false, "Esc is not consumed when not expanded");
});

test("Ctrl+Shift+Home/End/PgUp/PgDn jump and page in the compact list", () => {
	const h = scrollHarness(false);
	h.component.render(100);
	h.fire(CS_HOME);
	assert.doesNotMatch(h.component.render(100).join("\n"), /↑ \d+ more tasks/, "home jumps to the top");
	assert.match(h.component.render(100).join("\n"), /[✓▸·~] t1\s/, "the earliest task row is visible");
	h.fire(CS_END);
	assert.match(h.component.render(100).join("\n"), /↑ 25 more tasks/, "end jumps to the tail (max offset 25)");
	assert.doesNotMatch(h.component.render(100).join("\n"), /… \+\d+ more tasks/);
	h.fire(CS_PGDN); // at max: clamped, still consumed
	assert.match(h.component.render(100).join("\n"), /↑ 25 more tasks/);
	h.fire(CS_PGUP); // page up 5 rows → offset 20
	assert.match(h.component.render(100).join("\n"), /↑ 20 more tasks/);
});

test("compact overflow shows the scroll hint in the footer; a short list does not", () => {
	const overflowing = scrollHarness(false);
	assert.match(overflowing.component.render(100).join("\n"), /Ctrl\+Shift\+T: expand · Ctrl\+Shift\+↑↓: scroll/);
	const narrow = scrollHarness(false);
	assert.match(narrow.component.render(40).join("\n"), /↑↓: scroll/, "minimal layout shortens the hint");
	const g = goal({ taskList: { tasks: [
		{ id: "t1", title: "One", status: "pending" },
		{ id: "t2", title: "Two", status: "pending" },
		{ id: "t3", title: "Three", status: "pending" },
	], blockCompletion: false, proposedAt: testProposedAt } });
	const short = scrollHarness(false, g);
	assert.match(short.component.render(100).join("\n"), /Ctrl\+Shift\+T: expand tasks/, "no overflow → no scroll hint");
});

test("Ctrl+Shift chords are not consumed when the compact list fits", () => {
	const g = goal({ taskList: { tasks: [
		{ id: "t1", title: "One", status: "pending" },
		{ id: "t2", title: "Two", status: "pending" },
		{ id: "t3", title: "Three", status: "pending" },
	], blockCompletion: false, proposedAt: testProposedAt } });
	const h = scrollHarness(false, g);
	h.component.render(100);
	h.fire(CS_UP);
	h.fire(CS_DOWN);
	assert.deepEqual(h.consumed, [], "nothing to scroll → chords pass through");
});

test("expanded mode scrolls the task tree with arrows, Home, End, and page keys", () => {
	const h = scrollHarness(true);
	h.component.render(100); // expanded rows 20 over 30 nodes; anchor t20 → offset 0
	assert.doesNotMatch(h.component.render(100).join("\n"), /↑ \d+ more tasks/, "anchored window starts at the top");
	assert.match(h.component.render(100).join("\n"), /Task number 20/, "the latest completion is the last visible row");
	h.fire(DOWN);
	assert.match(h.component.render(100).join("\n"), /↑ 1 more task/, "down moves the expanded window");
	h.fire(HOME);
	assert.doesNotMatch(h.component.render(100).join("\n"), /↑ \d+ more tasks/, "home jumps to the top");
	h.fire(UP); // at top: clamped, still consumed
	h.fire(END);
	assert.match(h.component.render(100).join("\n"), /↑ 10 more tasks/, "end jumps to the tail (max offset 10)");
	h.fire(PGDN); // at max: clamped, still consumed
	assert.match(h.component.render(100).join("\n"), /↑ 10 more tasks/);
	h.fire(PGUP); // page up 20 rows → top
	assert.doesNotMatch(h.component.render(100).join("\n"), /↑ \d+ more tasks/);
	assert.ok(h.consumed.filter((c) => c.startsWith("c:")).length >= 6, "every navigation key is consumed while expanded");
});

test("Ctrl+Shift+T toggles expansion; plain arrows scroll only while expanded", () => {
	const h = scrollHarness(false);
	h.component.render(100);
	h.fire(CS_UP); // compact scroll — chord
	assert.ok(h.consumed.includes("c:" + CS_UP));
	h.fire(CTRL_SHIFT_T); // expand
	assert.equal(h.expanded(), true);
	h.fire(UP); // expanded is modal → plain arrow scrolls
	assert.ok(h.consumed.includes("c:" + UP));
	h.fire("\u001b"); // collapse
	assert.equal(h.expanded(), false);
	h.fire(UP);
	assert.equal(h.consumed.filter((c) => c.startsWith("c:")).length, 4, "chord + Ctrl+Shift+T + expanded ↑ + Esc consumed; plain ↑ reaches the editor after collapse");
});

test("scrolling before the first render keeps the requested viewport", () => {
	const compact = scrollHarness(false);
	assert.deepEqual(compact.fire(CS_DOWN), { consume: true });
	assert.match(compact.component.render(100).join("\n"), /↑ 16 more tasks/);

	const expanded = scrollHarness(true);
	assert.deepEqual(expanded.fire(DOWN), { consume: true });
	assert.match(expanded.component.render(100).join("\n"), /↑ 1 more task/);
});

test("expanded short task lists keep plain arrows out of the editor", () => {
	const shortGoal = goal({ taskList: { tasks: [
		{ id: "t1", title: "One", status: "pending" },
		{ id: "t2", title: "Two", status: "pending" },
	], blockCompletion: false, proposedAt: testProposedAt } });
	const h = scrollHarness(true, shortGoal);
	h.component.render(100);
	const before = h.component.render(100);
	assert.deepEqual(h.fire(DOWN), { consume: true });
	assert.deepEqual(h.fire(UP), { consume: true });
	assert.deepEqual(h.component.render(100), before);
});

test("compact scroll chords do not change the hidden list while expanded", () => {
	const h = scrollHarness(false);
	assert.match(h.component.render(100).join("\n"), /↑ 15 more tasks/);
	h.fire(CTRL_SHIFT_T);
	assert.equal(h.expanded(), true);
	assert.equal(h.fire(CS_HOME), undefined);
	h.fire("\u001b");
	assert.match(h.component.render(100).join("\n"), /↑ 15 more tasks/);
});

test("a new completion re-anchors the viewport to the latest completed task", () => {
	let current = manyTasksGoal();
	const { tui } = createMockTUI();
	const component = new GoalWidgetComponent({
		tui,
		theme: createMockTheme(),
		getGoal: () => current,
		getOpenGoalCount: () => 1,
		getSettings: () => ({}),
	});
	// anchored to t20 → compact window t16..t20
	assert.match(component.render(100).join("\n"), /↑ 15 more tasks/);
	// scroll to the top with the compact chord
	assert.equal(component.handleCompactScrollKey("home"), true, "compact list overflows → chord consumed");
	assert.doesNotMatch(component.render(100).join("\n"), /↑ \d+ more tasks/);
	assert.match(component.render(100).join("\n"), /[✓▸·~] t1\s/, "the earliest task row is visible after scrolling up");
	// a short list: the chord is inert
	assert.equal(component.handleCompactScrollKey("down"), true, "still overflows → consumed");
	// a new completion (t9, later than t20) arrives → re-anchor to t9
	const tasks = (current.taskList!.tasks as GoalTask[]).map((t) => ({ ...t }));
	tasks[8] = { ...tasks[8]!, status: "complete", completedAt: "2026-01-01T12:00:00.000Z" };
	current = { ...current, taskList: { tasks, blockCompletion: false, proposedAt: testProposedAt } };
	const text = component.render(100).join("\n");
	assert.match(text, /↑ 4 more tasks/, "re-anchored window shows the new completion (offset 4)");
	assert.match(text, /Task number 9/, "the newest completion is visible at the bottom of the window");
});

// ── terminal-height bound (spec 2026-08-10-widget-height-bound-scrollback-fix) ──

import { boundWidgetRenderLines, WIDGET_HEIGHT_RESERVE } from "../extensions/widgets/goal-widget.ts";

test("boundWidgetRenderLines is a no-op when terminal rows are unknown", () => {
	const lines = ["a", "b", "c", "d", "e"];
	assert.deepEqual(boundWidgetRenderLines(lines, undefined), lines);
	assert.deepEqual(boundWidgetRenderLines(lines, 0), lines);
	assert.deepEqual(boundWidgetRenderLines(lines, -3), lines);
});

test("boundWidgetRenderLines leaves content that fits unchanged", () => {
	const lines = Array.from({ length: 8 }, (_, i) => `line ${i}`);
	assert.deepEqual(boundWidgetRenderLines(lines, 30), lines);
	assert.deepEqual(boundWidgetRenderLines(lines, 14), lines); // 8 <= 30-6
});

test("boundWidgetRenderLines head-slices content over the cap deterministically", () => {
	const lines = Array.from({ length: 13 }, (_, i) => `line ${i}`);
	const rows = 13; // terminal == natural widget height (equal-height case)
	const cap = Math.max(1, rows - WIDGET_HEIGHT_RESERVE); // 7
	const out = boundWidgetRenderLines(lines, rows);
	assert.equal(out.length, cap);
	assert.deepEqual(out, lines.slice(0, cap), "keeps the head (identity/status/tasks)");
	// deterministic: same input + rows -> same output, no oscillation
	assert.deepEqual(boundWidgetRenderLines(lines, rows), out);
});

test("boundWidgetRenderLines floors at 1 line for tiny terminals", () => {
	const lines = ["a", "b", "c", "d", "e"];
	assert.equal(boundWidgetRenderLines(lines, 3).length, 1);
	assert.deepEqual(boundWidgetRenderLines(lines, 3), ["a"]);
});

test("renderGoalWidgetLines accepts an optional terminalRows bound (pure path)", () => {
	const withGoal = goal({ taskList: undefined });
	const unbounded = renderGoalWidgetLines(withGoal, theme, 100, { openGoalCount: 1 });
	const rows = Math.max(1, unbounded.length - 1); // force the bound to engage
	const bounded = renderGoalWidgetLines(withGoal, theme, 100, { openGoalCount: 1, terminalRows: rows });
	const cap = Math.max(1, rows - WIDGET_HEIGHT_RESERVE);
	assert.ok(bounded.length <= cap, `bounded to ${cap}, got ${bounded.length}`);
	assert.match(bounded[0]!, /^╭─ pi-goal-x/, "header survives the slice");
});

test("GoalWidgetComponent with terminalRows caps the compact dashboard at equal terminal height", () => {
	const { tui } = createMockTUI({ terminalRows: 13 }); // terminal == compact natural height
	const component = new GoalWidgetComponent({
		tui,
		theme: createMockTheme(),
		getGoal: () => goal(),
		getOpenGoalCount: () => 1,
		getSettings: () => ({}),
	});
	const lines = component.render(100);
	const cap = Math.max(1, 13 - WIDGET_HEIGHT_RESERVE);
	assert.ok(lines.length <= cap, `rendered ${lines.length} lines, cap ${cap}`);
	assert.match(lines[0]!, /^╭─ pi-goal-x/, "header preserved");
	assert.match(lines[1]!, /goal: sisyphus running/, "status line preserved");
});

test("GoalWidgetComponent caps the expanded dashboard at equal terminal height", () => {
	const { tui } = createMockTUI({ terminalRows: 24 }); // terminal == expanded natural height
	const component = new GoalWidgetComponent({
		tui,
		theme: createMockTheme(),
		getGoal: () => goal(),
		getOpenGoalCount: () => 1,
		getSettings: () => ({}),
		getExpanded: () => true,
	});
	const lines = component.render(100);
	const cap = Math.max(1, 24 - WIDGET_HEIGHT_RESERVE);
	assert.ok(lines.length <= cap, `rendered ${lines.length} lines, cap ${cap}`);
	assert.match(lines[0]!, /^╭─ pi-goal-x/, "header preserved");
});

test("GoalWidgetComponent leaves the expanded dashboard unchanged when it fits", () => {
	const { tui } = createMockTUI({ terminalRows: 30 }); // 24 natural + 6 chrome = 30
	const component = new GoalWidgetComponent({
		tui,
		theme: createMockTheme(),
		getGoal: () => goal(),
		getOpenGoalCount: () => 1,
		getSettings: () => ({}),
		getExpanded: () => true,
	});
	const lines = component.render(100);
	const natural = new GoalWidgetComponent({
		tui: createMockTUI().tui, // no terminal rows -> unbounded
		theme: createMockTheme(),
		getGoal: () => goal(),
		getOpenGoalCount: () => 1,
		getSettings: () => ({}),
		getExpanded: () => true,
	}).render(100);
	assert.equal(lines.length, natural.length, "fits -> byte-identical to the unbounded render");
});

test("GoalWidgetComponent bounds the audit dashboard, result card, debug panel, and unfocused panel", () => {
	const mk = (opts: { rows: number; extra?: Partial<ConstructorParameters<typeof GoalWidgetComponent>[0]> }) =>
		new GoalWidgetComponent({
			tui: createMockTUI({ terminalRows: opts.rows }).tui,
			theme: createMockTheme(),
			getGoal: () => goal(),
			getOpenGoalCount: () => 1,
			getSettings: () => ({}),
			...opts.extra,
		});

	// Audit dashboard at its natural height (8 lines) on an 8-row terminal.
	const audit = mk({
		rows: 8,
		extra: { getAuditorProgress: () => auditorProgress() },
	}).render(100);
	assert.ok(audit.length <= Math.max(1, 8 - WIDGET_HEIGHT_RESERVE), `audit rendered ${audit.length}`);
	assert.match(audit[0]!, /^╭─ Independent completion audit/, "audit header preserved");

	// Audit result card on a 6-row terminal.
	const card = mk({
		rows: 6,
		extra: { getAuditResult: () => ({ verdict: "approved" as const, report: "Everything checks out." }) },
	}).render(100);
	assert.ok(card.length <= Math.max(1, 6 - WIDGET_HEIGHT_RESERVE), `card rendered ${card.length}`);
	assert.match(card[0]!, /^╭─ Audit result/, "card header preserved");

	// Unfocused panel on a 4-row terminal.
	const unfocused = new GoalWidgetComponent({
		tui: createMockTUI({ terminalRows: 4 }).tui,
		theme: createMockTheme(),
		getGoal: () => null,
		getOpenGoalCount: () => 2,
		getSettings: () => ({}),
	}).render(100);
	assert.ok(unfocused.length <= Math.max(1, 4 - WIDGET_HEIGHT_RESERVE), `unfocused rendered ${unfocused.length}`);
});

test("GoalWidgetComponent render height is deterministic across repeated renders", () => {
	const { tui } = createMockTUI({ terminalRows: 13 });
	const component = new GoalWidgetComponent({
		tui,
		theme: createMockTheme(),
		getGoal: () => goal(),
		getOpenGoalCount: () => 1,
		getSettings: () => ({}),
	});
	const first = component.render(100).length;
	const second = component.render(100).length;
	const third = component.render(100).length;
	assert.equal(first, second);
	assert.equal(second, third);
});

// ── stable height per regime (spec 2026-08-11-stable-widget-height) ────────

const freshStableState = () => ({ stickyCap: undefined as number | undefined, stickyRegime: undefined as string | undefined, stickyTerminalRows: undefined as number | undefined, stickyReserve: undefined as number | undefined });

test("applyStableHeightBound: adaptive reserve caps the widget so the block + chrome fits the terminal", () => {
	const state = freshStableState();
	const natural14 = Array.from({ length: 14 }, (_, i) => `n${i}`);
	const natural20 = Array.from({ length: 20 }, (_, i) => `n${i}`);

	// A tall editor (measured chrome = 7) shrinks the cap: 15 - 7 = 8.
	const out = applyStableHeightBound(natural14, 15, state, "regime", 7);
	assert.equal(out.length, 8, "cap = terminalRows - measured reserve");
	assert.equal(state.stickyCap, 8);

	// Same render again: latch holds.
	assert.equal(applyStableHeightBound(natural20, 15, state, "regime", 7).length, 8);
});

test("applyStableHeightBound: chrome change (editor grew) re-evaluates the latch", () => {
	const state = freshStableState();
	const natural14 = Array.from({ length: 14 }, (_, i) => `n${i}`);

	// First render with small chrome: latches at 15 - 4 = 11.
	const first = applyStableHeightBound(natural14, 15, state, "regime", 4);
	assert.equal(first.length, 11);
	assert.equal(state.stickyCap, 11);

	// The editor grew (chrome 4 -> 8): the latch re-evaluates to 15 - 8 = 7
	// so the widget's block plus the chrome never exceeds the terminal (else
	// pi-tui full-renders on every agent write).
	const second = applyStableHeightBound(natural14, 15, state, "regime", 8);
	assert.equal(second.length, 7, "reserve change clears the latch and re-evaluates");
	assert.equal(state.stickyCap, 7);
	assert.equal(state.stickyReserve, 8);

	// Back to small chrome: re-evaluates up again.
	const third = applyStableHeightBound(natural14, 15, state, "regime", 4);
	assert.equal(third.length, 11);
});

test("applyStableHeightBound: default reserve keeps the 6-row contract unchanged", () => {
	const state = freshStableState();
	const natural20 = Array.from({ length: 20 }, (_, i) => `n${i}`);
	const out = applyStableHeightBound(natural20, 24, state, "regime");
	assert.equal(out.length, 24 - WIDGET_HEIGHT_RESERVE, "default reserve = WIDGET_HEIGHT_RESERVE");
	assert.equal(state.stickyReserve, WIDGET_HEIGHT_RESERVE);
});

test("applyStableHeightBound: latches at the first render and holds (fits or capped)", () => {
	const state = freshStableState();
	const cap = Math.max(1, 24 - WIDGET_HEIGHT_RESERVE); // 18
	const natural10 = Array.from({ length: 10 }, (_, i) => `n${i}`);
	const natural25 = Array.from({ length: 25 }, (_, i) => `n${i}`);
	const natural30 = Array.from({ length: 30 }, (_, i) => `n${i}`);

	// first render above the cap: latches at the cap, head slice
	const out = applyStableHeightBound(natural25, 24, state, "regime");
	assert.equal(out.length, cap);
	assert.deepEqual(out, natural25.slice(0, cap));
	assert.equal(state.stickyCap, cap);

	// still above: constant
	assert.equal(applyStableHeightBound(natural30, 24, state, "regime").length, cap);
	assert.equal(applyStableHeightBound(natural25, 24, state, "regime").length, cap);

	// first render fits: byte-identical, but the height is now committed
	assert.deepEqual(applyStableHeightBound(natural10, 24, freshStableState(), "regime"), natural10);
});

test("applyStableHeightBound: fits case latches at the first-render natural and stays constant", () => {
	const state = freshStableState();
	const natural13 = Array.from({ length: 13 }, (_, i) => `line ${i}`);
	const natural16 = Array.from({ length: 16 }, (_, i) => `line ${i}`);
	const natural10 = Array.from({ length: 10 }, (_, i) => `line ${i}`);

	// first render fits: byte-identical, but the height is now committed
	assert.deepEqual(applyStableHeightBound(natural13, 30, state, "regime"), natural13);
	assert.equal(state.stickyCap, 13, "fits case latches at the natural height");

	// growth past the committed height: head slice, height never changes
	const grown = applyStableHeightBound(natural16, 30, state, "regime");
	assert.equal(grown.length, 13, "growth is head-sliced to the committed height");
	assert.deepEqual(grown, natural16.slice(0, 13));

	// shrink: blank padding, height never changes
	const shrunk = applyStableHeightBound(natural10, 30, state, "regime");
	assert.equal(shrunk.length, 13, "shrink is padded to the committed height");
	assert.deepEqual(shrunk.slice(0, 10), natural10);
	assert.deepEqual(shrunk.slice(10), Array(3).fill(""));

	// back to the committed height: unchanged
	assert.deepEqual(applyStableHeightBound(natural13, 30, state, "regime"), natural13);
});

test("applyStableHeightBound: pads deterministically when natural dips below the cap (cap crossing down)", () => {
	const state = freshStableState();
	const cap = Math.max(1, 24 - WIDGET_HEIGHT_RESERVE); // 18
	applyStableHeightBound(Array.from({ length: 25 }), 24, state, "regime"); // latch at 18
	const natural12 = Array.from({ length: 12 }, (_, i) => `n${i}`);

	const padded = applyStableHeightBound(natural12, 24, state, "regime");
	assert.equal(padded.length, cap, "rendered height stays at the committed cap");
	assert.deepEqual(padded.slice(0, 12), natural12, "content preserved");
	assert.deepEqual(padded.slice(12), Array(cap - 12).fill(""), "blank filler rows");

	// back above the cap: head slice again, still the same height
	const natural20 = Array.from({ length: 20 }, (_, i) => `n${i}`);
	assert.equal(applyStableHeightBound(natural20, 24, state, "regime").length, cap);
	// exactly at the cap: unchanged, still the same height
	assert.equal(applyStableHeightBound(Array.from({ length: cap }), 24, state, "regime").length, cap);
});

test("applyStableHeightBound: terminal resize clears the latch and adapts to the new height", () => {
	const state = freshStableState();
	const natural22 = Array.from({ length: 22 }, (_, i) => `n${i}`);
	const natural25 = Array.from({ length: 25 }, (_, i) => `n${i}`);
	const cap24 = Math.max(1, 24 - WIDGET_HEIGHT_RESERVE); // 18

	applyStableHeightBound(natural25, 24, state, "regime"); // latch at 18
	assert.equal(state.stickyCap, cap24);

	// grow the terminal: more of the widget renders (min(natural, new cap))
	const cap30 = Math.max(1, 30 - WIDGET_HEIGHT_RESERVE); // 24
	const grown = applyStableHeightBound(natural22, 30, state, "regime");
	assert.equal(grown.length, Math.min(natural22.length, cap30), "grow reveals more of the widget");
	assert.equal(state.stickyCap, Math.min(natural22.length, cap30), "latch re-engages at the first render after the resize");

	// shrink back: re-latches at the new cap
	const shrunk = applyStableHeightBound(natural25, 24, state, "regime");
	assert.equal(shrunk.length, cap24, "re-latches at the 24-row cap");
});

test("applyStableHeightBound: regime change clears the latch so the new mode starts from its own height", () => {
	const state = freshStableState();
	const big = Array.from({ length: 25 }, (_, i) => `n${i}`);
	const small = Array.from({ length: 10 }, (_, i) => `n${i}`);
	const cap = Math.max(1, 24 - WIDGET_HEIGHT_RESERVE);

	applyStableHeightBound(big, 24, state, "expanded"); // latch at 18
	assert.equal(state.stickyCap, cap);

	// regime change: fresh evaluation — compact starts from its own natural
	// height (fits -> unchanged) and re-latches there
	const out = applyStableHeightBound(small, 24, state, "compact");
	assert.deepEqual(out, small, "compact starts from its own natural height");
	assert.equal(state.stickyCap, small.length, "latch re-engages at the first render of the new regime");

	// the compact regime holds its committed height as natural grows
	const out2 = applyStableHeightBound(big, 24, state, "compact");
	assert.equal(out2.length, small.length, "compact holds its committed height");
});

test("applyStableHeightBound: unbounded without a terminal (mock/harness/status)", () => {
	const state = freshStableState();
	const lines = Array.from({ length: 40 }, (_, i) => `n${i}`);
	const out = applyStableHeightBound(lines, undefined, state, "regime");
	assert.deepEqual(out, lines, "no terminal -> unbounded");
	assert.equal(state.stickyCap, undefined);
	assert.equal(state.stickyTerminalRows, undefined);
});

test("GoalWidgetComponent: rendered height is constant across goal-state changes (fits and capped)", () => {
	const task = (id: string, status: string) => ({
		id,
		title: `Task ${id} with a reasonably long title for wrapping tests`,
		status,
		createdAt: "2026-08-10T00:00:00Z",
		updatedAt: "2026-08-10T00:00:00Z",
		completedAt: status === "complete" ? "2026-08-10T00:01:00Z" : undefined,
	} as GoalTask);
	let current: GoalWidgetRecord = { ...goal(), taskList: { tasks: [task("t1", "pending")], blockCompletion: false, proposedAt: "2026-08-10T00:00:00Z" } };
	let events: unknown[] = [];
	const { tui } = createMockTUI({ terminalRows: 24 });
	const component = new GoalWidgetComponent({
		tui,
		theme: createMockTheme(),
		getGoal: () => current,
		getOpenGoalCount: () => 1,
		getSettings: () => ({}),
		getExpanded: () => true,
		getLedgerEvents: () => events as never,
	});
	const cap = Math.max(1, 24 - WIDGET_HEIGHT_RESERVE); // 18

	const heights: number[] = [];
	const steps: Array<() => void> = [
		() => { current = { ...current, taskList: { tasks: [task("t1", "complete"), task("t2", "pending")], blockCompletion: false, proposedAt: "2026-08-10T00:00:00Z" } }; events = [{ type: "task_complete", at: "2026-08-10T00:01:00Z", goalId: "g1", taskId: "t1" }]; },
		() => { current = { ...current, taskList: { tasks: Array.from({ length: 12 }, (_, i) => task(`t${i}`, i < 5 ? "complete" : "pending")), blockCompletion: false, proposedAt: "2026-08-10T00:00:00Z" } }; },
		() => { current = { ...current, verificationContract: "Run npm test (0 failures) and re-read every requirement" }; },
		() => { current = { ...current, tokenBudget: 200000 }; },
		() => { current = { ...current, usage: { activeSeconds: 5000, tokensUsed: 9000 } }; },
	];
	for (const step of steps) {
		step();
		heights.push(component.render(100).length);
	}
	// the first render latches the height and every later goal-state change
	// (task completions, feed growth, verification, budget, usage) keeps it
	// constant — the buffer line count never changes
	assert.ok(heights.every((h) => h <= cap), `bounded by the cap: ${heights.join(",")}`);
	assert.equal(new Set(heights).size, 1, `constant across all goal-state changes: ${heights.join(",")}`);
});

test("GoalWidgetComponent: the first task appearing re-latches (task presence is part of the regime)", () => {
	let current: GoalWidgetRecord = { ...goal(), taskList: { tasks: [], blockCompletion: false, proposedAt: "2026-08-10T00:00:00Z" } };
	const { tui } = createMockTUI({ terminalRows: 40 });
	const component = new GoalWidgetComponent({
		tui,
		theme: createMockTheme(),
		getGoal: () => current,
		getOpenGoalCount: () => 1,
		getSettings: () => ({}),
		getExpanded: () => true,
	});
	const h0 = component.render(100).length; // 0 tasks: small dashboard, latched
	current = { ...current, taskList: { tasks: [{ id: "t1", title: "Task one", status: "pending" }], blockCompletion: false, proposedAt: "2026-08-10T00:00:00Z" } };
	const h1 = component.render(100).length; // first task: regime change, re-latch
	const h2 = component.render(100).length; // same regime: constant
	assert.ok(h1 > h0, `first task grows the dashboard (${h0} -> ${h1})`);
	assert.equal(h2, h1, "stable within the task-present regime");
});

test("GoalWidgetComponent: expanding the terminal reveals more of the widget, collapsing re-latches", () => {
	let current: GoalWidgetRecord = { ...goal(), taskList: { tasks: Array.from({ length: 12 }, (_, i) => ({ id: `t${i}`, title: `Task ${i} long title for wrapping`, status: i < 5 ? "complete" : "pending", createdAt: "2026-08-10T00:00:00Z", updatedAt: "2026-08-10T00:00:00Z", completedAt: i < 5 ? "2026-08-10T00:01:00Z" : undefined })), blockCompletion: false, proposedAt: "2026-08-10T00:00:00Z" } };
	const { tui } = createMockTUI({ terminalRows: 24 });
	const component = new GoalWidgetComponent({
		tui,
		theme: createMockTheme(),
		getGoal: () => current,
		getOpenGoalCount: () => 1,
		getSettings: () => ({}),
		getExpanded: () => true,
	});
	const cap24 = Math.max(1, 24 - WIDGET_HEIGHT_RESERVE);
	assert.equal(component.render(100).length, cap24, "latched at 18 on a 24-row terminal");

	const grown = new GoalWidgetComponent({
		tui: createMockTUI({ terminalRows: 30 }).tui,
		theme: createMockTheme(),
		getGoal: () => current,
		getOpenGoalCount: () => 1,
		getSettings: () => ({}),
		getExpanded: () => true,
	}).render(100);
	const cap30 = Math.max(1, 30 - WIDGET_HEIGHT_RESERVE);
	assert.ok(grown.length > cap24, `growing the terminal reveals more (${grown.length} > ${cap24})`);
	assert.ok(grown.length <= cap30, `still bounded by the new cap (${grown.length} <= ${cap30})`);
});

test("GoalWidgetComponent: measured dock chrome shrinks the widget so the block + chrome fits the terminal", () => {
	// A fake TUI with the regular-mode child structure:
	// [document, status, widgetContainer(component), editor, footer].
	// The widget must size itself so its block + the chrome (status + editor
	// + footer) never exceeds the terminal — otherwise pi-tui full-renders
	// (2J+3J wipe) whenever the agent writes and the chrome pushes the chat
	// append point above the viewport top.
	let current: GoalWidgetRecord = { ...goal(), taskList: { tasks: Array.from({ length: 12 }, (_, i) => ({ id: `t${i}`, title: `Task ${i} long title for wrapping`, status: i < 5 ? "complete" : "pending", createdAt: "2026-08-10T00:00:00Z", updatedAt: "2026-08-10T00:00:00Z", completedAt: i < 5 ? "2026-08-10T00:01:00Z" : undefined })), blockCompletion: false, proposedAt: "2026-08-10T00:00:00Z" } };
	let editorLines: string[] = [""];
	const tui = {
		terminal: { rows: 15 },
		requestRender: () => {},
		children: [
			{ render: () => ["chat 0", "chat 1", "chat 2"] }, // document
			{ render: () => ["status"] },                     // status
			{ children: [] as unknown[] },                    // widgetContainer (component added below)
			{ render: () => ["❯", ...editorLines] },          // editor
			{ render: () => ["footer a", "footer b"] },       // footer
		],
	};
	const component = new GoalWidgetComponent({
		tui: tui as unknown as import("@earendil-works/pi-tui").TUI,
		theme: createMockTheme(),
		getGoal: () => current,
		getOpenGoalCount: () => 1,
		getSettings: () => ({}),
		getExpanded: () => true,
	});
	// Register the component inside its container so the measurement finds it.
	tui.children[2]!.children!.push(component);

	// Small editor: chrome = status(1) + editor(1) + footer(2) = 4 -> reserve 5
	// -> cap = 15 - 5 = 10; the natural height (9) fits, so it renders natural.
	const small = component.render(100);
	assert.equal(small.length, 9, "with a small editor the widget renders its natural height (9 < cap 10)");

	// Tall editor (user's typed message): chrome = status(1) + editor(4:
	// "❯" + 3 wrapped lines) + footer(2) = 7 -> reserve 8 -> cap = 15 - 8 = 7.
	// The widget must shrink so the block + chrome (7 + 7 = 14) still fits the
	// 15-row terminal.
	editorLines = ["l1", "l2", "l3"];
	const tall = component.render(100);
	assert.equal(tall.length, 7, "with a tall editor the widget shrinks to 15 - (7 + 1) = 7 lines");
	assert.ok(tall.length < small.length, "taller chrome shrinks the widget");

	// Editor back to small: the widget grows again.
	editorLines = [""];
	const back = component.render(100);
	assert.equal(back.length, 9, "chrome shrinking re-evaluates the latch up");
});
