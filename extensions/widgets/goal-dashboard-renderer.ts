/**
 * Unified dashboard renderer.
 *
 * Renders the shared dashboard view model (goal-dashboard-model.ts) as the
 * compact above-editor widget, the expanded full dashboard (which replaces the
 * task overlay), and the unfocused panel. Pure presentation: all data comes
 * from the model, all line fitting comes from dashboard-box.ts, and no line is
 * ever wider than the requested terminal width.
 *
 * Both dashboards are a list of small section renderers that share one
 * signature, `(ctx) => string[]`, and are joined in order.
 *
 * Layout modes: wide >=100, medium 70-99, narrow 50-69, minimal <50.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { bindingKeys, commandHint, type GoalCommands, type GoalKeybinding } from "../goal-controls.ts";
import type { GoalActivityItem } from "../goal-activity.ts";
import { DEFAULT_GOAL_KEYBINDINGS, formatGoalKeybinding, type GoalDashboardKeybindings } from "../settings/schema.ts";
import {
	accent,
	amber,
	Box,
	dim,
	fit,
	frame,
	layoutMode,
	muted,
	progressBar,
	specFor,
	success,
	type LayoutMode,
	type LayoutSpec,
	type RenderColor,
} from "./dashboard-box.ts";
import { formatBudget } from "./dashboard-format.ts";
import type { DashboardStatusCode, DashboardTaskNode, GoalDashboardModel } from "./goal-dashboard-model.ts";
import { anchoredScrollOffset, compactTaskViewportRows, deriveTaskListViewport, type TaskListViewport } from "./task-viewport.ts";

export { clampLinesToWidth } from "./dashboard-box.ts";
export { renderAuditorDashboard, renderAuditResultCard } from "./goal-audit-renderer.ts";

// ── shared pieces ───────────────────────────────────────────────────────────

const STATUS_COLOR: Record<DashboardStatusCode, RenderColor> = {
	running: "accent",
	idle: "muted",
	paused: "muted",
	blocked: "error",
	budget_limited: "mdHeading",
	complete: "success",
};

/**
 * Widget status line, in step with the pi footer status:
 * `goal: <label> [<usage>] (+N open)`. No objective preview (the header title
 * shows it). The open-goals count appears only when other open goals exist.
 */
function statusLine(theme: Theme, model: GoalDashboardModel): string {
	const color = STATUS_COLOR[model.status.code];
	const usage = model.usage.footerBits ? ` [${model.usage.footerBits}]` : "";
	const open = model.otherOpenGoals > 0 ? ` (+${model.otherOpenGoals} open)` : "";
	return `${theme.fg(color, `goal: ${model.status.footerLabel}`)}${muted(theme, `${usage}${open}`)}`;
}

/** The `↑ N more tasks` row above a task window. */
function moreAboveText(hidden: number): string {
	return `↑ ${hidden} more task${hidden === 1 ? "" : "s"}`;
}

/** The `… +N more tasks` row below a task window. */
function moreBelowText(hidden: number): string {
	return `… +${hidden} more task${hidden === 1 ? "" : "s"}`;
}

/** Task rows: pending amber ·, complete green ✓, skipped gray ~, current teal ▸. */
function taskMarker(node: DashboardTaskNode): { symbol: string; color: RenderColor } {
	if (node.isCurrent) return { symbol: "▸", color: "accent" };
	if (node.status === "complete") return { symbol: "✓", color: "success" };
	if (node.status === "skipped") return { symbol: "~", color: "muted" };
	return { symbol: "·", color: "mdHeading" };
}

/** Marker, id and title of one task row; the id shares the marker colour and the current task is all accent. */
function coloredTaskParts(theme: Theme, node: DashboardTaskNode, id: string, title: string): { marker: string; id: string; title: string } {
	const marker = taskMarker(node);
	return {
		marker: theme.fg(marker.color, marker.symbol),
		id: node.isCurrent ? accent(theme, id) : theme.fg(marker.color, id),
		title: node.isCurrent ? accent(theme, title) : amber(theme, title),
	};
}

/** Expanded-tree row: indented by depth, with the contract mark after the title. */
function renderTaskRow(theme: Theme, node: DashboardTaskNode, indent: number, available: number): string {
	const marker = taskMarker(node);
	const indentText = "  ".repeat(indent);
	const prefix = `${indentText}${marker.symbol} ${node.id}  `;
	const contractMark = node.verificationContract ? dim(theme, " ☑") : "";
	const titleBudget = Math.max(4, available - visibleWidth(prefix) - visibleWidth(contractMark));
	const parts = coloredTaskParts(theme, node, node.id, fit(node.title, titleBudget));
	return `${indentText}${parts.marker} ${parts.id}  ${parts.title}${contractMark}`;
}

