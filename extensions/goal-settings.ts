/**
 * Layered global goal settings (clean rewrite of PR #27).
 *
 * Resolution order (per leaf):
 *
 *     environment > project layer > global layer > defaults
 *
 * Files:
 *
 *     global:  ${PI_CODING_AGENT_DIR:-~/.pi/agent}/pi-goal-x-settings.json
 *     project: <cwd>/.pi/pi-goal-x-settings.json
 *
 * Overrides: PI_GOAL_GLOBAL_SETTINGS_FILE, PI_GOAL_SETTINGS_FILE, and the
 * per-setting PI_GOAL_* variables.
 *
 * Two distinct types (never one interface for both): GoalSettingsLayer is the
 * SPARSE file content (booleans tri-state, 0 meaningful); GoalSettings is the
 * RESOLVED runtime value with concrete defaults. Layer files are parsed into
 * diagnostics rather than rejected wholesale — unknown keys are reported, and
 * every valid known key still applies.
 *
 * Mutations go through mutateSettingsLayer(): fresh re-read under a filesystem
 * path lock, structured-clone apply, atomic same-dir temp+rename write with
 * mode preservation — concurrent processes never lose each other's keys.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { writeFileAtomicSync } from "./storage/atomic-rename.ts";
import { acquireFileLock, type FileLock } from "./storage/file-lock.ts";
import { GOAL_COMMANDS, GOAL_KEY_ACTIONS, PAUSE_ORDERS, parseCommandPaths, parseGoalKeybinding, type GoalCommands, type GoalKeybinding, type PauseOrder } from "./goal-controls.ts";

export const GOAL_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = typeof GOAL_THINKING_LEVELS[number];

// ── sparse keybinding layers ────────────────────────────────────────────────

export interface GoalDashboardKeybindings {
	toggleExpand: GoalKeybinding;
	scrollUp: GoalKeybinding;
	scrollDown: GoalKeybinding;
	scrollPageUp?: GoalKeybinding;
	scrollPageDown?: GoalKeybinding;
	scrollFirst?: GoalKeybinding;
	scrollLast?: GoalKeybinding;
	collapse?: GoalKeybinding;
	up?: GoalKeybinding;
	down?: GoalKeybinding;
	pageUp?: GoalKeybinding;
	pageDown?: GoalKeybinding;
	first?: GoalKeybinding;
	last?: GoalKeybinding;
}
export type GoalDashboardKeybindingsLayer = Partial<GoalDashboardKeybindings>;
export interface GoalKeybindings {
	dashboard: GoalDashboardKeybindings;
	pause?: GoalKeybinding;
	toggleAuditor?: GoalKeybinding;
	interruptAudit?: GoalKeybinding;
	dialog?: Partial<Record<import("./goal-controls.ts").GoalDialogAction, GoalKeybinding>>;
	commands?: Partial<Record<import("./goal-controls.ts").GoalCommandId, GoalKeybinding>>;
}
export const DEFAULT_GOAL_KEYBINDINGS: GoalKeybindings = {
	dashboard: {
		toggleExpand: "ctrl+shift+t",
		scrollUp: "ctrl+shift+up",
		scrollDown: "ctrl+shift+down",
	},
};

/**
 * Default ceiling for a single recovery delay; the escalation ladder
 * plateaus here. Configurable via networkRecovery.maxDelayMs.
 */
export const DEFAULT_NETWORK_RECOVERY_MAX_DELAY_MS = 80_000;

export function formatGoalKeybinding(key: GoalKeybinding | undefined): string {
	if (Array.isArray(key)) return key.length ? key.map(k => formatGoalKeybinding(k)).join(" / ") : "Unbound";
	if (!key) return "Unbound";
	return key.split("+").map((part) => ({
		ctrl: "Ctrl",
		control: "Ctrl",
		shift: "Shift",
		alt: "Alt",
		up: "↑",
		down: "↓",
		left: "←",
		right: "→",
		pageup: "PageUp",
		pagedown: "PageDown",
		home: "Home",
		end: "End",
		enter: "Enter",
		escape: "Esc",
	}[part.toLowerCase()] ?? part.toUpperCase())).join("+");
}

// ── resolved settings (runtime shape) ───────────────────────────────────────

export interface GoalSettingsResolvedShape {
	disableTasks?: boolean;
	disableContracts?: boolean;
	subtaskDepth?: number;
	provider?: string;
	model?: string;
	thinkingLevel?: ThinkingLevel;
	disabled?: boolean;
	autoSelectSingleGoal?: boolean;
	/** E3: load the project's own skills/extensions into auditor sessions (off by default = isolation). */
	auditorProjectResources?: boolean;
	/** F5: stall detector timeout in minutes (0 = off). */
	stallTimeoutMinutes?: number;
	/** Optional extension-run limit per creation/resume; zero disables, absent inherits (default unlimited). */
	maxAutonomousRuns?: number;
	/**
	 * Report the "Autonomous runs: used/limit" line for a finite run allowance
	 * (default true). The line reports a limit, so it appears exactly when a
	 * finite allowance exists. Display only; enforcement is unaffected.
	 */
	showAutonomousRuns?: boolean;
	/** Include context-window occupancy in new prompt snapshots (off by default). */
	showContextUsage?: boolean;
	strictExecutionContract?: boolean;
	/** Delay repeated executions without recognized work (off by default). */
	idleContinuationBackoff?: boolean;
	/**
	 * Maximum objective length in characters (0/unset = no limit, the
	 * default; >0 caps objectives in create_goal, propose_goal_draft, and
	 * /goal-tweak).
	 */
	objectiveMaxChars?: number;
	/** Keyboard shortcuts for the compact task list and dashboard expansion. */
	keybindings?: GoalKeybindings;
	commands?: GoalCommands;
	pauseOrder?: PauseOrder;
	/** PR #29: suppress the unfocused goal widget + status hint (default false). */
	hideUnfocusedBanner?: boolean;
	/** Issue #72: suppress the model-facing [PI GOAL UNFOCUSED] prompt (default false). */
	hideUnfocusedPrompt?: boolean;
	goalsRoot?: string;
	/** Issue #26: opt-in read-only blocker Oracle configuration (sparse). */
	oracle?: GoalOracleSettingsLayer;
	/**
	 * Goal-level provider-error recovery backoff (sparse). maxAttempts 0 or
	 * unset = unbounded retry (default); maxDelayMs caps the delay plateau.
	 */
	networkRecovery?: GoalNetworkRecoverySettingsLayer;
}

// Resolved Oracle settings are attached to the resolved runtime shape below
// (see ResolvedGoalOracleSettings).

/**
 * Issue #26: sparse per-leaf Oracle settings. Every leaf inherits
 * independently (project > global > default); enabled defaults false.
 */
export interface GoalOracleSettingsLayer {
	enabled?: boolean;
	provider?: string;
	model?: string;
	thinkingLevel?: ThinkingLevel;
	projectResources?: boolean;
	maxFailedAttemptsPerBlocker?: number;
}

