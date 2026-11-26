/**
 * Settings schema: the types a settings file and the resolved runtime value
 * use, keybinding defaults, and the diagnostic-producing parser for one layer.
 *
 * Two distinct types (never one interface for both): GoalSettingsLayer is the
 * SPARSE file content (booleans tri-state, 0 meaningful); GoalSettings is the
 * RESOLVED runtime value with concrete defaults. Layer files are parsed into
 * diagnostics rather than rejected wholesale: unknown keys are reported, and
 * every valid known key still applies.
 */

import { t } from "../i18n/index.ts";
import { GOAL_COMMANDS, GOAL_KEY_ACTIONS, PAUSE_ORDERS, parseCommandPaths, parseGoalKeybinding, type GoalCommands, type GoalKeybinding, type PauseOrder } from "../goal-controls.ts";

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
export interface GoalKeybindings {
	dashboard: GoalDashboardKeybindings;
	pause?: GoalKeybinding;
	toggleAuditor?: GoalKeybinding;
	interruptAudit?: GoalKeybinding;
	dialog?: Partial<Record<import("../goal-controls.ts").GoalDialogAction, GoalKeybinding>>;
	commands?: Partial<Record<import("../goal-controls.ts").GoalCommandId, GoalKeybinding>>;
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
	if (Array.isArray(key)) return key.length ? key.map(k => formatGoalKeybinding(k)).join(" / ") : t("Unbound");
	if (!key) return t("Unbound");
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

// ── settings shapes ─────────────────────────────────────────────────────────

/**
 * Sparse settings layer: exactly what a settings file may contain. Every field
 * is optional, and explicit false/0 is kept so a lower layer can override a
 * higher one.
 */
export interface GoalSettingsLayer {
	disableTasks?: boolean;
	disableContracts?: boolean;
	subtaskDepth?: number;
	provider?: string;
	model?: string;
	thinkingLevel?: ThinkingLevel;
	/** Language for text shown in the UI, such as "zh-CN". Absent means English. */
	locale?: string;
	disabled?: boolean;
	autoSelectSingleGoal?: boolean;
	/** E3: load the project's own skills/extensions into auditor sessions (off by default = isolation). */
	auditorProjectResources?: boolean;
	/** F5: stall detector timeout in minutes (0 = off). */
	stallTimeoutMinutes?: number;
	/** Pause after this many automatic turns in a row with no tool call (default 4; 0 = never). */
	maxIdleTurns?: number;
	/** Pause a goal after this many minutes of active time (0 or unset = no limit). */
	maxGoalMinutes?: number;
	/** Stop a completion audit that runs longer than this many minutes (0 or unset = no limit). */
	auditorTimeoutMinutes?: number;
	/** Stop a completion audit after this many auditor tool calls (0 or unset = no limit). */
	auditorMaxToolCalls?: number;
	/** How a guided draft starts: "ask" interviews you first (default), "propose" drafts at once and states its assumptions. */
	draftStyle?: "ask" | "propose";
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
interface ResolvedGoalNetworkRecoverySettings {
	maxAttempts: number;
	maxDelayMs: number;
}

/** Resolved runtime settings, with defaults filled in. */
export interface GoalSettings extends GoalSettingsLayer {
	oracle?: ResolvedGoalOracleSettings;
	networkRecovery?: ResolvedGoalNetworkRecoverySettings;
}


const THINKING_LEVELS = new Set<string>(GOAL_THINKING_LEVELS);

// ── pure path resolution ────────────────────────────────────────────────────

export function asNonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

// ── diagnostics ─────────────────────────────────────────────────────────────

export type SettingsScope = "global" | "project";

type SettingsDiagnosticCode =
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

// ── leaf parsers (diagnostic-producing, never throwing) ─────────────────────

export function asBool(value: unknown): boolean | undefined {
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
export function asNonNegativeInt(value: unknown): number | undefined {
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

/** Reports one problem while parsing a layer. */
type Fail = (code: SettingsDiagnosticCode, message: string, settingPath?: string) => void;

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Walk the keybindings object, keeping only paths that name a known key action. */
function parseKeybindingsLayer(value: unknown, fail: Fail): GoalKeybindings {
	const sparse: Record<string, unknown> = {};
	const visit = (record: unknown, prefix: string[], target: Record<string, unknown>): void => {
		if (!isPlainObject(record)) { fail("invalid_nested_key", `${prefix.join(".")} must be an object`, prefix.join(".")); return; }
		for (const [name, binding] of Object.entries(record)) {
			const path = [...prefix, name];
			const exact = GOAL_KEY_ACTIONS.some(action => action.path.join(".") === path.join("."));
			if (exact) {
				const parsed = parseGoalKeybinding(binding);
				if (parsed === undefined) fail("invalid_value", "Expected a Pi key name, key list, or [] to disable", path.join("."));
				else target[name] = parsed;
			} else if (GOAL_KEY_ACTIONS.some(action => action.path.slice(0, path.length).join(".") === path.join("."))) {
				const nested: Record<string, unknown> = {}; visit(binding, path, nested); target[name] = nested;
			} else fail("unknown_key", `unknown keybinding: ${path.join(".")}`, path.join("."));
		}
	};
	visit(value, ["keybindings"], sparse);
	return sparse as unknown as GoalKeybindings;
}

function parseOracleLayer(record: Record<string, unknown>, fail: Fail): GoalOracleSettingsLayer {
	const oracle: GoalOracleSettingsLayer = {};
	for (const [oKey, oValue] of Object.entries(record)) {
		if (!ALLOWED_ORACLE_KEYS.has(oKey)) {
			fail("unknown_key", `unknown oracle key: ${oKey}`, `oracle.${oKey}`);
			continue;
		}
		switch (oKey) {
			case "enabled":
			case "projectResources": {
				const parsed = asBool(oValue);
				if (parsed === undefined) fail("invalid_value", `oracle.${oKey} must be true or false`, `oracle.${oKey}`);
				else oracle[oKey] = parsed;
				break;
			}
			case "provider":
			case "model": {
				const parsed = asNonEmptyString(oValue);
				if (parsed === undefined) fail("invalid_value", `oracle.${oKey} must be a non-empty string`, `oracle.${oKey}`);
				else oracle[oKey] = parsed;
				break;
			}
			case "thinkingLevel":
			case "thinking_level": {
				const parsed = asThinkingLevel(oValue);
				if (parsed === undefined) fail("invalid_value", `oracle.${oKey} must be one of: ${[...THINKING_LEVELS].join(", ")}`, `oracle.${oKey}`);
				else oracle.thinkingLevel = parsed;
				break;
			}
			case "maxFailedAttemptsPerBlocker": {
				const parsed = asPositiveInt(oValue);
				if (parsed === undefined || parsed > 3) {
					fail("invalid_value", "oracle.maxFailedAttemptsPerBlocker must be an integer between 1 and 3", `oracle.${oKey}`);
				} else {
					oracle.maxFailedAttemptsPerBlocker = parsed;
				}
				break;
			}
		}
	}
	return oracle;
}

function parseNetworkRecoveryLayer(record: Record<string, unknown>, fail: Fail): GoalNetworkRecoverySettingsLayer {
	const networkRecovery: GoalNetworkRecoverySettingsLayer = {};
	for (const [nKey, nValue] of Object.entries(record)) {
		if (!ALLOWED_NETWORK_RECOVERY_KEYS.has(nKey)) {
			fail("unknown_key", `unknown networkRecovery key: ${nKey}`, `networkRecovery.${nKey}`);
			continue;
		}
		const parsed = asNonNegativeInt(nValue);
		if (nKey === "maxAttempts") {
			if (parsed === undefined) fail("invalid_value", "networkRecovery.maxAttempts must be an integer >= 0 (0 = unbounded)", `networkRecovery.${nKey}`);
			else networkRecovery.maxAttempts = parsed;
		} else if (parsed === undefined || parsed < 1_000) {
			fail("invalid_value", "networkRecovery.maxDelayMs must be an integer >= 1000", `networkRecovery.${nKey}`);
		} else {
			networkRecovery.maxDelayMs = parsed;
		}
	}
	return networkRecovery;
}


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
	const fail: Fail = (code, message, settingPath) => {
		diagnostics.push({ scope, path: filePath, settingPath, code, message });
	};

	if (raw === null || raw === undefined) return { layer: {}, diagnostics };
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		fail("not_object", "settings file must contain a JSON object");
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
					if (value !== undefined) fail("invalid_value", `${key} must be true or false`, key);
				} else {
					layer[key] = parsed;
				}
				break;
			}
			case "subtaskDepth": {
				const parsed = asPositiveInt(value);
				if (parsed === undefined) fail("invalid_value", `${key} must be an integer >= 1`, key);
				else layer.subtaskDepth = parsed;
				break;
			}
			case "maxAutonomousRuns": {
				const n = typeof value === "number" ? value : typeof value === "string" && /^[0-9]+$/.test(value.trim()) ? Number(value) : NaN;
				if (!Number.isSafeInteger(n) || n < 0) fail("invalid_value", "maxAutonomousRuns must be a nonnegative safe integer (0 disables automatic continuation)", key);
				else layer.maxAutonomousRuns = n;
				break;
			}
			case "stallTimeoutMinutes":
			case "maxIdleTurns":
			case "maxGoalMinutes":
			case "auditorTimeoutMinutes":
			case "auditorMaxToolCalls":
			case "objectiveMaxChars": {
				const parsed = asNonNegativeInt(value);
				if (parsed === undefined) fail("invalid_value", `${key} must be an integer >= 0`, key);
				else layer[key] = parsed;
				break;
			}
			case "draftStyle": {
				if (value === "ask" || value === "propose") layer.draftStyle = value;
				else fail("invalid_value", `${key} must be "ask" or "propose"`, key);
				break;
			}
			case "goalsRoot":
			case "locale":
			case "provider":
			case "model": {
				const parsed = asNonEmptyString(value);
				if (parsed === undefined) fail("invalid_value", `${key} must be a non-empty string`, key);
				else layer[key] = parsed;
				break;
			}
			case "thinkingLevel":
			case "thinking_level": {
				const parsed = asThinkingLevel(value);
				if (parsed === undefined) {
					fail("invalid_value", `${key} must be one of: ${[...THINKING_LEVELS].join(", ")}`, key);
				} else {
					layer.thinkingLevel = parsed;
				}
				break;
			}
			case "pauseOrder": {
				if (!PAUSE_ORDERS.some(order => order.id === value)) fail("invalid_value", "pauseOrder must be together, goal-first or turn-first", key);
				else layer.pauseOrder = value as PauseOrder;
				break;
			}
			case "commands": {
				if (!value || typeof value !== "object" || Array.isArray(value)) {
					fail("invalid_nested_key", "commands must be an object", key); break;
				}
				const commands: GoalCommands = {};
				for (const [id, routes] of Object.entries(value)) {
					if (!GOAL_COMMANDS.some(([action]) => action === id)) { fail("unknown_key", `unknown command action: ${id}`, `commands.${id}`); continue; }
					const parsed = parseCommandPaths(routes);
					if (!parsed) fail("invalid_value", "Expected an array of command paths, or [] to disable", `commands.${id}`);
					else commands[id as keyof GoalCommands] = parsed;
				}
				layer.commands = commands;
				break;
			}
			case "keybindings":
				layer.keybindings = parseKeybindingsLayer(value, fail);
				break;
			case "oracle": {
				if (!isPlainObject(value)) {
					fail("invalid_nested_key", "oracle must be an object", key);
					break;
				}
				layer.oracle = parseOracleLayer(value, fail);
				break;
			}
			case "networkRecovery": {
				if (!isPlainObject(value)) {
					fail("invalid_nested_key", "networkRecovery must be an object", key);
					break;
				}
				const networkRecovery = parseNetworkRecoveryLayer(value, fail);
				if (Object.keys(networkRecovery).length > 0) layer.networkRecovery = networkRecovery;
				break;
			}
			default:
				fail("unknown_key", `unknown settings key: ${key}`, key);
				break;
		}
	}
	return { layer, diagnostics };
}