/**
 * Compact task rows: a window over the top-level tasks with an aligned id
 * column and `↑ N more` / `… +N more` rows, so the widget height stays bounded.
 */
function renderCompactTaskRows(theme: Theme, nodes: DashboardTaskNode[], viewport: TaskListViewport, available: number): string[] {
	const rows: string[] = [];
	if (viewport.hiddenAbove > 0) rows.push(muted(theme, moreAboveText(viewport.hiddenAbove)));
	const shown = nodes.slice(viewport.offset, viewport.offset + viewport.rows);
	const idWidth = shown.length === 0 ? 0 : Math.min(10, Math.max(...shown.map((node) => node.id.length)));
	for (const node of shown) {
		const contractMark = node.verificationContract ? dim(theme, " ☑") : "";
		// Direct-child done/total for tasks that have subtasks, muted so it
		// stays an annotation; the Tasks header carries the visual weight.
		const subtaskMark = node.totalSubtasks > 0 ? muted(theme, ` ▸ ${node.completedSubtasks}/${node.totalSubtasks}`) : "";
		const id = node.id.padEnd(idWidth);
		const prefix = `${taskMarker(node).symbol} ${id}  `;
		const titleBudget = Math.max(4, available - visibleWidth(prefix) - visibleWidth(contractMark) - visibleWidth(subtaskMark));
		const parts = coloredTaskParts(theme, node, id, fit(node.title, titleBudget));
		rows.push(`${parts.marker} ${parts.id}  ${parts.title}${contractMark}${subtaskMark}`);
	}
	if (viewport.hiddenBelow > 0) rows.push(muted(theme, moreBelowText(viewport.hiddenBelow)));
	return rows;
}

function activityMarker(item: GoalActivityItem): { symbol: string; color: RenderColor } {
	if (item.marker === "done") return { symbol: "✓", color: "success" };
	if (item.marker === "current") return { symbol: "▸", color: "accent" };
	if (item.marker === "skipped") return { symbol: "~", color: "mdHeading" };
	return { symbol: "·", color: "muted" };
}

// ── section plumbing ────────────────────────────────────────────────────────

interface SectionContext<Opts> {
	model: GoalDashboardModel;
	theme: Theme;
	box: Box;
	mode: LayoutMode;
	spec: LayoutSpec;
	opts: Opts;
}

/** One block of dashboard rows. Returns nothing (an empty list) when it does not apply. */
type Section<Ctx> = (ctx: Ctx) => string[];

function runSections<Ctx>(ctx: Ctx, sections: Array<Section<Ctx>>): string[] {
	return sections.flatMap((section) => section(ctx));
}

function makeContext<Opts>(model: GoalDashboardModel, theme: Theme, width: number, opts: Opts): SectionContext<Opts> {
	const box = new Box(theme, width);
	const mode = layoutMode(box.width);
	return { model, theme, box, mode, spec: specFor(mode), opts };
}

function titleHeader({ box, theme, model }: SectionContext<unknown>): string[] {
	return [box.header(`${accent(theme, "pi-goal-x")} ${frame(theme, `─ ${model.title}`)}`)];
}

function verificationSection({ box, model }: SectionContext<unknown>): string[] {
	if (!model.goalVerificationContract) return [];
	return [box.rule("Verification"), ...box.wrapped("", model.goalVerificationContract)];
}

// ── compact dashboard ───────────────────────────────────────────────────────

interface CompactOptions {
	footerHint?: string;
	scrollOffset?: number;
	keybindings?: GoalDashboardKeybindings;
	auditorKey?: GoalKeybinding;
}

interface CompactContext extends SectionContext<CompactOptions> {
	/** Top-level tasks, the only ones the compact list shows. */
	topLevel: DashboardTaskNode[];
	/** Row budget of the compact task window at this width. */
	taskRows: number;
}

function compactStatus({ box, theme, model }: CompactContext): string[] {
	if (model.status.code === "complete") {
		return [box.line(`${success(theme, "✓")} ${success(theme, "All required work is complete.")}`)];
	}
	return [box.line(model.idlePacing ? fit(model.idlePacing, box.inner) : statusLine(theme, model))];
}

function compactScheduling({ box, theme, model }: CompactContext): string[] {
	return (model.scheduling ?? []).filter((row) => row !== model.idlePacing).map((row) => box.line(muted(theme, fit(row, box.inner))));
}

