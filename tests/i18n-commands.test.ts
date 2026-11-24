import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { GOAL_COMMANDS, GOAL_KEY_ACTIONS, PAUSE_ORDERS, commandProblems } from "../extensions/goal-controls.ts";
import { diffGoalRefreshState } from "../extensions/goal-commands.ts";
import { registerLocale, setLocale } from "../extensions/i18n/index.ts";

afterEach(() => setLocale("en"));

test("command and control tables read the active language each time", () => {
	assert.equal(GOAL_COMMANDS[0][1], "Draft a goal");
	registerLocale("xc", {
		"Draft a goal": "XC draft",
		"Pause / interrupt": "XC pause",
		"Goal first": "XC goal first",
		"/goal-settings is reserved for settings recovery.": "XC reserved",
	});
	setLocale("xc");
	assert.equal(GOAL_COMMANDS[0][1], "XC draft");
	assert.equal(GOAL_KEY_ACTIONS[0]?.label, "XC pause");
	assert.equal(PAUSE_ORDERS[1]?.label, "XC goal first");
	assert.deepEqual(commandProblems({ goal: ["goal-settings"], "goal-settings": [] }), ["XC reserved"]);
});

test("refresh changes are translated with their values filled in", () => {
	const state = { poolIds: ["a"], ledgerEvents: 1, ledgerMalformed: 0, settings: "{}" };
	const english = diffGoalRefreshState(state, { ...state, poolIds: ["a", "b"], ledgerEvents: 3 });
	assert.deepEqual(english, ["pool: 1 goal(s) added — b", "ledger: 1 -> 3 events"]);
	registerLocale("xd", { "ledger: {before} -> {after} events": "XD {after} from {before}" });
	setLocale("xd");
	assert.equal(diffGoalRefreshState(state, { ...state, ledgerEvents: 3 })[0], "XD 3 from 1");
});
