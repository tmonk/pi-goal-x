import assert from "node:assert/strict";
import test from "node:test";

import { createMockExtensionContext, createMockTheme, createMockTUI } from "./tui-test-utils.ts";
import { buildDraftConfirmationText } from "../extensions/goal-draft.ts";
import type { GoalTask } from "../extensions/goal-record.ts";
import { renderConfirmationTasks } from "../extensions/goal-task-confirmation.ts";
import {
	computeDialogLineLimit,
	type DialogScrollState,
	findProposalPresentationSegments,
	fitDialogLines,
	formatQuestionnaireAnswers,
	isHeadlessQuestionSufficientForDraft,
	normalizeQuestionnaireQuestions,
	proposalDialogFailureMessage,
	proposalDecisionFromQuestionnaireResult,
	showProposalDialog,
	runGoalQuestionnaire,
	shouldAutoConfirmProposal,
	DIALOG_UNAVAILABLE_HINT,
	type GoalQuestionnaireResult,
} from "../extensions/goal-questionnaire.ts";

test("normalizeQuestionnaireQuestions trims ids, de-duplicates, filters options, and validates recommended", () => {
	assert.deepEqual(
		normalizeQuestionnaireQuestions([
			{ id: " scope ", question: "Scope?", options: [" A ", "", "B"], recommended: 1 },
			{ id: "scope", question: "Again?", options: ["X"], recommended: 2, allowCustom: false },
			{ id: "  ", question: "Empty id?", options: [], recommended: 0 },
		]),
		[
			{ id: "scope", question: "Scope?", options: [" A ", "B"], recommended: 1, allowCustom: true },
			{ id: "scope-2", question: "Again?", options: ["X"], recommended: undefined, allowCustom: false },
			{ id: "q3", question: "Empty id?", options: [], recommended: undefined, allowCustom: true },
		],
	);
});

test("dialog line limit supports pi 0.83 frames and pi 0.84 docked/fullscreen frames", () => {
	assert.equal(computeDialogLineLimit({ terminalRows: 46, baseFrameLines: 38 }), 10);
	assert.equal(computeDialogLineLimit({ terminalRows: 46, baseFrameLines: 20 }), 27);
	assert.equal(computeDialogLineLimit({ terminalRows: 46 }), 42);
	assert.equal(computeDialogLineLimit({ terminalRows: 8 }), 4);
	assert.equal(computeDialogLineLimit({ terminalRows: 8, baseFrameLines: 20 }), 8);
	assert.equal(computeDialogLineLimit({ terminalRows: 3 }), 3);
	assert.equal(computeDialogLineLimit({}), undefined);
});

test("formatQuestionnaireAnswers emits stable Q/A records with context and options", () => {
	const result: GoalQuestionnaireResult = {
		cancelled: false,
		questions: [
			{ id: "scope", question: "Scope?", context: "Pick one", options: ["A", "B"], allowCustom: true },
			{ id: "notes", question: "Notes?", options: [], allowCustom: true },
		],
		answers: [
			{ id: "scope", question: "Scope?", answer: "A", wasCustom: false },
			{ id: "notes", question: "Notes?", answer: "Custom", wasCustom: true },
		],
	};

	assert.equal(
		formatQuestionnaireAnswers(result),
		"**Q:** Scope?\nPick one\nOptions: A / B\n**A:** A\n\n---\n\n**Q:** Notes?\n**A:** Custom",
	);
});

test("headless question sufficiency blocks vague-topic default fabrication", () => {
	assert.equal(isHeadlessQuestionSufficientForDraft({
		topic: "整理笔记",
		questionText: "你的笔记目前存放在哪里，是什么格式？输出为什么形式？",
	}), false);
	assert.equal(isHeadlessQuestionSufficientForDraft({
		topic: "在 sandbox 当前目录创建 hello.txt，内容为 Hello, Goal!，不要修改其他文件。",
		questionText: "如果 hello.txt 已存在，应该覆盖还是停止？",
	}), true);
});

// Realistic repro content from the reported bug: the agent asked "via uv too?"
// while the goal panel + chat frame (19 lines) left only 10 dialog rows on a
// 24-row terminal; the option labels wrap over multiple lines.
const REPRO_QUESTION_TEXT = "via uv too?";
const REPRO_OPTION_LABELS = [
	"Dev toolchain only (recommended): pyproject.toml with [tool.uv] package=false, [dependency-groups] dev (pytest, pytest-benchmark), pytest config moved in; committed uv.lock; `uv sync` + `uv run pytest benchmarks/`; requirements-dev.txt and pytest.ini removed; runtime/zipapp/battery stay stdlib-only and uv-free",
	"Also pin a dev Python via uv (.python-version, e.g. 3.12) while the runtime floor stays >=3.9",
	"Also manage the built artifact with uv (uv tool install of the zipapp) — note: the zipapp is self-contained, uv adds nothing there",
	"Write your own answer...",
];

/**
 * Open a single-question goal_question dialog against a TUI that exposes
 * terminal.rows and previousLines (pi's regular-renderer frame cache), so the
 * terminal-height churn guard actually engages, and return the rendered lines.
 */
function renderGoalQuestionDialog(args: { rows: number; baseFrameLines: number }, width = 100): string[] {
	const ctx = createMockExtensionContext();
	void runGoalQuestionnaire(ctx, [{
		id: "question",
		question: REPRO_QUESTION_TEXT,
		options: REPRO_OPTION_LABELS,
		recommended: 0,
	}]);
	const record = ctx._customCalls[0];
	assert.ok(record, "goal_question opens a custom dialog");
	const { tui } = createMockTUI();
	const augmented = Object.assign(tui, {
		terminal: { rows: args.rows },
		previousLines: Array.from({ length: args.baseFrameLines }, () => "x"),
	});
	const theme = createMockTheme();
	const component = record.factory(augmented, theme, {}, () => {});
	return (component as { render(w: number): string[] }).render(width);
}

