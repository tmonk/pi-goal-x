/**
 * PR #27 clean rewrite — layered global settings.
 *
 * Covers path resolution (injected env/home), the layering matrix
 * (env > project > global > defaults), per-leaf provenance, diagnostics,
 * conflict-safe scoped mutation, and fault behavior.
 */

import { skipWhenRoot } from "./support/permissions.ts";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
	resolveAgentDir,
	goalGlobalSettingsPath,
	goalSettingsPath,
	loadGoalSettings,
	saveGoalSettingsFileConfig,
	loadSettingsSnapshot,
	readSettingsLayer,
	mutateSettingsLayer,
	SettingsMutationError,
	invalidateGoalSettingsCache,
	type SettingsScope,
} from "../extensions/goal-settings.ts";

function withTempDir(fn: (dir: string) => void): void {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "goal-layered-")));
	try {
		fn(dir);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

function writeJson(file: string, value: unknown): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, JSON.stringify(value), "utf8");
}

describe("path resolution", () => {
	it("global path defaults to ~/.pi/agent/pi-goal-x-settings.json", () => {
		const p = goalGlobalSettingsPath({}, "/home/u");
		assert.equal(p, path.join("/home/u", ".pi", "agent", "pi-goal-x-settings.json"));
	});

	it("PI_CODING_AGENT_DIR overrides the agent dir (absolute and home-relative)", () => {
		assert.equal(resolveAgentDir({ PI_CODING_AGENT_DIR: "/opt/agent" }, "/home/u"), path.normalize("/opt/agent"));
		assert.equal(goalGlobalSettingsPath({ PI_CODING_AGENT_DIR: "agent-rel" }, "/home/u"), path.resolve("/home/u", "agent-rel", "pi-goal-x-settings.json"));
	});

	it("PI_GOAL_GLOBAL_SETTINGS_FILE overrides the whole path (absolute and home-relative)", () => {
		assert.equal(goalGlobalSettingsPath({ PI_GOAL_GLOBAL_SETTINGS_FILE: "/etc/g.json" }, "/home/u"), path.normalize("/etc/g.json"));
		assert.equal(goalGlobalSettingsPath({ PI_GOAL_GLOBAL_SETTINGS_FILE: "g.json" }, "/home/u"), path.resolve("/home/u", "g.json"));
	});

	it("project path honors PI_GOAL_SETTINGS_FILE relative to cwd", () => {
		assert.equal(goalSettingsPath("/tmp/p", { PI_GOAL_SETTINGS_FILE: "custom.json" }), path.join("/tmp/p", "custom.json"));
	});
});

