import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { extractVerificationContract, sisyphusObjectiveSufficient } from "./goal-contract.ts";
import { buildDraftConfirmationText, buildProposalSummary, buildTweakConfirmationText, goalDraftingPrompt, type GoalDraftingFocus } from "./goal-draft.ts";
import { renderConfirmationTasks } from "./goal-task-confirmation.ts";
import { deriveTasksFromObjective } from "./goal-task-derive.ts";
import { goalDetails, renderGoalResult } from "./goal-format.ts";
import { buildGoalCreatedReport } from "./goal-policy.ts";
import { loadGoalSettings } from "./goal-settings.ts";
import { DIALOG_UNAVAILABLE_HINT, formatQuestionnaireAnswers, runGoalQuestionnaire, shouldAutoConfirmProposal, showProposalDialog, type GoalQuestionnaireQuestion, type ProposalDecision } from "./goal-questionnaire.ts";
import { currentTaskIdIsPending, nowIso, type GoalRecord, type GoalTaskList } from "./goal-record.ts";
import type { GoalCore } from "./goal-state.ts";
import { convertFlatTasks, countTasks, mergeTasksWithExisting, type FlatTaskInput } from "./goal-task-tools.ts";
import { PROPOSE_DRAFT_TOOL_NAME, QUESTIONNAIRE_TOOL_NAME, QUESTION_TOOL_NAME } from "./goal-tool-names.ts";

export type GoalDraftMode = GoalDraftingFocus | "tweak";

export const DRAFT_ENTRY = "pi-goal-draft";
export const DRAFT_ENTRY_VERSION = 1;

/**
 * Branch-local durable draft session, persisted through custom session entries
 * so an unconfirmed draft survives compaction and tree navigation. It is never
 * a project goal file or ledger event.
 */
export interface GoalDraftSession {
	version: 1;
	mode: GoalDraftMode;
	seed: string;
	targetGoalId?: string;
	startedAt: string;
	auditorEnabled: boolean;
	/** Tombstone marker: set when the draft is cancelled, confirmed, or replaced. */
	clearedAt?: string;
}

export interface ActiveGoalDraft {
	mode: GoalDraftMode;
	originalTopic: string;
	targetGoalId?: string;
	startedAt: string;
	auditorEnabled: boolean;
	/** E5: formatted questionnaire Q&A to echo in the created-goal report. */
	questionnaireEcho?: string;
}

const activeDrafts = new WeakMap<GoalCore, ActiveGoalDraft>();

function activeDraft(core: GoalCore): ActiveGoalDraft | undefined { return activeDrafts.get(core); }

export function hasActiveDraft(core: GoalCore): boolean { return activeDraft(core) !== undefined; }

function draftSessionEntry(core: GoalCore, session: GoalDraftSession): void {
	try {
		core.pi.appendEntry(DRAFT_ENTRY, session);
	} catch {}
}

export function clearGoalDrafting(core: GoalCore, ctx: ExtensionContext): void {
	if (!activeDrafts.has(core)) return;
	const existing = activeDrafts.get(core)!;
	activeDrafts.delete(core);
	// Tombstone the durable entry: the last entry wins on rehydration.
	draftSessionEntry(core, { version: 1, mode: existing.mode, seed: existing.originalTopic, targetGoalId: existing.targetGoalId, startedAt: existing.startedAt, auditorEnabled: existing.auditorEnabled, clearedAt: nowIso() });
	core.installGoalToolProfile(core.tasksEnabled);
	void ctx;
}

/**
 * Rehydrate a durable draft on session_start / session_tree. Restores the
 * transient drafting profile only for a valid, un-cleared draft whose tweak
 * target still matches the focused goal; stale tweak drafts are tombstoned.
 */