export interface ResolvedGoalOracleSettings {
	enabled: boolean;
	provider?: string;
	model?: string;
	thinkingLevel?: ThinkingLevel;
	projectResources: boolean;
	maxFailedAttemptsPerBlocker: number;
}

/** Sparse per-leaf network-recovery settings (maxAttempts 0 = unbounded). */
export interface GoalNetworkRecoverySettingsLayer {
	maxAttempts?: number;
	maxDelayMs?: number;
}

/** Resolved network-recovery settings (concrete defaults). */
export interface ResolvedGoalNetworkRecoverySettings {
	maxAttempts: number;
	maxDelayMs: number;
}

/**
 * Sparse settings layer: exactly what a settings FILE may contain. Every
 * field optional; explicit false/0 preserved so lower layers can override
 * higher ones. Never passed to prompt/runtime code — that consumes the
 * resolved GoalSettings below.
 */
export interface GoalSettingsLayer extends GoalSettingsResolvedShape {}

/**
 * Fully resolved runtime settings (defaults filled). Exported as an alias for
 * compatibility: all existing consumers keep importing GoalSettings.
 */
export interface ResolvedGoalSettingsShape extends GoalSettingsResolvedShape {
	/** Issue #26: resolved opt-in blocker Oracle configuration. */
	oracle?: ResolvedGoalOracleSettings;
	/** Resolved goal-level provider-error recovery configuration. */
	networkRecovery?: ResolvedGoalNetworkRecoverySettings;
}

export type ResolvedGoalSettings = ResolvedGoalSettingsShape;

/** Compatibility alias: runtime code keeps importing GoalSettings. */
export type GoalSettings = ResolvedGoalSettings;

export const PI_GOAL_SETTINGS_FILE_ENV = "PI_GOAL_SETTINGS_FILE";
export const PI_GOAL_GLOBAL_SETTINGS_FILE_ENV = "PI_GOAL_GLOBAL_SETTINGS_FILE";

const THINKING_LEVELS = new Set<string>(GOAL_THINKING_LEVELS);

// ── pure path resolution ────────────────────────────────────────────────────

function asNonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

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

// ── diagnostics ─────────────────────────────────────────────────────────────

export type SettingsScope = "global" | "project";

export type SettingsDiagnosticCode =
	| "invalid_json"
	| "not_object"
	| "unknown_key"
	| "invalid_value"
	| "invalid_nested_key";

export interface SettingsDiagnostic {
	scope: SettingsScope;
	path: string;
	settingPath?: string;
	code: SettingsDiagnosticCode;
	message: string;
}

export interface SettingsLayerRead {
	scope: SettingsScope;
	path: string;
	status: "ok" | "missing" | "invalid";
	layer: GoalSettingsLayer;
	diagnostics: SettingsDiagnostic[];
	fingerprint: string;
}

// ── zero-op cache ───────────────────────────────────────────────────────────

interface SettingsFileCacheEntry {
	/** Missing/malformed file: cached so repeated loads are zero-op too. */
	missing?: boolean;
	read?: SettingsLayerRead;
}

const settingsFileCache = new Map<string, SettingsFileCacheEntry>();

/**
 * Session boundary (session_start / resume): drop the zero-op settings cache
 * so a new session always reads both layers fresh from disk.
 */
export function invalidateGoalSettingsCache(): void {
	settingsFileCache.clear();
	resolvedSettingsCache.length = 0;
}

function invalidateSettingsCachePath(target: string): void {
	settingsFileCache.delete(target);
	resolvedSettingsCache.length = 0;
}

// ── leaf parsers (diagnostic-producing, never throwing) ─────────────────────

function asBool(value: unknown): boolean | undefined {
	if (value === true || value === "true") return true;
	if (value === false || value === "false") return false;
	return undefined;
}

function asPositiveInt(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isInteger(value) && value >= 1) return value;
	if (typeof value === "string") {
		const n = parseInt(value, 10);
		if (!isNaN(n) && n >= 1) return n;
	}
	return undefined;
}

/** Positive-integer-or-zero parser (for settings where 0 = off / no limit). */
function asNonNegativeInt(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isInteger(value) && value >= 0) return value;
	if (typeof value === "string") {
		const n = parseInt(value, 10);
		if (!isNaN(n) && n >= 0) return n;
	}
	return undefined;
}

function asThinkingLevel(value: unknown): ThinkingLevel | undefined {
	const text = asNonEmptyString(value);
	return text && THINKING_LEVELS.has(text) ? text as ThinkingLevel : undefined;
}

const ALLOWED_SETTINGS_KEYS = new Set([
	"disableTasks",
	"disableContracts",
	"subtaskDepth",
	"provider",
	"model",
	"thinkingLevel",
	"thinking_level",
	"disabled",
	"autoSelectSingleGoal",
	"auditorProjectResources",
	"stallTimeoutMinutes",
	"maxAutonomousRuns",
	"strictExecutionContract",
	"idleContinuationBackoff",
	"objectiveMaxChars",
	"keybindings",
	"commands",
	"pauseOrder",
	"hideUnfocusedBanner",
	"showAutonomousRuns",
	"showContextUsage",
	"hideUnfocusedPrompt",
	"goalsRoot",
	"oracle",
	"networkRecovery",
]);

const ALLOWED_NETWORK_RECOVERY_KEYS = new Set(["maxAttempts", "maxDelayMs"]);

const ALLOWED_ORACLE_KEYS = new Set([
	"enabled",
	"provider",
	"model",
	"thinkingLevel",
	"thinking_level",
	"projectResources",
	"maxFailedAttemptsPerBlocker",
]);

/**
 * Parse raw JSON content into a sparse layer plus diagnostics. Unknown keys
 * and invalid values produce diagnostics; they never erase valid known keys
 * in the same file, and this never throws for content problems.
 */
