import { createHash } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { commandHint, commandInstructions } from "./goal-controls.ts";
import { buildPostCompactionGoalDelta } from "./goal-compaction.ts";
import { latestAuditorResultForGoal, goalRuntimeEvents, type GoalLedgerEvent } from "./goal-ledger.ts";
import { shouldInjectPostCompactReminder } from "./goal-policy.ts";
import { formatTokenValue } from "./goal-display.ts";
import { modelBudgetLine, budgetRemaining } from "./goal-accounting.ts";
import type { GoalRecord } from "./goal-record.ts";
import { otherOpenGoalCount } from "./goal-pool.ts";
import { hasActiveDraft } from "./goal-drafting.ts";
import type {
	GoalContinuationControl,
	GoalFocusedGoalAccess,
	GoalLoadedCommands,
	GoalPoolAccess,
	RuntimeSlice,
	SchedulerSlice,
	WatchSlice,
} from "./goal-core-types.ts";

/** What building the model-facing goal state reads. */
export type GoalContextCore = GoalFocusedGoalAccess &
	GoalPoolAccess &
	GoalLoadedCommands &
	Pick<GoalContinuationControl, "isActionableContinuationGoal"> &
	RuntimeSlice<"clearPostCompactReminder" | "consumePostBudgetReminder" | "getCheckpointGoalId" | "isPostCompactReminderPending"> &
	SchedulerSlice<"isDenied"> &
	WatchSlice<"checkStall">;
import { loadGoalSettings } from "./settings/resolve.ts";
import {
	goalPromptParts,
	staleContinuationPrompt,
	unfocusedOpenGoalsPrompt,
	untrustedObjectiveBlock,
} from "./prompts/goal-prompts.ts";

/**
 * The model-facing goal state for one request, split by how often it changes:
 * the policy (kept in history, appended when it changes), the task list
 * (kept, appended when it changes), and request-only text sent with every
 * request and never kept: usage, scheduling, notes and one-shot reminders.
 */
interface GoalContextParts {
	state: string;
	counters?: string;
	ephemeral?: string;
	/** Which goal this is about. A different scope starts the retained prefix over. */
	scope: string;
}

/**
 * What the retained prefix is about. Pausing, resuming and changing limits
 * keep it; a different goal, or a changed objective, contract or style, does
 * not, because stale copies of those would contradict the new ones.
 */
function goalScope(goal: GoalRecord): string {
	const digest = createHash("sha256").update(JSON.stringify([goal.objective, goal.verificationContract ?? null, goal.sisyphus])).digest("hex").slice(0, 12);
	return `${goal.id}:${digest}`;
}

function auditorRejectionBody(report: string): string {
	return `An independent auditor previously rejected a completion request for this goal. Reason: ${report.slice(0, 300)}\nAddress the auditor's objections before requesting completion again.`;
}

/**
 * Request-only goal state split into a rarely-changing policy block and
 * per-turn counters. Other branches are stable-only: no live counters, focus,
 * or reminders enter the system prefix.
 */
export function goalContextParts(core: GoalContextCore, ctx: ExtensionContext): GoalContextParts | undefined {
	// During a draft the drafting prompt is in charge. The goal block would
	// ask for update_goal, which is blocked until the draft ends, and the
	// unfocused reminder would tell the agent to stop.
	if (hasActiveDraft(core)) return;
	const checkpoint = core.runtime.getCheckpointGoalId();
	if (checkpoint !== null && (core.scheduler.isDenied() || !core.isActionableContinuationGoal(checkpoint))) {
		return { state: staleContinuationPrompt(checkpoint, core.state.goal), scope: `stale:${checkpoint}` };
	}
	const goal = core.state.goal;
	if (!goal) return unfocusedState(core, ctx);

	// Several prompt enrichments may need the same ledger snapshot. Keep one
	// local read for this hook instead of repeatedly traversing the cached
	// ledger when rejection and post-compaction steering overlap.
	let promptEvents: GoalLedgerEvent[] | undefined;
	const ledgerEvents = () => promptEvents ??= goalRuntimeEvents(ctx, goal.id);

	switch (goal.status) {
		case "complete": return;
		case "paused": return pausedState(core, goal, ledgerEvents);
		case "budget_limited": return budgetLimitedState(core, goal);
		case "blocked": return { state: blockedState(core, goal), scope: goalScope(goal) };
		default: return activeState(core, ctx, goal, ledgerEvents);
	}
}

function unfocusedState(core: GoalContextCore, ctx: ExtensionContext): GoalContextParts | undefined {
	// Issue #72: hideUnfocusedPrompt opts out of the model-facing unfocused
	// reminder only. The stale-checkpoint guard and all focused-goal context are
	// unaffected.
	if (loadGoalSettings(ctx.cwd).hideUnfocusedPrompt === true) return;
	const openCount = otherOpenGoalCount(core.state.goalsById, null);
	if (openCount === 0) return;
	return { state: commandInstructions(unfocusedOpenGoalsPrompt(openCount), core.loadedCommands), scope: "unfocused" };
}

