import { goalStorageContext, type GoalStorageContext } from "./storage/goal-root.ts";
import { commandHint, commandInstructions } from "./goal-controls.ts";
import { FIVE_GOAL_TOOLS } from "./goal-tool-names.ts";
import { cacheGoalHistory } from "./goal-prompt-cache.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	GOAL_EVENT_ENTRY,
	assistantTurnTokens,
	extractGoalIdFromInjectedMessage,
	goalEventMessageId,
	hasAbortedAssistantMessage,
	hasErrorAssistantMessage,
	providerErrorText,
	hasNetworkErrorAssistantMessage,
	isAbortedAssistantMessage,
	isErrorAssistantMessage,
	isMeaningfulProgressToolCall,
} from "./goal-format.ts";
import { invalidateGoalLedgerCache, type GoalLedgerEvent } from "./goal-ledger.ts";
import { shouldArmPostCompactReminder } from "./goal-policy.ts";
import { invalidateGoalSettingsCache } from "./settings/files.ts";
import { loadGoalSettings } from "./settings/resolve.ts";
import { configureLocale } from "./i18n/locales.ts";
import { asRecord, nowIso, type AssistantMessageLike, type GoalRecord } from "./goal-record.ts";
import { goalSelectorLabel, otherOpenGoalCount } from "./goal-pool.ts";
import { invalidateGoalPoolCache } from "./storage/goal-files.ts";
import { checkpointTriggerPrompt } from "./prompts/goal-prompts.ts";
import { consumeOracleFollowupMarker, hasPendingOracleAdviceForFocusedGoal } from "./goal-oracle.ts";
import { LiveTailRetention } from "./goal-live-retention.ts";
import { goalContextParts } from "./goal-context-parts.ts";
import { hasActiveDraft, rehydrateDraft } from "./goal-drafting.ts";
import { syncTerminalInputPause } from "./goal-terminal-input.ts";
import type { GoalContextCore } from "./goal-context-parts.ts";
import type {
	FocusSlice,
	GoalAuditQueue,
	GoalContinuationControl,
	GoalControlWarnings,
	GoalDiskSync,
	GoalLoadedCommands,
	GoalModalAccess,
	GoalRunControl,
	GoalSessionHandles,
	GoalToolProfile,
	GoalUiRefresh,
	HostSlice,
	InterruptionSlice,
	LifecycleSlice,
	ProgressSlice,
	RuntimeSlice,
	SchedulerSlice,
	ServiceSlice,
	StateSlice,
	ViewSlice,
	WatchSlice,
} from "./goal-core-types.ts";
import type { TerminalInputCore } from "./goal-terminal-input.ts";

/** What the host event handlers read and change. */
export type GoalEventsCore = GoalContextCore &
	TerminalInputCore &
	GoalAuditQueue &
	GoalContinuationControl &
	GoalControlWarnings &
	GoalDiskSync &
	GoalLoadedCommands &
	GoalModalAccess &
	GoalRunControl &
	GoalSessionHandles &
	GoalToolProfile &
	GoalUiRefresh &
	HostSlice<"on" | "appendEntry" | "sendMessage"> &
	StateSlice<"assignFocusedGoalId" | "cacheStats" | "goalWorkToolCalledThisTurn" | "hasExplicitSessionFocus" | "invalidate"> &
	FocusSlice<"appendEntry" | "load" | "setFocus"> &
	ServiceSlice<"appendEvents" | "apply" | "beginTurn" | "endSession" | "endTurn" | "flushTurn" | "persist"> &
	InterruptionSlice<"continueWithUser" | "finishTurn" | "ignoreAbort" | "isHeld" | "reset" | "settled"> &
	LifecycleSlice<"persist" | "refreshDisplayFromDisk"> &
	ProgressSlice<"begin" | "charge"> &
	RuntimeSlice<
		| "advanceTurn"
		| "armPostCompactReminder"
		| "clearContinuationState"
		| "clearNetworkErrorBackoff"
		| "currentTurnStoppedGoalId"
		| "isStaleCheckpointBlocked"
		| "scheduleNetworkErrorRetry"
		| "setCheckpoint"
	> &
	SchedulerSlice<"begin" | "isDenied" | "message" | "noteTool" | "pauseForError" | "recordWork" | "rejectCheckpoint" | "restore" | "resume" | "schedule" | "settled" | "shutdown" | "turn"> &
	ViewSlice<"clear" | "clearAuditResult" | "stopAuditAnimation"> &
	WatchSlice<"touchActivity">;
