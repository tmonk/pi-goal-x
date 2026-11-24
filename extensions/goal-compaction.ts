import {
	formatDuration,
	formatTokenValue,
	statusLabel,
	truncateText,
} from "./goal-display.ts";
import {
	latestAuditorResultForGoal, latestAuditForGoal,
	latestEventsForGoal,
	reconstructGoalLedger,
	type GoalLedgerEvent,
	type LedgerStateReadResult,
} from "./goal-ledger.ts";
import { type GoalRecord } from "./goal-record.ts";
import { taskIndex } from "./goal-task-index.ts";

export function buildGoalCompactSummary(
	goal: GoalRecord,
	events: GoalLedgerEvent[],
	auditorOverride?: { verdict: "approved" | "disapproved" | "error"; report: string; at: string },
): string {
	const lines: string[] = [];
	lines.push(`Goal ${goal.id} — ${statusLabel(goal)}`);
	lines.push(`  Objective: ${truncateText(goal.objective, 200)}`);
	if (goal.usage.tokensUsed > 0) {
		lines.push(`  Cumulative goal usage (not context occupancy): ${formatTokenValue(goal.usage.tokensUsed)}`);
	}
	if (goal.usage.activeSeconds > 0) {
		lines.push(`  Time: ${formatDuration(goal.usage.activeSeconds)}`);
	}

	const recent = latestEventsForGoal(events, goal.id, 5);
	if (recent.length > 0) {
		lines.push("  Recent events:");
		for (const event of recent) {
			switch (event.type) {
				case "goal_paused":
					lines.push(`    - paused: ${event.reason}`);
					break;
				case "goal_resumed":
					lines.push(`    - resumed: ${event.reason}`);
					break;
				case "goal_tweaked":
					lines.push(`    - tweaked: ${event.changeSummary}`);
					break;
				case "auditor_toggled":
					lines.push(`    - auditor toggled ${event.enabled ? "on" : "off"}`);
					break;
				case "completion_requested":
					lines.push(`    - completion requested${event.summary ? `: ${truncateText(event.summary, 80)}` : ""}`);
					break;
				case "audit_result":
					lines.push(`    - auditor ${event.verdict}${event.verdict === "disapproved" ? `: ${truncateText(event.report, 80)}` : ""}`);
					break;
				case "goal_completed":
					lines.push("    - completed");
					break;
				case "task_list_set":
					lines.push(`    - task list set: ${event.taskCount} tasks${event.blockCompletion ? " (blocking)" : ""}`);
					break;
				case "task_complete":
					lines.push(`    - task complete: ${event.taskId}${event.evidence ? ` — ${truncateText(event.evidence, 60)}` : ""}`);
					break;
				case "task_skipped":
					lines.push(`    - task skipped: ${event.taskId} — ${truncateText(event.reason, 60)}`);
					break;
				case "task_reopened":
					lines.push(`    - task reopened: ${event.taskId}`);
					break;
				case "goal_aborted":
					lines.push(`    - aborted: ${event.reason}`);
					break;
				default:
					break;
			}
		}
	}

	const auditor = auditorOverride ?? latestAuditorResultForGoal(events, goal.id);
	if (latestAuditForGoal(events, goal.id)?.type === "audit_started") lines.push("  Latest audit: no recorded result.");
	if (auditor && auditor.verdict === "disapproved") {
		lines.push(`  Auditor rejection (latest): ${truncateText(auditor.report, 120)}`);
	}

	if (goal.pauseReason) {
		lines.push(`  Pause reason: ${goal.pauseReason}`);
	}
	if (goal.pauseSuggestedAction) {
		lines.push(`  Suggested action: ${goal.pauseSuggestedAction}`);
	}

	return lines.join("\n");
}

