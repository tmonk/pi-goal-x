/**
 * Unified dashboard renderer (plan §5, §4).
 *
 * Renders the shared dashboard view model (goal-dashboard-model.ts) as the
 * compact above-editor widget, the expanded full dashboard (which replaces the
 * task overlay), and the unfocused panel. Pure presentation: all data comes
 * from the model; this file owns the §5 visual spec (borders, status symbols,
 * progress bars, responsive layouts, width-safe ANSI/Unicode handling) and
 * must never emit a line wider than the requested terminal width.
 *
 * Layout modes (§5.5): wide ≥100, medium 70–99, narrow 50–69, minimal <50.
 */

import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import {
	anchoredScrollOffset,
	compactTaskViewportRows,
	deriveTaskListViewport,
	formatAuditElapsed,
	formatBudget,
	type DashboardStatusCode,
	type DashboardTaskNode,
	type GoalDashboardModel,
	type TaskListViewport,
} from "./goal-dashboard-model.ts";
import type { GoalActivityItem } from "../goal-activity.ts";
import { truncateText } from "../goal-core.ts";
import { DEFAULT_GOAL_KEYBINDINGS, formatGoalKeybinding, type GoalDashboardKeybindings } from "../goal-settings.ts";

// mdLink is deliberately excluded: the chrome must stay neutral gray, not
// blue-tinged ("more grey than blue").
type RenderColor = Extract<ThemeColor, "accent" | "warning" | "success" | "error" | "dim" | "muted" | "text" | "mdHeading">;

// ── §5.1 border system ──────────────────────────────────────────────────────

const H = "─";
const V = "│";

/** Box chrome: the entire frame — corners, top/bottom dashes, left/right
 * edges and interior rules — is one tone: the theme's neutral gray (muted).
 * No blue tinge: the chrome is grey, while the content inside is
 * colour-coded. */
function frame(theme: Theme, value: string): string {
	return theme.fg("muted", value);
}

function fit(value: string, width: number): string {
	return visibleWidth(value) > width ? truncateToWidth(value, width, "…") : value;
}

function boxHeader(theme: Theme, width: number, left: string, right = ""): string {
	const inner = Math.max(4, width - 2);
	// One-tone frame line: corners, leading/trailing dashes and fill all carry
	// the frame color; only the brand inside stays accent.
	const l = `${frame(theme, H)} ${left}`;
	const r = right ? ` ${right} ${frame(theme, H)}` : "";
	const fixed = visibleWidth(l) + visibleWidth(r);
	if (fixed > inner - 2) {
		// Too tight: truncate the title so the right-side meta survives.
		const budget = Math.max(4, inner - visibleWidth(r) - 4);
		const l2 = `${frame(theme, H)} ${fit(left, budget)}`;
		const fill = Math.max(1, inner - visibleWidth(l2) - visibleWidth(r));
		return `${frame(theme, "╭")}${l2}${frame(theme, H.repeat(fill))}${r}${frame(theme, "╮")}`;
	}
	const fill = Math.max(1, inner - fixed);
	return `${frame(theme, "╭")}${l}${frame(theme, H.repeat(fill))}${r}${frame(theme, "╮")}`;
}

function boxLine(theme: Theme, width: number, content: string): string {
	const inner = Math.max(2, width - 2);
	const contentFit = fit(content, inner - 1);
	const pad = Math.max(0, inner - 1 - visibleWidth(contentFit));
	return `${frame(theme, V)} ${contentFit}${" ".repeat(pad)}${frame(theme, V)}`;
}

function boxRule(theme: Theme, width: number): string {
	return frame(theme, `├${H.repeat(Math.max(1, width - 2))}┤`);
}

/** Section separator with a label and optional right-side content:
 * `├─ Tasks ──── [████░] · Sub 2/3 [██░░] ┤` (§5.1). The right content
 * (e.g. the header progress bars) always survives; the label truncates when
 * tight. Hardened so label + right never exceed the inner width: the fill is
 * `max(0, …)` and the truncation budget leaves room for the `─ ` prefix and
 * trailing space. */