export function parseSettingsLayer(
	raw: unknown,
	scope: SettingsScope,
	filePath: string,
): { layer: GoalSettingsLayer; diagnostics: SettingsDiagnostic[] } {
	const diagnostics: SettingsDiagnostic[] = [];
	const diagnostic = (
		code: SettingsDiagnosticCode,
		message: string,
		settingPath?: string,
	): SettingsDiagnostic => ({ scope, path: filePath, settingPath, code, message });

	if (raw === null || raw === undefined) return { layer: {}, diagnostics };
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		diagnostics.push(diagnostic("not_object", "settings file must contain a JSON object"));
		return { layer: {}, diagnostics };
	}
	const record = raw as Record<string, unknown>;
	const layer: GoalSettingsLayer = {};

	for (const [key, value] of Object.entries(record)) {
		switch (key) {
			case "idleContinuationBackoff":
			case "strictExecutionContract":
			case "disableTasks":
			case "disableContracts":
			case "disabled":
			case "autoSelectSingleGoal":
			case "auditorProjectResources":
			case "hideUnfocusedBanner":
			case "showAutonomousRuns":
			case "showContextUsage":
			case "hideUnfocusedPrompt": {
				const parsed = asBool(value);
				if (parsed === undefined) {
					if (value !== undefined) diagnostics.push(diagnostic("invalid_value", `${key} must be true or false`, key));
				} else {
					layer[key] = parsed;
				}
				break;
			}
			case "subtaskDepth": {
				const parsed = asPositiveInt(value);
				if (parsed === undefined) diagnostics.push(diagnostic("invalid_value", `${key} must be an integer >= 1`, key));
				else layer.subtaskDepth = parsed;
				break;
			}
			case "maxAutonomousRuns": {
				const n = typeof value === "number" ? value : typeof value === "string" && /^[0-9]+$/.test(value.trim()) ? Number(value) : NaN;
				if (!Number.isSafeInteger(n) || n < 0) diagnostics.push(diagnostic("invalid_value", "maxAutonomousRuns must be a nonnegative safe integer (0 disables automatic continuation)", key));
				else layer.maxAutonomousRuns = n;
				break;
			}
			case "stallTimeoutMinutes":
			case "objectiveMaxChars": {
				const parsed = asNonNegativeInt(value);
				if (parsed === undefined) diagnostics.push(diagnostic("invalid_value", `${key} must be an integer >= 0`, key));
				else layer[key] = parsed;
				break;
			}
			case "goalsRoot":
			case "provider":
			case "model": {
				const parsed = asNonEmptyString(value);
				if (parsed === undefined) diagnostics.push(diagnostic("invalid_value", `${key} must be a non-empty string`, key));
				else layer[key] = parsed;
				break;
			}
			case "thinkingLevel":
			case "thinking_level": {
				const parsed = asThinkingLevel(value);
				if (parsed === undefined) {
					diagnostics.push(diagnostic("invalid_value", `${key} must be one of: ${[...THINKING_LEVELS].join(", ")}`, key));
				} else {
					layer.thinkingLevel = parsed;
				}
				break;
			}
			case "pauseOrder": {
				if (!PAUSE_ORDERS.some(order => order.id === value)) diagnostics.push(diagnostic("invalid_value", "pauseOrder must be together, goal-first or turn-first", key));
				else layer.pauseOrder = value as PauseOrder;
				break;
			}
			case "commands": {
				if (!value || typeof value !== "object" || Array.isArray(value)) {
					diagnostics.push(diagnostic("invalid_nested_key", "commands must be an object", key)); break;
				}
				const commands: GoalCommands = {};
				for (const [id, routes] of Object.entries(value)) {
					if (!GOAL_COMMANDS.some(([action]) => action === id)) { diagnostics.push(diagnostic("unknown_key", `unknown command action: ${id}`, `commands.${id}`)); continue; }
					const parsed = parseCommandPaths(routes);
					if (!parsed) diagnostics.push(diagnostic("invalid_value", "Expected an array of command paths, or [] to disable", `commands.${id}`));
					else commands[id as keyof GoalCommands] = parsed;
				}
				layer.commands = commands;
				break;
			}
			case "keybindings": {
				const sparse: Record<string, unknown> = {};
				const visit = (record: unknown, prefix: string[], target: Record<string, unknown>): void => {
					if (!record || typeof record !== "object" || Array.isArray(record)) { diagnostics.push(diagnostic("invalid_nested_key", `${prefix.join(".")} must be an object`, prefix.join("."))); return; }
					for (const [name, binding] of Object.entries(record)) {
						const path = [...prefix, name];
						const exact = GOAL_KEY_ACTIONS.some(action => action.path.join(".") === path.join("."));
						if (exact) {
							const parsed = parseGoalKeybinding(binding);
							if (parsed === undefined) diagnostics.push(diagnostic("invalid_value", "Expected a Pi key name, key list, or [] to disable", path.join(".")));
							else target[name] = parsed;
						} else if (GOAL_KEY_ACTIONS.some(action => action.path.slice(0, path.length).join(".") === path.join("."))) {
							const nested: Record<string, unknown> = {}; visit(binding, path, nested); target[name] = nested;
						} else diagnostics.push(diagnostic("unknown_key", `unknown keybinding: ${path.join(".")}`, path.join(".")));
					}
				};
				visit(value, ["keybindings"], sparse);
				layer.keybindings = sparse as unknown as GoalKeybindings;
				break;
			}
			case "oracle": {
				if (!value || typeof value !== "object" || Array.isArray(value)) {
					diagnostics.push(diagnostic("invalid_nested_key", "oracle must be an object", key));
					break;
				}
				const oracleRecord = value as Record<string, unknown>;
				const oracle: GoalOracleSettingsLayer = {};
				for (const [oKey, oValue] of Object.entries(oracleRecord)) {
					if (!ALLOWED_ORACLE_KEYS.has(oKey)) {
						diagnostics.push(diagnostic("unknown_key", `unknown oracle key: ${oKey}`, `oracle.${oKey}`));
						continue;
					}
					switch (oKey) {
						case "enabled":
						case "projectResources": {
							const parsed = asBool(oValue);
							if (parsed === undefined) diagnostics.push(diagnostic("invalid_value", `oracle.${oKey} must be true or false`, `oracle.${oKey}`));
							else oracle[oKey] = parsed;
							break;
						}
						case "provider":
						case "model": {
							const parsed = asNonEmptyString(oValue);
							if (parsed === undefined) diagnostics.push(diagnostic("invalid_value", `oracle.${oKey} must be a non-empty string`, `oracle.${oKey}`));
							else oracle[oKey] = parsed;
							break;
						}
						case "thinkingLevel":
						case "thinking_level": {
							const parsed = asThinkingLevel(oValue);
							if (parsed === undefined) diagnostics.push(diagnostic("invalid_value", `oracle.${oKey} must be one of: ${[...THINKING_LEVELS].join(", ")}`, `oracle.${oKey}`));
							else oracle.thinkingLevel = parsed;
							break;
						}
						case "maxFailedAttemptsPerBlocker": {
							const parsed = asPositiveInt(oValue);
							if (parsed === undefined || parsed > 3) {
								diagnostics.push(diagnostic("invalid_value", "oracle.maxFailedAttemptsPerBlocker must be an integer between 1 and 3", `oracle.${oKey}`));
							} else {
								oracle.maxFailedAttemptsPerBlocker = parsed;
							}
							break;
						}
					}
				}
				layer.oracle = oracle;
				break;
			}
			case "networkRecovery": {
				if (!value || typeof value !== "object" || Array.isArray(value)) {
					diagnostics.push(diagnostic("invalid_nested_key", "networkRecovery must be an object", key));
					break;
				}
				const nrRecord = value as Record<string, unknown>;
				const nr: GoalNetworkRecoverySettingsLayer = {};
				for (const [nKey, nValue] of Object.entries(nrRecord)) {
					if (!ALLOWED_NETWORK_RECOVERY_KEYS.has(nKey)) {
						diagnostics.push(diagnostic("unknown_key", `unknown networkRecovery key: ${nKey}`, `networkRecovery.${nKey}`));
						continue;
					}
					if (nKey === "maxAttempts") {
						const parsed = asNonNegativeInt(nValue);
						if (parsed === undefined) diagnostics.push(diagnostic("invalid_value", "networkRecovery.maxAttempts must be an integer >= 0 (0 = unbounded)", `networkRecovery.${nKey}`));
						else nr.maxAttempts = parsed;
					} else {
						const parsed = asNonNegativeInt(nValue);
						if (parsed === undefined || parsed < 1_000) diagnostics.push(diagnostic("invalid_value", "networkRecovery.maxDelayMs must be an integer >= 1000", `networkRecovery.${nKey}`));
						else nr.maxDelayMs = parsed;
					}
				}
				if (Object.keys(nr).length > 0) layer.networkRecovery = nr;
				break;
			}
			default:
				diagnostics.push(diagnostic("unknown_key", `unknown settings key: ${key}`, key));
				break;
		}
	}
	return { layer, diagnostics };
}

