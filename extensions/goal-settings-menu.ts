import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { showGoalControls, type GoalControlsCore } from "./widgets/goal-controls-dialog.ts";
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
	section: "Goal behavior" | "Task tracking" | "Completion auditor" | "Blocker Oracle" | "Advanced execution";
	kind: "boolean" | "modelSelector" | "thinking" | "positiveInteger";
	/** Settings path for the mutation (defaults to [key]). */
	path?: string[];
	help?: string;
};

const SETTING_ROWS: readonly SettingRow[] = [
	{ key: "autoSelectSingleGoal", label: "autoSelectSingleGoal", section: "Goal behavior", kind: "boolean" },
	{ key: "hideUnfocusedBanner", label: "hideUnfocusedBanner", section: "Goal behavior", kind: "boolean" },
	{ key: "hideUnfocusedPrompt", label: "hideUnfocusedPrompt", section: "Goal behavior", kind: "boolean" },
	{ key: "disableContracts", label: "disableContracts", section: "Goal behavior", kind: "boolean" },
	{ key: "strictExecutionContract", label: "explicit execution contracts (opt-in)", section: "Goal behavior", kind: "boolean" },
	{ key: "maxAutonomousRuns", label: "autonomous run allowance", section: "Goal behavior", kind: "positiveInteger" },
	{ key: "showAutonomousRuns", label: "show autonomous runs line", section: "Goal behavior", kind: "boolean" },
	{ key: "showContextUsage", label: "show context usage line", section: "Goal behavior", kind: "boolean" },
	{ key: "stallTimeoutMinutes", label: "stall timeout (minutes)", section: "Goal behavior", kind: "positiveInteger" },
	{ key: "objectiveMaxChars", label: "max objective length (0 = none)", section: "Goal behavior", kind: "positiveInteger" },
	{ key: "idleContinuationBackoff", label: "slow repeated idle replies (opt-in)", section: "Advanced execution", kind: "boolean",
		help: "Slows repeated replies without recognized work. May delay reasoning or custom tools. For a hard stop, set an autonomous run allowance." },
	{ key: "disableTasks", label: "disableTasks", section: "Task tracking", kind: "boolean" },
	{ key: "subtaskDepth", label: "subtaskDepth", section: "Task tracking", kind: "positiveInteger" },
	{ key: "disabled", label: "auditor disabled", section: "Completion auditor", kind: "boolean" },
	{ key: "provider", label: "provider", section: "Completion auditor", kind: "modelSelector" },
	{ key: "model", label: "model", section: "Completion auditor", kind: "modelSelector" },
	{ key: "thinkingLevel", label: "thinking_level", section: "Completion auditor", kind: "thinking" },
	// Issue #26: opt-in blocker Oracle. Disabled by default; provider/model
	// must BOTH be set explicitly — the executor model is never used silently.
	{ key: "oracleEnabled", label: "oracle enabled", section: "Blocker Oracle", kind: "boolean", path: ["oracle", "enabled"] },
	{ key: "oracleProviderModel", label: "oracle provider/model", section: "Blocker Oracle", kind: "modelSelector", path: ["oracle"] },
	{ key: "oracleThinkingLevel", label: "oracle thinking_level", section: "Blocker Oracle", kind: "thinking", path: ["oracle", "thinkingLevel"] },
	{ key: "oracleProjectResources", label: "oracle project resources", section: "Blocker Oracle", kind: "boolean", path: ["oracle", "projectResources"] },
	{ key: "oracleMaxFailedAttemptsPerBlocker", label: "max failed attempts per blocker", section: "Blocker Oracle", kind: "positiveInteger", path: ["oracle", "maxFailedAttemptsPerBlocker"] },
];

const BOOLEAN_KEYS = new Set<string>([
	"idleContinuationBackoff", "strictExecutionContract", "disabled", "disableTasks", "disableContracts", "autoSelectSingleGoal",
	"auditorProjectResources", "hideUnfocusedBanner", "hideUnfocusedPrompt", "showAutonomousRuns", "showContextUsage",
]);