function boxSectionRule(theme: Theme, width: number, label: string, right = ""): string {
	const inner = Math.max(4, width - 2);
	const left = frame(theme, `${H} ${label} `);
	const r = right ? ` ${right} ` : "";
	let l = left;
	if (visibleWidth(left) + visibleWidth(r) > inner) {
		const budget = Math.max(4, inner - visibleWidth(r) - 3);
		l = frame(theme, `${H} ${fit(label, budget)} `);
	}
	const fill = Math.max(0, inner - visibleWidth(l) - visibleWidth(r));
	return `${frame(theme, "├")}${l}${frame(theme, H.repeat(fill))}${r}${frame(theme, "┤")}`;
}

function boxFooter(theme: Theme, width: number, content: string, right = ""): string {
	const inner = Math.max(4, width - 2);
	// Optional right slot mirrors boxHeader's right-meta treatment (` ● ─`
	// before the corner), so the auditor dot sits at the bottom-right of the
	// border. The dot survives; the hint (left content) truncates when tight.
	const r = right ? ` ${right} ${frame(theme, H)}` : "";
	if (!content && !r) {
		return frame(theme, `╰${H.repeat(inner)}╯`);
	}
	// The footer is one frame tone: leading dash, hint text and trailing fill
	// all carry the frame color, so the blue-gray spans the whole line.
	const l = content ? frame(theme, `${H} ${fit(content, Math.max(0, inner - 4 - visibleWidth(r)))}`) : "";
	const fill = Math.max(1, inner - visibleWidth(l) - visibleWidth(r));
	return `${frame(theme, "╰")}${l}${frame(theme, H.repeat(fill))}${r}${frame(theme, "╯")}`;
}

// ── §5.2 status colors ──────────────────────────────────────────────────────

const STATUS_COLOR: Record<DashboardStatusCode, RenderColor> = {
	running: "accent",
	idle: "muted",
	paused: "muted",
	blocked: "error",
	budget_limited: "mdHeading",
	complete: "success",
};

/**
 * Widget status line — footer-status parity: `goal: <label> [<usage>] (+N open)`.
 * Same terminology/format as the pi footer status line (goal-core statusLabel +
 * usage bracket), without the objective preview (the header title shows it) and
 * without the old `Focused: yes` / `Other goals: N` bits. The open-goals count
 * appears only when other open goals exist.
 */
function statusLine(theme: Theme, model: GoalDashboardModel): string {
	const color = STATUS_COLOR[model.status.code];
	const usage = model.usage.footerBits ? ` [${model.usage.footerBits}]` : "";
	const open = model.otherOpenGoals > 0 ? ` (+${model.otherOpenGoals} open)` : "";
	return `${theme.fg(color, `goal: ${model.status.footerLabel}`)}${muted(theme, `${usage}${open}`)}`;
}

// ── §5.3 progress bars ──────────────────────────────────────────────────────

function progressBar(theme: Theme, pct: number, barWidth: number): string {
	const safeBar = Math.max(2, barWidth);
	const filled = Math.min(safeBar, Math.max(0, Math.round((pct / 100) * safeBar)));
	// The bar is muted like the rest of the progress info: neutral-gray fill
	// with dim empty cells — no accent teal anywhere in the progress element.
	return `[${theme.fg("muted", "█".repeat(filled))}${theme.fg("dim", "░".repeat(safeBar - filled))}]`;
}

// ── Layout modes (§5.5) ─────────────────────────────────────────────────────

type LayoutMode = "wide" | "medium" | "narrow" | "minimal";

function layoutMode(width: number): LayoutMode {
	if (width >= 100) return "wide";
	if (width >= 70) return "medium";
	if (width >= 50) return "narrow";
	return "minimal";
}

interface LayoutSpec {
	barWidth: number;
	/** Compact progress bar width inside the Tasks header row (bar at the end). */
	headerBarWidth: number;
	/** Subtask progress bar width inside the Tasks header row, beside the task
	 * bar (wide/medium/narrow; minimal omits the segment — unused there). */
	subtaskBarWidth: number;
	showPath: boolean;
	showPauseAction: boolean;
	footerHint: string;
}

function specFor(mode: LayoutMode): LayoutSpec {
	switch (mode) {
		case "wide":
			return { barWidth: 26, headerBarWidth: 8, subtaskBarWidth: 4, showPath: true, showPauseAction: true, footerHint: "Ctrl+Shift+T: expand tasks" };
		case "medium":
			return { barWidth: 18, headerBarWidth: 6, subtaskBarWidth: 3, showPath: true, showPauseAction: true, footerHint: "Ctrl+Shift+T: expand tasks" };
		case "narrow":
			return { barWidth: 12, headerBarWidth: 5, subtaskBarWidth: 2, showPath: false, showPauseAction: false, footerHint: "Ctrl+Shift+T: expand" };
		case "minimal":
			return { barWidth: 8, headerBarWidth: 4, subtaskBarWidth: 2, showPath: false, showPauseAction: false, footerHint: "Ctrl+Shift+T: expand" };
	}
}