/**
 * Legacy strict parse: throws on unknown keys. Kept for callers that want
 * fail-closed parsing of a whole known-shape object (e.g. tests); layered
 * loading uses parseSettingsLayer instead.
 */
export function parseGoalSettings(raw: unknown): GoalSettings {
	const { layer, diagnostics } = parseSettingsLayer(raw, "project", "(inline)");
	const unknown = diagnostics
		.filter((d) => d.code === "unknown_key" && d.settingPath && !d.settingPath.includes("."))
		.map((d) => d.settingPath!);
	if (unknown.length > 0) throw new Error(`Unknown pi-goal-x-settings.json key(s): ${unknown.join(", ")}`);
	return layer as GoalSettings;
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

function readSettingsLayerFresh(target: string, scope: SettingsScope): SettingsLayerRead {
	let rawText: string | undefined;
	try {
		rawText = fs.readFileSync(target, "utf8");
	} catch {
		const read: SettingsLayerRead = {
			scope,
			path: target,
			status: "missing",
			layer: {},
			diagnostics: [],
			fingerprint: "missing",
		};
		settingsFileCache.set(target, { read });
		return read;
	}
	let parsed: unknown;
	let diagnostics: SettingsDiagnostic[] = [];
	let layer: GoalSettingsLayer = {};
	try {
		parsed = JSON.parse(rawText);
	} catch {
		const read: SettingsLayerRead = {
			scope,
			path: target,
			status: "invalid",
			layer: {},
			diagnostics: [{ scope, path: target, code: "invalid_json", message: "settings file is not valid JSON" }],
			fingerprint: fingerprintOf(rawText),
		};
		settingsFileCache.set(target, { read });
		return read;
	}
	const result = parseSettingsLayer(parsed, scope, target);
	layer = result.layer;
	diagnostics = result.diagnostics;
	const read: SettingsLayerRead = {
		scope,
		path: target,
		status: statusFor(diagnostics, rawText.trim().length > 0),
		layer,
		diagnostics,
		fingerprint: fingerprintOf(rawText),
	};
	settingsFileCache.set(target, { read });
	return read;
}

/** Cache-served layer read (zero-op in steady state). */
export function readSettingsLayer(target: string, scope: SettingsScope): SettingsLayerRead {
	const cached = settingsFileCache.get(target);
	if (cached?.read) return cached.read;
	if (cached?.missing) {
		return { scope, path: target, status: "missing", layer: {}, diagnostics: [], fingerprint: "missing" };
	}
	return readSettingsLayerFresh(target, scope);
}

/** Load just one layer's sparse config (compat helper over readSettingsLayer). */
export function loadGoalSettingsFileConfig(cwd: string, env: NodeJS.ProcessEnv = process.env): GoalSettings {
	return readSettingsLayer(goalSettingsPath(cwd, env), "project").layer as GoalSettings;
}

// ── resolution with provenance ──────────────────────────────────────────────

export type SettingsSource = "environment" | "project" | "global" | "default";

export interface ResolvedSetting<T> {
	value: T;
	source: SettingsSource;
	envVar?: string;
}

export interface SettingsSnapshot {
	global: SettingsLayerRead;
	project: SettingsLayerRead;
	value: ResolvedGoalSettings;
	provenance: Map<string, ResolvedSetting<unknown>>;
	diagnostics: SettingsDiagnostic[];
}

function resolveLeaf<T>(args: {
	envValue?: T;
	projectValue?: T;
	globalValue?: T;
	defaultValue: T;
	envVar?: string;
}): ResolvedSetting<T> {
	if (args.envValue !== undefined) {
		return { value: args.envValue, source: "environment", envVar: args.envVar };
	}
	if (args.projectValue !== undefined) return { value: args.projectValue, source: "project" };
	if (args.globalValue !== undefined) return { value: args.globalValue, source: "global" };
	return { value: args.defaultValue, source: "default" };
}

function pathKey(...parts: Array<string | undefined>): string {
	return parts.filter((p) => p !== undefined).join(".");
}

/**
 * Resolve both layers + env into one snapshot with per-leaf provenance.
 * Nested keybindings resolve leaf-by-leaf from the SPARSE layers.
 */
const resolutionEnvKeys = ["PI_GOAL_ROOT", "PI_GOAL_DISABLE_TASKS", "PI_GOAL_DISABLE_CONTRACTS", "PI_GOAL_OBJECTIVE_MAX_CHARS", "PI_GOAL_NETWORK_RECOVERY_MAX_ATTEMPTS", "PI_GOAL_NETWORK_RECOVERY_MAX_DELAY_MS"] as const;
const resolvedSettingsCache: Array<{global: SettingsLayerRead; project: SettingsLayerRead; environment: Array<string | undefined>; snapshot: SettingsSnapshot}> = [];

function resolvedSettingsSnapshot(cwd: string, env: NodeJS.ProcessEnv): SettingsSnapshot {
	const globalPath = goalGlobalSettingsPath(env);
	const projectPath = goalSettingsPath(cwd, env);
	const global = readSettingsLayer(globalPath, "global");
	const project = readSettingsLayer(projectPath, "project");
	for (const cached of resolvedSettingsCache) {
		if (cached.global === global && cached.project === project && resolutionEnvKeys.every((key, i) => env[key] === cached.environment[i])) return cached.snapshot;
	}

	const provenance = new Map<string, ResolvedSetting<unknown>>();
	const track = <T>(key: string, resolved: ResolvedSetting<T>): T => {
		provenance.set(key, resolved as ResolvedSetting<unknown>);
		return resolved.value;
	};

	const envBool = (name: string): boolean | undefined =>
		asBool(env[name]);
	const envInt = (name: string): number | undefined =>
		asNonNegativeInt(env[name]);

	const disableTasks = track("disableTasks", resolveLeaf<boolean>({
		envValue: envBool("PI_GOAL_DISABLE_TASKS"),
		projectValue: project.layer.disableTasks,
		globalValue: global.layer.disableTasks,
		defaultValue: false,
		envVar: "PI_GOAL_DISABLE_TASKS",
	}));
	const disableContracts = track("disableContracts", resolveLeaf<boolean>({
		envValue: envBool("PI_GOAL_DISABLE_CONTRACTS"),
		projectValue: project.layer.disableContracts,
		globalValue: global.layer.disableContracts,
		defaultValue: false,
		envVar: "PI_GOAL_DISABLE_CONTRACTS",
	}));
	const subtaskDepth = track("subtaskDepth", resolveLeaf<number>({
		projectValue: project.layer.subtaskDepth,
		globalValue: global.layer.subtaskDepth,
		defaultValue: 1,
	}));
	const provider = track("provider", resolveLeaf<string>({
		projectValue: project.layer.provider,
		globalValue: global.layer.provider,
		defaultValue: undefined as unknown as string,
	}));
	const model = track("model", resolveLeaf<string>({
		projectValue: project.layer.model,
		globalValue: global.layer.model,
		defaultValue: undefined as unknown as string,
	}));
	const thinkingLevel = track("thinkingLevel", resolveLeaf<ThinkingLevel>({
		projectValue: project.layer.thinkingLevel,
		globalValue: global.layer.thinkingLevel,
		defaultValue: undefined as unknown as ThinkingLevel,
	}));
	const disabled = track("disabled", resolveLeaf<boolean>({
		projectValue: project.layer.disabled,
		globalValue: global.layer.disabled,
		defaultValue: false,
	}));
	const autoSelectSingleGoal = track("autoSelectSingleGoal", resolveLeaf<boolean>({
		projectValue: project.layer.autoSelectSingleGoal,
		globalValue: global.layer.autoSelectSingleGoal,
		defaultValue: false,
	}));
	const auditorProjectResources = track("auditorProjectResources", resolveLeaf<boolean>({
		projectValue: project.layer.auditorProjectResources,
		globalValue: global.layer.auditorProjectResources,
		defaultValue: false,
	}));
	const hideUnfocusedBanner = track("hideUnfocusedBanner", resolveLeaf<boolean>({
		projectValue: project.layer.hideUnfocusedBanner,
		globalValue: global.layer.hideUnfocusedBanner,
		defaultValue: false,
	}));
	const showAutonomousRuns = track("showAutonomousRuns", resolveLeaf<boolean>({
		projectValue: project.layer.showAutonomousRuns,
		globalValue: global.layer.showAutonomousRuns,
		defaultValue: true,
	}));
	const showContextUsage = track("showContextUsage", resolveLeaf<boolean>({
		projectValue: project.layer.showContextUsage,
		globalValue: global.layer.showContextUsage,
		defaultValue: false,
	}));
	const hideUnfocusedPrompt = track("hideUnfocusedPrompt", resolveLeaf<boolean>({
		projectValue: project.layer.hideUnfocusedPrompt,
		globalValue: global.layer.hideUnfocusedPrompt,
		defaultValue: false,
	}));
	const goalsRoot = track("goalsRoot", resolveLeaf<string | undefined>({
		envValue: env.PI_GOAL_ROOT, envVar: "PI_GOAL_ROOT",
		projectValue: project.layer.goalsRoot, globalValue: global.layer.goalsRoot, defaultValue: undefined,
	}));
	// Issue #26: Oracle leaves resolve per leaf like every other setting.
	const oracleEnabled = track("oracle.enabled", resolveLeaf<boolean>({
		projectValue: project.layer.oracle?.enabled,
		globalValue: global.layer.oracle?.enabled,
		defaultValue: false,
	}));
	const oracleProvider = track("oracle.provider", resolveLeaf<string>({
		projectValue: project.layer.oracle?.provider,
		globalValue: global.layer.oracle?.provider,
		defaultValue: undefined as unknown as string,
	}));
	const oracleModel = track("oracle.model", resolveLeaf<string>({
		projectValue: project.layer.oracle?.model,
		globalValue: global.layer.oracle?.model,
		defaultValue: undefined as unknown as string,
	}));
	const oracleThinkingLevel = track("oracle.thinkingLevel", resolveLeaf<ThinkingLevel>({
		projectValue: project.layer.oracle?.thinkingLevel,
		globalValue: global.layer.oracle?.thinkingLevel,
		defaultValue: undefined as unknown as ThinkingLevel,
	}));
	const oracleProjectResources = track("oracle.projectResources", resolveLeaf<boolean>({
		projectValue: project.layer.oracle?.projectResources,
		globalValue: global.layer.oracle?.projectResources,
		defaultValue: false,
	}));
	const oracleMaxFailedAttemptsPerBlocker = track("oracle.maxFailedAttemptsPerBlocker", resolveLeaf<number>({
		projectValue: project.layer.oracle?.maxFailedAttemptsPerBlocker,
		globalValue: global.layer.oracle?.maxFailedAttemptsPerBlocker,
		defaultValue: 2,
	}));
	const idleContinuationBackoff = track("idleContinuationBackoff", resolveLeaf<boolean>({projectValue: project.layer.idleContinuationBackoff, globalValue: global.layer.idleContinuationBackoff, defaultValue: false}));
	const strictExecutionContract = track("strictExecutionContract", resolveLeaf<boolean>({
		projectValue: project.layer.strictExecutionContract,
		globalValue: global.layer.strictExecutionContract,
		defaultValue: false,
	}));
	const maxAutonomousRuns = track("maxAutonomousRuns", resolveLeaf<number | undefined>({
		projectValue: project.layer.maxAutonomousRuns,
		globalValue: global.layer.maxAutonomousRuns,
		defaultValue: undefined,
	}));
	const stallTimeoutMinutes = track("stallTimeoutMinutes", resolveLeaf<number>({
		projectValue: project.layer.stallTimeoutMinutes,
		globalValue: global.layer.stallTimeoutMinutes,
		defaultValue: 0,
	}));
	const objectiveMaxChars = track("objectiveMaxChars", resolveLeaf<number>({
		envValue: envInt("PI_GOAL_OBJECTIVE_MAX_CHARS"),
		projectValue: project.layer.objectiveMaxChars,
		globalValue: global.layer.objectiveMaxChars,
		defaultValue: 0,
		envVar: "PI_GOAL_OBJECTIVE_MAX_CHARS",
	}));
	const networkRecoveryMaxAttempts = track("networkRecovery.maxAttempts", resolveLeaf<number>({
		envValue: envInt("PI_GOAL_NETWORK_RECOVERY_MAX_ATTEMPTS"),
		projectValue: project.layer.networkRecovery?.maxAttempts,
		globalValue: global.layer.networkRecovery?.maxAttempts,
		defaultValue: 0,
		envVar: "PI_GOAL_NETWORK_RECOVERY_MAX_ATTEMPTS",
	}));
	const networkRecoveryMaxDelayMs = track("networkRecovery.maxDelayMs", resolveLeaf<number>({
		envValue: envInt("PI_GOAL_NETWORK_RECOVERY_MAX_DELAY_MS"),
		projectValue: project.layer.networkRecovery?.maxDelayMs,
		globalValue: global.layer.networkRecovery?.maxDelayMs,
		defaultValue: DEFAULT_NETWORK_RECOVERY_MAX_DELAY_MS,
		envVar: "PI_GOAL_NETWORK_RECOVERY_MAX_DELAY_MS",
	}));

	const keybindings = { dashboard: {} } as unknown as GoalKeybindings;
	for (const action of GOAL_KEY_ACTIONS) {
		const get = (layer: GoalSettingsLayer): GoalKeybinding | undefined => {
			let cursor: unknown = layer;
			for (const key of action.path) cursor = (cursor as Record<string, unknown> | undefined)?.[key];
			return cursor as GoalKeybinding | undefined;
		};
		const resolved = track(action.path.join("."), resolveLeaf<GoalKeybinding>({ projectValue: get(project.layer), globalValue: get(global.layer), defaultValue: action.defaults }));
		let target = keybindings as unknown as Record<string, unknown>;
		const configured = get(project.layer) !== undefined || get(global.layer) !== undefined;
		// Keep the ordinary, uncustomized settings fast path as small as before.
		if (!configured && !(action.path[1] === "dashboard" && ["toggleExpand", "scrollUp", "scrollDown"].includes(action.path[2]!))) continue;
		for (const segment of action.path.slice(1, -1)) target = (target[segment] ??= {}) as Record<string, unknown>;
		target[action.path.at(-1)!] = resolved;
	}
	const commands: GoalCommands = {};
	for (const [id] of GOAL_COMMANDS) commands[id] = track(`commands.${id}`, resolveLeaf<string[]>({ projectValue: project.layer.commands?.[id], globalValue: global.layer.commands?.[id], defaultValue: [id] }));
	const pauseOrder = track("pauseOrder", resolveLeaf<PauseOrder>({ projectValue: project.layer.pauseOrder, globalValue: global.layer.pauseOrder, defaultValue: "together" }));

	const value: ResolvedGoalSettings = {
		disableTasks,
		disableContracts,
		subtaskDepth,
		...(provider ? { provider } : {}),
		...(model ? { model } : {}),
		...(thinkingLevel ? { thinkingLevel } : {}),
		disabled,
		autoSelectSingleGoal,
		auditorProjectResources,
		hideUnfocusedBanner,
		showAutonomousRuns,
		showContextUsage,
		hideUnfocusedPrompt,
		goalsRoot,
		stallTimeoutMinutes,
		maxAutonomousRuns,
		idleContinuationBackoff,
		strictExecutionContract,
		objectiveMaxChars,
		keybindings,
		...((Object.keys(global.layer.commands ?? {}).length || Object.keys(project.layer.commands ?? {}).length) ? { commands } : {}),
		pauseOrder,
		networkRecovery: {
			maxAttempts: networkRecoveryMaxAttempts,
			maxDelayMs: networkRecoveryMaxDelayMs,
		},
		oracle: {
			enabled: oracleEnabled,
			...(oracleProvider ? { provider: oracleProvider } : {}),
			...(oracleModel ? { model: oracleModel } : {}),
			...(oracleThinkingLevel ? { thinkingLevel: oracleThinkingLevel } : {}),
			projectResources: oracleProjectResources,
			maxFailedAttemptsPerBlocker: oracleMaxFailedAttemptsPerBlocker,
		},
	};

	const snapshot = {
		global,
		project,
		value,
		provenance,
		diagnostics: [...global.diagnostics, ...project.diagnostics],
	};
	if (resolvedSettingsCache.length >= 16) resolvedSettingsCache.shift();
	resolvedSettingsCache.push({global, project, environment: resolutionEnvKeys.map(key => env[key]), snapshot});
	return snapshot;
}

function copyResolvedSettings(value: ResolvedGoalSettings): ResolvedGoalSettings {
	return {...value,
		...(value.keybindings ? {keybindings: Object.keys(value.keybindings).length === 1 && Object.values(value.keybindings.dashboard).every(binding => typeof binding === "string")
			? { dashboard: { ...value.keybindings.dashboard } } : structuredClone(value.keybindings)} : {}),
		...(value.commands ? {commands: structuredClone(value.commands)} : {}),
		...(value.networkRecovery ? {networkRecovery: {...value.networkRecovery}} : {}),
		...(value.oracle ? {oracle: {...value.oracle}} : {}),
	};
}

/** Return caller-owned resolved values and provenance; cached layer reads keep their existing contract. */
export function loadSettingsSnapshot(cwd: string, env: NodeJS.ProcessEnv = process.env): SettingsSnapshot {
	const snapshot = resolvedSettingsSnapshot(cwd, env);
	return {...snapshot, value: copyResolvedSettings(snapshot.value), provenance: new Map(Array.from(snapshot.provenance, ([key, value]) => [key, {...value, value: Array.isArray(value.value) ? [...value.value] : value.value}])), diagnostics: [...snapshot.diagnostics]};
}

/**
 * Load settings with layered resolution:
 * environment > project > global > defaults.
 */
export function loadGoalSettings(cwd: string, env: NodeJS.ProcessEnv = process.env): GoalSettings {
	return copyResolvedSettings(resolvedSettingsSnapshot(cwd, env).value);
}

// ── conflict-safe scoped mutation ───────────────────────────────────────────

export type SettingsMutation =
	| { op: "set"; path: readonly string[]; value: unknown }
	| { op: "unset"; path: readonly string[] };

export interface MutateSettingsInput {
	scope: SettingsScope;
	cwd: string;
	env?: NodeJS.ProcessEnv;
	mutation: SettingsMutation;
	/** Optional UI validation, run against the fresh layer while its write lock is held. */
	validate?: (next: GoalSettingsLayer, current: GoalSettingsLayer) => void;
}

export class SettingsMutationError extends Error {
	readonly diagnostics?: SettingsDiagnostic[];

	constructor(message: string, diagnostics?: SettingsDiagnostic[]) {
		super(message);
		this.name = "SettingsMutationError";
		this.diagnostics = diagnostics;
	}
}

function acquireSettingsLock(target: string): FileLock {
	const lockPath = `${target}.lock`;
	return acquireFileLock(lockPath, {
		attempts: 200,
		retryMs: 5,
		staleTtlMs: 30_000,
		timeoutError: () => new SettingsMutationError(`Timed out acquiring the settings lock at ${lockPath}. Another writer may hold it.`),
	});
}

function refuseSymlinkTarget(target: string): void {
	try {
		if (fs.lstatSync(target).isSymbolicLink()) {
			throw new SettingsMutationError(`refusing symlink settings target: ${target}`);
		}
	} catch (err) {
		if (err instanceof SettingsMutationError) throw err;
		// Target does not exist yet — fine.
	}
}

function writeSettingsJson(target: string, value: unknown): void {
	fs.mkdirSync(path.dirname(target), { recursive: true });
	refuseSymlinkTarget(target);
	writeFileAtomicSync(target, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, durable: true });
}