/** Budget fuel gauge: amber until the budget is exhausted, then soft red. */
function compactBudget({ box, theme, model }: CompactContext): string[] {
	if (!model.budget) return [];
	const fuel: RenderColor = model.budget.used >= model.budget.total ? "error" : "mdHeading";
	return [box.line(`${theme.fg(fuel, "⛽")} ${muted(theme, "Budget")} ${theme.fg(fuel, formatBudget(model.budget.used, model.budget.total))}`)];
}

/**
 * The Tasks rule carries the counts (`✓N done · M open`, skipped counts as
 * done), the task progress bar and, beside it, the current task's subtask bar.
 * Narrow drops the word `Sub` so the counts fit at 50 columns; minimal omits
 * the segment, since two bars cannot share 38 inner columns.
 */
function compactTasks(ctx: CompactContext): string[] {
	const { box, theme, model, mode, spec, topLevel, taskRows, opts } = ctx;
	if (topLevel.length === 0) return [];
	const offset = opts.scrollOffset ?? anchoredScrollOffset(topLevel, taskRows);
	const viewport = deriveTaskListViewport(topLevel.length, taskRows, offset);
	const progress = model.taskProgress;
	const label = progress ? `Tasks · ✓${progress.completed} done · ${progress.total - progress.completed} open` : "Tasks";
	let right = progress ? progressBar(theme, progress.percentage, spec.headerBarWidth) : "";
	const current = model.currentTask;
	if (current && current.totalSubtasks > 0 && mode !== "minimal") {
		const subBar = progressBar(theme, current.subtaskPercentage, spec.subtaskBarWidth);
		const subWord = mode === "narrow" ? "" : "Sub ";
		right += `${muted(theme, ` · ${subWord}`)}${muted(theme, `${current.completedSubtasks}/${current.totalSubtasks}`)} ${subBar}`;
	}
	return [box.rule(label, right), ...renderCompactTaskRows(theme, topLevel, viewport, box.inner).map((row) => box.line(row))];
}

/** All top-level tasks done and no current task. */
function compactAllTasksDone({ box, theme, model }: CompactContext): string[] {
	if (model.currentTask || !model.taskProgress || model.taskProgress.completed !== model.taskProgress.total || model.status.code === "complete") return [];
	return [box.line(`${muted(theme, "Current")}  ${accent(theme, "All tasks complete")}`)];
}

function compactCurrentTask({ box, theme, model, mode }: CompactContext): string[] {
	const current = model.currentTask;
	if (!current) return [];
	if (mode === "minimal") {
		return [box.line(`${accent(theme, "▸")} ${accent(theme, fit(current.title, box.inner - 3))}`)];
	}
	const titleBudget = box.inner - visibleWidth(`Current  ${current.id} · `);
	return [box.line(`${muted(theme, "Current")}  ${accent(theme, current.id)} · ${accent(theme, fit(current.title, titleBudget))}`)];
}

/** Goal-level verification: the contract squeezed onto one truncated line. */
function compactVerification({ box, theme, model, mode }: CompactContext): string[] {
	if (!model.goalVerificationContract || mode === "minimal") return [];
	return [box.line(`${muted(theme, "Verify")}   ${fit(model.goalVerificationContract.replace(/\s+/g, " "), box.inner - 9)}`)];
}

/** Why the goal is blocked or paused, and what to do about it. */
function compactStopDetails({ box, theme, model, spec }: CompactContext): string[] {
	const lines: string[] = [];
	const { status } = model;
	if (status.code === "blocked") {
		if (status.reason) lines.push(box.line(`${theme.fg("error", "Blocker")}  ${muted(theme, fit(status.reason, box.inner - 10))}`));
		if (spec.showPauseAction && status.suggestedAction) lines.push(box.line(`${muted(theme, "Action")}   ${fit(status.suggestedAction, box.inner - 9)}`));
	}
	if (status.code === "paused" && status.reason) {
		lines.push(box.line(`${muted(theme, "Reason")}   ${fit(status.reason, box.inner - 9)}`));
	}
	return lines;
}

function compactFilePath({ box, theme, model, spec }: CompactContext): string[] {
	if (!spec.showPath || !model.filePath) return [];
	return [box.line(dim(theme, `File     ${model.filePath}`))];
}

/**
 * Footer hint on the left, auditor dot bottom-right: green when the focused
 * goal's independent auditor is on, muted gray when off. Wide and medium add a
 * right-aligned note naming the toggle chord; narrow and minimal keep the dot.
 */
