import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { GoalQuestionnaireAnswer, GoalQuestionnaireQuestion, GoalQuestionnaireResult } from "./types.ts";

const CUSTOM_ANSWER_LABEL = "Write your own answer...";

/** Sequential native dialogs for hosts that cannot render terminal components. */
export async function runQuestionnaireWithBasicDialogs(
	ctx: ExtensionContext,
	questions: GoalQuestionnaireQuestion[],
	auditorToggleInit?: { defaultEnabled: boolean },
): Promise<GoalQuestionnaireResult> {
	const unavailable = (): GoalQuestionnaireResult => ({ questions: [], answers: [], cancelled: true, unavailable: true, ...(auditorToggleInit ? { auditorEnabled: auditorToggleInit.defaultEnabled } : {}) });
	// Require only the primitives this questionnaire can actually use.
	if ((auditorToggleInit || questions.some(q => q.options.length > 0)) && typeof ctx.ui.select !== "function") return unavailable();
	if (questions.some(q => q.options.length === 0 || q.allowCustom !== false) && typeof ctx.ui.input !== "function") return unavailable();
	let auditorEnabled = auditorToggleInit?.defaultEnabled;
	const cancelled = (): GoalQuestionnaireResult => ({ questions, answers: [], cancelled: true, auditorEnabled });
	if (auditorToggleInit) {
		const enabled = "Enabled — require independent approval";
		const disabled = "Disabled — skip the completion audit";
		const choices = auditorEnabled ? [enabled, disabled] : [disabled, enabled];
		const picked = await ctx.ui.select(`Completion auditor (currently ${auditorEnabled ? "enabled" : "disabled"})`, choices);
		if (picked === undefined) return cancelled();
		if (!choices.includes(picked)) throw new Error("The host returned an unknown auditor choice");
		auditorEnabled = picked === enabled;
	}
	const answers: GoalQuestionnaireAnswer[] = [];
	for (const question of questions) {
		let prompt = question.context ? `${question.question}\n\n${question.context}` : question.question;
		if (auditorToggleInit) prompt += `\n\nAuditor for this goal: ${auditorEnabled ? "enabled (independent approval required)" : "disabled (completion skips the audit)"}.`;
		let answer: string | undefined;
		let wasCustom = question.options.length === 0;
		if (!wasCustom) {
			// Numbered labels keep duplicate/reserved option text unambiguous.
			const labels = question.options.map((option, i) => `${i + 1}. ${option}${question.recommended === i ? " (Recommended)" : ""}`);
			const customLabel = `${labels.length + 1}. ${CUSTOM_ANSWER_LABEL}`;
			const options = question.allowCustom === false ? labels : [...labels, customLabel];
			const picked = await ctx.ui.select(prompt, options);
			if (picked === undefined) return cancelled();
			if (!options.includes(picked)) throw new Error("The host returned an unknown questionnaire choice");
			wasCustom = picked === customLabel && question.allowCustom !== false;
			if (!wasCustom) answer = question.options[labels.indexOf(picked)];
		}
		if (wasCustom) {
			// Match the terminal editor: whitespace alone is not a submitted answer.
			do {
				answer = (await ctx.ui.input(prompt, "Write your answer"))?.trim();
			} while (answer === "");
		}
		if (answer === undefined) return cancelled();
		answers.push({ id: question.id, question: question.question, answer, wasCustom });
	}
	return { questions, answers, cancelled: false, auditorEnabled };
}
