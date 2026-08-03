import type { GoalTask } from "./goal-record.ts";

export type GoalDraftingFocus = "goal" | "sisyphus";

export interface GoalConfirmationIntentLike {
	focus: GoalDraftingFocus;
	originalTopic: string;
	startedAt?: number;
}

export interface DraftProposalInput {
	intent: GoalConfirmationIntentLike | null;
	hasUnfinishedGoal: boolean;
	objective: string;
	sisyphus?: boolean;
	draftId?: string;
}

export type DraftProposalValidation =
	| { ok: true; objective: string; expectedSisyphus: boolean }
	| { ok: false; message: string; clearDrafting?: boolean };

export type ToolGateDecision =
	| { block: false }
	| { block: true; reason: string };

// ── Shared formatting helpers ──────────────────────────────────────────────

function formatModeLabel(sisyphus: boolean): string {
	return sisyphus ? "Sisyphus (prompt/criteria style)" : "Normal goal";
}

function formatPrefixedLines(content: string): string[] {
	const lines: string[] = [];
	for (const rawLine of content.split("\n")) {
		const trimmed = rawLine.trim();
		if (!trimmed) continue;
		if (trimmed.startsWith("│")) {
			lines.push(rawLine);
		} else {
			lines.push(`│   ${rawLine}`);
		}
	}
	return lines;
}

function formatSection(title: string, content: string): string[] {
	const body = formatPrefixedLines(content);
	return ["", `─── ${title} ───`, "", ...body];
}

export function renderConfirmationTasks(tasks: GoalTask[], indent: number): string[] {
	const prefix = "  ".repeat(indent);
	const lines: string[] = [];
	for (const t of tasks) {
		const lw = t.lightweightSubtasks ? " (lightweight)" : "";
		const contract = t.verificationContract ? ` contract: ${t.verificationContract}` : "";
		lines.push(`${prefix}[ ] ${t.id}: ${t.title}${lw}${contract}`);
		if (t.subtasks && t.subtasks.length > 0) {
			lines.push(...renderConfirmationTasks(t.subtasks, indent + 1));
		}
	}
	return lines;
}

export function promptSafeObjective(objective: string): string {
	return objective.replace(/<\/?untrusted_objective>/gi, (tag) => tag.replace(/</g, "&lt;").replace(/>/g, "&gt;"));
}

const VERIFICATION_CONTRACT_RE = /^Verification contract:\s*(.+)$/im;

const CONVENTIONAL_SECTION_NAMES = [
	"success criteria",
	"boundaries",
	"constraints",
	"if blocked",
	"if blocked / unclear / failing",
	"don'ts",
	"sisyphus reminder",
	"objective",
	"目标",
	"ordered steps",
	"order rules",
	"steps",
];

/**
 * Extract a `Verification contract:` section from a goal objective and return
 * the cleaned objective (without the contract section) and the contract text.
 *
 * The contract section is a single line matching:
 *   Verification contract: <text>
 *
 * It can appear anywhere in the objective, but by convention it goes after
 * the other sections (like Success criteria, Boundaries, Constraints).
 *
 * If no contract section is found, `verificationContract` is undefined.
 */
export function extractVerificationContract(objective: string): { objective: string; verificationContract?: string } {
	const lines = objective.replace(/\r/g, "").split("\n");
	let contract: string | undefined;
	const filtered: string[] = [];

	for (const line of lines) {
		const trimmed = line.trim();
		const m = VERIFICATION_CONTRACT_RE.exec(trimmed);
		if (m) {
			contract = m[1].trim();
			// Skip this line — don't add it to the cleaned objective
		} else {
			filtered.push(line);
		}
	}

	return {
		objective: filtered.join("\n"),
		verificationContract: contract || undefined,
	};
}

export function buildDraftConfirmationText(args: {
	focus: GoalDraftingFocus;
	originalTopic: string;
	objective: string;
	autoContinue: boolean;
}): string {
	const lines: string[] = [];
	lines.push("● Goal draft ready for confirmation.");
	lines.push("");
	lines.push("─── Draft Details ───");
	lines.push(`│   Mode: ${formatModeLabel(args.focus === "sisyphus")}`);
	lines.push(`│   Auto-continue: ${args.autoContinue ? "yes" : "no"}`);
	lines.push(...formatSection("Original Topic", args.originalTopic.trim()));
	lines.push(...formatSection("Proposed Goal", args.objective));
	return lines.join("\n");
}
