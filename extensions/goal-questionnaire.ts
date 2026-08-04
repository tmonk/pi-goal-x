import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Editor, type EditorTheme, Key, matchesKey, Text, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";


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
}

export type ProposalDecision = "confirm" | "continue" | "cancel";

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

export function isHeadlessQuestionSufficientForDraft(args: { topic: string; questionText: string }): boolean {
	const topic = args.topic.toLowerCase();
	void args;
	const vagueTopic = topic.trim().length < 20 || /(整理笔记|organize notes|notes|笔记)$/.test(topic.trim());
	return !vagueTopic;
}

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
	const isMulti = questions.length > 1;
	const totalTabs = questions.length + 1;

	return await ctx.ui.custom<GoalQuestionnaireResult>((tui, theme, _kb, done) => {
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
		// so the window takes ~10s to scroll back to the bottom. The tail slice keeps
		// the actionable options/footer in view; content that fits renders exactly as
		// the pre-regression (383ae52) UI. Only applies with real TUI dimensions.
		const tuiInfo = tui as unknown as { terminal?: { rows?: number }; previousLines?: string[] };
		const terminalRows = tuiInfo.terminal?.rows;
		const baseFrame = tuiInfo.previousLines?.length;
		const maxDialogLines = terminalRows && baseFrame ? Math.max(10, terminalRows - baseFrame + 1) : undefined;
		let currentTab = 0;
		let optionIndex = 0;
		let inputMode = false;
		let inputQuestionId: string | null = null;
		let cachedLines: string[] | undefined;
		let auditorEnabled = auditorToggleInit?.defaultEnabled ?? true;
		const answers = new Map<string, GoalQuestionnaireAnswer>();
		const drafts = new Map<string, string>();

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
			const ordered = questions.map((q) => answers.get(q.id)).filter((a): a is GoalQuestionnaireAnswer => !!a);
			done({ questions, answers: ordered, cancelled, auditorEnabled: auditorToggleInit ? auditorEnabled : undefined });
		}

		function currentQuestion(): GoalQuestionnaireQuestion | undefined {
			return questions[currentTab];
		}

		function displayOptions(): Array<{ label: string; isCustom?: boolean }> {
			const q = currentQuestion();
			if (!q) return [];
			const opts: Array<{ label: string; isCustom?: boolean }> = q.options.map((label) => ({ label }));
			if (q.allowCustom !== false) opts.push({ label: "Write your own answer...", isCustom: true });
			return opts;
		}

		function allAnswered(): boolean {
			return questions.every((q) => answers.has(q.id));
		}

		function enterQuestion(q: GoalQuestionnaireQuestion) {
			const existing = answers.get(q.id);
			const draft = drafts.get(q.id);
			if (q.options.length === 0) {
				inputMode = true;
				inputQuestionId = q.id;
				editor.setText(draft ?? (existing?.wasCustom ? existing.answer : ""));
			} else if (existing?.wasCustom) {
				optionIndex = q.options.length;
			} else if (existing && !existing.wasCustom) {
				const idx = q.options.indexOf(existing.answer);
				optionIndex = idx >= 0 ? idx : 0;
			} else {
				optionIndex = q.recommended ?? 0;
			}
		}

		function advanceAfterAnswer() {
			if (!isMulti) {
				submit(false);
				return;
			}
			if (currentTab < questions.length - 1) currentTab++;
			else currentTab = questions.length;
			const nextQ = currentQuestion();
			if (nextQ) enterQuestion(nextQ);
			else optionIndex = 0;
			refresh();
		}

		function saveAnswer(qId: string, value: string, wasCustom: boolean) {
			const q = questions.find((qq) => qq.id === qId);
			answers.set(qId, { id: qId, question: q?.question ?? qId, answer: value, wasCustom });
		}

		editor.onSubmit = (value) => {
			if (!inputQuestionId) return;
			const trimmed = value.trim();
			if (!trimmed) {
				refresh();
				return;
			}
			drafts.delete(inputQuestionId);
			saveAnswer(inputQuestionId, trimmed, true);
			inputMode = false;
			inputQuestionId = null;
			editor.setText("");
			advanceAfterAnswer();
		};

		function exitEditor() {
			if (inputQuestionId) {
				const text = editor.getText();
				if (text.trim()) drafts.set(inputQuestionId, text);
				else drafts.delete(inputQuestionId);
			}
			inputMode = false;
			inputQuestionId = null;
			editor.setText("");
		}

		enterQuestion(questions[0]);

		function handleInput(data: string) {
			if (inputMode) {
				if (matchesKey(data, Key.escape)) {
					const q = currentQuestion();
					if (q && q.options.length === 0 && !isMulti) submit(true);
					else {
						exitEditor();
						refresh();
					}
					return;
				}
				if (isMulti && (matchesKey(data, Key.tab) || matchesKey(data, Key.shift("tab")))) {
					exitEditor();
					currentTab = matchesKey(data, Key.tab) ? (currentTab + 1) % totalTabs : (currentTab - 1 + totalTabs) % totalTabs;
					const nextQ = currentQuestion();
					if (nextQ) enterQuestion(nextQ);
					else optionIndex = 0;
					refresh();
					return;
				}
				editor.handleInput(data);
				refresh();
				return;
			}

			const q = currentQuestion();
			const opts = displayOptions();

			if (isMulti) {
				if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
					currentTab = (currentTab + 1) % totalTabs;
					const nextQ = currentQuestion();
					if (nextQ) enterQuestion(nextQ);
					else optionIndex = 0;
					refresh();
					return;
				}
				if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
					currentTab = (currentTab - 1 + totalTabs) % totalTabs;
					const nextQ = currentQuestion();
					if (nextQ) enterQuestion(nextQ);
					else optionIndex = 0;
					refresh();
					return;
				}
			}

			if (currentTab === questions.length) {
				if (matchesKey(data, Key.enter) && allAnswered()) submit(false);
				else if (matchesKey(data, Key.escape)) submit(true);
				return;
			}

			if (matchesKey(data, Key.up)) {
				optionIndex = Math.max(0, optionIndex - 1);
				refresh();
				return;
			}
			if (matchesKey(data, Key.down)) {
				optionIndex = Math.min(opts.length - 1, optionIndex + 1);
				refresh();
				return;
			}

			// Auditor toggle hotkey
			if (matchesKey(data, "a") && auditorToggleInit) {
				auditorEnabled = !auditorEnabled;
				refresh();
				return;
			}

			if (matchesKey(data, Key.enter) && q) {
				if (q.options.length === 0 || opts[optionIndex]?.isCustom) {
					inputMode = true;
					inputQuestionId = q.id;
					const draft = drafts.get(q.id);
					const existing = answers.get(q.id);
					editor.setText(draft ?? (existing?.wasCustom ? existing.answer : ""));
					refresh();
					return;
				}
				const opt = opts[optionIndex];
				if (opt) {
					saveAnswer(q.id, opt.label, false);
					advanceAfterAnswer();
				}
				return;
			}

			if (matchesKey(data, Key.escape)) submit(true);
		}

			function render(width: number): string[] {
			if (cachedLines) return cachedLines;
			const safeWidth = Math.max(20, width);
			let lines: string[] = [];
			const q = currentQuestion();
			const opts = displayOptions();
			const add = (s: string) => lines.push(truncateToWidth(s, safeWidth, "…", true));
			const addWrapped = (s: string) => lines.push(...wrapTextWithAnsi(s, safeWidth));
			/**
			 * Wraps a pipe-prefixed line and prepends "│   " to continuation lines
			 * so wrapped content stays within the ASCII box.
			 */
			const PIPE_PREFIX = "│   ";
			const PIPE_WIDTH = visibleWidth(PIPE_PREFIX);
			const addWrappedPipe = (styledLine: string) => {
				const wrapWidth = Math.max(1, safeWidth - PIPE_WIDTH);
				const wrapped = wrapTextWithAnsi(styledLine, wrapWidth);
				for (let i = 0; i < wrapped.length; i++) {
					lines.push(i === 0 ? wrapped[i] : PIPE_PREFIX + wrapped[i]);
				}
			};

			/** Render context lines with per-line styling. No truncation. */
			const renderContextLines = (context: string): void => {
				const rawLines = context.split("\n");
				for (const rawLine of rawLines) {
					const trimmed = rawLine.trim();
					// Empty line — preserve as spacing
					if (!trimmed) {
						lines.push("");
						continue;
					}

					// 1. Announcement header — "● Goal draft/tweak ready for confirmation."
					if (/^● Goal (draft|tweak) ready for confirmation\.$/.test(trimmed)) {
						addWrapped(theme.fg("accent", rawLine));
						continue;
					}

					// 2. Section marker — "─── Name ───" → full-width box-drawing header
					const sectionMatch = trimmed.match(/^───\s+(.+?)\s+───$/);
					if (sectionMatch) {
						const sectionName = sectionMatch[1];
						const namePart = ` ${sectionName} `;
						const left = "┌─";
						const right = "─┐";
						const fill = Math.max(0, safeWidth - 2 - visibleWidth(left + namePart + right));
						add(theme.fg("accent", left + namePart + "─".repeat(fill) + right));
						continue;
					}

					// 3. Lines with │ prefix come from buildDraftConfirmationText / buildTweakConfirmationText.
					if (trimmed.startsWith("│")) {
						const afterPipe = trimmed.slice(1).trim();
						// 3a. Task checkbox under │ prefix — detect before key-value to avoid
						// "[x] t1: ..." being misinterpreted as a key-value pair.
						const pipeTaskMatch = afterPipe.match(/^(\[.\])(\s+)(.+)$/);
						if (pipeTaskMatch) {
							const bracket = pipeTaskMatch[1];
							const sep = pipeTaskMatch[2];
							const rest = pipeTaskMatch[3];
							// Preserve inner whitespace between │ and the task marker (e.g. "   " in "│   [x]...")
							const pipeContent = trimmed.slice(1);
							const innerWs = pipeContent.slice(0, pipeContent.length - pipeContent.trimStart().length);
							const linePrefix = "│" + innerWs;
							const color = bracket === "[x]" ? "success" : "warning";
							addWrappedPipe(linePrefix + theme.fg(color, bracket) + sep + theme.fg("muted", rest));
							continue;
						}
						// 3b. Key-value content (e.g. "│   Mode: Normal goal", "│   Auto-continue: yes")
						if (afterPipe.includes(": ")) {
							const colonIdx = afterPipe.indexOf(": ");
							const val = afterPipe.slice(colonIdx + 2).trim();
							const keyPart = rawLine.slice(0, rawLine.indexOf(afterPipe) + colonIdx + 2);
							if (val === "yes" || val === "no") {
								addWrappedPipe(theme.fg("muted", keyPart) + theme.fg(val === "yes" ? "success" : "warning", val));
								continue;
							}
							addWrappedPipe(theme.fg("muted", rawLine));
							continue;
						}
						// 3c. Generic content under │ prefix (topic, goal text, etc.)
						addWrappedPipe(theme.fg("muted", rawLine));
						continue;
					}

					// 4. Goal objective structure lines — detected before task checkboxes
					// because === Goal could overlap with ─── markers but we already checked those.
					const GOAL_SECTION_RE = /^(=== (Goal|Sisyphus Goal) ===|Objective:|Success criteria:|Boundaries:|Constraints:|Verification contract:|If blocked:)/;
					if (GOAL_SECTION_RE.test(trimmed)) {
						addWrapped(theme.fg("accent", rawLine));
						continue;
					}

					// 5. Actual box-drawing borders (┌ └ ├ └ ┐ ┤ ┘ ─) — NOT │ which is handled above
					if (/^[┌├└┐┤┘─]/.test(trimmed)) {
						addWrapped(theme.fg("dim", rawLine));
						continue;
					}

					// 6. Task checkbox item — "[ ] ...", "[x] ...", or "[~] ..." (with optional indent)
					const checkMatch = trimmed.match(/^(\[.\])(\s+)(.+)$/);
					if (checkMatch) {
						const bracket = checkMatch[1];
						const sep = checkMatch[2];
						const rest = checkMatch[3];
						const indent = rawLine.slice(0, rawLine.length - trimmed.length);
						const color = bracket === "[x]" ? "success" : "warning";
						addWrapped(indent + theme.fg(color, bracket) + sep + theme.fg("muted", rest));
						continue;
					}

					// 7. Default: any remaining content (fallback)
					addWrapped(theme.fg("muted", rawLine));
				}
			};

			add(theme.fg("accent", "─".repeat(safeWidth)));
			if (isMulti) {
				const tabs: string[] = ["← "];
				for (let i = 0; i < questions.length; i++) {
					const isActive = i === currentTab;
					const isAnswered = answers.has(questions[i].id);
					const label = ` ${isAnswered ? "■" : "□"} ${questions[i].id} `;
					tabs.push(isActive ? theme.bg("selectedBg", theme.fg("text", label)) : theme.fg(isAnswered ? "success" : "muted", label));
					tabs.push(" ");
				}
				const submitText = " ✓ Submit ";
				tabs.push(currentTab === questions.length ? theme.bg("selectedBg", theme.fg("text", submitText)) : theme.fg(allAnswered() ? "success" : "dim", submitText));
				tabs.push(" →");
				add(` ${tabs.join("")}`);
				lines.push("");
			}

			function renderOptions() {
				for (let i = 0; i < opts.length; i++) {
					const opt = opts[i];
					const selected = i === optionIndex;
					const prefix = selected ? theme.fg("accent", "> ") : "  ";
					const recTag = !opt.isCustom && q?.recommended === i ? theme.fg("success", " ★") : "";
					addWrapped(prefix + theme.fg(selected ? "accent" : "text", `${i + 1}. ${opt.label}`) + recTag);
				}
			}

			if (inputMode && q) {
				addWrapped(theme.fg("text", ` ${q.question}`));
				if (q.context) renderContextLines(q.context);
				lines.push("");
				if (q.options.length > 0) {
					renderOptions();
					lines.push("");
				}
				add(theme.fg("muted", " Your answer:"));
				for (const line of editor.render(safeWidth - 2)) add(` ${line}`);
				lines.push("");
				add(theme.fg("dim", " Enter to submit • Esc to cancel"));
			} else if (currentTab === questions.length) {
				add(theme.fg("accent", theme.bold(" Ready to submit")));
				lines.push("");
				for (const question of questions) {
					const answer = answers.get(question.id);
					add(`${theme.fg("muted", ` ${question.id}: `)}${answer ? theme.fg("text", `${answer.wasCustom ? "(wrote) " : ""}${answer.answer}`) : theme.fg("warning", "(unanswered)")}`);
				}
				lines.push("");
				add(allAnswered() ? theme.fg("success", " Press Enter to submit") : theme.fg("warning", ` Unanswered: ${questions.filter((qq) => !answers.has(qq.id)).map((qq) => qq.id).join(", ")}`));
			} else if (q) {
				addWrapped(theme.fg("text", ` ${q.question}`));
				if (q.context) renderContextLines(q.context);
				// Auditor toggle line between context and options
				if (auditorToggleInit) {
					const circle = auditorEnabled ? "●" : "○";
					const label = auditorEnabled ? "Auditor enabled" : "Auditor disabled";
					const color = auditorEnabled ? "success" : "warning";
					add(theme.fg(color, ` ${circle} ${label}`) + theme.fg("dim", "  (press 'a' to toggle)"));
					lines.push("");
				}
				const existing = answers.get(q.id);
				if (existing) add(theme.fg("dim", ` Current: ${existing.wasCustom ? "(wrote) " : ""}${existing.answer}`));
				lines.push("");
				if (opts.length > 0) renderOptions();
				else add(theme.fg("muted", " Press Enter to write your answer"));
			}

			lines.push("");
			if (!inputMode) {
				const auditorHint = auditorToggleInit ? " • a toggle auditor" : "";
				add(theme.fg("dim", isMulti ? " Tab/←→ navigate • ↑↓ select • Enter confirm • Esc cancel" + auditorHint : " ↑↓ navigate • Enter select • Esc cancel" + auditorHint));
			}
			add(theme.fg("accent", "─".repeat(safeWidth)));
			// Safety net: ensure no returned line exceeds the terminal width
			for (let i = 0; i < lines.length; i++) {
				if (lines[i] && visibleWidth(lines[i]) > safeWidth) {
					lines[i] = truncateToWidth(lines[i], safeWidth);
				}
			}
			// Churn guard: tail-slice to the terminal-height bound (see factory top).
			if (maxDialogLines !== undefined && lines.length > maxDialogLines) {
				lines = lines.slice(lines.length - maxDialogLines);
			}
			cachedLines = lines;
			return lines;
		}

		return { render, invalidate: () => { cachedLines = undefined; }, handleInput };
	});
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
): Promise<{ decision: ProposalDecision; auditorEnabled: boolean }> {
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
	return { decision, auditorEnabled: result.auditorEnabled ?? true };
}