test("regression: agent question stays readable when the goal panel leaves little room (rows=24, baseFrame=19)", () => {
	// Reported repro: a goal_question dialog opened while the pi-goal-x goal
	// panel + chat frame consumed 19 rows of a 24-row terminal. The churn guard
	// bounds the dialog to 10 lines and tail-slices it — which dropped the top
	// border AND the question text, leaving only option fragments + footer.
	const lines = renderGoalQuestionDialog({ rows: 24, baseFrameLines: 19 });
	assert.ok(lines.length <= 10, "dialog stays within the terminal-height bound");
	assert.match(lines[0]!, /^─+$/, "top border must be visible");
	assert.ok(lines.some((l) => l.includes(REPRO_QUESTION_TEXT)), "question text must be visible");
	assert.ok(lines.some((l) => l.includes("Dev toolchain only")), "recommended first option must be visible");
	// §options-scroll: when content is clipped the reserved bottom edge is the
	// scroll indicator ("… +N more · PgUp/PgDn scroll") — the border is
	// reachable by scrolling to the end. The indicator, not a silent slice,
	// tells the user the remaining options exist.
	const last = lines[lines.length - 1]!;
	assert.ok(
		/^─+$/.test(last) || last.includes("more · PgUp/PgDn scroll"),
		"bottom edge is the border or the scroll indicator when clipped",
	);
});

// Proposal confirmation repro: the goal confirmation dialog (showProposalDialog)
// renders the full draft — objective box + "Tasks proposed for confirmation:" +
// task lines + auditor line — as question context. The draft text is built with
// the real production helpers (buildDraftConfirmationText + renderConfirmationTasks)
// exactly as proposalText() does for a new draft.
const PROPOSAL_TOPIC = "Goal draft is not presenting tasks";
const PROPOSAL_OBJECTIVE = [
	"=== Goal ===",
	"Objective: Fix the pi-goal-x bug where the goal draft is not presenting tasks.",
	"Success criteria: the tasks section is visible in the confirmation dialog.",
	"Boundaries: in scope: extensions; out of scope: pi-tui API changes.",
	"Constraints: the dialog frame must never exceed the terminal height.",
	"Verification contract: npm run check (0 errors); npm test (0 failures).",
	"If blocked: stop and ask the user.",
].join("\n");
// Two tasks: at rows=24/baseFrame=19 the churn guard allows exactly 10 dialog
// lines — head (2) + tasks header + every task line + options + footer + border
// must all stay in-frame; a longer list still relies on scrollback completeness.
const PROPOSAL_TASKS: GoalTask[] = [
	{ id: "task-1", title: "Add the failing render-level regression test", status: "pending" },
	{ id: "task-2", title: "Add the failing flow-level regression test", status: "pending" },
];
const PROPOSAL_CONFIRM_OPTIONS = [
	"Confirm — create this goal now",
	"Continue chatting — keep refining",
	"Cancel — discard this draft",
];

function buildProposalConfirmationContext(tasks: readonly GoalTask[], auditorEnabled: boolean): string {
	const base = buildDraftConfirmationText({ focus: "goal", originalTopic: PROPOSAL_TOPIC, objective: PROPOSAL_OBJECTIVE, autoContinue: true });
	const tasksText = "\n\nTasks proposed for confirmation:\n" + renderConfirmationTasks(tasks, 0).join("\n");
	const auditorLine = auditorEnabled
		? "\n\nAuditor for this goal: enabled (independent approval required before completion)."
		: "\n\nAuditor for this goal: disabled (completion skips the audit).";
	return base + tasksText + auditorLine;
}

/**
 * Open the goal confirmation dialog (showProposalDialog shape: single confirm
 * question with the full draft as context) and return the rendered lines.
 */
function renderProposalDialog(args: { rows: number; baseFrameLines: number }, width = 100): string[] {
	const ctx = createMockExtensionContext();
	void runGoalQuestionnaire(ctx, [{
		id: "confirm",
		question: "Confirm Goal Draft",
		context: buildProposalConfirmationContext(PROPOSAL_TASKS, true),
		options: PROPOSAL_CONFIRM_OPTIONS,
		recommended: 0,
		allowCustom: false,
	}], { defaultEnabled: true });
	const record = ctx._customCalls[0];
	assert.ok(record, "goal confirmation opens a custom dialog");
	const { tui } = createMockTUI();
	const augmented = Object.assign(tui, {
		terminal: { rows: args.rows },
		previousLines: Array.from({ length: args.baseFrameLines }, () => "x"),
	});
	const theme = createMockTheme();
	const component = record.factory(augmented, theme, {}, () => {});
	return (component as { render(w: number): string[] }).render(width);
}

test("regression: the goal confirmation dialog presents the tasks and the auditor toggle (rows=24, baseFrame=19)", () => {
	// Reported repro: the goal draft was not presenting tasks. The proposal
	// confirmation dialog renders the full draft (objective box + "Tasks
	// proposed for confirmation:" + task lines) as context; the churn guard
	// bounds the dialog to 10 lines and the tail-keep slice dropped the entire
	// tasks section — the user was asked to confirm without ever seeing the plan.
	// The auditor toggle line must stay in frame too: it is the only in-dialog
	// status feedback for the auditor on/off state (the proposal text line is
	// not interactive). Task lines beyond the bound remain in the scrollback
	// presentation.
	const lines = renderProposalDialog({ rows: 24, baseFrameLines: 19 });
	assert.ok(lines.length <= 10, "dialog stays within the terminal-height bound");
	assert.match(lines[0]!, /^─+$/, "top border must be visible");
	assert.ok(lines.some((l) => l.includes("Confirm Goal Draft")), "question must be visible");
	assert.ok(lines.some((l) => l.includes("Tasks proposed for confirmation:")), "tasks header must be visible");
	assert.ok(
		lines.some((l) => l.includes("[ ] task-1: Add the failing render-level regression test")),
		"at least one task line must be visible",
	);
	assert.ok(
		lines.some((l) => l.includes("press 'a' to toggle")),
		"the auditor toggle line must be visible in the bounded dialog",
	);
	assert.ok(lines.some((l) => l.includes("Confirm — create this goal now")), "confirm option must be visible");
	assert.ok(lines.some((l) => l.includes("Enter select")), "footer hint must be visible");
	assert.match(lines[lines.length - 1]!, /^─+$/, "bottom border must be visible");
});