export function rehydrateDraft(core: GoalCore, ctx: ExtensionContext): void {
	// Validate any live memory draft against the reloaded world first: a tweak
	// draft whose target is no longer focused is stale and must not survive.
	if (activeDraft(core)) {
		const live = activeDraft(core)!;
		if (live.mode === "tweak") {
			core.reconcileFocusedGoalFromDisk(ctx);
			if (!core.state.goal || core.state.goal.id !== live.targetGoalId) {
				clearGoalDrafting(core, ctx);
				ctx.ui.notify("The goal tweak draft is stale (its target goal changed); it was discarded.", "warning");
			}
		}
		return;
	}
	let session: GoalDraftSession | null = null;
	try {
		const entries = ctx.sessionManager.getBranch();
		for (let i = entries.length - 1; i >= 0; i--) {
			const entry = entries[i] as { type?: string; customType?: string; data?: unknown };
			if (entry.type === "custom" && entry.customType === DRAFT_ENTRY) {
				session = entry.data as GoalDraftSession;
				break;
			}
		}
	} catch {
		session = null;
	}
	if (!session || session.version !== DRAFT_ENTRY_VERSION || session.clearedAt) {
		// No durable draft: make sure a previous drafting profile is not left
		// installed (e.g. after a stale entry or an interrupted session).
		core.installGoalToolProfile(core.tasksEnabled);
		return;
	}
	if (session.mode === "tweak") {
		core.reconcileFocusedGoalFromDisk(ctx);
		if (!core.state.goal || core.state.goal.id !== session.targetGoalId) {
			// The tweak target is gone or no longer focused — the draft is stale.
			draftSessionEntry(core, { ...session, clearedAt: nowIso() });
			ctx.ui.notify("The goal tweak draft is stale (its target goal changed); it was discarded.", "warning");
			core.installGoalToolProfile(core.tasksEnabled);
			return;
		}
	}
	activeDrafts.set(core, { mode: session.mode, originalTopic: session.seed, targetGoalId: session.targetGoalId, startedAt: session.startedAt, auditorEnabled: session.auditorEnabled });
	core.installDraftingToolProfile();
}

async function awaitDraftChoice(core: GoalCore, ctx: ExtensionContext, label: string): Promise<"resume" | "replace" | "cancel"> {
	void core;
	const choices = ["Resume the existing draft", "Replace it with a new draft", "Cancel"];
	core.enterGoalModal();
	try {
		const selected = await ctx.ui.select(`A ${label.toLowerCase()} is already active`, choices);
		if (!selected || selected === choices[0]!) return "resume";
		if (selected === choices[2]) return "cancel";
		return "replace";
	} finally {
		core.exitGoalModal();
	}
}

export async function startGoalDrafting(core: GoalCore, ctx: ExtensionContext, mode: GoalDraftMode, topic: string, targetGoal?: GoalRecord): Promise<void> {
	const trimmed = topic.trim();
	const label = mode === "sisyphus" ? "Sisyphus draft" : mode === "tweak" ? "Goal tweak draft" : "Goal draft";
	// A second draft must never silently discard the first.
	if (activeDraft(core)) {
		const choice = ctx.hasUI
			? await awaitDraftChoice(core, ctx, label)
			: "replace"; // headless: explicit new intent wins, but not silently (notified)
		if (choice === "resume") {
			ctx.ui.notify("A draft is already active; resuming it. Use /goal-cancel to discard it.", "info");
			return;
		}
		if (choice === "cancel") {
			ctx.ui.notify("Draft start cancelled; the existing draft stays active.", "info");
			return;
		}
		ctx.ui.notify("Replacing the active draft with a new " + label.toLowerCase() + ".", "warning");
		clearGoalDrafting(core, ctx);
	}
	const startedAt = nowIso();
	// §tweak-persist: a tweak confirmation defaults to the target goal's
	// persisted per-goal auditor setting (skipAuditor); the global `auditor
	// disabled` setting is only the fallback when the goal has no per-goal
	// value. Confirming a tweak must never silently re-enable or disable the
	// auditor the user chose when the goal was created.
	const auditorEnabled = mode === "tweak"
		? !(targetGoal?.skipAuditor ?? loadGoalSettings(ctx.cwd).disabled)
		: !loadGoalSettings(ctx.cwd).disabled;
	activeDrafts.set(core, { mode, originalTopic: trimmed, targetGoalId: targetGoal?.id, startedAt, auditorEnabled });
	draftSessionEntry(core, { version: 1, mode, seed: trimmed, targetGoalId: targetGoal?.id, startedAt, auditorEnabled });
	core.clearContinuationState();
	core.clearActiveAccounting();
	core.installDraftingToolProfile();
	ctx.ui.notify(label + " started" + (trimmed ? ": " + trimmed.slice(0, 60) : "") + ". The agent will clarify, propose a goal and tasks where useful, then ask you to confirm.", "info");
	const prompt = mode === "tweak" ? [
		"[GOAL TWEAK DRAFT]",
		"The user wants to revise the focused persistent goal. Discuss requirements as needed; do not edit files or start substantive work.",
		"Propose the complete revised objective with propose_goal_draft. Preserve the current goal mode. Include a complete flat task list when the revision changes a decomposable plan; omit tasks to retain the current list.",
		"Current objective:", targetGoal?.objective ?? "(goal no longer available)",
		"User request:", trimmed || "(ask what they want to change)",
	].join("\n") : goalDraftingPrompt(trimmed, mode);
	try {
		core.pi.sendUserMessage(prompt, { deliverAs: ctx.isIdle() ? "followUp" : "steer" });
	} catch (err) {
		clearGoalDrafting(core, ctx);
		ctx.ui.notify("Could not start " + label.toLowerCase() + ": " + (err instanceof Error ? err.message : String(err)), "error");
	}
}

