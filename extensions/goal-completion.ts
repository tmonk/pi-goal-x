import {randomUUID} from "node:crypto";
import {type AgentToolResult, type ExtensionContext} from "@earendil-works/pi-coding-agent";
import {GOAL_AUDIT_ENTRY, detailedSummary, goalDetails} from "./goal-format.ts";
import {buildCompletionReport, buildTaskSummary, taskCompletionBlockWarning, validateGoalCompletion} from "./goal-policy.ts";
import {loadGoalSettings, loadGoalSettingsFileConfig} from "./goal-settings.ts";
import {runGoalCompletionAuditor, type GoalAuditorResult} from "./goal-auditor.ts";
import {nowIso, type GoalRecord} from "./goal-record.ts";
import {latestEventsForGoal, latestSettledAuditorResultForGoal, goalRuntimeEvents, type GoalLedgerEvent} from "./goal-ledger.ts";
import {mergeGoalPromptFromDisk} from "./storage/goal-files.ts";
import {isStaleExtensionContextError} from "./goal-session-safety.ts";
import {goalStorageContext} from "./storage/goal-root.ts";
import {showEscapeDialog} from "./widgets/goal-escape-dialog.ts";
import type {GoalCore, ActiveGoalAudit} from "./goal-state.ts";

type CompletionOptions = {
	goal: GoalRecord;
	focus: {goalId: string; revision: number};
	auditorReport?: string;
	skipped?: string;
	userBypass?: boolean;
};

/** One completion transaction, using current usage and the audited disk revision. */
function commitCompletion(core: GoalCore, ctx: ExtensionContext, opts: CompletionOptions): AgentToolResult<unknown> {
	if (!core.isFocusedOperationCurrent(opts.focus)) return core.focusedOperationCancelledResult("Goal completion", opts.focus);
	core.reconcileFocusedGoalFromDisk(ctx);
	if (core.state.goal?.revision !== opts.goal.revision) return {
		content: [{type: "text", text: "Goal completion failed: the goal changed during the audit. Recheck the current requirements and retry."}],
		details: goalDetails(core.state.goal), terminate: false,
		};
	core.accountProgress(ctx);
	let result;
	try {
		result = core.goalService.apply(ctx, {
			reconcile: false, focusToken: opts.focus,
			mutate: current => ({...current, status: "complete", stopReason: "agent", updatedAt: nowIso()}),
			});
	} catch (error) {result = {ok: false as const, message: error instanceof Error ? error.message : String(error)};}
	if (!result.ok) return {
		content: [{type: "text", text: `Goal completion failed: ${result.message}. The goal was not completed.`}],
		details: goalDetails(core.state.goal), terminate: false,
		};
	core.runtime.markTurnStopped(result.goal.id);
	core.updateUI(ctx);
	const report = buildCompletionReport({detailedSummary: detailedSummary(core.state.goal), auditorReport: opts.auditorReport, auditSkippedReason: opts.skipped, taskSummary: core.state.goal?.taskList ? buildTaskSummary(core.state.goal.taskList) : null});
	return {content: [{type: "text", text: report + (opts.userBypass ? "\n\nThe goal is complete. Provide a final summary of what was accomplished." : "")}], details: goalDetails(core.state.goal), ...(opts.userBypass ? {} : {terminate: true})};
}