export function buildCompactionSummary(args: {
	goalsById: Map<string, GoalRecord>;
	focusedGoalId: string | null;
	ledgerEvents?: GoalLedgerEvent[];
	/** Checkpoint-fed view: uses reconstructed state + per-goal recent tails instead of a full event list. */
	ledgerState?: LedgerStateReadResult;
	capOpenGoals?: number;
	capEventsPerGoal?: number;
}): string {
	const { goalsById, focusedGoalId, ledgerEvents = [], ledgerState, capOpenGoals = 20, capEventsPerGoal = 5 } = args;

	const lines: string[] = [];
	const openGoals = Array.from(goalsById.values()).filter((g) => g.status !== "complete");
	const reconstructed = ledgerState?.state ?? reconstructGoalLedger(ledgerEvents);
	const recentEventsFor = (goalId: string, cap: number): GoalLedgerEvent[] => {
		if (ledgerState) return (ledgerState.recentEventsByGoal.get(goalId) ?? []).slice(0, cap);
		return latestEventsForGoal(ledgerEvents, goalId, cap);
	};

	if (focusedGoalId && goalsById.has(focusedGoalId)) {
		const focused = goalsById.get(focusedGoalId)!;
		const auditor = ledgerState
			? reconstructed.goals.get(focusedGoalId)?.latestAuditorResult ?? reconstructed.terminalGoals.get(focusedGoalId)?.latestAuditorResult
			: undefined;
		lines.push(`[FOCUSED GOAL]`);
		lines.push(buildGoalCompactSummary(focused, recentEventsFor(focusedGoalId, capEventsPerGoal), auditor));
		lines.push("");
	}

	const otherOpen = openGoals.filter((g) => g.id !== focusedGoalId);
	if (otherOpen.length > 0) {
		lines.push(`[OTHER OPEN GOALS — ${otherOpen.length} total]`);
		for (const goal of otherOpen.slice(0, capOpenGoals)) {
			lines.push(`- ${goal.id} — ${statusLabel(goal)} — ${truncateText(goal.objective, 120)}`);
		}
		if (otherOpen.length > capOpenGoals) {
			lines.push(`... and ${otherOpen.length - capOpenGoals} more`);
		}
		lines.push("");
	}

	if (reconstructed.terminalGoals.size > 0) {
		lines.push(`[TERMINAL GOALS — ${reconstructed.terminalGoals.size} completed or aborted]`);
		for (const [goalId, state] of reconstructed.terminalGoals) {
			const label = state.latestStatus === "complete" ? "completed" : "aborted";
			lines.push(`- ${goalId} — ${label}${state.completedAt ? ` at ${state.completedAt}` : ""}${state.abortedAt ? ` at ${state.abortedAt}` : ""}`);
		}
		lines.push("");
	}

	if (openGoals.length === 0 && reconstructed.terminalGoals.size === 0) {
		lines.push("[NO GOALS]");
		lines.push("No open or terminal goals recorded in this session.");
	}

	lines.push("[INSTRUCTION]");
	lines.push("Continue from the focused goal above, or ask the user to run /goal-focus.");
	lines.push("Do not rely on chat memory for goal state; use the facts above.");

	return lines.join("\n");
}

/**
 * PR E §62: post-compaction DELTA for the focused goal. The active system
 * goal block already contains the objective, full policy, task gate, and
 * verification contract — this delta adds only what compaction may have
 * lost: the execution focus, a bounded recent-events tail, the latest
 * unresolved auditor finding, and the other-open-goals count.
 */
export function buildPostCompactionGoalDelta(args: {
	goal: GoalRecord;
	ledgerEvents: GoalLedgerEvent[];
	otherOpenCount: number;
}): string {
	const { goal, ledgerEvents, otherOpenCount } = args;
	const lines: string[] = [];
	lines.push(`[POST-COMPACTION RESYNC goalId=${goal.id}]`);
	// Execution focus (with contract) — the one thing memory must not lose.
	if (goal.currentTaskId && goal.taskList) {
		const current = taskIndex(goal.taskList.tasks).byId.get(goal.currentTaskId);
		if (current) {
			lines.push(`Current task: ${truncateText(current.id, 80)} — ${truncateText(current.title, 180)}${current.verificationContract ? ` (contract: ${truncateText(current.verificationContract, 600)})` : ""}`);
			if (current.id.length > 80 || current.title.length > 180 || (current.verificationContract?.length ?? 0) > 600) lines.push('Retrieve omitted task requirements with get_goal(section="tasks") before continuing.');
		}
	}
	// Bounded recent-event tail.
	const recent = latestEventsForGoal(ledgerEvents, goal.id, 5);
	if (recent.length > 0) {
		lines.push("Recent events:");
		for (const event of recent) {
			lines.push(`  ${event.at.slice(11, 19)} ${event.type}`);
		}
	}
	// Latest unresolved auditor finding.
	const audit = latestAuditorResultForGoal(ledgerEvents, goal.id);
	if (latestAuditForGoal(ledgerEvents, goal.id)?.type === "audit_started") lines.push("Latest audit: no recorded result.");
	if (audit && audit.verdict === "disapproved") {
		lines.push(`Latest unresolved auditor finding: ${audit.report.slice(0, 300)}`);
	}
	lines.push(`Other open goals: ${otherOpenCount}`);
	lines.push("Continue from authoritative files and goal storage.");
	return lines.join("\n");
}
