/**
 * Layered settings resolution.
 *
 *     environment > project layer > global layer > defaults
 *
 * Merges the two cached layers and the PI_GOAL_* environment into one
 * snapshot with per-leaf provenance, and reports it for /goal-status.
 */

import { t } from "../i18n/index.ts";
import { GOAL_COMMANDS, GOAL_KEY_ACTIONS, type GoalCommands, type GoalKeybinding } from "../goal-controls.ts";
import { PI_GOAL_SETTINGS_FILE_ENV, goalGlobalSettingsPath, goalSettingsPath, readSettingsLayer, type SettingsLayerRead } from "./files.ts";
import {
	DEFAULT_NETWORK_RECOVERY_MAX_DELAY_MS, asBool, asNonNegativeInt, formatGoalKeybinding,
	type GoalKeybindings, type GoalNetworkRecoverySettingsLayer, type GoalOracleSettingsLayer, type GoalSettings,
	type GoalSettingsLayer, type SettingsDiagnostic,
} from "./schema.ts";

// ── resolution with provenance ──────────────────────────────────────────────

type SettingsSource = "environment" | "project" | "global" | "default";

interface ResolvedSetting<T> {
	value: T;
	source: SettingsSource;
	envVar?: string;
}

export interface SettingsSnapshot {
	global: SettingsLayerRead;
	project: SettingsLayerRead;
	value: GoalSettings;
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

/**
 * Resolve both layers + env into one snapshot with per-leaf provenance.
 * Nested keybindings resolve leaf-by-leaf from the SPARSE layers.
 */
const resolutionEnvKeys = ["PI_GOAL_ROOT", "PI_GOAL_LOCALE", "PI_GOAL_DISABLE_TASKS", "PI_GOAL_DISABLE_CONTRACTS", "PI_GOAL_OBJECTIVE_MAX_CHARS", "PI_GOAL_NETWORK_RECOVERY_MAX_ATTEMPTS", "PI_GOAL_NETWORK_RECOVERY_MAX_DELAY_MS"] as const;
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
	const resolve = <T>(key: string, get: (layer: GoalSettingsLayer) => T | undefined, defaultValue: T, envVar?: string, envValue?: T): T => {
		const resolved = resolveLeaf<T>({ envValue, envVar, projectValue: get(project.layer), globalValue: get(global.layer), defaultValue });
		provenance.set(key, resolved as ResolvedSetting<unknown>);
		return resolved.value;
	};
	const top = <K extends keyof GoalSettingsLayer>(key: K, defaultValue: GoalSettingsLayer[K], envVar?: string, envValue?: GoalSettingsLayer[K]) =>
		resolve(key, layer => layer[key], defaultValue, envVar, envValue);
	const oracle = <K extends keyof GoalOracleSettingsLayer>(key: K, defaultValue: GoalOracleSettingsLayer[K]) =>
		resolve(`oracle.${key}`, layer => layer.oracle?.[key], defaultValue);
	const networkRecovery = <K extends keyof GoalNetworkRecoverySettingsLayer>(key: K, envVar: string) =>
		resolve(`networkRecovery.${key}`, layer => layer.networkRecovery?.[key], key === "maxAttempts" ? 0 : DEFAULT_NETWORK_RECOVERY_MAX_DELAY_MS, envVar, asNonNegativeInt(env[envVar]));

	const provider = top("provider", undefined);
	const model = top("model", undefined);
	const thinkingLevel = top("thinkingLevel", undefined);
	const oracleProvider = oracle("provider", undefined);
	const oracleModel = oracle("model", undefined);
	const oracleThinkingLevel = oracle("thinkingLevel", undefined);

	const keybindings = { dashboard: {} } as unknown as GoalKeybindings;
	for (const action of GOAL_KEY_ACTIONS) {
		const get = (layer: GoalSettingsLayer): GoalKeybinding | undefined => {
			let cursor: unknown = layer;
			for (const key of action.path) cursor = (cursor as Record<string, unknown> | undefined)?.[key];
			return cursor as GoalKeybinding | undefined;
		};
		const resolved = resolve(action.path.join("."), get, action.defaults);
		let target = keybindings as unknown as Record<string, unknown>;
		const configured = get(project.layer) !== undefined || get(global.layer) !== undefined;
		// Keep the ordinary, uncustomized settings fast path as small as before.
		if (!configured && !(action.path[1] === "dashboard" && ["toggleExpand", "scrollUp", "scrollDown"].includes(action.path[2]!))) continue;
		for (const segment of action.path.slice(1, -1)) target = (target[segment] ??= {}) as Record<string, unknown>;
		target[action.path.at(-1)!] = resolved;
	}
	const commands: GoalCommands = {};
	for (const [id] of GOAL_COMMANDS) commands[id] = resolve(`commands.${id}`, layer => layer.commands?.[id], [id]);

