import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { t } from "./i18n/index.ts";
import { scopeName, showGoalControls, type GoalControlsCore } from "./widgets/goal-controls-dialog.ts";
import { type GoalSettings, type SettingsScope } from "./settings/schema.ts";
import { goalSettingsPath, goalGlobalSettingsPath } from "./settings/files.ts";
import { loadGoalSettings, loadSettingsSnapshot, envOverrideFor, type SettingsSnapshot } from "./settings/resolve.ts";
import { mutateSettingsLayer, type SettingsMutation } from "./settings/mutate.ts";
import {
	AUDITOR_THINKING_LEVELS,
	buildAuditorModelChoices,
	configuredAuditorModelKey,
	filterAuditorModelChoices,
	parseManualAuditorModel,
	thinkingLevelChoices,
	type AuditorChoice,
} from "./auditor-selector.ts";
import type { GoalToolProfile, SchedulerSlice, StateSlice } from "./goal-core-types.ts";

/**
 * One declarative row table for the settings menu. Rendering and dispatch
 * both derive from SETTING_ROWS so the displayed fields and the selectable
 * fields can never drift apart. Rows are grouped into sections.
 */
type SettingRow = {
	key: keyof GoalSettings | string;
	label: string;
	section: string;
	kind: "boolean" | "modelSelector" | "thinking" | "positiveInteger";
	/** Settings path for the mutation (defaults to [key]). */
	path?: string[];
	help?: string;
};

/** Built when the menu opens, so labels follow the chosen language. */
const settingRows = (): SettingRow[] => [
	{ key: "autoSelectSingleGoal", label: "autoSelectSingleGoal", section: t("Goal behavior"), kind: "boolean" },
	{ key: "hideUnfocusedBanner", label: "hideUnfocusedBanner", section: t("Goal behavior"), kind: "boolean" },
	{ key: "hideUnfocusedPrompt", label: "hideUnfocusedPrompt", section: t("Goal behavior"), kind: "boolean" },
	{ key: "disableContracts", label: "disableContracts", section: t("Goal behavior"), kind: "boolean" },
	{ key: "strictExecutionContract", label: t("explicit execution contracts (opt-in)"), section: t("Goal behavior"), kind: "boolean" },
	{ key: "maxAutonomousRuns", label: t("autonomous run allowance"), section: t("Goal behavior"), kind: "positiveInteger" },
	{ key: "showAutonomousRuns", label: t("show autonomous runs line"), section: t("Goal behavior"), kind: "boolean" },
	{ key: "showContextUsage", label: t("show context usage line"), section: t("Goal behavior"), kind: "boolean" },
	{ key: "stallTimeoutMinutes", label: t("stall timeout (minutes)"), section: t("Goal behavior"), kind: "positiveInteger" },
	{ key: "maxIdleTurns", label: t("pause after idle turns (0 = never)"), section: t("Goal behavior"), kind: "positiveInteger" },
	{ key: "maxGoalMinutes", label: t("goal time limit (minutes, 0 = none)"), section: t("Goal behavior"), kind: "positiveInteger" },
	{ key: "auditorTimeoutMinutes", label: t("audit time limit (minutes, 0 = none)"), section: t("Completion auditor"), kind: "positiveInteger" },
	{ key: "objectiveMaxChars", label: t("max objective length (0 = none)"), section: t("Goal behavior"), kind: "positiveInteger" },
	{ key: "idleContinuationBackoff", label: t("slow repeated idle replies (opt-in)"), section: t("Advanced execution"), kind: "boolean",
		help: t("Slows repeated replies without recognized work. May delay reasoning or custom tools. For a hard stop, set an autonomous run allowance.") },
	{ key: "disableTasks", label: "disableTasks", section: t("Task tracking"), kind: "boolean" },
	{ key: "subtaskDepth", label: "subtaskDepth", section: t("Task tracking"), kind: "positiveInteger" },
	{ key: "disabled", label: t("auditor disabled"), section: t("Completion auditor"), kind: "boolean" },
	{ key: "provider", label: "provider", section: t("Completion auditor"), kind: "modelSelector" },
	{ key: "model", label: "model", section: t("Completion auditor"), kind: "modelSelector" },
	{ key: "thinkingLevel", label: "thinking_level", section: t("Completion auditor"), kind: "thinking" },
	// Issue #26: opt-in blocker Oracle. Disabled by default; provider/model
	// must BOTH be set explicitly — the executor model is never used silently.
	{ key: "oracleEnabled", label: t("oracle enabled"), section: t("Blocker Oracle"), kind: "boolean", path: ["oracle", "enabled"] },
	{ key: "oracleProviderModel", label: t("oracle provider/model"), section: t("Blocker Oracle"), kind: "modelSelector", path: ["oracle"] },
	{ key: "oracleThinkingLevel", label: t("oracle thinking_level"), section: t("Blocker Oracle"), kind: "thinking", path: ["oracle", "thinkingLevel"] },
	{ key: "oracleProjectResources", label: t("oracle project resources"), section: t("Blocker Oracle"), kind: "boolean", path: ["oracle", "projectResources"] },
	{ key: "oracleMaxFailedAttemptsPerBlocker", label: t("max failed attempts per blocker"), section: t("Blocker Oracle"), kind: "positiveInteger", path: ["oracle", "maxFailedAttemptsPerBlocker"] },
];

