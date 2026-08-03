import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../extensions/goal-state.ts", import.meta.url), "utf8");

test("goal updates do not append full state snapshots to the session", () => {
	assert.doesNotMatch(source, /appendEntry\(STATE_ENTRY/);
	assert.match(source, /entry\.customType === STATE_ENTRY/);
});
