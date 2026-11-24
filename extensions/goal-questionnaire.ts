import { goalDialogControls } from "./goal-dialog-controls.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Editor, type EditorTheme } from "@earendil-works/pi-tui";
import { computeDialogLineLimit } from "./goal-dialog-fit.ts";
import { runQuestionnaireWithBasicDialogs } from "./questionnaire/basic-dialogs.ts";
import { createQuestionnaireKeys } from "./questionnaire/keys.ts";
import { createRenderLayout, renderQuestionnaire } from "./questionnaire/render.ts";
import { createQuestionnaireState, editorTextFor, enterQuestion, orderedAnswers } from "./questionnaire/state.ts";
import type {
	GoalDraftingFocus,
	GoalQuestionnaireQuestion,
	GoalQuestionnaireResult,
	ProposalDecision,
} from "./questionnaire/types.ts";

export type {
	GoalDraftingFocus,
	GoalQuestionnaireAnswer,
	GoalQuestionnaireQuestion,
	GoalQuestionnaireResult,
	ProposalDecision,
} from "./questionnaire/types.ts";

export function normalizeQuestionnaireQuestions(rawQuestions: GoalQuestionnaireQuestion[]): GoalQuestionnaireQuestion[] {
	const seenIds = new Set<string>();
	return rawQuestions.map((q, i) => {
		let id = q.id.trim() || `q${i + 1}`;
		if (seenIds.has(id)) id = `${id}-${i + 1}`;
		seenIds.add(id);
		const options = q.options.filter((option) => option.trim().length > 0);
		const recommended = q.recommended !== undefined && q.recommended >= 0 && q.recommended < options.length
			? q.recommended
			: undefined;
		return { ...q, id, options, recommended, allowCustom: q.allowCustom ?? true };
	});
}

export function formatQuestionnaireAnswers(result: GoalQuestionnaireResult): string {
	return result.answers.map((answer) => {
		const question = result.questions.find((q) => q.id === answer.id);
		const lines = [`**Q:** ${answer.question}`];
		if (question?.context) lines.push(`\n${question.context}`);
		if (question && question.options.length > 0) lines.push(`\nOptions: ${question.options.join(" / ")}`);
		lines.push(`\n**A:** ${answer.answer}`);
		return lines.join("");
	}).join("\n\n---\n\n");
}

export function shouldAutoConfirmProposal(args: { hasUI: boolean; autoConfirmEnv?: string }): boolean {
	if (args.autoConfirmEnv === "0") return false; // explicit opt-out (benchmarking)
	return !args.hasUI || args.autoConfirmEnv === "1";
}

export function proposalDecisionFromQuestionnaireResult(args: { cancelled: boolean; answer?: string }): ProposalDecision {
	if (args.cancelled) return "continue"; // never trapped; escape keeps refining
	if ((args.answer ?? "").startsWith("Confirm")) return "confirm";
	if ((args.answer ?? "").startsWith("Cancel")) return "cancel";
	return "continue";
}

export const DIALOG_UNAVAILABLE_HINT = "This host cannot display the required goal-drafting dialogs. Use a host with select/input support or the pi TUI, or explicitly restart with PI_GOAL_AUTO_CONFIRM=1 to confirm proposals without a dialog.";

export function proposalDialogFailureMessage(error: unknown): string {
	const detail = error instanceof Error ? error.message : String(error);
	return `Goal draft confirmation failed: ${detail}. The goal was NOT created; drafting remains active.`;
}

/**
 * Shared question UI used by both the agent-callable goal_questionnaire tool and
 * the internal draft-confirm prompt. This keeps pi-goal self-contained and
 * avoids depending on external question/questionnaire packages.
 */