const BOOLEAN_KEYS = new Set<string>([
	"idleContinuationBackoff", "strictExecutionContract", "disabled", "disableTasks", "disableContracts", "autoSelectSingleGoal",
	"auditorProjectResources", "hideUnfocusedBanner", "hideUnfocusedPrompt", "showAutonomousRuns", "showContextUsage",
]);

/** Integer settings whose minimum is 0; every other integer setting starts at 1. */
const ZERO_ALLOWED_KEYS = new Set<string>(["stallTimeoutMinutes", "objectiveMaxChars", "maxAutonomousRuns", "maxIdleTurns", "maxGoalMinutes", "auditorTimeoutMinutes"]);

function settingsValue(config: GoalSettings, key: keyof GoalSettings | string): string {
	if (BOOLEAN_KEYS.has(key)) return (config as Record<string, unknown>)[key] === true ? "true" : "false";
	if (key === "subtaskDepth") return config.subtaskDepth !== undefined ? String(config.subtaskDepth) : "1";
	if (key === "maxAutonomousRuns") return config.maxAutonomousRuns === 0 ? t("0 (disabled)") : String(config.maxAutonomousRuns ?? t("unlimited (default)"));
	if (key === "stallTimeoutMinutes") return config.stallTimeoutMinutes !== undefined ? String(config.stallTimeoutMinutes) : "0";
	if (key === "maxIdleTurns") return String(config.maxIdleTurns ?? 4);
	if (key === "auditorTimeoutMinutes") return String(config.auditorTimeoutMinutes ?? 20);
	if (key === "maxGoalMinutes") return String(config.maxGoalMinutes ?? 0);
	if (key === "objectiveMaxChars") return config.objectiveMaxChars !== undefined ? String(config.objectiveMaxChars) : "0";
	if (key === "keybindings") return config.keybindings ? `${config.keybindings.dashboard.toggleExpand}, ${config.keybindings.dashboard.scrollUp}, ${config.keybindings.dashboard.scrollDown}` : "(default)";
	const value = (config as Record<string, unknown>)[key];
	return typeof value === "string" ? value : "(default)";
}

const rowPathOf = (row: SettingRow): string[] => row.path ?? [String(row.key)];

function valueAtPath(obj: unknown, path: string[]): unknown {
	let cursor: unknown = obj;
	for (const segment of path) {
		if (!cursor || typeof cursor !== "object") return undefined;
		cursor = (cursor as Record<string, unknown>)[segment];
	}
	return cursor;
}

