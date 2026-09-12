import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	GOAL_EVENT_ENTRY,
	assistantTurnTokens,
	extractGoalIdFromInjectedMessage,
	goalEventMessageId,
	hasAbortedAssistantMessage,
	hasErrorAssistantMessage,
	hasNetworkErrorAssistantMessage,
	isAbortedAssistantMessage,
	isErrorAssistantMessage,
	isMeaningfulProgressToolCall,
	isToolUseAssistantMessage,
} from "./goal-format.ts";
import { buildCompactionSummary, buildPostCompactionGoalDelta } from "./goal-compaction.ts";
import { latestAuditorResultForGoal, readGoalLedger, goalRuntimeEvents, invalidateGoalLedgerCache } from "./goal-ledger.ts";
import { shouldArmPostCompactReminder, shouldInjectPostCompactReminder } from "./goal-policy.ts";
import { formatTokenValue } from "./goal-core.ts";
import { loadGoalSettings, invalidateGoalSettingsCache } from "./goal-settings.ts";
import { budgetLine, budgetRemaining } from "./goal-accounting.ts";
import { asRecord, nowIso, type AssistantMessageLike, type GoalRecord } from "./goal-record.ts";
import { goalSelectorLabel, otherOpenGoalCount } from "./goal-pool.ts";
import { invalidateGoalPoolCache } from "./storage/goal-files.ts";
import { checkpointTriggerPrompt } from "./prompts/goal-prompts.ts";
import { consumeOracleFollowupMarker, hasPendingOracleAdviceForFocusedGoal } from "./goal-oracle.ts";import {
	goalPrompt,
	staleContinuationPrompt,
	unfocusedOpenGoalsPrompt,
	untrustedObjectiveBlock,
} from "./prompts/goal-prompts.ts";
import { hasActiveDraft, rehydrateDraft } from "./goal-drafting.ts";
import { syncTerminalInputPause } from "./goal-widget.ts";
import type { GoalCore } from "./goal-state.ts";
import { filterGoalSessionContext } from "./goal-session-safety.ts";
import type { GoalMutationOutcome } from "./goal-service.ts";

/**
 * Issue #30: provider-context checkpoint compaction (pure helper).
 *
 * Every historical checkpoint message is redundant: its authoritative state is
 * reconstructed from goal storage and injected once per turn by
 * before_agent_start. Normal provider requests therefore retain at most ONE
 * checkpoint marker — the latest — rewritten to the tiny bounded v2 trigger
 * content. Keeping one user-role turn-start marker avoids provider edge cases
 * where removing it would leave the request ending on an assistant or tool
 * result. Audit events, user messages, assistant messages, and tool results
 * pass through untouched.
 */
export function compactGoalCheckpointContext(
	messages: readonly unknown[],
	currentGoal: GoalRecord | null,
): unknown[] | null {
 let lastCheckpointIndex = -1;
 let checkpointGoalId: string | null = null;
 const checkpoints: number[] = [];
 // Parse each message once; retain ordinary messages and rewrite only the last marker.
 for (let i = 0; i < messages.length; i++) {
  const id = goalEventMessageId(messages[i] as {customType?: string; details?: unknown; content?: unknown});
  if (id !== null) { checkpoints.push(i); lastCheckpointIndex = i; checkpointGoalId = id; }
 }
 if (checkpointGoalId === null) return null;
 const output: unknown[] = [];
 let start = 0;
 for (const index of checkpoints) {
  for (let i = start; i < index; i++) output.push(messages[i]);
  start = index + 1;
 }
 const message = messages[lastCheckpointIndex] as Record<string, unknown>;
 output.push({...message, content: checkpointTriggerPrompt(checkpointGoalId), display: false, details: {
  version: 2,
  kind: currentGoal?.id === checkpointGoalId && currentGoal?.status === "active" ? "checkpoint" : "stale",
  goalId: checkpointGoalId, currentGoalId: currentGoal?.id ?? null, currentStatus: currentGoal?.status ?? null,
 }});
 for (let i = start; i < messages.length; i++) output.push(messages[i]);
	return output;
}

