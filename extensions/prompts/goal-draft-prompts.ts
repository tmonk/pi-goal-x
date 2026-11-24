import { commandInstructions, type GoalCommands } from "../goal-controls.ts";
import type { GoalTask, GoalTaskList } from "../goal-record.ts";
import { promptSafeObjective } from "../goal-contract.ts";
import { renderConfirmationTasks } from "../goal-task-confirmation.ts";

export type GoalDraftingFocus = "goal" | "sisyphus";

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

export function buildTweakConfirmationText(args: {
	currentObjective: string;
	newObjective: string;
	changeSummary: string;
	sisyphus: boolean;
	tasks?: GoalTask[];
}): string {
	const lines: string[] = [];
	lines.push("● Goal tweak ready for confirmation.");
	lines.push("");
	lines.push("─── Draft Details ───");
	lines.push(`│   Mode: ${formatModeLabel(args.sisyphus)}`);
	lines.push(...formatSection("Change", args.changeSummary));
	lines.push(...formatSection("Current Objective", args.currentObjective));
	lines.push(...formatSection("Proposed New Objective", args.newObjective));
	if (args.tasks && args.tasks.length > 0) {
		const taskLines = renderConfirmationTasks(args.tasks, 0);
		lines.push("");
		lines.push(`┌─ TASKS ─────────────────────────────────────┐`);
		for (const tl of taskLines) lines.push(tl);
		lines.push(`└──────────────────────────────────────────────┘`);
	}
	return lines.join("\n");
}

export function goalDraftingPrompt(topic: string, focus: GoalDraftingFocus, commands?: GoalCommands): string {
	const safeTopic = promptSafeObjective(topic.trim() || "(no topic provided — ask the user what they want to accomplish)");
	const header = focus === "sisyphus"
		? "[GOAL CONFIRMATION focus=sisyphus]\nThe user invoked Sisyphus intent discussion (/sisyphus). Help turn their request into a confirmed goal contract. Do NOT start substantive work yet."
		: "[GOAL CONFIRMATION focus=goal]\nThe user invoked guided goal drafting (/goal). Help turn their request into a confirmed goal contract. Do NOT start substantive work yet.";

	const commonProtocol = [
		"How to draft:",
		"- Keep this a short conversation. Do not start the work until the user confirms.",
		"- If the request is vague, ask a focused question with a suggested answer. goal_questionnaire shows questions in a dialog; plain chat is fine too.",
		"- Read-only research is fine if it helps define the goal.",
		"- Make the objective, success criteria, boundaries, constraints and blocker rule clear. Keep asking until they are. If the request already covers them, propose right away.",
		"- If the work splits into milestones you can track, you MUST pass them in the tasks argument of propose_goal_draft, so the user confirms the goal and tasks together. Simple goals need no tasks. Once the goal exists, set_goal_tasks changes the task list.",
		"- Set token_budget only if the user asked for a budget or spend limit. Never estimate one.",
		"- propose_goal_draft opens a dialog that shows the full proposal, so do not repeat it in chat first. Confirm creates and focuses the goal; Continue Chatting keeps the draft open.",
		"- create_goal and the other goal tools are blocked during a draft. Use propose_goal_draft.",
	];

	const goalFocusItems = [
		"For /goal, propose a normal goal in this shape when ready:",
		"=== Goal ===",
		"Objective: <one-sentence outcome>",
		"Success criteria: <observable evidence the goal is done>",
		"Boundaries: <in scope / out of scope>",
		"Constraints: <hard rules>",
		"Verification contract: <optional — what verification evidence is required before marking complete, e.g. 'Run npm test (0 failures), grep for remaining references, re-read requirements and confirm every item is addressed'>",
		"If blocked: <default = stop and ask the user>",
		"Put this whole block, headings included, in the objective argument of propose_goal_draft. The headings are not separate arguments.",
	];

	const sisyphusFocusItems = [
		"For /sisyphus, remember that Sisyphus is a prompt/criteria style, not a separate step-counter mechanism.",
		"Propose a Sisyphus goal in this shape when ready:",
		"=== Sisyphus Goal ===",
		"Objective: <one-sentence outcome>",
		"Success criteria: <observable evidence the whole ordered goal is done>",
		"Boundaries: <in scope / out of scope>",
		"Constraints: <hard rules, files not to touch, etc.>",
		"Verification contract: <optional — what verification evidence is required before marking complete>",
		"Ordered steps: <preserve the user's requested steps and ordering; do not add preflight or reconnaissance steps they did not ask for>",
		"If blocked / unclear / failing: <default = stop and ask the user>",
		"Sisyphus reminder: Work patiently and sequentially. No rushing, no unrequested preflight steps, no improvising around blockers.",
		"Put this whole block, headings included, in the objective argument of propose_goal_draft. The headings are not separate arguments.",
	];

	return [
		commandInstructions(header, commands),
		"",
		"Topic the user provided:",
		"<goal_topic>",
		safeTopic,
		"</goal_topic>",
		"",
		...commonProtocol,
		"",
		...(focus === "sisyphus" ? sisyphusFocusItems : goalFocusItems).map(line => commandInstructions(line, commands)),
	].join("\n");
}


// ── §14 durable proposal summary ─────────────────────────────────────────────

export interface ProposalSummaryArgs {
	objective: string;
	taskList?: GoalTaskList;
	verificationContract?: string;
	autoContinue: boolean;
	auditorEnabled: boolean;
}

/**
 * Durable proposal summary written to the terminal transcript (plan §14):
 * proposed objective, proposed plan (numbered top-level tasks), verification,
 * automatic-continuation state, and auditor state. Produced for every proposal
 * outcome (confirm / continue refining / cancel) so the summary is always part
 * of the conversation, not only the confirmation dialog.
 */
export function buildProposalSummary(args: ProposalSummaryArgs): string {
	const lines: string[] = ["Proposed objective:", args.objective.trim()];
	if (args.taskList && args.taskList.tasks.length > 0) {
		lines.push("", "Proposed plan:");
		lines.push(...renderProposalPlan(args.taskList.tasks));
	}
	if (args.verificationContract?.trim()) {
		lines.push("", "Verification:", args.verificationContract.trim());
	}
	lines.push("", `Automatic continuation: ${args.autoContinue ? "enabled" : "disabled"}`);
	lines.push(`Independent auditor: ${args.auditorEnabled ? "enabled" : "disabled"}`);
	return lines.join("\n");
}

function renderProposalPlan(tasks: GoalTask[]): string[] {
	const lines: string[] = [];
	let index = 1;
	for (const t of tasks) {
		lines.push(`${index}. ${t.title}`);
		if (t.subtasks && t.subtasks.length > 0) {
			for (const child of t.subtasks) {
				lines.push(`   - ${child.title}`);
			}
		}
		index++;
	}
	return lines;
}