function compactFooter({ box, theme, model, mode, topLevel, taskRows, opts }: CompactContext): string[] {
	const keybindings = opts.keybindings ?? DEFAULT_GOAL_KEYBINDINGS.dashboard;
	const roomy = mode === "wide" || mode === "medium";
	const toggleShortcut = formatGoalKeybinding(keybindings.toggleExpand);
	const scrollShortcut = `${formatGoalKeybinding(keybindings.scrollUp)}/${formatGoalKeybinding(keybindings.scrollDown)}`;
	const defaults = DEFAULT_GOAL_KEYBINDINGS.dashboard;
	const usesDefaultScrollKeys = keybindings.scrollUp === defaults.scrollUp && keybindings.scrollDown === defaults.scrollDown;
	const scrollHint = usesDefaultScrollKeys ? (mode === "minimal" ? "↑↓" : "Ctrl+Shift+↑↓") : scrollShortcut;
	const expandHint = !bindingKeys(keybindings.toggleExpand).length ? "" : roomy ? `${toggleShortcut}: expand tasks` : `${toggleShortcut}: expand`;
	const listOverflows = topLevel.length > taskRows;
	const footerHint = opts.footerHint
		?? (listOverflows ? (roomy ? `${toggleShortcut}: expand · ${scrollHint}: scroll` : `${scrollHint}: scroll`) : expandHint);
	const auditorDot = model.auditorEnabled ? success(theme, "●") : muted(theme, "●");
	const auditorKey = opts.auditorKey ?? "ctrl+shift+a";
	const right = roomy && bindingKeys(auditorKey).length
		? `${frame(theme, `${formatGoalKeybinding(auditorKey)}: toggle auditor`)} ${auditorDot}`
		: auditorDot;
	return [box.footer(footerHint, right)];
}

const COMPACT_SECTIONS: Array<Section<CompactContext>> = [
	titleHeader,
	compactStatus,
	compactScheduling,
	compactBudget,
	compactTasks,
	compactAllTasksDone,
	compactCurrentTask,
	compactVerification,
	compactStopDetails,
	compactFilePath,
	compactFooter,
];

/**
 * Persistent summary above the editor while a goal is focused. Compact, with a
 * footer hint for the expand shortcut.
 */
export function renderCompactDashboard(
	model: GoalDashboardModel,
	theme: Theme,
	width: number,
	opts: CompactOptions = {},
): string[] {
	const base = makeContext(model, theme, width, opts);
	const ctx: CompactContext = {
		...base,
		topLevel: model.taskTree.filter((node) => node.depth === 0),
		taskRows: compactTaskViewportRows(base.box.width),
	};
	return runSections(ctx, COMPACT_SECTIONS);
}

// ── expanded dashboard ──────────────────────────────────────────────────────

interface ExpandedOptions {
	scrollOffset?: number;
	rows?: number;
	keybindings?: GoalDashboardKeybindings;
}

type ExpandedContext = SectionContext<ExpandedOptions>;

/** Status line, scheduling rows, file path and budget, in that order. */
function expandedSummary({ box, theme, model, spec }: ExpandedContext): string[] {
	const lines = [box.line(statusLine(theme, model))];
	for (const row of model.scheduling ?? []) lines.push(box.line(muted(theme, fit(row, box.inner))));
	if (spec.showPath && model.filePath) lines.push(box.line(dim(theme, `File: ${model.filePath}`)));
	if (model.budget) {
		lines.push(box.line(`${theme.fg("mdHeading", "⛽")} ${muted(theme, `Budget ${formatBudget(model.budget.used, model.budget.total)}`)}`));
	}
	return lines;
}

function expandedProgress({ box, theme, model, spec }: ExpandedContext): string[] {
	const progress = model.taskProgress;
	if (!progress) return [];
	const bar = progressBar(theme, progress.percentage, Math.max(10, spec.barWidth + 8));
	return [
		box.rule("Progress"),
		box.line(`${bar} ${muted(theme, `${progress.completed}/${progress.total} tasks · ${progress.percentage}%`)}`),
	];
}

/**
 * A window over the recursive task tree. With no explicit rows the whole tree
 * is shown; with a row budget the panel stays bounded and the arrow keys move
 * the window.
 */
function expandedTasks({ box, theme, model, opts }: ExpandedContext): string[] {
	if (model.taskTree.length === 0) return [];
	const totalRows = model.taskTree.length;
	const rows = opts.rows ?? totalRows;
	const offset = opts.scrollOffset ?? anchoredScrollOffset(model.taskTree, rows);
	const viewport = deriveTaskListViewport(totalRows, rows, offset);
	const lines = [box.rule("Tasks")];
	if (viewport.hiddenAbove > 0) lines.push(box.line(dim(theme, moreAboveText(viewport.hiddenAbove))));
	for (const node of model.taskTree.slice(viewport.offset, viewport.offset + viewport.rows)) {
		lines.push(box.line(renderTaskRow(theme, node, Math.min(node.depth, 6), box.inner)));
	}
	if (viewport.hiddenBelow > 0) lines.push(box.line(dim(theme, moreBelowText(viewport.hiddenBelow))));
	return lines;
}

