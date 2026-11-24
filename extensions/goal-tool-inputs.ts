import type {GoalContinuation} from "./goal-scheduler-state.ts";

export interface TaskProgressInput {
	task_id: string;
	status: "start" | "complete" | "skipped" | "pending";
	evidence?: string;
	reason?: string;
}

type Result = {ok: true; updates: TaskProgressInput[]; batch: boolean} | {ok: false; message: string};
const fields = ["task_id", "status", "evidence", "reason"] as const;
const statuses = new Set(["start", "complete", "skipped", "pending"]);
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

/** Remove a blank top-level status so an otherwise valid batch call passes validation. */
export function dropBlankStatus(args: unknown): unknown {
	if (!object(args)) return args;
	const { status, ...rest } = args;
	return typeof status === "string" && !status.trim() ? rest : args;
}

/** Remove one top-level argument, if present. */
export function dropKey(args: unknown, key: string): unknown {
	if (!object(args) || !(key in args)) return args;
	const { [key]: _dropped, ...rest } = args;
	return rest;
}

/** Normalize transport noise without discarding a meaningful task instruction. */
export function normalizeTaskProgress(input: unknown): Result {
	const fail = (message: string): Result => ({ok: false, message});
	if (!object(input)) return fail("Provide task_id and status, or an updates batch.");
	const normalize = (raw: Record<string, unknown>): Partial<TaskProgressInput> | undefined => {
		const result: Record<string, string> = {};
		for (const field of fields) {
			const value = raw[field];
			if (value === undefined) continue;
			if (typeof value !== "string") return;
			if (value.trim()) result[field] = value.trim();
		}
		if (result.status && !statuses.has(result.status)) return;
		return result as Partial<TaskProgressInput>;
	};
	const complete = (value: Partial<TaskProgressInput>): value is TaskProgressInput => !!value.task_id && !!value.status;
	const root = normalize(input);
	if (!root) return fail("Task fields must be strings; status must be start, complete, skipped, or pending.");
	if (input.updates === undefined || (Array.isArray(input.updates) && input.updates.length === 0)) {
		return complete(root) ? {ok: true, updates: [root], batch: false}
			: fail("Provide task_id and status, or a non-empty updates batch.");
	}
	if (!Array.isArray(input.updates) || input.updates.length > 100) return fail("updates must contain 1–100 valid task updates.");
	const updates: TaskProgressInput[] = [];
	for (const entry of input.updates) {
		if (!object(entry) || Object.keys(entry).some(key => !fields.includes(key as typeof fields[number]))) return fail("updates must contain 1–100 valid task updates.");
		const normalized = normalize(entry);
		if (!normalized || !complete(normalized)) return fail("updates must contain 1–100 valid task updates.");
		updates.push(normalized);
	}
	if (!updates.some(entry => fields.every(field => root[field] === undefined || root[field] === entry[field]))) {
		return fail("Top-level task fields conflict with updates. Put each instruction in updates and omit the top-level task fields.");
	}
	return {ok: true, updates, batch: true};
}

type GoalUpdatePlan =
	| {action: "complete"; completionSummary?: string}
	| {action: "blocked"; reason: string; attemptedActions: string[]}
	| {action: "paused"; reason: string; suggestedAction?: string}
	| {action: "continuation"; continuation: GoalContinuation};