import { filterGoalSessionContext, isStaleExtensionContextError } from "./goal-session-safety.ts";
import { registerGoalContext } from "./goal-context.ts";
import type { GoalMutationOutcome } from "./goal-service.ts";
import { t } from "./i18n/index.ts";

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

/** Archive a goal marked complete whose archival was deferred, reporting success or failure to the user and ledger. */
function archiveCompletedGoal(core: GoalEventsCore, ctx: ExtensionContext, completedGoal: GoalRecord): void {
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
		core.state.goalsById.delete(completedGoal.id);
		core.state.assignFocusedGoalId(null);
		core.focus.appendEntry(null, "completed");
		const path = archiveResult.goal?.archivedPath ?? "";
		// Log goal_archived with the real archive path; the completion
		// transaction still writes goal_completed. Best-effort: the archive
		// itself already succeeded.
		appendBestEffort(core, ctx, { type: "goal_archived", goalId: completedGoal.id, archivePath: path, at: nowIso() });
		ctx.ui.notify(path ? t("Goal archived.\nFile: {path}", { path }) : t("Goal archived."), "info");
		return;
	}
	// Never claim success: the complete record stays at its active path,
	// and we log a diagnostic event when we can.
	const remainingPath = completedGoal.activePath ?? "(unknown)";
	ctx.ui.notify(t("Failed to archive completed goal: {message}. The complete record remains at {path}.", { message: archiveResult.message ?? "", path: remainingPath }), "warning");
	appendBestEffort(core, ctx, { type: "goal_archive_failed", goalId: completedGoal.id, message: archiveResult.message ?? "archive write failed", at: nowIso() });
}

function appendBestEffort(core: GoalEventsCore, ctx: ExtensionContext, event: GoalLedgerEvent): void {
	try {
		core.goalService.appendEvents(ctx, [event]);
	} catch {
		// Diagnostic ledger writes are best-effort.
	}
}

/**
 * The goal extension's lifecycle event handlers (context, turn_start,
 * tool_call, tool_execution_end, turn_end, message_end, session_start,
 * session_before_compact, session_compact, session_tree, before_agent_start,
 * agent_end, agent_settled, session_shutdown). All state flows through the
 * GoalCore.
 */