describe("layering matrix", () => {
	it("context display defaults off and preserves both values, provenance and override removal", () => {
		withTempDir(dir => {
			const env = {PI_GOAL_GLOBAL_SETTINGS_FILE: path.join(dir, "global.json")};
			const change = (scope: SettingsScope, op: "set" | "unset", value?: unknown) => mutateSettingsLayer({scope, cwd: dir, env, mutation: op === "set" ? {op, path: ["showContextUsage"], value} : {op, path: ["showContextUsage"]}});
			assert.equal(loadGoalSettings(dir, env).showContextUsage, false);
			for (const value of [false, true]) {
				change("global", "set", value);
				assert.equal(loadGoalSettings(dir, env).showContextUsage, value);
				assert.equal(loadSettingsSnapshot(dir, env).provenance.get("showContextUsage")?.source, "global");
				change("project", "set", !value);
				assert.equal(loadGoalSettings(dir, env).showContextUsage, !value);
				assert.equal(loadSettingsSnapshot(dir, env).provenance.get("showContextUsage")?.source, "project");
				const bytes = fs.readFileSync(goalSettingsPath(dir, env), "utf8");
				assert.equal(JSON.parse(bytes).showContextUsage, !value);
				for (const invalid of [1, null, "off"]) assert.throws(() => change("project", "set", invalid), SettingsMutationError);
				assert.equal(fs.readFileSync(goalSettingsPath(dir, env), "utf8"), bytes);
				change("project", "unset");
				assert.equal(loadGoalSettings(dir, env).showContextUsage, value);
			}
			change("global", "unset");
			assert.equal(loadGoalSettings(dir, env).showContextUsage, false);
			saveGoalSettingsFileConfig(dir, {showContextUsage: false});
			assert.equal(JSON.parse(fs.readFileSync(goalSettingsPath(dir, env), "utf8")).showContextUsage, false, "sparse legacy saves retain explicit false too");
		});
	});
	it("idle backoff defaults off and preserves explicit project false, inheritance and reopen", () => {
		withTempDir(dir => {
			const env = { PI_GOAL_GLOBAL_SETTINGS_FILE: path.join(dir, "global.json") };
			invalidateGoalSettingsCache();
			assert.equal(loadGoalSettings(dir, env).idleContinuationBackoff, false);
			const change = (scope: SettingsScope, mutation: Parameters<typeof mutateSettingsLayer>[0]["mutation"]) => mutateSettingsLayer({ scope, cwd: dir, env, mutation });
			for (const invalid of [1, null, "enabled"]) assert.throws(() => change("project", { op: "set", path: ["idleContinuationBackoff"], value: invalid }), SettingsMutationError);
			change("global", { op: "set", path: ["idleContinuationBackoff"], value: true });
			assert.equal(loadSettingsSnapshot(dir, env).provenance.get("idleContinuationBackoff")?.source, "global");
			assert.equal(loadGoalSettings(dir, env).idleContinuationBackoff, true);
			change("project", { op: "set", path: ["idleContinuationBackoff"], value: false });
			invalidateGoalSettingsCache();
			assert.equal(loadGoalSettings(dir, env).idleContinuationBackoff, false);
			assert.equal(loadSettingsSnapshot(dir, env).provenance.get("idleContinuationBackoff")?.source, "project");
			change("project", { op: "unset", path: ["idleContinuationBackoff"] });
			assert.equal(loadGoalSettings(dir, env).idleContinuationBackoff, true);
			change("global", { op: "unset", path: ["idleContinuationBackoff"] });
			assert.equal(loadGoalSettings(dir, env).idleContinuationBackoff, false);
		});
	});
	it("no global file behaves identically to project-only resolution", () => {
		withTempDir((dir) => {
			const env = { PI_GOAL_GLOBAL_SETTINGS_FILE: path.join(dir, "no-global.json") };
			writeJson(path.join(dir, ".pi", "pi-goal-x-settings.json"), { disableTasks: true });
			invalidateGoalSettingsCache();
			const s = loadGoalSettings(dir, env);
			assert.equal(s.disableTasks, true);
			const snap = loadSettingsSnapshot(dir, env);
			assert.equal(snap.global.status, "missing");
		});
	});

	it("global-only setting applies when project absent", () => {
		withTempDir((dir) => {
			const globalFile = path.join(dir, "global.json");
			const env = { PI_GOAL_GLOBAL_SETTINGS_FILE: globalFile };
			writeJson(globalFile, { subtaskDepth: 4 });
			invalidateGoalSettingsCache();
			assert.equal(loadGoalSettings(dir, env).subtaskDepth, 4);
		});
	});

	it("project overrides global for booleans, integers, strings", () => {
		withTempDir((dir) => {
			const env = { PI_GOAL_GLOBAL_SETTINGS_FILE: path.join(dir, "g.json") };
			writeJson(path.join(dir, "g.json"), { disableTasks: true, objectiveMaxChars: 5000, provider: "globalprov" });
			writeJson(path.join(dir, ".pi", "pi-goal-x-settings.json"), { disableTasks: false, objectiveMaxChars: 0, provider: "projprov" });
			invalidateGoalSettingsCache();
			const s = loadGoalSettings(dir, env);
			assert.equal(s.disableTasks, false, "explicit project false overrides global true");
			assert.equal(s.objectiveMaxChars, 0, "explicit project zero overrides global positive");
			assert.equal(s.provider, "projprov");
		});
	});

	it("environment overrides both layers", () => {
		withTempDir((dir) => {
			const env = {
				PI_GOAL_GLOBAL_SETTINGS_FILE: path.join(dir, "g.json"),
				PI_GOAL_DISABLE_TASKS: "true",
				PI_GOAL_OBJECTIVE_MAX_CHARS: "99",
			};
			writeJson(path.join(dir, "g.json"), { disableTasks: false });
			writeJson(path.join(dir, ".pi", "pi-goal-x-settings.json"), { disableTasks: false });
			invalidateGoalSettingsCache();
			const s = loadGoalSettings(dir, env);
			assert.equal(s.disableTasks, true);
			assert.equal(s.objectiveMaxChars, 99);
		});
	});

	it("nested keybindings inherit per leaf; partial override does not reset other leaves", () => {
		withTempDir((dir) => {
			const env = { PI_GOAL_GLOBAL_SETTINGS_FILE: path.join(dir, "g.json") };
			writeJson(path.join(dir, "g.json"), { keybindings: { dashboard: { toggleExpand: "ctrl+g", scrollUp: "ctrl+up" } } });
			writeJson(path.join(dir, ".pi", "pi-goal-x-settings.json"), { keybindings: { dashboard: { toggleExpand: "ctrl+p" } } });
			invalidateGoalSettingsCache();
			const s = loadGoalSettings(dir, env);
			assert.equal(s.keybindings?.dashboard.toggleExpand, "ctrl+p", "project leaf wins");
			assert.equal(s.keybindings?.dashboard.scrollUp, "ctrl+up", "unset project leaf inherits global");
			assert.equal(s.keybindings?.dashboard.scrollDown, "ctrl+shift+down", "missing everywhere falls back to default");
		});
	});

	it("provenance records the source of every leaf", () => {
		withTempDir((dir) => {
			const env = { PI_GOAL_GLOBAL_SETTINGS_FILE: path.join(dir, "g.json"), PI_GOAL_DISABLE_CONTRACTS: "false" };
			writeJson(path.join(dir, "g.json"), { disableContracts: true, subtaskDepth: 2 });
			writeJson(path.join(dir, ".pi", "pi-goal-x-settings.json"), { subtaskDepth: 5 });
			invalidateGoalSettingsCache();
			const snap = loadSettingsSnapshot(dir, env);
			assert.equal(snap.provenance.get("disableContracts")?.source, "environment");
			assert.equal(snap.provenance.get("disableContracts")?.envVar, "PI_GOAL_DISABLE_CONTRACTS");
			assert.equal(snap.provenance.get("subtaskDepth")?.source, "project");
			assert.equal(snap.provenance.get("autoSelectSingleGoal")?.source, "default");
			assert.equal(snap.provenance.get("keybindings.dashboard.toggleExpand")?.source, "default");
		});
	});
});

