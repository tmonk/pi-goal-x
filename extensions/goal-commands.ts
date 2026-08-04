import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { extractVerificationContract } from "./goal-contract.ts";
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
import { mergeGoalPromptFromDisk } from "./storage/goal-files.ts";
import { nowIso, type DraftingFocus, type GoalRecord } from "./goal-record.ts";
import type { GoalCore } from "./goal-state.ts";

/**
 * The curated ten-command palette (Stage 5). /goal and /sisyphus are the two
 * direct creation paths; every frequent lifecycle action is independently
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
		const selected = await ctx.ui.select(title, labels);
		const selectedId = selected ? byLabel.get(selected) : undefined;
		if (!selectedId) {
			ctx.ui.notify("Goal focus unchanged.", "info");
			return null;
		}
		core.setFocusedGoalId(selectedId, ctx, "selected");
		return core.state.goal;
	}

	async function focusGoalCommand(ctx: ExtensionContext): Promise<void> {
		const open = core.openGoals();
		if (open.length === 0) {
			ctx.ui.notify("No open goals. Use /goal <objective> or /sisyphus <objective> to start immediately.", "warning");
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
		const selected = await ctx.ui.select("Focus open goal", labels);
		const selectedId = selected ? byLabel.get(selected) : undefined;
		if (!selectedId) {
			ctx.ui.notify("Goal focus unchanged.", "info");
			return;
		}
		core.setFocusedGoalId(selectedId, ctx, "selected");
		core.armFocusedContinuation(ctx);
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

	function handleDirectGoalSet(rawObjective: string, ctx: ExtensionContext, focus: DraftingFocus): void {
		const raw = rawObjective.trim();
		if (!raw) {
			const command = focus === "sisyphus" ? "/sisyphus <objective>" : "/goal <objective>";
			ctx.ui.notify(`No objective provided. Use ${command}.`, "warning");
			return;
		}
		const { objective, verificationContract } = extractVerificationContract(raw);
		core.clearContinuationState();
		core.clearActiveAccounting();
		core.replaceGoal({ objective, autoContinue: true, sisyphus: focus === "sisyphus" }, ctx, true, verificationContract);
	}

	async function showGoalStatus(ctx: ExtensionContext): Promise<void> {
		core.reconcileFocusedGoalFromDisk(ctx);
		if (core.state.goal) core.syncGoalPromptFromDisk(ctx);
		const view = core.goalForDisplay() ?? core.state.goal;
		const otherCount = otherOpenGoalCount(core.goalsById, core.focusedGoalId);
		const extra = view && otherCount > 0 ? `\nOther open goals: ${otherCount} (run /goal-list or /goal-focus)` : "";
		const text = view ? `${detailedSummary(view)}${extra}` : core.openGoals().length > 0 ? buildUnfocusedOpenGoalsSummary(core.openGoals().length) : detailedSummary(null);
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

	function settingsValue(config: GoalSettings, key: keyof GoalSettings): string {
		if (key === "disabled") return config.disabled === true ? "true" : "false";
		if (key === "disableTasks") return config.disableTasks === true ? "true" : "false";
		if (key === "disableContracts") return config.disableContracts === true ? "true" : "false";
		if (key === "autoSelectSingleGoal") return config.autoSelectSingleGoal === true ? "true" : "false";
		if (key === "subtaskDepth") return config.subtaskDepth !== undefined ? String(config.subtaskDepth) : "1";
		return config[key] ?? "(default)";
	}

	function settingsLines(config: GoalSettings): string[] {
		return [
			`disabled: ${settingsValue(config, "disabled")}`,
			`provider: ${settingsValue(config, "provider")}`,
			`model: ${settingsValue(config, "model")}`,
			`thinking_level: ${settingsValue(config, "thinkingLevel")}`,
			`disableTasks: ${settingsValue(config, "disableTasks")}`,
			`disableContracts: ${settingsValue(config, "disableContracts")}`,
			`subtaskDepth: ${settingsValue(config, "subtaskDepth")}`,
		];
	}

	async function handleSettingsMenu(ctx: ExtensionContext): Promise<void> {
		if (!ctx.hasUI) {
			ctx.ui.notify(`Settings file: ${goalSettingsPath(ctx.cwd)}`, "info");
			return;
		}
		const editorKeys = ["disabled", "provider", "model", "thinking_level", "subtaskDepth", "autoSelectSingleGoal"] as const;
		// Fixed-profile hook: if a settings change toggles disableTasks, the
		// three/five goal-tool profile is reinstalled exactly once. Lifecycle
		// transitions never touch the profile.
		const tasksEnabledAtMenuStart = !loadGoalSettings(ctx.cwd).disableTasks;
		const saveSettings = (next: GoalSettings): void => {
			saveGoalSettingsFileConfig(ctx.cwd, next);
			const tasksEnabledNow = !loadGoalSettings(ctx.cwd).disableTasks;
			if (tasksEnabledNow !== tasksEnabledAtMenuStart) {
				core.installGoalToolProfile(tasksEnabledNow);
			}
		};
		while (true) {
			const config = loadGoalSettingsFileConfig(ctx.cwd);
			const options = settingsLines(config).map((line) => `  ${line}`);
			options.unshift("─── Settings ───");
			options.push("Done");
			const selected = await ctx.ui.select("Goal settings", options);
			if (!selected || selected === "Done" || selected === "─── Settings ───") return;
			// Strip leading spaces from selection
			const selectedTrimmed = selected.trim();
			const colon = selectedTrimmed.indexOf(":");
			if (colon === -1) continue;
			const field = selectedTrimmed.slice(0, colon).trim();
			const editorKey = field === "thinking_level" ? "thinkingLevel" : field;
			if (!(editorKeys as readonly string[]).includes(editorKey)) continue;
			const key = editorKey as keyof GoalSettings;
			if (key === "disabled") {
				const next = { ...config, disabled: !config.disabled };
				saveSettings(next);
				ctx.ui.notify(`Settings saved:\n${settingsLines(loadGoalSettingsFileConfig(ctx.cwd)).join("\n")}`, "info");
				continue;
			}
			if (key === "autoSelectSingleGoal") {
				const next = { ...config, autoSelectSingleGoal: config.autoSelectSingleGoal !== true };
				saveSettings(next);
				ctx.ui.notify(`Settings saved:\n${settingsLines(loadGoalSettingsFileConfig(ctx.cwd)).join("\n")}`, "info");
				continue;
			}
			if (key === "subtaskDepth") {
				const input = await ctx.ui.input("Set subtaskDepth", String(config.subtaskDepth ?? 1));
				if (input === undefined) continue;
				const n = parseInt(input.trim(), 10);
				if (isNaN(n) || n < 1) {
					ctx.ui.notify("subtaskDepth must be a positive integer", "warning");
					continue;
				}
				const next = { ...config, subtaskDepth: n };
				saveSettings(next);
				ctx.ui.notify(`Settings saved:\n${settingsLines(loadGoalSettingsFileConfig(ctx.cwd)).join("\n")}`, "info");
				continue;
			}
			const currentValue = settingsValue(config, key);
			const input = await ctx.ui.input(`Set ${field}`, currentValue === "(default)" ? "Leave empty for default" : currentValue);
			if (input === undefined) continue;
			const next: GoalSettings = { ...config };
			const inputTrimmed = input.trim();
			if (!inputTrimmed) {
				delete next[key];
			} else if (key === "thinkingLevel") {
				if (!["off", "minimal", "low", "medium", "high", "xhigh"].includes(inputTrimmed)) {
					ctx.ui.notify("thinking_level must be one of: off, minimal, low, medium, high, xhigh", "warning");
					continue;
				}
				next.thinkingLevel = inputTrimmed as GoalSettings["thinkingLevel"];
			} else if (key === "provider" || key === "model") {
				next[key] = inputTrimmed;
			}
			saveSettings(next);
			ctx.ui.notify(`Settings saved:\n${settingsLines(loadGoalSettingsFileConfig(ctx.cwd)).join("\n")}`, "info");
		}
	}

	async function handleGoalClear(ctx: ExtensionContext): Promise<void> {
		core.reconcileFocusedGoalFromDisk(ctx);
		if (!core.state.goal && core.openGoals().length > 0) {
			const selected = await chooseOpenGoal(ctx, "Clear which open goal?");
			if (!selected) return;
		}
		const archived = core.archiveCurrentGoal(ctx, "user");
		const didArchive = !!archived;
		core.setGoal(null, ctx, true, "cleared");
		const msg = clearGoalCommandMessage({ archived: didArchive, wasDrafting: false });
		ctx.ui.notify(msg, didArchive ? "info" : "warning");
	}

	async function startGoalTweakDrafting(replacement: string, ctx: ExtensionContext): Promise<void> {
		core.reconcileFocusedGoalFromDisk(ctx);
		if (!core.state.goal) {
			if (core.openGoals().length > 0) {
				const selected = await chooseOpenGoal(ctx, "Tweak which open goal?");
				if (!selected) return;
			} else {
				ctx.ui.notify("No goal is set. Use /goal <objective> or /sisyphus <objective> to create one.", "warning");
				return;
			}
		}
		const currentGoal = core.state.goal;
		if (!currentGoal) return;
		if (currentGoal.status === "complete") {
			ctx.ui.notify("Goal is complete. Use /goal <objective> to create a new one.", "warning");
			return;
		}
		const trimmed = replacement.trim();
		if (!trimmed) {
			ctx.ui.notify("Provide the replacement objective: /goal-tweak <new objective>", "info");
			return;
		}
		if (trimmed.length > 4000) {
			ctx.ui.notify(`Replacement objective exceeds 4000 characters (${trimmed.length}).`, "warning");
			return;
		}
		// User-owned tweak (Stage 6): apply the replacement directly through the
		// service — preserve usage/tasks/mode/budget, reactivate budget-limited
		// goals, clear any agent pause reason, and record the tweak ledger event.
		core.syncGoalPromptFromDisk(ctx);
		const current = core.state.goal;
		if (!current) return;
		const { objective: cleanedObjective, verificationContract } = extractVerificationContract(trimmed);
		const now = nowIso();
		const result = core.goalService.apply(ctx, {
			reconcile: false,
			mutate: (g) => {
				const reactivate = g.status === "budget_limited";
				return {
					...g,
					objective: cleanedObjective,
					verificationContract: verificationContract ?? g.verificationContract,
					updatedAt: now,
					pauseReason: undefined,
					pauseSuggestedAction: undefined,
					status: reactivate ? "active" : g.status,
					autoContinue: reactivate ? true : g.autoContinue,
				} as GoalRecord;
			},
			ledger: (written) => [{
				type: "goal_tweaked",
				goalId: written.id,
				changeSummary: "Objective updated by the user via /goal-tweak.",
				at: written.updatedAt,
			}],
		});
		if (!result.ok) {
			ctx.ui.notify(`Goal tweak failed: ${result.message}`, "error");
			return;
		}
		core.runtime.markTurnStopped(result.goal.id);
		core.clearContinuationState();
		core.updateUI(ctx);
		ctx.ui.notify("Goal objective updated.", "info");
	}

	// /goal: status when empty, direct creation otherwise. /sisyphus: direct creation.
	pi.registerCommand("goal", {
		description: "Create a regular goal from the objective, or show status when empty.",
		handler: async (rawArgs, ctx) => {
			if (rawArgs.trim()) {
				handleDirectGoalSet(rawArgs, ctx, "goal");
				return;
			}
			await showGoalStatus(ctx);
		},
	});
	pi.registerCommand("sisyphus", {
		description: "Create a Sisyphus goal (strict ordered steps) from the objective.",
		handler: async (rawArgs, ctx) => {
			if (rawArgs.trim()) {
				handleDirectGoalSet(rawArgs, ctx, "sisyphus");
				return;
			}
			ctx.ui.notify("Provide an objective: /sisyphus <ordered-steps objective>", "info");
		},
	});
	pi.registerCommand("goal-list", {
		description: "List all open goals and the current focus.",
		handler: async (_rawArgs, ctx) => {
			core.reconcileFocusedGoalFromDisk(ctx);
			ctx.ui.notify(buildGoalListText(core.goalsById, core.focusedGoalId), "info");
			core.updateUI(ctx);
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
			await startGoalTweakDrafting(rawArgs, ctx);
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
