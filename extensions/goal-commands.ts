import { GOAL_COMMANDS, commandHint, commandPaths, commandProblems, commandRoutes, matchCommandRoute, type GoalCommandId } from "./goal-controls.ts";
import { showGoalControls } from "./widgets/goal-controls-dialog.ts";
import { handleSettingsMenu } from "./goal-settings-menu.ts";
import { goalStoragePath, goalStorageRoot } from "./storage/goal-root.ts";
import { existsSync } from "node:fs";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { extractVerificationContract, sisyphusObjectiveSufficient } from "./goal-contract.ts";
import { detailedSummary, oneLineSummary } from "./goal-format.ts";
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
import { loadGoalSettings, effectiveSettingsReport } from "./settings/resolve.ts";
import { invalidateGoalPoolCache, readActiveGoalPool } from "./storage/goal-files.ts";
import { nowIso, type GoalMode, type GoalRecord } from "./goal-record.ts";
import { clearGoalDrafting, hasActiveDraft, startGoalDrafting } from "./goal-drafting.ts";
import { formatRecoveryReport, runRecoveryReport, runRecoveryRepair } from "./goal-recovery.ts";
import { formatCheckpointHealthReport, readSessionCheckpointHealth } from "./goal-session-health.ts";
import type { GoalCore } from "./goal-state.ts";

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

	/** Ask the user to pick one of `open`; `onPicked` runs while the modal is still open. False when they decline. */
	async function pickOpenGoal(ctx: ExtensionContext, title: string, open: GoalRecord[], onPicked: (goalId: string) => void): Promise<boolean> {
		const labels = open.map((item) => goalSelectorLabel(item, core.focusedGoalId));
		const byLabel = new Map(labels.map((label, index) => [label, open[index]?.id]));
		core.enterGoalModal();
		try {
			const selected = await ctx.ui.select(title, labels);
			const selectedId = selected ? byLabel.get(selected) : undefined;
			if (!selectedId) {
				ctx.ui.notify("Goal focus unchanged.", "info");
				return false;
			}
			onPicked(selectedId);
			return true;
		} finally {
			core.exitGoalModal();
		}
	}

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
		const picked = await pickOpenGoal(ctx, title, open, (goalId) => core.setFocusedGoalId(goalId, ctx, "selected"));
		return picked ? core.state.goal : null;
	}

	/**
	 * When no goal is focused but open goals exist, let the user pick one.
	 * "cancelled" means they declined; "none" means there is nothing to pick;
	 * "ready" leaves `core.state.goal` as the command should act on it.
	 */
	async function pickWhenUnfocused(ctx: ExtensionContext, title: string): Promise<"ready" | "cancelled" | "none"> {
		if (core.state.goal) return "ready";
		if (otherOpenGoalCount(core.goalsById, null) === 0) return "none";
		return (await chooseOpenGoal(ctx, title)) ? "ready" : "cancelled";
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
		const picked = await pickOpenGoal(ctx, "Focus open goal", open, (goalId) => {
			core.setFocusedGoalId(goalId, ctx, "selected");
			core.armFocusedContinuation(ctx);
		});
		if (picked) ctx.ui.notify(`Focused goal: ${oneLineSummary(core.state.goal)}`, "info");
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
		const pick = await pickWhenUnfocused(ctx, "Pause which open goal?");
		if (pick === "cancelled") return;
		if (pick === "none") {
			ctx.ui.notify("No goal is set.", "warning");
			return;
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
		if (await pickWhenUnfocused(ctx, "Resume or focus open goal") === "cancelled") return;
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

	async function handleGoalClear(ctx: ExtensionContext): Promise<void> {
		core.reconcileFocusedGoalFromDisk(ctx);
		if (await pickWhenUnfocused(ctx, "Clear which open goal?") === "cancelled") return;
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
		const pick = await pickWhenUnfocused(ctx, "Tweak which open goal?");
		if (pick === "cancelled") return;
		if (pick === "none") {
			ctx.ui.notify(`No goal is set. Use ${commandHint("goal", core.loadedCommands)} to draft one, or ${commandHint("goal-direct", core.loadedCommands)} <objective> to create one immediately.`, "warning");
			return;
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
		if (max !== undefined && max > 0 && trimmed.length > max) {
			ctx.ui.notify(`Requested change exceeds ${max} characters (${trimmed.length}).`, "warning");
			return;
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
			else await handleSettingsMenu(core, ctx);
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