function applyPathMutation(layer: GoalSettingsLayer, mutation: SettingsMutation): void {
	if (mutation.path.length === 0) throw new SettingsMutationError("empty settings path");
	let container: Record<string, unknown> = layer as unknown as Record<string, unknown>;
	for (let i = 0; i < mutation.path.length - 1; i += 1) {
		const key = mutation.path[i]!;
		const next = container[key];
		if (!next || typeof next !== "object") {
			if (mutation.op === "unset") return; // nothing to unset
			container[key] = {};
		}
		container = container[key] as Record<string, unknown>;
	}
	const last = mutation.path[mutation.path.length - 1]!;
	// thinkingLevel/thinking_level are accepted aliases on read; writes operate
	// on BOTH spellings so unset clears hand-edited variants too.
	if (last === "thinkingLevel" || last === "thinking_level") {
		if (mutation.op === "set") container.thinkingLevel = mutation.value;
		else {
			delete container.thinkingLevel;
			delete container.thinking_level;
		}
		return;
	}
	if (mutation.op === "set") container[last] = mutation.value;
	else delete container[last];
}

/** Canonicalize the persisted spelling of aliased keys before writing. */
function canonicalizeAliases(layer: Record<string, unknown>): void {
	if (layer.thinkingLevel !== undefined) {
		layer.thinking_level = layer.thinkingLevel;
		delete layer.thinkingLevel;
	}
}

