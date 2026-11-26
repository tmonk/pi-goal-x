import { t } from "./i18n/index.ts";
import { GOAL_COMMANDS, uiCommandHint, commandPaths, commandProblems, commandRoutes, matchCommandRoute, type GoalCommandId } from "./goal-controls.ts";
import { goalStoragePath, goalStorageRoot } from "./storage/goal-root.ts";
import { existsSync } from "node:fs";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { extractVerificationContract, sisyphusObjectiveSufficient } from "./goal-contract.ts";
import { detailedSummary, oneLineSummary } from "./goal-format.ts";
import {
	buildGoalListText,
	unfocusedOpenGoalsNotice,
	goalSelectorLabel,
	otherOpenGoalCount,
} from "./goal-pool.ts";
import { clearGoalCommandMessage } from "./goal-policy.ts";
import { invalidateGoalLedgerCache, readGoalLedger } from "./goal-ledger.ts";
import { invalidateGoalSettingsCache } from "./settings/files.ts";
import { loadGoalSettings, effectiveSettingsReport } from "./settings/resolve.ts";
import { invalidateGoalPoolCache, readActiveGoalPool, refreshActiveGoalPool } from "./storage/goal-files.ts";
import { nowIso, type GoalMode, type GoalRecord } from "./goal-record.ts";
import { clearGoalDrafting, hasActiveDraft, startGoalDrafting } from "./goal-drafting.ts";
import { formatCheckpointHealthReport, readSessionCheckpointHealth } from "./goal-session-health.ts";
import type {
	GoalCommandInvoker,
	GoalContinuationControl,
	GoalControlWarnings,
	GoalModalAccess,
	GoalOperationGuard,
	GoalPoolAccess,
	GoalRecordWriter,
	GoalRunControl,
	GoalTurnStopMarker,
	FocusSlice,
	HostSlice,
	InterruptionSlice,
	LifecycleSlice,
	RuntimeSlice,
	SchedulerSlice,
	StateSlice,
	ViewSlice,
} from "./goal-core-types.ts";
import type { SettingsMenuCore } from "./goal-settings-menu.ts";
import type { GoalDraftingCore } from "./goal-drafting.ts";

/** What the slash commands read and change. */
type GoalCommandsCore = SettingsMenuCore &
	GoalDraftingCore &
	GoalCommandInvoker &
	GoalControlWarnings &
	GoalContinuationControl &
	GoalRunControl &
	GoalPoolAccess &
	GoalOperationGuard &
	GoalModalAccess &
	GoalRecordWriter &
	GoalTurnStopMarker &
	HostSlice<"registerCommand"> &
	StateSlice<"activeAudit" | "cacheStats" | "openGoals"> &
	FocusSlice<"setFocus" | "setGoal"> &
	LifecycleSlice<"archive" | "create" | "syncPromptFromDisk"> &
	InterruptionSlice<"reset"> &
	RuntimeSlice<"clearPostCompactReminder" | "getCheckpointGoalId" | "setCheckpoint"> &
	SchedulerSlice<"resume" | "refreshSettings"> &
	ViewSlice<"goalForDisplay">;

export interface GoalRefreshState {
	poolIds: Iterable<string>;
	/** Revision of each pool goal, to notice an edit that keeps the same ids. */
	revisions?: ReadonlyMap<string, number>;
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
	if (added.length > 0) changes.push(t("pool: {count} goal(s) added — {ids}", { count: added.length, ids: added.join(", ") }));
	if (removed.length > 0) changes.push(t("pool: {count} goal(s) removed — {ids}", { count: removed.length, ids: removed.join(", ") }));
	for (const [id, revision] of after.revisions ?? []) {
		const old = before.revisions?.get(id);
		if (old !== undefined && old !== revision) changes.push(t("pool: {id} changed on disk (revision {before} -> {after})", { id, before: old, after: revision }));
	}
	if (after.ledgerEvents !== before.ledgerEvents) {
		changes.push(t("ledger: {before} -> {after} events", { before: before.ledgerEvents, after: after.ledgerEvents }));
	}
	if (after.ledgerMalformed !== before.ledgerMalformed) {
		changes.push(t("ledger: malformed entries {before} -> {after}", { before: before.ledgerMalformed, after: after.ledgerMalformed }));
	}
	if (before.settings !== after.settings) {
		changes.push(t("settings: effective settings changed (external edit)"));
	}
	return changes;
}

