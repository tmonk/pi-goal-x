import { commandHint, commandInstructions } from "./goal-controls.ts";
import { randomUUID } from "node:crypto";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { extractVerificationContract, sisyphusObjectiveSufficient } from "./goal-contract.ts";
import { buildDraftConfirmationText, buildProposalSummary, buildTweakConfirmationText } from "./prompts/goal-draft-prompts.ts";
import { renderConfirmationTasks } from "./goal-task-confirmation.ts";
import { deriveTasksFromObjective } from "./goal-task-derive.ts";
import { goalTextResult, renderGoalResult } from "./goal-format.ts";
import { budgetReached } from "./goal-accounting.ts";
import { buildGoalCreatedReport, formatGoalBudget } from "./goal-policy.ts";
import { loadGoalSettings } from "./settings/resolve.ts";
import { DIALOG_UNAVAILABLE_HINT, proposalDialogFailureMessage, formatQuestionnaireAnswers, runGoalQuestionnaire, shouldAutoConfirmProposal, showProposalDialog, type GoalQuestionnaireQuestion, type ProposalDecision } from "./goal-questionnaire.ts";
import { currentTaskIdIsPending, nowIso, validateTokenBudgetInput, type GoalRecord, type GoalTaskList } from "./goal-record.ts";
import type { GoalLedgerEvent } from "./goal-ledger.ts";
import type {
	GoalClockReset,
	GoalDiskSync,
	GoalFocusedGoalAccess,
	GoalLoadedCommands,
	GoalModalAccess,
	GoalOperationGuard,
	GoalRecordWriter,
	GoalUiRefresh,
	HostSlice,
	LifecycleSlice,
	ProgressSlice,
	RuntimeSlice,
	SchedulerSlice,
	ServiceSlice,
	StateSlice,
} from "./goal-core-types.ts";

/** What the questionnaire and propose tools read and change. */
export type DraftingToolsCore = HostSlice<"registerTool" | "appendEntry"> &
	GoalFocusedGoalAccess &
	GoalOperationGuard &
	GoalModalAccess &
	GoalUiRefresh &
	GoalDiskSync &
	GoalLoadedCommands &
	GoalClockReset &
	GoalRecordWriter &
	StateSlice<"tasksEnabled"> &
	ServiceSlice<"isTurnBuffered" | "flushForAudit"> &
	LifecycleSlice<"create"> &
	ProgressSlice<"begin"> &
	RuntimeSlice<"armPostBudgetReminder" | "consumePostBudgetReminder"> &
	SchedulerSlice<"declare" | "cancelTimer" | "schedule">;
import { activeDraft, clearGoalDrafting, setActiveDraft, type ActiveGoalDraft } from "./goal-drafting.ts";
import { convertFlatTasks, countTasks, mergeTasksWithExisting, taskTreeSchema, type FlatTaskInput } from "./goal-task-tree.ts";
import { dropKey } from "./goal-tool-inputs.ts";
import { PROPOSE_DRAFT_TOOL_NAME, QUESTIONNAIRE_TOOL_NAME } from "./goal-tool-names.ts";

function proposedTaskList(core: DraftingToolsCore, ctx: ExtensionContext, tasks: FlatTaskInput[] | undefined, blockCompletion: boolean | undefined): { ok: true; value?: GoalTaskList } | { ok: false; message: string } {
	if (tasks === undefined) return { ok: true };
	if (!core.state.tasksEnabled) return { ok: false, message: "Task lists are disabled by settings; omit tasks from this proposal." };
	const converted = convertFlatTasks(tasks, { maxSubtaskDepth: loadGoalSettings(ctx.cwd).subtaskDepth ?? 1 });
	if (!converted.ok) return converted;
	return { ok: true, value: { tasks: converted.tasks, blockCompletion: blockCompletion === true, proposedAt: nowIso() } };
}

