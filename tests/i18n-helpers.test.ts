import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { registerLocale, setLocale } from "../extensions/i18n/index.ts";
import { commandHint, uiCommandHint } from "../extensions/goal-controls.ts";
import { buildUnfocusedOpenGoalsSummary, unfocusedOpenGoalsNotice } from "../extensions/goal-pool.ts";
import { clearGoalCommandMessage } from "../extensions/goal-policy.ts";
import { parseManualAuditorModel } from "../extensions/auditor-selector.ts";
import { formatRecoveryReport } from "../extensions/goal-recovery.ts";
import { schedulerSummary, schedulerSummaryParts, newGoalScheduler } from "../extensions/goal-scheduler-state.ts";
import { formatGoalKeybinding } from "../extensions/settings/schema.ts";

afterEach(() => setLocale("en"));

registerLocale("xh", {
	"Goal cleared and archived.": "XH cleared",
	"No goal is set.": "XH none",
	"Unbound": "XH unbound",
	"/goal-settings controls to enable {command}": "XH enable {command}",
	"No goal is focused in this session.": "XH unfocused.",
	"{n} open goals exist in the goal pool.": { one: "XH {n} goal.", other: "XH {n} goals." },
	"Auditor model must use provider/model format; unavailable models will fail clearly at audit time.": "XH bad model",
	"Recovery report: OK — no issues found.": "XH ok",
	"Autonomous runs: {used}/{limit}.": "XH runs {used}/{limit}",
});

const healthy = { healthy: true, malformedGoalFiles: [], malformedLedgerLines: 0, staleLocks: [], orphanedSnapshotGoals: [] } as unknown as Parameters<typeof formatRecoveryReport>[0];

test("helpers return the original English text", () => {
	assert.equal(clearGoalCommandMessage({ archived: true }), "Goal cleared and archived.");
	assert.equal(clearGoalCommandMessage({ archived: false }), "No goal is set.");
	assert.equal(unfocusedOpenGoalsNotice(2), buildUnfocusedOpenGoalsSummary(2));
	assert.equal(unfocusedOpenGoalsNotice(1), buildUnfocusedOpenGoalsSummary(1));
	assert.equal(formatGoalKeybinding(undefined), "Unbound");
	assert.equal(formatRecoveryReport(healthy), "Recovery report: OK — no issues found.");
	assert.deepEqual(parseManualAuditorModel("nope"), { error: "Auditor model must use provider/model format; unavailable models will fail clearly at audit time." });
	assert.equal(uiCommandHint("goal-pause", { "goal-pause": [] }), commandHint("goal-pause", { "goal-pause": [] }));
});

test("host-UI helpers follow the locale", () => {
	setLocale("xh");
	assert.equal(clearGoalCommandMessage({ archived: true }), "XH cleared");
	assert.equal(formatGoalKeybinding(undefined), "XH unbound");
	assert.equal(formatRecoveryReport(healthy), "XH ok");
	assert.deepEqual(parseManualAuditorModel("nope"), { error: "XH bad model" });
	assert.equal(unfocusedOpenGoalsNotice(1), "XH unfocused. XH 1 goal. Use /goal-focus to choose the session focus before doing goal work.");
	assert.match(uiCommandHint("goal-pause", { "goal-pause": [] }), /^XH enable /);
});

test("model-facing helpers stay English under another locale", () => {
	setLocale("xh");
	assert.match(buildUnfocusedOpenGoalsSummary(2), /^No goal is focused in this session\. 2 open goals exist/);
	assert.match(commandHint("goal-pause", { "goal-pause": [] }), /^\/goal-settings controls to enable /);
	const s = newGoalScheduler("owner");
	assert.equal(schedulerSummary(s, 3), "Autonomous runs: 0/3.");
	assert.equal(schedulerSummaryParts(s, 3).runs, "Autonomous runs: 0/3.");
	assert.equal(schedulerSummaryParts(s, 3, true, false, undefined, true).runs, "XH runs 0/3");
});
