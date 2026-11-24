import { GOAL_COMMANDS, commandHint, commandPaths, commandProblems, commandRoutes, matchCommandRoute, type GoalCommandId } from "./goal-controls.ts";
import { showGoalControls } from "./widgets/goal-controls-dialog.ts";
import { goalStoragePath, goalStorageRoot } from "./storage/goal-root.ts";
import { existsSync } from "node:fs";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { extractVerificationContract, sisyphusObjectiveSufficient } from "./goal-contract.ts";
import { detailedSummary, oneLineSummary } from "./goal-format.ts";
import { type GoalSettings, type SettingsScope } from "./settings/schema.ts";
import { goalSettingsPath, goalGlobalSettingsPath } from "./settings/files.ts";
import { loadGoalSettings, loadSettingsSnapshot, envOverrideFor } from "./settings/resolve.ts";
import { mutateSettingsLayer, type SettingsMutation } from "./settings/mutate.ts";
import {
	buildGoalListText,
	buildUnfocusedOpenGoalsSummary,
	goalSelectorLabel,
	otherOpenGoalCount,
} from "./goal-pool.ts";
import { clearGoalCommandMessage } from "./goal-policy.ts";
import { invalidateGoalLedgerCache, readGoalLedger } from "./goal-ledger.ts";
import { buildGoalStatusText } from "./goal-status.ts";
import { invalidateGoalSettingsCache, loadGoalSettingsFileConfig } from "./settings/files.ts";
import { effectiveSettingsReport } from "./settings/resolve.ts";
import { invalidateGoalPoolCache, readActiveGoalPool } from "./storage/goal-files.ts";
import { nowIso, type GoalMode, type GoalRecord } from "./goal-record.ts";
import { clearGoalDrafting, hasActiveDraft, startGoalDrafting } from "./goal-drafting.ts";
import { formatRecoveryReport, runRecoveryReport, runRecoveryRepair } from "./goal-recovery.ts";
import { formatCheckpointHealthReport, readSessionCheckpointHealth } from "./goal-session-health.ts";

export interface GoalRefreshState {
	poolIds: Iterable<string>;
	ledgerEvents: number;
	ledgerMalformed: number;
	/** Stable fingerprint of the effective settings (JSON of the parsed file). */
	settings: string;
}

/**
 * Pure diff of a goal-refresh cycle (before invalidation vs after re-read).
 * Unit-testable without the command harness; the command renders the changes.
 */
export function diffGoalRefreshState(before: GoalRefreshState, after: GoalRefreshState): string[] {
	const changes: string[] = [];
	const beforeIds = new Set(before.poolIds);
	const afterIds = new Set(after.poolIds);
	const added = [...afterIds].filter((id) => !beforeIds.has(id)).sort();
	const removed = [...beforeIds].filter((id) => !afterIds.has(id)).sort();
	if (added.length > 0) changes.push(`pool: ${added.length} goal(s) added — ${added.join(", ")}`);
	if (removed.length > 0) changes.push(`pool: ${removed.length} goal(s) removed — ${removed.join(", ")}`);
	if (after.ledgerEvents !== before.ledgerEvents) {
		changes.push(`ledger: ${before.ledgerEvents} -> ${after.ledgerEvents} events`);
	}
	if (after.ledgerMalformed !== before.ledgerMalformed) {
		changes.push(`ledger: malformed entries ${before.ledgerMalformed} -> ${after.ledgerMalformed}`);
	}
	if (before.settings !== after.settings) {
		changes.push("settings: effective settings changed (external edit)");
	}
	return changes;
}
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

function sessionFileOf(ctx: ExtensionContext): string | undefined {
	return (ctx.sessionManager as { getSessionFile?: () => string | undefined } | undefined)?.getSessionFile?.();
}

/**
 * Stable command actions retain their lifecycle checks. Configured invocation
 * paths are registered at load time; aliases and subcommands share the same
 * handler and argument completion. /goal-settings remains the recovery entry.
 */
