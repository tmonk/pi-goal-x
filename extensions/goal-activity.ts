/**
 * Human-readable activity feed (plan §12).
 *
 * Maps the durable ledger into concise, readable activity items for the
 * unified dashboard, `/goal-status`, and archived records. Pure module: no
 * TUI imports; formatting lives here so every surface reads the same text.
 *
 * Rules (from the plan):
 * - Prefer the task title over the task id.
 * - Include completion evidence only when concise.
 * - Exclude low-value checkpoint noise.
 * - Deduplicate repeated lifecycle events.
 * - Default to the latest three to five useful entries; preserve full history
 *   for verbose status and archived records.
 */

import { truncateText } from "./goal-display.ts";
import type { GoalLedgerEvent } from "./goal-ledger.ts";

export type GoalActivityKind = "goal" | "task" | "verification" | "audit" | "archive";

export interface GoalActivityItem {
	at: string;
	kind: GoalActivityKind;
	text: string;
	/**
	 * Display marker category for the dashboard feed: done (✓), current (▸),
	 * skipped (~), or neutral (·) — the renderer maps these to §5.2 symbols.
	 */
	marker?: "done" | "current" | "skipped";
}

export interface DeriveGoalActivityOptions {
	/** taskId → title lookup; falls back to the raw task id when absent. */
	taskTitles?: ReadonlyMap<string, string>;
	/** Maximum items to return (the latest N, in chronological order). Default 5. */
	limit?: number;
}

/** Completion evidence longer than this is omitted (kept only for full history). */
export const CONCISE_EVIDENCE_MAX = 48;
/** Lifecycle reasons (pause/block/skip) longer than this are truncated. */
export const ACTIVITY_REASON_MAX = 80;

function quote(title: string): string {
	return `“${title}”`;
}

function titleFor(taskTitles: ReadonlyMap<string, string> | undefined, taskId: string): string {
	const title = taskTitles?.get(taskId);
	return title ?? taskId;
}

