import { cacheGoalHistory } from "./goal-prompt-cache.ts";
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
} from "./goal-format.ts";
import { buildCompactionSummary, buildPostCompactionGoalDelta } from "./goal-compaction.ts";
import { latestAuditorResultForGoal, readGoalLedger, goalRuntimeEvents, invalidateGoalLedgerCache } from "./goal-ledger.ts";
import { shouldArmPostCompactReminder, shouldInjectPostCompactReminder } from "./goal-policy.ts";
import { formatTokenValue } from "./goal-core.ts";
import { loadGoalSettings, invalidateGoalSettingsCache } from "./goal-settings.ts";
import { modelBudgetLine, budgetRemaining } from "./goal-accounting.ts";
import { asRecord, nowIso, type AssistantMessageLike, type GoalRecord } from "./goal-record.ts";
import { goalSelectorLabel, otherOpenGoalCount } from "./goal-pool.ts";
import { invalidateGoalPoolCache } from "./storage/goal-files.ts";
import { checkpointTriggerPrompt } from "./prompts/goal-prompts.ts";
import { consumeOracleFollowupMarker, hasPendingOracleAdviceForFocusedGoal } from "./goal-oracle.ts";
import { LiveTailRetention } from "./goal-live-retention.ts";
import {
	goalPromptParts,
	backgroundTaskNotice,
	backgroundTaskWaitPrompt,
	staleContinuationPrompt,
	unfocusedOpenGoalsPrompt,
	untrustedObjectiveBlock,
} from "./prompts/goal-prompts.ts";
import { hasActiveDraft, rehydrateDraft } from "./goal-drafting.ts";
import { syncTerminalInputPause } from "./goal-widget.ts";
import type { GoalCore } from "./goal-state.ts";
import { filterGoalSessionContext } from "./goal-session-safety.ts";
import type { GoalMutationOutcome } from "./goal-service.ts";