describe("diagnostics", () => {
	it("unknown keys produce diagnostics while known values still apply", () => {
		withTempDir((dir) => {
			const env = { PI_GOAL_GLOBAL_SETTINGS_FILE: path.join(dir, "g.json") };
			writeJson(path.join(dir, ".pi", "pi-goal-x-settings.json"), { disableTasks: true, totallyUnknown: 1 });
			invalidateGoalSettingsCache();
			const snap = loadSettingsSnapshot(dir, env);
			assert.equal(snap.value.disableTasks, true, "valid known key still loads");
			assert.ok(snap.diagnostics.some((d) => d.code === "unknown_key" && d.scope === "project" && d.settingPath === "totallyUnknown"));
		});
	});

	it("malformed global with valid project still resolves the project layer", () => {
		withTempDir((dir) => {
			const env = { PI_GOAL_GLOBAL_SETTINGS_FILE: path.join(dir, "g.json") };
			fs.mkdirSync(dir, { recursive: true });
			fs.writeFileSync(path.join(dir, "g.json"), "{not json", "utf8");
			writeJson(path.join(dir, ".pi", "pi-goal-x-settings.json"), { disableContracts: true });
			invalidateGoalSettingsCache();
			const snap = loadSettingsSnapshot(dir, env);
			assert.equal(snap.global.status, "invalid");
			assert.equal(snap.value.disableContracts, true);
		});
	});

	it("invalid values are diagnosed without erasing sibling keys", () => {
		withTempDir((dir) => {
			const env = { PI_GOAL_GLOBAL_SETTINGS_FILE: path.join(dir, "nonexistent-g.json") };
			writeJson(path.join(dir, ".pi", "pi-goal-x-settings.json"), { subtaskDepth: -3, provider: "ok" });
			invalidateGoalSettingsCache();
			const snap = loadSettingsSnapshot(dir, env);
			assert.equal(snap.project.status, "invalid");
			assert.equal(snap.value.provider, "ok");
			assert.ok(snap.diagnostics.some((d) => d.code === "invalid_value" && d.settingPath === "subtaskDepth"));
		});
	});
});

