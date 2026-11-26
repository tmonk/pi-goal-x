import { truncateText } from "./goal-display.ts";
import { latestAuditorResultForGoal, latestAuditForGoal, latestEventsForGoal, type GoalLedgerEvent } from "./goal-ledger.ts";
import { type GoalRecord } from "./goal-record.ts";
import { taskIndex } from "./goal-task-index.ts";

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
	// What the agent already found out. Compaction drops it, and finished tasks no longer appear in the task list.
	const finished = goal.taskList
		? taskIndex(goal.taskList.tasks).ordered.map(entry => entry.task)
			.filter(task => task.status === "complete" && task.evidence?.trim())
			.sort((a, b) => (b.completedAt ?? "").localeCompare(a.completedAt ?? ""))
			.slice(0, 5)
		: [];
	if (finished.length > 0) {
		lines.push("Recently completed, with the evidence recorded:");
		for (const task of finished) lines.push(`  ${truncateText(task.id, 80)}: ${truncateText(task.evidence!.trim(), 200)}`);
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
