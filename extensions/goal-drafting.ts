import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { extractVerificationContract, sisyphusObjectiveSufficient } from "./goal-contract.ts";
import { buildDraftConfirmationText, buildTweakConfirmationText, goalDraftingPrompt, renderConfirmationTasks, type GoalDraftingFocus } from "./goal-draft.ts";
import { goalDetails, renderGoalResult } from "./goal-format.ts";
import { buildGoalCreatedReport } from "./goal-policy.ts";
import { loadGoalSettings } from "./goal-settings.ts";
import { formatQuestionnaireAnswers, runGoalQuestionnaire, shouldAutoConfirmProposal, showProposalDialog, type GoalQuestionnaireQuestion } from "./goal-questionnaire.ts";
import { nowIso, type GoalRecord, type GoalTaskList } from "./goal-record.ts";
import type { GoalCore } from "./goal-state.ts";
import { countTasks, convertFlatTasks, type FlatTaskInput } from "./goal-task-tools.ts";
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

interface ActiveGoalDraft {
	mode: GoalDraftMode;
	originalTopic: string;
	targetGoalId?: string;
	startedAt: string;
	auditorEnabled: boolean;
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
	const selected = await ctx.ui.select(`A ${label.toLowerCase()} is already active`, choices);
	if (!selected || selected === choices[0]!) return "resume";
	if (selected === choices[2]) return "cancel";
	return "replace";
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
	const auditorEnabled = !loadGoalSettings(ctx.cwd).disabled;
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

function proposalText(draft: ActiveGoalDraft, objective: string, autoContinue: boolean, taskList: GoalTaskList | undefined, current?: GoalRecord): string {
	const base = draft.mode === "tweak" && current
		? buildTweakConfirmationText({ currentObjective: current.objective, newObjective: objective, changeSummary: draft.originalTopic || "Goal revised through guided drafting.", sisyphus: current.sisyphus, tasks: taskList?.tasks })
		: buildDraftConfirmationText({ focus: draft.mode === "sisyphus" ? "sisyphus" : "goal", originalTopic: draft.originalTopic, objective, autoContinue });
	return !taskList || draft.mode === "tweak" ? base : base + "\n\nTasks proposed for confirmation:\n" + renderConfirmationTasks(taskList.tasks, 0).join("\n");
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
			const result = await runGoalQuestionnaire(ctx, [{ id: "question", question: params.question, options: params.options ?? [], recommended: params.recommended, allowCustom: params.allow_custom }]);
			return { content: [{ type: "text", text: result.cancelled ? "The user cancelled the question. Continue drafting conversationally." : formatQuestionnaireAnswers(result) }], details: goalDetails(core.state.goal) };
		},
		renderCall() { return new Text("goal_question", 0, 0); },
		renderResult(result, _opts, theme) { return renderGoalResult(result, theme); },
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
			const questions: GoalQuestionnaireQuestion[] = params.questions.map((q: any) => ({ ...q, allowCustom: q.allow_custom }));
			const result = await runGoalQuestionnaire(ctx, questions);
			return { content: [{ type: "text", text: result.cancelled ? "The user cancelled the questionnaire. Continue drafting conversationally." : formatQuestionnaireAnswers(result) }], details: goalDetails(core.state.goal) };
		},
		renderCall() { return new Text("goal_questionnaire", 0, 0); },
		renderResult(result, _opts, theme) { return renderGoalResult(result, theme); },
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
			if (!objective || objective.length > 4000) return { content: [{ type: "text", text: "The proposed objective must be between 1 and 4000 characters." }], details: goalDetails(core.state.goal) };
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
			const confirmation = shouldAutoConfirmProposal({ hasUI: ctx.hasUI, autoConfirmEnv: process.env.PI_GOAL_AUTO_CONFIRM })
				? { decision: "confirm" as const, auditorEnabled: draft.auditorEnabled }
				: await showProposalDialog(ctx, proposalText(draft, objective, params.auto_continue !== false, taskResult.value, target ?? undefined) + auditorLine, draft.mode === "sisyphus" ? "sisyphus" : "goal", draft.auditorEnabled);
			if (confirmation.decision === "cancel") {
				clearGoalDrafting(core, ctx);
				return { content: [{ type: "text", text: "Draft cancelled; no goal was created. Run /goal or /sisyphus to start a new draft." }], details: goalDetails(core.state.goal) };
			}
			if (confirmation.decision !== "confirm") {
				// Continue refining: preserve the user's auditor choice for the
				// next proposal (memory and the durable session entry).
				if (confirmation.auditorEnabled !== draft.auditorEnabled) {
					const next = { ...draft, auditorEnabled: confirmation.auditorEnabled };
					activeDrafts.set(core, next);
					draftSessionEntry(core, { version: 1, mode: next.mode, seed: next.originalTopic, targetGoalId: next.targetGoalId, startedAt: next.startedAt, auditorEnabled: next.auditorEnabled });
				}
				return { content: [{ type: "text", text: "Goal draft refinement requested. The goal was not changed; ask what the user wants revised before proposing again." }], details: goalDetails(core.state.goal) };
			}
			const skipAuditor = confirmation.auditorEnabled === false;
			const settings = loadGoalSettings(ctx.cwd);
			const extracted = settings.disableContracts ? { objective, verificationContract: undefined } : extractVerificationContract(objective);
			if (draft.mode !== "tweak") {
				core.replaceGoal({ objective: extracted.objective, autoContinue: params.auto_continue !== false, sisyphus: expectedSisyphus, taskList: taskResult.value, skipAuditor }, ctx, true, extracted.verificationContract);
				clearGoalDrafting(core, ctx);
				return { content: [{ type: "text", text: buildGoalCreatedReport({ objective: extracted.objective }) }], details: goalDetails(core.state.goal), terminate: true };
			}
			if (!target) return { content: [{ type: "text", text: "The goal changed while drafting; review it and start /goal-tweak again." }], details: goalDetails(core.state.goal) };
			const token = core.focusedOperationToken(target.id);
			const now = nowIso();
			const result = core.goalService.apply(ctx, {
				reconcile: false, focusToken: token, refreshFromDisk: true,
				mutate: (goal) => ({ ...goal, objective: extracted.objective, verificationContract: extracted.verificationContract ?? goal.verificationContract, taskList: taskResult.value ?? goal.taskList, skipAuditor, updatedAt: now }),
				ledger: (written) => [{ type: "goal_tweaked", goalId: written.id, changeSummary: "Goal revised through /goal-tweak drafting.", at: written.updatedAt }, ...(taskResult.value ? [{ type: "task_list_set" as const, goalId: written.id, taskCount: countTasks(taskResult.value.tasks), blockCompletion: taskResult.value.blockCompletion, at: written.updatedAt }] : [])],
			});
			if (!result.ok) return { content: [{ type: "text", text: "Goal tweak was not applied: " + result.message }], details: goalDetails(core.state.goal) };
			core.clearContinuationState();
			core.updateUI(ctx);
			clearGoalDrafting(core, ctx);
			return { content: [{ type: "text", text: "Goal tweak confirmed and applied." }], details: goalDetails(result.goal), terminate: true };
		},
		renderCall(args, theme) { return new Text(theme.fg("toolTitle", "propose_goal_draft ") + theme.fg("muted", args?.objective ?? ""), 0, 0); },
		renderResult(result, _opts, theme) { return renderGoalResult(result, theme); },
	}));
}