/** Classify once before the caller flushes or changes any state. */
export function planUpdateGoal(input: unknown): {ok: true; plan: GoalUpdatePlan} | {ok: false; message: string} {
	const fail = (message: string) => ({ok: false as const, message});
	const keys = ["status", "continuation", "reason", "attempted_actions", "suggested_action", "completion_summary"];
	if (!object(input) || Object.keys(input).some(key => !keys.includes(key))) return fail("Provide a lifecycle status or continuation using the declared fields.");
	const strings: Record<string, string> = {};
	for (const key of ["status", "reason", "suggested_action", "completion_summary"]) {
		const value = input[key];
		if (value === undefined) continue;
		if (typeof value !== "string") return fail(`${key} must be a string.`);
		if (value.trim()) strings[key] = value;
	}
	const status = strings.status;
	if (status && !["complete", "blocked", "paused"].includes(status)) return fail("status must be complete, blocked, or paused.");
	const rawActions = input.attempted_actions;
	if (rawActions !== undefined && (!Array.isArray(rawActions) || rawActions.length > 8 || rawActions.some(a => typeof a !== "string" || a.length > 240))) return fail("attempted_actions must contain at most eight strings of at most 240 characters.");
	const attemptedActions: string[] = (rawActions ?? []).filter((action: string) => action.trim());
	let continuation: GoalContinuation | undefined;
	if (input.continuation !== undefined) {
		const raw = input.continuation;
		if (!object(raw)) return fail("continuation must be a ready or wait object.");
		if (raw.kind === "ready" && Object.keys(raw).length === 1) {
			if (!status) continuation = {kind: "ready"};
		} else if (raw.kind === "wait" && Object.keys(raw).every(key => ["kind", "reason", "deadline", "wait_id", "polling"].includes(key))) {
			if (typeof raw.reason !== "string" || !raw.reason.trim() || raw.reason.length > 2000 || typeof raw.deadline !== "string" || (raw.wait_id !== undefined && typeof raw.wait_id !== "string")) return fail("continuation.wait requires reason and deadline strings; wait_id must be a string.");
			let polling: {interval_seconds: number; max_checks: number} | undefined;
			if (raw.polling !== undefined) {
				const p = raw.polling;
				if (!object(p) || Object.keys(p).some(key => !["interval_seconds", "max_checks"].includes(key)) || typeof p.interval_seconds !== "number" || !Number.isSafeInteger(p.interval_seconds) || p.interval_seconds < 1 || p.interval_seconds > 2147483 || typeof p.max_checks !== "number" || !Number.isSafeInteger(p.max_checks) || p.max_checks < 1) return fail("continuation.polling requires positive whole interval_seconds and max_checks.");
				polling = {interval_seconds: p.interval_seconds, max_checks: p.max_checks};
			}
			continuation = {kind: "wait", reason: raw.reason, deadline: raw.deadline, ...(raw.wait_id === undefined ? {} : {wait_id: raw.wait_id}), ...(polling ? {polling} : {})};
		} else return fail("continuation must be payload-free ready or a valid wait; unexpected continuation fields are not filler.");
	}
	if (status && continuation) return fail("status conflicts with continuation.wait. Choose one action; a payload-free ready may accompany status as filler.");
	if (!status && !continuation) return fail("Provide one lifecycle status or continuation.");
	const allowed = status === "complete" ? ["completion_summary"] : status === "blocked" ? ["reason", "attempted_actions"] : status === "paused" ? ["reason", "suggested_action"] : [];
	const supplied = [...Object.keys(strings).filter(key => key !== "status"), ...(attemptedActions.length ? ["attempted_actions"] : [])];
	const conflicts = supplied.filter(key => !allowed.includes(key));
	if (conflicts.length) return fail(`${status ? `status=${status}` : "continuation"} conflicts with ${conflicts.join(", ")}. Use only the fields for that action; empty strings and arrays may remain filler.`);
	if ((status === "blocked" || status === "paused") && !strings.reason) return fail(`update_goal({ status: "${status}" }) requires a "reason" describing why work cannot continue.`);
	if (continuation) return {ok: true, plan: {action: "continuation", continuation}};
	if (status === "blocked") return {ok: true, plan: {action: "blocked", reason: strings.reason!, attemptedActions}};
	if (status === "paused") return {ok: true, plan: {action: "paused", reason: strings.reason!, suggestedAction: strings.suggested_action}};
	return {ok: true, plan: {action: "complete", completionSummary: strings.completion_summary}};
}
