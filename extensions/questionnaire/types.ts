import type { goalDialogControls } from "../goal-dialog-controls.ts";

/** Key matching and hint text for the dialogs, built per working directory. */
export type DialogControls = ReturnType<typeof goalDialogControls>;

export type GoalDraftingFocus = "goal" | "sisyphus";

export interface GoalQuestionnaireQuestion {
	id: string;
	question: string;
	context?: string;
	options: string[];
	recommended?: number;
	allowCustom?: boolean;
}

export interface GoalQuestionnaireAnswer {
	id: string;
	question: string;
	answer: string;
	wasCustom: boolean;
}

export interface GoalQuestionnaireResult {
	questions: GoalQuestionnaireQuestion[];
	answers: GoalQuestionnaireAnswer[];
	cancelled: boolean;
	auditorEnabled?: boolean;
	/**
	 * The host could not present the dialog at all, so `cancelled` reflects an
	 * absent UI rather than a decision the user made. Hosts that expose a
	 * non-terminal UI keep `ctx.hasUI` true while `ctx.ui.custom` stays the
	 * SDK's headless default, which resolves to `undefined`.
	 */
	unavailable?: boolean;
}

export type ProposalDecision = "confirm" | "continue" | "cancel";