/** Integer settings whose minimum is 0; every other integer setting starts at 1. */
const ZERO_ALLOWED_KEYS = new Set<string>(["stallTimeoutMinutes", "objectiveMaxChars", "maxAutonomousRuns"]);

function settingsValue(config: GoalSettings, key: keyof GoalSettings | string): string {
	if (BOOLEAN_KEYS.has(key)) return (config as Record<string, unknown>)[key] === true ? "true" : "false";
	if (key === "subtaskDepth") return config.subtaskDepth !== undefined ? String(config.subtaskDepth) : "1";
	if (key === "maxAutonomousRuns") return config.maxAutonomousRuns === 0 ? "0 (disabled)" : String(config.maxAutonomousRuns ?? "unlimited (default)");
	if (key === "stallTimeoutMinutes") return config.stallTimeoutMinutes !== undefined ? String(config.stallTimeoutMinutes) : "0";
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
	if (provenance?.source === "global") source = scope === "project" ? "(inherited from global)" : "(global override)";
	else if (provenance?.source === "project") source = scope === "project" ? "(project override)" : "(project; edit via project scope)";
	else source = "(default)";
	if (valueAtPath(localLayer, rowPath) !== undefined && provenance?.source === scope) source = `(${scope} override)`;
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
	return scope === "project" ? "Use inherited value" : "Use default (delete global override)";
}

async function editBooleanRow(edit: RowEdit): Promise<void> {
	const { ctx, row, scope, snapshot, rowPath, hasLocalOverride, apply } = edit;
	const inheritLabel = inheritLabelFor(scope);
	const effective = snapshot.provenance.get(rowPath.join("."))?.value === true;
	const actions = [`Set ${scope} override to true`, `Set ${scope} override to false`];
	if (hasLocalOverride) actions.push(inheritLabel);
	actions.push("Cancel");
	const action = await ctx.ui.select(`${row.label} (${scope})${row.help ? `\n${row.help}` : ""}`, actions);
	if (!action || action === "Cancel") return;
	if (action === inheritLabel) {
		apply(scope, { op: "unset", path: rowPath });
		return;
	}
	const value = action.endsWith("true");
	if (value !== effective || !hasLocalOverride) apply(scope, { op: "set", path: rowPath, value });
}

async function editIntegerRow(edit: RowEdit): Promise<void> {
	const { ctx, row, scope, snapshot, rowPath, hasLocalOverride, apply } = edit;
	const inheritLabel = inheritLabelFor(scope);
	const min = !row.path && ZERO_ALLOWED_KEYS.has(String(row.key)) ? 0 : 1;
	const actions = [`Set ${scope} override...`];
	if (hasLocalOverride) actions.push(inheritLabel);
	actions.push("Cancel");
	const action = await ctx.ui.select(`${row.label} (${scope})${row.help ? `\n${row.help}` : ""}`, actions);
	if (!action || action === "Cancel") return;
	if (action === inheritLabel) {
		apply(scope, { op: "unset", path: rowPath });
		return;
	}
	const input = await ctx.ui.input(`Set ${row.label}`, String(snapshot.provenance.get(rowPath.join("."))?.value ?? min));
	if (input === undefined) return;
	// Full-string decimal validation: rejects 1.5, 1x, negatives,
	// infinity, and unsafe integers alike.
	const value = input.trim();
	if (!/^[0-9]+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < min) {
		ctx.ui.notify(`${row.label} must be an integer >= ${min} (e.g. ${min}, ${min + 1}, ${min + 2})`, "warning");
		return;
	}
	// Oracle attempt cap is bounded at 3 by the settings parser.
	if (row.path?.[0] === "oracle" && Number(value) > 3) {
		ctx.ui.notify(`${row.label} must be an integer between 1 and 3`, "warning");
		return;
	}
	apply(scope, { op: "set", path: rowPath, value: Number(value) });
}

