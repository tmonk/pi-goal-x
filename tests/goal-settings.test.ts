/**
 * Tests for the goal settings system (.pi/goal-settings.json + env var overrides).
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";

import {
	normalizeTaskItem,
	normalizeTaskList,
	type GoalRecord,
} from "../extensions/goal-record.ts";
import {
	goalSettingsPath,
	parseGoalSettings,
	loadGoalSettingsFileConfig,
	loadGoalSettings,
	type GoalSettings,
} from "../extensions/goal-settings.ts";

// ── parseGoalSettings ───────────────────────────────────────────────────

test("parseGoalSettings: null/undefined returns empty defaults", () => {
	assert.deepEqual(parseGoalSettings(null), {});
	assert.deepEqual(parseGoalSettings(undefined as unknown), {});
	assert.deepEqual(parseGoalSettings(""), {});
	assert.deepEqual(parseGoalSettings(42), {});
	assert.deepEqual(parseGoalSettings([]), {});
});

test("parseGoalSettings: empty object returns empty defaults", () => {
	assert.deepEqual(parseGoalSettings({}), {});
});

test("parseGoalSettings: both flags false returns false defaults", () => {
	const result = parseGoalSettings({ disableTasks: false, disableContracts: false });
	assert.equal(result.disableTasks, false);
	assert.equal(result.disableContracts, false);
});

test("parseGoalSettings: both flags true", () => {
	const result = parseGoalSettings({ disableTasks: true, disableContracts: true });
	assert.equal(result.disableTasks, true);
	assert.equal(result.disableContracts, true);
});

test("parseGoalSettings: boolean false stored correctly", () => {
	const result = parseGoalSettings({ disableTasks: false, disableContracts: true });
	assert.equal(result.disableTasks, false);
	assert.equal(result.disableContracts, true);
});

test("parseGoalSettings: string true/false values accepted", () => {
	assert.deepEqual(parseGoalSettings({ disableTasks: "true", disableContracts: "false" }), {
		disableTasks: true,
		disableContracts: false,
	});
});

test("parseGoalSettings: autoSelectSingleGoal accepted as bool or string", () => {
	assert.deepEqual(parseGoalSettings({ autoSelectSingleGoal: true }), { autoSelectSingleGoal: true });
	assert.deepEqual(parseGoalSettings({ autoSelectSingleGoal: "true" }), { autoSelectSingleGoal: true });
	assert.deepEqual(parseGoalSettings({ autoSelectSingleGoal: false }), {});
	assert.deepEqual(parseGoalSettings({ autoSelectSingleGoal: "false" }), {});
});

test("parseGoalSettings: unknown keys rejected", () => {
	assert.throws(
		() => parseGoalSettings({ disableTasks: true, disableContracts: false, foo: "bar" }),
		/Unknown pi-goal-x-settings.json key/,
	);
});

test("parseGoalSettings: multiple unknown keys rejected", () => {
	assert.throws(
		() => parseGoalSettings({ disableTasks: true, foo: "bar", baz: 42 }),
		/foo, baz/,
	);
});

// ── goalSettingsPath ────────────────────────────────────────────────────

test("goalSettingsPath: resolves under .pi/ with new filename", () => {
	const p = goalSettingsPath("/tmp/project");
	assert.ok(p.endsWith(path.join(".pi", "pi-goal-x-settings.json")));
	assert.ok(p.startsWith("/tmp/project"));
});

test("goalSettingsPath: respects PI_GOAL_SETTINGS_FILE env var", () => {
	// Relative path
	const rel = goalSettingsPath("/tmp/project", { PI_GOAL_SETTINGS_FILE: "custom-settings.json" });
	assert.equal(rel, path.join("/tmp/project", "custom-settings.json"));

	// Absolute path
	const abs = goalSettingsPath("/tmp/project", { PI_GOAL_SETTINGS_FILE: "/etc/pi/settings.json" });
	assert.equal(abs, "/etc/pi/settings.json");

	// No env var — defaults to .pi/pi-goal-x-settings.json
	const def = goalSettingsPath("/tmp/project", {});
	assert.ok(def.endsWith(path.join(".pi", "pi-goal-x-settings.json")));
});

// ── loadGoalSettingsFileConfig ──────────────────────────────────────────

function withTempDir(fn: (dir: string) => void): void {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "goal-settings-test-"));
	try {
		fn(dir);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

test("loadGoalSettingsFileConfig: missing file returns empty defaults", () => {
	withTempDir((dir) => {
		const result = loadGoalSettingsFileConfig(dir);
		assert.deepEqual(result, {});
	});
});

test("loadGoalSettingsFileConfig: reads valid file config", () => {
	withTempDir((dir) => {
		const configPath = goalSettingsPath(dir);
		fs.mkdirSync(path.dirname(configPath), { recursive: true });
		fs.writeFileSync(configPath, JSON.stringify({ disableTasks: true, disableContracts: false }), "utf8");
		const result = loadGoalSettingsFileConfig(dir);
		assert.equal(result.disableTasks, true);
		assert.equal(result.disableContracts, false);
	});
});

test("loadGoalSettingsFileConfig: malformed JSON returns empty defaults", () => {
	withTempDir((dir) => {
		const configPath = goalSettingsPath(dir);
		fs.mkdirSync(path.dirname(configPath), { recursive: true });
		fs.writeFileSync(configPath, "not-json", "utf8");
		const result = loadGoalSettingsFileConfig(dir);
		assert.deepEqual(result, {});
	});
});

test("loadGoalSettingsFileConfig: unknown keys cause fallback to empty defaults", () => {
	withTempDir((dir) => {
		const configPath = goalSettingsPath(dir);
		fs.mkdirSync(path.dirname(configPath), { recursive: true });
		fs.writeFileSync(configPath, JSON.stringify({ disableTasks: true, extra: "bad" }), "utf8");
		// parseGoalSettings throws on unknown keys, so loadGoalSettingsFileConfig catches -> returns empty {}
		const result = loadGoalSettingsFileConfig(dir);
		assert.deepEqual(result, {});
	});
});

// ── loadGoalSettings (env var overrides) ────────────────────────────────

test("loadGoalSettings: no file, no env vars -> defaults false", () => {
	withTempDir((dir) => {
		const result = loadGoalSettings(dir, {});
		assert.equal(result.disableTasks, false);
		assert.equal(result.disableContracts, false);
		assert.equal(result.autoSelectSingleGoal, false, "autoSelectSingleGoal defaults to false");
	});
});

test("loadGoalSettings: env vars override file config", () => {
	withTempDir((dir) => {
		const configPath = goalSettingsPath(dir);
		fs.mkdirSync(path.dirname(configPath), { recursive: true });
		// File says both should true
		fs.writeFileSync(configPath, JSON.stringify({ disableTasks: true, disableContracts: true }), "utf8");
		// Env says only disableTasks should be false (overriding file)
		const result = loadGoalSettings(dir, { PI_GOAL_DISABLE_TASKS: "false", PI_GOAL_DISABLE_CONTRACTS: "true" });
		assert.equal(result.disableTasks, false, "env override should win");
		assert.equal(result.disableContracts, true, "file value used when no env override");
	});
});

test("loadGoalSettings: env var true overrides file false", () => {
	withTempDir((dir) => {
		const configPath = goalSettingsPath(dir);
		fs.mkdirSync(path.dirname(configPath), { recursive: true });
		fs.writeFileSync(configPath, JSON.stringify({ disableTasks: false, disableContracts: false }), "utf8");
		const result = loadGoalSettings(dir, { PI_GOAL_DISABLE_TASKS: "true" });
		assert.equal(result.disableTasks, true);
		assert.equal(result.disableContracts, false);
	});
});

test("loadGoalSettings: env var absent falls back to file", () => {
	withTempDir((dir) => {
		const configPath = goalSettingsPath(dir);
		fs.mkdirSync(path.dirname(configPath), { recursive: true });
		fs.writeFileSync(configPath, JSON.stringify({ disableTasks: true, disableContracts: true }), "utf8");
		const result = loadGoalSettings(dir, { SOME_OTHER_VAR: "x" });
		assert.equal(result.disableTasks, true);
		assert.equal(result.disableContracts, true);
	});
});

test("loadGoalSettings: env var non-true values treated as absent", () => {
	withTempDir((dir) => {
		const configPath = goalSettingsPath(dir);
		fs.mkdirSync(path.dirname(configPath), { recursive: true });
		fs.writeFileSync(configPath, JSON.stringify({ disableTasks: false, disableContracts: false }), "utf8");
		const result = loadGoalSettings(dir, { PI_GOAL_DISABLE_TASKS: "1", PI_GOAL_DISABLE_CONTRACTS: "" });
		assert.equal(result.disableTasks, false, "1 is not 'true'");
		assert.equal(result.disableContracts, false, "empty string treated as absent");
	});
});

test("loadGoalSettings: no file, env var true", () => {
	withTempDir((dir) => {
		const result = loadGoalSettings(dir, { PI_GOAL_DISABLE_TASKS: "true", PI_GOAL_DISABLE_CONTRACTS: "true" });
		assert.equal(result.disableTasks, true);
		assert.equal(result.disableContracts, true);
	});
});

test("loadGoalSettings: both flags disabled via file", () => {
	withTempDir((dir) => {
		const configPath = goalSettingsPath(dir);
		fs.mkdirSync(path.dirname(configPath), { recursive: true });
		fs.writeFileSync(configPath, JSON.stringify({ disableTasks: true, disableContracts: true }), "utf8");
		const result = loadGoalSettings(dir, {});
		assert.equal(result.disableTasks, true);
		assert.equal(result.disableContracts, true);
	});
});

// ── Integration: prompt suppression with settings ────────────────────────

import {
	goalPrompt,
	continuationPrompt,
	taskListBlock,
	verificationContractBlock,
} from "../extensions/prompts/goal-prompts.ts";
import { createGoal } from "../extensions/goal-record.ts";

function goalWithTaskList(overrides: Partial<GoalRecord> & { objective?: string } = {}): GoalRecord {
	const g: GoalRecord = {
		...createGoal({ objective: overrides.objective ?? "Test goal", autoContinue: true, sisyphus: false }),
		...overrides,
	};
	return g;
}

test("taskListBlock: suppressed when disableTasks is true", () => {
	const g = goalWithTaskList();
	g.taskList = { tasks: [{ id: "t1", title: "Task 1", status: "pending" }], blockCompletion: false, proposedAt: new Date().toISOString() };
	const block = taskListBlock(g, { disableTasks: true });
	assert.equal(block, "", "should be empty when tasks disabled");
});

test("taskListBlock: present when disableTasks is false", () => {
	const g = goalWithTaskList();
	g.taskList = { tasks: [{ id: "t1", title: "Task 1", status: "pending" }], blockCompletion: false, proposedAt: new Date().toISOString() };
	const block = taskListBlock(g, { disableTasks: false });
	assert.ok(block.includes("Task 1"), "should contain task when tasks enabled");
});

test("taskListBlock: not suppressed when settings is undefined (backward compat)", () => {
	const g = goalWithTaskList();
	g.taskList = { tasks: [{ id: "t1", title: "Task 1", status: "pending" }], blockCompletion: false, proposedAt: new Date().toISOString() };
	const block = taskListBlock(g);
	assert.ok(block.includes("Task 1"), "should contain task when no settings");
});

test("verificationContractBlock: suppressed when disableContracts is true", () => {
	const g = goalWithTaskList({ verificationContract: "Must verify X" });
	const block = verificationContractBlock(g, { disableContracts: true });
	assert.equal(block, "", "should be empty when contracts disabled");
});

test("verificationContractBlock: present when disableContracts is false", () => {
	const g = goalWithTaskList({ verificationContract: "Must verify X" });
	const block = verificationContractBlock(g, { disableContracts: false });
	assert.ok(block.includes("Must verify X"), "should contain contract when contracts enabled");
});

test("verificationContractBlock: not suppressed when settings is undefined (backward compat)", () => {
	const g = goalWithTaskList({ verificationContract: "Must verify X" });
	const block = verificationContractBlock(g);
	assert.ok(block.includes("Must verify X"), "should contain contract when no settings");
});

test("goalPrompt: contract block suppressed when disableContracts is true", () => {
	const g = goalWithTaskList({ verificationContract: "Must verify X" });
	const prompt = goalPrompt(g, { disableContracts: true });
	assert.ok(!prompt.includes("VERIFICATION CONTRACT"), "contract section suppressed from goalPrompt");
});

test("goalPrompt: task list suppressed when disableTasks is true", () => {
	const g = goalWithTaskList();
	g.taskList = { tasks: [{ id: "t1", title: "Task 1", status: "pending" }], blockCompletion: false, proposedAt: new Date().toISOString() };
	const prompt = goalPrompt(g, { disableTasks: true });
	assert.ok(!prompt.includes("TASK LIST"), "task list suppressed from goalPrompt");
});

test("goalPrompt: contract block shown when settings undefined (backward compat)", () => {
	const g = goalWithTaskList({ verificationContract: "Must verify X" });
	const prompt = goalPrompt(g);
	assert.ok(prompt.includes("VERIFICATION CONTRACT"), "contract shown when no settings");
});

test("continuationPrompt: contract block suppressed when disableContracts is true", () => {
	const g = goalWithTaskList({ verificationContract: "Must verify X" });
	const prompt = continuationPrompt(g, { disableContracts: true });
	assert.ok(!prompt.includes("VERIFICATION CONTRACT"), "contract section suppressed from continuationPrompt");
});

test("continuationPrompt: task list suppressed when disableTasks is true", () => {
	const g = goalWithTaskList();
	g.taskList = { tasks: [{ id: "t1", title: "Task 1", status: "pending" }], blockCompletion: false, proposedAt: new Date().toISOString() };
	const prompt = continuationPrompt(g, { disableTasks: true });
	assert.ok(!prompt.includes("TASK LIST"), "task list suppressed from continuationPrompt");
});

// ── subtaskDepth ────────────────────────────────────────────────────────

test("parseGoalSettings: parses subtaskDepth as number", () => {
	const result = parseGoalSettings({ disableTasks: false, disableContracts: false, subtaskDepth: 2 });
	assert.equal(result.subtaskDepth, 2);
});

test("parseGoalSettings: parses subtaskDepth string", () => {
	const result = parseGoalSettings({ disableTasks: false, disableContracts: false, subtaskDepth: "3" });
	assert.equal(result.subtaskDepth, 3);
});

test("parseGoalSettings: rejects subtaskDepth below 1", () => {
	const result = parseGoalSettings({ disableTasks: false, disableContracts: false, subtaskDepth: 0 });
	assert.equal(result.subtaskDepth, undefined);
});

test("parseGoalSettings: rejects non-numeric subtaskDepth", () => {
	const result = parseGoalSettings({ disableTasks: false, disableContracts: false, subtaskDepth: "abc" });
	assert.equal(result.subtaskDepth, undefined);
});

test("loadGoalSettings: default subtaskDepth is 1", () => {
	withTempDir((dir) => {
		const result = loadGoalSettings(dir, {});
		assert.equal(result.subtaskDepth, 1);
	});
});

test("loadGoalSettings: reads subtaskDepth from file", () => {
	withTempDir((dir) => {
		const configPath = goalSettingsPath(dir);
		fs.mkdirSync(path.dirname(configPath), { recursive: true });
		fs.writeFileSync(configPath, JSON.stringify({ disableTasks: false, disableContracts: false, subtaskDepth: 3 }), "utf8");
		const result = loadGoalSettings(dir, {});
		assert.equal(result.subtaskDepth, 3);
	});
});

// ── Scroll fix: hardware cursor toggle ──────────────────────────────────

test("loadGoalSettings respects various subtaskDepth edge cases", () => {
	withTempDir((dir) => {
		// No file = default 1
		assert.equal(loadGoalSettings(dir, {}).subtaskDepth, 1);

		// subtaskDepth 0 is rejected (below minimum), defaults to 1
		const configPath = goalSettingsPath(dir);
		fs.mkdirSync(path.dirname(configPath), { recursive: true });
		fs.writeFileSync(configPath, JSON.stringify({ disableTasks: false, disableContracts: false, subtaskDepth: 0 }), "utf8");
		assert.equal(loadGoalSettings(dir, {}).subtaskDepth, 1);

		// subtaskDepth non-integer rejected
		fs.writeFileSync(configPath, JSON.stringify({ disableTasks: false, disableContracts: false, subtaskDepth: 1.5 }), "utf8");
		assert.equal(loadGoalSettings(dir, {}).subtaskDepth, 1);

		// subtaskDepth negative rejected
		fs.writeFileSync(configPath, JSON.stringify({ disableTasks: false, disableContracts: false, subtaskDepth: -1 }), "utf8");
		assert.equal(loadGoalSettings(dir, {}).subtaskDepth, 1);
	});
});

// ── E2E-style: simulate goal creation with tasks ────────────────────────

test("normalizeTaskList handles subtasks", () => {
	const raw = {
		tasks: [{
			id: "t1", title: "Parent", status: "pending",
			subtasks: [
				{ id: "t1a", title: "Child", status: "pending" },
			],
		}],
		blockCompletion: false,
		proposedAt: "2026-05-27T00:00:00.000Z",
	};
	const result = normalizeTaskList(raw);
	assert.ok(result);
	assert.equal(result.tasks.length, 1);
	assert.ok(result.tasks[0]!.subtasks);
	assert.equal(result.tasks[0]!.subtasks![0]!.id, "t1a");
	assert.equal(result.tasks[0]!.subtasks![0]!.title, "Child");

	// Verify normalizeTaskItem creates proper nested structure
	const item = normalizeTaskItem({
		id: "x", title: "X", status: "pending",
		subtasks: [
			{ id: "xa", title: "XA", status: "complete" },
		],
	});
	assert.ok(item);
	assert.equal(item.subtasks?.length, 1);
	assert.equal(item.subtasks![0]!.id, "xa");
	assert.equal(item.subtasks![0]!.status, "complete");
});

test("normalizeTaskItem preserves lightweightSubtasks flag", () => {
	const item = normalizeTaskItem({
		id: "t1", title: "T1", status: "pending",
		lightweightSubtasks: true,
		subtasks: [{ id: "t1a", title: "A", status: "pending" }],
	});
	assert.ok(item);
	assert.equal(item.lightweightSubtasks, true);
	assert.equal(item.subtasks?.length, 1);
});
