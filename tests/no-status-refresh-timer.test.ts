import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../extensions/goal-state.ts", import.meta.url), "utf8");

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
	assert.match(source, /goalWidgetComponentRef\.current\?\.update\(\)/);
	assert.match(source, /ctx\.ui\.setStatus\("goal"/);
});
