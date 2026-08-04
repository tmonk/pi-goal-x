import { type AgentToolResult, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { GOAL_AUDIT_ENTRY, detailedSummary, goalDetails, type GoalAuditEventDetails } from "./goal-format.ts";
import {
	buildCompletionReport,
	buildTaskSummary,
	taskCompletionBlockWarning,
	validateGoalCompletion,
} from "./goal-policy.ts";
import { loadGoalSettings, loadGoalSettingsFileConfig } from "./goal-settings.ts";
import { runGoalCompletionAuditor } from "./goal-auditor.ts";
import { nowIso, type GoalRecord } from "./goal-record.ts";
import { mergeGoalPromptFromDisk } from "./storage/goal-files.ts";
import { showEscapeDialog, type EscapeDialogResult } from "./widgets/goal-escape-dialog.ts";
import type { GoalCore } from "./goal-state.ts";

// Agent's goal-confirmation entry point. Shows the user a full plain-text
// draft report with two choices: [Confirm] (creates the goal) or
// [Continue Chatting] (returns control to the agent for more clarification).
// Schema gates enforce focus-vs-sisyphus consistency; draftId is ignored for
// one-release compatibility with older prompt residue.
// In headless mode (no UI), auto-confirms — harness-friendly.
export async function runGoalCompletionFlow(core: GoalCore, ctx: ExtensionContext): Promise<AgentToolResult<unknown>> {
	const { pi } = core;
	core.reconcileFocusedGoalFromDisk(ctx);

	// -- Completion --
	const completionGate = validateGoalCompletion({ goal: core.state.goal, runningGoalId: core.runningGoalId });
	if (!completionGate.ok) {
		return {
			content: [{ type: "text", text: completionGate.message }],
			details: goalDetails(core.state.goal),
		};
	}
	if (!core.state.goal) throw new Error("Goal disappeared during completion validation.");

	// Task gate: warn if blockCompletion is enabled and tasks remain pending
	const disableTasksSettings = loadGoalSettings(ctx.cwd).disableTasks;
	if (!disableTasksSettings) {
		const taskWarning = core.state.goal.taskList ? taskCompletionBlockWarning(core.state.goal.taskList) : null;
		if (taskWarning) {
			return {
				content: [{ type: "text", text: taskWarning }],
				details: goalDetails(core.state.goal),
			};
		}
	}

	const auditTarget = mergeGoalPromptFromDisk(ctx, core.state.goal);
	const completionFocus = core.focusedOperationToken(auditTarget.id);
	// Append ledger: completion requested
	try {
		core.goalService.appendEvents(ctx, [{
			type: "completion_requested",
			goalId: auditTarget.id,
			at: nowIso(),
		}]);
	} catch {
		// Ledger append failure should not block completion
	}
	const settings = loadGoalSettingsFileConfig(ctx.cwd);
	const auditorLabel = settings.provider || settings.model || settings.thinkingLevel
		? `${settings.provider ?? "default"}/${settings.model ?? "default"}${settings.thinkingLevel ? `:${settings.thinkingLevel}` : ""}`
		: "default";

/**
 * Single transaction for every successful completion commit — audit-approved,
 * globally disabled, legacy per-goal skipped, or user-bypassed via Escape.
 * Deferred archival: sets the goal complete in memory + writes the active
 * file WITHOUT archiving; archival happens at turn_end so the agent can
 * recognise the outcome before the goal is archived.
 */
function commitGoalCompletion(core: GoalCore, ctx: ExtensionContext, opts: {
	goal: GoalRecord;
	completionFocus: { goalId: string; revision: number };
	auditorReport?: string | null;
	auditSkippedReason?: string | null;
	terminate?: boolean;
	trailing?: string[];
}): AgentToolResult<unknown> {
	core.accountProgress(ctx);
	core.auditProgress = null;
	core.goalWidgetComponentRef.current?.invalidate();
	const completeResult = core.goalService.apply(ctx, {
		reconcile: false,
		focusToken: opts.completionFocus,
		mutate: () => ({ ...opts.goal, status: "complete" as const, stopReason: "agent" as const, updatedAt: nowIso() }),
	});
	if (completeResult.ok && completeResult.goal) core.runtime.markTurnStopped(completeResult.goal.id);
	core.updateUI(ctx);
	const text = buildCompletionReport({
		detailedSummary: detailedSummary(core.state.goal),
		auditorReport: opts.auditorReport,
		auditSkippedReason: opts.auditSkippedReason,
		taskSummary: core.state.goal?.taskList ? buildTaskSummary(core.state.goal.taskList) : null,
	});
	return {
		content: [{ type: "text", text: opts.trailing?.length ? [text, "", ...opts.trailing].join("\n") : text }],
		details: goalDetails(core.state.goal),
		...(opts.terminate === false ? {} : { terminate: true }),
	};
}

// Check if auditor is disabled per-goal (legacy persisted skipAuditor:true
// records remain readable and honored for compatibility; no model tool or
// task dialog creates new per-goal bypass state).
if (auditTarget.skipAuditor) {
	pi.sendMessage<GoalAuditEventDetails>({
		customType: GOAL_AUDIT_ENTRY,
		content: `Goal completed — per-goal auditor disabled.`,
		display: true,
		details: { phase: "skipped", goalId: auditTarget.id, auditor: auditorLabel },
	});
	try {
		core.goalService.appendEvents(ctx, [{
			type: "audit_skipped",
			goalId: auditTarget.id,
			reason: "disabled",
			provider: settings.provider,
			model: settings.model,
			thinkingLevel: settings.thinkingLevel,
			at: nowIso(),
		}]);
	} catch {
		// Ledger append failure should not block completion
	}
	return commitGoalCompletion(core, ctx, {
		goal: auditTarget,
		completionFocus,
		auditSkippedReason: "per-goal auditor disabled",
	});
}

// settings.disabled is an explicit user-owned setting: completion skips
// the auditor, records audit_skipped, and proceeds through the normal
// deferred-completion path. No model-side bypass flag is required.
if (settings.disabled === true) {
	pi.sendMessage<GoalAuditEventDetails>({
		customType: GOAL_AUDIT_ENTRY,
		content: `Goal completed — auditor disabled in settings.`,
		display: true,
		details: { phase: "skipped", goalId: auditTarget.id, auditor: auditorLabel },
	});
	try {
		core.goalService.appendEvents(ctx, [{
			type: "audit_skipped",
			goalId: auditTarget.id,
			reason: "disabled",
			provider: settings.provider,
			model: settings.model,
			thinkingLevel: settings.thinkingLevel,
			at: nowIso(),
		}]);
	} catch {
		// Ledger append failure should not block completion
	}
	return commitGoalCompletion(core, ctx, {
		goal: auditTarget,
		completionFocus,
		auditSkippedReason: "auditor disabled in settings",
	});
}

	// Auditor is enabled — run the normal audit flow
	await pi.sendMessage<GoalAuditEventDetails>({
		customType: GOAL_AUDIT_ENTRY,
		content: [
			"Auditor: I am starting the independent completion audit.",
			`Goal id: ${auditTarget.id}`,
			`Auditor model: ${auditorLabel}`,
		].filter((line): line is string => line !== undefined).join("\n"),
		display: true,
		details: { phase: "started", goalId: auditTarget.id, auditor: auditorLabel },
	}, { triggerTurn: true });
	if (!core.isFocusedOperationCurrent(completionFocus)) {
		return core.focusedOperationCancelledResult("Goal completion", completionFocus);
	}
	// Append ledger: audit started
	try {
		core.goalService.appendEvents(ctx, [{
			type: "audit_started",
			goalId: auditTarget.id,
			provider: settings.provider,
			model: settings.model,
			thinkingLevel: settings.thinkingLevel,
			at: nowIso(),
		}]);
	} catch {
		// Ledger append failure should not block completion
	}
	// Set up auditor progress display (before createAgentSession)
	const auditStartedAt = Date.now();
	core.auditProgress = {
		recentOutput: [],
		phase: "running",
		elapsedMs: 0,
	};
	// Start animation timer for the spinner in the auditor widget
	core.stopAuditAnimation();
	core.auditAnimationTimer = setInterval(() => {
		if (!core.auditProgress) {
			core.stopAuditAnimation();
			return;
		}
		core.auditProgress.elapsedMs = Date.now() - auditStartedAt;
		core.goalWidgetComponentRef.current?.invalidate();
	}, 80);
	core.auditAnimationTimer?.unref?.();

	// Create a dedicated AbortController for the audit so it can be interrupted via Escape
	core.auditAbortController?.abort(); // Clean up any stale controller
	const completionAuditController = new AbortController();
	core.auditAbortController = completionAuditController;

	const auditor = await (core.dependencies.runCompletionAuditor ?? runGoalCompletionAuditor)({
		ctx,
		goal: auditTarget,
		detailedSummary: detailedSummary(auditTarget),
		settings: loadGoalSettings(ctx.cwd),
		signal: completionAuditController.signal,
		onProgress: (progress) => {
			core.auditProgress = {
				...progress,
				elapsedMs: Date.now() - auditStartedAt,
			};
			core.goalWidgetComponentRef.current?.invalidate();
		},
	});
	// Clear abort controller — audit finished on its own
	if (core.auditAbortController === completionAuditController) core.auditAbortController = null;
	// Clear auditor progress display
	core.stopAuditAnimation();
	if (!core.isFocusedOperationCurrent(completionFocus)) {
		core.auditProgress = null;
		core.goalWidgetComponentRef.current?.invalidate();
		return core.focusedOperationCancelledResult("Goal completion", completionFocus);
	}

	// If the audit was aborted by the user (Esc), show a TUI dialog letting
	// the user choose: mark complete without audit, or continue working.
	if (auditor.error === "Auditor aborted.") {
		core.auditProgress = null;
		core.goalWidgetComponentRef.current?.invalidate();
		core.updateUI(ctx);

		core.showingEscapeDialog = true;
		const userChoice: EscapeDialogResult = await showEscapeDialog(ctx, auditTarget.objective);
		core.showingEscapeDialog = false;
		if (!core.isFocusedOperationCurrent(completionFocus)) {
			return core.focusedOperationCancelledResult("Goal completion", completionFocus);
		}

		if (userChoice === "complete_without_audit") {
			// ── Mark complete without audit ────────────────────────────
			pi.sendMessage<GoalAuditEventDetails>({
				customType: GOAL_AUDIT_ENTRY,
				content: `Goal completed — user bypassed audit via Escape.`,
				display: true,
				details: { phase: "skipped", goalId: auditTarget.id, auditor: auditorLabel },
			});
			try {
				core.goalService.appendEvents(ctx, [{
					type: "audit_skipped",
					goalId: auditTarget.id,
					reason: "user_aborted",
					provider: settings.provider,
					model: settings.model,
					thinkingLevel: settings.thinkingLevel,
					at: nowIso(),
				}]);
			} catch {
				// Ledger append failure should not block completion
			}
			// Deferred archival: set goal complete in memory + write the active file
			// WITHOUT archiving; archival happens at turn_end so the agent can
			// recognise the skipped audit before the goal is archived.
			return commitGoalCompletion(core, ctx, {
				goal: auditTarget,
				completionFocus,
				auditSkippedReason: "auditor bypassed (user pressed Escape during audit)",
				terminate: false,
				trailing: ["The goal is complete. Provide a final summary of what was accomplished."],
			});
		} else {
			// ── Continue working → pause the goal ──────────────
			core.pauseActiveGoal(ctx);
			if (core.state.goal) core.runtime.markTurnStopped(core.state.goal.id);
			return {
				content: [{ type: "text", text: "Goal paused — user chose to continue working after skipping audit." }],
				details: core.state.goal ? goalDetails(core.state.goal) : undefined,
			};
		}
	}

	// Show final audit output briefly before clearing
	if (core.auditProgress && auditor.output) {
		const outputLines = auditor.output.split("\n").slice(0, 8);
		core.auditProgress = {
			...core.auditProgress,
			phase: "done",
			recentOutput: outputLines,
			elapsedMs: Date.now() - auditStartedAt,
		};
		core.goalWidgetComponentRef.current?.invalidate();
	}
	// Append ledger: audit result
	const verdict = auditor.approved ? "approved" : auditor.error ? "error" : "disapproved" as const;
	try {
		core.goalService.appendEvents(ctx, [{
			type: "audit_result",
			goalId: auditTarget.id,
			verdict,
			report: auditor.output || "Auditor produced no output.",
			at: nowIso(),
		}]);
	} catch {
		// Ledger append failure should not block completion
	}
	if (!auditor.approved) {
		// Clear auditor progress to restore normal widget state
		core.auditProgress = null;
		core.goalWidgetComponentRef.current?.invalidate();
		const rejectionText = [
			"Goal audit rejected.",
			"",
			"Goal completion rejected by independent auditor.",
			auditor.model ? `Auditor model: ${auditor.model}${auditor.thinkingLevel ? `:${auditor.thinkingLevel}` : ""}` : undefined,
			auditor.error ? `Auditor error: ${auditor.error}` : undefined,
			"",
			auditor.output || "Auditor produced no approval marker.",
		].filter((line): line is string => line !== undefined).join("\n");
		pi.sendMessage<GoalAuditEventDetails>({
			customType: GOAL_AUDIT_ENTRY,
			content: rejectionText,
			display: true,
			details: { phase: "rejected", goalId: auditTarget.id, auditor: auditor.model },
		});
		return {
			content: [{ type: "text", text: rejectionText }],
			details: goalDetails(core.state.goal),
		};
	}
	const approvalText = [
		"Auditor: I approve this completion claim.",
		auditor.model ? `Auditor model: ${auditor.model}${auditor.thinkingLevel ? `:${auditor.thinkingLevel}` : ""}` : undefined,
		"",
		auditor.output || "Auditor approved completion.",
	].filter((line): line is string => line !== undefined).join("\n");
	pi.sendMessage<GoalAuditEventDetails>({
		customType: GOAL_AUDIT_ENTRY,
		content: approvalText,
		display: true,
		details: { phase: "approved", goalId: auditTarget.id, auditor: auditor.model },
	});
	// Account for any remaining elapsed time.
	// Deferred archival happens inside commitGoalCompletion; archival occurs at
	// turn_end so the agent can see the auditor approval before the goal is
	// archived.
	return commitGoalCompletion(core, ctx, {
		goal: auditTarget,
		completionFocus,
		auditorReport: auditor.output,
	});
}