// ── shared row helpers ──────────────────────────────────────────────────────

function muted(theme: Theme, value: string): string {
	return theme.fg("muted", value);
}

function dim(theme: Theme, value: string): string {
	return theme.fg("dim", value);
}

function accent(theme: Theme, value: string): string {
	return theme.fg("accent", value);
}

function success(theme: Theme, value: string): string {
	return theme.fg("success", value);
}

/** Pastel accent helpers (§5): amber for tasks, teal for current/progress,
 * muted gray for chrome, soft red for blockers, muted green for complete. */
function amber(theme: Theme, value: string): string {
	return theme.fg("mdHeading", value);
}

// ── task tree rows (§9.2) ───────────────────────────────────────────────────

/** Task rows: pending amber ·, complete muted-green ✓, skipped gray ~, and
 * the current task teal ▸ with accent text; row text is pastel amber. */
function taskMarker(node: DashboardTaskNode): { symbol: string; color: RenderColor } {
	if (node.isCurrent) return { symbol: "▸", color: "accent" };
	if (node.status === "complete") return { symbol: "✓", color: "success" };
	if (node.status === "skipped") return { symbol: "~", color: "muted" };
	return { symbol: "·", color: "mdHeading" };
}

function renderTaskRow(theme: Theme, node: DashboardTaskNode, indent: number, available: number): string {
	const marker = taskMarker(node);
	const indentText = "  ".repeat(indent);
	const prefix = `${indentText}${marker.symbol} ${node.id}  `;
	const contractMark = node.verificationContract ? dim(theme, " ☑") : "";
	const titleBudget = Math.max(4, available - visibleWidth(prefix) - visibleWidth(contractMark));
	const title = fit(node.title, titleBudget);
	const markerText = theme.fg(marker.color, marker.symbol);
	// Colour-coded: the id shares the marker color (amber pending, green
	// complete, gray skipped, teal current); titles stay amber, the current
	// task is fully accent.
	const idText = node.isCurrent ? accent(theme, node.id) : theme.fg(marker.color, node.id);
	const titleText = node.isCurrent ? accent(theme, title) : amber(theme, title);
	return `${indentText}${markerText} ${idText}  ${titleText}${contractMark}`;
}

/**
 * Compact task-list rows (§9.2, §9.6): top-level tasks shown in a window over
 * the plan-ordered list with colored markers and truncated titles, an aligned
 * id column, and `↑ N more` / `… +N more` indicator rows so the widget height
 * stays bounded. The window is a viewport (offset + rows) derived from the
 * shared model — the default (anchored) offset is computed by the caller when
 * no explicit offset is given.
 */
function renderCompactTaskRows(theme: Theme, nodes: DashboardTaskNode[], viewport: TaskListViewport, available: number): string[] {
	const rows: string[] = [];
	if (viewport.hiddenAbove > 0) {
		rows.push(muted(theme, `↑ ${viewport.hiddenAbove} more task${viewport.hiddenAbove === 1 ? "" : "s"}`));
	}
	const shown = nodes.slice(viewport.offset, viewport.offset + viewport.rows);
	const idWidth = shown.length === 0 ? 0 : Math.min(10, Math.max(...shown.map((node) => node.id.length)));
	for (const node of shown) {
		const marker = taskMarker(node);
		const contractMark = node.verificationContract ? dim(theme, " ☑") : "";
		// §9.3 compact subtask marker: direct-child done/total for tasks that
		// have subtasks, muted so it stays annotation — the current-task bar
		// below carries the visual weight.
		const subtaskMark = node.totalSubtasks > 0 ? muted(theme, ` ▸ ${node.completedSubtasks}/${node.totalSubtasks}`) : "";
		const id = node.id.padEnd(idWidth);
		const prefix = `${marker.symbol} ${id}  `;
		const titleBudget = Math.max(4, available - visibleWidth(prefix) - visibleWidth(contractMark) - visibleWidth(subtaskMark));
		const title = fit(node.title, titleBudget);
		const markerText = theme.fg(marker.color, marker.symbol);
		// Colour-coded: id shares the marker color; titles amber; current accent.
		const idText = node.isCurrent ? accent(theme, id) : theme.fg(marker.color, id);
		const body = node.isCurrent ? accent(theme, title) : amber(theme, title);
		rows.push(`${markerText} ${idText}  ${body}${contractMark}${subtaskMark}`);
	}
	if (viewport.hiddenBelow > 0) {
		rows.push(muted(theme, `… +${viewport.hiddenBelow} more task${viewport.hiddenBelow === 1 ? "" : "s"}`));
	}
	return rows;
}