/** Capture one audit owner; every outcome and callback belongs to that owner. */
export async function runGoalCompletionFlow(core: GoalCore, ctx: ExtensionContext, completionSummary?: string): Promise<AgentToolResult<unknown>> {
	const flushError = core.goalService.flushForAudit(ctx);
	if (flushError) return {content: [{type: "text", text: flushError}], details: goalDetails(core.state.goal)};
	core.reconcileFocusedGoalFromDisk(ctx);
	const gate = validateGoalCompletion({goal: core.state.goal, runningGoalId: core.runningGoalId});
	if (!gate.ok) return {content: [{type: "text", text: gate.message}], details: goalDetails(core.state.goal)};
	if (!core.state.goal) throw new Error("Goal disappeared during completion validation.");
	const settings = loadGoalSettings(ctx.cwd);
	const warning = !settings.disableTasks && core.state.goal.taskList ? taskCompletionBlockWarning(core.state.goal.taskList) : null;
	if (warning) return {content: [{type: "text", text: warning}], details: goalDetails(core.state.goal)};

	const target = mergeGoalPromptFromDisk(ctx, core.state.goal);
	const focus = core.focusedOperationToken(target.id);
	const storage = goalStorageContext(ctx);
	const config = loadGoalSettingsFileConfig(ctx.cwd);
	const label = config.provider || config.model || config.thinkingLevel
		? `${config.provider ?? "default"}/${config.model ?? "default"}${config.thinkingLevel ? `:${config.thinkingLevel}` : ""}` : "default";
	const auditId = randomUUID();
	const append = (event: GoalLedgerEvent) => core.goalService.appendEvents(storage, [event], {immediate: true});
	const message = (phase: string, text: string, auditor = label) => core.auditMessages.enqueue(ctx, {customType: GOAL_AUDIT_ENTRY, content: text, display: true, details: {phase, goalId: target.id, auditor}});
	const cancelled = () => core.focusedOperationCancelledResult("Goal completion", focus);
	const persistenceError = (): AgentToolResult<unknown> => ({isError: true, content: [{type: "text", text: "The audit outcome could not be persisted. The goal remains open; inspect the storage diagnostic and retry."}], details: goalDetails(core.state.goal), terminate: false});
	append({type: "completion_requested", goalId: target.id, at: nowIso()});
	core.activeAudit?.cancel("A newer completion attempt replaced this audit.");

	const skipReason = target.skipAuditor ? "per-goal auditor disabled" : config.disabled ? "auditor disabled in settings" : undefined;
	if (skipReason) {
		if (!append({type: "audit_skipped", auditId, goalId: target.id, reason: "disabled", provider: config.provider, model: config.model, thinkingLevel: config.thinkingLevel, at: nowIso()})) return persistenceError();
		message("skipped", `Goal completed — ${skipReason}.`);
		return commitCompletion(core, ctx, {goal: target, focus, skipped: skipReason});
	}

	const run: ActiveGoalAudit = {
		controller: new AbortController(), phase: "running",
		cancel: reason => {
			if (run.phase === "settling" || run.phase === "settled") return;
			run.controller.abort();
			settle({type: "audit_result", auditId, goalId: target.id, verdict: "error", report: reason, at: nowIso()});
		},
		};
	const current = () => core.activeAudit === run && core.isFocusedOperationCurrent(focus) && run.phase !== "settled";
	function settle(event: GoalLedgerEvent): boolean {
		if (run.phase === "settling" || run.phase === "settled") return false;
		run.phase = "settling";
		try {return append(event);}
		finally {
			run.phase = "settled";
			if (core.activeAudit === run) {
				core.activeAudit = null;
				core.stopAuditAnimation();
				core.auditProgress = null;
				core.goalWidgetComponentRef.current?.invalidate();
			}
		}
	}
	core.activeAudit = run;
	try {
		if (!append({type: "audit_started", auditId, goalId: target.id, provider: config.provider, model: config.model, thinkingLevel: config.thinkingLevel, at: nowIso()})) {
			run.cancel("Audit could not start because its ledger entry failed.");
			return persistenceError();
		}
		message("started", `Auditor: I am starting the independent completion audit.\nGoal id: ${target.id}\nAuditor model: ${label}`);
		const startedAt = Date.now();
		core.clearAuditResult();
		core.auditProgress = {recentOutput: [], phase: "running", elapsedMs: 0, auditorLabel: label};
		core.stopAuditAnimation();
		core.auditAnimationTimer = setInterval(() => {
			if (!current() || !core.auditProgress) return;
			core.auditProgress.elapsedMs = Date.now() - startedAt;
			core.goalWidgetComponentRef.current?.invalidate();
		}, 80);
		core.auditAnimationTimer.unref?.();
		const ledger = goalRuntimeEvents(storage, target.id);
		const tail = latestEventsForGoal(ledger, target.id, 8);
		const previous = latestSettledAuditorResultForGoal(ledger, target.id);
		let warmContext = tail.length ? `Recent goal events (from the shared ledger):\n${tail.map(e => `- ${e.at} ${e.type}${"taskId" in e ? ` (task ${e.taskId})` : ""}${"evidence" in e && e.evidence ? ` evidence: ${e.evidence}` : ""}`).join("\n")}` : null;
		if (previous?.verdict === "disapproved") warmContext = `${warmContext ?? ""}\nPrevious rejection (verify whether resolved): ${previous.report.slice(0, 600)}`;
		let auditor: GoalAuditorResult;
		try {
			auditor = await (core.dependencies.runCompletionAuditor ?? runGoalCompletionAuditor)({ctx, goal: target, detailedSummary: detailedSummary(target), completionSummary: completionSummary?.trim() || undefined, settings, warmContext, signal: run.controller.signal, onProgress: progress => {
				if (!current() || run.phase !== "running") return;
				core.auditProgress = {...progress, elapsedMs: Date.now() - startedAt};
				core.goalWidgetComponentRef.current?.invalidate();
			}});
		} catch (error) {auditor = {approved: false, disapproved: false, output: "", error: error instanceof Error ? error.message : String(error)};}
		if (!current()) return cancelled();
		core.stopAuditAnimation();
		core.auditProgress = null;

		if (run.controller.signal.aborted || auditor.error === "Auditor aborted.") {
			run.phase = "awaiting-choice";
			core.updateUI(ctx);
			core.enterGoalModal();
			let choice;
			try {choice = await showEscapeDialog(ctx, target.objective);}
			finally {if (current()) core.exitGoalModal();}
			if (!current()) return cancelled();
			if (choice === "complete_without_audit") {
				if (!settle({type: "audit_skipped", auditId, goalId: target.id, reason: "user_aborted", provider: config.provider, model: config.model, thinkingLevel: config.thinkingLevel, at: nowIso()})) return persistenceError();
				message("skipped", "Goal completed — user bypassed audit via Escape.");
				return commitCompletion(core, ctx, {goal: target, focus, skipped: "auditor bypassed (user pressed Escape during audit)", userBypass: true});
			}
			if (!settle({type: "audit_result", auditId, goalId: target.id, verdict: "error", report: "Audit aborted — the goal remains active and work continues.", at: nowIso()})) return persistenceError();
			core.updateUI(ctx);
			return {content: [{type: "text", text: "Audit aborted — the goal remains active and work continues."}], details: goalDetails(core.state.goal)};
		}
		const verdict = auditor.approved ? "approved" : auditor.error ? "error" : "disapproved";
		if (!settle({type: "audit_result", auditId, goalId: target.id, verdict, report: auditor.output || auditor.error || "Auditor produced no output.", at: nowIso()})) return persistenceError();
		core.setAuditResult(verdict, auditor.output || auditor.error || "Auditor produced no output.");
		if (!auditor.approved) {
			const text = ["Goal audit rejected.", "", "Goal completion rejected by independent auditor.", auditor.model ? `Auditor model: ${auditor.model}${auditor.thinkingLevel ? `:${auditor.thinkingLevel}` : ""}` : undefined, auditor.error ? `Auditor error: ${auditor.error}` : undefined, "", auditor.output || "Auditor produced no approval marker."].filter(line => line !== undefined).join("\n");
			message("rejected", text, auditor.model);
			return {content: [{type: "text", text}], details: goalDetails(core.state.goal)};
		}
		message("approved", ["Auditor: I approve this completion claim.", auditor.model ? `Auditor model: ${auditor.model}${auditor.thinkingLevel ? `:${auditor.thinkingLevel}` : ""}` : undefined, "", auditor.output || "Auditor approved completion."].filter(line => line !== undefined).join("\n"), auditor.model);
		return commitCompletion(core, ctx, {goal: target, focus, auditorReport: auditor.output});
	} catch (error) {
		if (isStaleExtensionContextError(error)) return cancelled();
		throw error;
	} finally {
		// Covers a dialog/host exception as well as late cancellation; settlement is claimed once.
		if (run.phase !== "settled") run.cancel("Completion audit ended without a terminal result.");
	}
}