export function proposalText(draft: ActiveGoalDraft, objective: string, autoContinue: boolean, taskList: GoalTaskList | undefined, current?: GoalRecord, tokenBudget?: number | null): string {
	const base = draft.mode === "tweak" && current
		? buildTweakConfirmationText({ currentObjective: current.objective, newObjective: objective, changeSummary: draft.originalTopic || "Goal revised through guided drafting.", sisyphus: current.sisyphus, tasks: taskList?.tasks })
		: buildDraftConfirmationText({ focus: draft.mode === "sisyphus" ? "sisyphus" : "goal", originalTopic: draft.originalTopic, objective, autoContinue });
	// The task list is always shown exactly once in a proposal: explicitly
	// proposed tasks, or (new drafts) tasks derived from the RAW objective, or
	// (tweaks) the current goal's list when it is retained unchanged. Deriving
	// from the boxed base text would never match: formatPrefixedLines prefixes
	// every objective line with "│   " so checklist/ordered markers are hidden.
	let tasksText = "";
	if (draft.mode === "tweak") {
		// buildTweakConfirmationText already renders explicit tasks exactly once
		// inside its ┌─ TASKS ─┐ box; never append a second render. When no
		// explicit list is proposed the current list is retained on apply
		// (taskResult.value ?? goal.taskList), so preview it for confirmation.
		if (!taskList && current?.taskList && current.taskList.tasks.length > 0) {
			tasksText = "\n\nCurrent task list (retained unchanged):\n" + renderConfirmationTasks(current.taskList.tasks, 0).join("\n");
		}
	} else if (taskList && taskList.tasks.length > 0) {
		tasksText = "\n\nTasks proposed for confirmation:\n" + renderConfirmationTasks(taskList.tasks, 0).join("\n");
	} else {
		// The derived preview must derive from the SAME objective text the apply
		// path persists (extracted — the Verification contract line removed), so
		// shown == persisted.
		const derived = deriveTasksFromObjective(extractVerificationContract(objective).objective);
		if (derived && derived.length > 0) {
			tasksText = "\n\nTasks derived from the objective (confirm or ask the agent to adjust):\n" + renderConfirmationTasks(derived, 0).join("\n");
		}
	}
	const budgetText = draft.mode === "tweak"
		? `Current ${formatGoalBudget(current?.tokenBudget)}\nProposed ${formatGoalBudget(tokenBudget === undefined ? current?.tokenBudget : tokenBudget ?? undefined)}`
		: formatGoalBudget(tokenBudget ?? undefined);
	return `${budgetText}\n\n${base}${tasksText}`;
}

/** Everything a confirmed proposal needs to become a goal or a tweak. */
interface ConfirmedProposal {
	draft: ActiveGoalDraft;
	/** Objective with the verification contract extracted (unless contracts are disabled). */
	objective: string;
	verificationContract: string | undefined;
	taskList: GoalTaskList | undefined;
	autoContinue: boolean;
	/** The proposed token budget; undefined means none (or retained, for a tweak). */
	proposedBudget: number | undefined;
	budgetProvided: boolean;
	skipAuditor: boolean;
	/** The durable proposal summary shown on every outcome. */
	summary: string;
}