test("fitDialogLines keeps the protected head and never exceeds the bound", () => {
	const lines = ["─", "Q", "", "ctx1", "ctx2", "", "1. A", "2. B", "", "footer", "─"];
	// Under the limit: unchanged.
	assert.deepEqual(fitDialogLines(lines, 20, 3), lines);
	// Tiny bound: the head alone fits (question stays visible).
	assert.deepEqual(fitDialogLines(["─", "Q", "", "1. A", "footer", "─"], 2, 2), ["─", "Q"]);
});

test("fitDialogLines tail-keeps context-heavy dialogs so options/footer/border stay", () => {
	const lines = ["─", "Confirm", "", "ctx1", "ctx2", "", "1. A", "2. B", "", "footer", "─"];
	// Context dialog (options at the end): head + tail, middle context sliced —
	// the actionable options, footer, and bottom border remain visible.
	assert.deepEqual(fitDialogLines(lines, 6, 3), ["─", "Confirm", "", "", "footer", "─"]);
	assert.deepEqual(fitDialogLines(lines, 8, 3), ["─", "Confirm", "", "1. A", "2. B", "", "footer", "─"]);
});

test("fitDialogLines viewport: full content stays reachable, nothing truncated or dropped", () => {
	const lines = ["─", "Q", "", "1. first", "2. second", "3. third", "", "footer", "─"];
	// Bound 6: content window 5 + reserved bottom edge. The top options stay
	// visible (recommended/first option never hidden) and the clipped rest is
	// advertised with a scroll hint instead of being silently dropped.
	const scroll: DialogScrollState = { scrollTop: 0, needsFollow: false, optionRanges: [], followIndex: 0 };
	assert.deepEqual(fitDialogLines(lines, 6, 3, null, scroll), [
		"─",
		"Q",
		"",
		"1. first",
		"2. second",
		"… +3 more · PgUp/PgDn scroll",
	]);
	// Scroll position is clamped to the content end.
	scroll.scrollTop = 99;
	assert.deepEqual(fitDialogLines(lines, 6, 3, null, scroll), [
		"▲ 3 more",
		"2. second",
		"3. third",
		"",
		"footer",
		"─",
	]);
	// Every content line is reachable across the scroll range: the union of
	// viewports over all scroll positions covers the full dialog.
	const full = new Set(lines);
	const seen = new Set<string>();
	for (let s = 0; s <= lines.length; s++) {
		for (const l of fitDialogLines(lines, 6, 3, null, { scrollTop: s, needsFollow: false, optionRanges: [], followIndex: 0 })) {
			if (!l.startsWith("… +") && !l.startsWith("▲")) seen.add(l);
		}
	}
	for (const l of full) assert.ok(seen.has(l), `content line reachable: ${l}`);
});

test("fitDialogLines viewport: selection auto-follow nudges the window into view", () => {
	const lines = ["─", "Q", "", "1. first", "2. second", "3. third", "", "footer", "─"];
	const ranges: Array<[number, number]> = [[3, 3], [4, 4], [5, 5]];
	// Selection below the window: follow nudges scrollTop so it is visible.
	const scroll: DialogScrollState = { scrollTop: 0, needsFollow: true, optionRanges: ranges, followIndex: 2 };
	const out = fitDialogLines(lines, 4, 3, null, scroll);
	assert.equal(scroll.scrollTop, 3, "window nudged to reveal the selected option");
	assert.ok(out.some((l) => l.includes("3. third")), "selected option visible");
	assert.equal(scroll.needsFollow, false, "follow flag consumed");
	// Selection already visible: no nudge.
	const ranges2: Array<[number, number]> = [[1, 1], [3, 3], [5, 5]];
	const scroll2: DialogScrollState = { scrollTop: 0, needsFollow: true, optionRanges: ranges2, followIndex: 0 };
	fitDialogLines(lines, 4, 3, null, scroll2);
	assert.equal(scroll2.scrollTop, 0, "no nudge when the selection is already visible");
});

test("fitDialogLines viewport: ▲ indicator and never-exceeds-bound across the scroll range", () => {
	const lines = ["─", "Q", "", "1. first", "2. second", "3. third", "", "footer", "─"];
	// Scrolled down: the top content row gives way to a themed ▲ indicator.
	const scrolled: DialogScrollState = { scrollTop: 4, needsFollow: false, optionRanges: [], followIndex: 0 };
	const out = fitDialogLines(lines, 5, 2, null, scrolled);
	assert.ok(out[0]!.startsWith("▲ 4 more"), "▲ indicator at the top when scrolled down");
	assert.ok(out.length <= 5);
	// Churn-guard invariant: never exceeds the bound at ANY scroll position or
	// degenerate budget (the head itself may fill the bound).
	for (const bound of [1, 2, 3, 4, 5, 8]) {
		for (let s = 0; s <= lines.length + 2; s++) {
			const sc: DialogScrollState = { scrollTop: s, needsFollow: false, optionRanges: [], followIndex: 0 };
			assert.ok(fitDialogLines(lines, bound, Math.min(2, bound), null, sc).length <= bound, `bound ${bound} at scroll ${s}`);
		}
	}
	// Tail-keep (no scroll state) keeps its own bound guarantee.
	assert.ok(fitDialogLines(["─", "Q", "", "ctx", "", "1. A", "", "footer", "─"], 4, 2).length <= 4);
});

// Proposal-confirmation synthetic render (goal confirmation dialog shape):
// head (border + question), objective-box context, tasks section, auditor
// line, then the options/footer/border tail.
const PROPOSAL_UNIT_LINES = [
	"─",
	" Confirm Goal Draft",
	"● Goal draft ready for confirmation.",
	" Objective: Fix the goal draft.",
	" Success criteria: tasks visible.",
	"",
	"Tasks proposed for confirmation:",
	"[ ] task-1: Add the failing render-level regression test",
	"[ ] task-2: Add the failing flow-level regression test",
	"[ ] task-3: Add the fitDialogLines unit tests",
	"",
	" Auditor for this goal: enabled.",
	"",
	" 1. Confirm — create this goal now",
	" 2. Continue chatting — keep refining",
	" 3. Cancel — discard this draft",
	"",
	" ↑↓ navigate • Enter select • Esc cancel",
	"─",
];
const PROPOSAL_UNIT_SEGMENTS = { tasksStart: 6, tasksEnd: 9, tailStart: 13 };

