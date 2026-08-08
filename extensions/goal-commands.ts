import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { extractVerificationContract, sisyphusObjectiveSufficient } from "./goal-contract.ts";
import { detailedSummary, oneLineSummary } from "./goal-format.ts";
import {
	goalSettingsPath,
	loadGoalSettings,
	loadGoalSettingsFileConfig,
	saveGoalSettingsFileConfig,
	type GoalSettings,
} from "./goal-settings.ts";
import {
	buildGoalListText,
	buildUnfocusedOpenGoalsSummary,
	goalSelectorLabel,
	otherOpenGoalCount,
} from "./goal-pool.ts";
import { clearGoalCommandMessage, validateResumeGoal } from "./goal-policy.ts";
import { readGoalLedger } from "./goal-ledger.ts";
import { buildGoalStatusText } from "./goal-status.ts";
import { effectiveSettingsReport, envOverrideFor } from "./goal-settings.ts";
import { mergeGoalPromptFromDisk } from "./storage/goal-files.ts";
import { nowIso, type GoalMode, type GoalRecord } from "./goal-record.ts";
import { clearGoalDrafting, hasActiveDraft, startGoalDrafting } from "./goal-drafting.ts";
import {
	AUDITOR_THINKING_LEVELS,
	buildAuditorModelChoices,
	configuredAuditorModelKey,
	filterAuditorModelChoices,
	parseManualAuditorModel,
	thinkingLevelChoices,
	type AuditorChoice,
} from "./auditor-selector.ts";
import type { GoalCore } from "./goal-state.ts";

/**
 * The curated twelve-command palette. /goal and /sisyphus begin guided
 * drafting; -direct commands are the explicit bypass. Every frequent lifecycle action is independently
 * registered so it appears in slash-command tab completion. No aliases.
 */