function createGoalFromDraft(core: DraftingToolsCore, ctx: ExtensionContext, proposal: ConfirmedProposal) {
	const { draft, objective, taskList, summary } = proposal;
	// F2: if the confirmation carried no task plan but the objective has
	// structure, bootstrap the derived tree so the goal starts trackable.
	const effectiveTaskList: GoalTaskList | undefined = taskList ?? (() => {
		const derived = deriveTasksFromObjective(objective);
		return derived && derived.length > 0 ? { tasks: derived, blockCompletion: false, proposedAt: nowIso() } : undefined;
	})();
	// Capture the questionnaire answers BEFORE clearing draft state so the
	// confirmed-goal report can include them reliably (E5).
	const qaEcho = draft.questionnaireEcho;
	core.lifecycle.create({ objective, autoContinue: proposal.autoContinue, sisyphus: draft.mode === "sisyphus", taskList: effectiveTaskList, skipAuditor: proposal.skipAuditor }, ctx, true, proposal.verificationContract, proposal.proposedBudget);
	clearGoalDrafting(core, ctx);
	const created = core.state.goal;
	return { ...goalTextResult(`${summary}\n\n${buildGoalCreatedReport({
		objective,
		detailedSummary: qaEcho,
		confirmed: true,
		goalId: created?.id,
		filePath: created?.activePath,
		taskCount: created?.taskList ? countTasks(created.taskList.tasks) : undefined,
		verificationContract: created?.verificationContract,
		auditorEnabled: !proposal.skipAuditor,
		tokenBudget: created?.tokenBudget,
	})}`, core.state.goal), terminate: true };
}

/** Ledger events for a confirmed tweak: budget changes, the tweak itself, and a replaced task list. */
function tweakLedgerEvents(target: GoalRecord, written: GoalRecord, taskList: GoalTaskList | undefined): GoalLedgerEvent[] {
	const events: GoalLedgerEvent[] = [];
	if (target.tokenBudget !== written.tokenBudget) {
		events.push({ type: "goal_budget_changed", goalId: written.id, oldBudget: target.tokenBudget ?? null, newBudget: written.tokenBudget ?? null, tokensUsed: written.usage.tokensUsed, at: written.updatedAt });
	}
	if (target.status !== "budget_limited" && written.status === "budget_limited") {
		events.push({ type: "goal_budget_limited", goalId: written.id, budget: written.tokenBudget!, tokensUsed: written.usage.tokensUsed, at: written.updatedAt });
	}
	events.push({ type: "goal_tweaked", goalId: written.id, changeSummary: "Goal revised through /goal-tweak drafting.", at: written.updatedAt });
	if (taskList) {
		events.push({ type: "task_list_set", goalId: written.id, taskCount: countTasks(written.taskList?.tasks), blockCompletion: taskList.blockCompletion, at: written.updatedAt });
	}
	return events;
}