function pruneEmptyObjects(value: unknown): void {
	for (const key of Object.keys(value as Record<string, unknown>)) {
		const child = (value as Record<string, unknown>)[key];
		if (child && typeof child === "object" && !Array.isArray(child)) {
			pruneEmptyObjects(child);
			if (Object.keys(child as Record<string, unknown>).length === 0) delete (value as Record<string, unknown>)[key];
		}
	}
}

/**
 * Apply a scoped mutation under the target's path lock and return a fresh
 * snapshot. Refuses to overwrite an invalid layer; writes atomically;
 * invalidates only the affected cache entry.
 */
export function mutateSettingsLayer(input: MutateSettingsInput): SettingsSnapshot {
	const env = input.env ?? process.env;
	const target = input.scope === "global"
		? goalGlobalSettingsPath(env)
		: goalSettingsPath(input.cwd, env);
	const lock = acquireSettingsLock(target);

	try {
		const current = readSettingsLayerFresh(target, input.scope);
		if (current.status === "invalid") {
			throw new SettingsMutationError(
				`Refusing to overwrite invalid ${input.scope} settings at ${target}`,
				current.diagnostics,
			);
		}

		const next = structuredClone(current.layer) as Record<string, unknown>;
		applyPathMutation(next as unknown as GoalSettingsLayer, input.mutation);
		pruneEmptyObjects(next);
		canonicalizeAliases(next);

		const reparsed = parseSettingsLayer(JSON.parse(JSON.stringify(next)), input.scope, target);
		if (reparsed.diagnostics.some((d) => d.code === "invalid_value" || d.code === "invalid_nested_key")) {
			throw new SettingsMutationError(`Mutation produced invalid ${input.scope} settings`, reparsed.diagnostics);
		}
		input.validate?.(reparsed.layer, current.layer);

		writeSettingsJson(target, next);
		invalidateSettingsCachePath(target);
		return loadSettingsSnapshot(input.cwd, env);
	} finally {
		lock.release();
	}
}

