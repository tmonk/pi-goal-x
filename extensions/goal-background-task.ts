/**
 * Background-task observation for the goal scheduler.
 *
 * A detached task is a wait, not an execution disposition: pi reports the result
 * on its own, so burning autonomous runs polling it is pure waste.
 *
 * Producers announce detached work structurally, through the convention the
 * shared task catalog already uses: `@4fu/pi-tasks` reports a `phase`,
 * `@4fu/pi-pwsh` reports a `status`, and a subagent package reports whichever of
 * the two it already has. This module is the only place that reads it, and the
 * rule is deliberately producer-agnostic. Any tool participates by reporting a
 * non-terminal status or phase plus an id; a producer that reports nothing keeps
 * today's behaviour.
 *
 * Free text is never parsed, so an unrelated tool result can never pause a goal.
 */

import { asRecord } from "./goal-record.ts";

/** Producer values that mean the task is still running, from either field. */
const RUNNING_STATUSES = new Set([
	// `running` / `background` are what @tintinweb/pi-subagents reports for an
	// in-flight or detached agent; the rest are the shared task vocabulary.
	"starting", "running", "background", "active", "pending", "queued", "in_progress", "in-progress", "working", "waiting",
]);

/** Producer values that mean the task can no longer be waited on. */
const SETTLED_STATUSES = new Set([
	"completed", "complete", "done", "succeeded", "success", "failed", "failure", "error",
	"cancelled", "canceled", "aborted", "timedout", "timeout", "timed_out", "stopped", "deleted", "exited", "settled",
]);

/** Result-details fields that carry the producer's lifecycle value. */
const STATUS_FIELDS = ["status", "phase"] as const;

/** Result-details fields that name the task, most specific first. */
const ID_FIELDS = ["taskId", "task_id", "agentId", "agent_id", "id"] as const;

/** Result-details fields that describe the task, most specific first. */
const LABEL_FIELDS = ["summary", "label", "title", "name", "description", "command"] as const;

/**
 * Container fields a producer may nest the task object under. A producer can
 * report the task flat (`{ taskId, status }`) or nest it (`{ task: { id, status } }`,
 * which is what pi-background-tasks returns), so one shape is not enough.
 */
const NESTED_TASK_FIELDS = ["task"] as const;

/** Untrusted producer text stays short and single-line before it reaches a prompt. */
const MAX_LABEL_CHARS = 120;

/** Minimal shape of a `tool_result`/`tool_execution_end` event. */
export interface TaskResultLike {
	toolName: string;
	details?: unknown;
	input?: unknown;
	isError?: boolean;
}

export interface BackgroundTaskRef {
	/** Producer id (task, job, or agent id). Empty when the producer reports none. */
	id: string;
	/** Short single-line label for prompts, reasons, and notifications. */
	label: string;
	/** Tool that produced the result. */
	toolName: string;
}

export type BackgroundTaskObservation =
	| { kind: "running"; task: BackgroundTaskRef }
	| { kind: "settled"; taskId: string };

function readId(details: Record<string, unknown>): string {
	for (const field of ID_FIELDS) {
		const value = details[field];
		if (typeof value === "string" && value.trim()) return value.trim().slice(0, 200);
	}
	return "";
}

function readLabel(details: Record<string, unknown>, id: string, toolName: string): string {
	for (const field of LABEL_FIELDS) {
		const value = details[field];
		if (typeof value === "string" && value.trim()) {
			const single = value.replace(/\s+/g, " ").trim().slice(0, MAX_LABEL_CHARS);
			if (single) return `${toolName}: ${single}`;
		}
	}
	return id ? `${toolName} task ${id}` : `${toolName} background task`;
}

function readStatus(details: Record<string, unknown>): string {
	for (const field of STATUS_FIELDS) {
		const value = details[field];
		if (typeof value === "string" && value.trim()) return value.trim().toLowerCase();
	}
	return "";
}

/**
 * The object that carries the task's lifecycle value: the details themselves, or
 * the nested task object when that is the one with a value. Reading the flat
 * fields first keeps every producer that reports at the top level unchanged.
 */
function taskScope(details: Record<string, unknown>): Record<string, unknown> {
	if (readStatus(details)) return details;
	for (const field of NESTED_TASK_FIELDS) {
		const nested = asRecord(details[field]);
		if (nested && readStatus(nested)) return nested;
	}
	return details;
}

/**
 * Read a tool result as a background-task observation.
 *
 * `running` means the result left work in flight and the goal should wait for it
 * instead of continuing; `settled` means a tracked task finished. Returns null
 * when the result says nothing about detached work.
 */
export function observeBackgroundTask(event: TaskResultLike): BackgroundTaskObservation | null {
	if (event.isError) return null;
	const details = asRecord(event.details);
	if (!details) return null;
	const scope = taskScope(details);
	const status = readStatus(scope);
	if (!status) return null;
	const id = readId(scope);
	if (RUNNING_STATUSES.has(status)) {
		// An anonymous running status still parks the goal; it simply cannot
		// match a poll, which needs the id.
		return { kind: "running", task: { id, label: readLabel(scope, id, event.toolName), toolName: event.toolName } };
	}
	if (SETTLED_STATUSES.has(status)) return id ? { kind: "settled", taskId: id } : null;
	return null;
}

function sameId(value: unknown, id: string): boolean {
	return id.length > 0 && typeof value === "string" && value === id;
}

/** Tool names that act on a task rather than waiting for it (`TaskStop`, `steer_subagent`). */
const TASK_ACTION_TOOL = /stop|cancel|kill|terminate|abort|steer|interrupt|retry|resume|delete/i;

/** Argument values that act on a task rather than waiting for it. */
const TASK_ACTION_VALUES = new Set(["stop", "cancel", "kill", "terminate", "abort", "steer", "interrupt", "retry", "resume", "delete"]);

/**
 * Whether a call waits on an already-detected task again.
 *
 * The test is the task id, not the tool name, so any producer's polling tool is
 * covered: `pwsh { taskId }`, `TaskOutput { task_id }`, a subagent result getter
 * that takes `agent_id`, or a tool this extension has never seen. Only the
 * tracked task is affected, and a call that acts on the task (cancel, stop,
 * steer, retry) stays allowed. An unidentified task (`id === ""`) can never
 * match, so nothing is blocked for a producer that reports no id.
 */
export function isPendingTaskPoll(toolName: string, input: unknown, taskId: string): boolean {
	if (!taskId) return false;
	const args = asRecord(input);
	if (!args) return false;
	if (toolName === "pwsh") return sameId(args.taskId, taskId) && args.stop !== true;
	if (TASK_ACTION_TOOL.test(toolName)) return false;
	if (!ID_FIELDS.some((field) => sameId(args[field], taskId))) return false;
	if (args.stop === true || args.cancel === true) return false;
	const action = typeof args.action === "string" ? args.action.trim().toLowerCase() : "";
	return !TASK_ACTION_VALUES.has(action);
}
