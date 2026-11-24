/**
 * Settings files: where the global and project layers live, reading them from
 * disk, and the cache that keeps repeated loads free of I/O.
 *
 *     global:  ${PI_CODING_AGENT_DIR:-~/.pi/agent}/pi-goal-x-settings.json
 *     project: <cwd>/.pi/pi-goal-x-settings.json
 *
 * Overrides: PI_GOAL_GLOBAL_SETTINGS_FILE and PI_GOAL_SETTINGS_FILE.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { asNonEmptyString, parseSettingsLayer, type GoalSettings, type GoalSettingsLayer, type SettingsDiagnostic, type SettingsScope } from "./schema.ts";

export const PI_GOAL_SETTINGS_FILE_ENV = "PI_GOAL_SETTINGS_FILE";
const PI_GOAL_GLOBAL_SETTINGS_FILE_ENV = "PI_GOAL_GLOBAL_SETTINGS_FILE";

/** Resolve the pi agent dir honoring PI_CODING_AGENT_DIR (absolute or ~-relative to homeDir). */
export function resolveAgentDir(env: NodeJS.ProcessEnv = process.env, homeDir: string = os.homedir()): string {
	const override = asNonEmptyString(env.PI_CODING_AGENT_DIR);
	if (override) {
		return path.isAbsolute(override) ? path.normalize(override) : path.resolve(homeDir, override);
	}
	return path.join(homeDir, ".pi", "agent");
}

/**
 * Global settings path: PI_GOAL_GLOBAL_SETTINGS_FILE if set (absolute or
 * relative to homeDir), else <agentDir>/pi-goal-x-settings.json.
 */
export function goalGlobalSettingsPath(env: NodeJS.ProcessEnv = process.env, homeDir: string = os.homedir()): string {
	const override = asNonEmptyString(env[PI_GOAL_GLOBAL_SETTINGS_FILE_ENV]);
	if (override) {
		return path.isAbsolute(override) ? path.normalize(override) : path.resolve(homeDir, override);
	}
	return path.join(resolveAgentDir(env, homeDir), "pi-goal-x-settings.json");
}

/**
 * Project settings path: PI_GOAL_SETTINGS_FILE if set (absolute or relative
 * to cwd), else <cwd>/.pi/pi-goal-x-settings.json.
 */
export function goalSettingsPath(cwd: string, env: NodeJS.ProcessEnv = process.env): string {
	const override = asNonEmptyString(env[PI_GOAL_SETTINGS_FILE_ENV]);
	if (override) {
		return path.isAbsolute(override) ? override : path.join(cwd, override);
	}
	return path.join(cwd, ".pi", "pi-goal-x-settings.json");
}

export interface SettingsLayerRead {
	scope: SettingsScope;
	path: string;
	status: "ok" | "missing" | "invalid";
	layer: GoalSettingsLayer;
	diagnostics: SettingsDiagnostic[];
	fingerprint: string;
}

// Missing and malformed files are cached too, so repeated loads do no I/O.
const settingsFileCache = new Map<string, SettingsLayerRead>();

/**
 * Session boundary (session_start / resume): drop the zero-op settings cache
 * so a new session always reads both layers fresh from disk. The resolved
 * snapshot cache is keyed on layer identity, so fresh reads miss it too.
 */
export function invalidateGoalSettingsCache(): void {
	settingsFileCache.clear();
}

/** Drop one file's cached read (after a write to it). */
export function invalidateSettingsCachePath(target: string): void {
	settingsFileCache.delete(target);
}

// ── layer reads (cache-served, zero-op steady state) ───────────────────────

function fingerprintOf(text: string): string {
	// Cheap stable fingerprint: length + simple rolling sum (not security).
	let hash = 2166136261;
	for (let i = 0; i < text.length; i += 1) {
		hash ^= text.charCodeAt(i);
		hash = Math.imul(hash, 16777619);
	}
	return `${text.length}:${(hash >>> 0).toString(16)}`;
}

function statusFor(diagnostics: SettingsDiagnostic[], hadContent: boolean): "ok" | "missing" | "invalid" {
	if (diagnostics.some((d) => d.code === "invalid_json" || d.code === "not_object")) return "invalid";
	if (!hadContent) return "missing";
	return diagnostics.length > 0 ? "invalid" : "ok";
}

export function readSettingsLayerFresh(target: string, scope: SettingsScope): SettingsLayerRead {
	const read = parseSettingsFile(target, scope);
	settingsFileCache.set(target, read);
	return read;
}

function parseSettingsFile(target: string, scope: SettingsScope): SettingsLayerRead {
	let rawText: string;
	try {
		rawText = fs.readFileSync(target, "utf8");
	} catch {
		return { scope, path: target, status: "missing", layer: {}, diagnostics: [], fingerprint: "missing" };
	}
	const fingerprint = fingerprintOf(rawText);
	let parsed: unknown;
	try {
		parsed = JSON.parse(rawText);
	} catch {
		const diagnostics: SettingsDiagnostic[] = [{ scope, path: target, code: "invalid_json", message: "settings file is not valid JSON" }];
		return { scope, path: target, status: "invalid", layer: {}, diagnostics, fingerprint };
	}
	const { layer, diagnostics } = parseSettingsLayer(parsed, scope, target);
	return { scope, path: target, status: statusFor(diagnostics, rawText.trim().length > 0), layer, diagnostics, fingerprint };
}

/** Cache-served layer read (zero-op in steady state). */
export function readSettingsLayer(target: string, scope: SettingsScope): SettingsLayerRead {
	return settingsFileCache.get(target) ?? readSettingsLayerFresh(target, scope);
}

/** Load just one layer's sparse config (compat helper over readSettingsLayer). */
export function loadGoalSettingsFileConfig(cwd: string, env: NodeJS.ProcessEnv = process.env): GoalSettings {
	return readSettingsLayer(goalSettingsPath(cwd, env), "project").layer as GoalSettings;
}