function proposedTaskList(core: GoalCore, ctx: ExtensionContext, tasks: FlatTaskInput[] | undefined, blockCompletion: boolean | undefined): { ok: true; value?: GoalTaskList } | { ok: false; message: string } {
	if (tasks === undefined) return { ok: true };
	if (!core.tasksEnabled) return { ok: false, message: "Task lists are disabled by settings; omit tasks from this proposal." };
	const converted = convertFlatTasks(tasks, { maxSubtaskDepth: loadGoalSettings(ctx.cwd).subtaskDepth ?? 1 });
	if (!converted.ok) return converted;
	return { ok: true, value: { tasks: converted.tasks, blockCompletion: blockCompletion === true, proposedAt: nowIso() } };
}

export function proposalText(draft: ActiveGoalDraft, objective: string, autoContinue: boolean, taskList: GoalTaskList | undefined, current?: GoalRecord): string {
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
		// §single-task-set: the derived preview must derive from the SAME
		// objective text the apply path persists (extracted — the Verification
		// contract line removed), so shown == persisted.
		const derived = deriveTasksFromObjective(extractVerificationContract(objective).objective);
		if (derived && derived.length > 0) {
			tasksText = "\n\nTasks derived from the objective (confirm or ask the agent to adjust):\n" + renderConfirmationTasks(derived, 0).join("\n");
		}
	}
	return base + tasksText;
}

function flatTaskSchema() {
	return Type.Array(Type.Object({
		id: Type.String({ description: "Short stable slug, for example task-1." }),
		title: Type.String({ description: "Human-readable task title." }),
		parent_id: Type.Optional(Type.String({ description: "Optional parent task id in this proposal." })),
		verification_contract: Type.Optional(Type.String({ description: "Evidence required for this task." })),
		lightweight_subtasks: Type.Optional(Type.Boolean({ description: "True only for a task with lightweight children." })),
	}), { description: "Flat parent-linked task tree to confirm with the goal." });
}