describe("scoped mutation", () => {
	function scopeTarget(dir: string, scope: SettingsScope): string {
		return scope === "global" ? path.join(dir, "g.json") : path.join(dir, ".pi", "pi-goal-x-settings.json");
	}

	it("set/unset round trip restores inheritance and returns a fresh snapshot", () => {
		withTempDir((dir) => {
			const env = { PI_GOAL_GLOBAL_SETTINGS_FILE: path.join(dir, "g.json") };
			writeJson(path.join(dir, "g.json"), { disableTasks: true });
			invalidateGoalSettingsCache();
			mutateSettingsLayer({ scope: "project", cwd: dir, env, mutation: { op: "set", path: ["disableTasks"], value: false } });
			let snap = loadSettingsSnapshot(dir, env);
			assert.equal(snap.value.disableTasks, false);
			assert.equal(snap.provenance.get("disableTasks")?.source, "project");
			mutateSettingsLayer({ scope: "project", cwd: dir, env, mutation: { op: "unset", path: ["disableTasks"] } });
			snap = loadSettingsSnapshot(dir, env);
			assert.equal(snap.value.disableTasks, true, "unset restores inheritance");
			assert.equal(snap.provenance.get("disableTasks")?.source, "global");
		});
	});

	it("refuses to overwrite an invalid layer without explicit repair", () => {
		withTempDir((dir) => {
			const env = { PI_GOAL_GLOBAL_SETTINGS_FILE: path.join(dir, "g.json") };
			fs.writeFileSync(scopeTarget(dir, "global"), "{broken", "utf8");
			invalidateGoalSettingsCache();
			assert.throws(
				() => mutateSettingsLayer({ scope: "global", cwd: dir, env, mutation: { op: "set", path: ["provider"], value: "x" } }),
				(err: unknown) => err instanceof SettingsMutationError && /Refusing to overwrite invalid global settings/.test(err.message),
			);
			assert.match(fs.readFileSync(scopeTarget(dir, "global"), "utf8"), /\{broken/);
		});
	});

	it("stale lock (dead pid) is recovered and the mutation succeeds", () => {
		withTempDir((dir) => {
			const env = { PI_GOAL_GLOBAL_SETTINGS_FILE: path.join(dir, "g.json") };
			const target = scopeTarget(dir, "global");
			writeJson(target, {});
			fs.writeFileSync(`${target}.lock`, JSON.stringify({ pid: 999_999_999, startedAt: new Date(Date.now() - 60_000).toISOString() }), "utf8");
			invalidateGoalSettingsCache();
			mutateSettingsLayer({ scope: "global", cwd: dir, env, mutation: { op: "set", path: ["model"], value: "m" } });
			assert.equal(readSettingsLayer(target, "global").layer.model, "m");
		});
	});

	it("failed write preserves the original file (fault injection)", skipWhenRoot, () => {
		withTempDir((dir) => {
			const env = { PI_GOAL_GLOBAL_SETTINGS_FILE: path.join(dir, "g.json") };
			const target = scopeTarget(dir, "global");
			writeJson(target, { provider: "keep" });
			invalidateGoalSettingsCache();
			// Make the directory read-only AFTER the original file exists so the
			// temp-file creation fails; the original must remain intact.
			fs.chmodSync(dir, 0o555);
			try {
				assert.throws(() =>
					mutateSettingsLayer({ scope: "global", cwd: dir, env, mutation: { op: "set", path: ["provider"], value: "changed" } }),
				);
			} finally {
				fs.chmodSync(dir, 0o755);
			}
			invalidateGoalSettingsCache();
			const layer = readSettingsLayer(target, "global").layer;
			assert.equal(layer.provider, "keep", "original preserved after failed write");
			assert.equal(typeof JSON.parse(fs.readFileSync(target, "utf8")).provider, "string");
		});
	});

	it("refuses a symlink target", () => {
		withTempDir((dir) => {
			const env = { PI_GOAL_GLOBAL_SETTINGS_FILE: path.join(dir, "g.json") };
			const real = path.join(dir, "real.json");
			const link = path.join(dir, "g.json");
			writeJson(real, {});
			fs.symlinkSync(real, link);
			invalidateGoalSettingsCache();
			assert.throws(
				() => mutateSettingsLayer({ scope: "global", cwd: dir, env, mutation: { op: "set", path: ["model"], value: "m" } }),
				/symlink/i,
			);
		});
	});

	it("external edits to either layer are picked up after cache invalidation with separate fingerprints", () => {
		withTempDir((dir) => {
			const env = { PI_GOAL_GLOBAL_SETTINGS_FILE: path.join(dir, "g.json") };
			writeJson(path.join(dir, "g.json"), { model: "one" });
			writeJson(path.join(dir, ".pi", "pi-goal-x-settings.json"), { provider: "p1" });
			invalidateGoalSettingsCache();
			const before = loadSettingsSnapshot(dir, env);
			assert.notEqual(before.global.fingerprint, before.project.fingerprint);
			writeJson(path.join(dir, "g.json"), { model: "two" });
			invalidateGoalSettingsCache();
			const after = loadSettingsSnapshot(dir, env);
			assert.equal(after.value.model, "two");
			assert.equal(after.project.fingerprint, before.project.fingerprint, "untouched layer keeps its fingerprint");
		});
	});
});
