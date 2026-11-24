import { createHash } from "node:crypto";
import { taskIndex } from "./goal-task-index.ts";
import type { GoalRecord } from "./goal-record.ts";
import type { GoalLedgerEvent } from "./goal-ledger.ts";

export const GOAL_DETAIL_PAGE_CHARS = 4000;
export type GoalDetailSection = "objective" | "tasks" | "history";
export interface GoalDetailQuery { section: GoalDetailSection; task_id?: string; cursor?: string }
export type GoalDetailPage = {ok: true; text: string; content: string; nextCursor?: string; totalChars: number} | {ok: false; text: string};

interface DetailSource { source: string; key: string }
const detailCache: Array<{inputs: readonly unknown[]; result: DetailSource}> = [];
let detailCacheChars = 0;

function compiledSource(goal: GoalRecord, query: GoalDetailQuery, events: readonly GoalLedgerEvent[], revision?: object): DetailSource | undefined {
	const index = query.section === "tasks" ? taskIndex(goal.taskList?.tasks) : undefined;
	const inputs = [goal.id, query.section, query.task_id, ...(query.section === "objective" ? [goal.objective, goal.verificationContract]
		: query.section === "tasks" ? [index, goal.currentTaskId] : [revision])];
	// Arbitrary caller-owned histories remain content checked; only the ledger can supply a generation.
	const cacheable = query.section !== "history" || revision !== undefined;
	if (cacheable) for (let i = detailCache.length - 1; i >= 0; i--) {
		const entry = detailCache[i]!;
		if (inputs.length === entry.inputs.length && inputs.every((value, j) => value === entry.inputs[j])) return entry.result;
	}
	let source: string;
	if (query.section === "objective") source = `${goal.objective}${goal.verificationContract ? `\n\nVerification contract:\n${goal.verificationContract}` : ""}`;
		else if (query.section === "history") source = events.filter(e => "goalId" in e && e.goalId === goal.id).map(e => JSON.stringify(e)).join("\n");
		else {
		const rows = index!.ordered;
		const selected = query.task_id ? rows.find(row => row.task.id === query.task_id) : undefined;
		if (query.task_id && !selected) return undefined;
		source = (selected ? [selected] : rows).map(({task: {subtasks, ...task}, parentId}) => JSON.stringify({...task, parent_id: parentId, ...(task.id === goal.currentTaskId ? {current: true} : {})})).join("\n");
	}
	const key = createHash("sha256").update(JSON.stringify([goal.id, query.section, query.task_id, source])).digest("hex");
	const result = {source, key};
	// Full data remains available even when it exceeds the bounded shared page cache.
	if (cacheable && source.length <= 16_000_000) {
		while (detailCache.length >= 16 || detailCacheChars + source.length > 16_000_000) detailCacheChars -= detailCache.shift()!.result.source.length;
		detailCache.push({inputs, result}); detailCacheChars += source.length;
	}
	return result;
}

/** Stable, lossless detail text. Ledger revisions are opaque generations, never timestamps. */
export function goalDetailPage(goal: GoalRecord, query: GoalDetailQuery, events: readonly GoalLedgerEvent[] = [], historyRevision?: object): GoalDetailPage {
	if (query.task_id !== undefined && query.section !== "tasks") return {ok: false, text: "task_id requires section=tasks."};
	const compiled = compiledSource(goal, query, events, historyRevision);
	if (!compiled) return {ok: false, text: `Task "${query.task_id}" not found.`};
	const {source, key} = compiled;
	let offset = 0;
	if (query.cursor) {
		try {
			if (query.cursor.length > 256) throw new Error();
			const parsed = JSON.parse(Buffer.from(query.cursor, "base64url").toString("utf8"));
			if (parsed.v !== 1 || parsed.key !== key || !Number.isSafeInteger(parsed.offset) || parsed.offset < 0 || parsed.offset > source.length) throw new Error();
			offset = parsed.offset;
		} catch { return {ok: false, text: "Invalid or stale cursor: goal details changed or the section/task differs. Restart this section without cursor."}; }
	}
	let end = Math.min(offset + GOAL_DETAIL_PAGE_CHARS, source.length);
	if (end < source.length && /[\uD800-\uDBFF]/.test(source[end - 1]!)) end--;
	const content = source.slice(offset, end);
	const nextCursor = end < source.length ? Buffer.from(JSON.stringify({v: 1, key, offset: end})).toString("base64url") : undefined;
	const text = `${query.section} for ${goal.id} (${offset}–${end}/${source.length} chars)\n${content}${nextCursor ? `\nMore content: repeat this section/task with cursor="${nextCursor}".` : "\nEnd of section."}`;
	return {ok: true, text, content, nextCursor, totalChars: source.length};
}