test("fitDialogLines proposal mode: content that fits renders byte-identical", () => {
	assert.deepEqual(fitDialogLines(PROPOSAL_UNIT_LINES, 30, 2, PROPOSAL_UNIT_SEGMENTS), PROPOSAL_UNIT_LINES);
});

test("fitDialogLines proposal mode: head + tasks + options/footer/border kept within budget", () => {
	// Budget 12: head (2) + tasks header + all 3 task lines + the whole tail.
	// The objective-box middle and the auditor line are sacrificed in-frame.
	assert.deepEqual(
		fitDialogLines(PROPOSAL_UNIT_LINES, 12, 2, PROPOSAL_UNIT_SEGMENTS),
		[
			"─",
			" Confirm Goal Draft",
			"Tasks proposed for confirmation:",
			"[ ] task-1: Add the failing render-level regression test",
			"[ ] task-2: Add the failing flow-level regression test",
			"[ ] task-3: Add the fitDialogLines unit tests",
			" 1. Confirm — create this goal now",
			" 2. Continue chatting — keep refining",
			" 3. Cancel — discard this draft",
			"",
			" ↑↓ navigate • Enter select • Esc cancel",
			"─",
		],
	);
});

test("fitDialogLines proposal mode: strips blank spacing, then drops task lines from the end", () => {
	// Budget 10: head + tasks header + first 2 task lines + options/footer/
	// border (the blank between options and footer is stripped; task-3 drops
	// only after that, and stays readable in the scrollback presentation).
	const fitted = fitDialogLines(PROPOSAL_UNIT_LINES, 10, 2, PROPOSAL_UNIT_SEGMENTS);
	assert.deepEqual(fitted, [
		"─",
		" Confirm Goal Draft",
		"Tasks proposed for confirmation:",
		"[ ] task-1: Add the failing render-level regression test",
		"[ ] task-2: Add the failing flow-level regression test",
		" 1. Confirm — create this goal now",
		" 2. Continue chatting — keep refining",
		" 3. Cancel — discard this draft",
		" ↑↓ navigate • Enter select • Esc cancel",
		"─",
	]);
	assert.ok(!fitted.join("\n").includes("task-3"), "task-3 drops only after blank spacing is exhausted");
});

test("fitDialogLines proposal mode: never exceeds the bound even at degenerate budgets", () => {
	// Budget 6: head + tail kept from its end (border/footer first).
	const tight = fitDialogLines(PROPOSAL_UNIT_LINES, 6, 2, PROPOSAL_UNIT_SEGMENTS);
	assert.ok(tight.length <= 6);
	assert.match(tight[tight.length - 1]!, /^─+$/, "bottom border must be visible");
	assert.ok(tight.some((l) => l.includes("Enter select")), "footer hint must be visible");
	// Budget 3: head + bottom border only, still within the bound.
	const tiny = fitDialogLines(PROPOSAL_UNIT_LINES, 3, 2, PROPOSAL_UNIT_SEGMENTS);
	assert.equal(tiny.length, 3);
	assert.match(tiny[tiny.length - 1]!, /^─+$/, "bottom border must be visible");
	// Budget 1: the head itself fills the bound.
	assert.equal(fitDialogLines(PROPOSAL_UNIT_LINES, 1, 2, PROPOSAL_UNIT_SEGMENTS).length, 1);
});

test("findProposalPresentationSegments locates the tasks section and options tail", () => {
	assert.deepEqual(findProposalPresentationSegments(PROPOSAL_UNIT_LINES, 13), PROPOSAL_UNIT_SEGMENTS);
	// A plain agent question (no tasks marker) is not a proposal confirmation.
	assert.equal(findProposalPresentationSegments(["─", "Q", "", "1. A", "footer", "─"], 3), null);
	// Degenerate tail index is rejected.
	assert.equal(findProposalPresentationSegments(PROPOSAL_UNIT_LINES, -1), null);
});

test("proposal confirmation helpers keep headless and cancel semantics stable", () => {
	assert.equal(shouldAutoConfirmProposal({ hasUI: false }), true);
	assert.equal(shouldAutoConfirmProposal({ hasUI: true, autoConfirmEnv: "1" }), true);
	assert.equal(shouldAutoConfirmProposal({ hasUI: true, autoConfirmEnv: "0" }), false);
	assert.equal(proposalDecisionFromQuestionnaireResult({ cancelled: true, answer: "Confirm — create this goal now" }), "continue");
	assert.equal(proposalDecisionFromQuestionnaireResult({ cancelled: false, answer: "Confirm — create this goal now" }), "confirm");
	assert.equal(proposalDecisionFromQuestionnaireResult({ cancelled: false, answer: "Continue chatting — keep refining" }), "continue");
	assert.equal(proposalDecisionFromQuestionnaireResult({ cancelled: false, answer: "Cancel — discard this draft" }), "cancel");
	assert.match(proposalDialogFailureMessage(new Error("boom")), /NOT created/);
	assert.match(proposalDialogFailureMessage(new Error("boom")), /drafting remains active/);
});

// ── Auditor-restore regressions (specs/2026-08-08-tweak-status-persistence) ─
// The real TUI renders every dialog line with ANSI SGR sequences (theme.fg);
// the mock theme emits none, so regressions in ANSI-aware scanning only show
// up with styled lines.

const ANSI_STYLE = (s: string) => `\x1b[32m${s}\x1b[0m`;

/** Open the proposal confirmation dialog against an ANSI-emitting theme. */
function openProposalDialogComponent(args: { rows: number; baseFrameLines: number }, width = 100) {
	const ctx = createMockExtensionContext();
	void runGoalQuestionnaire(ctx, [{
		id: "confirm",
		question: "Confirm Goal Draft",
		context: buildProposalConfirmationContext(PROPOSAL_TASKS, true),
		options: PROPOSAL_CONFIRM_OPTIONS,
		recommended: 0,
		allowCustom: false,
	}], { defaultEnabled: true });
	const record = ctx._customCalls[0];
	assert.ok(record, "goal confirmation opens a custom dialog");
	const { tui } = createMockTUI();
	const augmented = Object.assign(tui, {
		terminal: { rows: args.rows },
		previousLines: Array.from({ length: args.baseFrameLines }, () => "x"),
	});
	const ansiTheme = {
		fg: (_c: string, v: string) => ANSI_STYLE(v),
		bold: (v: string) => v,
		bg: () => "",
		dim: (v: string) => v,
	} as unknown as ReturnType<typeof createMockTheme>;
	return record.factory(augmented, ansiTheme, {}, () => {}) as unknown as {
		render(w: number): string[];
		handleInput(data: string): void;
	};
}