function pausedState(core: GoalContextCore, goal: GoalRecord, ledgerEvents: () => GoalLedgerEvent[]): GoalContextParts {
	const pauseExtras: string[] = [];
	if (goal.stopReason === "agent") {
		pauseExtras.push("");
		pauseExtras.push(`Pause reason: ${goal.pauseReason ?? "(unknown)"}`);
		if (goal.pauseSuggestedAction) pauseExtras.push(`Suggested action: ${goal.pauseSuggestedAction}`);
	}
	// Inject durable auditor feedback if available
	let auditorExtra = "";
	try {
		const auditorResult = latestAuditorResultForGoal(ledgerEvents(), goal.id);
		if (auditorResult && auditorResult.verdict === "disapproved") {
			auditorExtra = `\n\n[AUDITOR REJECTION] ${auditorRejectionBody(auditorResult.report)}`;
		}
	} catch {
		// Ledger read failure should not break the prompt
	}
	const state = `[PI GOAL PAUSED goalId=${goal.id}]\n${untrustedObjectiveBlock(goal)}${pauseExtras.join("\n")}${auditorExtra}\n\nThe goal is paused. Do not autonomously continue substantive work unless the user resumes it with ${commandHint("goal-resume", core.loadedCommands)}. If the user explicitly asks to finish the paused goal and the objective is already satisfied based on available evidence, you may call update_goal({status: "complete"}). To abandon a goal, the user runs ${commandHint("goal-clear", core.loadedCommands)}. Do not report the goal blocked in response to a pause.`;
	return { state, scope: goalScope(goal) };
}

/** Token-budget-limited goals get one-time wrap-up steering: summarize, do not start new substantive work, never claim completion unless real. */
function budgetLimitedState(core: GoalContextCore, goal: GoalRecord): GoalContextParts {
	const budgetText = modelBudgetLine(goal);
	// E4: surface the remaining-vs-overshoot fact in the wrap-up steering.
	const remaining = budgetRemaining(goal);
	const balanceText = typeof remaining === "number"
		? remaining < 0
			? ` — ${formatTokenValue(-remaining)} over the budget`
			: ` — ${formatTokenValue(remaining)} remaining`
		: "";
	// The one-time wrap-up steering is request-only, so it never lingers in history.
	const reminder = core.runtime.consumePostBudgetReminder()
		? `[TOKEN BUDGET REACHED goalId=${goal.id}]\nThe goal's lifetime token-spending cap (not context capacity) has been reached${budgetText ? ` (${budgetText}${balanceText})` : ""}. Wrap up the current work in one final response: summarize what was accomplished and what remains, do not start new substantive work, and do not claim the goal is complete unless it actually is. To continue, the user can use ${commandHint("goal-tweak", core.loadedCommands)} to raise or remove the token budget.`
		: "";
	const state = `[PI GOAL BUDGET LIMITED goalId=${goal.id}]\n${untrustedObjectiveBlock(goal)}${budgetText ? `\n${budgetText}` : ""}`;
	return reminder ? { state, ephemeral: reminder, scope: goalScope(goal) } : { state, scope: goalScope(goal) };
}

function blockedState(core: GoalContextCore, goal: GoalRecord): string {
	return `[PI GOAL BLOCKED goalId=${goal.id}]\n${untrustedObjectiveBlock(goal)}\nBlocker: ${goal.pauseReason ?? "unspecified"}\nThe goal is blocked; the user must run ${commandHint("goal-resume", core.loadedCommands)} before goal work continues.`;
}

function activeState(core: GoalContextCore, ctx: ExtensionContext, goal: GoalRecord, ledgerEvents: () => GoalLedgerEvent[]): GoalContextParts {
	const settings = loadGoalSettings(ctx.cwd);
	const { state: policy, counters, ephemeral: usage } = goalPromptParts(goal, { ...settings, commands: core.loadedCommands }, ctx.getContextUsage?.());
	// Short-lived notes (stall, post-compaction) are request-only: they ride
	// after the usage snapshot and leave no stale copy in history. An auditor
	// rejection lasts until the next audit, so it joins the policy block, which
	// is appended once when it changes.
	let state = policy;
	let ephemeral = usage;
	// F5: [GOAL STALLED] steering note when the detector fired.
	const stalledNote = core.watch.checkStall(ctx);
	if (stalledNote) ephemeral += stalledNote;
	// Inject durable auditor feedback if the latest result was a rejection
	try {
		const events = ledgerEvents();
		const auditorResult = latestAuditorResultForGoal(events, goal.id);
		if (auditorResult && auditorResult.verdict === "disapproved" && events.some((e) => e.type === "completion_requested" && e.goalId === goal.id)) {
			state = `${state}\n\n[AUDITOR REJECTION goalId=${goal.id}]\n${auditorRejectionBody(auditorResult.report)}`;
		}
	} catch {
		// Ledger read failure should not break the prompt
	}
	if (core.runtime.isPostCompactReminderPending() && shouldInjectPostCompactReminder({ pending: true, goal })) {
		core.runtime.clearPostCompactReminder();
		// After compaction the goal block already carries the objective, policy
		// and task contract, so inject only what compaction may have lost.
		// Falls back to a generic note if the ledger can't be read.
		try {
			const otherOpenCount = core.state.openGoals().filter((g) => g.id !== goal.id).length;
			const delta = buildPostCompactionGoalDelta({ goal, ledgerEvents: ledgerEvents(), otherOpenCount });
			ephemeral = `${ephemeral}\n\n${delta}`;
		} catch {
			ephemeral = `${ephemeral}\n\n[POST-COMPACTION RESYNC goalId=${goal.id}]\nThe conversation was just compacted. Re-read the objective and continue from the actual artifacts/state; do not rely on memory of the prior chat.`;
		}
	}
	return { state, ...(counters ? { counters } : {}), ephemeral, scope: goalScope(goal) };
}
