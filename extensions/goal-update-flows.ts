import type { AgentToolResult, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { commandHint } from "./goal-controls.ts";
import { goalDetails, goalTextResult } from "./goal-format.ts";
import { validateGoalAgentPause, validateGoalBlock } from "./goal-policy.ts";
import { goalOracleState, type GoalLedgerEvent } from "./goal-ledger.ts";
import { nowIso } from "./goal-record.ts";
import type { GoalCore } from "./goal-state.ts";
import {
	armOracleAdvice,
	buildBlockerFingerprint,
	consumeOracleFollowupMarker,
	hasPendingOracleAdviceForFocusedGoal,
	renderActionableOracleAdvice,
	renderOracleAdviceReminder,
	runBlockerOracle,
} from "./goal-oracle.ts";
import { type ResolvedGoalOracleSettings } from "./settings/schema.ts";
import { loadSettingsSnapshot } from "./settings/resolve.ts";

/** Append ledger events without letting a ledger failure change the tool outcome. */
function appendBestEffort(core: GoalCore, ctx: ExtensionContext, event: GoalLedgerEvent): void {
	try {
		core.goalService.appendEvents(ctx, [event]);
	} catch { /* ledger annotations are best-effort */ }
}

/**
 * update_goal({status: "blocked"}): a distinct agent-blocked state that stops
 * continuation. The three-consecutive-turn blocker rule is prompt policy. With
 * the opt-in Oracle (issue #26) the blocker is consulted once per fingerprint
 * before the goal is actually blocked.
 */
export async function runGoalBlockedFlow(core: GoalCore, ctx: ExtensionContext, reasonInput?: string, attemptedActions: string[] = []): Promise<AgentToolResult<unknown>> {
	core.reconcileFocusedGoalFromDisk(ctx);
	const gate = validateGoalBlock({ goal: core.state.goal, runningGoalId: core.runningGoalId });
	if (!gate.ok) return goalTextResult(gate.message, core.state.goal);
	if (!core.state.goal) throw new Error("Goal disappeared during blocked validation.");

	// Issue #26: the blocker reason is required for update_goal(blocked) —
	// it feeds the fingerprint, the ledger event, and the user-facing report.
	const reason = reasonInput?.trim() ?? "";
	if (!reason) {
		return goalTextResult('update_goal({ status: "blocked" }) requires a "reason" describing the concrete blocker. The goal remains active.', core.state.goal, false);
	}

	const commitBlocked = (): AgentToolResult<unknown> => {
		const result = core.goalService.apply(ctx, {
			reconcile: false,
			refreshFromDisk: true,
			mutate: (g) => ({
				...g,
				status: "blocked" as const,
				stopReason: "agent" as const,
				pauseReason: reason,
				updatedAt: nowIso(),
			}),
			ledger: (written) => [{
				type: "goal_blocked",
				goalId: written.id,
				reason: written.pauseReason ?? "blocked",
				source: "agent",
				at: written.updatedAt,
			}],
		});
		if (!result.ok) {
			return goalTextResult(`Goal blocked state update failed: ${result.message ?? "the state mutation was rejected"}. The goal was NOT marked blocked. Retry after resolving the conflict.`, core.state.goal, false);
		}
		core.clearContinuationState();
		core.clearActiveAccounting();
		if (result.goal) core.runtime.markTurnStopped(result.goal.id);
		core.updateUI(ctx);
		return goalTextResult("Goal blocked. Continuation stopped; the goal is waiting for the user to resume, revise, or clear it. Stop now; do not start another tool call.", core.state.goal, true);
	};

	// Oracle disabled: existing block transition, unchanged behavior.
	const oracleSettings = loadSettingsSnapshot(ctx.cwd).value.oracle;
	if (!oracleSettings?.enabled) return commitBlocked();

	const goalAtBlock = core.state.goal;
	const focusToken = core.focusedOperationToken(goalAtBlock.id);
	const fingerprint = buildBlockerFingerprint(goalAtBlock, reason);
	const consult = goalOracleState(ctx, goalAtBlock.id, fingerprint);

	// One actionable result already exists.
	if (consult.result?.disposition === "actionable") {
		if (consult.followupAttempted || hasPendingOracleAdviceForFocusedGoal(goalAtBlock.id)) return commitBlocked();
		// Re-arm without consulting again and refuse the block.
		const adviceText = renderOracleAdviceReminder({
			goalId: goalAtBlock.id,
			fingerprint,
			adviceId: consult.result.adviceId,
			text: consult.result.summary,
		});
		return goalTextResult(`${adviceText}\n\nThe goal was NOT marked blocked.`, goalAtBlock, false);
	}
	if (consult.result?.disposition === "needs_human" || consult.result?.disposition === "insufficient_context") {
		return commitBlocked();
	}
	if (consult.failedAttempts >= oracleSettings.maxFailedAttemptsPerBlocker) {
		appendBestEffort(core, ctx, {
			type: "oracle_failed",
			goalId: goalAtBlock.id,
			fingerprint,
			attempt: consult.failedAttempts,
			errorCode: consult.lastFailure?.errorCode ?? "provider",
			message: "failure limit reached; blocking with durable Oracle failure annotation",
			at: nowIso(),
		});
		return commitBlocked();
	}

	// Consult once.
	appendBestEffort(core, ctx, {
		type: "oracle_started",
		goalId: goalAtBlock.id,
		fingerprint,
		provider: oracleSettings.provider ?? "(unresolved)",
		model: oracleSettings.model ?? "(unresolved)",
		thinkingLevel: oracleSettings.thinkingLevel,
		reason: reason.slice(0, 1000),
		at: nowIso(),
	});

	const run = await runBlockerOracle({
		ctx,
		goal: goalAtBlock,
		reason,
		attemptedActions: attemptedActions.slice(0, 8),
		settings: oracleSettings as ResolvedGoalOracleSettings,
		recentEvidence: "",
	});

	if (!core.isFocusedOperationCurrent(focusToken)) {
		return core.focusedOperationCancelledResult("Blocker Oracle", focusToken);
	}

	if (!run.ok) {
		appendBestEffort(core, ctx, {
			type: "oracle_failed",
			goalId: goalAtBlock.id,
			fingerprint,
			attempt: consult.failedAttempts + 1,
			errorCode: run.errorCode,
			message: run.message.slice(0, 300),
			at: nowIso(),
		});
		if (run.errorCode === "aborted") {
			return goalTextResult("Oracle consultation was aborted; the goal remains active.", goalAtBlock, false);
		}
		const retryable = consult.failedAttempts + 1 < oracleSettings.maxFailedAttemptsPerBlocker;
		return goalTextResult(`Oracle consultation failed (${run.errorCode}): ${run.message.slice(0, 200)}${retryable ? " The goal remains active; try again or continue working." : ""}`, goalAtBlock, false);
	}

	// Persist bounded result + arm/remind per disposition.
	const advice = run.advice;
	const adviceId = armOracleAdvice(goalAtBlock.id, fingerprint, advice);
	const recommendedTitle = advice.alternatives[advice.recommendedIndex]?.title;
	appendBestEffort(core, ctx, {
		type: "oracle_result",
		goalId: goalAtBlock.id,
		fingerprint,
		adviceId,
		disposition: advice.disposition,
		summary: advice.diagnosis.slice(0, 500),
		recommendedTitle: recommendedTitle?.slice(0, 200),
		at: nowIso(),
	});

	if (advice.disposition === "needs_human" || advice.disposition === "insufficient_context") {
		consumeOracleFollowupMarker(goalAtBlock.id);
		return commitBlocked();
	}

	return goalTextResult(renderActionableOracleAdvice(advice), goalAtBlock, false);
}

/**
 * Agent-initiated immediate pause: update_goal({status: "paused"}) with a
 * required reason pauses an active goal right away and records goal_paused
 * with source "agent". It is distinct from blocked (three-consecutive-turn
 * gate) and from the user-owned pause/resume commands.
 */
export async function runGoalAgentPauseFlow(core: GoalCore, ctx: ExtensionContext, reason: string | undefined, suggestedAction: string | undefined): Promise<AgentToolResult<unknown>> {
	core.reconcileFocusedGoalFromDisk(ctx);
	const gate = validateGoalAgentPause({ goal: core.state.goal, runningGoalId: core.runningGoalId });
	if (!gate.ok) return goalTextResult(gate.message, core.state.goal);
	const trimmedReason = reason?.trim() ?? "";
	if (!trimmedReason) {
		return goalTextResult('update_goal({ status: "paused" }) requires a "reason" describing why the work is pausing.', core.state.goal);
	}
	if (!core.state.goal) throw new Error("Goal disappeared during pause validation.");
	core.accountProgress(ctx);
	const trimmedAction = suggestedAction?.trim();
	const result = core.goalService.apply(ctx, {
		reconcile: false,
		refreshFromDisk: true,
		mutate: (g) => ({
			...g,
			status: "paused" as const,
			autoContinue: false,
			stopReason: "agent" as const,
			pauseReason: trimmedReason,
			pauseSuggestedAction: trimmedAction || undefined,
			updatedAt: nowIso(),
		}),
		ledger: (written) => [{
			type: "goal_paused" as const,
			goalId: written.id,
			reason: written.pauseReason ?? trimmedReason,
			suggestedAction: written.pauseSuggestedAction,
			source: "agent",
			at: written.updatedAt,
		}],
	});
	if (!result.ok) {
		// Surface the conflict instead of claiming the goal is paused, and keep
		// the turn alive so the agent can retry.
		return goalTextResult(`Goal pause update failed: ${result.message ?? "the state mutation was rejected"}. The goal was NOT paused. Retry after resolving the conflict.`, core.state.goal, false);
	}
	core.clearContinuationState();
	core.clearActiveAccounting();
	if (result.goal) core.runtime.markTurnStopped(result.goal.id);
	core.updateUI(ctx);
	const suggestion = trimmedAction ? ` Suggested next step: ${trimmedAction}` : "";
	return {
		content: [{ type: "text", text: `Goal paused by the agent: ${trimmedReason}.${suggestion} Stop now; the user can resume with ${commandHint("goal-resume", core.loadedCommands)} or revise with ${commandHint("goal-tweak", core.loadedCommands)}.` }],
		details: goalDetails(core.state.goal, `Pause reason: ${trimmedReason}${trimmedAction ? `\nSuggested action: ${trimmedAction}` : ""}`), // E7
		terminate: true,
	};
}