export async function runGoalQuestionnaire(ctx: ExtensionContext, rawQuestions: GoalQuestionnaireQuestion[], auditorToggleInit?: { defaultEnabled: boolean }): Promise<GoalQuestionnaireResult> {
	if (!ctx.hasUI) {
		return { questions: [], answers: [], cancelled: true };
	}

	const questions = normalizeQuestionnaireQuestions(rawQuestions);
	// `mode` is not a capability signal: pi-web runs in "rpc" mode and still renders
	// TUI components (headless TUI + line capture + key forwarding), so the rich
	// single-dialog questionnaire works there. The host itself decides — the factory
	// below bails out with done(undefined) when the TUI it passes lacks the required
	// surface, and that path already falls back to one dialog per question (rpc mode
	// additionally degrades on a thrown error — see the `showRichDialog()` call below).
	if (typeof ctx.ui.custom !== "function") {
		return runQuestionnaireWithBasicDialogs(ctx, questions, auditorToggleInit);
	}

	const controls = goalDialogControls(typeof ctx.cwd === "string" ? ctx.cwd : process.cwd());
	const showRichDialog = async () => await ctx.ui.custom<GoalQuestionnaireResult | undefined>((tui, theme, _kb, done) => {
		// Some web hosts invoke the factory with a render callback in place of a TUI.
		if (!tui || typeof tui.getShowHardwareCursor !== "function" || typeof tui.setShowHardwareCursor !== "function" || typeof tui.requestRender !== "function") {
			done(undefined);
			return { render: () => [], invalidate: () => {} };
		}
		// Suppress hardware cursor during dialog to reduce TUI auto-scroll
		// (the TUI render loop runs at ~60fps and writes ANSI cursor positioning
		// sequences every cycle, which can cause terminal viewport snapping).
		const wasHardwareCursorShown = tui.getShowHardwareCursor();
		tui.setShowHardwareCursor(false);
		// Pause pi's working spinner for the dialog duration: its ~80ms
		// re-renders write output while the user is scrolled up reading the
		// proposal, which snaps the terminal viewport back to the bottom
		// ("terminal scrolls back down after X seconds"). Restored on close.
		ctx.ui.setWorkingVisible(false);
		// Terminal-height bound: the dialog renders in the editor slot, so the opened
		// frame height is (pre-dialog frame - 1) + dialog lines. Bound the dialog so
		// the frame never exceeds the terminal height — without this, closing a dialog
		// taller than the terminal triggers pi-tui's generic shrink full-render
		// (\x1b[2J\x1b[H\x1b[3J), erasing terminal scrollback and yanking the viewport
		// so the window takes ~10s to scroll back to the bottom. The slice keeps
		// the question and the actionable options/footer in view (see
		// fitDialogLines); content that fits renders exactly as the
		// pre-regression (383ae52) UI. Only applies with real TUI dimensions.
		const tuiInfo = tui as unknown as { terminal?: { rows?: number }; previousLines?: string[] };
		const maxDialogLines = computeDialogLineLimit({ terminalRows: tuiInfo.terminal?.rows, baseFrameLines: tuiInfo.previousLines?.length });

		const state = createQuestionnaireState(questions, auditorToggleInit);
		const layout = createRenderLayout();
		let cachedLines: string[] | undefined;
		// Focusable container state: the TUI sets `focused` when the dialog has
		// focus; we propagate it to the embedded Editor while in input mode so
		// the editor emits CURSOR_MARKER and the hardware cursor is positioned
		// for IME input (pi docs/tui.md — Focusable Interface).
		let dialogFocused = false;

		const editorTheme: EditorTheme = {
			borderColor: (s) => theme.fg("accent", s),
			selectList: {
				selectedPrefix: (t) => theme.fg("accent", t),
				selectedText: (t) => theme.fg("accent", t),
				description: (t) => theme.fg("muted", t),
				scrollInfo: (t) => theme.fg("dim", t),
				noMatch: (t) => theme.fg("warning", t),
			},
		};
		const editor = new Editor(tui, editorTheme);

		function refresh() {
			cachedLines = undefined;
			tui.requestRender();
		}

		function submit(cancelled: boolean) {
			// Restore hardware cursor now that the dialog is closing
			tui.setShowHardwareCursor(wasHardwareCursorShown);
			// Resume pi's working spinner (the agent run is still active until agent_end).
			ctx.ui.setWorkingVisible(true);
			done({ questions, answers: orderedAnswers(state), cancelled, auditorEnabled: auditorToggleInit ? state.auditorEnabled : undefined });
		}

		const keys = createQuestionnaireKeys({
			state,
			controls,
			maxDialogLines,
			submit,
			refresh,
			editor: {
				// Anchor the editor while the dialog has focus.
				open(text) {
					editor.setText(text);
					editor.focused = dialogFocused;
					tui.setShowHardwareCursor(dialogFocused);
				},
				// Release the cursor and clear the editor.
				close() {
					editor.focused = false;
					tui.setShowHardwareCursor(false);
					editor.setText("");
				},
				getText: () => editor.getText(),
				handleInput: (data) => editor.handleInput(data),
			},
		});
		editor.onSubmit = keys.submitEditor;

		if (enterQuestion(state, questions[0]!)) {
			editor.setText(editorTextFor(state, questions[0]!.id));
			editor.focused = dialogFocused;
			tui.setShowHardwareCursor(dialogFocused);
		}

		function render(width: number): string[] {
			if (cachedLines) return cachedLines;
			cachedLines = renderQuestionnaire({ state, layout, theme, controls, editor, width, maxDialogLines });
			return cachedLines;
		}

		return {
			render,
			invalidate: () => { cachedLines = undefined; },
			handleInput: keys.handleInput,
			// Focusable (pi docs/tui.md): propagate focus to the embedded Editor
			// so it emits CURSOR_MARKER and the hardware cursor is positioned
			// correctly for IME input while the answer editor is active.
			get focused(): boolean { return dialogFocused; },
			set focused(v: boolean) {
				dialogFocused = v;
				editor.focused = v && state.inputMode;
				tui.setShowHardwareCursor(v && state.inputMode);
			},
		};
	});
	// RPC hosts historically never reached this path (the mode check sent them
	// straight to the per-question dialogs), so keep their safety net: a host that
	// advertises `custom` yet throws while building or rendering the component
	// degrades to per-question dialogs instead of failing the whole draft. Non-rpc
	// hosts keep upstream semantics — their errors surface to the caller.
	const result = ctx.mode === "rpc"
		? await showRichDialog().catch((error) => {
			// Degrading silently would look like the per-question dialogs came back for no
			// reason (and any already-answered questions are re-asked): say why first.
			ctx.ui.notify(
				`Goal dialog could not be rendered by this host (${error instanceof Error ? error.message : String(error)}); falling back to one dialog per question.`,
				"warning",
			);
			return undefined;
		})
		: await showRichDialog();
	if (result !== undefined) return result;
	return runQuestionnaireWithBasicDialogs(ctx, questions, auditorToggleInit);
}

/**
 * Confirm a proposed draft through the shared questionnaire UI. Escape / cancel
 * maps to "continue" so the user is never trapped.
 */
export async function showProposalDialog(
	ctx: ExtensionContext,
	confirmationText: string,
	focus: GoalDraftingFocus,
	defaultAuditorEnabled?: boolean,
): Promise<{ decision: ProposalDecision; auditorEnabled: boolean; unavailable: boolean }> {
	const headerTitle = focus === "sisyphus" ? "Confirm Sisyphus Goal Draft" : "Confirm Goal Draft";
	const result = await runGoalQuestionnaire(ctx, [{
		id: "confirm",
		question: headerTitle,
		context: confirmationText,
		options: ["Confirm — create this goal now", "Continue chatting — keep refining", "Cancel — discard this draft"],
		recommended: 0,
		allowCustom: false,
	}], defaultAuditorEnabled !== undefined ? { defaultEnabled: defaultAuditorEnabled } : undefined);
	const decision = proposalDecisionFromQuestionnaireResult({
		cancelled: result.cancelled,
		answer: result.answers[0]?.answer,
	});
	return { decision, auditorEnabled: result.auditorEnabled ?? true, unavailable: result.unavailable === true };
}