export function registerGoalCommands(core: GoalCore): void {
	const { pi } = core;

	async function chooseOpenGoal(ctx: ExtensionContext, title: string): Promise<GoalRecord | null> {
		core.reconcileFocusedGoalFromDisk(ctx);
		if (core.state.goal && core.state.goal.status !== "complete") return core.state.goal;
		const open = core.openGoals();
		if (open.length === 0) return null;
		if (open.length === 1) {
			const only = open[0];
			if (!only) return null;
			core.setFocusedGoalId(only.id, ctx, "selected");
			return core.state.goal;
		}
		if (!ctx.hasUI) {
			ctx.ui.notify(buildUnfocusedOpenGoalsSummary(open.length), "warning");
			return null;
		}
		const labels = open.map((item) => goalSelectorLabel(item, core.focusedGoalId));
		const byLabel = new Map(labels.map((label, index) => [label, open[index]?.id]));
		core.enterGoalModal();
		try {
			const selected = await ctx.ui.select(title, labels);
			const selectedId = selected ? byLabel.get(selected) : undefined;
			if (!selectedId) {
				ctx.ui.notify("Goal focus unchanged.", "info");
				return null;
			}
			core.setFocusedGoalId(selectedId, ctx, "selected");
			return core.state.goal;
		} finally {
			core.exitGoalModal();
		}
	}

	async function focusGoalCommand(ctx: ExtensionContext): Promise<void> {
		const open = core.openGoals();
		if (open.length === 0) {
			ctx.ui.notify("No open goals. Use /goal to draft one, or /goal-direct <objective> to start immediately.", "warning");
			return;
		}
		if (open.length === 1) {
			const only = open[0];
			if (!only) return;
			core.setFocusedGoalId(only.id, ctx, "selected");
			core.armFocusedContinuation(ctx);
			ctx.ui.notify(`Focused goal: ${oneLineSummary(only)}`, "info");
			return;
		}
		if (!ctx.hasUI) {
			ctx.ui.notify(buildGoalListText(core.goalsById, core.focusedGoalId), "info");
			return;
		}
		const labels = open.map((item) => goalSelectorLabel(item, core.focusedGoalId));
		const byLabel = new Map(labels.map((label, index) => [label, open[index]?.id]));
		core.enterGoalModal();
		try {
			const selected = await ctx.ui.select("Focus open goal", labels);
			const selectedId = selected ? byLabel.get(selected) : undefined;
			if (!selectedId) {
				ctx.ui.notify("Goal focus unchanged.", "info");
				return;
			}
			core.setFocusedGoalId(selectedId, ctx, "selected");
			core.armFocusedContinuation(ctx);
		} finally {
			core.exitGoalModal();
		}
		ctx.ui.notify(`Focused goal: ${oneLineSummary(core.state.goal)}`, "info");
	}

	function unfocusGoalCommand(ctx: ExtensionContext): void {
		const runtimeGoalId = core.state.goal?.id ?? core.runningGoalId ?? core.runtime.getCheckpointGoalId();
		core.reconcileFocusedGoalFromDisk(ctx);
		const current = core.state.goal;
		const detachedGoalId = current?.id ?? runtimeGoalId;
		let wasBusy = false;
		try {
			wasBusy = !ctx.isIdle();
		} catch {}
		if (detachedGoalId && wasBusy) core.runtime.markTurnStopped(detachedGoalId);
		core.setFocusedGoalId(null, ctx, "unfocused", { recordLedger: false });
		core.runningGoalId = null;
		core.runtime.setCheckpoint(null);
		core.runtime.clearPostCompactReminder();
		if (core.auditAbortController) core.auditAbortController.abort();
		if (detachedGoalId && wasBusy) {
			try {
				ctx.abort?.();
			} catch {}
		}
		if (!current) {
			const openCount = core.openGoals().length;
			ctx.ui.notify(openCount > 0 ? buildUnfocusedOpenGoalsSummary(openCount) : detailedSummary(null), "info");
			return;
		}
		ctx.ui.notify(`Goal unfocused for this session. It remains open in .pi/goals: ${current.id}`, "info");
	}

	function handleDirectGoalSet(rawObjective: string, ctx: ExtensionContext, mode: GoalMode): void {
		const raw = rawObjective.trim();
		if (!raw) {
			const command = mode === "sisyphus" ? "/sisyphus <objective>" : "/goal <objective>";
			ctx.ui.notify(`No objective provided. Use ${command}.`, "warning");
			return;
		}
		if (mode === "sisyphus" && !sisyphusObjectiveSufficient(raw)) {
			ctx.ui.notify("A Sisyphus objective needs ordered steps with per-step done criteria. Use /sisyphus for guided drafting, or provide numbered steps (1) ..., 2) ...) in the objective.", "warning");
			return;
		}
		const settings = loadGoalSettings(ctx.cwd);
		const { objective, verificationContract } = settings.disableContracts ? { objective: raw, verificationContract: undefined } : extractVerificationContract(raw);
		clearGoalDrafting(core, ctx);
		core.clearContinuationState();
		core.clearActiveAccounting();
		core.replaceGoal({ objective, autoContinue: true, sisyphus: mode === "sisyphus" }, ctx, true, verificationContract);
	}

	async function showGoalStatus(rawArgs: string, ctx: ExtensionContext): Promise<void> {
		core.reconcileFocusedGoalFromDisk(ctx);
		if (core.state.goal) core.syncGoalPromptFromDisk(ctx);
		const view = core.goalForDisplay() ?? core.state.goal;
		const otherCount = otherOpenGoalCount(core.goalsById, core.focusedGoalId);
		const verbose = /^\s*verbose\b/i.test(rawArgs);
		const text = buildGoalStatusText({
			goal: view,
			focused: view !== null && core.focusedGoalId === view.id,
			otherOpenGoals: otherCount,
			ledgerEvents: readGoalLedger(ctx).events,
			verbose,
			// §13.2: effective settings with provenance appear only in verbose mode;
			// the standard mode stays free of settings noise (§13.1).
			settingsReport: verbose ? effectiveSettingsReport(ctx.cwd) : [],
		});
		ctx.ui.notify(text, "info");
		core.updateUI(ctx);
	}

	async function handleGoalPause(ctx: ExtensionContext): Promise<void> {
		core.reconcileFocusedGoalFromDisk(ctx);
		if (!core.state.goal) {
			if (core.openGoals().length > 0) {
				const selected = await chooseOpenGoal(ctx, "Pause which open goal?");
				if (!selected) return;
			} else {
				ctx.ui.notify("No goal is set.", "warning");
				return;
			}
		}
		const currentGoal = core.state.goal;
		if (!currentGoal) return;
		if (currentGoal.status === "complete") {
			ctx.ui.notify("Goal is complete.", "warning");
			return;
		}
		if (currentGoal.status === "paused") {
			ctx.ui.notify("Goal is already paused. Use /goal-resume to continue.", "info");
			return;
		}
		core.pauseActiveGoal(ctx);
	}

	async function handleGoalResume(ctx: ExtensionContext): Promise<void> {
		core.reconcileFocusedGoalFromDisk(ctx);
		if (!core.state.goal && core.openGoals().length > 0) {
			const selected = await chooseOpenGoal(ctx, "Resume or focus open goal");
			if (!selected) return;
			if (selected.status === "active") {
				core.armFocusedContinuation(ctx);
				ctx.ui.notify(`Goal focused: ${oneLineSummary(selected)}`, "info");
				return;
			}
		}
		const resumeGate = validateResumeGoal(core.state.goal);
		if (!resumeGate.ok) {
			const level = resumeGate.message.includes("already running") ? "info" : "warning";
			ctx.ui.notify(resumeGate.message, level);
			return;
		}
		if (!core.state.goal) throw new Error("Goal disappeared during resume validation.");
		core.setGoal(
			{
				...mergeGoalPromptFromDisk(ctx, core.state.goal),
				status: "active",
				autoContinue: true,
				stopReason: undefined,
				pauseReason: undefined,
				pauseSuggestedAction: undefined,
			},
			ctx,
		);
		core.beginAccounting();
		ctx.ui.notify("Goal resumed.", "info");
		core.queueContinuation(ctx, true);
		// Append ledger event for resumption
		try {
			core.goalService.appendEvents(ctx, [{
				type: "goal_resumed",
				goalId: core.state.goal.id,
				reason: "user",
				at: nowIso(),
			}]);
		} catch {
			// Ledger append failure should not crash resume
		}
	}

	/**
	 * One declarative row table for the settings menu (follow-up Stage 1).
	 * Rendering and dispatch both derive from SETTING_ROWS so the displayed
	 * fields and the selectable fields can never drift apart. Rows are grouped
	 * into sections (Goal behavior / Task tracking / Completion auditor). All
	 * eight persisted fields are present and operable.
	 */
	type SettingRow = {
		key: keyof GoalSettings;
		label: string;
		section: "Goal behavior" | "Task tracking" | "Completion auditor";
		kind: "boolean" | "modelSelector" | "thinking" | "positiveInteger";
	};

	const SETTING_ROWS: readonly SettingRow[] = [
		{ key: "autoSelectSingleGoal", label: "autoSelectSingleGoal", section: "Goal behavior", kind: "boolean" },
		{ key: "disableContracts", label: "disableContracts", section: "Goal behavior", kind: "boolean" },
		{ key: "stallTimeoutMinutes", label: "stall timeout (minutes)", section: "Goal behavior", kind: "positiveInteger" },
		{ key: "objectiveMaxChars", label: "max objective length (0 = none)", section: "Goal behavior", kind: "positiveInteger" },
		{ key: "disableTasks", label: "disableTasks", section: "Task tracking", kind: "boolean" },
		{ key: "subtaskDepth", label: "subtaskDepth", section: "Task tracking", kind: "positiveInteger" },
		{ key: "disabled", label: "auditor disabled", section: "Completion auditor", kind: "boolean" },
		{ key: "provider", label: "provider", section: "Completion auditor", kind: "modelSelector" },
		{ key: "model", label: "model", section: "Completion auditor", kind: "modelSelector" },
		{ key: "thinkingLevel", label: "thinking_level", section: "Completion auditor", kind: "thinking" },
	];

	function settingsValue(config: GoalSettings, key: keyof GoalSettings): string {
		if (key === "disabled" || key === "disableTasks" || key === "disableContracts" || key === "autoSelectSingleGoal" || key === "auditorProjectResources") {
			return config[key] === true ? "true" : "false";
		}
		if (key === "subtaskDepth") return config.subtaskDepth !== undefined ? String(config.subtaskDepth) : "1";
		if (key === "stallTimeoutMinutes") return config.stallTimeoutMinutes !== undefined ? String(config.stallTimeoutMinutes) : "0";
		if (key === "objectiveMaxChars") return config.objectiveMaxChars !== undefined ? String(config.objectiveMaxChars) : "0";
		if (key === "keybindings") return config.keybindings ? `${config.keybindings.dashboard.toggleExpand}, ${config.keybindings.dashboard.scrollUp}, ${config.keybindings.dashboard.scrollDown}` : "(default)";
		const value = config[key];
		return typeof value === "string" ? value : "(default)";
	}

	function settingsLines(config: GoalSettings): string[] {
		return SETTING_ROWS.map((row) => `${row.label}: ${settingsValue(config, row.key)}`);
	}

	async function handleSettingsMenu(ctx: ExtensionContext): Promise<void> {
		if (!ctx.hasUI) {
			ctx.ui.notify(`Settings file: ${goalSettingsPath(ctx.cwd)}`, "info");
			return;
		}
		/**
		 * Persist a settings edit, then reinstall the fixed three/five profile
		 * when the effective disableTasks value changed since the last install.
		 * core.tasksEnabled tracks the last profile actually installed (updated
		 * by installGoalToolProfile), so toggling task availability off, on, and
		 * off within one menu session reinstalls on every real change instead of
		 * comparing against the value captured when the menu opened.
		 */
		const saveSettings = (next: GoalSettings): void => {
			saveGoalSettingsFileConfig(ctx.cwd, next);
			const tasksEnabledNow = !loadGoalSettings(ctx.cwd).disableTasks;
			if (tasksEnabledNow !== core.tasksEnabled) {
				core.installGoalToolProfile(tasksEnabledNow);
			}
		};
		core.enterGoalModal();
		try {
			while (true) {
				const config = loadGoalSettingsFileConfig(ctx.cwd);
				const options: string[] = [];
				let lastSection: string | null = null;
				for (const row of SETTING_ROWS) {
					if (row.section !== lastSection) {
						options.push(`─── ${row.section} ───`);
						lastSection = row.section;
					}
					const envVar = envOverrideFor(row.key);
					options.push(envVar ? `  ${row.label}: ${settingsValue(config, row.key)} (env: ${envVar} — read-only)` : `  ${row.label}: ${settingsValue(config, row.key)}`);
				}
				options.push("Done");
				const selected = await ctx.ui.select("Goal settings", options);
				if (!selected || selected === "Done") break;
				if (selected.startsWith("───")) continue; // section headers are not rows
				// Strip leading spaces and resolve the row from the display label.
				const selectedTrimmed = selected.trim();
				const colon = selectedTrimmed.indexOf(":");
				if (colon === -1) continue;
			const label = selectedTrimmed.slice(0, colon).trim();
			const row = SETTING_ROWS.find((r) => r.label === label);
			if (!row) continue;
			const key = row.key;
			if (envOverrideFor(key)) {
				ctx.ui.notify(`${row.label} is read-only: overridden by the ${envOverrideFor(key)} env var.`, "warning");
				continue;
			}
			if (row.kind === "boolean") {
				const next = { ...config, [key]: config[key] !== true };
				saveSettings(next);
				ctx.ui.notify(`Settings saved:\n${settingsLines(loadGoalSettingsFileConfig(ctx.cwd)).join("\n")}`, "info");
				continue;
			}
			if (row.kind === "positiveInteger") {
				const input = await ctx.ui.input(`Set ${row.label}`, settingsValue(config, key));
				if (input === undefined) continue;
				// Row-driven lower bound: subtaskDepth is a nesting depth (min 1);
				// stallTimeoutMinutes and objectiveMaxChars default to 0 meaning
				// "off / no limit".
				const min = (row.key === "stallTimeoutMinutes" || row.key === "objectiveMaxChars") ? 0 : 1;
				// Full-string decimal validation: no partial parseInt. Rejects
				// 1.5, 1x, negatives, infinity, and unsafe integers alike.
				const trimmed = input.trim();
				if (!/^[0-9]+$/.test(trimmed) || !Number.isSafeInteger(Number(trimmed)) || Number(trimmed) < min) {
					ctx.ui.notify(`${row.label} must be an integer >= ${min} (e.g. ${min}, ${min + 1}, ${min + 2})`, "warning");
					continue;
				}
				const next = { ...config, [key]: Number(trimmed) };
				saveSettings(next);
				ctx.ui.notify(`Settings saved:\n${settingsLines(loadGoalSettingsFileConfig(ctx.cwd)).join("\n")}`, "info");
				continue;
			}
			if (row.kind === "thinking") {
				const currentValue = settingsValue(config, key);
				const levels = thinkingLevelChoices(currentValue === "(default)" ? undefined : currentValue);
				const picked = await ctx.ui.select(`Set ${row.label}`, levels);
				if (!picked) continue;
				const trimmed = picked.trim().replace(/^\u2713\s+/, "");
				const next: GoalSettings = { ...config };
				if (trimmed === "(default)") {
					delete next.thinkingLevel;
				} else if ((AUDITOR_THINKING_LEVELS as readonly string[]).includes(trimmed)) {
					next.thinkingLevel = trimmed as GoalSettings["thinkingLevel"];
				} else {
					ctx.ui.notify(`thinking_level must be one of: ${AUDITOR_THINKING_LEVELS.join(", ")} (or "(default)")`, "warning");
					continue;
				}
				saveSettings(next);
				ctx.ui.notify(`Settings saved:\n${settingsLines(loadGoalSettingsFileConfig(ctx.cwd)).join("\n")}`, "info");
				continue;
			}
			// modelSelector rows (provider, model): searchable auditor model
			// picker with current-session/default, authenticated models (\u2713
			// marker on the exact current selection), and a manual
			// provider/model entry (ll01 pattern). Either row applies the same
			// provider+model pair.
			const configured = configuredAuditorModelKey(config);
			const session = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
			const choices = buildAuditorModelChoices(ctx.modelRegistry.getAvailable(), configured, session);
			const filter = await ctx.ui.input("Filter auditor models (provider/id/name; blank = all)", "");
			if (filter === undefined) continue;
			const filtered = filterAuditorModelChoices(choices, filter);
			const picked = await ctx.ui.select("Select auditor model", filtered.map((choice) => choice.label));
			if (!picked) continue;
			const choice = filtered.find((candidate: AuditorChoice) => candidate.label === picked);
			if (!choice) continue;
			const next: GoalSettings = { ...config };
			if (choice.kind === "default") {
				delete next.provider;
				delete next.model;
			} else if (choice.kind === "manual") {
				const input = await ctx.ui.input("Set auditor provider/model", configured ?? "provider/model");
				if (input === undefined) continue;
				const parsed = parseManualAuditorModel(input);
				if ("error" in parsed) {
					ctx.ui.notify(parsed.error, "warning");
					continue;
				}
				next.provider = parsed.provider;
				next.model = parsed.model;
			} else {
				next.provider = choice.provider;
				next.model = choice.model;
			}
			saveSettings(next);
			ctx.ui.notify(`Settings saved:\n${settingsLines(loadGoalSettingsFileConfig(ctx.cwd)).join("\n")}`, "info");
			}
		} finally {
			core.exitGoalModal();
		}
	}

	async function handleGoalClear(ctx: ExtensionContext): Promise<void> {
		core.reconcileFocusedGoalFromDisk(ctx);
		if (!core.state.goal && core.openGoals().length > 0) {
			const selected = await chooseOpenGoal(ctx, "Clear which open goal?");
			if (!selected) return;
		}
		if (!core.state.goal) {
			ctx.ui.notify(clearGoalCommandMessage({ archived: false }), "warning");
			return;
		}
		// Snapshot the selected goal id and focus revision before asking.
		const target = core.state.goal;
		const focusToken = core.focusedOperationToken(target.id);
		// Headless behavior is explicit: guidance without mutation. Clearing
		// requires an interactive confirmation (follow-up Stage 2).
		if (!ctx.hasUI) {
			ctx.ui.notify(`Run /goal-clear in an interactive session to confirm clearing: ${oneLineSummary(target)}`, "warning");
			return;
		}
		const confirmed = await ctx.ui.confirm("Clear goal?", oneLineSummary(target));
		if (!confirmed) {
			ctx.ui.notify("Goal clear cancelled.", "info");
			return;
		}
		// Reconcile and validate the same focus token after confirmation, then
		// archive. Cancellation above changes no file, focus entry, ledger
		// entry, or runtime state.
		core.reconcileFocusedGoalFromDisk(ctx);
		if (!core.isFocusedOperationCurrent(focusToken) || !core.state.goal || core.state.goal.id !== target.id) {
			ctx.ui.notify("Goal changed while confirming; nothing was cleared.", "warning");
			return;
		}
		const archived = core.archiveCurrentGoal(ctx, "user");
		const didArchive = !!archived;
		core.setGoal(null, ctx, true, "cleared");
		const msg = clearGoalCommandMessage({ archived: didArchive });
		ctx.ui.notify(msg, didArchive ? "info" : "warning");
	}

	async function runGoalTweak(replacement: string, ctx: ExtensionContext): Promise<void> {
		core.reconcileFocusedGoalFromDisk(ctx);
		if (!core.state.goal) {
			if (core.openGoals().length > 0) {
				const selected = await chooseOpenGoal(ctx, "Tweak which open goal?");
				if (!selected) return;
			} else {
				ctx.ui.notify("No goal is set. Use /goal to draft one, or /goal-direct <objective> to create one immediately.", "warning");
				return;
			}
		}
		const currentGoal = core.state.goal;
		if (!currentGoal) return;
		if (currentGoal.status === "complete") {
			ctx.ui.notify("Goal is complete. Use /goal to draft a new one, or /goal-direct <objective> to create one immediately.", "warning");
			return;
		}
		const trimmed = replacement.trim();
		if (!trimmed) {
			ctx.ui.notify("Provide the replacement objective: /goal-tweak <new objective>", "info");
			return;
		}
		if (trimmed.length > (loadGoalSettings(ctx.cwd).objectiveMaxChars ?? 0)) {
			const max = loadGoalSettings(ctx.cwd).objectiveMaxChars;
			if (max !== undefined && max > 0) {
				ctx.ui.notify(`Replacement objective exceeds ${max} characters (${trimmed.length}).`, "warning");
				return;
			}
		}
		await startGoalDrafting(core, ctx, "tweak", trimmed, currentGoal);
	}

	// /goal and /sisyphus are the guided default. -direct commands are the explicit bypass.
	pi.registerCommand("goal", {
		description: "Draft a regular goal with clarification, task planning, and confirmation.",
		handler: async (rawArgs, ctx) => {
			await startGoalDrafting(core, ctx, "goal", rawArgs);
		},
	});
	pi.registerCommand("sisyphus", {
		description: "Draft a Sisyphus goal with clarification, task planning, and confirmation.",
		handler: async (rawArgs, ctx) => {
			await startGoalDrafting(core, ctx, "sisyphus", rawArgs);
		},
	});
	pi.registerCommand("goal-cancel", {
		description: "Cancel the in-progress guided draft without creating or modifying a goal.",
		handler: async (_rawArgs, ctx) => {
			if (!hasActiveDraft(core)) {
				ctx.ui.notify("No active draft to cancel.", "info");
				return;
			}
			clearGoalDrafting(core, ctx);
			core.clearContinuationState();
			ctx.ui.notify("Draft cancelled; no goal was created. The execution profile is restored.", "info");
		},
	});
	pi.registerCommand("goal-direct", {
		description: "Create and start a regular goal immediately, without drafting.",
		handler: async (rawArgs, ctx) => { handleDirectGoalSet(rawArgs, ctx, "goal"); },
	});
	pi.registerCommand("sisyphus-direct", {
		description: "Create and start a Sisyphus goal immediately, without drafting.",
		handler: async (rawArgs, ctx) => { handleDirectGoalSet(rawArgs, ctx, "sisyphus"); },
	});
	pi.registerCommand("goal-list", {
		description: "List all open goals and the current focus.",
		handler: async (_rawArgs, ctx) => {
			core.reconcileFocusedGoalFromDisk(ctx);
			ctx.ui.notify(buildGoalListText(core.goalsById, core.focusedGoalId), "info");
			core.updateUI(ctx);
		},
	});
	pi.registerCommand("goal-status", {
		description: "Show the unified goal dashboard for the focused goal (read-only). Append \"verbose\" for full diagnostic detail (goal id, revision, objective, task tree with evidence and contracts, ledger history, budget, pause/blocker, paths, audit report, effective settings).",
		handler: async (rawArgs, ctx) => {
			await showGoalStatus(rawArgs ?? "", ctx);
		},
	});
	pi.registerCommand("goal-focus", {
		description: "Choose which open goal this session focuses on.",
		handler: async (_rawArgs, ctx) => {
			await focusGoalCommand(ctx);
		},
	});
	pi.registerCommand("goal-unfocus", {
		description: "Stop focusing the current goal (session only; goal stays open).",
		handler: async (_rawArgs, ctx) => {
			unfocusGoalCommand(ctx);
		},
	});
	pi.registerCommand("goal-settings", {
		description: "Open pi-goal settings (auditor provider/model/thinking level).",
		handler: async (_rawArgs, ctx) => {
			await handleSettingsMenu(ctx);
		},
	});
	pi.registerCommand("goal-tweak", {
		description: "Refine the current goal's objective with the user.",
		handler: async (rawArgs, ctx) => {
			await runGoalTweak(rawArgs, ctx);
		},
	});
	pi.registerCommand("goal-clear", {
		description: "Archive the current goal after confirmation (user-owned abandonment).",
		handler: async (_rawArgs, ctx) => {
			await handleGoalClear(ctx);
		},
	});
	pi.registerCommand("goal-pause", {
		description: "Pause the currently running goal. Esc also pauses while running.",
		handler: async (_rawArgs, ctx) => {
			await handleGoalPause(ctx);
		},
	});
	pi.registerCommand("goal-resume", {
		description: "Resume a paused or blocked goal.",
		handler: async (_rawArgs, ctx) => {
			await handleGoalResume(ctx);
		},
	});
}