/** Where a row's effective value comes from, relative to the layer being edited. */
function sourceLabel(snapshot: SettingsSnapshot, localLayer: Record<string, unknown>, scope: SettingsScope, rowPath: string[]): string {
	const provenance = snapshot.provenance.get(rowPath.join("."));
	let source: string;
	if (provenance?.source === "global") source = scope === "project" ? t("(inherited from global)") : t("(global override)");
	else if (provenance?.source === "project") source = scope === "project" ? t("(project override)") : t("(project; edit via project scope)");
	else source = t("(default)");
	if (valueAtPath(localLayer, rowPath) !== undefined && provenance?.source === scope) source = scope === "project" ? t("(project override)") : t("(global override)");
	return source;
}

interface RowEdit {
	ctx: ExtensionContext;
	row: SettingRow;
	scope: SettingsScope;
	snapshot: SettingsSnapshot;
	localLayer: Record<string, unknown>;
	rowPath: string[];
	hasLocalOverride: boolean;
	apply: (scope: SettingsScope, mutation: SettingsMutation) => boolean;
}

function inheritLabelFor(scope: SettingsScope): string {
	return scope === "project" ? t("Use inherited value") : t("Use default (delete global override)");
}

function rowTitle(row: SettingRow, scope: SettingsScope): string {
	return t("{label} ({scope})", { label: row.label, scope: scopeName(scope) }) + (row.help ? `\n${row.help}` : "");
}

async function editBooleanRow(edit: RowEdit): Promise<void> {
	const { ctx, row, scope, snapshot, rowPath, hasLocalOverride, apply } = edit;
	const inheritLabel = inheritLabelFor(scope);
	const effective = snapshot.provenance.get(rowPath.join("."))?.value === true;
	const setTrue = t("Set {scope} override to true", { scope: scopeName(scope) });
	const cancel = t("Cancel");
	const actions = [setTrue, t("Set {scope} override to false", { scope: scopeName(scope) })];
	if (hasLocalOverride) actions.push(inheritLabel);
	actions.push(cancel);
	const action = await ctx.ui.select(rowTitle(row, scope), actions);
	if (!action || action === cancel) return;
	if (action === inheritLabel) {
		apply(scope, { op: "unset", path: rowPath });
		return;
	}
	const value = action === setTrue;
	if (value !== effective || !hasLocalOverride) apply(scope, { op: "set", path: rowPath, value });
}

async function editIntegerRow(edit: RowEdit): Promise<void> {
	const { ctx, row, scope, snapshot, rowPath, hasLocalOverride, apply } = edit;
	const inheritLabel = inheritLabelFor(scope);
	const min = !row.path && ZERO_ALLOWED_KEYS.has(String(row.key)) ? 0 : 1;
	const cancel = t("Cancel");
	const actions = [t("Set {scope} override...", { scope: scopeName(scope) })];
	if (hasLocalOverride) actions.push(inheritLabel);
	actions.push(cancel);
	const action = await ctx.ui.select(rowTitle(row, scope), actions);
	if (!action || action === cancel) return;
	if (action === inheritLabel) {
		apply(scope, { op: "unset", path: rowPath });
		return;
	}
	const input = await ctx.ui.input(t("Set {label}", { label: row.label }), String(snapshot.provenance.get(rowPath.join("."))?.value ?? min));
	if (input === undefined) return;
	// Full-string decimal validation: rejects 1.5, 1x, negatives,
	// infinity, and unsafe integers alike.
	const value = input.trim();
	if (!/^[0-9]+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < min) {
		ctx.ui.notify(t("{label} must be an integer >= {min} (e.g. {min}, {next}, {after})", { label: row.label, min, next: min + 1, after: min + 2 }), "warning");
		return;
	}
	// Oracle attempt cap is bounded at 3 by the settings parser.
	if (row.path?.[0] === "oracle" && Number(value) > 3) {
		ctx.ui.notify(t("{label} must be an integer between 1 and 3", { label: row.label }), "warning");
		return;
	}
	apply(scope, { op: "set", path: rowPath, value: Number(value) });
}