// ── activity rows ───────────────────────────────────────────────────────────

function activityMarker(item: GoalActivityItem): { symbol: string; color: RenderColor } {
	if (item.marker === "done") return { symbol: "✓", color: "success" };
	if (item.marker === "current") return { symbol: "▸", color: "accent" };
	if (item.marker === "skipped") return { symbol: "~", color: "mdHeading" };
	return { symbol: "·", color: "muted" };
}

// ── COMPACT DASHBOARD (§4.1) ────────────────────────────────────────────────

/**
 * Persistent summary above the editor while a goal is focused. Visually rich
 * but compact; the footer hints at the expansion shortcut.
 */
export function renderCompactDashboard(
	model: GoalDashboardModel,
	theme: Theme,
	width: number,
	opts: { footerHint?: string; scrollOffset?: number; keybindings?: GoalDashboardKeybindings } = {},
): string[] {
	const safeWidth = Math.max(10, width);
	const mode = layoutMode(safeWidth);
	const spec = specFor(mode);
	const inner = safeWidth - 2;
	const lines: string[] = [];

	lines.push(boxHeader(theme, safeWidth, `${accent(theme, "pi-goal-x")} ${frame(theme, `─ ${model.title}`)}`));

	// Status line.
	if (model.status.code === "complete") {
		lines.push(boxLine(theme, safeWidth, `${success(theme, "✓")} ${success(theme, "All required work is complete.")}`));
	} else {
		lines.push(boxLine(theme, safeWidth, statusLine(theme, model)));
	}

	// Budget (when configured): fuel gauge + amount, amber until the budget is
	// exhausted, then soft red.
	if (model.budget) {
		const fuel = model.budget.used >= model.budget.total ? "error" : "mdHeading";
		lines.push(boxLine(theme, safeWidth, `${theme.fg(fuel as RenderColor, "⛽")} ${muted(theme, "Budget")} ${theme.fg(fuel as RenderColor, formatBudget(model.budget.used, model.budget.total))}`));
	}

	// §auditor-toggle: the focused goal's independent-auditor status is the
	// bottom-right border dot (green on / muted gray off, see the footer
	// below); wide/medium footers right-align a note next to it explaining
	// that Ctrl+Shift+A turns the auditor on and off.

	// §9.1 compact task counts + progress bars live in the Tasks header row
	// (below); the standalone progress lines were removed in favor of it.

	// §9.2/§9.6 compact task list: a window over the top-level tasks, anchored
	// by default so the most recently completed tasks are visible; when the
	// list overflows the window, the footer advertises Ctrl+Shift+↑↓ to scroll
	// it. The current task's subtask progress lives in the header segment, and
	// per-row subtask markers show which tasks have subtasks.
	const topLevel = model.taskTree.filter((node) => node.depth === 0);
	const compactRows = compactTaskViewportRows(safeWidth);
	const listOverflows = topLevel.length > compactRows;
	if (topLevel.length > 0) {
		const offset = opts.scrollOffset ?? anchoredScrollOffset(topLevel, compactRows);
		const viewport = deriveTaskListViewport(topLevel.length, compactRows, offset);
		// §9.1/§9.3 header row: counts first (`✓N done · M open`, skipped
		// counts as done), compact task progress bar, then the current task's
		// subtask progress bar beside it (` · Sub done/total `, wide/medium;
		// narrow drops the word `Sub` so the full counts fit at 50 cols;
		// minimal omits the segment — counts + task bar alone cannot share 38
		// inner columns with a second bar). All muted: the header stays one
		// frame-tone block. The standalone compact progress lines were removed
		// in favor of this row.
		const headerLabel = model.taskProgress
			? `Tasks · ✓${model.taskProgress.completed} done · ${model.taskProgress.total - model.taskProgress.completed} open`
			: "Tasks";
		let headerRight = model.taskProgress ? progressBar(theme, model.taskProgress.percentage, spec.headerBarWidth) : "";
		if (model.currentTask && model.currentTask.totalSubtasks > 0 && mode !== "minimal") {
			const subBar = progressBar(theme, model.currentTask.subtaskPercentage, spec.subtaskBarWidth);
			const subWord = mode === "narrow" ? "" : "Sub ";
			headerRight += `${muted(theme, ` · ${subWord}`)}${muted(theme, `${model.currentTask.completedSubtasks}/${model.currentTask.totalSubtasks}`)} ${subBar}`;
		}
		lines.push(boxSectionRule(theme, safeWidth, headerLabel, headerRight));
		for (const row of renderCompactTaskRows(theme, topLevel, viewport, inner)) {
			lines.push(boxLine(theme, safeWidth, row));
		}
	}

	// §9.4: all top-level tasks done and no current task → "All tasks complete".
	if (!model.currentTask && model.taskProgress && model.taskProgress.completed === model.taskProgress.total && model.status.code !== "complete") {
		lines.push(boxLine(theme, safeWidth, `${muted(theme, "Current")}  ${accent(theme, "All tasks complete")}`));
	}

	// Current task (persisted focus or inferred first pending).
	if (model.currentTask) {
		if (mode === "minimal") {
			lines.push(boxLine(theme, safeWidth, `${accent(theme, "▸")} ${accent(theme, fit(model.currentTask.title, inner - 3))}`));
		} else {
			const titleBudget = inner - visibleWidth(`Current  ${model.currentTask.id} · `);
			lines.push(boxLine(theme, safeWidth, `${muted(theme, "Current")}  ${accent(theme, model.currentTask.id)} · ${accent(theme, fit(model.currentTask.title, titleBudget))}`));
		}
	}

	// Current-task subtask progress moved into the Tasks header row (§9.3);
	// the standalone compact Subtasks progress line was removed. (The
	// expanded dashboard's Current-task block still shows it.)

	// Goal-level verification (§11.1): truncated first line in compact.
	if (model.goalVerificationContract && mode !== "minimal") {
		lines.push(boxLine(theme, safeWidth, `${muted(theme, "Verify")}   ${fit(model.goalVerificationContract.replace(/\s+/g, " "), inner - 9)}`));
	}

	// Blocked details (§4.5).
	if (model.status.code === "blocked") {
		if (model.status.reason) lines.push(boxLine(theme, safeWidth, `${theme.fg("error", "Blocker")}  ${muted(theme, fit(model.status.reason, inner - 10))}`));
		if (spec.showPauseAction && model.status.suggestedAction) lines.push(boxLine(theme, safeWidth, `${muted(theme, "Action")}   ${fit(model.status.suggestedAction, inner - 9)}`));
	}

	// Paused details (§4.4).
	if (model.status.code === "paused" && model.status.reason) {
		lines.push(boxLine(theme, safeWidth, `${muted(theme, "Reason")}   ${fit(model.status.reason, inner - 9)}`));
	}

	// File path (§4.1 example shows the active file).
	if (spec.showPath && model.filePath) {
		lines.push(boxLine(theme, safeWidth, `${dim(theme, `File     ${model.filePath}`)}`));
	}

	const keybindings = opts.keybindings ?? DEFAULT_GOAL_KEYBINDINGS.dashboard;
	const toggleShortcut = formatGoalKeybinding(keybindings.toggleExpand);
	const scrollShortcut = `${formatGoalKeybinding(keybindings.scrollUp)}/${formatGoalKeybinding(keybindings.scrollDown)}`;
	const usesDefaultScrollKeys = keybindings.scrollUp === DEFAULT_GOAL_KEYBINDINGS.dashboard.scrollUp && keybindings.scrollDown === DEFAULT_GOAL_KEYBINDINGS.dashboard.scrollDown;
	const scrollHint = usesDefaultScrollKeys
		? mode === "minimal" ? "↑↓" : "Ctrl+Shift+↑↓"
		: scrollShortcut;
	const expandHint = mode === "wide" || mode === "medium"
		? `${toggleShortcut}: expand tasks`
		: `${toggleShortcut}: expand`;
	const footerHint = opts.footerHint
		?? (listOverflows
			? mode === "wide" || mode === "medium"
				? `${toggleShortcut}: expand · ${scrollHint}: scroll`
				: `${scrollHint}: scroll`
			: expandHint);
	// The auditor dot sits at the bottom-right of the border: green when the
	// focused goal's independent auditor is on, muted gray when off. In
	// wide/medium a right-aligned note (same frame tone as the hint) explains
	// that Ctrl+Shift+A turns the auditor on and off; narrow/minimal keep
	// just the dot. The boxFooter right slot pushes both to the right edge,
	// so the chord and its note are right-aligned by construction.
	const auditorDot = model.auditorEnabled ? success(theme, "●") : muted(theme, "●");
	const right =
		mode === "wide" || mode === "medium"
			? `${frame(theme, "Ctrl+Shift+A: toggle auditor")} ${auditorDot}`
			: auditorDot;
	lines.push(boxFooter(theme, safeWidth, footerHint, right));
	return lines;
}