function expandedCurrentTask({ model, theme, box, spec }: ExpandedContext): string[] {
	return model.currentTask ? renderCurrentTaskBlock(model, theme, box.width, spec.barWidth) : [];
}

function expandedActivity({ model, theme, box }: ExpandedContext): string[] {
	return model.recentActivity.length > 0 ? renderActivityBlock(model.recentActivity, theme, box.width) : [];
}

function expandedFooter({ box, opts }: ExpandedContext): string[] {
	const closeKeys = [opts.keybindings?.collapse ?? "escape", opts.keybindings?.toggleExpand ?? DEFAULT_GOAL_KEYBINDINGS.dashboard.toggleExpand].flatMap(bindingKeys);
	return [box.footer(closeKeys.length ? `${closeKeys.map(formatGoalKeybinding).join("/")}: collapse` : "")];
}

const EXPANDED_SECTIONS: Array<Section<ExpandedContext>> = [
	titleHeader,
	expandedSummary,
	expandedProgress,
	expandedTasks,
	expandedCurrentTask,
	verificationSection,
	expandedActivity,
	expandedFooter,
];

/**
 * The full dashboard: header, status, progress, a window over the task tree,
 * current-task details, verification and recent activity. Replaces the
 * separate task overlay. The task window defaults to the whole tree; pass
 * `rows` (and optionally `scrollOffset`) to bound it for scrolling, in which
 * case the default offset anchors to the most recently completed task.
 */
export function renderExpandedDashboard(
	model: GoalDashboardModel,
	theme: Theme,
	width: number,
	opts: ExpandedOptions = {},
): string[] {
	return runSections(makeContext(model, theme, width, opts), EXPANDED_SECTIONS);
}

// ── blocks shared with /goal-status ─────────────────────────────────────────

/**
 * The current-task detail block: title, subtask progress, contract, evidence,
 * and the inferred-focus note. Shared by the expanded dashboard and the
 * standard /goal-status output.
 */
export function renderCurrentTaskBlock(
	model: GoalDashboardModel,
	theme: Theme,
	width: number,
	barWidth = 16,
): string[] {
	const box = new Box(theme, width);
	const current = model.currentTask!;
	const lines = [
		box.rule("Current task"),
		box.line(`${accent(theme, current.id)} · ${fit(current.title, box.inner - visibleWidth(`${current.id} · `))}`),
	];
	if (current.totalSubtasks > 0) {
		const bar = progressBar(theme, current.subtaskPercentage, Math.max(8, barWidth));
		lines.push(box.line(`${muted(theme, "Subtasks")} ${bar} ${current.completedSubtasks}/${current.totalSubtasks} · ${current.subtaskPercentage}%`));
	}
	if (current.verificationContract) lines.push(...box.wrapped("Contract", current.verificationContract));
	if (current.evidence) lines.push(...box.wrapped("Evidence", current.evidence));
	if (current.inferred) lines.push(box.line(dim(theme, "Inferred from the first pending task — no persisted current task.")));
	return lines;
}

/** The recent-activity block, shared by the expanded dashboard and /goal-status. */
export function renderActivityBlock(items: GoalActivityItem[], theme: Theme, width: number): string[] {
	const box = new Box(theme, width);
	const lines = [box.rule("Recent activity")];
	for (const item of items) {
		const marker = activityMarker(item);
		lines.push(box.line(`${theme.fg(marker.color, marker.symbol)} ${fit(item.text, box.inner - 4)}`));
	}
	return lines;
}

// ── unfocused panel ─────────────────────────────────────────────────────────

/**
 * Shown when open goals exist but none is focused. The widget's no-goal branch
 * renders nothing.
 */
export function renderUnfocusedDashboard(openGoalCount: number, theme: Theme, width: number, commands?: GoalCommands): string[] {
	const box = new Box(theme, width);
	const goals = openGoalCount === 1 ? "1 open goal is available." : `${openGoalCount} open goals are available.`;
	return [
		box.header(frame(theme, "pi-goal-x ─ Goal focus required")),
		box.line(muted(theme, goals)),
		box.line(muted(theme, `Run ${commandHint("goal-focus", commands)} to choose the goal for this session.`)),
		box.footer(""),
	];
}