async function applyGoalTweak(core: DraftingToolsCore, ctx: ExtensionContext, proposal: ConfirmedProposal, target: GoalRecord, token: { goalId: string; revision: number }, proposalRevision: number) {
	const { objective, summary, proposedBudget } = proposal;
	const reply = (text: string) => goalTextResult(text, core.state.goal);
	const finalFlushError = core.goalService.flushForAudit(ctx);
	core.reconcileFocusedGoalFromDisk(ctx);
	if (finalFlushError || core.goalService.isTurnBuffered() || !core.state.isTokenCurrent(token) || core.state.goal?.revision !== proposalRevision || core.state.goal?.status === "complete") {
		return reply("Goal tweak was not applied: the goal changed during confirmation. Review and propose again.");
	}
	const now = nowIso();
	// A goal tweak must never change the status of steps that persist across
	// it. The proposed list merges into the goal's existing tree by id (same
	// semantics as set_goal_tasks): surviving ids keep status/evidence/
	// completedAt/skippedAt/skipReason, new ids start pending, removed ids
	// drop. currentTaskId survives only while its task is still pending in the
	// merged tree.
	// A confirmed tweak is a deliberate revision of a stalled goal — `resumed`
	// is set when the goal actually transitions out of paused/blocked so the
	// post-apply glue can resume accounting, continuation, and the ledger event.
	let resumed = false;
	const result = core.goalService.apply(ctx, {
		reconcile: false, focusToken: token, refreshFromDisk: true,
		mutate: (goal) => {
			const proposed = proposal.taskList;
			const mergedTaskList = proposed && goal.taskList
				? { ...proposed, tasks: mergeTasksWithExisting(goal.taskList.tasks, proposed.tasks) }
				: proposed;
			const taskList = mergedTaskList ?? goal.taskList;
			const currentTaskId = mergedTaskList && goal.currentTaskId && !currentTaskIdIsPending(mergedTaskList.tasks, goal.currentTaskId)
				? undefined
				: goal.currentTaskId;
			// Resume a paused/blocked goal (mirror the /goal-resume transition:
			// status active + pause metadata cleared). A budget-limited goal needs
			// an explicit budget change that clears the resource gate; preserve
			// scheduler limits.
			const exhausted = budgetReached({...goal, tokenBudget: proposedBudget});
			const wantsResume = goal.status === "paused" || goal.status === "blocked" || (goal.status === "budget_limited" && proposal.budgetProvided && !exhausted);
			const scheduler = goal.scheduler;
			const owned = !scheduler || (scheduler.owner === (ctx.sessionManager.getSessionId() || "unknown-session") && !["interrupted", "claimed"].includes(scheduler.phase));
			const limit = loadGoalSettings(ctx.cwd).maxAutonomousRuns;
			const allowance = limit === undefined || (scheduler?.used ?? 0) < limit;
			const stalled = wantsResume && !exhausted && owned && allowance;
			if (stalled) resumed = true;
			return {
				...goal,
				tokenBudget: proposedBudget,
				...(exhausted && owned && scheduler ? {scheduler: {...scheduler, generation: randomUUID(), phase: "idle" as const, decision: undefined, dispatch: undefined, wait: undefined}} : {}),
				objective,
				verificationContract: proposal.verificationContract ?? goal.verificationContract,
				taskList, currentTaskId, skipAuditor: proposal.skipAuditor,
				status: exhausted && (goal.status === "active" || goal.status === "budget_limited" || wantsResume) ? "budget_limited" : stalled ? "active" : wantsResume ? "paused" : goal.status,
				autoContinue: stalled ? true : goal.autoContinue,
				stopReason: stalled ? undefined : goal.stopReason,
				pauseReason: stalled ? undefined : goal.pauseReason,
				pauseSuggestedAction: stalled ? undefined : goal.pauseSuggestedAction,
				updatedAt: now,
			};
		},
		ledger: (written) => tweakLedgerEvents(target, written, proposal.taskList),
	});
	if (!result.ok) return reply("Goal tweak was not applied: " + result.message);
	if (resumed) {
		try {
			core.goalService.appendEvents(ctx, [{ type: "goal_resumed", goalId: result.goal.id, reason: "tweak", at: nowIso() }]);
		} catch {
			// Ledger append failure should not crash the tweak.
		}
	}
	core.clearContinuationState();
	if (!budgetReached(result.goal)) core.runtime.consumePostBudgetReminder();
	else { core.runtime.armPostBudgetReminder(); core.clearActiveAccounting(); core.scheduler.cancelTimer(); }
	core.updateUI(ctx);
	let schedulingNote = "";
	if (resumed) {
		// Resume glue mirrors replaceGoal: restart accounting and queue the
		// auto-continuation so the revived goal keeps going.
		core.progress.begin();
		const scheduling = core.scheduler.declare(ctx, {kind: "ready"});
		if (!scheduling.terminate) schedulingNote = "\n" + scheduling.content.filter(item => item.type === "text").map(item => item.text).join("\n");
		core.scheduler.schedule(ctx);
	}
	clearGoalDrafting(core, ctx);
	const statusNote = result.goal.status === "budget_limited"
		? "\nConsumed tokens already meet this budget; the goal remains budget-limited."
		: result.goal.status === "paused" ? commandInstructions("\nGoal remains paused. Use /goal-resume to continue when scheduling permits.", core.loadedCommands) : "";
	return { ...goalTextResult(`${summary}\n\nGoal tweak confirmed and applied.\n${formatGoalBudget(result.goal.tokenBudget)}${schedulingNote}${statusNote}`, result.goal), terminate: true };
}