// ── EXPANDED DASHBOARD (§4.2) ───────────────────────────────────────────────

/**
 * The full dashboard: goal header, status, usage, progress, a window over the
 * task tree, current-task details with contract/evidence, verification, and
 * recent activity. Replaces the separate task overlay. The task-tree window
 * defaults to the whole tree; pass `rows` (and optionally `scrollOffset`) to
 * bound the panel for interactive scrolling — the default offset anchors to
 * the most recently completed task.
 */
export function renderExpandedDashboard(
	model: GoalDashboardModel,
	theme: Theme,
	width: number,
	opts: { scrollOffset?: number; rows?: number; keybindings?: GoalDashboardKeybindings } = {},
): string[] {
	const safeWidth = Math.max(10, width);
	const mode = layoutMode(safeWidth);
	const spec = specFor(mode);
	const inner = safeWidth - 2;
	const lines: string[] = [];

	lines.push(boxHeader(theme, safeWidth, `${accent(theme, "pi-goal-x")} ${frame(theme, `─ ${model.title}`)}`));

	lines.push(boxLine(theme, safeWidth, statusLine(theme, model)));

	if (spec.showPath && model.filePath) {
		lines.push(boxLine(theme, safeWidth, dim(theme, `File: ${model.filePath}`)));
	}
	if (model.budget) {
		lines.push(boxLine(theme, safeWidth, `${theme.fg("mdHeading", "⛽")} ${muted(theme, `Budget ${formatBudget(model.budget.used, model.budget.total)}`)}`));
	}

	// Progress section (§4.2).
	if (model.taskProgress) {
		lines.push(boxSectionRule(theme, safeWidth, "Progress"));
		const bar = progressBar(theme, model.taskProgress.percentage, Math.max(10, spec.barWidth + 8));
		lines.push(boxLine(theme, safeWidth, `${bar} ${muted(theme, `${model.taskProgress.completed}/${model.taskProgress.total} tasks · ${model.taskProgress.percentage}%`)}`));
	}

	// Tasks section: a window over the recursive tree (§9.2, §9.6). With no
	// explicit rows the whole tree is shown (backward compatible); with a row
	// budget the panel stays bounded and ↑/↓ keys move the window.
	if (model.taskTree.length > 0) {
		lines.push(boxSectionRule(theme, safeWidth, "Tasks"));
		const totalRows = model.taskTree.length;
		const rows = opts.rows ?? totalRows;
		const offset = opts.scrollOffset ?? anchoredScrollOffset(model.taskTree, rows);
		const viewport = deriveTaskListViewport(totalRows, rows, offset);
		if (viewport.hiddenAbove > 0) {
			lines.push(boxLine(theme, safeWidth, dim(theme, `↑ ${viewport.hiddenAbove} more task${viewport.hiddenAbove === 1 ? "" : "s"}`)));
		}
		for (const node of model.taskTree.slice(viewport.offset, viewport.offset + viewport.rows)) {
			const indent = Math.min(node.depth, 6);
			lines.push(boxLine(theme, safeWidth, renderTaskRow(theme, node, indent, inner)));
		}
		if (viewport.hiddenBelow > 0) {
			lines.push(boxLine(theme, safeWidth, dim(theme, `… +${viewport.hiddenBelow} more task${viewport.hiddenBelow === 1 ? "" : "s"}`)));
		}
	}

	// Current-task section (§4.2).
	if (model.currentTask) {
		lines.push(...renderCurrentTaskBlock(model, theme, safeWidth, spec.barWidth));
	}

	// Goal-level verification section (§11.1).
	if (model.goalVerificationContract) {
		lines.push(boxSectionRule(theme, safeWidth, "Verification"));
		lines.push(...wrappedBlock(theme, safeWidth, "", model.goalVerificationContract));
	}

	// Recent activity section (§12).
	if (model.recentActivity.length > 0) {
		lines.push(...renderActivityBlock(model.recentActivity, theme, safeWidth));
	}

	const toggleShortcut = formatGoalKeybinding(opts.keybindings?.toggleExpand ?? DEFAULT_GOAL_KEYBINDINGS.dashboard.toggleExpand);
	lines.push(boxFooter(theme, safeWidth, `Esc/${toggleShortcut}: collapse`));
	return lines;
}