/**
 * The goal extension's lifecycle event handlers (context, turn_start,
 * tool_call, tool_execution_end, turn_end, message_end, session_start,
 * session_before_compact, session_compact, session_tree, before_agent_start,
 * agent_end, agent_settled, session_shutdown). All state flows through the
 * GoalCore.
 */
export function registerGoalEvents(core: GoalCore): void {
	const { pi } = core;
	let continuationAfterSettleFor: string | null = null;
	let networkErrorRecoveryAfterSettleFor: string | null = null;
	// Run-scoped empty-turn gate: turn_start resets the per-turn flag, so a text-only
	// last turn after earlier work must not wipe the run. before_agent_start starts a
	// new run. agent_settled must not auto-continue a run that did no goal work, or
	// empty replies ("Paused. No action.") loop forever.
	let goalWorkThisRun = false;

	pi.on("context", async (event) => {
		const filtered = filterGoalSessionContext(event.messages);
		const messages = compactGoalCheckpointContext(filtered ?? event.messages, core.state.goal) ?? filtered;
		return messages === null ? undefined : { messages: messages as typeof event.messages };
	});

	pi.on("turn_start", async (_event, ctx) => {
		// Per-turn flag resets (#4 + C9 fix).
		core.advanceTurnSeq();
		core.goalWorkToolCalledThisTurn = false;
		core.beginAccounting();
		core.goalService.beginTurn(ctx, core.focusedGoalId); // P1-3 transaction buffer
		core.touchGoalActivity(); // F5
		core.updateUI(ctx);
	});

	// #4 + C9 fix + Phase 5 C3: gate in-turn tool calls based on lifecycle state.
	pi.on("tool_call", async (event, ctx) => {
		const stoppedGoalId = core.currentTurnStoppedGoalId();
		// Post-stop in-turn block: after update_goal / set_goal_tasks (or a user
		// lifecycle command) fires in this turn, block all subsequent tool calls
		// except read-only inspection.
		if (stoppedGoalId !== null && core.runtime.isStaleCheckpointBlocked(event.toolName)) {
			return {
				block: true,
				reason: `The goal was already stopped earlier in this turn (goalId=${stoppedGoalId}). ` +
					`Do not call more tools; end the turn with a brief summary and yield to the user.`,
			};
		}
		// Stale checkpoint guard: if the turn was triggered by a queued continuation
		// for a goal that is no longer active/autoContinue, block work tools.
		const checkpointGoalId = core.runtime.getCheckpointGoalId();
		if (checkpointGoalId !== null && !core.isActionableContinuationGoal(checkpointGoalId) && core.isStaleCheckpointBlockedToolCall(event.toolName)) {
			// Block the tool call with a stale-checkpoint message.
			return {
				block: true,
				reason: `Cannot call ${event.toolName}: the goal checkpoint that triggered this turn is no longer active. ` +
					`Goal ${checkpointGoalId} has been paused, cleared, or replaced. ` +
					`End the turn with a brief summary and yield to the user.`,
			};
		}
		// Track for #4 empty-turn gate (per-turn and per-run).
		if (isMeaningfulProgressToolCall(event.toolName, asRecord(event)?.args)) {
			core.goalWorkToolCalledThisTurn = true;
			goalWorkThisRun = true;
			// Issue #26: record a meaningful work attempt against armed Oracle
			// advice. get_goal / echo-only reads are excluded upstream by
			// isMeaningfulProgressToolCall.
			const focusedId = core.focusedGoalId;
			if (focusedId && hasPendingOracleAdviceForFocusedGoal(focusedId)) {
				const armed = consumeOracleFollowupMarker(focusedId);
				if (armed) {
					try {
						core.goalService.appendEvents(ctx, [{
							type: "oracle_followup_attempted",
							goalId: armed.goalId,
							fingerprint: armed.fingerprint,
							adviceId: armed.adviceId,
							firstToolName: event.toolName,
							at: nowIso(),
						}]);
					} catch { /* best-effort ledger append */ }
				}
			}
		}
		return;
	});

	pi.on("tool_execution_end", async (_event, ctx) => {
		core.touchGoalActivity(); // F5
		core.accountProgress(ctx);
	});

	pi.on("turn_end", async (event, ctx) => {
		const message = event.message as AssistantMessageLike;
		const tokens = assistantTurnTokens(message);
		core.touchGoalActivity(); // F5
		core.accountProgress(ctx, { completedTurnTokens: tokens });

		if (isAbortedAssistantMessage(message)) {
			// Pause only on a genuine user abort (signal fired). A provider- or
			// transport-side abort without the signal routes into recovery via
			// agent_end instead of stranding the goal.
			if (ctx.signal?.aborted) core.pauseActiveGoal(ctx);
			return;
		}
		// Provider failures are not completed work: do not turn one failed turn
		// into an unbounded auto-continue retry storm. Keep the display
		// reconciled (and accounting already ran above), but never queue a
		// continuation for an error turn (danim47c pattern).
		if (isErrorAssistantMessage(message)) {
			core.refreshGoalDisplayFromDisk(ctx);
			core.updateUI(ctx);
			return;
		}
		core.refreshGoalDisplayFromDisk(ctx);

		// Archive a goal that was marked complete but whose archival was deferred
		// so the agent could see/recognize the audit result first.
		// This runs after the agent's turn ends — the agent has now seen the result.
		if (core.state.goal?.status === "complete" && !core.state.goal?.archivedPath) {
			const completedGoal = core.state.goal;
			let archiveResult: GoalMutationOutcome;
			try {
				archiveResult = core.goalService.apply(ctx, {
					reconcile: false,
					archive: true,
					commitFocused: false,
					mutate: () => completedGoal,
					ledger: (written) => [{
						type: "goal_completed",
						goalId: completedGoal.id,
						archivePath: written.archivedPath,
						at: nowIso(),
					}],
				});
			} catch (err) {
				// The archive write throws on failure (e.g. unwritable archived
				// directory); surface it as a typed outcome (follow-up Stage 3).
				archiveResult = { ok: false, message: err instanceof Error ? err.message : String(err) };
			}
			if (archiveResult.ok) {
				core.goalsById.delete(completedGoal.id);
				core.assignFocusedGoalId(null);
				core.appendFocusEntry(null, "completed");
				// §16.6: append the dedicated goal_archived event (the completion
				// transaction keeps goal_completed for compatibility) and emit the
				// real archive path.
				try {
					core.goalService.appendEvents(ctx, [{
						type: "goal_archived",
						goalId: completedGoal.id,
						archivePath: archiveResult.goal?.archivedPath ?? "",
						at: nowIso(),
					}]);
				} catch {
					// Best-effort; the archive itself already succeeded.
				}
				const path = archiveResult.goal?.archivedPath ?? "";
				ctx.ui.notify(path ? `Goal archived.\nFile: ${path}` : "Goal archived.", "info");
			} else {
				// §16.6 failure behavior: never claim success, keep the complete
				// record recoverable at its active path, and write a diagnostic
				// ledger event when possible.
				const remainingPath = completedGoal.activePath ?? "(unknown)";
				ctx.ui.notify(`Failed to archive completed goal: ${archiveResult.message}. The complete record remains at ${remainingPath}.`, "warning");
				try {
					core.goalService.appendEvents(ctx, [{
						type: "goal_archive_failed",
						goalId: completedGoal.id,
						message: archiveResult.message ?? "archive write failed",
						at: nowIso(),
					}]);
				} catch {
					// Diagnostic write is best-effort.
				}
			}
			core.updateUI(ctx);
		}

		// If the assistant ended a turn without queuing more tool calls, push a continuation right away.
		// #4: only queue if some real work was done this turn — otherwise the model is
		// just chatting and we should not keep firing turns on noise.
		if (
			!isToolUseAssistantMessage(message)
			&& core.state.goal?.status === "active"
			&& core.state.goal.autoContinue
			&& core.goalWorkToolCalledThisTurn
		) {
			core.queueContinuation(ctx);
		}
		core.goalService.endTurn(ctx); // P1-3: single flush (lock + write + ledger batch)
	});

	pi.on("message_end", async (event, ctx) => {
		// Signal-aware: see turn_end — only user aborts pause; provider-side
		// aborts are handled by agent_end's recovery path.
		if (isAbortedAssistantMessage(event.message) && ctx.signal?.aborted) core.pauseActiveGoal(ctx);
		const raw = asRecord(event.message);
		if (raw?.role === "custom" && raw.customType === GOAL_EVENT_ENTRY && raw.display !== false) {
			return { message: { ...event.message, display: false } as typeof event.message };
		}
	});

	pi.on("session_start", async (event, ctx) => {
		core.auditMessages.clear();
		// NAF: the zero-op read caches are session-scoped — a new session always
		// re-reads settings/pool/ledger fresh from disk (cross-process and
		// hand-edited changes are picked up at the session boundary).
		invalidateGoalSettingsCache();
		invalidateGoalPoolCache();
		invalidateGoalLedgerCache();
		core.goalService.flushTurn(ctx); // P1-3: persist any buffered transaction before reload
		await core.loadState(ctx);
		core.installGoalToolProfile(!loadGoalSettings(ctx.cwd).disableTasks);
		rehydrateDraft(core, ctx);
		syncTerminalInputPause(core, ctx);
		if (event.reason === "resume" && !core.state.goal && !core.hasExplicitSessionFocus && otherOpenGoalCount(core.goalsById, null) > 1 && ctx.hasUI) {
			// Prompt the user to pick which open goal to focus (mirrors /goal-focus).
			const open = core.openGoals();
			const labels = open.map((item) => goalSelectorLabel(item, core.focusedGoalId));
			const byLabel = new Map(labels.map((label, index) => [label, open[index]?.id]));
			core.enterGoalModal();
			try {
				const selected = await ctx.ui.select("Focus open goal", labels);
				const selectedId = selected ? byLabel.get(selected) : undefined;
				if (selectedId) {
					core.setFocusedGoalId(selectedId, ctx, "selected");
					core.armFocusedContinuation(ctx);
				}
			} finally {
				core.exitGoalModal();
			}
		}
		// Codex behavior: prompt before reactivating a paused goal on resume.
		if (event.reason === "resume" && core.state.goal?.status === "paused" && ctx.hasUI) {
			const current = core.state.goal;
			const shouldResume = await ctx.ui.confirm("Resume paused goal?", `Goal: ${current.objective}`);
			if (shouldResume) {
				core.setGoal({ ...current, status: "active", autoContinue: true, stopReason: undefined, pauseReason: undefined, pauseSuggestedAction: undefined }, ctx);
			}
		}
		core.beginAccounting();
		core.queueContinuation(ctx, true);
	});

	pi.on("session_before_compact", async (_event, ctx) => {
		core.accountProgress(ctx);
	});

	pi.on("session_compact", async (_event, ctx) => {
		core.goalService.flushTurn(ctx); // P1-3: persist any buffered transaction before reload
		if (core.state.goal) core.persist(ctx);
		core.beginAccounting();
		// Arm a deterministic compaction summary for the next agent turn.
		// This replaces the generic reminder with artifact-backed state.
		if (shouldArmPostCompactReminder(core.state.goal)) {
			core.runtime.armPostCompactReminder();
		}
		core.queueContinuation(ctx, true);
	});

	pi.on("session_tree", async (_event, ctx) => {
		core.auditMessages.clear();
		core.goalService.flushTurn(ctx); // P1-3: persist any buffered transaction before reload
		await core.loadState(ctx);
		rehydrateDraft(core, ctx);
		syncTerminalInputPause(core, ctx);
		core.beginAccounting();
		core.queueContinuation(ctx, true);
	});

	pi.on("before_agent_start", async (event, ctx) => {
		goalWorkThisRun = false;
		core.advanceTurnSeq();
  if (!hasActiveDraft(core)) core.installGoalToolProfile(!loadGoalSettings(ctx.cwd).disableTasks);
		const currentSystemPrompt = () => ctx.getSystemPrompt?.() || event.systemPrompt;
		const incomingGoalId = extractGoalIdFromInjectedMessage(event.prompt ?? "");
		// Several prompt enrichments may need the same ledger snapshot. Keep one
		// local read for this hook instead of repeatedly traversing the cached
		// ledger when rejection and post-compaction steering overlap.
		let promptLedger: ReturnType<typeof readGoalLedger> | undefined;
		const getPromptLedger = () => promptLedger ??= { events: core.state.goal ? goalRuntimeEvents(ctx, core.state.goal.id) : [], malformed: 0 };

		// If this turn was triggered by a hidden goal checkpoint that no longer
		// matches the active goal, abort the whole turn instead of letting the
		// model act on a stale instruction.
		if (incomingGoalId !== null) {
			// Reconcile from disk to pick up any external state changes before
			// evaluating whether the checkpoint is actionable.
			core.reconcileFocusedGoalFromDisk(ctx);
			core.runtime.setCheckpoint(incomingGoalId);
			// This can be the hidden checkpoint dispatched by the network-error
			// timer. Clear ordinary continuation bookkeeping but retain the
			// consecutive recovery count for a later failed retry.
			core.clearContinuationState(false);
			if (!core.isActionableContinuationGoal(incomingGoalId)) {
				try {
					ctx.abort?.();
				} catch {}
				core.updateUI(ctx);
				return {
					systemPrompt: `${currentSystemPrompt()}\n\n${staleContinuationPrompt(incomingGoalId, core.state.goal)}`,
				};
			}
			core.runtime.setCheckpoint(null);
		} else {
			// A user-driven turn — clear any queued continuation so we don't
			// double-fire after the user's own message returns. Also reset the
			// autoContinue nudge state so the user always gets a fresh chain.
			core.runtime.setCheckpoint(null);
			core.clearContinuationState();
			networkErrorRecoveryAfterSettleFor = null;
		}

		if (!core.state.goal) {
			core.runningGoalId = null;
			const openCount = otherOpenGoalCount(core.goalsById, null);
			if (openCount > 0) {
				return { systemPrompt: `${currentSystemPrompt()}\n\n${unfocusedOpenGoalsPrompt(openCount)}` };
			}
			return;
		}
		core.reconcileFocusedGoalFromDisk(ctx);
		if (!core.state.goal) {
			core.runningGoalId = null;
			const openCount = otherOpenGoalCount(core.goalsById, null);
			if (openCount > 0) return { systemPrompt: `${currentSystemPrompt()}\n\n${unfocusedOpenGoalsPrompt(openCount)}` };
			return;
		}
		core.runningGoalId = core.state.goal.status === "active" ? core.state.goal.id : null;
		if (core.state.goal.status === "complete") return;
		if (core.state.goal.status === "paused") {
			const current = core.state.goal;
			const pauseExtras: string[] = [];
			if (current.stopReason === "agent") {
				pauseExtras.push("");
				pauseExtras.push(`Pause reason: ${current.pauseReason ?? "(unknown)"}`);
				if (current.pauseSuggestedAction) pauseExtras.push(`Suggested action: ${current.pauseSuggestedAction}`);
			}
				// Inject durable auditor feedback if available
				let auditorExtra = "";
				try {
					const ledger = getPromptLedger();
				const auditorResult = latestAuditorResultForGoal(ledger.events, current.id);
				if (auditorResult && auditorResult.verdict === "disapproved") {
					auditorExtra = `\n\n[AUDITOR REJECTION] An independent auditor previously rejected a completion request for this goal. Reason: ${auditorResult.report.slice(0, 300)}\nAddress the auditor's objections before requesting completion again.`;
				}
			} catch {
				// Ledger read failure should not break the prompt
			}
			return {
				systemPrompt: `${currentSystemPrompt()}\n\n[PI GOAL PAUSED goalId=${current.id}]\n${untrustedObjectiveBlock(current)}${pauseExtras.join("\n")}${auditorExtra}\n\nThe goal is paused. Do not autonomously continue substantive work unless the user resumes it with /goal-resume. If the user explicitly asks to finish the paused goal and the objective is already satisfied based on available evidence, you may call update_goal({status: "complete"}). To abandon a goal, the user runs /goal-clear. Do not report the goal blocked in response to a pause.`,
			};
		}
		// Token-budget-limited goals get one-time wrap-up steering: summarize,
		// do not start new substantive work, never claim completion unless real.
		if (core.state.goal?.status === "budget_limited") {
			const limitedGoal = core.state.goal;
			const budgetText = budgetLine(limitedGoal);
			// E4: surface the remaining-vs-overshoot fact in the wrap-up steering.
			const remaining = budgetRemaining(limitedGoal);
			const balanceText = typeof remaining === "number"
				? remaining < 0
					? ` — ${formatTokenValue(-remaining)} over the budget`
					: ` — ${formatTokenValue(remaining)} remaining`
				: "";
			const reminder = core.runtime.consumePostBudgetReminder()
				? `\n\n[TOKEN BUDGET REACHED goalId=${limitedGoal.id}]\nThe goal's token budget has been reached${budgetText ? ` (${budgetText}${balanceText})` : ""}. Wrap up the current work in one final response: summarize what was accomplished and what remains, do not start new substantive work, and do not claim the goal is complete unless it actually is. To continue, the user must raise or remove the budget and resume the goal.`
				: "";
			return {
				systemPrompt: `${currentSystemPrompt()}\n\n[PI GOAL BUDGET LIMITED goalId=${limitedGoal.id}]\n${untrustedObjectiveBlock(limitedGoal)}${budgetText ? `\n${budgetText}` : ""}${reminder}`,
			};
		}
  if (core.state.goal.status === "blocked") {
   const blocked = core.state.goal;
   return {systemPrompt: `${currentSystemPrompt()}\n\n[PI GOAL BLOCKED goalId=${blocked.id}]\n${untrustedObjectiveBlock(blocked)}\nBlocker: ${blocked.pauseReason ?? "unspecified"}\nThe goal is blocked; the user must run /goal-resume before goal work continues.`};
  }
		const activeGoal = core.state.goal;
		const settings = loadGoalSettings(ctx.cwd);
		let prompt = goalPrompt(activeGoal, settings);
		// F5: [GOAL STALLED] steering note when the detector fired.
		const stalledNote = core.checkStall(ctx);
		if (stalledNote) prompt += stalledNote;
		// Inject durable auditor feedback if the latest result was a rejection
		try {
			const ledger = getPromptLedger();
			const auditorResult = latestAuditorResultForGoal(ledger.events, activeGoal.id);
			if (auditorResult && auditorResult.verdict === "disapproved" && ledger.events.some((e) => e.type === "completion_requested" && e.goalId === activeGoal.id)) {
				prompt = `${prompt}\n\n[AUDITOR REJECTION goalId=${activeGoal.id}]\nAn independent auditor previously rejected a completion request for this goal. Reason: ${auditorResult.report.slice(0, 300)}\nAddress the auditor's objections before requesting completion again.`;
			}
		} catch {
			// Ledger read failure should not break the prompt
		}
		if (core.runtime.isPostCompactReminderPending() && shouldInjectPostCompactReminder({ pending: true, goal: activeGoal })) {
			core.runtime.clearPostCompactReminder();
			// PR E §62: post-compaction DELTA — the active system goal block already
			// carries objective/policy/task gate/contract; inject only what
			// compaction may have lost. Falls back to a generic note on ledger
			// read failure.
			try {
				const ledger = getPromptLedger();
				const otherOpenCount = core.openGoals().filter((g) => g.id !== activeGoal.id).length;
				const delta = buildPostCompactionGoalDelta({ goal: activeGoal, ledgerEvents: ledger.events, otherOpenCount });
				prompt = `${prompt}\n\n${delta}`;
			} catch {
				prompt = `${prompt}\n\n[POST-COMPACTION RESYNC goalId=${core.state.goal.id}]\nThe conversation was just compacted. Re-read the objective and continue from the actual artifacts/state; do not rely on memory of the prior chat.`;
			}
		}
		return { systemPrompt: `${currentSystemPrompt()}\n\n${prompt}` };
	});

	pi.on("agent_end", async (event, ctx) => {
		const endedGoalId = core.runningGoalId;
		core.runningGoalId = null;
		continuationAfterSettleFor = null;
		networkErrorRecoveryAfterSettleFor = null;

		// Account for any tokens from aborted in-flight assistant messages so
		// they are not silently lost (but charge them to the original goal).
		const abortedTokens = event.messages
			.filter(isAbortedAssistantMessage)
			.reduce((sum, message) => sum + assistantTurnTokens(message), 0);
		if (abortedTokens > 0 && endedGoalId && core.state.goal?.id === endedGoalId) {
			core.accountProgress(ctx, { completedTurnTokens: abortedTokens });
		}

		// Keep any prior recovery attempt while Pi finishes its own automatic
		// retries. A user-driven path resets it through the default argument.
		core.runtime.clearContinuationState(false);
		if (!core.state.goal || core.state.goal.status !== "active" || !core.state.goal.autoContinue) return;
		if (endedGoalId && core.state.goal.id !== endedGoalId) return;
		if (!core.reconcileFocusedGoalFromDisk(ctx)) return;
		// A genuine user abort pauses the goal. An assistant message with
		// stopReason "aborted" WITHOUT a user abort signal is a provider- or
		// transport-side termination (e.g. after Pi exhausts its retries) —
		// pausing there stranded goals during outages, so it routes into the
		// same bounded recovery as classified transient errors instead.
		if (ctx.signal?.aborted) {
			core.pauseActiveGoal(ctx);
			return;
		}
		// Provider failures are not completed work: persist and refresh the
		// display, but never queue a continuation for a run whose messages
		// include an assistant error (danim47c pattern).
		if (hasNetworkErrorAssistantMessage(event.messages) || hasAbortedAssistantMessage(event.messages)) {
			core.persist(ctx);
			core.updateUI(ctx);
			networkErrorRecoveryAfterSettleFor = core.state.goal.id;
			return;
		}
		if (hasErrorAssistantMessage(event.messages)) {
			core.persist(ctx);
			core.updateUI(ctx);
			return;
		}
		core.runtime.clearNetworkErrorBackoff();
		core.persist(ctx);
		core.updateUI(ctx);
		// Empty-turn gate: agent_end clears any turn_end continuation timer, then
		// agent_settled re-queues with force=true. Without this check, a no-tool
		// reply (chat, or "Paused. No action." after resume) loops forever.
		if (!goalWorkThisRun) return;
		// agent_end runs before pi finishes retries, compaction, terminating-tool
		// settlement, and queued messages. Starting the continuation timer here
		// can poll a stale busy context for minutes on pi 0.84. agent_settled is
		// available in both supported SDK lines (0.83 and 0.84) and is the first
		// point where pi guarantees no automatic work remains.
		continuationAfterSettleFor = core.state.goal.id;
	});

	pi.on("agent_settled", async (_event, ctx) => {
		core.auditMessages.flush(ctx, pi);
		const goalId = continuationAfterSettleFor;
		continuationAfterSettleFor = null;
		const networkErrorGoalId = networkErrorRecoveryAfterSettleFor;
		networkErrorRecoveryAfterSettleFor = null;
		if (goalId && core.isActionableContinuationGoal(goalId)) {
			core.queueContinuation(ctx, true);
			return;
		}
		if (!networkErrorGoalId || !core.isActionableContinuationGoal(networkErrorGoalId)) return;
		const recovery = loadGoalSettings(ctx.cwd).networkRecovery;
		const policy = recovery
			? { maxAttempts: recovery.maxAttempts, maxDelayMs: recovery.maxDelayMs }
			: undefined;
		const plan = core.runtime.scheduleNetworkErrorRetry(ctx, core.state.goal!, policy);
		if (plan) {
			const cap = plan.maxAttempts > 0 ? `/${plan.maxAttempts}` : ", unbounded";
			ctx.ui.notify(
				`Provider network error. Retrying the goal in ${Math.round(plan.delayMs / 1000)}s (recovery ${plan.attempt}${cap}).`,
				"warning",
			);
			return;
		}
		// Only reachable under a configured bounded cap (maxAttempts > 0).
		ctx.ui.notify(
			"Provider network errors persisted after all recovery attempts. The goal remains active; resume it when the provider is healthy.",
			"warning",
		);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		core.auditMessages.clear();
		continuationAfterSettleFor = null;
		networkErrorRecoveryAfterSettleFor = null;
		core.accountProgress(ctx);
		core.clearContinuationState();
		core.terminalInputUnsubscribe?.();
		core.terminalInputUnsubscribe = null;
		if (core.state.goal) core.persist(ctx);
	});
}