export function registerGoalEvents(core: GoalEventsCore): void {
	const { pi } = core;
	// Transients are keyed per session: the context hook of session B must never
	// overwrite the set that session A's provider request will consume.
	const liveRetention = new LiveTailRetention();
	const managerNumbers = new WeakMap<object, number>();
	let managersSeen = 0;
	const managerNumber = (manager: object): number => {
		let number = managerNumbers.get(manager);
		if (number === undefined) managerNumbers.set(manager, number = ++managersSeen);
		return number;
	};
	const sessionKeyFor = (ctx?: ExtensionContext): string => {
		const manager = ctx?.sessionManager;
		// A host that gives no session id still gives the same manager object for
		// the whole session, so use that rather than retaining nothing.
		const id = manager?.getSessionId?.() || (manager && typeof manager === "object" ? `manager-${managerNumber(manager)}` : undefined);
		return id ? JSON.stringify([id, ctx?.model?.provider, ctx?.model?.id]) : "unidentified";
	};
	type SessionOwner = {ctx: ExtensionContext; manager: ExtensionContext["sessionManager"]; storage: GoalStorageContext; keys: Set<string>};
	let session: SessionOwner | undefined;
	const contexts = new WeakMap<object, SessionOwner>();
	const leases = new Map<string, SessionOwner>();
	/** A context already seen under an earlier session owner must not touch its successor. */
	const isSupersededContext = (ctx: object): boolean => contexts.has(ctx) && contexts.get(ctx) !== session;
	pi.on("before_provider_request", (event, ctx) => {
		if (ctx && isSupersededContext(ctx)) return;
		try {
			if (session && ctx && ctx.sessionManager !== session.manager) return;
			return cacheGoalHistory(event.payload, liveRetention.contents(sessionKeyFor(ctx)));
		}
		catch (error) { if (!isStaleExtensionContextError(error)) throw error; }
	});
	let continuationAfterSettleFor: string | null = null;
	let networkErrorRecoveryAfterSettleFor: string | null = null;
	let errorPauseAfterSettle: { goalId: string; reason: string } | null = null;

	registerGoalContext(pi, (input, ctx) => {
		const filtered = filterGoalSessionContext(input);
		const messages = compactGoalCheckpointContext(filtered ?? input, core.state.goal) ?? filtered;
		const base = messages ?? input;
		if (isSupersededContext(ctx)) return messages;
		try {if (session && ctx.sessionManager !== session.manager) return messages;}
		catch (error) {if (isStaleExtensionContextError(error)) return messages; throw error;}
		// Reassert startup rejection only for the current host's provider boundary.
		if (core.scheduler.isDenied()) ctx.abort?.();
		if (session) contexts.set(ctx, session);
		const sessionKey = sessionKeyFor(ctx);
		if (session) {
			leases.delete(sessionKey);
			leases.set(sessionKey, session);
			session.keys.delete(sessionKey);
			session.keys.add(sessionKey);
			if (leases.size > 16) leases.delete(leases.keys().next().value!);
			if (session.keys.size > 16) session.keys.delete(session.keys.values().next().value!);
		}
		if (sessionKey === "unidentified") liveRetention.clear(sessionKey);
		const parts = goalContextParts(core, ctx);
		if (parts) {
			// Retain previously sent tails verbatim at their anchors so this
			// request extends the previous one instead of displacing its tail.
			// Only genuinely new policy and task-list content is appended; usage
			// and notes ride at the end of this request only.
			const { messages: retained } = liveRetention.apply(sessionKey, base, parts);
			return retained;
		}
		// A draft or a hidden reminder leaves no goal text: drop what was sent.
		liveRetention.clear(sessionKey);
		return messages;
	});

	pi.on("agent_start", async (_event, ctx) => { core.scheduler.begin(ctx); });
	pi.on("message_start", async (event, ctx) => { core.scheduler.message(ctx, event.message); });
	pi.on("turn_start", async (_event, ctx) => {
		if (core.scheduler.isDenied()) return;
		core.scheduler.turn(ctx);
		// Per-turn flag resets (#4 + C9 fix).
		core.runtime.advanceTurn();
		core.state.goalWorkToolCalledThisTurn = false;
		core.progress.begin();
		core.goalService.beginTurn(ctx, core.state.focusedGoalId); // P1-3 transaction buffer
		core.watch.touchActivity(); // F5
		core.updateUI(ctx);
	});

	// #4 + C9 fix + Phase 5 C3: gate in-turn tool calls based on lifecycle state.
	pi.on("tool_call", async (event, ctx) => {
		const stoppedGoalId = core.runtime.currentTurnStoppedGoalId();
		if (core.scheduler.isDenied()) return { block: true, reason: `Stale goal dispatch; use ${commandHint("goal-resume", core.loadedCommands)}.` };
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
		if (checkpointGoalId !== null && !core.isActionableContinuationGoal(checkpointGoalId) && core.runtime.isStaleCheckpointBlocked(event.toolName)) {
			// Block the tool call with a stale-checkpoint message.
			return {
				block: true,
				reason: `Cannot call ${event.toolName}: the goal checkpoint that triggered this turn is no longer active. ` +
					`Goal ${checkpointGoalId} has been paused, cleared, or replaced. ` +
					`End the turn with a brief summary and yield to the user.`,
			};
		}
		// The goal tools stay advertised during a draft so the cached prompt does
		// not change. Block them here instead, so nothing touches a goal before
		// the user confirms the draft.
		if (hasActiveDraft(core) && (FIVE_GOAL_TOOLS as readonly string[]).includes(event.toolName)) {
			return {
				block: true,
				reason: commandInstructions("A goal draft is in progress. Finish it with propose_goal_draft, or ask the user to run /goal-cancel.", core.loadedCommands),
			};
		}
		if (event.toolName !== "get_goal") core.scheduler.noteTool();
		// Track Oracle work attempts; this does not authorize scheduling.
		if (isMeaningfulProgressToolCall(event.toolName, event.input)) {
			core.state.goalWorkToolCalledThisTurn = true;
			// Goal mutations are measured by content changes at settlement. A
			// ready declaration or an unchanged task update is only bookkeeping.
			if (event.toolName !== "update_goal" && event.toolName !== "update_goal_task") core.scheduler.recordWork();
			// Issue #26: record a meaningful work attempt against armed Oracle
			// advice. get_goal / echo-only reads are excluded upstream by
			// isMeaningfulProgressToolCall.
			const focusedId = core.state.focusedGoalId;
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
		if (core.scheduler.isDenied()) return;
		core.watch.touchActivity(); // F5
		core.progress.charge(ctx);
	});

	pi.on("turn_end", async (event, ctx) => {
		if (core.scheduler.isDenied()) return;
		const message = event.message as AssistantMessageLike;
		const tokens = assistantTurnTokens(message);
		core.watch.touchActivity(); // F5
		core.progress.charge(ctx, { completedTurnTokens: tokens });
		if (!isAbortedAssistantMessage(message) && !isErrorAssistantMessage(message)) {
			const warning = core.state.cacheStats.record((message as { usage?: unknown } | undefined)?.usage, core.state.goal?.id);
			if (warning) ctx.ui.notify(warning, "warning");
		}
		core.interruption.finishTurn(ctx);

		if (isAbortedAssistantMessage(message)) {
			// Pause only on a genuine user abort (signal fired). A provider- or
			// transport-side abort without the signal routes into recovery via
			// agent_end instead of stranding the goal.
			if (ctx.signal?.aborted && !core.interruption.ignoreAbort() && !core.interruption.isHeld()) core.pauseActiveGoal(ctx);
			return;
		}
		// Provider failures are not completed work: do not turn one failed turn
		// into an unbounded auto-continue retry storm. Keep the display
		// reconciled (and accounting already ran above), but never queue a
		// continuation for an error turn (danim47c pattern).
		if (isErrorAssistantMessage(message)) {
			core.lifecycle.refreshDisplayFromDisk(ctx);
			core.updateUI(ctx);
			return;
		}
		core.lifecycle.refreshDisplayFromDisk(ctx);

		// Archive a goal that was marked complete but whose archival was deferred
		// so the agent could see/recognize the audit result first.
		// This runs after the agent's turn ends — the agent has now seen the result.
		if (core.state.goal?.status === "complete" && !core.state.goal?.archivedPath) {
			archiveCompletedGoal(core, ctx, core.state.goal);
			core.updateUI(ctx);
		}

		core.goalService.endTurn(ctx); // P1-3: single flush (lock + write + ledger batch)
	});

	pi.on("message_end", async (event, ctx) => {
		// Signal-aware: see turn_end — only user aborts pause; provider-side
		// aborts are handled by agent_end's recovery path.
		if (!core.scheduler.isDenied() && isAbortedAssistantMessage(event.message) && ctx.signal?.aborted && !core.interruption.ignoreAbort() && !core.interruption.isHeld()) core.pauseActiveGoal(ctx);
		const raw = asRecord(event.message);
		if (raw?.role === "custom" && raw.customType === GOAL_EVENT_ENTRY && raw.display !== false) {
			return { message: { ...event.message, display: false } as typeof event.message };
		}
	});

	/** Detach first; every local cleanup runs even when host or persistence throws. */
	function teardown(ctx: ExtensionContext): void {
		const outgoing = session;
		session = undefined;
		core.sessionOwner = null;
		let failure: unknown;
		const run = (action: () => void) => {
			try {action();} catch (error) {if (!isStaleExtensionContextError(error)) failure ??= error;}
		};
		run(() => core.state.invalidate());
		continuationAfterSettleFor = null;
		networkErrorRecoveryAfterSettleFor = null;
		run(() => core.interruption.settled());
		run(() => core.interruption.reset());
		run(() => core.auditMessages.clear());
		run(() => core.scheduler.shutdown());
		if (outgoing) run(() => core.progress.charge(outgoing.ctx));
		run(() => core.goalService.endSession(outgoing?.storage));
		run(() => core.clearContinuationState());
		run(() => core.clearActiveAccounting());
		run(() => core.view.stopAuditAnimation());
		run(() => core.view.clearAuditResult());
		core.view.auditProgress = null;
		core.state.goalModalDepth = 0;
		const unsubscribe = core.terminalInputUnsubscribe;
		core.terminalInputUnsubscribe = null;
		run(() => unsubscribe?.());
		if (outgoing && core.state.goal) run(() => {core.goalService.persist(outgoing.storage);});
		run(() => core.view.clear(outgoing?.ctx ?? ctx));
		if (outgoing) for (const key of outgoing.keys) {
			if (leases.get(key) !== outgoing) continue;
			liveRetention.clear(key);
			leases.delete(key);
		}
		if (failure) throw failure;
	}

	async function startSession(event: {reason?: string}, ctx: ExtensionContext): Promise<void> {
		teardown(ctx);
		try {
			configureLocale(loadGoalSettings(ctx.cwd).locale);
			const owner: SessionOwner = {ctx, manager: ctx.sessionManager, storage: goalStorageContext(ctx), keys: new Set()};
			session = owner;
			core.sessionOwner = owner;
			contexts.set(ctx, owner);
			invalidateGoalSettingsCache();
			invalidateGoalPoolCache();
			invalidateGoalLedgerCache();
			await core.focus.load(ctx);
			if (session !== owner) return;
			if (ctx.hasUI) ctx.ui.setStatus("goal-interrupt", undefined);
			if (core.controlWarnings?.length) ctx.ui.notify(t("Goal command settings were not applied: {warnings} Open /goal-settings controls to correct them.", { warnings: core.controlWarnings.join(" ") }), "warning");
			rehydrateDraft(core, ctx);
			core.installGoalToolProfile(!loadGoalSettings(ctx.cwd).disableTasks);
			syncTerminalInputPause(core, ctx);
			// Ask resume questions only in the terminal. Over RPC, hasUI is also true,
			// but the host may never show the dialog and session_start would wait forever.
			const askOnResume = event.reason === "resume" && ctx.hasUI && ctx.mode === "tui";
			if (askOnResume && !core.state.goal && !core.state.hasExplicitSessionFocus && otherOpenGoalCount(core.state.goalsById, null) > 1) {
				// Prompt the user to pick which open goal to focus (mirrors /goal-focus).
				const open = core.state.openGoals();
				const labels = open.map((item) => goalSelectorLabel(item, core.state.focusedGoalId));
				const byLabel = new Map(labels.map((label, index) => [label, open[index]?.id]));
				core.state.enterModal();
				try {
					const selected = await ctx.ui.select(t("Focus open goal"), labels);
					const selectedId = selected ? byLabel.get(selected) : undefined;
					if (selectedId && session === owner) {
						core.focus.setFocus(selectedId, ctx, "selected");
						core.armFocusedContinuation(ctx);
					}
				} finally {
					if (session === owner) core.state.exitModal();
				}
			}
			if (session !== owner) return;
			// Codex behavior: prompt before reactivating a paused goal on resume.
			if (askOnResume && core.state.goal?.status === "paused") {
				const current = core.state.goal;
				const shouldResume = await ctx.ui.confirm(t("Resume paused goal?"), t("Goal: {objective}", { objective: current.objective }));
				if (shouldResume && session === owner) core.scheduler.resume(ctx);
			}
			if (session !== owner) return;
			core.progress.begin();
			core.scheduler.restore(ctx);
		} catch (error) {if (!isStaleExtensionContextError(error)) throw error;}
	}
	pi.on("session_start", startSession);

	pi.on("session_before_compact", async (_event, ctx) => {
		core.progress.charge(ctx);
	});

	pi.on("session_compact", async (_event, ctx) => {
		core.goalService.flushTurn(ctx); // P1-3: persist any buffered transaction before reload
		if (core.state.goal) core.lifecycle.persist(ctx);
		core.progress.begin();
		// Arm a deterministic compaction summary for the next agent turn.
		// This replaces the generic reminder with artifact-backed state.
		if (shouldArmPostCompactReminder(core.state.goal)) {
			core.runtime.armPostCompactReminder();
		}
		core.scheduler.schedule(ctx);
	});

	pi.on("session_compact_failed", async (event, ctx) => {
		// `session_before_compact` already charged progress to the goal, so
		// flush the buffered transaction and persist first. Otherwise the goal
		// record and the ledger can disagree about a compaction that never
		// happened.
		core.goalService.flushTurn(ctx);
		if (core.state.goal) core.lifecycle.persist(ctx);
		if (event.aborted || !core.state.goal) return;
		const detail = event.errorMessage ? `: ${event.errorMessage}` : "";
		ctx.ui.notify(
			detail
				? t("Goal context compaction failed ({reason}): {error}. The goal stays active; retry with /compact or keep working.", { reason: event.reason, error: event.errorMessage ?? "" })
				: t("Goal context compaction failed ({reason}). The goal stays active; retry with /compact or keep working.", { reason: event.reason }),
			"warning",
		);
	});

	pi.on("session_tree", (_event, ctx) => startSession({}, ctx));

	pi.on("before_agent_start", async (event, ctx) => {
		core.runtime.advanceTurn();
		core.installGoalToolProfile(!loadGoalSettings(ctx.cwd).disableTasks);
		const incomingGoalId = event.messageType === "custom"
			? goalEventMessageId(event.message) : extractGoalIdFromInjectedMessage(event.prompt ?? "");
		if (event.messageType !== "custom" && !incomingGoalId) core.interruption.continueWithUser(ctx);

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
					core.scheduler.rejectCheckpoint(ctx);
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

	pi.on("agent_end", async (event, ctx) => {
		const endedGoalId = core.runningGoalId;
		core.runningGoalId = null;
		continuationAfterSettleFor = null;
		networkErrorRecoveryAfterSettleFor = null;
		errorPauseAfterSettle = null;
		if (core.scheduler.isDenied()) return;

		// Account for any tokens from aborted in-flight assistant messages so
		// they are not silently lost (but charge them to the original goal).
		const abortedTokens = event.messages
			.filter(isAbortedAssistantMessage)
			.reduce((sum, message) => sum + assistantTurnTokens(message), 0);
		if (abortedTokens > 0 && endedGoalId && core.state.goal?.id === endedGoalId) {
			core.progress.charge(ctx, { completedTurnTokens: abortedTokens });
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
		if (core.interruption.isHeld() || core.interruption.ignoreAbort()) return;
		if (ctx.signal?.aborted) {
			if (!core.interruption.ignoreAbort() && !core.interruption.isHeld()) core.pauseActiveGoal(ctx);
			return;
		}
		// Provider failures are not completed work: persist and refresh the
		// display, but never queue a continuation for a run whose messages
		// include an assistant error (danim47c pattern).
		if (hasNetworkErrorAssistantMessage(event.messages) || hasAbortedAssistantMessage(event.messages)) {
			core.lifecycle.persist(ctx);
			core.updateUI(ctx);
			networkErrorRecoveryAfterSettleFor = core.state.goal.id;
			return;
		}
		// Any other provider error cannot be retried automatically. Pause once Pi
		// settles (it may still retry by itself) so the goal does not sit there
		// looking "running" with nothing scheduled.
		if (hasErrorAssistantMessage(event.messages)) {
			core.lifecycle.persist(ctx);
			core.updateUI(ctx);
			const detail = providerErrorText(event.messages);
			errorPauseAfterSettle = { goalId: core.state.goal.id, reason: `The provider returned an error${detail ? `: ${detail}` : ""}.` };
			return;
		}
		core.runtime.clearNetworkErrorBackoff();
		core.lifecycle.persist(ctx);
		core.updateUI(ctx);
		// agent_end runs before pi finishes retries, compaction, terminating-tool
		// settlement, and queued messages. Starting the continuation timer here
		// can poll a stale busy context. agent_settled is the first point where
		// Pi guarantees no automatic work remains.
		continuationAfterSettleFor = core.state.goal.id;
	});

	pi.on("agent_settled", async (event, ctx) => {
		if (!core.auditMessages.flush(ctx, pi)) return;
		const goalId = continuationAfterSettleFor;
		continuationAfterSettleFor = null;
		const networkErrorGoalId = networkErrorRecoveryAfterSettleFor;
		networkErrorRecoveryAfterSettleFor = null;
		const errorPause = errorPauseAfterSettle;
		errorPauseAfterSettle = null;
		if (core.scheduler.isDenied()) {
			core.runningGoalId = null;
			core.runtime.setCheckpoint(null);
			core.scheduler.settled(ctx, false);
			return;
		}
		const resumedInterruptedTurn = core.interruption.ignoreAbort() && !core.interruption.isHeld();
		// Startup cancellation may leave no assistant message or request signal.
		if (event.aborted) {
			const abortedGoalId = goalId ?? networkErrorGoalId ?? core.runningGoalId;
			core.runningGoalId = null;
			if (abortedGoalId && !core.interruption.ignoreAbort(abortedGoalId) && !core.interruption.isHeld(abortedGoalId) && core.state.goal?.id === abortedGoalId && core.state.goal.status === "active") core.pauseActiveGoal(ctx);
			core.scheduler.settled(ctx, false);
			core.interruption.settled();
			if (resumedInterruptedTurn) core.scheduler.schedule(ctx);
			return;
		}
		core.interruption.settled();
		core.scheduler.settled(ctx, !!goalId && core.isActionableContinuationGoal(goalId));
		if (resumedInterruptedTurn) core.scheduler.schedule(ctx);
		if (goalId && core.isActionableContinuationGoal(goalId)) return;
		if (errorPause && core.isActionableContinuationGoal(errorPause.goalId)) {
			core.scheduler.pauseForError(ctx, commandInstructions(`${errorPause.reason} Goal paused. Use /goal-resume to try again.`, core.loadedCommands));
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
				t("Provider network error. Retrying the goal in {seconds}s (recovery {attempt}{cap}).", { seconds: Math.round(plan.delayMs / 1000), attempt: plan.attempt, cap }),
				"warning",
			);
			return;
		}
		// Only reachable under a configured bounded cap (maxAttempts > 0).
		core.scheduler.pauseForError(ctx, commandInstructions("Provider network errors persisted after all recovery attempts. Goal paused. Use /goal-resume when the provider works again.", core.loadedCommands), commandInstructions(t("Provider network errors persisted after all recovery attempts. Goal paused. Use /goal-resume when the provider works again."), core.loadedCommands));
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		// A delayed shutdown of a previously observed owner cannot touch its successor.
		if (isSupersededContext(ctx)) return;
		try {if (session && ctx.sessionManager !== session.manager) return;}
		catch (error) {
			if (!isStaleExtensionContextError(error)) throw error;
			if (session && contexts.get(ctx) !== session) {
				// An unseen stale callback cannot retire an owner whose host is still live.
				try {session.ctx.sessionManager; return;}
				catch (ownerError) {if (!isStaleExtensionContextError(ownerError)) throw ownerError;}
			}
		}
		teardown(ctx);
	});
}