/**
 * The current-task detail block (§4.2): title, subtask progress, contract,
 * evidence, and the inferred-focus note. Shared by the expanded dashboard and
 * the standard /goal-status output (§13.3).
 */
export function renderCurrentTaskBlock(
	model: GoalDashboardModel,
	theme: Theme,
	width: number,
	barWidth = 16,
): string[] {
	const safeWidth = Math.max(10, width);
	const inner = safeWidth - 2;
	const lines: string[] = [];
	lines.push(boxSectionRule(theme, safeWidth, "Current task"));
	lines.push(boxLine(theme, safeWidth, `${accent(theme, model.currentTask!.id)} · ${fit(model.currentTask!.title, inner - visibleWidth(`${model.currentTask!.id} · `))}`));
	if (model.currentTask!.totalSubtasks > 0) {
		const bar = progressBar(theme, model.currentTask!.subtaskPercentage, Math.max(8, barWidth));
		lines.push(boxLine(theme, safeWidth, `${muted(theme, "Subtasks")} ${bar} ${model.currentTask!.completedSubtasks}/${model.currentTask!.totalSubtasks} · ${model.currentTask!.subtaskPercentage}%`));
	}
	if (model.currentTask!.verificationContract) {
		lines.push(...wrappedBlock(theme, safeWidth, "Contract", model.currentTask!.verificationContract));
	}
	if (model.currentTask!.evidence) {
		lines.push(...wrappedBlock(theme, safeWidth, "Evidence", model.currentTask!.evidence));
	}
	if (model.currentTask!.inferred) {
		lines.push(boxLine(theme, safeWidth, dim(theme, "Inferred from the first pending task — no persisted current task.")));
	}
	return lines;
}