function poolRevisions(pool: ReadonlyMap<string, GoalRecord>): Map<string, number> {
	return new Map([...pool].map(([id, goal]) => [id, goal.revision ?? 0]));
}

function sessionFileOf(ctx: ExtensionContext): string | undefined {
	return (ctx.sessionManager as { getSessionFile?: () => string | undefined } | undefined)?.getSessionFile?.();
}

/**
 * Stable command actions retain their lifecycle checks. Configured invocation
 * paths are registered at load time; aliases and subcommands share the same
 * handler and argument completion. /goal-settings remains the recovery entry.
 */
export function registerGoalCommands(core: GoalCommandsCore): void {
	const { pi } = core;
	type Definition = { description: string; handler: (args: string, ctx: ExtensionContext) => Promise<void> };
	const actions = new Map<GoalCommandId, Definition>();
	const define = (id: GoalCommandId, definition: Definition): void => { actions.set(id, definition); };

	/** Ask the user to pick one of `open`; `onPicked` runs while the modal is still open. False when they decline. */
	async function pickOpenGoal(ctx: ExtensionContext, title: string, open: GoalRecord[], onPicked: (goalId: string) => void): Promise<boolean> {
		const labels = open.map((item) => goalSelectorLabel(item, core.state.focusedGoalId));
		const byLabel = new Map(labels.map((label, index) => [label, open[index]?.id]));
		core.state.enterModal();
		try {
			const selected = await ctx.ui.select(title, labels);
			const selectedId = selected ? byLabel.get(selected) : undefined;
			if (!selectedId) {
				ctx.ui.notify(t("Goal focus unchanged."), "info");
				return false;
			}
			onPicked(selectedId);
			return true;
		} finally {
			core.state.exitModal();
		}
	}

	async function chooseOpenGoal(ctx: ExtensionContext, title: string): Promise<GoalRecord | null> {
		core.reconcileFocusedGoalFromDisk(ctx);
		if (core.state.goal && core.state.goal.status !== "complete") return core.state.goal;
		const open = core.state.openGoals();
		if (open.length === 0) return null;
		if (open.length === 1) {
			const only = open[0];
			if (!only) return null;
			core.focus.setFocus(only.id, ctx, "selected");
			return core.state.goal;
		}
		if (!ctx.hasUI) {
			ctx.ui.notify(unfocusedOpenGoalsNotice(open.length), "warning");
			return null;
		}
		const picked = await pickOpenGoal(ctx, title, open, (goalId) => core.focus.setFocus(goalId, ctx, "selected"));
		return picked ? core.state.goal : null;
	}

	/**
	 * When no goal is focused but open goals exist, let the user pick one.
	 * "cancelled" means they declined; "none" means there is nothing to pick;
	 * "ready" leaves `core.state.goal` as the command should act on it.
	 */
	async function pickWhenUnfocused(ctx: ExtensionContext, title: string): Promise<"ready" | "cancelled" | "none"> {
		if (core.state.goal) return "ready";
		if (otherOpenGoalCount(core.state.goalsById, null) === 0) return "none";
		return (await chooseOpenGoal(ctx, title)) ? "ready" : "cancelled";
	}

	async function focusGoalCommand(ctx: ExtensionContext): Promise<void> {
		const open = core.state.openGoals();
		if (open.length === 0) {
			ctx.ui.notify(t("No open goals. Use {draft} to draft one, or {direct} <objective> to start immediately.", { draft: uiCommandHint("goal", core.loadedCommands), direct: uiCommandHint("goal-direct", core.loadedCommands) }), "warning");
			return;
		}
		if (open.length === 1) {
			const only = open[0];
			if (!only) return;
			core.focus.setFocus(only.id, ctx, "selected");
			core.armFocusedContinuation(ctx);
			ctx.ui.notify(t("Focused goal: {summary}", { summary: oneLineSummary(only) }), "info");
			return;
		}
		if (!ctx.hasUI) {
			ctx.ui.notify(buildGoalListText(core.state.goalsById, core.state.focusedGoalId), "info");
			return;
		}
		const picked = await pickOpenGoal(ctx, t("Focus open goal"), open, (goalId) => {
			core.focus.setFocus(goalId, ctx, "selected");
			core.armFocusedContinuation(ctx);
		});
		if (picked) ctx.ui.notify(t("Focused goal: {summary}", { summary: oneLineSummary(core.state.goal) }), "info");
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
		core.focus.setFocus(null, ctx, "unfocused", { recordLedger: false });
		core.runningGoalId = null;
		core.runtime.setCheckpoint(null);
		core.runtime.clearPostCompactReminder();
		core.state.activeAudit?.cancel("Goal cleared during completion audit.");
		if (detachedGoalId && wasBusy) {
			try {
				ctx.abort?.();
			} catch {}
		}
		if (!current) {
			const openCount = otherOpenGoalCount(core.state.goalsById, null);
			ctx.ui.notify(openCount > 0 ? unfocusedOpenGoalsNotice(openCount) : detailedSummary(null, core.loadedCommands), "info");
			return;
		}
		ctx.ui.notify(t("Goal unfocused for this session. It remains open in .pi/goals: {id}", { id: current.id }), "info");
	}

	function handleDirectGoalSet(rawObjective: string, ctx: ExtensionContext, mode: GoalMode): void {
		const raw = rawObjective.trim();
		if (!raw) {
			const command = `${uiCommandHint(mode === "sisyphus" ? "sisyphus-direct" : "goal-direct", core.loadedCommands)} <objective>`;
			ctx.ui.notify(t("No objective provided. Use {command}.", { command }), "warning");
			return;
		}
		if (mode === "sisyphus" && !sisyphusObjectiveSufficient(raw)) {
			ctx.ui.notify(t("A Sisyphus objective needs ordered steps with per-step done criteria. Use {command} for guided drafting, or provide numbered steps (1) ..., 2) ...) in the objective.", { command: uiCommandHint("sisyphus", core.loadedCommands) }), "warning");
			return;
		}
		const settings = loadGoalSettings(ctx.cwd);
		const { objective, verificationContract } = settings.disableContracts ? { objective: raw, verificationContract: undefined } : extractVerificationContract(raw);
		clearGoalDrafting(core, ctx);
		core.clearContinuationState();
		core.clearActiveAccounting();
		core.lifecycle.create({ objective, autoContinue: true, sisyphus: mode === "sisyphus" }, ctx, true, verificationContract);
	}

	async function runGoalRecovery(rawArgs: string, ctx: ExtensionContext): Promise<void> {
		const { formatRecoveryReport, runRecoveryReport, runRecoveryRepair } = await import("./goal-recovery.ts");
		const report = runRecoveryReport(ctx);
		if (/^repair$/i.test(rawArgs)) {
			const result = await runRecoveryRepair(ctx, report, async () => {
				const confirmed = await ctx.ui.confirm(t("Remove {count} stale lock(s) and refresh the pool snapshot?", { count: report.staleLocks.length }), t("Files are backed up to .pi/goals/.recovery-backup first."));
				return confirmed === true;
			});
			if (result.confirmed) {
				ctx.ui.notify(result.applied.length > 0
					? t("goal-recovery repair: {count} operation(s) applied.\n{operations}\nBackup: {backupDir}", { count: result.applied.length, operations: result.applied.map((a) => `  - ${a}`).join("\n"), backupDir: String(result.backupDir) })
					: t("goal-recovery repair: nothing to repair."), "info");
			} else {
				ctx.ui.notify(t("goal-recovery repair: cancelled — nothing changed."), "info");
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

		const afterPool = refreshActiveGoalPool(ctx);
		// Pick up the new revision of the focused goal now, so a buffered in-turn goal is kept.
		core.reconcileFocusedGoalFromDisk(ctx);
		const afterLedger = readGoalLedger(ctx);
		const afterSettings = settingsFingerprint(ctx);

		const changes = diffGoalRefreshState({
			poolIds: beforePool.keys(),
			revisions: poolRevisions(beforePool),
			ledgerEvents: beforeLedger.events.length,
			ledgerMalformed: beforeLedger.malformed,
			settings: beforeSettings,
		}, {
			poolIds: afterPool.keys(),
			revisions: poolRevisions(afterPool),
			ledgerEvents: afterLedger.events.length,
			ledgerMalformed: afterLedger.malformed,
			settings: afterSettings,
		});

		const text = changes.length > 0
			? t("goal-refresh: re-read caches from disk — {count} change(s):\n{changes}", { count: changes.length, changes: changes.map((c) => `  - ${c}`).join("\n") })
			: t("goal-refresh: no changes detected — caches were already current.");
		ctx.ui.notify(text, "info");
		core.scheduler.refreshSettings(ctx);
		core.updateUI(ctx);
	}

	/** Stable fingerprint of the effective settings (cache-served before invalidation). */
	function settingsFingerprint(ctx: ExtensionContext): string {
		return JSON.stringify(loadGoalSettings(ctx.cwd));
	}

	async function showGoalStatus(rawArgs: string, ctx: ExtensionContext): Promise<void> {
		core.reconcileFocusedGoalFromDisk(ctx);
		if (core.state.goal) core.lifecycle.syncPromptFromDisk(ctx);
		const view = core.view.goalForDisplay() ?? core.state.goal;
		const otherCount = otherOpenGoalCount(core.state.goalsById, core.state.focusedGoalId);
		const verbose = /^\s*verbose\b/i.test(rawArgs);
		const health = /^\s*health\b/i.test(rawArgs);
		const ledger = readGoalLedger(ctx);
		const { buildGoalStatusText } = await import("./goal-status.ts");
		const text = buildGoalStatusText({
			commands: core.loadedCommands,
			keybindings: loadGoalSettings(ctx.cwd).keybindings,
			maxAutonomousRuns: loadGoalSettings(ctx.cwd).maxAutonomousRuns,
			idleContinuationBackoff: loadGoalSettings(ctx.cwd).idleContinuationBackoff,
			goal: view,
			focused: view !== null && core.state.focusedGoalId === view.id,
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
			cacheLine: verbose ? core.state.cacheStats.line() : undefined,
			settingsReport: verbose ? [...effectiveSettingsReport(ctx.cwd), t("effective goal pool: {path}", { path: goalStorageRoot(ctx) })] : [],
		});
		ctx.ui.notify(text, "info");
		core.updateUI(ctx);
	}

	async function handleGoalPause(ctx: ExtensionContext): Promise<void> {
		core.reconcileFocusedGoalFromDisk(ctx);
		const pick = await pickWhenUnfocused(ctx, t("Pause which open goal?"));
		if (pick === "cancelled") return;
		if (pick === "none") {
			ctx.ui.notify(t("No goal is set."), "warning");
			return;
		}
		const currentGoal = core.state.goal;
		if (!currentGoal) return;
		if (currentGoal.status === "complete") {
			ctx.ui.notify(t("Goal is complete."), "warning");
			return;
		}
		if (currentGoal.status === "paused") {
			ctx.ui.notify(t("Goal is already paused. Use {command} to continue.", { command: uiCommandHint("goal-resume", core.loadedCommands) }), "info");
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
		if (await pickWhenUnfocused(ctx, t("Resume or focus open goal")) === "cancelled") return;
		if (!core.state.goal) { ctx.ui.notify(t("No goal is focused."), "warning"); return; }
		if (!core.scheduler.resume(ctx)) return;
		ctx.ui.notify(t("Goal resumed; autonomous allowance renewed."), "info");
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

	async function handleGoalClear(ctx: ExtensionContext): Promise<void> {
		core.reconcileFocusedGoalFromDisk(ctx);
		if (await pickWhenUnfocused(ctx, t("Clear which open goal?")) === "cancelled") return;
		if (!core.state.goal) {
			ctx.ui.notify(clearGoalCommandMessage({ archived: false }), "warning");
			return;
		}
		// Snapshot the selected goal id and focus revision before asking.
		const target = core.state.goal;
		const focusToken = core.state.focusToken(target.id);
		// Headless behavior is explicit: guidance without mutation. Clearing
		// requires an interactive confirmation (follow-up Stage 2).
		if (!ctx.hasUI) {
			ctx.ui.notify(t("Run {command} in an interactive session to confirm clearing: {summary}", { command: uiCommandHint("goal-clear", core.loadedCommands), summary: oneLineSummary(target) }), "warning");
			return;
		}
		const confirmed = await ctx.ui.confirm(t("Clear goal?"), oneLineSummary(target));
		if (!confirmed) {
			ctx.ui.notify(t("Goal clear cancelled."), "info");
			return;
		}
		// Reconcile and validate the same focus token after confirmation, then
		// archive. Cancellation above changes no file, focus entry, ledger
		// entry, or runtime state.
		core.reconcileFocusedGoalFromDisk(ctx);
		if (!core.state.isTokenCurrent(focusToken) || !core.state.goal || core.state.goal.id !== target.id) {
			ctx.ui.notify(t("Goal changed while confirming; nothing was cleared."), "warning");
			return;
		}
		const archived = core.lifecycle.archive(ctx, "user");
		const didArchive = !!archived;
		core.focus.setGoal(null, ctx, true, "cleared");
		const msg = clearGoalCommandMessage({ archived: didArchive });
		ctx.ui.notify(msg, didArchive ? "info" : "warning");
	}

	async function runGoalTweak(replacement: string, ctx: ExtensionContext): Promise<void> {
		core.reconcileFocusedGoalFromDisk(ctx);
		const pick = await pickWhenUnfocused(ctx, t("Tweak which open goal?"));
		if (pick === "cancelled") return;
		if (pick === "none") {
			ctx.ui.notify(t("No goal is set. Use {draft} to draft one, or {direct} <objective> to create one immediately.", { draft: uiCommandHint("goal", core.loadedCommands), direct: uiCommandHint("goal-direct", core.loadedCommands) }), "warning");
			return;
		}
		const currentGoal = core.state.goal;
		if (!currentGoal) return;
		if (currentGoal.status === "complete") {
			ctx.ui.notify(t("Goal is complete. Use {draft} to draft a new one, or {direct} <objective> to create one immediately.", { draft: uiCommandHint("goal", core.loadedCommands), direct: uiCommandHint("goal-direct", core.loadedCommands) }), "warning");
			return;
		}
		const trimmed = replacement.trim();
		if (!trimmed) {
			ctx.ui.notify(t("Describe the requested change: {command} <change>, for example remove the token budget", { command: uiCommandHint("goal-tweak", core.loadedCommands) }), "info");
			return;
		}
		const max = loadGoalSettings(ctx.cwd).objectiveMaxChars;
		if (max !== undefined && max > 0 && trimmed.length > max) {
			ctx.ui.notify(t("Requested change exceeds {max} characters ({length}).", { max, length: trimmed.length }), "warning");
			return;
		}
		await startGoalDrafting(core, ctx, "tweak", trimmed, currentGoal);
	}

	// /goal and /sisyphus are the guided default. -direct commands are the explicit bypass.
	define("goal", {
		description: t("Draft a regular goal with clarification, task planning, and confirmation."),
		handler: async (rawArgs, ctx) => {
			await startGoalDrafting(core, ctx, "goal", rawArgs);
		},
	});
	define("sisyphus", {
		description: t("Draft a Sisyphus goal with clarification, task planning, and confirmation."),
		handler: async (rawArgs, ctx) => {
			await startGoalDrafting(core, ctx, "sisyphus", rawArgs);
		},
	});
	define("goal-cancel", {
		description: t("Cancel the in-progress guided draft without creating or modifying a goal."),
		handler: async (_rawArgs, ctx) => {
			if (!hasActiveDraft(core)) {
				ctx.ui.notify(t("No active draft to cancel."), "info");
				return;
			}
			clearGoalDrafting(core, ctx);
			core.clearContinuationState();
			ctx.ui.notify(t("Draft cancelled; no goal was created. The execution profile is restored."), "info");
		},
	});
	define("goal-direct", {
		description: t("Create and start a regular goal immediately, without drafting."),
		handler: async (rawArgs, ctx) => { handleDirectGoalSet(rawArgs, ctx, "goal"); },
	});
	define("sisyphus-direct", {
		description: t("Create and start a Sisyphus goal immediately, without drafting."),
		handler: async (rawArgs, ctx) => { handleDirectGoalSet(rawArgs, ctx, "sisyphus"); },
	});
	define("goal-list", {
		description: t("List all open goals and the current focus."),
		handler: async (_rawArgs, ctx) => {
			core.reconcileFocusedGoalFromDisk(ctx);
			ctx.ui.notify(buildGoalListText(core.state.goalsById, core.state.focusedGoalId), "info");
			core.updateUI(ctx);
		},
	});
	define("goal-status", {
		description: t("Show the unified goal dashboard (read-only). Append \"verbose\" for full detail or \"health\" for storage/runtime checks."),
		handler: async (rawArgs, ctx) => {
			await showGoalStatus(rawArgs ?? "", ctx);
		},
	});
	define("goal-refresh", {
		description: t("Re-read goal storage caches (pool, ledger, settings) from disk and report what changed. Picks up external edits to .pi files — no file watchers needed."),
		handler: async (_rawArgs, ctx) => {
			await runGoalRefresh(ctx);
		},
	});
	define("goal-recovery", {
		description: t("Read-only storage/recovery report (malformed goal files, malformed ledger lines, stale locks, orphaned snapshot data). Append \"repair\" to remove stale locks and refresh the pool snapshot after confirmation (with backup)."),
		handler: async (rawArgs, ctx) => {
			await runGoalRecovery((rawArgs ?? "").trim(), ctx);
		},
	});
	define("goal-focus", {
		description: t("Choose which open goal this session focuses on."),
		handler: async (_rawArgs, ctx) => {
			await focusGoalCommand(ctx);
		},
	});
	define("goal-unfocus", {
		description: t("Stop focusing the current goal (session only; goal stays open)."),
		handler: async (_rawArgs, ctx) => {
			unfocusGoalCommand(ctx);
		},
	});
	define("goal-settings", {
		description: t("Goal settings and controls; accepts controls for commands, keys and pause order."),
		handler: async (rawArgs, ctx) => {
			if (rawArgs.trim() === "controls") await (await import("./widgets/goal-controls-dialog.ts")).showGoalControls(core, ctx);
			else await (await import("./goal-settings-menu.ts")).handleSettingsMenu(core, ctx);
		},
	});
	define("goal-tweak", {
		description: t("Revise the current goal or its token budget with confirmation."),
		handler: async (rawArgs, ctx) => {
			await runGoalTweak(rawArgs, ctx);
		},
	});
	define("goal-clear", {
		description: t("Archive the current goal after confirmation (user-owned abandonment)."),
		handler: async (_rawArgs, ctx) => {
			await handleGoalClear(ctx);
		},
	});
	define("goal-pause", {
		description: t("Pause the currently running goal and stop its turn."),
		handler: async (_rawArgs, ctx) => {
			await handleGoalPause(ctx);
		},
	});
	define("goal-resume", {
		description: t("Continue now and renew the configured autonomous-run allowance. Any text after the command is sent to the agent."),
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
		core.state.enterModal();
		try { await action.handler(args, ctx); }
		finally { core.state.exitModal(); }
	};
	const roots = [...actions.keys()].flatMap(id => commandPaths(core.loadedCommands, id).map(route => route.split(" ")[0]!));
	for (const root of new Set([...roots, "goal-settings"])) {
		const rootRoutes = routes.filter(route => route.path.split(" ")[0] === root);
		const direct = rootRoutes.find(route => route.path === root);
		pi.registerCommand(root, {
			description: direct ? actions.get(direct.id)!.description : t("Goal actions: {actions}", { actions: rootRoutes.map(route => route.path.slice(root.length + 1)).join(", ") }),
			getArgumentCompletions: prefix => rootRoutes.filter(route => route.path !== root && route.path.slice(root.length + 1).startsWith(prefix)).map(route => ({ value: route.path.slice(root.length + 1), label: route.path.slice(root.length + 1), description: GOAL_COMMANDS.find(([id]) => id === route.id)![1] })),
			handler: async (args, ctx) => {
				const match = matchCommandRoute(routes, root, args);
				if (match) await core.invokeGoalCommand!(match.id, match.args, ctx);
				else ctx.ui.notify(t("Choose a goal command: {commands}", { commands: rootRoutes.map(route => `/${route.path}`).join(", ") }), "info");
			},
		});
	}

}
