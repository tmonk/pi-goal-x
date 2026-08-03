import { StringEnum, Type } from "@earendil-works/pi-ai";
import { defineTool, type AgentToolResult, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { formatDuration, formatTokenValue, statusLabel, truncateText } from "./goal-core.ts";
import { extractVerificationContract } from "./goal-draft.ts";
import {
	COMPLETE_STATUS,
	GOAL_AUDIT_ENTRY,
	detailedSummary,
	goalDetails,
	renderGoalResult,
	type GoalAuditEventDetails,
} from "./goal-format.ts";
import { budgetLine } from "./goal-accounting.ts";
import { loadGoalSettings, loadGoalSettingsFileConfig } from "./goal-settings.ts";
import {
	buildCompletionReport,
	buildGoalCreatedReport,
	buildTaskSummary,
	checkSubtasksComplete,
	findTaskInTree,
	skipAllSubtasks,
	taskCompletionBlockWarning,
	updateTaskInTree,
	validateGoalBlock,
	validateGoalCompletion,
	validateTaskCompletion,
	validateTaskSkip,
	validateVerificationSummary,
} from "./goal-policy.ts";
import { buildUnfocusedOpenGoalsSummary, otherOpenGoalCount } from "./goal-pool.ts";
import { shouldAutoConfirmProposal, showProposalDialog } from "./goal-questionnaire.ts";
import { runGoalCompletionAuditor } from "./goal-auditor.ts";
import {
	SET_GOAL_TASKS_TOOL_NAME,
	UPDATE_GOAL_TASK_TOOL_NAME,
} from "./goal-tool-names.ts";
import { convertFlatTasks, mergeTasksWithExisting, type FlatTaskInput } from "./goal-task-tools.ts";
import { nowIso, type GoalRecord, type GoalTask, type GoalTaskList } from "./goal-record.ts";
import { mergeGoalPromptFromDisk } from "./storage/goal-files.ts";
import { showEscapeDialog, type EscapeDialogResult } from "./widgets/goal-escape-dialog.ts";
import type { GoalCore } from "./goal-state.ts";

/**
 * The five model tools (get_goal, create_goal, update_goal, set_goal_tasks,
 * update_goal_task) plus the shared completion/blocked flows. All state is
 * read and mutated through the GoalCore; nothing here writes goal files or
 * ledger entries directly — that stays behind GoalService.
 */
export function registerGoalTools(core: GoalCore): void {
	const { pi } = core;

	pi.registerTool(defineTool({
		name: "get_goal",
		label: "Get Goal",
		description: "Get the current pi goal for this session: objective, status, auto-continue, usage, and local file paths.",
		promptSnippet: "Read the active pi goal state for the current session.",
		promptGuidelines: [
			"Use get_goal when you need the current goal before deciding whether to continue or mark it complete.",
			"Before marking a goal complete, compare every explicit requirement with concrete evidence from the workspace/session.",
			"If the returned goal has sisyphus mode on, you must execute strictly step-by-step in the order written in the objective; do not skip, combine, or rush steps, and stop to ask the user when blocked or unclear.",
		],
		parameters: Type.Object({}, { additionalProperties: false }),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			core.reconcileFocusedGoalFromDisk(ctx);
			if (core.state.goal) core.syncGoalPromptFromDisk(ctx);
			core.syncGoalTools();
			const view = core.goalForDisplay() ?? core.state.goal;
			const otherCount = otherOpenGoalCount(core.goalsById, core.focusedGoalId);
			if (!view) {
				const text = core.openGoals().length > 0
					? `${buildUnfocusedOpenGoalsSummary(core.openGoals().length)}\n\nCall create_goal with the objective to create and focus a new goal, or ask the user to run /goal-focus to choose an open goal.`
					: "No goal is set in this session. Call create_goal with the objective when the user explicitly asks to start a persistent goal.";
				return {
					content: [{ type: "text", text }],
					details: goalDetails(view),
				};
			}
			const lines: string[] = [view.objective, ""];
			lines.push(`Status: ${statusLabel(view)}`);
			lines.push(`Mode: ${view.sisyphus ? "sisyphus" : "regular"}`);
			const usageBits: string[] = [];
			if (view.usage.activeSeconds > 0) usageBits.push(formatDuration(view.usage.activeSeconds));
			if (view.usage.tokensUsed > 0) usageBits.push(formatTokenValue(view.usage.tokensUsed));
			lines.push(`Usage: ${usageBits.length > 0 ? usageBits.join(" · ") : "none"}`);
			const budget = budgetLine(view);
			if (budget) lines.push(`Budget: ${budget}`);
			if (view.taskList) lines.push(`Tasks: ${buildTaskSummary(view.taskList)}`);
			if (view.verificationContract?.trim()) lines.push(`Verification contract: ${view.verificationContract.trim()}`);
			if (view.status === "paused" || view.status === "blocked") {
				if (view.pauseReason) lines.push(`Blocker: ${view.pauseReason}`);
				if (view.pauseSuggestedAction) lines.push(`Suggested action: ${view.pauseSuggestedAction}`);
			}
			if (view.activePath) lines.push(`Path: ${view.activePath}`);
			if (view.archivedPath) lines.push(`Archive: ${view.archivedPath}`);
			if (otherCount > 0) lines.push(`Other open goals: ${otherCount} (user can run /goal-list or /goal-focus)`);
			lines.push("");
			lines.push("Lifecycle: call update_goal({status: \"complete\"}) only when every requirement is satisfied — the independent auditor verifies from actual evidence. Call update_goal({status: \"blocked\"}) only after the same blocker recurs on three consecutive goal turns. User commands handle pause/resume/clear/focus.");
			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: goalDetails(view),
			};
		},
		renderCall(_args, theme) {
			return new Text(theme.fg("toolTitle", "get_goal"), 0, 0);
		},
		renderResult(result, _options, theme) {
			return renderGoalResult(result, theme);
		},
	}));

	pi.registerTool(defineTool({
		name: "create_goal",
		label: "Create Goal",
		description: "Create and focus a new pi goal after an explicit user request. Only call this when the user has explicitly asked to make something a persistent goal (directly, or via /goal or /sisyphus); do NOT infer a goal from an ordinary task. Creating a goal focuses it and leaves other open goals untouched.",
		promptSnippet: "Create a persistent pi goal only when the user explicitly asks for one.",
		promptGuidelines: [
			"Call create_goal only when the user explicitly asks to start a long-running goal or hands you a concrete objective to pursue. Never infer a goal from an ordinary one-off task.",
			"Creating a new goal focuses it and leaves other open goals untouched. Do not archive or replace existing goals unless the user explicitly asks through a user command.",
			"Pass mode=\"sisyphus\" only when the user explicitly invoked Sisyphus mode.",
		],
		parameters: Type.Object({
			objective: Type.String({ description: "Full goal text. For Sisyphus goals this MUST include the user's numbered steps + per-step done criteria, taken faithfully from the user's input. 1-4000 characters." }),
			mode: Type.Optional(StringEnum(["regular", "sisyphus"] as const, { description: "Goal mode. Defaults to regular. Use sisyphus only when the user explicitly invoked Sisyphus mode." })),
			token_budget: Type.Optional(Type.Number({ minimum: 1, description: "Optional token budget in whole tokens. Accept it only when the user explicitly supplied a budget; never invent one." })),
		}, { additionalProperties: false }),
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			core.reconcileFocusedGoalFromDisk(ctx);
			const objective = params.objective.trim();
			if (!objective) throw new Error("create_goal requires a non-empty objective.");
			if (objective.length > 4000) {
				return {
					content: [{ type: "text", text: `create_goal objective exceeds 4000 characters (${objective.length}). Shorten the objective and retry.` }],
					details: goalDetails(core.state.goal),
				};
			}
			const sisyphusFlag = params.mode === "sisyphus";
			const { objective: cleanedObjective, verificationContract } = extractVerificationContract(objective);
			core.replaceGoal(
				{ objective: cleanedObjective, autoContinue: true, sisyphus: sisyphusFlag },
				ctx,
				true,
				verificationContract,
				params.token_budget,
			);
			const created = core.state.goal;
			const otherCount = otherOpenGoalCount(core.goalsById, core.focusedGoalId);
			const otherLine = otherCount > 0
				? `\n${otherCount} other open goal${otherCount === 1 ? "" : "s"} remain in .pi/goals — this goal is now the session focus.`
				: "";
			return {
				content: [{ type: "text", text: `${buildGoalCreatedReport({ objective: created?.objective ?? objective, detailedSummary: detailedSummary(created) })}${otherLine}` }],
				details: goalDetails(created),
				terminate: true,
			};
		},
		renderCall(args, theme) {
			const prefix = args?.mode === "sisyphus" ? "create_goal sisyphus " : "create_goal ";
			return new Text(theme.fg("toolTitle", prefix) + theme.fg("muted", args?.objective ?? ""), 0, 0);
		},
		renderResult(result, _options, theme) {
			return renderGoalResult(result, theme);
		},
	}));

	// Agent's goal-confirmation entry point. Shows the user a full plain-text
	// draft report with two choices: [Confirm] (creates the goal) or
	// [Continue Chatting] (returns control to the agent for more clarification).
	// Schema gates enforce focus-vs-sisyphus consistency; draftId is ignored for
	// one-release compatibility with older prompt residue.
	// In headless mode (no UI), auto-confirms — harness-friendly.
			async function runGoalCompletionFlow(ctx: ExtensionContext, opts: { completionSummary?: string; verificationSummary?: string; confirmBypassAuditor?: boolean; status?: string }): Promise<AgentToolResult<unknown>> {
		core.reconcileFocusedGoalFromDisk(ctx);

		// -- Phase 2: Status validation --
		const effectiveStatus = opts.status ?? COMPLETE_STATUS;
		if (effectiveStatus !== COMPLETE_STATUS) {
			throw new Error("update_goal(complete) requires status=complete when marking a goal complete.");
		}

		// -- Phase 3: Completion --
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

		// Verification contract gate: enforced only when the model supplied a
		// verification summary. The new update_goal surface has no paperwork field
		// — the independent auditor derives the requirements from the objective and
		// contract and inspects actual state instead.
		const disableContractsSettings = loadGoalSettings(ctx.cwd).disableContracts;
		if (!disableContractsSettings && opts.verificationSummary !== undefined) {
			const contractGate = validateVerificationSummary({
				verificationContract: core.state.goal.verificationContract,
				verificationSummary: opts.verificationSummary,
			});
			if (!contractGate.ok) {
				return {
					content: [{ type: "text", text: contractGate.message }],
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
				summary: opts.completionSummary,
				at: nowIso(),
			}]);
		} catch {
			// Ledger append failure should not block completion
		}
		const settings = loadGoalSettingsFileConfig(ctx.cwd);
		const auditorLabel = settings.provider || settings.model || settings.thinkingLevel
			? `${settings.provider ?? "default"}/${settings.model ?? "default"}${settings.thinkingLevel ? `:${settings.thinkingLevel}` : ""}`
			: "default";

		// Check if auditor is disabled per-goal (user toggled it off during goal confirmation)
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
			core.accountProgress(ctx);
			core.auditProgress = null;
			core.goalWidgetComponentRef.current?.invalidate();
			const completeResult = core.goalService.apply(ctx, {
				reconcile: false,
				focusToken: completionFocus,
				mutate: () => ({ ...auditTarget, status: "complete" as const, stopReason: "agent" as const, updatedAt: nowIso() }),
			});
			if (completeResult.ok && completeResult.goal) core.runtime.markTurnStopped(completeResult.goal.id);
			core.syncGoalTools();
			core.updateUI(ctx);
			return {
				content: [{
					type: "text",
					text: buildCompletionReport({
						detailedSummary: detailedSummary(core.state.goal),
						completionSummary: opts.completionSummary,
						auditSkippedReason: "per-goal auditor disabled",
						taskSummary: core.state.goal?.taskList ? buildTaskSummary(core.state.goal.taskList) : null,
					}),
				}],
				details: goalDetails(core.state.goal),
				terminate: true,
			};
		}

		// Check if auditor is disabled in settings
		if (settings.disabled === true) {
			if (opts.confirmBypassAuditor !== true) {
				return {
					content: [{ type: "text", text: [
						"The completion auditor is disabled in settings.",
						"",
						"The completion auditor is disabled in settings. There is no model-side bypass for update_goal; enable the auditor in /goal-settings or ask the user to complete via the TUI.",
					].join("\n") }],
					details: goalDetails(core.state.goal),
				};
			}
			// Auditor disabled and confirmed — skip audit.
			// Defer archival: set goal complete in-memory + write active file WITHOUT
			// archiving. Archival happens at turn_end so the agent has a chance to
			// recognise the skipped audit before the goal is archived.
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
			// Set goal complete in memory (defer archival to turn_end)
			core.accountProgress(ctx);
			core.auditProgress = null;
			core.goalWidgetComponentRef.current?.invalidate();
			const completeResult = core.goalService.apply(ctx, {
				reconcile: false,
				focusToken: completionFocus,
				mutate: () => ({ ...auditTarget, status: "complete" as const, stopReason: "agent" as const, updatedAt: nowIso() }),
			});
			if (completeResult.ok && completeResult.goal) core.runtime.markTurnStopped(completeResult.goal.id);
			core.syncGoalTools();
			core.updateUI(ctx);
			return {
				content: [{
					type: "text",
					text: buildCompletionReport({
						detailedSummary: detailedSummary(core.state.goal),
						completionSummary: opts.completionSummary,
						auditSkippedReason: "auditor disabled in settings",
						taskSummary: core.state.goal?.taskList ? buildTaskSummary(core.state.goal.taskList) : null,
					}),
				}],
				details: goalDetails(core.state.goal),
				terminate: true,
			};
		}

		// Auditor is enabled — run the normal audit flow
		await pi.sendMessage<GoalAuditEventDetails>({
			customType: GOAL_AUDIT_ENTRY,
			content: [
				"Auditor: I am starting the independent completion audit.",
				`Goal id: ${auditTarget.id}`,
				`Auditor model: ${auditorLabel}`,
				opts.completionSummary?.trim() ? `Completion claim: ${opts.completionSummary.trim()}` : undefined,
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
			completionSummary: opts.completionSummary,
			detailedSummary: detailedSummary(auditTarget),
			verificationSummary: opts.verificationSummary,
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
				// Set goal complete in memory (defer archival to turn_end)
				core.accountProgress(ctx);
				const completeResult = core.goalService.apply(ctx, {
					reconcile: false,
					focusToken: completionFocus,
					mutate: () => ({ ...auditTarget, status: "complete" as const, stopReason: "agent" as const, updatedAt: nowIso() }),
				});
				if (completeResult.ok && completeResult.goal) core.runtime.markTurnStopped(completeResult.goal.id);
				core.syncGoalTools();
				core.updateUI(ctx);
				return {
					content: [{
						type: "text",
						text: [
							"User chose to mark the goal complete (bypassed audit via Escape).",
							"",
							"The goal is complete. Provide a final summary of what was accomplished.",
						].join("\n"),
					}],
					details: goalDetails(core.state.goal),
				};
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
		// Defer archival: set goal complete in-memory + write active file WITHOUT
		// archiving. Archival happens at turn_end so the agent can see the auditor
		// approval before the goal is archived.
		core.accountProgress(ctx);
		core.auditProgress = null;
		core.goalWidgetComponentRef.current?.invalidate();
		const completeResult = core.goalService.apply(ctx, {
			reconcile: false,
			focusToken: completionFocus,
			mutate: () => ({ ...auditTarget, status: "complete" as const, stopReason: "agent" as const, updatedAt: nowIso() }),
		});
		if (completeResult.ok && completeResult.goal) core.runtime.markTurnStopped(completeResult.goal.id);
		core.syncGoalTools();
		core.updateUI(ctx);
		return {
			content: [{
				type: "text",
				text: buildCompletionReport({
					detailedSummary: detailedSummary(core.state.goal),
					completionSummary: opts.completionSummary,
					auditorReport: auditor.output,
					taskSummary: core.state.goal?.taskList ? buildTaskSummary(core.state.goal.taskList) : null,
				}),
			}],
			details: goalDetails(core.state.goal),
			terminate: true,
		};
	}


		// ── update_goal: the model's terminal-outcome surface (Stage 3) ────────
	// complete → the independent auditor verifies from actual evidence (no
	// paperwork field); blocked → a distinct agent-blocked state that stops
	// continuation. The three-consecutive-turn blocker rule is prompt policy.
	async function runGoalBlockedFlow(ctx: ExtensionContext): Promise<AgentToolResult<unknown>> {
		core.reconcileFocusedGoalFromDisk(ctx);
		const gate = validateGoalBlock({ goal: core.state.goal, runningGoalId: core.runningGoalId });
		if (!gate.ok) {
			return {
				content: [{ type: "text", text: gate.message }],
				details: goalDetails(core.state.goal),
			};
		}
		if (!core.state.goal) throw new Error("Goal disappeared during blocked validation.");
		core.accountProgress(ctx);
		const result = core.goalService.apply(ctx, {
			reconcile: false,
			refreshFromDisk: true,
			mutate: (g) => ({
				...g,
				status: "blocked" as const,
				stopReason: "agent" as const,
				pauseReason: g.pauseReason ?? "The model reported this goal as blocked after the same blocker recurred on consecutive turns.",
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
		if (result.ok) {
			core.clearContinuationState();
			core.clearActiveAccounting();
			if (result.goal) core.runtime.markTurnStopped(result.goal.id);
			core.syncGoalTools();
			core.updateUI(ctx);
		}
		return {
			content: [{
				type: "text",
				text: "Goal blocked. Continuation stopped; the goal is waiting for the user to resume, revise, or clear it. Stop now; do not start another tool call.",
			}],
			details: goalDetails(core.state.goal),
			terminate: true,
		};
	}

	pi.registerTool(defineTool({
		name: "update_goal",
		label: "Update Goal",
		description: "Report one of two terminal outcomes for the current run: status \"complete\" (runs the independent completion auditor, which verifies from actual evidence — no paperwork field) or status \"blocked\" (records a distinct agent-blocked state and stops continuation). Call blocked only after the same blocker recurs on three consecutive goal turns.",
		promptSnippet: "Report the current run as complete (audited) or blocked (after three consecutive identical blockers).",
		promptGuidelines: [
			"Call update_goal({status: \"complete\"}) only when every requirement is satisfied. There is no verification-summary parameter: the independent auditor derives the requirements from the objective and any verification contract, and inspects the actual workspace evidence.",
			"Call update_goal({status: \"blocked\"}) only after the SAME blocker has recurred on three consecutive goal turns. Do not block on the first or second occurrence — keep trying concrete next steps and ask for help when genuinely stuck. A user pause remains an immediate, distinct state controlled by the user.",
			"Do not use update_goal as an escape hatch: if the objective is achieved, complete it; if it is not, do not complete it. The goal objective is immutable — the model must never edit it on its own initiative.",
			"For sisyphus goals, do not mark complete until every numbered step has been executed and individually verified against its done criterion.",
		],
		parameters: Type.Object({
			status: StringEnum(["complete", "blocked"] as const, { description: "complete runs the independent auditor; blocked records a distinct agent-blocked state. Only these two outcomes are accepted." }),
		}, { additionalProperties: false }),
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (params.status === "blocked") {
				return runGoalBlockedFlow(ctx);
			}
			return runGoalCompletionFlow(ctx, {});
		},
		renderCall(args, theme) {
			return new Text(theme.fg("toolTitle", "update_goal ") + theme.fg("muted", args?.status ?? ""), 0, 0);
		},
		renderResult(result, _options, theme) {
			return renderGoalResult(result, theme);
		},
	}));


		// ── set_goal_tasks: flat parent-linked structural task-tree tool ───────────
	pi.registerTool(defineTool({
		name: SET_GOAL_TASKS_TOOL_NAME,
		label: "Set Goal Tasks",
		description: "Create or structurally replace the task tree for the focused active or paused goal. Takes a flat parent-linked task list (id, title, optional parent_id, optional verification_contract, optional lightweight_subtasks) plus block_completion. Matching ids retain status and evidence. Structural changes use the existing confirmation dialog.",
		promptSnippet: "Set the goal task tree with confirmation. Stops the turn after confirmation.",
		promptGuidelines: [
			"Use set_goal_tasks after a goal is confirmed, on the first continuation turn, if the objective naturally decomposes into trackable milestones. Do not add a task list for simple single-step goals.",
			"If a task list already exists, only call set_goal_tasks to restructure it when (a) the user explicitly asks, or (b) the goal objective or requirements have structurally changed. Do not restructure autonomously.",
			"Existing tasks with matching ids preserve their status/evidence/timestamps; new ids start as pending; removed ids are gone.",
			"After confirmation the turn stops; the next continuation will arrive automatically.",
			"Validation is enforced at runtime: unique non-empty ids/titles, existing parents, acyclic relationships, at most 50 tasks, configured depth, and lightweight_subtasks only on tasks that have children.",
		],
		parameters: Type.Object({
			tasks: Type.Array(Type.Object({
				id: Type.String({ description: "Short stable slug e.g. 'task-1'" }),
				title: Type.String({ description: "Human-readable task title" }),
				parent_id: Type.Optional(Type.String({ description: "Optional id of the parent task in this same input; roots omit it." })),
				verification_contract: Type.Optional(Type.String({ description: "Optional evidence requirement for completing this task." })),
				lightweight_subtasks: Type.Optional(Type.Boolean({ description: "If true, this task's subtasks are lightweight (no completion enforcement). Only valid when the task has children." })),
			}), { description: "Flat parent-linked task list" }),
			block_completion: Type.Optional(Type.Boolean({ description: "If true, warns when pending tasks remain during completion. Default false." })),
			change_summary: Type.Optional(Type.String({ description: "Optional summary of the task list change" })),
		}, { additionalProperties: false }),
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			core.reconcileFocusedGoalFromDisk(ctx);
			if (!core.state.goal) {
				return {
					content: [{ type: "text", text: "No goal is set; set_goal_tasks requires a focused active or paused goal." }],
					details: goalDetails(core.state.goal),
				};
			}
			if (loadGoalSettings(ctx.cwd).disableTasks) {
				return {
					content: [{ type: "text", text: "set_goal_tasks is disabled by settings (disableTasks: true)." }],
					details: goalDetails(core.state.goal),
				};
			}
			if (core.state.goal.status !== "active" && core.state.goal.status !== "paused") {
				return {
					content: [{ type: "text", text: `set_goal_tasks applies to an active or paused goal; this goal is ${statusLabel(core.state.goal)}.` }],
					details: goalDetails(core.state.goal),
				};
			}
			const settings = loadGoalSettings(ctx.cwd);
			const converted = convertFlatTasks(params.tasks as FlatTaskInput[], { maxSubtaskDepth: settings.subtaskDepth });
			if (!converted.ok) {
				return {
					content: [{ type: "text", text: converted.message }],
					details: goalDetails(core.state.goal),
				};
			}
			const mergedTasks = mergeTasksWithExisting(core.state.goal.taskList?.tasks, converted.tasks);
			const blockCompletion = params.block_completion === true;
			const now = nowIso();
			const taskList: GoalTaskList = {
				tasks: mergedTasks,
				blockCompletion,
				proposedAt: now,
			};

			// Render the proposed tree for the confirmation dialog.
			function renderTaskLines(tasks: GoalTask[], indent = 0): string[] {
				const prefix = "  ".repeat(indent);
				const lines: string[] = [];
				for (const t of tasks) {
					const marker = t.status === "complete" ? "[x]" : t.status === "skipped" ? "[~]" : "[ ]";
					const lw = t.lightweightSubtasks ? " (lightweight)" : "";
					lines.push(`${prefix}${marker} ${t.id}: ${t.title}${lw}`);
					if (t.subtasks && t.subtasks.length > 0) {
						lines.push(...renderTaskLines(t.subtasks, indent + 1));
					}
				}
				return lines;
			}
			const taskLines = renderTaskLines(taskList.tasks);
			const gateLabel = blockCompletion ? " (blockCompletion enabled)" : "";
			const proposalText = [`Proposed task list${gateLabel}:`, "", ...taskLines].join("\n");
			const taskListFocus = core.focusedOperationToken(core.state.goal.id);
			const headless = shouldAutoConfirmProposal({ hasUI: ctx.hasUI, autoConfirmEnv: process.env.PI_GOAL_AUTO_CONFIRM });
			let dialogResult: { decision: "confirm" | "continue"; auditorEnabled: boolean };
			if (headless) {
				dialogResult = { decision: "confirm", auditorEnabled: core.state.goal?.skipAuditor ? false : true };
			} else {
				dialogResult = await showProposalDialog(ctx, proposalText, "goal", !core.state.goal?.skipAuditor);
			}
			if (!core.isFocusedOperationCurrent(taskListFocus)) {
				return core.focusedOperationCancelledResult("Task list proposal", taskListFocus);
			}
			if (dialogResult.decision !== "confirm") {
				return {
					content: [{ type: "text", text: "Task list proposal declined." }],
					details: goalDetails(core.state.goal),
				};
			}
			if (core.state.goal) {
				core.state.goal = { ...core.state.goal, skipAuditor: !dialogResult.auditorEnabled };
			}
			const applyResult = core.goalService.apply(ctx, {
				reconcile: false,
				focusToken: taskListFocus,
				refreshFromDisk: true,
				mutate: (g) => ({ ...g, taskList, updatedAt: now }),
				ledger: (written) => [{
					type: "task_list_set",
					goalId: written.id,
					taskCount: taskList.tasks.length,
					blockCompletion,
					at: written.updatedAt,
				}],
			});
			if (!applyResult.ok) {
				return core.focusedOperationCancelledResult("Task list proposal", taskListFocus);
			}
			core.runtime.markTurnStopped(core.state.goal.id);
			core.syncGoalTools();
			core.updateUI(ctx);
			return {
				content: [{ type: "text", text: `Task list set and confirmed. ${taskList.tasks.length} task${taskList.tasks.length === 1 ? "" : "s"}.${gateLabel}` }],
				details: goalDetails(core.state.goal),
				terminate: true,
			};
		},
		renderCall(args, theme) {
			const summary = args?.change_summary ? truncateText(args.change_summary, 80) : `${args?.tasks?.length ?? 0} tasks`;
			return new Text(theme.fg("toolTitle", "set_goal_tasks ") + theme.fg("muted", summary), 0, 0);
		},
		renderResult(result, _options, theme) {
			return renderGoalResult(result, theme);
		},
	}));

	// ── update_goal_task: discriminated per-task status tool ───────────────────
	pi.registerTool(defineTool({
		name: UPDATE_GOAL_TASK_TOOL_NAME,
		label: "Update Goal Task",
		description: "Update one task in the focused goal's task tree without stopping the turn: status \"complete\" (with optional evidence; requires evidence when the task has a verification contract and enforces completed children), \"skipped\" (requires a reason; restricted to explicit user direction or a hard contradiction), or \"pending\" (reopens a skipped task). Completed tasks are immutable through this tool.",
		promptSnippet: "Mark one task complete, skipped, or reopened. Does not stop the turn.",
		promptGuidelines: [
			"Use update_goal_task to update exactly one task; the turn does NOT stop so you may continue with other work.",
			"status=complete requires evidence when the task has a verification contract, and requires all non-lightweight children to be complete first.",
			"status=skipped requires a concrete reason and is restricted to explicit user direction or a hard contradiction (e.g. an impossible requirement). Do not skip to avoid work.",
			"status=pending reopens a skipped task (clears its skip state). Completed tasks cannot be reopened through this tool.",
		],
		parameters: Type.Object({
			task_id: Type.String({ description: "Task id to update" }),
			status: StringEnum(["complete", "skipped", "pending"] as const, { description: "complete (with optional evidence), skipped (requires reason), or pending (reopens a skipped task)." }),
			evidence: Type.Optional(Type.String({ description: "Evidence note for complete (max 200 characters). Required when the task has a verification contract." })),
			reason: Type.Optional(Type.String({ description: "Reason for skipped. Required when status=skipped." })),
		}, { additionalProperties: false }),
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			core.reconcileFocusedGoalFromDisk(ctx);
			if (loadGoalSettings(ctx.cwd).disableTasks) {
				return {
					content: [{ type: "text", text: "update_goal_task is disabled by settings (disableTasks: true)." }],
					details: goalDetails(core.state.goal),
				};
			}
			const gate = validateTaskCompletion({ goal: core.state.goal, taskId: params.task_id });
			// The completion gate rejects skipped/complete tasks; for status=pending
			// (reopen) we intentionally bypass it — the reopen rules are enforced in
			// the pending branch below.
			if (!gate.ok && params.status !== "pending") {
				return {
					content: [{ type: "text", text: gate.message }],
					details: goalDetails(core.state.goal),
				};
			}
			if (!core.state.goal?.taskList) throw new Error("Task list disappeared during task update.");
			const taskToUpdate = findTaskInTree(core.state.goal.taskList.tasks, params.task_id);
			if (!taskToUpdate) throw new Error(`Task ${params.task_id} not found.`);
			const settings = loadGoalSettings(ctx.cwd);
			const now = nowIso();

			if (params.status === "complete") {
				if (!settings.disableContracts && taskToUpdate.verificationContract && !params.evidence?.trim()) {
					return {
						content: [{ type: "text", text: `Task "${params.task_id}" has a verification contract; provide evidence to complete it.` }],
						details: goalDetails(core.state.goal),
					};
				}
				const subtaskGate = checkSubtasksComplete(taskToUpdate);
				if (subtaskGate) {
					return {
						content: [{ type: "text", text: subtaskGate }],
						details: goalDetails(core.state.goal),
					};
				}
				const evidence = params.evidence?.trim().slice(0, 200) || undefined;
				const updatedTasks = updateTaskInTree(core.state.goal.taskList.tasks, params.task_id, (t) => ({
					...t,
					status: "complete" as const,
					completedAt: now,
					evidence,
				}));
				const result = core.goalService.apply(ctx, {
					reconcile: false,
					refreshFromDisk: true,
					mutate: (g) => {
						if (!g.taskList) throw new Error("Task list disappeared during task update.");
						return { ...g, taskList: { ...g.taskList, tasks: updatedTasks }, updatedAt: now };
					},
					ledger: (written) => [{
						type: "task_complete",
						goalId: written.id,
						taskId: params.task_id,
						evidence,
						at: written.updatedAt,
					}],
				});
				if (!result.ok) {
					return { content: [{ type: "text", text: result.message }], details: goalDetails(core.state.goal) };
				}
				core.syncGoalTools();
				core.updateUI(ctx);
				return {
					content: [{ type: "text", text: `${params.task_id} complete. ${buildTaskSummary(core.state.goal.taskList!)}.` }],
					details: goalDetails(core.state.goal),
				};
			}

			if (params.status === "skipped") {
				const reason = params.reason?.trim();
				if (!reason) {
					return {
						content: [{ type: "text", text: "update_goal_task(status=skipped) requires a non-empty reason." }],
						details: goalDetails(core.state.goal),
					};
				}
				const skipGate = validateTaskSkip({ goal: core.state.goal, taskId: params.task_id, reason });
				if (!skipGate.ok) {
					return {
						content: [{ type: "text", text: skipGate.message }],
						details: goalDetails(core.state.goal),
					};
				}
				const updatedTasks = updateTaskInTree(core.state.goal.taskList.tasks, params.task_id, (t) => {
					const base = { ...t, status: "skipped" as const, skippedAt: now, skipReason: reason };
					if (t.subtasks && t.subtasks.length > 0 && !t.lightweightSubtasks) {
						return skipAllSubtasks(base, now, reason);
					}
					return base;
				});
				const result = core.goalService.apply(ctx, {
					reconcile: false,
					refreshFromDisk: true,
					mutate: (g) => {
						if (!g.taskList) throw new Error("Task list disappeared during task update.");
						return { ...g, taskList: { ...g.taskList, tasks: updatedTasks }, updatedAt: now };
					},
					ledger: (written) => [{
						type: "task_skipped",
						goalId: written.id,
						taskId: params.task_id,
						reason,
						at: written.updatedAt,
					}],
				});
				if (!result.ok) {
					return { content: [{ type: "text", text: result.message }], details: goalDetails(core.state.goal) };
				}
				core.syncGoalTools();
				core.updateUI(ctx);
				return {
					content: [{ type: "text", text: `${params.task_id} skipped. ${buildTaskSummary(core.state.goal.taskList!)}.` }],
					details: goalDetails(core.state.goal),
				};
			}

			// status === "pending": reopen a skipped task; completed tasks are immutable.
			if (taskToUpdate.status === "complete") {
				return {
					content: [{ type: "text", text: `Task "${params.task_id}" is complete and cannot be reopened through update_goal_task.` }],
					details: goalDetails(core.state.goal),
				};
			}
			if (taskToUpdate.status !== "skipped") {
				return {
					content: [{ type: "text", text: `Task "${params.task_id}" is not skipped; only skipped tasks can be reopened with status=pending.` }],
					details: goalDetails(core.state.goal),
				};
			}
			const updatedTasks = updateTaskInTree(core.state.goal.taskList.tasks, params.task_id, (t) => {
				const { skippedAt, skipReason, ...rest } = t;
				return { ...rest, status: "pending" as const };
			});
			const result = core.goalService.apply(ctx, {
				reconcile: false,
				refreshFromDisk: true,
				mutate: (g) => {
					if (!g.taskList) throw new Error("Task list disappeared during task update.");
					return { ...g, taskList: { ...g.taskList, tasks: updatedTasks }, updatedAt: now };
				},
				ledger: (written) => [{
					type: "task_skipped",
					goalId: written.id,
					taskId: params.task_id,
					reason: "unskipped (toggle via update_goal_task status=pending)",
					at: written.updatedAt,
				}],
			});
			if (!result.ok) {
				return { content: [{ type: "text", text: result.message }], details: goalDetails(core.state.goal) };
			}
			core.syncGoalTools();
			core.updateUI(ctx);
			return {
				content: [{ type: "text", text: `${params.task_id} reopened. ${buildTaskSummary(core.state.goal.taskList!)}.` }],
				details: goalDetails(core.state.goal),
			};
		},
		renderCall(args, theme) {
			return new Text(theme.fg("toolTitle", "update_goal_task ") + theme.fg("muted", `${args?.task_id ?? ""} ${args?.status ?? ""}`), 0, 0);
		},
		renderResult(result, _options, theme) {
			return renderGoalResult(result, theme);
		},
	}));


}