/** The recent-activity block (§12), shared by the expanded dashboard and /goal-status. */
export function renderActivityBlock(items: GoalActivityItem[], theme: Theme, width: number): string[] {
	const safeWidth = Math.max(10, width);
	const inner = safeWidth - 2;
	const lines: string[] = [];
	lines.push(boxSectionRule(theme, safeWidth, "Recent activity"));
	for (const item of items) {
		const marker = activityMarker(item);
		const text = fit(item.text, inner - 4);
		lines.push(boxLine(theme, safeWidth, `${theme.fg(marker.color, marker.symbol)} ${text}`));
	}
	return lines;
}

/** Wrap long contract/evidence text safely at the inner width (§11.1). */
function wrappedBlock(theme: Theme, width: number, label: string, text: string): string[] {
	const inner = Math.max(4, width - 2);
	const prefix = label ? `${label}: ` : "";
	const indent = " ".repeat(visibleWidth(prefix));
	const wrapped = wrapTextWithAnsi(text.replace(/\s+/g, " ").trim(), Math.max(8, inner - visibleWidth(prefix)));
	const lines: string[] = [];
	for (const [index, segment] of wrapped.entries()) {
		const content = index === 0 ? `${prefix}${segment}` : `${indent}${segment}`;
		lines.push(boxLine(theme, width, muted(theme, content)));
	}
	return lines;
}

// ── UNFOCUSED PANEL (§4.3) ──────────────────────────────────────────────────

/**
 * Shown when open goals exist but none is focused. The widget's default
 * no-goal branch renders nothing (surfaces without goals).
 */