async function editThinkingRow(edit: RowEdit): Promise<void> {
	const { ctx, row, scope, snapshot, rowPath, hasLocalOverride, apply } = edit;
	const currentValue = settingsValue(snapshot.value, row.key);
	const levels = thinkingLevelChoices(currentValue === "(default)" ? undefined : currentValue);
	const picked = await ctx.ui.select(`Set ${row.label} (${scope})`, levels);
	if (!picked) return;
	const choice = picked.trim().replace(/^✓\s+/, "");
	if (choice === "(default)") {
		if (hasLocalOverride) apply(scope, { op: "unset", path: rowPath });
		return;
	}
	if (!(AUDITOR_THINKING_LEVELS as readonly string[]).includes(choice)) {
		ctx.ui.notify(`thinking_level must be one of: ${AUDITOR_THINKING_LEVELS.join(", ")} (or "(default)")`, "warning");
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
	const filter = await ctx.ui.input("Filter auditor models (provider/id/name; blank = all)", "");
	if (filter === undefined) return;
	const filtered = filterAuditorModelChoices(choices, filter);
	const picked = await ctx.ui.select("Select auditor model", filtered.map((choice: AuditorChoice) => choice.label));
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
		const input = await ctx.ui.input("Set auditor provider/model", configured ?? "provider/model");
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
			`Settings — project file: ${goalSettingsPath(ctx.cwd)}\nGlobal file: ${goalGlobalSettingsPath()}`,
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
			ctx.ui.notify(`Settings change failed: ${err instanceof Error ? err.message : String(err)}`, "warning");
			return false;
		}
	};

	const scopePath = (scope: SettingsScope): string =>
		scope === "global" ? goalGlobalSettingsPath() : goalSettingsPath(ctx.cwd);

	core.state.enterModal();
	try {
		let scope: SettingsScope = "project";
		while (true) {
			const snapshot = loadSettingsSnapshot(ctx.cwd);
			const localLayer = snapshot[scope].layer as Record<string, unknown>;
			const options: string[] = [
				`─── Editing: ${scope} (${scopePath(scope)}) ───`,
				`Scope: ${scope} (select to switch)`,
				"Controls: commands, keys and pause order…",
			];
			let lastSection: string | null = null;
			for (const row of SETTING_ROWS) {
				if (row.section !== lastSection) {
					options.push(`─── ${row.section} ───`);
					lastSection = row.section;
				}
				if (envOverrideFor(row.key as keyof GoalSettings)) {
					options.push(`  ${row.label}: ${settingsValue(snapshot.value, row.key)} (environment; read-only)`);
					continue;
				}
				// Nested rows render their leaf value directly.
				const displayValue = row.path
					? String(valueAtPath(snapshot.value, row.path) ?? "(default)")
					: settingsValue(snapshot.value, row.key);
				options.push(`  ${row.label}: ${displayValue} ${sourceLabel(snapshot, localLayer, scope, rowPathOf(row))}`);
			}
			options.push("Done");
			const selected = await ctx.ui.select("Goal settings", options);
			if (!selected || selected === "Done") break;
			if (selected.startsWith("Controls:")) { if (await showGoalControls(core, ctx, scope)) return; continue; }
			if (selected.startsWith("───")) continue; // headers are not rows
			const trimmed = selected.trim();
			if (trimmed.startsWith("Scope:")) {
				scope = scope === "project" ? "global" : "project";
				continue;
			}
			const colon = trimmed.indexOf(":");
			if (colon === -1) continue;
			const label = trimmed.slice(0, colon).trim();
			const row = SETTING_ROWS.find((r) => r.label === label);
			if (!row) continue;
			const envVar = envOverrideFor(row.key as keyof GoalSettings);
			if (envVar) {
				ctx.ui.notify(`${row.label} is read-only: overridden by the ${envVar} env var.`, "warning");
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