export function registerGoalCommands(core: GoalCore): void {
	const { pi } = core;
	type Definition = { description: string; handler: (args: string, ctx: ExtensionContext) => Promise<void> };
	const actions = new Map<GoalCommandId, Definition>();
	const define = (id: GoalCommandId, definition: Definition): void => { actions.set(id, definition); };

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
			ctx.ui.notify(`No open goals. Use ${commandHint("goal", core.loadedCommands)} to draft one, or ${commandHint("goal-direct", core.loadedCommands)} <objective> to start immediately.`, "warning");
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
		core.activeAudit?.cancel("Goal cleared during completion audit.");
		if (detachedGoalId && wasBusy) {
			try {
				ctx.abort?.();
			} catch {}
		}
		if (!current) {
			const openCount = otherOpenGoalCount(core.goalsById, null);
			ctx.ui.notify(openCount > 0 ? buildUnfocusedOpenGoalsSummary(openCount) : detailedSummary(null, core.loadedCommands), "info");
			return;
		}
		ctx.ui.notify(`Goal unfocused for this session. It remains open in .pi/goals: ${current.id}`, "info");
	}

	function handleDirectGoalSet(rawObjective: string, ctx: ExtensionContext, mode: GoalMode): void {
		const raw = rawObjective.trim();
		if (!raw) {
			const command = `${commandHint(mode === "sisyphus" ? "sisyphus-direct" : "goal-direct", core.loadedCommands)} <objective>`;
			ctx.ui.notify(`No objective provided. Use ${command}.`, "warning");
			return;
		}
		if (mode === "sisyphus" && !sisyphusObjectiveSufficient(raw)) {
			ctx.ui.notify(`A Sisyphus objective needs ordered steps with per-step done criteria. Use ${commandHint("sisyphus", core.loadedCommands)} for guided drafting, or provide numbered steps (1) ..., 2) ...) in the objective.`, "warning");
			return;
		}
		const settings = loadGoalSettings(ctx.cwd);
		const { objective, verificationContract } = settings.disableContracts ? { objective: raw, verificationContract: undefined } : extractVerificationContract(raw);
		clearGoalDrafting(core, ctx);
		core.clearContinuationState();
		core.clearActiveAccounting();
		core.replaceGoal({ objective, autoContinue: true, sisyphus: mode === "sisyphus" }, ctx, true, verificationContract);
	}

	async function runGoalRecovery(rawArgs: string, ctx: ExtensionContext): Promise<void> {
		const report = runRecoveryReport(ctx);
		if (/^repair$/i.test(rawArgs)) {
			const result = await runRecoveryRepair(ctx, report, async () => {
				const confirmed = await ctx.ui.confirm(`Remove ${report.staleLocks.length} stale lock(s) and refresh the pool snapshot?`, `Files are backed up to .pi/goals/.recovery-backup first.`);
				return confirmed === true;
			});
			if (result.confirmed) {
				ctx.ui.notify(result.applied.length > 0
					? `goal-recovery repair: ${result.applied.length} operation(s) applied.\n${result.applied.map((a) => `  - ${a}`).join("\n")}\nBackup: ${result.backupDir}`
					: "goal-recovery repair: nothing to repair.", "info");
			} else {
				ctx.ui.notify("goal-recovery repair: cancelled — nothing changed.", "info");
			}
			return;
		}
		// Issue #30: surface persisted-checkpoint health for this session file
		// (read-only). Legacy full checkpoints are repairable offline with the
		// shipped pi-goal-x-recover CLI; this command never writes.
		const sessionFile = sessionFileOf(ctx);
		const checkpointHealth = sessionFile ? readSessionCheckpointHealth(sessionFile) : null;
		const checkpointSection = checkpointHealth && checkpointHealth.total > 0
			? `\n\n${formatCheckpointHealthReport(checkpointHealth, sessionFile)}`
			: "";
		ctx.ui.notify(
			formatRecoveryReport(report, core.loadedCommands) + checkpointSection,
			report.healthy && (checkpointHealth?.legacyFull ?? 0) === 0 ? "info" : "warning",
		);
	}

	async function runGoalRefresh(ctx: ExtensionContext): Promise<void> {
		// Pre-state snapshots are cache-served (0 fs ops); the re-reads after
		// invalidation go cold. This is the explicit user-owned path for picking
		// up external edits — no watchers, no per-turn polling.
		const beforePool = readActiveGoalPool(ctx);
		const beforeLedger = readGoalLedger(ctx);
		// Settings: the before fingerprint is cache-served; the after one is a
		// cold re-read after invalidation — so an external settings edit shows
		// up as a fingerprint difference.
		const beforeSettings = settingsFingerprint(ctx);

		invalidateGoalPoolCache();
		invalidateGoalLedgerCache();
		invalidateGoalSettingsCache();

		const afterPool = readActiveGoalPool(ctx);
		const afterLedger = readGoalLedger(ctx);
		const afterSettings = settingsFingerprint(ctx);

		const changes = diffGoalRefreshState({
			poolIds: beforePool.keys(),
			ledgerEvents: beforeLedger.events.length,
			ledgerMalformed: beforeLedger.malformed,
			settings: beforeSettings,
		}, {
			poolIds: afterPool.keys(),
			ledgerEvents: afterLedger.events.length,
			ledgerMalformed: afterLedger.malformed,
			settings: afterSettings,
		});

		const text = changes.length > 0
			? `goal-refresh: re-read caches from disk — ${changes.length} change(s):\n${changes.map((c) => `  - ${c}`).join("\n")}`
			: "goal-refresh: no changes detected — caches were already current.";
		ctx.ui.notify(text, "info");
		core.scheduler.refreshSettings(ctx);
		core.updateUI(ctx);
	}

	/** Stable fingerprint of the effective settings (cache-served before invalidation). */
	function settingsFingerprint(ctx: ExtensionContext): string {
		return JSON.stringify(loadGoalSettingsFileConfig(ctx.cwd));
	}

	async function showGoalStatus(rawArgs: string, ctx: ExtensionContext): Promise<void> {
		core.reconcileFocusedGoalFromDisk(ctx);
		if (core.state.goal) core.syncGoalPromptFromDisk(ctx);
		const view = core.goalForDisplay() ?? core.state.goal;
		const otherCount = otherOpenGoalCount(core.goalsById, core.focusedGoalId);
		const verbose = /^\s*verbose\b/i.test(rawArgs);
		const health = /^\s*health\b/i.test(rawArgs);
		const ledger = readGoalLedger(ctx);
		const text = buildGoalStatusText({
			commands: core.loadedCommands,
			keybindings: loadGoalSettings(ctx.cwd).keybindings,
			maxAutonomousRuns: loadGoalSettings(ctx.cwd).maxAutonomousRuns,
			idleContinuationBackoff: loadGoalSettings(ctx.cwd).idleContinuationBackoff,
			goal: view,
			focused: view !== null && core.focusedGoalId === view.id,
			otherOpenGoals: otherCount,
			ledgerEvents: ledger.events,
			ledgerMalformed: ledger.malformed,
			verbose,
			health,
			activeFilePresent: health && view?.activePath
				? existsSync(goalStoragePath(ctx, view.activePath))
				: undefined,
			// Issue #30: checkpoint growth report (health view only, read-only).
			checkpointHealth: health
				? readSessionCheckpointHealth(sessionFileOf(ctx) ?? "")
				: null,
			checkpointSessionFile: sessionFileOf(ctx),
			// Settings and their provenance are shown only in verbose mode.
			settingsReport: verbose ? [...effectiveSettingsReport(ctx.cwd), `effective goal pool: ${goalStorageRoot(ctx)}`] : [],
		});
		ctx.ui.notify(text, "info");
		core.updateUI(ctx);
	}

	async function handleGoalPause(ctx: ExtensionContext): Promise<void> {
		core.reconcileFocusedGoalFromDisk(ctx);
		if (!core.state.goal) {
			if (otherOpenGoalCount(core.goalsById, null) > 0) {
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
			ctx.ui.notify(`Goal is already paused. Use ${commandHint("goal-resume", core.loadedCommands)} to continue.`, "info");
			if (!ctx.isIdle()) ctx.abort?.();
			return;
		}
		core.interruption.reset();
		ctx.ui.setStatus("goal-interrupt", undefined);
		core.pauseActiveGoal(ctx);
		ctx.abort?.();
	}

	async function handleGoalResume(ctx: ExtensionContext, rawArgs = ""): Promise<void> {
		// Send any text first, so no early return below can drop it.
		const text = rawArgs.trim();
		if (text) core.pi.sendUserMessage(text, { deliverAs: ctx.isIdle() ? "followUp" : "steer" });
		core.reconcileFocusedGoalFromDisk(ctx);
		if (!core.state.goal && otherOpenGoalCount(core.goalsById, null) > 0) {
			const selected = await chooseOpenGoal(ctx, "Resume or focus open goal");
			if (!selected) return;
		}
		if (!core.state.goal) { ctx.ui.notify("No goal is focused.", "warning"); return; }
		if (!core.scheduler.resume(ctx)) return;
		ctx.ui.notify("Goal resumed; autonomous allowance renewed.", "info");
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

	function settingsValue(config: GoalSettings, key: keyof GoalSettings | string): string {
		if (key === "idleContinuationBackoff" || key === "strictExecutionContract" || key === "disabled" || key === "disableTasks" || key === "disableContracts" || key === "autoSelectSingleGoal" || key === "auditorProjectResources" || key === "hideUnfocusedBanner" || key === "hideUnfocusedPrompt" || key === "showAutonomousRuns" || key === "showContextUsage") {
			return config[key] === true ? "true" : "false";
		}
		if (key === "subtaskDepth") return config.subtaskDepth !== undefined ? String(config.subtaskDepth) : "1";
		if (key === "maxAutonomousRuns") return config.maxAutonomousRuns === 0 ? "0 (disabled)" : String(config.maxAutonomousRuns ?? "unlimited (default)");
		if (key === "stallTimeoutMinutes") return config.stallTimeoutMinutes !== undefined ? String(config.stallTimeoutMinutes) : "0";
		if (key === "objectiveMaxChars") return config.objectiveMaxChars !== undefined ? String(config.objectiveMaxChars) : "0";
		if (key === "keybindings") return config.keybindings ? `${config.keybindings.dashboard.toggleExpand}, ${config.keybindings.dashboard.scrollUp}, ${config.keybindings.dashboard.scrollDown}` : "(default)";
		const value = (config as Record<string, unknown>)[key];
		return typeof value === "string" ? value : "(default)";
	}

	async function handleSettingsMenu(ctx: ExtensionContext): Promise<void> {
		if (!ctx.hasUI) {
			// Headless: read-only report of both layer paths.
			ctx.ui.notify(
				`Settings — project file: ${goalSettingsPath(ctx.cwd)}\nGlobal file: ${goalGlobalSettingsPath()}`,
				"info",
			);
			return;
		}

		/**
		 * After any mutation: reinstall the goal tool list when
		 * the effective disableTasks value changed since the last install, and
		 * refresh the UI. This is the central settings side-effect hook — no
		 * ad hoc per-row refresh code.
		 */
		const applyEffectiveSettings = (): void => {
			const tasksEnabledNow = !loadGoalSettings(ctx.cwd).disableTasks;
			if (tasksEnabledNow !== core.tasksEnabled) {
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

		core.enterGoalModal();
		try {
			let scope: SettingsScope = "project";
			while (true) {
				const snapshot = loadSettingsSnapshot(ctx.cwd);
				const localLayer = snapshot[scope].layer as Record<string, unknown>;
				const options: string[] = [];
				options.push(`─── Editing: ${scope} (${scopePath(scope)}) ───`);
				options.push(`Scope: ${scope} (select to switch)`);
				options.push("Controls: commands, keys and pause order…");
				let lastSection: string | null = null;
				const pathOf = (row: SettingRow): string[] => row.path ?? [String(row.key)];
				const valueAtPath = (obj: unknown, path: string[]): unknown => {
					let cursor: unknown = obj;
					for (const segment of path) {
						if (!cursor || typeof cursor !== "object") return undefined;
						cursor = (cursor as Record<string, unknown>)[segment];
					}
					return cursor;
				};
				for (const row of SETTING_ROWS) {
					if (row.section !== lastSection) {
						options.push(`─── ${row.section} ───`);
						lastSection = row.section;
					}
					const envVar = typeof row.key === "string" ? envOverrideFor(row.key as keyof GoalSettings) : null;
					if (envVar) {
						options.push(`  ${row.label}: ${settingsValue(snapshot.value, row.key)} (environment; read-only)`);
						continue;
					}
					const rowPath = pathOf(row);
					const provenance = snapshot.provenance.get(rowPath.join("."));
					let source: string;
					if (provenance?.source === "global") source = scope === "project" ? "(inherited from global)" : "(global override)";
					else if (provenance?.source === "project") source = scope === "project" ? "(project override)" : "(project; edit via project scope)";
					else source = "(default)";
					const hasLocalOverride = valueAtPath(localLayer, rowPath) !== undefined;
					if (hasLocalOverride && provenance?.source === scope) source = `(${scope} override)`;
					// Nested rows render their leaf value directly.
					const displayValue = row.path
						? String(valueAtPath(snapshot.value, rowPath) ?? "(default)")
						: settingsValue(snapshot.value, row.key);
					options.push(`  ${row.label}: ${displayValue} ${source}`);
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
				const envVarForRow2 = envOverrideFor(row.key as keyof GoalSettings);
				if (envVarForRow2) {
					ctx.ui.notify(`${row.label} is read-only: overridden by the ${envVarForRow2} env var.`, "warning");
					continue;
				}
				// Per-row settings path (flat keys default to [key]; nested Blocker
				// Oracle rows carry explicit paths).
				const rowPath = row.path ?? [String(row.key)];
				const pathKeyStr = rowPath.join(".");
				const localValueAtPath = (() => {
					let cursor: unknown = localLayer;
					for (const segment of rowPath) {
						if (!cursor || typeof cursor !== "object") return undefined;
						cursor = (cursor as Record<string, unknown>)[segment];
					}
					return cursor;
				})();

				const inheritLabel = scope === "project" ? "Use inherited value" : "Use default (delete global override)";
				const hasLocalOverride = localValueAtPath !== undefined;

				if (row.kind === "boolean") {
					const effective = snapshot.provenance.get(pathKeyStr)?.value === true;
					const actions = [
						`Set ${scope} override to true`,
						`Set ${scope} override to false`,
					];
					if (hasLocalOverride) actions.push(inheritLabel);
					actions.push("Cancel");
					const action = await ctx.ui.select(`${row.label} (${scope})${row.help ? `\n${row.help}` : ""}`, actions);
					if (!action || action === "Cancel") continue;
					if (action === inheritLabel) {
						applyMutation(scope, { op: "unset", path: rowPath });
						continue;
					}
					const value = action.endsWith("true");
					if (value !== effective || !hasLocalOverride) {
						applyMutation(scope, { op: "set", path: rowPath, value });
					}
					continue;
				}

				if (row.kind === "positiveInteger") {
					const min = row.path ? 1 : ((row.key === "stallTimeoutMinutes" || row.key === "objectiveMaxChars" || row.key === "maxAutonomousRuns") ? 0 : 1);
					const actions = [`Set ${scope} override...`];
					if (hasLocalOverride) actions.push(inheritLabel);
					actions.push("Cancel");
					const action = await ctx.ui.select(`${row.label} (${scope})${row.help ? `\n${row.help}` : ""}`, actions);
					if (!action || action === "Cancel") continue;
					if (action === inheritLabel) {
						applyMutation(scope, { op: "unset", path: rowPath });
						continue;
					}
					const input = await ctx.ui.input(`Set ${row.label}`, String(snapshot.provenance.get(pathKeyStr)?.value ?? min));
					if (input === undefined) continue;
					// Full-string decimal validation: rejects 1.5, 1x, negatives,
					// infinity, and unsafe integers alike.
					const value = input.trim();
					if (!/^[0-9]+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < min) {
						ctx.ui.notify(`${row.label} must be an integer >= ${min} (e.g. ${min}, ${min + 1}, ${min + 2})`, "warning");
						continue;
					}
					// Oracle attempt cap is bounded at 3 by the settings parser.
					if (row.path?.[0] === "oracle" && Number(value) > 3) {
						ctx.ui.notify(`${row.label} must be an integer between 1 and 3`, "warning");
						continue;
					}
					applyMutation(scope, { op: "set", path: rowPath, value: Number(value) });
					continue;
				}

				if (row.kind === "thinking") {
					const currentValue = settingsValue(snapshot.value, row.key);
					const levels = thinkingLevelChoices(currentValue === "(default)" ? undefined : currentValue);
					const picked = await ctx.ui.select(`Set ${row.label} (${scope})`, levels);
					if (!picked) continue;
					const choice = picked.trim().replace(/^\u2713\s+/, "");
					if (choice === "(default)") {
						if (hasLocalOverride) applyMutation(scope, { op: "unset", path: rowPath });
						continue;
					}
					if (!(AUDITOR_THINKING_LEVELS as readonly string[]).includes(choice)) {
						ctx.ui.notify(`thinking_level must be one of: ${AUDITOR_THINKING_LEVELS.join(", ")} (or "(default)")`, "warning");
						continue;
					}
					applyMutation(scope, { op: "set", path: rowPath, value: choice });
					continue;
				}

				// modelSelector rows (provider, model): searchable model picker with
				// explicit inherit/default handling. Auditor rows apply provider+model
				// at the flat paths; the Oracle row writes oracle.provider/oracle.model.
				const oraclePair = row.path?.[0] === "oracle";
				const pairPrefix = oraclePair ? ["oracle"] : [];
				const configuredBase = oraclePair
					? [snapshot.value.oracle?.provider, snapshot.value.oracle?.model].filter(Boolean).join("/")
					: configuredAuditorModelKey(snapshot.value as GoalSettings);
				const configured = configuredBase || undefined;
				const session = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
				const choices = buildAuditorModelChoices(ctx.modelRegistry.getAvailable(), configured, session);
				const filter = await ctx.ui.input("Filter auditor models (provider/id/name; blank = all)", "");
				if (filter === undefined) continue;
				const filtered = filterAuditorModelChoices(choices, filter);
				const picked = await ctx.ui.select("Select auditor model", filtered.map((choice: AuditorChoice) => choice.label));
				if (!picked) continue;
				const choice = filtered.find((candidate: AuditorChoice) => candidate.label === picked);
				if (!choice) continue;
				if (choice.kind === "default") {
					for (const key of ["provider", "model"] as const) {
						if (localLayer[key] !== undefined) applyMutation(scope, { op: "unset", path: [...pairPrefix, key] });
					}
					continue;
				}
				let providerValue: string;
				let modelValue: string;
				if (choice.kind === "manual") {
					const input = await ctx.ui.input("Set auditor provider/model", configured ?? "provider/model");
					if (input === undefined) continue;
					const parsed = parseManualAuditorModel(input);
					if ("error" in parsed) {
						ctx.ui.notify(parsed.error, "warning");
						continue;
					}
					providerValue = parsed.provider;
					modelValue = parsed.model;
				} else {
					providerValue = choice.provider;
					modelValue = choice.model;
				}
				if (applyMutation(scope, { op: "set", path: [...pairPrefix, "provider"], value: providerValue })) {
					applyMutation(scope, { op: "set", path: [...pairPrefix, "model"], value: modelValue });
				}
			}
		} finally {
			core.exitGoalModal();
		}
	}
	async function handleGoalClear(ctx: ExtensionContext): Promise<void> {
		core.reconcileFocusedGoalFromDisk(ctx);
		if (!core.state.goal && otherOpenGoalCount(core.goalsById, null) > 0) {
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
			ctx.ui.notify(`Run ${commandHint("goal-clear", core.loadedCommands)} in an interactive session to confirm clearing: ${oneLineSummary(target)}`, "warning");
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
			if (otherOpenGoalCount(core.goalsById, null) > 0) {
				const selected = await chooseOpenGoal(ctx, "Tweak which open goal?");
				if (!selected) return;
			} else {
				ctx.ui.notify(`No goal is set. Use ${commandHint("goal", core.loadedCommands)} to draft one, or ${commandHint("goal-direct", core.loadedCommands)} <objective> to create one immediately.`, "warning");
				return;
			}
		}
		const currentGoal = core.state.goal;
		if (!currentGoal) return;
		if (currentGoal.status === "complete") {
			ctx.ui.notify(`Goal is complete. Use ${commandHint("goal", core.loadedCommands)} to draft a new one, or ${commandHint("goal-direct", core.loadedCommands)} <objective> to create one immediately.`, "warning");
			return;
		}
		const trimmed = replacement.trim();
		if (!trimmed) {
			ctx.ui.notify(`Describe the requested change: ${commandHint("goal-tweak", core.loadedCommands)} <change>, for example remove the token budget`, "info");
			return;
		}
		const max = loadGoalSettings(ctx.cwd).objectiveMaxChars;
		if (trimmed.length > (max ?? 0)) {
			if (max !== undefined && max > 0) {
				ctx.ui.notify(`Requested change exceeds ${max} characters (${trimmed.length}).`, "warning");
				return;
			}
		}
		await startGoalDrafting(core, ctx, "tweak", trimmed, currentGoal);
	}

	// /goal and /sisyphus are the guided default. -direct commands are the explicit bypass.
	define("goal", {
		description: "Draft a regular goal with clarification, task planning, and confirmation.",
		handler: async (rawArgs, ctx) => {
			await startGoalDrafting(core, ctx, "goal", rawArgs);
		},
	});
	define("sisyphus", {
		description: "Draft a Sisyphus goal with clarification, task planning, and confirmation.",
		handler: async (rawArgs, ctx) => {
			await startGoalDrafting(core, ctx, "sisyphus", rawArgs);
		},
	});
	define("goal-cancel", {
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
	define("goal-direct", {
		description: "Create and start a regular goal immediately, without drafting.",
		handler: async (rawArgs, ctx) => { handleDirectGoalSet(rawArgs, ctx, "goal"); },
	});
	define("sisyphus-direct", {
		description: "Create and start a Sisyphus goal immediately, without drafting.",
		handler: async (rawArgs, ctx) => { handleDirectGoalSet(rawArgs, ctx, "sisyphus"); },
	});
	define("goal-list", {
		description: "List all open goals and the current focus.",
		handler: async (_rawArgs, ctx) => {
			core.reconcileFocusedGoalFromDisk(ctx);
			ctx.ui.notify(buildGoalListText(core.goalsById, core.focusedGoalId), "info");
			core.updateUI(ctx);
		},
	});
	define("goal-status", {
		description: "Show the unified goal dashboard (read-only). Append \"verbose\" for full detail or \"health\" for storage/runtime checks.",
		handler: async (rawArgs, ctx) => {
			await showGoalStatus(rawArgs ?? "", ctx);
		},
	});
	define("goal-refresh", {
		description: "Re-read goal storage caches (pool, ledger, settings) from disk and report what changed. Picks up external edits to .pi files — no file watchers needed.",
		handler: async (_rawArgs, ctx) => {
			await runGoalRefresh(ctx);
		},
	});
	define("goal-recovery", {
		description: "Read-only storage/recovery report (malformed goal files, malformed ledger lines, stale locks, orphaned snapshot data). Append \"repair\" to remove stale locks and refresh the pool snapshot after confirmation (with backup).",
		handler: async (rawArgs, ctx) => {
			await runGoalRecovery((rawArgs ?? "").trim(), ctx);
		},
	});
	define("goal-focus", {
		description: "Choose which open goal this session focuses on.",
		handler: async (_rawArgs, ctx) => {
			await focusGoalCommand(ctx);
		},
	});
	define("goal-unfocus", {
		description: "Stop focusing the current goal (session only; goal stays open).",
		handler: async (_rawArgs, ctx) => {
			unfocusGoalCommand(ctx);
		},
	});
	define("goal-settings", {
		description: "Goal settings and controls; accepts controls for commands, keys and pause order.",
		handler: async (rawArgs, ctx) => {
			if (rawArgs.trim() === "controls") await showGoalControls(core, ctx);
			else await handleSettingsMenu(ctx);
		},
	});
	define("goal-tweak", {
		description: "Revise the current goal or its token budget with confirmation.",
		handler: async (rawArgs, ctx) => {
			await runGoalTweak(rawArgs, ctx);
		},
	});
	define("goal-clear", {
		description: "Archive the current goal after confirmation (user-owned abandonment).",
		handler: async (_rawArgs, ctx) => {
			await handleGoalClear(ctx);
		},
	});
	define("goal-pause", {
		description: "Pause the currently running goal and stop its turn.",
		handler: async (_rawArgs, ctx) => {
			await handleGoalPause(ctx);
		},
	});
	define("goal-resume", {
		description: "Continue now and renew the configured autonomous-run allowance. Any text after the command is sent to the agent.",
		handler: async (rawArgs, ctx) => {
			await handleGoalResume(ctx, rawArgs);
		},
	});
	const configured = loadGoalSettings(process.cwd()).commands;
	const problems = commandProblems(configured);
	core.loadedCommands = problems.length ? undefined : configured;
	core.controlWarnings = problems;
	const routes = commandRoutes(core.loadedCommands);
	core.invokeGoalCommand = async (id, args, ctx) => {
		const action = actions.get(id);
		if (!action) return;
		core.enterGoalModal();
		try { await action.handler(args, ctx); }
		finally { core.exitGoalModal(); }
	};
	const roots = [...actions.keys()].flatMap(id => commandPaths(core.loadedCommands, id).map(route => route.split(" ")[0]!));
	for (const root of new Set([...roots, "goal-settings"])) {
		const rootRoutes = routes.filter(route => route.path.split(" ")[0] === root);
		const direct = rootRoutes.find(route => route.path === root);
		pi.registerCommand(root, {
			description: direct ? actions.get(direct.id)!.description : `Goal actions: ${rootRoutes.map(route => route.path.slice(root.length + 1)).join(", ")}`,
			getArgumentCompletions: prefix => rootRoutes.filter(route => route.path !== root && route.path.slice(root.length + 1).startsWith(prefix)).map(route => ({ value: route.path.slice(root.length + 1), label: route.path.slice(root.length + 1), description: GOAL_COMMANDS.find(([id]) => id === route.id)![1] })),
			handler: async (args, ctx) => {
				const match = matchCommandRoute(routes, root, args);
				if (match) await core.invokeGoalCommand!(match.id, match.args, ctx);
				else ctx.ui.notify(`Choose a goal command: ${rootRoutes.map(route => `/${route.path}`).join(", ")}`, "info");
			},
		});
	}

}