export function renderUnfocusedDashboard(openGoalCount: number, theme: Theme, width: number): string[] {
	const safeWidth = Math.max(10, width);
	const lines: string[] = [];
	lines.push(boxHeader(theme, safeWidth, frame(theme, "pi-goal-x ─ Goal focus required")));
	const goals = openGoalCount === 1 ? "1 open goal is available." : `${openGoalCount} open goals are available.`;
	lines.push(boxLine(theme, safeWidth, muted(theme, goals)));
	lines.push(boxLine(theme, safeWidth, muted(theme, "Run /goal-focus to choose the goal for this session.")));
	lines.push(boxFooter(theme, safeWidth, ""));
	return lines;
}

// ── width safety net (defense in depth) ─────────────────────────────────────

/** Clamp every rendered line to the terminal width (used by the component). */
export function clampLinesToWidth(lines: string[], width: number): string[] {
	return lines.map((line) => (visibleWidth(line) > width ? truncateToWidth(line, width, "…") : line));
}

// ── AUDIT DASHBOARD (§15) ───────────────────────────────────────────────────

import type { AuditorDashboardModel, AuditResultCard } from "./auditor-dashboard-model.ts";

const CHECK_SYMBOL = { passed: "✓", running: "◌", pending: "·", failed: "✗" } as const;
const CHECK_COLOR = { passed: "success", running: "accent", pending: "muted", failed: "error" } as const;

/**
 * Structured audit dashboard (§15.3): five check stages, a progress bar, and
 * the elapsed duration, using the same visual system as the goal dashboard.
 * Raw tools and recent output appear only when showToolDetails is set
 * (expanded/debug audit mode) or when the audit finished with a failure.
 */
export function renderAuditorDashboard(
	model: AuditorDashboardModel,
	theme: Theme,
	width: number,
	opts: { showToolDetails?: boolean } = {},
): string[] {
	const safeWidth = Math.max(10, width);
	const inner = safeWidth - 2;
	const lines: string[] = [];
	const duration = formatAuditElapsed(model.elapsedMs);
	lines.push(boxHeader(theme, safeWidth, frame(theme, `Independent completion audit ─ ${model.auditorLabel}`), frame(theme, duration)));

	for (const check of model.checks) {
		const symbol = CHECK_SYMBOL[check.state];
		const color = CHECK_COLOR[check.state];
		lines.push(boxLine(theme, safeWidth, `${theme.fg(color as RenderColor, symbol)} ${check.label}`));
	}

	if (model.percentage !== undefined) {
		const barWidth = Math.max(8, Math.min(inner - 12, 30));
		const bar = progressBar(theme, model.percentage, barWidth);
		lines.push(boxLine(theme, safeWidth, `${bar} ${theme.fg("muted", `${model.percentage}%`)}`));
	}

	const showDiagnostics = opts.showToolDetails === true || model.verdict === "disapproved" || model.verdict === "error";
	if (showDiagnostics) {
		if (model.currentTool) {
			const args = model.currentToolArgs ? ` ${dim(theme, truncateText(model.currentToolArgs, Math.max(10, inner - 20)))}` : "";
			lines.push(boxLine(theme, safeWidth, `${accent(theme, "tool")} ${model.currentTool}${args}`));
		}
		if (model.recentOutput.length > 0) {
			lines.push(boxLine(theme, safeWidth, dim(theme, "─".repeat(Math.max(4, inner - 8)))));
			for (const output of model.recentOutput.slice(0, 3)) {
				lines.push(boxLine(theme, safeWidth, dim(theme, truncateText(output, Math.max(8, inner - 4)))));
			}
		}
	}

	lines.push(boxFooter(theme, safeWidth, model.active ? "Esc: stop audit" : ""));
	return lines;
}

/** Audit result card (§15.4): APPROVED or CHANGES REQUIRED / ERROR. */
export function renderAuditResultCard(card: AuditResultCard, theme: Theme, width: number): string[] {
	const safeWidth = Math.max(10, width);
	const inner = safeWidth - 2;
	const lines: string[] = [];
	const success = card.verdict === "approved";
	const accentColor = success ? "success" : "error";
	lines.push(boxHeader(theme, safeWidth, frame(theme, `Audit result ─ ${card.label}`)));
	for (const line of card.lines) {
		const symbol = success ? "✓" : "✗";
		lines.push(boxLine(theme, safeWidth, `${theme.fg(accentColor as RenderColor, symbol)} ${fit(line, inner - 4)}`));
	}
	lines.push(boxFooter(theme, safeWidth, ""));
	return lines;
}