function registerQuestionnaireTool(core: DraftingToolsCore): void {
	core.pi.registerTool(defineTool({
		name: QUESTIONNAIRE_TOOL_NAME,
		label: "Ask Drafting Questions",
		description: "During a goal draft, ask the user one or more questions in a dialog.",
		parameters: Type.Object({
			questions: Type.Array(Type.Object({
				question: Type.String(),
				options: Type.Optional(Type.Array(Type.String())),
				recommended: Type.Optional(Type.Integer({ minimum: 0, description: "Index of the suggested option." })),
				allow_custom: Type.Optional(Type.Boolean({ description: "Default true." })),
				context: Type.Optional(Type.String()),
			}), { minItems: 1 }),
		}, { additionalProperties: false }),
		async execute(_id, params, _signal, _update, ctx) {
			const reply = (text: string) => goalTextResult(text, core.state.goal);
			if (!activeDraft(core)) return reply(commandInstructions("No guided goal draft is active. Ask the user to run /goal or /sisyphus.", core.loadedCommands));
			const questions: GoalQuestionnaireQuestion[] = params.questions.map((q, i) => ({
				id: `q${i + 1}`,
				question: q.question,
				context: q.context,
				options: q.options ?? [],
				recommended: q.recommended,
				allowCustom: q.allow_custom,
			}));
			core.state.enterModal();
			try {
				const result = await runGoalQuestionnaire(ctx, questions);
				if (!result.cancelled) {
					const active = activeDraft(core);
					if (active) active.questionnaireEcho = formatQuestionnaireAnswers(result); // E5
				}
				if (result.unavailable === true) return reply(`${DIALOG_UNAVAILABLE_HINT} Ask the questions in chat instead.`);
				return reply(result.cancelled ? "The user cancelled the questionnaire. Continue drafting conversationally." : formatQuestionnaireAnswers(result));
			} catch (error) {
				return reply(`Goal drafting dialog failed: ${error instanceof Error ? error.message : String(error)}. Drafting remains active; ask in chat instead of retrying the dialog.`);
			} finally {
				core.state.exitModal();
			}
		},
		renderCall() { return new Text(QUESTIONNAIRE_TOOL_NAME, 0, 0); },
		renderResult(result, _opts, theme) { return renderGoalResult(result, _opts, theme); },
	}));
}

/**
 * The tool-call display lands in the terminal buffer the moment the tool call
 * starts — BEFORE the confirmation dialog opens — so it is the scrollable
 * "complete presentation" of the goal. It must show the full objective
 * contract AND every task line; the dialog frame alone cannot (its
 * churn-guard bound keeps it within the terminal height).
 */
function renderProposalCall(core: DraftingToolsCore, args: { objective?: unknown; tasks?: unknown; auto_continue?: boolean; block_completion?: boolean } | undefined, theme: { fg(color: string, text: string): string; bold(text: string): string }): Text {
	const objective = String(args?.objective ?? "");
	let text = theme.fg("toolTitle", "propose_goal_draft ") + theme.fg("muted", objective);
	const flatTasks = Array.isArray(args?.tasks) ? (args.tasks as FlatTaskInput[]) : [];
	// A proposal shows exactly ONE task set — the set that will actually be
	// persisted. Explicit tasks are that set; a tweak without explicit tasks
	// retains the current list (mirror proposalText — never a
	// derived-from-objective phantom); a new draft without explicit tasks shows
	// the F2-derived preview derived from the SAME objective text the apply
	// path persists (extracted).
	let taskBlock: { header: string; lines: string[] } | null = null;
	if (flatTasks.length > 0) {
		taskBlock = { header: "Tasks proposed for confirmation:", lines: flatTasks.map((t) => `[ ] ${t.id}: ${t.title}`) };
	} else if (activeDraft(core)?.mode === "tweak") {
		const retained = core.state.goal?.taskList?.tasks;
		if (retained && retained.length > 0) {
			taskBlock = { header: "Current task list (retained unchanged):", lines: renderConfirmationTasks(retained, 0) };
		}
	} else {
		const derived = deriveTasksFromObjective(extractVerificationContract(objective).objective) ?? [];
		if (derived.length > 0) {
			taskBlock = { header: "Tasks derived from the objective (confirm or ask the agent to adjust):", lines: renderConfirmationTasks(derived, 0) };
		}
	}
	if (taskBlock) {
		text += "\n\n" + theme.fg("toolTitle", theme.bold(taskBlock.header)) + "\n" + theme.fg("toolOutput", taskBlock.lines.join("\n"));
	}
	if (args?.auto_continue === false) text += "\n\n" + theme.fg("muted", "Automatic continuation: disabled");
	if (args?.block_completion === true) text += "\n\n" + theme.fg("muted", "Block completion on pending tasks: enabled");
	return new Text(text, 0, 0);
}