async function editThinkingRow(edit: RowEdit): Promise<void> {
	const { ctx, row, scope, snapshot, rowPath, hasLocalOverride, apply } = edit;
	const currentValue = settingsValue(snapshot.value, row.key);
	const levels = thinkingLevelChoices(currentValue === "(default)" ? undefined : currentValue);
	const picked = await ctx.ui.select(t("Set {label} ({scope})", { label: row.label, scope: scopeName(scope) }), levels);
	if (!picked) return;
	const choice = picked.trim().replace(/^✓\s+/, "");
	if (choice === "(default)") {
		if (hasLocalOverride) apply(scope, { op: "unset", path: rowPath });
		return;
	}
	if (!(AUDITOR_THINKING_LEVELS as readonly string[]).includes(choice)) {
		ctx.ui.notify(t("thinking_level must be one of: {levels} (or \"(default)\")", { levels: AUDITOR_THINKING_LEVELS.join(", ") }), "warning");
		return;
	}
	apply(scope, { op: "set", path: rowPath, value: choice });
}

/**
 * Model selector rows (provider, model): searchable model picker with
 * explicit inherit/default handling. Auditor rows apply provider+model at the
 * flat paths; the Oracle row writes oracle.provider/oracle.model.
 */
async function editModelRow(edit: RowEdit): Promise<void> {
	const { ctx, row, scope, snapshot, localLayer, apply } = edit;
	const pairPrefix = row.path?.[0] === "oracle" ? ["oracle"] : [];
	const configuredBase = pairPrefix.length > 0
		? [snapshot.value.oracle?.provider, snapshot.value.oracle?.model].filter(Boolean).join("/")
		: configuredAuditorModelKey(snapshot.value as GoalSettings);
	const configured = configuredBase || undefined;
	const session = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
	const choices = buildAuditorModelChoices(ctx.modelRegistry.getAvailable(), configured, session);
	const filter = await ctx.ui.input(t("Filter auditor models (provider/id/name; blank = all)"), "");
	if (filter === undefined) return;
	const filtered = filterAuditorModelChoices(choices, filter);
	const picked = await ctx.ui.select(t("Select auditor model"), filtered.map((choice: AuditorChoice) => choice.label));
	if (!picked) return;
	const choice = filtered.find((candidate: AuditorChoice) => candidate.label === picked);
	if (!choice) return;
	if (choice.kind === "default") {
		for (const key of ["provider", "model"] as const) {
			if (localLayer[key] !== undefined) apply(scope, { op: "unset", path: [...pairPrefix, key] });
		}
		return;
	}
	let providerValue: string;
	let modelValue: string;
	if (choice.kind === "manual") {
		const input = await ctx.ui.input(t("Set auditor provider/model"), configured ?? "provider/model");
		if (input === undefined) return;
		const parsed = parseManualAuditorModel(input);
		if ("error" in parsed) {
			ctx.ui.notify(parsed.error, "warning");
			return;
		}
		providerValue = parsed.provider;
		modelValue = parsed.model;
	} else {
		providerValue = choice.provider;
		modelValue = choice.model;
	}
	if (apply(scope, { op: "set", path: [...pairPrefix, "provider"], value: providerValue })) {
		apply(scope, { op: "set", path: [...pairPrefix, "model"], value: modelValue });
	}
}

const ROW_EDITORS: Record<SettingRow["kind"], (edit: RowEdit) => Promise<void>> = {
	boolean: editBooleanRow,
	positiveInteger: editIntegerRow,
	thinking: editThinkingRow,
	modelSelector: editModelRow,
};

/** What the settings menu reads from the session, on top of what the controls dialog needs. */
export type SettingsMenuCore = GoalControlsCore & GoalToolProfile & StateSlice<"tasksEnabled"> & SchedulerSlice<"refreshSettings">;