/** Normalize checkpoints independently: deleting old markers shifts the cached prefix. */
export function compactGoalCheckpointContext(
 messages: readonly unknown[],
 _currentGoal: GoalRecord | null,
): unknown[] | null {
 let output: unknown[] | null = null;
 for (let i = 0; i < messages.length; i++) {
  const message = messages[i] as { customType?: string; details?: unknown; content?: unknown };
  const id = goalEventMessageId(message);
  if (id === null) { output?.push(message); continue; }
  output ??= messages.slice(0, i);
  output.push({ ...message, content: checkpointTriggerPrompt(id), display: false,
   details: { version: 2, kind: "checkpoint", goalId: id } });
 }
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
	// Transients are keyed per session: the context hook of session B must never
	// overwrite the set that session A's provider request will consume.
	const liveRetention = new LiveTailRetention();
	const sessionKeyFor = (ctx?: ExtensionContext): string =>
		ctx?.sessionManager?.getSessionId?.() ? JSON.stringify([ctx.sessionManager.getSessionId(), ctx.model?.provider, ctx.model?.id]) : "unidentified";
	pi.on("before_provider_request", (event, ctx) => cacheGoalHistory(event.payload, liveRetention.contents(sessionKeyFor(ctx as ExtensionContext | undefined))));
	let continuationAfterSettleFor: string | null = null;
	let networkErrorRecoveryAfterSettleFor: string | null = null;

	pi.on("context", async (event, ctx) => {
		const filtered = filterGoalSessionContext(event.messages);
		const messages = compactGoalCheckpointContext(filtered ?? event.messages, core.state.goal) ?? filtered;
		const base = messages ?? event.messages;
		const sessionKey = sessionKeyFor(ctx);
		if (sessionKey === "unidentified") liveRetention.clear(sessionKey);
		const parts = currentGoalContextParts(ctx);
		if (parts) {
			// Retain previously sent tails verbatim at their anchors so this
			// request extends the previous one instead of displacing its tail.
			// Only genuinely new state/counters content is appended.
			const { messages: retained } = liveRetention.apply(sessionKey, base, { state: parts.state, counters: parts.counters });
			return { messages: retained as typeof event.messages };
		}
		liveRetention.clear(sessionKey);
		return messages === null ? undefined : { messages: messages as typeof event.messages };
	});

	pi.on("agent_start", async (_event, ctx) => { core.scheduler.begin(ctx); });
	pi.on("message_start", async (event, ctx) => { core.scheduler.message(ctx, event.message); });
	pi.on("turn_start", async (_event, ctx) => {
		core.scheduler.turn(ctx);
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
		if (core.scheduler.isDenied()) return { block: true, reason: "Stale goal dispatch; use /goal-resume." };
		// A second wait on a task the goal already sleeps on would only burn runs:
		// pi reports the result on its own and the goal wakes for it.
		// The pinned pi API carries tool arguments on `input` (ToolCallEventBase),
		// never on `args`.
		if (core.scheduler.blocksTaskPoll(event.toolName, event.input)) {
			return {
				block: true,
				reason: `The goal is waiting on this background task, and its result is reported automatically. ` +
					`Do not wait on ${event.toolName} again — end the turn with a one-line status. ` +
					`Use stop to cancel the task if that is now the intent.`,
			};
		}
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
		// Track Oracle work attempts; this does not authorize scheduling.
		if (isMeaningfulProgressToolCall(event.toolName, event.input)) {
			core.goalWorkToolCalledThisTurn = true;
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

	// Detached work is a wait, not a disposition. The notice teaches the model to
	// stop at the moment it starts a long task instead of polling it turn after
	// turn; the wait itself is raised at settlement, once the turn is over.
	pi.on("tool_result", async (event, _ctx) => {
		const task = core.scheduler.noteToolResult(event);
		if (!task) return;
		return { content: [...event.content, { type: "text" as const, text: backgroundTaskNotice(task) }] };
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
				core.scheduler.resume(ctx);
			}
		}
		core.beginAccounting();
		core.scheduler.restore(ctx);
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
		core.scheduler.restore(ctx);
	});

	pi.on("before_agent_start", async (event, ctx) => {
		core.advanceTurnSeq();
  if (!hasActiveDraft(core)) core.installGoalToolProfile(!loadGoalSettings(ctx.cwd).disableTasks);
		const incomingGoalId = extractGoalIdFromInjectedMessage(event.prompt ?? "");

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
				return;
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

		core.reconcileFocusedGoalFromDisk(ctx);
		core.runningGoalId = core.state.goal?.status === "active" ? core.state.goal.id : null;
	});

	/** Request-only state: no live counters, focus, or reminders enter the system prefix. */
	/** Request-only goal state split into a rarely-changing policy block and per-turn counters. Other branches are stable-only. */
	function currentGoalContextParts(ctx: ExtensionContext): { state: string; counters?: string } | undefined {
		const checkpoint = core.runtime.getCheckpointGoalId();
		if (checkpoint !== null && !core.isActionableContinuationGoal(checkpoint)) {
			return { state: staleContinuationPrompt(checkpoint, core.state.goal) };
		}
		// Several prompt enrichments may need the same ledger snapshot. Keep one
		// local read for this hook instead of repeatedly traversing the cached
		// ledger when rejection and post-compaction steering overlap.
		let promptLedger: ReturnType<typeof readGoalLedger> | undefined;
		const getPromptLedger = () => promptLedger ??= { events: core.state.goal ? goalRuntimeEvents(ctx, core.state.goal.id) : [], malformed: 0 };

		if (!core.state.goal) {
			// Issue #72: hideUnfocusedPrompt opts out of the model-facing
			// unfocused reminder only. The stale-checkpoint guard above and
			// all focused-goal context below are unaffected.
			if (loadGoalSettings(ctx.cwd).hideUnfocusedPrompt === true) return;
			const openCount = otherOpenGoalCount(core.goalsById, null);
			if (openCount > 0) {
				return { state: unfocusedOpenGoalsPrompt(openCount) };
			}
			return;
		}
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
		return { state: `[PI GOAL PAUSED goalId=${current.id}]\n${untrustedObjectiveBlock(current)}${pauseExtras.join("\n")}${auditorExtra}\n\nThe goal is paused. Do not autonomously continue substantive work unless the user resumes it with /goal-resume. If the user explicitly asks to finish the paused goal and the objective is already satisfied based on available evidence, you may call update_goal({status: "complete"}). To abandon a goal, the user runs /goal-clear. Do not report the goal blocked in response to a pause.` };
		}
		// Token-budget-limited goals get one-time wrap-up steering: summarize,
		// do not start new substantive work, never claim completion unless real.
		if (core.state.goal?.status === "budget_limited") {
			const limitedGoal = core.state.goal;
			const budgetText = modelBudgetLine(limitedGoal);
			// E4: surface the remaining-vs-overshoot fact in the wrap-up steering.
			const remaining = budgetRemaining(limitedGoal);
			const balanceText = typeof remaining === "number"
				? remaining < 0
					? ` — ${formatTokenValue(-remaining)} over the budget`
					: ` — ${formatTokenValue(remaining)} remaining`
				: "";
			const reminder = core.runtime.consumePostBudgetReminder()
				? `\n\n[TOKEN BUDGET REACHED goalId=${limitedGoal.id}]\nThe goal's lifetime token-spending cap (not context capacity) has been reached${budgetText ? ` (${budgetText}${balanceText})` : ""}. Wrap up the current work in one final response: summarize what was accomplished and what remains, do not start new substantive work, and do not claim the goal is complete unless it actually is. To continue, the user can use /goal-tweak to raise or remove the token budget.`
				: "";
		return { state: `[PI GOAL BUDGET LIMITED goalId=${limitedGoal.id}]\n${untrustedObjectiveBlock(limitedGoal)}${budgetText ? `\n${budgetText}` : ""}${reminder}` };
		}
  if (core.state.goal.status === "blocked") {
   const blocked = core.state.goal;
   return { state: `[PI GOAL BLOCKED goalId=${blocked.id}]\n${untrustedObjectiveBlock(blocked)}\nBlocker: ${blocked.pauseReason ?? "unspecified"}\nThe goal is blocked; the user must run /goal-resume before goal work continues.` };
  }
		const activeGoal = core.state.goal;
		const settings = loadGoalSettings(ctx.cwd);
		const { state: policy, counters } = goalPromptParts(activeGoal, settings, ctx.getContextUsage?.());
		// Rare transitional steering rides in the stable block; per-turn usage and
		// scheduling counters stay in the volatile block so retention grows slowly.
		let state = policy;
		// A task wait is system-managed: say so on every turn it spans, including
		// the scheduled re-check and the turn a task result opens.
		const taskWait = activeGoal.scheduler?.phase === "waiting" ? activeGoal.scheduler.wait : undefined;
		if (taskWait?.taskId !== undefined) {
			state += `\n\n${backgroundTaskWaitPrompt({ taskId: taskWait.taskId, reason: taskWait.reason })}`;
		}
		// F5: [GOAL STALLED] steering note when the detector fired.
		const stalledNote = core.checkStall(ctx);
		if (stalledNote) state += stalledNote;
		// Inject durable auditor feedback if the latest result was a rejection
		try {
			const ledger = getPromptLedger();
			const auditorResult = latestAuditorResultForGoal(ledger.events, activeGoal.id);
			if (auditorResult && auditorResult.verdict === "disapproved" && ledger.events.some((e) => e.type === "completion_requested" && e.goalId === activeGoal.id)) {
				state = `${state}\n\n[AUDITOR REJECTION goalId=${activeGoal.id}]\nAn independent auditor previously rejected a completion request for this goal. Reason: ${auditorResult.report.slice(0, 300)}\nAddress the auditor's objections before requesting completion again.`;
			}
		} catch {
			// Ledger read failure should not break the prompt
		}
		if (core.runtime.isPostCompactReminderPending() && shouldInjectPostCompactReminder({ pending: true, goal: activeGoal })) {
			core.runtime.clearPostCompactReminder();
			// PR E §62: post-compaction DELTA — the current goal block already
			// carries objective/policy/task gate/contract; inject only what
			// compaction may have lost. Falls back to a generic note on ledger
			// read failure.
			try {
				const ledger = getPromptLedger();
				const otherOpenCount = core.openGoals().filter((g) => g.id !== activeGoal.id).length;
				const delta = buildPostCompactionGoalDelta({ goal: activeGoal, ledgerEvents: ledger.events, otherOpenCount });
				state = `${state}\n\n${delta}`;
			} catch {
				state = `${state}\n\n[POST-COMPACTION RESYNC goalId=${core.state.goal.id}]\nThe conversation was just compacted. Re-read the objective and continue from the actual artifacts/state; do not rely on memory of the prior chat.`;
			}
		}
		return { state, counters };
	}

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
		core.scheduler.settled(ctx, !!goalId && core.isActionableContinuationGoal(goalId));
		if (goalId && core.isActionableContinuationGoal(goalId)) return;
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
		core.scheduler.shutdown();
		continuationAfterSettleFor = null;
		networkErrorRecoveryAfterSettleFor = null;
		core.accountProgress(ctx);
		core.clearContinuationState();
		core.terminalInputUnsubscribe?.();
		core.terminalInputUnsubscribe = null;
		if (core.state.goal) core.persist(ctx);
		core.clearGoalWidget(ctx); // Cancel UI work queued by final accounting before ctx is invalidated.
		liveRetention.clear(sessionKeyFor(ctx));
	});
}
