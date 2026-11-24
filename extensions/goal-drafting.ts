import { commandInstructions } from "./goal-controls.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { goalDraftingPrompt, type GoalDraftingFocus } from "./prompts/goal-draft-prompts.ts";
import { formatGoalBudget } from "./goal-policy.ts";
import { loadGoalSettings } from "./settings/resolve.ts";
import { nowIso, type GoalRecord } from "./goal-record.ts";
import type {
	GoalClockReset,
	GoalDiskSync,
	GoalFocusedGoalAccess,
	GoalLoadedCommands,
	GoalModalAccess,
	HostSlice,
} from "./goal-core-types.ts";
import { t } from "./i18n/index.ts";

type GoalDraftMode = GoalDraftingFocus | "tweak";

export const DRAFT_ENTRY = "pi-goal-draft";
const DRAFT_ENTRY_VERSION = 1;

/**
 * Branch-local durable draft session, persisted through custom session entries
 * so an unconfirmed draft survives compaction and tree navigation. It is never
 * a project goal file or ledger event.
 */
interface GoalDraftSession {
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

/** What a draft needs to record itself in the session. */
type DraftRecorder = HostSlice<"appendEntry">;

/** What starting a draft needs: the recorder plus asking the user, and stopping the goal clocks. */
export type GoalDraftingCore = DraftRecorder &
	HostSlice<"sendUserMessage"> &
	GoalFocusedGoalAccess &
	GoalModalAccess &
	GoalLoadedCommands &
	GoalDiskSync &
	GoalClockReset;

// One draft per core; the core is only the key here.
const activeDrafts = new WeakMap<object, ActiveGoalDraft>();

export function activeDraft(core: object): ActiveGoalDraft | undefined { return activeDrafts.get(core); }

export function hasActiveDraft(core: object): boolean { return activeDraft(core) !== undefined; }

function draftSessionEntry(core: DraftRecorder, session: GoalDraftSession): void {
	try {
		core.pi.appendEntry(DRAFT_ENTRY, session);
	} catch {}
}

function sessionOf(draft: ActiveGoalDraft, clearedAt?: string): GoalDraftSession {
	return {
		version: 1,
		mode: draft.mode,
		seed: draft.originalTopic,
		targetGoalId: draft.targetGoalId,
		startedAt: draft.startedAt,
		auditorEnabled: draft.auditorEnabled,
		...(clearedAt ? { clearedAt } : {}),
	};
}

/** Make `draft` the active draft in memory and in the durable session entry. */
export function setActiveDraft(core: DraftRecorder & object, draft: ActiveGoalDraft): void {
	activeDrafts.set(core, draft);
	draftSessionEntry(core, sessionOf(draft));
}

export function clearGoalDrafting(core: DraftRecorder & object, ctx: ExtensionContext): void {
	const existing = activeDrafts.get(core);
	if (!existing) return;
	activeDrafts.delete(core);
	// Tombstone the durable entry: the last entry wins on rehydration.
	draftSessionEntry(core, sessionOf(existing, nowIso()));
	void ctx;
}

/**
 * Rehydrate a durable draft on session_start / session_tree. Restores only a
 * valid, un-cleared draft whose tweak target still matches the focused goal;
 * stale tweak drafts are tombstoned.
 */
export function rehydrateDraft(core: DraftRecorder & GoalDiskSync & GoalFocusedGoalAccess, ctx: ExtensionContext): void {
	const live = activeDraft(core);
	activeDrafts.delete(core);
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
	if (!session || session.version !== DRAFT_ENTRY_VERSION || session.clearedAt) return;
	if (session.mode === "tweak") {
		core.reconcileFocusedGoalFromDisk(ctx);
		if (!core.state.goal || core.state.goal.id !== session.targetGoalId) {
			// The tweak target is gone or no longer focused — the draft is stale.
			draftSessionEntry(core, { ...session, clearedAt: nowIso() });
			ctx.ui.notify(t("The goal tweak draft is stale (its target goal changed); it was discarded."), "warning");
			return;
		}
	}
	const sameDraft = live?.startedAt === session.startedAt && live.originalTopic === session.seed && live.mode === session.mode && live.targetGoalId === session.targetGoalId;
	activeDrafts.set(core, {
		mode: session.mode,
		originalTopic: session.seed,
		targetGoalId: session.targetGoalId,
		startedAt: session.startedAt,
		auditorEnabled: session.auditorEnabled,
		...(sameDraft ? { questionnaireEcho: live.questionnaireEcho } : {}),
	});
}

async function awaitDraftChoice(core: GoalModalAccess, ctx: ExtensionContext, label: string): Promise<"resume" | "replace" | "cancel"> {
	const choices = [t("Resume the existing draft"), t("Replace it with a new draft"), t("Cancel")];
	core.state.enterModal();
	try {
		const selected = await ctx.ui.select(t("A {label} is already active", { label: label.toLowerCase() }), choices);
		if (!selected || selected === choices[0]!) return "resume";
		if (selected === choices[2]) return "cancel";
		return "replace";
	} finally {
		core.state.exitModal();
	}
}

function tweakDraftPrompt(topic: string, targetGoal: GoalRecord | undefined): string {
	return [
		"[GOAL TWEAK DRAFT]",
		"The user wants to revise the focused persistent goal. Discuss requirements as needed; do not edit files or start substantive work.",
		"Propose the complete revised objective with propose_goal_draft. Preserve the current goal mode. Include a complete flat task list when the revision changes a decomposable plan; omit tasks to retain the current list.",
		"For budget-only changes preserve the objective, tasks, mode and auditor. token_budget: positive integer sets the total lifetime limit; null removes it; omit to retain it. Change budgets only when requested. Do not add clarification steps when the request is clear.",
		formatGoalBudget(targetGoal?.tokenBudget),
		"Current objective:", targetGoal?.objective ?? "(goal no longer available)",
		"User request:", topic || "(ask what they want to change)",
	].join("\n");
}

export async function startGoalDrafting(core: GoalDraftingCore, ctx: ExtensionContext, mode: GoalDraftMode, topic: string, targetGoal?: GoalRecord): Promise<void> {
	const trimmed = topic.trim();
	const label = mode === "sisyphus" ? t("Sisyphus draft") : mode === "tweak" ? t("Goal tweak draft") : t("Goal draft");
	// A second draft must never silently discard the first.
	if (activeDraft(core)) {
		const choice = ctx.hasUI
			? await awaitDraftChoice(core, ctx, label)
			: "replace"; // headless: explicit new intent wins, but not silently (notified)
		if (choice === "resume") {
			ctx.ui.notify(commandInstructions(t("A draft is already active; resuming it. Use /goal-cancel to discard it."), core.loadedCommands), "info");
			return;
		}
		if (choice === "cancel") {
			ctx.ui.notify(t("Draft start cancelled; the existing draft stays active."), "info");
			return;
		}
		ctx.ui.notify(t("Replacing the active draft with a new {label}.", { label: label.toLowerCase() }), "warning");
		clearGoalDrafting(core, ctx);
	}
	// A tweak confirmation defaults to the target goal's persisted per-goal
	// auditor setting (skipAuditor); the global `auditor disabled` setting is
	// only the fallback when the goal has no per-goal value. Confirming a
	// tweak must never silently re-enable or disable the auditor the user
	// chose when the goal was created.
	const auditorEnabled = mode === "tweak"
		? !(targetGoal?.skipAuditor ?? loadGoalSettings(ctx.cwd).disabled)
		: !loadGoalSettings(ctx.cwd).disabled;
	setActiveDraft(core, { mode, originalTopic: trimmed, targetGoalId: targetGoal?.id, startedAt: nowIso(), auditorEnabled });
	core.clearContinuationState();
	core.clearActiveAccounting();
	ctx.ui.notify(trimmed
		? t("{label} started: {topic}. The agent will clarify, propose a goal and tasks where useful, then ask you to confirm.", { label, topic: trimmed.slice(0, 60) })
		: t("{label} started. The agent will clarify, propose a goal and tasks where useful, then ask you to confirm.", { label }), "info");
	const prompt = mode === "tweak" ? tweakDraftPrompt(trimmed, targetGoal) : goalDraftingPrompt(trimmed, mode, core.loadedCommands);
	try {
		core.pi.sendUserMessage(prompt, { deliverAs: ctx.isIdle() ? "followUp" : "steer" });
	} catch (err) {
		clearGoalDrafting(core, ctx);
		ctx.ui.notify(t("Could not start {label}: {error}", { label: label.toLowerCase(), error: err instanceof Error ? err.message : String(err) }), "error");
	}
}