// ── legacy whole-file save (routed through the locked mutation path) ────────

/**
 * Save settings to the PROJECT file. Kept for compatibility; internally uses
 * the conflict-safe locked mutation path (replace semantics via unset+set is
 * not needed here: the whole-object replace happens under the same lock with
 * a fresh re-read, so no cached stale object is ever written).
 */
export function saveGoalSettingsFileConfig(cwd: string, settings: GoalSettings): GoalSettings {
	const target = goalSettingsPath(cwd);
	const lock = acquireSettingsLock(target);
	try {
		// Fresh re-read under the lock: never persist a cached whole object.
		const current = readSettingsLayerFresh(target, "project");
		if (current.status === "invalid") {
			throw new SettingsMutationError(`Refusing to overwrite invalid project settings at ${target}`, current.diagnostics);
		}
		const clean = buildPersistedLayer(settings);
		writeSettingsJson(target, clean);
		invalidateSettingsCachePath(target);
		// Return the normalized runtime shape (thinkingLevel), not the
		// canonical persisted key (thinking_level).
		const returned = { ...clean };
		if (typeof returned.thinking_level === "string") {
			returned.thinkingLevel = returned.thinking_level as ThinkingLevel;
			delete returned.thinking_level;
		}
		return returned as unknown as GoalSettings;
	} finally {
		lock.release();
	}
}

/** Canonical persisted form of a resolved/sparse settings object. */
function buildPersistedLayer(settings: GoalSettings): Record<string, unknown> {
	const persisted: Record<string, unknown> = {};
	if (settings.provider) persisted.provider = settings.provider;
	if (settings.model) persisted.model = settings.model;
	if (settings.thinkingLevel) persisted.thinking_level = settings.thinkingLevel;
	if (settings.disabled !== undefined) persisted.disabled = settings.disabled;
	if (settings.disableTasks !== undefined) persisted.disableTasks = settings.disableTasks;
	if (settings.disableContracts !== undefined) persisted.disableContracts = settings.disableContracts;
	if (settings.subtaskDepth !== undefined) persisted.subtaskDepth = settings.subtaskDepth;
	if (settings.autoSelectSingleGoal !== undefined) persisted.autoSelectSingleGoal = settings.autoSelectSingleGoal;
	if (settings.auditorProjectResources !== undefined) persisted.auditorProjectResources = settings.auditorProjectResources;
	if (settings.hideUnfocusedBanner !== undefined) persisted.hideUnfocusedBanner = settings.hideUnfocusedBanner;
	if (settings.showAutonomousRuns !== undefined) persisted.showAutonomousRuns = settings.showAutonomousRuns;
	if (settings.showContextUsage !== undefined) persisted.showContextUsage = settings.showContextUsage;
	if (settings.goalsRoot !== undefined) persisted.goalsRoot = settings.goalsRoot;
	if (settings.hideUnfocusedPrompt !== undefined) persisted.hideUnfocusedPrompt = settings.hideUnfocusedPrompt;
	if ((settings as { networkRecovery?: ResolvedGoalNetworkRecoverySettings }).networkRecovery) {
		const nr = (settings as { networkRecovery?: ResolvedGoalNetworkRecoverySettings }).networkRecovery!;
		const o: Record<string, unknown> = {};
		if (nr.maxAttempts !== undefined) o.maxAttempts = nr.maxAttempts;
		if (nr.maxDelayMs !== undefined) o.maxDelayMs = nr.maxDelayMs;
		if (Object.keys(o).length > 0) persisted.networkRecovery = o;
	}
	if ((settings as { oracle?: ResolvedGoalOracleSettings }).oracle) {
		const o: Record<string, unknown> = {};
		const so = (settings as { oracle?: ResolvedGoalOracleSettings }).oracle!;
		if (so.enabled !== undefined) o.enabled = so.enabled;
		if (so.provider !== undefined) o.provider = so.provider;
		if (so.model !== undefined) o.model = so.model;
		if (so.thinkingLevel !== undefined) o.thinking_level = so.thinkingLevel;
		if (so.projectResources !== undefined) o.projectResources = so.projectResources;
		if (so.maxFailedAttemptsPerBlocker !== undefined) o.maxFailedAttemptsPerBlocker = so.maxFailedAttemptsPerBlocker;
		if (Object.keys(o).length > 0) persisted.oracle = o;
	}
	if (settings.idleContinuationBackoff !== undefined) persisted.idleContinuationBackoff = settings.idleContinuationBackoff;
	if (settings.strictExecutionContract !== undefined) persisted.strictExecutionContract = settings.strictExecutionContract;
	if (settings.maxAutonomousRuns !== undefined) persisted.maxAutonomousRuns = settings.maxAutonomousRuns;
	if (settings.stallTimeoutMinutes !== undefined) persisted.stallTimeoutMinutes = settings.stallTimeoutMinutes;
	if (settings.objectiveMaxChars !== undefined) persisted.objectiveMaxChars = settings.objectiveMaxChars;
	if (settings.keybindings) persisted.keybindings = structuredClone(settings.keybindings);
	if (settings.commands) persisted.commands = structuredClone(settings.commands);
	if (settings.pauseOrder) persisted.pauseOrder = settings.pauseOrder;
	return persisted;
}