function registerProposeTool(core: DraftingToolsCore): void {
	core.pi.registerTool(defineTool({
		name: PROPOSE_DRAFT_TOOL_NAME,
		label: "Propose Goal Draft",
		description: "Show the drafted goal, and tasks if any, for the user to confirm.",
		parameters: Type.Object({
			objective: Type.String({ description: "The whole goal block, headings included." }),
			tasks: Type.Optional(taskTreeSchema()),
			block_completion: Type.Optional(Type.Boolean({ description: "The goal cannot complete until every task is done." })),
			token_budget: Type.Optional(Type.Union([Type.Integer({ minimum: 1 }), Type.Null()], { description: "Only if the user asked for a budget. null removes it." })),
			auto_continue: Type.Optional(Type.Boolean({ description: "Default true." })),
		}, { additionalProperties: false }),
		// Older prompts asked for a sisyphus flag. The draft already knows its mode.
		prepareArguments: (args) => dropKey(args, "sisyphus") as never,
		executionMode: "sequential",
		async execute(_id, params, _signal, _update, ctx) {
			const reply = (text: string) => goalTextResult(text, core.state.goal);
			const draft = activeDraft(core);
			if (!draft) return reply(commandInstructions("No guided goal draft is active. Do not create a goal without the user starting /goal or /sisyphus.", core.loadedCommands));
			if (params.token_budget !== undefined && params.token_budget !== null) {
				const validation = validateTokenBudgetInput(params.token_budget);
				if (!validation.ok) return reply(validation.message);
			}
			const objective = params.objective.trim();
			if (!objective) return reply("The proposed objective must be at least 1 character.");
			const objectiveMaxChars = loadGoalSettings(ctx.cwd).objectiveMaxChars ?? 0;
			if (objectiveMaxChars > 0 && objective.length > objectiveMaxChars) return reply(`The proposed objective must be at most ${objectiveMaxChars} characters (${objective.length} given).`);
			const taskResult = proposedTaskList(core, ctx, params.tasks as FlatTaskInput[] | undefined, params.block_completion);
			if (!taskResult.ok) return reply(taskResult.message);
			const flushError = core.goalService.flushForAudit(ctx);
			if (flushError || core.goalService.isTurnBuffered()) return reply("Proposal not saved: " + (flushError ?? "goal changes are still buffered"));
			core.reconcileFocusedGoalFromDisk(ctx);
			const target = draft.mode === "tweak" ? core.state.goal : undefined;
			if (draft.mode === "tweak" && (!target || target.id !== draft.targetGoalId)) return reply(commandInstructions("The goal changed while drafting; review it and start /goal-tweak again.", core.loadedCommands));
			if (target?.status === "complete") return goalTextResult("Completed goals cannot be tweaked.", target);
			const proposalToken = target ? core.state.focusToken(target.id) : undefined;
			const proposalRevision = target?.revision ?? 0;
			const proposedBudget = params.token_budget === undefined ? target?.tokenBudget : params.token_budget ?? undefined;
			const budgetSummary = target ? `Current ${formatGoalBudget(target.tokenBudget)}\nProposed ${formatGoalBudget(proposedBudget)}` : formatGoalBudget(proposedBudget);
			if (draft.mode === "sisyphus" && !sisyphusObjectiveSufficient(objective)) return reply("A Sisyphus goal needs ordered steps with explicit per-step done criteria. Refine the objective with numbered steps (1) ..., 2) ...) or Step N: blocks before proposing again.");
			let confirmation: { decision: ProposalDecision; auditorEnabled: boolean; unavailable: boolean };
			if (shouldAutoConfirmProposal({ hasUI: ctx.hasUI, autoConfirmEnv: process.env.PI_GOAL_AUTO_CONFIRM })) {
				confirmation = { decision: "confirm" as const, auditorEnabled: draft.auditorEnabled, unavailable: false };
			} else {
				core.state.enterModal();
				try {
					confirmation = await showProposalDialog(ctx, proposalText(draft, objective, params.auto_continue !== false, taskResult.value, target ?? undefined, params.token_budget), draft.mode === "sisyphus" ? "sisyphus" : "goal", draft.auditorEnabled);
				} catch (error) {
					return reply(`${proposalDialogFailureMessage(error)} Do not retry the dialog until the host issue is resolved.`);
				} finally {
					core.state.exitModal();
				}
			}
			const settings = loadGoalSettings(ctx.cwd);
			const extracted = settings.disableContracts ? { objective, verificationContract: undefined } : extractVerificationContract(objective);
			// The durable proposal summary is part of the transcript for EVERY
			// outcome (confirm / continue refining / cancel), so the user can
			// review the proposal after the dialog closes.
			const summary = budgetSummary + "\n\n" + buildProposalSummary({
				objective: extracted.objective,
				taskList: taskResult.value,
				verificationContract: extracted.verificationContract,
				autoContinue: params.auto_continue !== false,
				auditorEnabled: confirmation.auditorEnabled,
			});
			if (confirmation.decision === "cancel") {
				clearGoalDrafting(core, ctx);
				return reply(`${summary}\n\nDraft cancelled; no goal was created. Run ${commandHint("goal", core.loadedCommands)} or ${commandHint("sisyphus", core.loadedCommands)} to start a new draft.`);
			}
			if (confirmation.unavailable) {
				return reply(`${summary}\n\n${DIALOG_UNAVAILABLE_HINT} The goal was NOT created and drafting remains active; do not retry the dialog until the host supports it or the user explicitly restarts with PI_GOAL_AUTO_CONFIRM=1.`);
			}
			if (confirmation.decision !== "confirm") {
				// Continue refining: preserve the user's auditor choice for the
				// next proposal (memory and the durable session entry).
				if (confirmation.auditorEnabled !== draft.auditorEnabled) setActiveDraft(core, { ...draft, auditorEnabled: confirmation.auditorEnabled });
				return reply(`${summary}\n\nGoal draft refinement requested. The goal was not changed; ask what the user wants revised before proposing again.`);
			}
			const proposal: ConfirmedProposal = {
				draft,
				objective: extracted.objective,
				verificationContract: extracted.verificationContract,
				taskList: taskResult.value,
				autoContinue: params.auto_continue !== false,
				proposedBudget,
				budgetProvided: params.token_budget !== undefined,
				skipAuditor: confirmation.auditorEnabled === false,
				summary,
			};
			if (draft.mode !== "tweak") return createGoalFromDraft(core, ctx, proposal);
			if (!target) return reply(commandInstructions("The goal changed while drafting; review it and start /goal-tweak again.", core.loadedCommands));
			return applyGoalTweak(core, ctx, proposal, target, proposalToken!, proposalRevision);
		},
		renderCall(args, theme) { return renderProposalCall(core, args, theme); },
		renderResult(result, _opts, theme) { return renderGoalResult(result, _opts, theme); },
	}));
}

export function registerDraftingTools(core: DraftingToolsCore): void {
	registerQuestionnaireTool(core);
	registerProposeTool(core);
}