test("findProposalPresentationSegments is ANSI-aware: styled task lines extend the tasks section", () => {
	// Reported repro: the tasksEnd scan ran the plain-text regex against
	// ANSI-styled lines, broke on the first task line, and collapsed the tasks
	// section to its header — every task line was sliced out of the bounded
	// dialog. Styled lines must extend the section, and tailStart must pull
	// back to the auditor toggle line so the fit keeps it.
	const lines = [
		ANSI_STYLE("─"),
		ANSI_STYLE(" Confirm Goal Draft"),
		ANSI_STYLE("● Goal draft ready for confirmation."),
		ANSI_STYLE(" Objective: Fix the dialog."),
		"",
		ANSI_STYLE("Tasks proposed for confirmation:"),
		ANSI_STYLE("[ ]") + " task-1: First",
		ANSI_STYLE("[ ]") + " task-2: Second",
		"",
		ANSI_STYLE(" ● Auditor enabled") + ANSI_STYLE("  (press 'a' to toggle)"),
		"",
		ANSI_STYLE(" 1. Confirm — create this goal now"),
		ANSI_STYLE(" 2. Continue chatting — keep refining"),
		ANSI_STYLE(" 3. Cancel — discard this draft"),
		"",
		ANSI_STYLE(" ↑↓ navigate • Enter select • Esc cancel"),
		ANSI_STYLE("─"),
	];
	const segs = findProposalPresentationSegments(lines, 12);
	assert.ok(segs, "proposal segments found");
	assert.equal(segs.tasksStart, 5, "tasks header located");
	assert.equal(segs.tasksEnd, 7, "styled task lines extend the tasks section");
	assert.equal(segs.tailStart, 9, "tail pulled back to the auditor toggle line");
});

test("findProposalPresentationSegments keeps the box-drawn TASKS section of a tweak confirmation complete", () => {
	// buildTweakConfirmationText renders explicit tasks inside a ┌─ TASKS ─┐
	// box; the section must include the header, every styled task line, and the
	// box bottom border so the bounded dialog never shows an empty box.
	const lines = [
		ANSI_STYLE("─"),
		ANSI_STYLE(" Confirm Goal Draft"),
		ANSI_STYLE("● Goal tweak ready for confirmation."),
		"",
		ANSI_STYLE("┌─ TASKS ─────────────────────────────────────┐"),
		ANSI_STYLE("[ ]") + " audit: Audit the tweak path",
		ANSI_STYLE("[ ]") + " fix: Fix it",
		ANSI_STYLE("└──────────────────────────────────────────────┘"),
		"",
		ANSI_STYLE(" ● Auditor enabled") + ANSI_STYLE("  (press 'a' to toggle)"),
		"",
		ANSI_STYLE(" 1. Confirm — create this goal now"),
		ANSI_STYLE("─"),
	];
	const segs = findProposalPresentationSegments(lines, 10);
	assert.ok(segs, "proposal segments found");
	assert.equal(segs.tasksStart, 4, "box header located");
	assert.equal(segs.tasksEnd, 7, "task lines AND the box bottom border are kept");
	assert.equal(segs.tailStart, 9, "tail pulled back to the auditor toggle line");
});

test("fitDialogLines proposal mode: the auditor toggle line is never sacrificed at tight budgets", () => {
	// Budget 10 with 2 task lines: head + tasks header + one task line + the
	// auditor toggle line + options/footer/border — the auditor line must
	// survive and a task line gives way (it stays in the scrollback
	// presentation).
	const lines = [
		"─",
		" Confirm Goal Draft",
		"Tasks proposed for confirmation:",
		"[ ] task-1: First",
		"[ ] task-2: Second",
		"",
		" ● Auditor enabled  (press 'a' to toggle)",
		"",
		" 1. Confirm — create this goal now",
		" 2. Continue chatting — keep refining",
		" 3. Cancel — discard this draft",
		"",
		" ↑↓ navigate • Enter select • Esc cancel",
		"─",
	];
	const segs = findProposalPresentationSegments(lines, 8);
	assert.ok(segs, "proposal segments found");
	const fitted = fitDialogLines(lines, 10, 2, segs);
	assert.ok(fitted.length <= 10, "never exceeds the bound");
	assert.ok(fitted.some((l) => l.includes("press 'a' to toggle")), "auditor toggle line stays in frame");
	assert.ok(fitted.some((l) => l.includes("[ ] task-1: First")), "at least one task line stays in frame");
	assert.ok(fitted.some((l) => l.includes("Confirm — create this goal now")), "options stay in frame");
	assert.match(fitted[fitted.length - 1]!, /^─+$/, "bottom border stays");
});