function oneLine(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

function mapEvent(event: GoalLedgerEvent, taskTitles: ReadonlyMap<string, string> | undefined): GoalActivityItem | undefined {
	switch (event.type) {
		case "goal_created":
			return { at: event.at, kind: "goal", text: "Created and focused the goal." };
		case "goal_tweaked":
			return { at: event.at, kind: "goal", text: "Updated the goal objective and task plan." };
		case "auditor_toggled":
			return { at: event.at, kind: "goal", text: event.enabled ? "Turned the independent auditor on." : "Turned the independent auditor off." };
		case "goal_paused":
			return {
				at: event.at,
				kind: "goal",
				text: event.reason ? `Paused the goal — ${truncateText(oneLine(event.reason), ACTIVITY_REASON_MAX)}` : "Paused the goal.",
			};
		case "goal_resumed":
			return { at: event.at, kind: "goal", text: "Resumed the goal." };
		case "goal_blocked":
			return {
				at: event.at,
				kind: "goal",
				text: event.reason ? `Blocked — ${truncateText(oneLine(event.reason), ACTIVITY_REASON_MAX)}` : "Reported a blocker.",
			};
		case "goal_budget_limited":
			return { at: event.at, kind: "goal", text: "Reached the configured token budget." };
		case "goal_completed":
			return { at: event.at, kind: "goal", text: "Completed the goal." };
		case "goal_aborted":
			return {
				at: event.at,
				kind: "goal",
				text: event.reason ? `Aborted the goal — ${truncateText(oneLine(event.reason), ACTIVITY_REASON_MAX)}` : "Aborted the goal.",
			};
		case "task_started":
			return { at: event.at, kind: "task", marker: "current", text: `Started ${quote(titleFor(taskTitles, event.taskId))}.` };
		case "task_complete": {
			const title = titleFor(taskTitles, event.taskId);
			const evidence = event.evidence ? oneLine(event.evidence) : undefined;
			// Include evidence only when concise; never bloat the feed.
			const suffix = evidence && evidence.length <= CONCISE_EVIDENCE_MAX ? ` — ${evidence}` : "";
			return { at: event.at, kind: "task", marker: "done", text: `Completed ${quote(title)}.${suffix}` };
		}
		case "task_skipped": {
			const title = titleFor(taskTitles, event.taskId);
			const reason = event.reason ? ` — ${truncateText(oneLine(event.reason), ACTIVITY_REASON_MAX)}` : "";
			return { at: event.at, kind: "task", marker: "skipped", text: `Skipped ${quote(title)}${reason}.` };
		}
		case "task_reopened":
			return { at: event.at, kind: "task", text: `Reopened ${quote(titleFor(taskTitles, event.taskId))}.` };
		case "completion_requested":
			return { at: event.at, kind: "verification", text: "Requested completion review." };
		case "audit_started":
			return { at: event.at, kind: "audit", text: "Started independent completion review." };
		case "audit_result":
			return event.verdict === "approved"
				? { at: event.at, kind: "audit", text: "Independent auditor approved completion." }
				: event.verdict === "disapproved"
					? { at: event.at, kind: "audit", text: "Completion review requested additional work." }
					: { at: event.at, kind: "audit", text: "Completion review could not finish." };
		case "audit_skipped":
			return {
				at: event.at,
				kind: "audit",
				text:
					event.reason === "user_aborted"
						? "Completion review was aborted by the user."
						: "Skipped independent completion review (auditor disabled).",
			};
		case "goal_archived":
			return { at: event.at, kind: "archive", marker: "done", text: "Archived the completed goal." };
		// Low-value checkpoint noise / focus churn: excluded from the default feed.
		case "goal_focused":
		case "goal_unfocused":
		case "goal_stalled":
		case "goal_budget_warning":
		case "task_list_set":
			return undefined;
		default:
			return undefined;
	}
}

const indexedActivity = new WeakSet<readonly GoalLedgerEvent[]>();
export function indexedActivityEvents(events: GoalLedgerEvent[]): GoalLedgerEvent[] {
	indexedActivity.add(events);
	return events;
}

/** Stable event identity for append-order deduplication, independent of title edits. */
export function activityEventKey(event: GoalLedgerEvent): string | undefined {
	const item = mapEvent(event, undefined);
	return item ? `${item.kind}:${item.text}` : undefined;
}

const activityTypes = new Set([
	"goal_created", "goal_tweaked", "auditor_toggled", "goal_paused", "goal_resumed", "goal_blocked",
	"goal_budget_limited", "goal_completed", "goal_aborted", "task_started", "task_complete", "task_skipped",
	"task_reopened", "completion_requested", "audit_started", "audit_result", "audit_skipped", "goal_archived",
]);
export function isActivityEvent(event: GoalLedgerEvent): boolean { return activityTypes.has(event.type); }

/** Avoid formatting distinct task events during a cold ledger rebuild. */
export function sameActivityEvent(left: GoalLedgerEvent, right: GoalLedgerEvent): boolean {
	if (left.type !== right.type) return false;
	if ("taskId" in left && "taskId" in right && left.taskId !== right.taskId) return false;
	// Reasons/evidence use the exact display normalization for true duplicates.
	return activityEventKey(left) === activityEventKey(right);
}

/**
 * Derive the readable activity feed for one goal from its durable ledger
 * events. Returns items in chronological order (oldest first), capped to the
 * latest `limit` entries, with adjacent duplicates merged.
 */
export function deriveGoalActivity(
	events: readonly GoalLedgerEvent[],
	goalId: string,
	options: DeriveGoalActivityOptions = {},
): GoalActivityItem[] {
	const { taskTitles, limit = 5 } = options;
	const items: GoalActivityItem[] = [];
	if (indexedActivity.has(events)) {
		// Runtime indexes already deduplicate and sort. Format only the requested tail.
		for (let i = events.length - 1; i >= 0; i--) {
			const event = events[i]!;
			if (!("goalId" in event) || event.goalId !== goalId) continue;
			const item = mapEvent(event, taskTitles);
			if (item) items.push(item);
			if (limit > 0 && items.length >= limit) break;
		}
		return items.reverse().slice(-limit);
	}
	for (const event of events) {
		if (!("goalId" in event) || event.goalId !== goalId) continue;
		const item = mapEvent(event, taskTitles);
		if (!item) continue;
		const last = items[items.length - 1];
		if (last && last.kind === item.kind && last.text === item.text) continue;
		items.push(item);
	}
	// The ledger is append-ordered, but sort defensively so the feed is
	// always correctly ordered regardless of input order (stable sort keeps
	// equal timestamps in input order).
	items.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
	return items.slice(-limit);
}