// ── reporting ───────────────────────────────────────────────────────────────

/**
 * E2: which env var (if any) overrides a settings key's effective value.
 */
export function envOverrideFor(key: keyof GoalSettings | "settingsFile", env: NodeJS.ProcessEnv = process.env): string | null {
	if (key === "goalsRoot" && env.PI_GOAL_ROOT !== undefined) return "PI_GOAL_ROOT";
	if (key === "disableTasks" && env.PI_GOAL_DISABLE_TASKS !== undefined) return "PI_GOAL_DISABLE_TASKS";
	if (key === "disableContracts" && env.PI_GOAL_DISABLE_CONTRACTS !== undefined) return "PI_GOAL_DISABLE_CONTRACTS";
	if (key === "objectiveMaxChars" && env.PI_GOAL_OBJECTIVE_MAX_CHARS !== undefined) return "PI_GOAL_OBJECTIVE_MAX_CHARS";
	if (key === "networkRecovery") {
		if (env.PI_GOAL_NETWORK_RECOVERY_MAX_ATTEMPTS !== undefined) return "PI_GOAL_NETWORK_RECOVERY_MAX_ATTEMPTS";
		if (env.PI_GOAL_NETWORK_RECOVERY_MAX_DELAY_MS !== undefined) return "PI_GOAL_NETWORK_RECOVERY_MAX_DELAY_MS";
	}
	if (key === "settingsFile" && env[PI_GOAL_SETTINGS_FILE_ENV] !== undefined) return PI_GOAL_SETTINGS_FILE_ENV;
	return null;
}

/**
 * E2: effective-settings report with per-leaf provenance
 * (environment > project > global > default), surfaced by /goal-status.
 */
export function effectiveSettingsReport(cwd: string, env: NodeJS.ProcessEnv = process.env): string[] {
	const snapshot = loadSettingsSnapshot(cwd, env);
	const lines = ["Settings (provenance):"];
	const rows: Array<{ key: string; label: string; format: () => string }> = [
		{ key: "autoSelectSingleGoal", label: "autoSelectSingleGoal", format: () => String(snapshot.value.autoSelectSingleGoal) },
		{ key: "disableContracts", label: "disableContracts", format: () => String(snapshot.value.disableContracts) },
		{ key: "disableTasks", label: "disableTasks", format: () => String(snapshot.value.disableTasks) },
		{ key: "subtaskDepth", label: "subtaskDepth", format: () => String(snapshot.value.subtaskDepth) },
		{ key: "disabled", label: "auditor disabled", format: () => String(snapshot.value.disabled) },
		{ key: "provider", label: "provider", format: () => snapshot.value.provider ?? "(default)" },
		{ key: "model", label: "model", format: () => snapshot.value.model ?? "(default)" },
		{ key: "thinkingLevel", label: "thinking_level", format: () => snapshot.value.thinkingLevel ?? "(default)" },
		{ key: "auditorProjectResources", label: "auditor project resources", format: () => String(snapshot.value.auditorProjectResources) },
		{ key: "hideUnfocusedBanner", label: "hide unfocused banner", format: () => String(snapshot.value.hideUnfocusedBanner) },
		{ key: "showAutonomousRuns", label: "show autonomous runs line", format: () => String(snapshot.value.showAutonomousRuns) },
		{ key: "showContextUsage", label: "show context usage line", format: () => String(snapshot.value.showContextUsage) },
		{ key: "goalsRoot", label: "goals root (reload to change)", format: () => snapshot.value.goalsRoot ?? ".pi/goals" },
		{ key: "hideUnfocusedPrompt", label: "hide unfocused prompt", format: () => String(snapshot.value.hideUnfocusedPrompt) },
		{ key: "idleContinuationBackoff", label: "slow repeated idle replies (opt-in)", format: () => String(snapshot.value.idleContinuationBackoff) },
		{ key: "strictExecutionContract", label: "explicit execution contracts (opt-in)", format: () => String(snapshot.value.strictExecutionContract) },
		{ key: "maxAutonomousRuns", label: "autonomous run allowance", format: () => snapshot.value.maxAutonomousRuns === 0 ? "0 (disabled)" : String(snapshot.value.maxAutonomousRuns ?? "unlimited (default)") },
		{ key: "stallTimeoutMinutes", label: "stall timeout (minutes)", format: () => String(snapshot.value.stallTimeoutMinutes) },
		{ key: "objectiveMaxChars", label: "max objective length (0 = none)", format: () => String(snapshot.value.objectiveMaxChars) },
		{ key: "networkRecovery", label: "network recovery attempts (0 = unbounded)", format: () => String(snapshot.value.networkRecovery?.maxAttempts ?? 0) },
		{ key: "networkRecovery", label: "network recovery max delay (ms)", format: () => String(snapshot.value.networkRecovery?.maxDelayMs ?? DEFAULT_NETWORK_RECOVERY_MAX_DELAY_MS) },
		{ key: "pauseOrder", label: "pause order", format: () => snapshot.value.pauseOrder ?? "together" },
		{ key: "keybindings", label: "dashboard keybindings", format: () => `${snapshot.value.keybindings!.dashboard.toggleExpand}, ${snapshot.value.keybindings!.dashboard.scrollUp}, ${snapshot.value.keybindings!.dashboard.scrollDown}` },
	];
	for (const row of rows) {
		const resolved = snapshot.provenance.get(row.key);
		let source: string;
		if (resolved?.source === "environment") source = `env (${resolved.envVar})`;
		else source = resolved?.source ?? "default";
		lines.push(`  ${row.label}: ${row.format()} (${source})`);
	}
	for (const [id] of GOAL_COMMANDS) {
		const source = snapshot.provenance.get(`commands.${id}`)?.source ?? "default";
		lines.push(`  ${id}: ${(snapshot.provenance.get(`commands.${id}`)?.value as string[]).map(route => `/${route}`).join(", ") || "disabled"} (${source})`);
	}
	for (const action of GOAL_KEY_ACTIONS) {
		const source = snapshot.provenance.get(action.path.join("."));
		lines.push(`  ${action.label}: ${formatGoalKeybinding(source?.value as GoalKeybinding)} (${source?.source ?? "default"})`);
	}
	lines.push(`  project settings file: ${snapshot.project.path}`);
	lines.push(`  global settings file: ${snapshot.global.path}`);
	const fileOverride = envOverrideFor("settingsFile", env);
	if (fileOverride) lines.push(`  (settings file overridden by ${fileOverride})`);
	return lines;
}

