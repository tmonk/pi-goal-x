/**
 * The goal file text format: a JSON metadata object followed by a human
 * readable markdown body. Pure string work, so the sync and async readers
 * share it and it needs no disk access to test.
 */
import { formatDuration, formatTokenValue, statusLabel } from "../goal-display.ts";
import { normalizeGoalRecord, type GoalRecord, type TaskStatus } from "../goal-record.ts";

function taskCheckbox(status: TaskStatus): string {
	if (status === "complete") return "x";
	if (status === "skipped") return "~";
	return " ";
}

function taskLineSuffix(task: { status: TaskStatus; evidence?: string; skipReason?: string; verificationContract?: string }): string {
	const parts: string[] = [];
	if (task.status === "complete" && task.evidence) parts.push(`evidence: ${task.evidence}`);
	if (task.status === "skipped" && task.skipReason) parts.push(`skipped: ${task.skipReason}`);
	if (task.status === "pending" && task.verificationContract) parts.push(`contract: ${task.verificationContract}`);
	return parts.length > 0 ? ` — ${parts.join("; ")}` : "";
}

export function serializeGoalFile(goal: GoalRecord): string {
	const meta = JSON.stringify({ version: 3, ...goal }, null, 2);
	const pauseLines: string[] = [];
	if (goal.pauseReason) pauseLines.push(`- Agent pause reason: ${goal.pauseReason}`);
	if (goal.pauseSuggestedAction) pauseLines.push(`- Agent suggests: ${goal.pauseSuggestedAction}`);
	const pauseBlock = pauseLines.length > 0 ? `\n${pauseLines.join("\n")}` : "";
	let taskSection = "";
	if (goal.taskList) {
		const taskLines = goal.taskList.tasks.map((t) => {
			return `- [${taskCheckbox(t.status)}] ${t.id}: ${t.title}${taskLineSuffix(t)}`;
		});
		taskSection = `\n## Tasks

<!-- blockCompletion: ${goal.taskList.blockCompletion} -->\n${taskLines.join("\n")}\n`;
	}
	const contractLine = goal.verificationContract?.trim() ? `
- Verification contract: ${goal.verificationContract.trim()}` : "";
	return `${meta}

# Goal Prompt

${goal.objective.trim()}

## Progress

- Status: ${statusLabel(goal)}
- Auto-continue: ${goal.autoContinue ? "on" : "off"}
- Sisyphus mode: ${goal.sisyphus ? "yes (prompt/criteria style)" : "no"}
- Time spent: ${formatDuration(goal.usage.activeSeconds)}
- Tokens used: ${formatTokenValue(goal.usage.tokensUsed)}${contractLine}${taskSection}${pauseBlock}
`;
}

/** Index of the brace that closes the leading JSON object, or -1. */
function findJsonObjectEnd(content: string): number {
	let depth = 0;
	let inString = false;
	let escaped = false;

	for (let i = 0; i < content.length; i++) {
		const char = content[i];
		if (inString) {
			if (escaped) {
				escaped = false;
			} else if (char === "\\") {
				escaped = true;
			} else if (char === "\"") {
				inString = false;
			}
			continue;
		}
		if (char === "\"") {
			inString = true;
			continue;
		}
		if (char === "{") {
			depth++;
			continue;
		}
		if (char === "}") {
			depth--;
			if (depth === 0) return i;
		}
	}
	return -1;
}

/** The objective text under "# Goal Prompt", which users may edit by hand. */
function extractObjectiveFromBody(body: string): string | undefined {
	const lines = body.replace(/^\s+/, "").split(/\r?\n/);
	const start = lines.findIndex((line) => line.trim() === "# Goal Prompt");
	if (start < 0) return body.trim() || undefined;
	let end = lines.length;
	for (let i = start + 1; i < lines.length; i++) {
		if (lines[i]?.trim() === "## Progress") {
			end = i;
			break;
		}
	}
	return lines.slice(start + 1, end).join("\n").trim() || undefined;
}

/**
 * Parse goal-file text into a record. Returns undefined when the text has no
 * readable JSON header (malformed), and null when the header is readable but
 * holds no usable goal (for example an empty objective).
 */
export function parseGoalFileContent(content: string): GoalRecord | null | undefined {
	const end = findJsonObjectEnd(content);
	if (end < 0) return undefined;
	let raw: Record<string, unknown>;
	try {
		raw = JSON.parse(content.slice(0, end + 1)) as Record<string, unknown>;
	} catch {
		return undefined;
	}
	const objective = extractObjectiveFromBody(content.slice(end + 1)) ?? raw.objective;
	return normalizeGoalRecord({ ...raw, objective });
}