	const value: GoalSettings = {
		disableTasks: top("disableTasks", false, "PI_GOAL_DISABLE_TASKS", asBool(env.PI_GOAL_DISABLE_TASKS)),
		disableContracts: top("disableContracts", false, "PI_GOAL_DISABLE_CONTRACTS", asBool(env.PI_GOAL_DISABLE_CONTRACTS)),
		subtaskDepth: top("subtaskDepth", 1),
		...(provider ? { provider } : {}),
		...(model ? { model } : {}),
		...(thinkingLevel ? { thinkingLevel } : {}),
		disabled: top("disabled", false),
		autoSelectSingleGoal: top("autoSelectSingleGoal", false),
		auditorProjectResources: top("auditorProjectResources", false),
		hideUnfocusedBanner: top("hideUnfocusedBanner", false),
		showAutonomousRuns: top("showAutonomousRuns", true),
		showContextUsage: top("showContextUsage", false),
		hideUnfocusedPrompt: top("hideUnfocusedPrompt", false),
		goalsRoot: top("goalsRoot", undefined, "PI_GOAL_ROOT", env.PI_GOAL_ROOT),
		locale: top("locale", undefined, "PI_GOAL_LOCALE", env.PI_GOAL_LOCALE),
		stallTimeoutMinutes: top("stallTimeoutMinutes", 0),
		maxIdleTurns: top("maxIdleTurns", 4),
		maxGoalMinutes: top("maxGoalMinutes", 0),
		auditorTimeoutMinutes: top("auditorTimeoutMinutes", 20),
		draftStyle: top("draftStyle", "ask"),
		maxAutonomousRuns: top("maxAutonomousRuns", undefined),
		idleContinuationBackoff: top("idleContinuationBackoff", false),
		strictExecutionContract: top("strictExecutionContract", false),
		objectiveMaxChars: top("objectiveMaxChars", 0, "PI_GOAL_OBJECTIVE_MAX_CHARS", asNonNegativeInt(env.PI_GOAL_OBJECTIVE_MAX_CHARS)),
		keybindings,
		...((Object.keys(global.layer.commands ?? {}).length || Object.keys(project.layer.commands ?? {}).length) ? { commands } : {}),
		pauseOrder: top("pauseOrder", "together"),
		networkRecovery: {
			maxAttempts: networkRecovery("maxAttempts", "PI_GOAL_NETWORK_RECOVERY_MAX_ATTEMPTS"),
			maxDelayMs: networkRecovery("maxDelayMs", "PI_GOAL_NETWORK_RECOVERY_MAX_DELAY_MS"),
		},
		oracle: {
			enabled: oracle("enabled", false)!,
			...(oracleProvider ? { provider: oracleProvider } : {}),
			...(oracleModel ? { model: oracleModel } : {}),
			...(oracleThinkingLevel ? { thinkingLevel: oracleThinkingLevel } : {}),
			projectResources: oracle("projectResources", false)!,
			maxFailedAttemptsPerBlocker: oracle("maxFailedAttemptsPerBlocker", 2)!,
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

function copyResolvedSettings(value: GoalSettings): GoalSettings {
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

// ── reporting ───────────────────────────────────────────────────────────────

/**
 * E2: which env var (if any) overrides a settings key's effective value.
 */
export function envOverrideFor(key: keyof GoalSettings | "settingsFile", env: NodeJS.ProcessEnv = process.env): string | null {
	if (key === "goalsRoot" && env.PI_GOAL_ROOT !== undefined) return "PI_GOAL_ROOT";
	if (key === "locale" && env.PI_GOAL_LOCALE !== undefined) return "PI_GOAL_LOCALE";
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
	const lines = [t("Settings (provenance):")];
	const rows: Array<{ key: string; label: string; format: () => string }> = [
		{ key: "autoSelectSingleGoal", label: "autoSelectSingleGoal", format: () => String(snapshot.value.autoSelectSingleGoal) },
		{ key: "disableContracts", label: "disableContracts", format: () => String(snapshot.value.disableContracts) },
		{ key: "disableTasks", label: "disableTasks", format: () => String(snapshot.value.disableTasks) },
		{ key: "subtaskDepth", label: "subtaskDepth", format: () => String(snapshot.value.subtaskDepth) },
		{ key: "disabled", label: t("auditor disabled"), format: () => String(snapshot.value.disabled) },
		{ key: "provider", label: "provider", format: () => snapshot.value.provider ?? t("(default)") },
		{ key: "model", label: "model", format: () => snapshot.value.model ?? t("(default)") },
		{ key: "thinkingLevel", label: "thinking_level", format: () => snapshot.value.thinkingLevel ?? t("(default)") },
		{ key: "auditorProjectResources", label: t("auditor project resources"), format: () => String(snapshot.value.auditorProjectResources) },
		{ key: "hideUnfocusedBanner", label: t("hide unfocused banner"), format: () => String(snapshot.value.hideUnfocusedBanner) },
		{ key: "showAutonomousRuns", label: t("show autonomous runs line"), format: () => String(snapshot.value.showAutonomousRuns) },
		{ key: "showContextUsage", label: t("show context usage line"), format: () => String(snapshot.value.showContextUsage) },
		{ key: "goalsRoot", label: t("goals root (reload to change)"), format: () => snapshot.value.goalsRoot ?? ".pi/goals" },
		{ key: "locale", label: t("language"), format: () => snapshot.value.locale ?? t("en (default)") },
		{ key: "hideUnfocusedPrompt", label: t("hide unfocused prompt"), format: () => String(snapshot.value.hideUnfocusedPrompt) },
		{ key: "idleContinuationBackoff", label: t("slow repeated idle replies (opt-in)"), format: () => String(snapshot.value.idleContinuationBackoff) },
		{ key: "strictExecutionContract", label: t("explicit execution contracts (opt-in)"), format: () => String(snapshot.value.strictExecutionContract) },
		{ key: "maxAutonomousRuns", label: t("autonomous run allowance"), format: () => snapshot.value.maxAutonomousRuns === 0 ? t("0 (disabled)") : String(snapshot.value.maxAutonomousRuns ?? t("unlimited (default)")) },
		{ key: "stallTimeoutMinutes", label: t("stall timeout (minutes)"), format: () => String(snapshot.value.stallTimeoutMinutes) },
		{ key: "maxIdleTurns", label: t("pause after idle turns (0 = never)"), format: () => String(snapshot.value.maxIdleTurns) },
		{ key: "maxGoalMinutes", label: t("goal time limit (minutes, 0 = none)"), format: () => String(snapshot.value.maxGoalMinutes) },
		{ key: "auditorTimeoutMinutes", label: t("audit time limit (minutes, 0 = none)"), format: () => String(snapshot.value.auditorTimeoutMinutes) },
		{ key: "draftStyle", label: t("draft style"), format: () => String(snapshot.value.draftStyle) },
		{ key: "objectiveMaxChars", label: t("max objective length (0 = none)"), format: () => String(snapshot.value.objectiveMaxChars) },
		{ key: "networkRecovery", label: t("network recovery attempts (0 = unbounded)"), format: () => String(snapshot.value.networkRecovery?.maxAttempts ?? 0) },
		{ key: "networkRecovery", label: t("network recovery max delay (ms)"), format: () => String(snapshot.value.networkRecovery?.maxDelayMs ?? DEFAULT_NETWORK_RECOVERY_MAX_DELAY_MS) },
		{ key: "pauseOrder", label: t("pause order"), format: () => snapshot.value.pauseOrder ?? "together" },
		{ key: "keybindings", label: t("dashboard keybindings"), format: () => `${snapshot.value.keybindings!.dashboard.toggleExpand}, ${snapshot.value.keybindings!.dashboard.scrollUp}, ${snapshot.value.keybindings!.dashboard.scrollDown}` },
	];
	for (const row of rows) {
		const resolved = snapshot.provenance.get(row.key);
		let source: string;
		if (resolved?.source === "environment") source = t("env ({envVar})", { envVar: String(resolved.envVar) });
		else source = resolved?.source ?? "default";
		lines.push(`  ${row.label}: ${row.format()} (${source})`);
	}
	for (const [id] of GOAL_COMMANDS) {
		const source = snapshot.provenance.get(`commands.${id}`)?.source ?? "default";
		lines.push(`  ${id}: ${(snapshot.provenance.get(`commands.${id}`)?.value as string[]).map(route => `/${route}`).join(", ") || t("disabled")} (${source})`);
	}
	for (const action of GOAL_KEY_ACTIONS) {
		const source = snapshot.provenance.get(action.path.join("."));
		lines.push(`  ${action.label}: ${formatGoalKeybinding(source?.value as GoalKeybinding)} (${source?.source ?? "default"})`);
	}
	lines.push(`  ${t("project settings file: {path}", { path: snapshot.project.path })}`);
	lines.push(`  ${t("global settings file: {path}", { path: snapshot.global.path })}`);
	const fileOverride = envOverrideFor("settingsFile", env);
	if (fileOverride) lines.push(`  ${t("(settings file overridden by {name})", { name: fileOverride })}`);
	return lines;
}
