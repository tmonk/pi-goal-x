import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// The view draws the widget and status; the core wires it up.
const source = ["goal-state.ts", "goal-view.ts"]
	.map((name) => readFileSync(new URL(`../extensions/${name}`, import.meta.url), "utf8"))
	.join("\n");

test("no periodic status-refresh timer is scheduled while goals are active", () => {
	// PR #5 removed the 1s status refresh interval that forced TUI redraws
	// (ui.setStatus + goalWidgetComponent.update), pulling users out of
	// terminal scrollback while reviewing long goals. Reintroducing a
	// STATUS_REFRESH_MS constant or a statusRefreshTimer would regress that.
	assert.doesNotMatch(source, /STATUS_REFRESH_MS/);
	assert.doesNotMatch(source, /statusRefreshTimer/);
	assert.doesNotMatch(source, /syncStatusRefresh/);
	assert.doesNotMatch(source, /stopStatusRefresh/);
});

test("the widget and footer status still update on state changes", () => {
	// The widget reads live values through closures; updateUI still requests
	// renders on state changes so elapsed time catches up on natural renders.
	assert.match(source, /widgetRef\.current\?\.update\(\)/);
	assert.match(source, /ctx\.ui\.setStatus\("goal"/);
});

test("the focused-goal footer line is removed; the widget is the single home", () => {
	// The status line moved into the widget (compact/expanded dashboard:
	// `goal: <label> [<usage>] (+N open)`). The focused-goal footer segment
	// must be cleared — not composed from footerStatus — so the bottom of the
	// screen stops duplicating goal status; the unfocused hint stays.
	assert.doesNotMatch(source, /footerStatus\(displayGoal\)/);
	assert.match(source, /ctx\.ui\.setStatus\("goal", undefined\)/);
	assert.match(source, /goal: unfocused/);
});