export function registerDraftingTools(core: GoalCore): void {
	const { pi } = core;
	pi.registerTool(defineTool({
		name: QUESTION_TOOL_NAME,
		label: "Ask Drafting Question",
		description: "Ask one structured question during a user-started goal draft.",
		promptSnippet: "Ask the user one focused drafting question.",
		parameters: Type.Object({
			question: Type.String({ description: "The question to ask." }),
			options: Type.Optional(Type.Array(Type.String({ description: "A concise answer option." }))),
			recommended: Type.Optional(Type.Integer({ minimum: 0, description: "Zero-based recommended option." })),
			allow_custom: Type.Optional(Type.Boolean({ description: "Allow a custom answer; defaults to true." })),
		}, { additionalProperties: false }),
		async execute(_id, params, _signal, _update, ctx) {
			if (!activeDraft(core)) return { content: [{ type: "text", text: "No guided goal draft is active. Ask the user to run /goal or /sisyphus." }], details: goalDetails(core.state.goal) };
			core.enterGoalModal();
			try {
				const result = await runGoalQuestionnaire(ctx, [{ id: "question", question: params.question, options: params.options ?? [], recommended: params.recommended, allowCustom: params.allow_custom }]);
				if (result.unavailable === true) return { content: [{ type: "text", text: `${DIALOG_UNAVAILABLE_HINT} Ask the question in chat instead.` }], details: goalDetails(core.state.goal) };
				return { content: [{ type: "text", text: result.cancelled ? "The user cancelled the question. Continue drafting conversationally." : formatQuestionnaireAnswers(result) }], details: goalDetails(core.state.goal) };
			} finally {
				core.exitGoalModal();
			}
		},
		renderCall() { return new Text("goal_question", 0, 0); },
		renderResult(result, _opts, theme) { return renderGoalResult(result, _opts, theme); },
	}));

	pi.registerTool(defineTool({
		name: QUESTIONNAIRE_TOOL_NAME,
		label: "Run Drafting Questionnaire",
		description: "Ask a short structured questionnaire during a user-started goal draft.",
		promptSnippet: "Ask only the questions needed to make the goal and task plan concrete.",
		parameters: Type.Object({
			questions: Type.Array(Type.Object({
				id: Type.String({ description: "Stable question id." }),
				question: Type.String({ description: "Question for the user." }),
				context: Type.Optional(Type.String({ description: "Optional short context." })),
				options: Type.Array(Type.String({ description: "Answer option." })),
				recommended: Type.Optional(Type.Integer({ minimum: 0 })),
				allow_custom: Type.Optional(Type.Boolean()),
			})),
		}, { additionalProperties: false }),
		async execute(_id, params, _signal, _update, ctx) {
			if (!activeDraft(core)) return { content: [{ type: "text", text: "No guided goal draft is active." }], details: goalDetails(core.state.goal) };
			const questions: GoalQuestionnaireQuestion[] = params.questions.map((q: GoalQuestionnaireQuestion & { allow_custom?: boolean }) => ({ ...q, allowCustom: q.allow_custom }));
			core.enterGoalModal();
			try {
				const result = await runGoalQuestionnaire(ctx, questions);
				if (!result.cancelled) {
					const active = activeDraft(core);
					if (active) active.questionnaireEcho = formatQuestionnaireAnswers(result); // E5
				}
				if (result.unavailable === true) return { content: [{ type: "text", text: `${DIALOG_UNAVAILABLE_HINT} Ask the questions in chat instead.` }], details: goalDetails(core.state.goal) };
				return { content: [{ type: "text", text: result.cancelled ? "The user cancelled the questionnaire. Continue drafting conversationally." : formatQuestionnaireAnswers(result) }], details: goalDetails(core.state.goal) };
			} finally {
				core.exitGoalModal();
			}
		},
		renderCall() { return new Text("goal_questionnaire", 0, 0); },
		renderResult(result, _opts, theme) { return renderGoalResult(result, _opts, theme); },
	}));

	pi.registerTool(defineTool({
		name: PROPOSE_DRAFT_TOOL_NAME,
		label: "Propose Goal Draft",
		description: "Present the drafted objective and agent-selected task plan for explicit user confirmation.",
		promptSnippet: "Confirm the proposed goal and any useful task tree in one dialog.",
		promptGuidelines: [
			"Use only during a /goal, /sisyphus, or /goal-tweak guided draft.",
			"Clarify ambiguity before proposing. Include tasks when the work naturally decomposes into trackable milestones; omit them for genuinely simple work.",
			"Confirmation creates or revises the goal atomically. Continue Chatting leaves drafting active for refinement.",
		],
		parameters: Type.Object({
			objective: Type.String({ description: "Complete proposed objective, including criteria and constraints." }),
			auto_continue: Type.Optional(Type.Boolean({ description: "Defaults to true." })),
			sisyphus: Type.Optional(Type.Boolean({ description: "Must match the user-selected goal mode." })),
			tasks: Type.Optional(flatTaskSchema()),
			block_completion: Type.Optional(Type.Boolean({ description: "Require task completion before goal completion." })),
		}, { additionalProperties: false }),
		executionMode: "sequential",
		async execute(_id, params, _signal, _update, ctx) {
			const draft = activeDraft(core);
			if (!draft) return { content: [{ type: "text", text: "No guided goal draft is active. Do not create a goal without the user starting /goal or /sisyphus." }], details: goalDetails(core.state.goal) };
			const objective = params.objective.trim();
			if (!objective) return { content: [{ type: "text", text: "The proposed objective must be at least 1 character." }], details: goalDetails(core.state.goal) };
			const objectiveMaxChars = loadGoalSettings(ctx.cwd).objectiveMaxChars ?? 0;
			if (objectiveMaxChars > 0 && objective.length > objectiveMaxChars) return { content: [{ type: "text", text: `The proposed objective must be at most ${objectiveMaxChars} characters (${objective.length} given).` }], details: goalDetails(core.state.goal) };
			const expectedSisyphus = draft.mode === "sisyphus";
			if (draft.mode !== "tweak" && ((params.sisyphus === true) !== expectedSisyphus)) return { content: [{ type: "text", text: "Proposal mode does not match the command that began this draft." }], details: goalDetails(core.state.goal) };
			const taskResult = proposedTaskList(core, ctx, params.tasks as FlatTaskInput[] | undefined, params.block_completion);
			if (!taskResult.ok) return { content: [{ type: "text", text: taskResult.message }], details: goalDetails(core.state.goal) };
			core.reconcileFocusedGoalFromDisk(ctx);
			const target = draft.mode === "tweak" ? core.state.goal : undefined;
			if (draft.mode === "tweak" && (!target || target.id !== draft.targetGoalId)) return { content: [{ type: "text", text: "The goal changed while drafting; review it and start /goal-tweak again." }], details: goalDetails(core.state.goal) };
			if (draft.mode === "sisyphus" && !sisyphusObjectiveSufficient(objective)) return { content: [{ type: "text", text: "A Sisyphus goal needs ordered steps with explicit per-step done criteria. Refine the objective with numbered steps (1) ..., 2) ...) or Step N: blocks before proposing again." }], details: goalDetails(core.state.goal) };
			const auditorLine = draft.auditorEnabled
				? "\n\nAuditor for this goal: enabled (independent approval required before completion)."
				: "\n\nAuditor for this goal: disabled (completion skips the audit).";
			let confirmation: { decision: ProposalDecision; auditorEnabled: boolean; unavailable: boolean };
			if (shouldAutoConfirmProposal({ hasUI: ctx.hasUI, autoConfirmEnv: process.env.PI_GOAL_AUTO_CONFIRM })) {
				confirmation = { decision: "confirm" as const, auditorEnabled: draft.auditorEnabled, unavailable: false };
			} else {
				core.enterGoalModal();
				try {
					confirmation = await showProposalDialog(ctx, proposalText(draft, objective, params.auto_continue !== false, taskResult.value, target ?? undefined) + auditorLine, draft.mode === "sisyphus" ? "sisyphus" : "goal", draft.auditorEnabled);
				} finally {
					core.exitGoalModal();
				}
			}
			const settings = loadGoalSettings(ctx.cwd);
			const extracted = settings.disableContracts ? { objective, verificationContract: undefined } : extractVerificationContract(objective);
			// §14: the durable proposal summary is part of the transcript for
			// EVERY outcome (confirm / continue refining / cancel), so the user
			// can review the proposal after the dialog closes.
			const summary = buildProposalSummary({
				objective: extracted.objective,
				taskList: taskResult.value,
				verificationContract: extracted.verificationContract,
				autoContinue: params.auto_continue !== false,
				auditorEnabled: draft.auditorEnabled,
			});
			if (confirmation.decision === "cancel") {
				clearGoalDrafting(core, ctx);
				return { content: [{ type: "text", text: `${summary}\n\nDraft cancelled; no goal was created. Run /goal or /sisyphus to start a new draft.` }], details: goalDetails(core.state.goal) };
			}
			if (confirmation.unavailable) {
				return { content: [{ type: "text", text: `${summary}\n\n${DIALOG_UNAVAILABLE_HINT} The goal was NOT created and drafting remains active; do not propose again until the user confirms in chat or restarts with PI_GOAL_AUTO_CONFIRM=1.` }], details: goalDetails(core.state.goal) };
			}
			if (confirmation.decision !== "confirm") {
				// Continue refining: preserve the user's auditor choice for the
				// next proposal (memory and the durable session entry).
				if (confirmation.auditorEnabled !== draft.auditorEnabled) {
					const next = { ...draft, auditorEnabled: confirmation.auditorEnabled };
					activeDrafts.set(core, next);
					draftSessionEntry(core, { version: 1, mode: next.mode, seed: next.originalTopic, targetGoalId: next.targetGoalId, startedAt: next.startedAt, auditorEnabled: next.auditorEnabled });
				}
				return { content: [{ type: "text", text: `${summary}\n\nGoal draft refinement requested. The goal was not changed; ask what the user wants revised before proposing again.` }], details: goalDetails(core.state.goal) };
			}
			const skipAuditor = confirmation.auditorEnabled === false;
			// §14: capture the questionnaire answers BEFORE clearing draft state so
			// the confirmed-goal report can include them reliably (E5).
			const qaEcho = draft.questionnaireEcho;
			if (draft.mode !== "tweak") {
				// F2: if the confirmation carried no task plan but the objective has
				// structure, bootstrap the derived tree so the goal starts trackable.
				const effectiveTaskList: GoalTaskList | undefined = taskResult.value ?? (() => {
					const derived = deriveTasksFromObjective(extracted.objective);
					return derived && derived.length > 0 ? { tasks: derived, blockCompletion: false, proposedAt: nowIso() } : undefined;
				})();
				core.replaceGoal({ objective: extracted.objective, autoContinue: params.auto_continue !== false, sisyphus: expectedSisyphus, taskList: effectiveTaskList, skipAuditor }, ctx, true, extracted.verificationContract);
				clearGoalDrafting(core, ctx);
				const created = core.state.goal;
				return { content: [{ type: "text", text: `${summary}\n\n${buildGoalCreatedReport({
					objective: extracted.objective,
					detailedSummary: qaEcho,
					confirmed: true,
					goalId: created?.id,
					filePath: created?.activePath,
					taskCount: created?.taskList ? countTasks(created.taskList.tasks) : undefined,
					verificationContract: created?.verificationContract,
					auditorEnabled: !skipAuditor,
					tokenBudget: created?.tokenBudget,
				})}` }], details: goalDetails(core.state.goal), terminate: true };
			}
			if (!target) return { content: [{ type: "text", text: "The goal changed while drafting; review it and start /goal-tweak again." }], details: goalDetails(core.state.goal) };
			const token = core.focusedOperationToken(target.id);
			const now = nowIso();
			// §7.5 merge: a goal tweak must never change the status of steps that
			// persist across the tweak. The proposed list merges into the goal's
			// existing tree by id (same semantics as set_goal_tasks): surviving ids
			// keep status/evidence/completedAt/skippedAt/skipReason, new ids start
			// pending, removed ids drop. currentTaskId survives only while its task
			// is still pending in the merged tree.
			// §tweak-resume: a confirmed tweak is a deliberate revision of a
			// stalled goal — set when the goal actually transitions out of
			// paused/blocked so the post-apply glue can resume accounting,
			// continuation, and the ledger event.
			let resumed = false;
			const result = core.goalService.apply(ctx, {
				reconcile: false, focusToken: token, refreshFromDisk: true,
				mutate: (goal) => {
					const proposed = taskResult.value;
					const mergedTaskList = proposed && goal.taskList
						? { ...proposed, tasks: mergeTasksWithExisting(goal.taskList.tasks, proposed.tasks) }
						: proposed;
					const taskList = mergedTaskList ?? goal.taskList;
					const currentTaskId = mergedTaskList && goal.currentTaskId && !currentTaskIdIsPending(mergedTaskList.tasks, goal.currentTaskId)
						? undefined
						: goal.currentTaskId;
					// §tweak-resume: resume a paused/blocked goal (mirror the
					// /goal-resume transition: status active + pause metadata
					// cleared); budget_limited stays behind its hard resource
					// gate and an active goal stays active.
					const stalled = goal.status === "paused" || goal.status === "blocked";
					if (stalled) resumed = true;
					return {
						...goal,
						objective: extracted.objective,
						verificationContract: extracted.verificationContract ?? goal.verificationContract,
						taskList, currentTaskId, skipAuditor,
						status: stalled ? "active" : goal.status,
						autoContinue: stalled ? true : goal.autoContinue,
						stopReason: stalled ? undefined : goal.stopReason,
						pauseReason: stalled ? undefined : goal.pauseReason,
						pauseSuggestedAction: stalled ? undefined : goal.pauseSuggestedAction,
						updatedAt: now,
					};
				},
				ledger: (written) => [{ type: "goal_tweaked", goalId: written.id, changeSummary: "Goal revised through /goal-tweak drafting.", at: written.updatedAt }, ...(taskResult.value ? [{ type: "task_list_set" as const, goalId: written.id, taskCount: countTasks(written.taskList?.tasks), blockCompletion: taskResult.value.blockCompletion, at: written.updatedAt }] : [])],
			});
			if (!result.ok) return { content: [{ type: "text", text: "Goal tweak was not applied: " + result.message }], details: goalDetails(core.state.goal) };
			if (resumed) {
				try {
					core.goalService.appendEvents(ctx, [{ type: "goal_resumed", goalId: result.goal.id, reason: "tweak", at: nowIso() }]);
				} catch {
					// Ledger append failure should not crash the tweak.
				}
			}
			core.clearContinuationState();
			core.updateUI(ctx);
			if (resumed) {
				// Resume glue mirrors replaceGoal: restart accounting and queue
				// the auto-continuation so the revived goal keeps going.
				core.beginAccounting();
				core.queueContinuation(ctx, true);
			}
			clearGoalDrafting(core, ctx);
			return { content: [{ type: "text", text: `${summary}\n\nGoal tweak confirmed and applied.` }], details: goalDetails(result.goal), terminate: true };
		},
		renderCall(args, theme) {
			// §proposal-presentation: the tool-call display lands in the terminal
			// buffer the moment the tool call starts — BEFORE the confirmation
			// dialog opens — so it is the scrollable "complete presentation" of
			// the goal. It must show the full objective contract AND every task
			// line; the dialog frame alone cannot (its churn-guard bound keeps
			// it within the terminal height). The user can scroll up and read
			// everything while the dialog is open ("the user can just scroll").
			const objective = String(args?.objective ?? "");
			let text = theme.fg("toolTitle", "propose_goal_draft ") + theme.fg("muted", objective);
			const flatTasks = Array.isArray(args?.tasks) ? (args.tasks as FlatTaskInput[]) : [];
			// §single-task-set: a proposal shows exactly ONE task set — the set
			// that will actually be persisted. Explicit tasks are that set; a
			// tweak without explicit tasks retains the current list (mirror
			// proposalText — never a derived-from-objective phantom); a new
			// draft without explicit tasks shows the F2-derived preview derived
			// from the SAME objective text the apply path persists (extracted).
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
		},
		renderResult(result, _opts, theme) { return renderGoalResult(result, _opts, theme); },
	}));
}