test("regression: the bounded proposal dialog keeps task lines and the auditor toggle with real-TUI ANSI styling", () => {
	// Reported repro (rows=24, baseFrame=19): with real ANSI-styled lines the
	// segment scan broke and the 10-line dialog showed the tasks header with
	// zero task lines and no auditor status. Both must be visible under ANSI
	// styling within the bound.
	const component = openProposalDialogComponent({ rows: 24, baseFrameLines: 19 });
	const plain = component.render(100).map((l) => l.replace(/\x1b\[[0-9;]*m/g, "")); // eslint-disable-line no-control-regex -- ANSI SGR matching
	assert.ok(plain.length <= 10, "dialog stays within the bound");
	assert.ok(plain.some((l) => l.includes("[ ] task-1:")), "a task line is visible under ANSI styling");
	assert.ok(plain.some((l) => l.includes("press 'a' to toggle")), "auditor toggle line is visible under ANSI styling");
});

test("pressing 'a' toggles the auditor status with visible feedback in the bounded proposal dialog", () => {
	const component = openProposalDialogComponent({ rows: 24, baseFrameLines: 19 });
	const before = component.render(100).join("\n");
	assert.ok(before.includes("● Auditor enabled"), "defaults to enabled");
	component.handleInput!("a");
	const after = component.render(100).join("\n");
	assert.ok(after.includes("○ Auditor disabled"), "toggle feedback is visible after 'a'");
	assert.ok(!after.includes("● Auditor enabled"), "status flipped off");
});

// §options-scroll flow tests — the reported bug (bounded questionnaire hides
// options) fixed by in-dialog viewport scrolling. All tests drive the real
// component (render + handleInput) with an ANSI-emitting theme so the mock-
// theme blind spot is exercised.

const PAGE_DOWN = "\x1b[6~";
const PAGE_UP = "\x1b[5~";
const CTRL_DOWN = "\x1bOb";
const CTRL_UP = "\x1bOa";
const ARROW_DOWN = "\x1b[B";
const ARROW_UP = "\x1b[A";
const TAB_KEY = "\t";
const ENTER_KEY = "\r";
const ESC_KEY = "\x1b";

/** Open a questionnaire against an ANSI-emitting theme with real TUI dims. */
function openQuestionnaireComponent(
	args: {
		rows: number;
		baseFrameLines: number;
		questions: Array<{
			id: string;
			question: string;
			context?: string;
			options: string[];
			recommended?: number;
			allowCustom?: boolean;
		}>;
	},
	width = 100,
) {
	const ctx = createMockExtensionContext();
	void runGoalQuestionnaire(ctx, args.questions);
	const record = ctx._customCalls[0];
	assert.ok(record, "goal_questionnaire opens a custom dialog");
	const { tui, state } = createMockTUI();
	const augmented = Object.assign(tui, {
		terminal: { rows: args.rows },
		previousLines: Array.from({ length: args.baseFrameLines }, () => "x"),
	});
	const ansiTheme = {
		fg: (_c: string, v: string) => ANSI_STYLE(v),
		bold: (v: string) => v,
		bg: () => "",
		dim: (v: string) => v,
	} as unknown as ReturnType<typeof createMockTheme>;
	const component = record.factory(augmented, ansiTheme, {}, () => {}) as unknown as {
		render(w: number): string[];
		handleInput(data: string): void;
		focused: boolean;
	};
	return {
		render: component.render.bind(component),
		handleInput: component.handleInput!.bind(component),
		/** Set/clear the dialog focus flag exactly as the pi TUI does. */
		set focused(v: boolean) { component.focused = v; },
		get focused(): boolean { return component.focused; },
		/** setShowHardwareCursor call log (mock TUI records every call). */
		hardwareCursorCalls: () => [...state.setShowHardwareCursorCalls],
		/** Raw (unstripped) render lines, for CURSOR_MARKER inspection. */
		rawRender: (w = 100) => component.render(w),
	};
}

test("bounded agent question: every option is in the initial frame; question stays, scroll indicator gone", () => {
	// The reported repro shape: a long question + several options at a tight
	// bound. Options always render in full — the scroll viewport only remains
	// as a last resort for option blocks that alone exceed the terminal.
	const strip = (l: string) => l.replace(/\x1b\[[0-9;]*m/g, ""); // eslint-disable-line no-control-regex -- ANSI SGR matching
	const component = openQuestionnaireComponent({
		rows: 24,
		baseFrameLines: 19,
		questions: [{
			id: "scope",
			question: "Which definition of parity should the release goal adopt?",
			options: [
				"Preserve the no-execute product definition — SFIToolkit.stata and .error become the ONLY documented incompatibilities (exact vendor signatures + deterministic typed refusal + prominent docs)",
				"Full vendor parity — adopt execution semantics for SFIToolkit.stata and SFIToolkit.error even though they execute / terminate the process, matching the vendor module in full",
			],
			recommended: 0,
		}],
	});
	const top = component.render(100).map(strip);
	assert.ok(top.length <= 10, "dialog stays within the terminal-height bound");
	assert.ok(top.join("\n").includes("Which definition of parity should the release goal adopt?"), "question visible");
	assert.ok(top.join("\n").includes("1. Preserve the no-execute product definition"), "option 1 in the initial frame");
	assert.ok(top.join("\n").includes("2. Full vendor parity"), "option 2 in the initial frame");
	assert.ok(!top.join("\n").includes("PgUp/PgDn"), "no scroll affordance advertised");
	assert.ok(!top.join("\n").includes("more ·"), "no clipped-content indicator");
});

test("multi-question tabs: every option of each tab is in the initial frame", () => {
	const component = openQuestionnaireComponent({
		rows: 24,
		baseFrameLines: 19,
		questions: [
			{
				id: "scope",
				question: "First question with a long option list.",
				options: [
					"Scope option A — with a very long label that wraps across several lines of the bounded dialog window",
					"Scope option B — another long wrapped label so the options exceed the dialog height and force scrolling",
					"Scope option C — still more wrapped text below the fold",
				],
				recommended: 0,
			},
			{
				id: "span",
				question: "Second question, also long.",
				options: [
					"Span option 1",
					"Span option 2",
				],
				recommended: 1,
			},
		],
	});
	// Question 1: all three options + the custom row in the first view.
	const q1 = component.render(100).join("\n");
	assert.ok(q1.includes("Scope option A"), "question 1 option A in the initial frame");
	assert.ok(q1.includes("Scope option B"), "question 1 option B in the initial frame");
	assert.ok(q1.includes("Scope option C"), "question 1 option C in the initial frame");
	assert.ok(q1.includes("Write your own answer"), "custom row in the initial frame");
	assert.ok(!q1.includes("PgUp/PgDn"), "no scroll affordance on question 1");

	// Switch to question 2: fresh tab, all options visible.
	component.handleInput!(TAB_KEY);
	const q2 = component.render(100).join("\n");
	assert.ok(q2.includes("Second question, also long."), "question 2 opens from the top");
	assert.ok(q2.includes("Span option 1"), "question 2 option 1 in the initial frame");
	assert.ok(q2.includes("Span option 2"), "question 2 option 2 in the initial frame");
	assert.ok(!q2.includes("▲ "), "no stale scroll position on the new tab");
});

test("overflow: question/context yields before options; dialog never exceeds the bound", () => {
	const strip = (l: string) => l.replace(/\x1b\[[0-9;]*m/g, ""); // eslint-disable-line no-control-regex -- ANSI SGR matching
	const component = openQuestionnaireComponent({
		rows: 24,
		baseFrameLines: 19,
		questions: [{
			id: "q",
			question: "This question is deliberately long and wraps across several lines to simulate a verbose prompt.",
			context: "Context one.\nContext two.\nContext three.\nContext four.\nContext five.",
			options: ["Alpha", "Beta", "Gamma"],
		}],
	});
	const view = component.render(100).map(strip).join("\n");
	assert.ok(component.render(100).length <= 10, "dialog never exceeds the bound");
	for (const opt of ["1. Alpha", "2. Beta", "3. Gamma", "Write your own answer"]) {
		assert.ok(view.includes(opt), `${opt} stays in frame on overflow`);
	}
	assert.ok(view.includes("This question is deliberately long"), "question kept while context yields");
	assert.ok(!view.includes("Context five"), "context gives way first (later context lines drop before any option)");
	assert.ok(!view.includes("PgUp/PgDn"), "no scroll affordance for realistic overflow");
});

test("pathological: an option block that alone exceeds the bound falls back to the scroll viewport", () => {
	const strip = (l: string) => l.replace(/\x1b\[[0-9;]*m/g, ""); // eslint-disable-line no-control-regex -- ANSI SGR matching
	const component = openQuestionnaireComponent({
		rows: 24,
		baseFrameLines: 19,
		questions: [{
			id: "q",
			question: "Many options.",
			options: Array.from({ length: 12 }, (_, i) => `Option number ${i + 1}`),
		}],
	});
	const top = component.render(100).map(strip);
	assert.ok(top.length <= 10, "bound preserved under the viewport fallback");
	assert.ok(top.join("\n").includes("PgUp/PgDn"), "fallback advertises the scroll affordance");
	component.handleInput!(PAGE_DOWN);
	const scrolled = component.render(100).map(strip).join("\n");
	assert.match(scrolled, /Option number 1[0-2]/, "later options reachable via the fallback viewport");
});

test("selection stays visible with all options in frame: ↓ moves the marker, nothing scrolls", () => {
	const strip = (l: string) => l.replace(/\x1b\[[0-9;]*m/g, ""); // eslint-disable-line no-control-regex -- ANSI SGR matching
	const component = openQuestionnaireComponent({
		rows: 24,
		baseFrameLines: 19,
		questions: [{
			id: "q",
			question: "Pick one — every option is immediately viewable.",
			options: [
				"Option one — short",
				"Option two — short",
				"Option three — short",
				"Option four — short",
				"Option five — short",
				"Option six — short",
			],
			recommended: 0,
		}],
	});
	const initial = component.render(100).map(strip).join("\n");
	for (const label of ["1. Option one", "2. Option two", "3. Option three", "4. Option four", "5. Option five", "6. Option six", "Write your own answer"]) {
		assert.ok(initial.includes(label), `${label} in the initial frame`);
	}
	assert.ok(!initial.includes("PgUp/PgDn"), "no scroll affordance");
	// ↓ walks the selection; the marker moves but every option stays on screen.
	component.handleInput!(ARROW_DOWN);
	component.handleInput!(ARROW_DOWN);
	component.handleInput!(ARROW_DOWN);
	component.handleInput!(ARROW_DOWN);
	const view = component.render(100).map(strip).join("\n");
	assert.ok(view.includes("> 5. Option five"), "selection marker on the fifth option");
	assert.ok(view.includes("Option six"), "later option still in frame");
	assert.ok(component.render(100).length <= 10, "bound preserved");
});

test("input mode keeps the editor visible when bounded (tail-keep unchanged)", () => {
	const strip = (l: string) => l.replace(/\x1b\[[0-9;]*m/g, ""); // eslint-disable-line no-control-regex -- ANSI SGR matching
	const component = openQuestionnaireComponent({
		rows: 24,
		baseFrameLines: 19,
		questions: [{
			id: "q",
			question: "Type your answer below the option hints.",
			options: [
				"Option one — with a long wrapped label that pushes the option hints far up the dialog",
				"Option two — with an equally long wrapped label for the hint block",
			],
		}],
	});
	// Enter on the custom option enters input mode.
	component.handleInput!(ARROW_DOWN);
	component.handleInput!(ARROW_DOWN);
	component.handleInput!(ENTER_KEY);
	const view = component.render(100).map(strip).join("\n");
	assert.ok(view.includes("Your answer:"), "editor prompt visible");
	assert.ok(view.includes("Enter to submit"), "editor submit hint visible");
	assert.ok(component.render(100).length <= 10, "input-mode dialog stays within the bound");
});

// ── Custom-answer input acceptance (specs/2026-08-09-questionnaire-custom-answers-and-options) ─
// The dialog must anchor the answer editor for text input: Focusable
// propagation (CURSOR_MARKER emitted by the Editor when focused) and the
// hardware cursor on while typing, off otherwise (pi docs/tui.md).

const CURSOR_MARKER = "\u001B_pi:c\u0007";

test("input mode: Editor emits CURSOR_MARKER and hardware cursor is on while typing", () => {
	const component = openQuestionnaireComponent({
		rows: 24,
		baseFrameLines: 19,
		questions: [{
			id: "q",
			question: "Pick or write your answer",
			options: ["Alpha", "Beta", "Gamma"],
		}],
	});
	// pi TUI sets focused=true when the custom dialog gains focus.
	component.focused = true;
	// Select-mode: cursor stays off even though the dialog is focused.
	assert.ok(component.hardwareCursorCalls().every((v) => v === false), "hardware cursor off in select mode");
	component.handleInput!(ARROW_DOWN);
	component.handleInput!(ARROW_DOWN);
	component.handleInput!(ARROW_DOWN);
	component.handleInput!(ENTER_KEY); // "Write your own answer..."
	const calls = component.hardwareCursorCalls();
	assert.equal(calls[calls.length - 1], true, "hardware cursor enabled on entering input mode");
	const markerLines = component.rawRender(100).filter((l) => l.includes(CURSOR_MARKER));
	assert.equal(markerLines.length, 1, "Editor emits CURSOR_MARKER at the cursor position when focused");
	// ASCII typing lands in the editor.
	for (const ch of "hello") component.handleInput!(ch);
	const strip = (l: string) => l.replace(/\x1b\[[0-9;]*m/g, ""); // eslint-disable-line no-control-regex -- ANSI SGR matching
	assert.ok(component.render(100).map(strip).join("\n").includes("hello"), "typed text lands in the editor");
	// IME-style composed text (e.g. CJK) also lands once focus is anchored.
	for (const ch of "我的答案") component.handleInput!(ch);
	assert.ok(component.render(100).map(strip).join("\n").includes("我的答案"), "composed text lands in the editor");
	// Esc leaves input mode and releases the cursor.
	component.handleInput!(ESC_KEY);
	const afterEsc = component.hardwareCursorCalls();
	assert.equal(afterEsc[afterEsc.length - 1], false, "hardware cursor off after leaving input mode");
});

test("custom answer flows to the summary as (wrote) and Enter submits it", () => {
	const strip = (l: string) => l.replace(/\x1b\[[0-9;]*m/g, ""); // eslint-disable-line no-control-regex -- ANSI SGR matching
	const component = openQuestionnaireComponent({
		rows: 24,
		baseFrameLines: 19,
		questions: [
			{ id: "q1", question: "First question", options: ["A1", "A2"] },
			{ id: "q2", question: "Second question", options: ["B1", "B2"] },
		],
	});
	component.focused = true;
	component.handleInput!(ARROW_DOWN);
	component.handleInput!(ARROW_DOWN);
	component.handleInput!(ENTER_KEY); // "Write your own answer..." on q1
	for (const ch of "my custom answer") component.handleInput!(ch);
	component.handleInput!(ENTER_KEY); // submit the custom answer → q2
	component.handleInput!(TAB_KEY); // to the submit summary tab
	const view = component.render(100).map(strip).join("\n");
	assert.ok(view.includes("Ready to submit"), "submit summary shown");
	assert.ok(view.includes("(wrote) my custom answer"), "custom answer recorded as (wrote) in the summary");
});

// ── Hosts with a UI that cannot render TUI components ───────────────────
// A host embedding pi behind a non-terminal UI installs a real UI context, so
// `ctx.hasUI` is true, while `ui.custom` stays the SDK's headless default
// (`async () => undefined`). Every drafting tool used to crash there with
// "Cannot read properties of undefined (reading 'cancelled')".

function nonTerminalUiContext() {
	return { hasUI: true, cwd: "/test", ui: { custom: async () => undefined } } as unknown as Parameters<typeof runGoalQuestionnaire>[0];
}

test("runGoalQuestionnaire reports an unavailable dialog instead of dereferencing undefined", async () => {
	const result = await runGoalQuestionnaire(nonTerminalUiContext(), [{ id: "q", question: "Scope?", options: ["A", "B"] }]);
	assert.deepEqual(result, { questions: [], answers: [], cancelled: true, unavailable: true });
});

// A host with a non-terminal UI implements the same confirm/select/input
// contract; only `custom` is terminal-only. Drafting degrades onto those.

function browserLikeUiContext(script: { picks?: (string | undefined)[]; typed?: string }) {
	const picks = [...(script.picks ?? [])];
	const prompts: string[] = [];
	const ctx = {
		hasUI: true,
		cwd: "/test",
		ui: {
			custom: async () => undefined,
			select: async (title: string, options: string[]) => { prompts.push(title); return picks.length > 0 ? picks.shift() : options[0]; },
			input: async (title: string) => { prompts.push(title); return script.typed; },
		},
	} as unknown as Parameters<typeof runGoalQuestionnaire>[0];
	return { ctx, prompts };
}

test("drafting degrades onto select/input where only ui.custom is missing", async () => {
	const { ctx, prompts } = browserLikeUiContext({ picks: ["B"] });
	const result = await runGoalQuestionnaire(ctx, [{ id: "scope", question: "Scope?", context: "Pick one", options: ["A", "B"] }]);
	assert.equal(result.cancelled, false);
	assert.equal(result.unavailable, undefined);
	assert.deepEqual(result.answers, [{ id: "scope", question: "Scope?", answer: "B", wasCustom: false }]);
	// Context is part of the question the host shows, not decoration dropped on
	// the way: a proposal is unreadable without it.
	assert.match(prompts[0] ?? "", /Scope\?[\s\S]*Pick one/);
});

test("the proposal dialog is answerable through plain select on such a host", async () => {
	const { ctx, prompts } = browserLikeUiContext({ picks: ["Confirm — create this goal now"] });
	assert.deepEqual(await showProposalDialog(ctx, "OBJECTIVE\n\nTasks:\n1. one", "goal", true), { decision: "confirm", auditorEnabled: true, unavailable: false });
	assert.match(prompts[0] ?? "", /Confirm Goal Draft[\s\S]*OBJECTIVE[\s\S]*1\. one/);
});

test("a free-text question falls back to input, and a dismissed dialog cancels", async () => {
	const typed = await runGoalQuestionnaire(browserLikeUiContext({ typed: "my own words" }).ctx, [{ id: "notes", question: "Notes?", options: [] }]);
	assert.deepEqual(typed.answers, [{ id: "notes", question: "Notes?", answer: "my own words", wasCustom: true }]);
	const dismissed = await runGoalQuestionnaire(browserLikeUiContext({ picks: [undefined] }).ctx, [{ id: "scope", question: "Scope?", options: ["A"] }]);
	assert.equal(dismissed.cancelled, true);
	// Partial answers must not be presented as a finished questionnaire.
	assert.deepEqual(dismissed.answers, []);
});

test("showProposalDialog survives a host whose ui.custom resolves to undefined", async () => {
	const decision = await showProposalDialog(nonTerminalUiContext(), "objective", "goal", true);
	assert.deepEqual(decision, { decision: "continue", auditorEnabled: true, unavailable: true });
});

test("a dialog the host never rendered is not reported as a user decision", async () => {
	const cancelledByUser = proposalDecisionFromQuestionnaireResult({ cancelled: true, answer: undefined });
	assert.equal(cancelledByUser, "continue");
	// Same decision, different cause: only `unavailable` distinguishes "the user
	// pressed escape" from "no dialog was ever shown", which is what lets the
	// drafting tools explain themselves instead of claiming a cancellation.
	const result = await runGoalQuestionnaire(nonTerminalUiContext(), [{ id: "q", question: "Scope?", options: [] }]);
	assert.equal(result.unavailable, true);
	assert.match(DIALOG_UNAVAILABLE_HINT, /PI_GOAL_AUTO_CONFIRM=1/);
});