export async function handleSettingsMenu(core: SettingsMenuCore, ctx: ExtensionContext): Promise<void> {
	if (!ctx.hasUI) {
		// Headless: read-only report of both layer paths.
		ctx.ui.notify(
			t("Settings — project file: {project}\nGlobal file: {global}", { project: goalSettingsPath(ctx.cwd), global: goalGlobalSettingsPath() }),
			"info",
		);
		return;
	}

	/**
	 * After any mutation: reinstall the goal tool list when the effective
	 * disableTasks value changed since the last install, and refresh the UI.
	 * This is the central settings side-effect hook — no ad hoc per-row
	 * refresh code.
	 */
	const applyEffectiveSettings = (): void => {
		const tasksEnabledNow = !loadGoalSettings(ctx.cwd).disableTasks;
		if (tasksEnabledNow !== core.state.tasksEnabled) {
			core.installGoalToolProfile(tasksEnabledNow);
		}
		// PR #29: settings changes must be visible immediately — the banner
		// hide/restore happens through this coalesced UI refresh.
		core.updateUI(ctx);
	};

	const applyMutation = (scope: SettingsScope, mutation: SettingsMutation): boolean => {
		try {
			mutateSettingsLayer({ scope, cwd: ctx.cwd, mutation });
			applyEffectiveSettings();
			if (mutation.path[0] === "idleContinuationBackoff") core.scheduler.refreshSettings(ctx);
			return true;
		} catch (err) {
			ctx.ui.notify(t("Settings change failed: {message}", { message: err instanceof Error ? err.message : String(err) }), "warning");
			return false;
		}
	};

	const scopePath = (scope: SettingsScope): string =>
		scope === "global" ? goalGlobalSettingsPath() : goalSettingsPath(ctx.cwd);

	core.state.enterModal();
	try {
		let scope: SettingsScope = "project";
		const rows = settingRows();
		const done = t("Done");
		const controls = t("Controls: commands, keys and pause order…");
		while (true) {
			const snapshot = loadSettingsSnapshot(ctx.cwd);
			const localLayer = snapshot[scope].layer as Record<string, unknown>;
			const scopeOption = t("Scope: {scope} (select to switch)", { scope: scopeName(scope) });
			const options: string[] = [
				t("─── Editing: {scope} ({path}) ───", { scope: scopeName(scope), path: scopePath(scope) }),
				scopeOption,
				controls,
			];
			const rowByOption = new Map<string, SettingRow>();
			let lastSection: string | null = null;
			for (const row of rows) {
				if (row.section !== lastSection) {
					options.push(`─── ${row.section} ───`);
					lastSection = row.section;
				}
				let line: string;
				if (envOverrideFor(row.key as keyof GoalSettings)) {
					line = `  ${row.label}: ${settingsValue(snapshot.value, row.key)} ${t("(environment; read-only)")}`;
				} else {
					// Nested rows render their leaf value directly.
					const displayValue = row.path
						? String(valueAtPath(snapshot.value, row.path) ?? "(default)")
						: settingsValue(snapshot.value, row.key);
					line = `  ${row.label}: ${displayValue} ${sourceLabel(snapshot, localLayer, scope, rowPathOf(row))}`;
				}
				rowByOption.set(line, row);
				options.push(line);
			}
			options.push(done);
			const selected = await ctx.ui.select(t("Goal settings"), options);
			if (!selected || selected === done) break;
			if (selected === controls) { if (await showGoalControls(core, ctx, scope)) return; continue; }
			if (selected.startsWith("───")) continue; // headers are not rows
			if (selected === scopeOption) {
				scope = scope === "project" ? "global" : "project";
				continue;
			}
			const row = rowByOption.get(selected);
			if (!row) continue;
			const envVar = envOverrideFor(row.key as keyof GoalSettings);
			if (envVar) {
				ctx.ui.notify(t("{label} is read-only: overridden by the {envVar} env var.", { label: row.label, envVar }), "warning");
				continue;
			}
			// Per-row settings path (flat keys default to [key]; nested Blocker
			// Oracle rows carry explicit paths).
			const rowPath = rowPathOf(row);
			await ROW_EDITORS[row.kind]({
				ctx, row, scope, snapshot, localLayer, rowPath,
				hasLocalOverride: valueAtPath(localLayer, rowPath) !== undefined,
				apply: applyMutation,
			});
		}
	} finally {
		core.state.exitModal();
	}
}
