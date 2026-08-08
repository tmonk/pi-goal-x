import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
	displayObjectiveTitle,
	formatDuration,
	formatTokenValue,
	truncateText,
	type GoalDisplayRecordLike,
} from "../goal-core.ts";
import type { GoalRecord, GoalTask, GoalTaskList, TaskStatus } from "../goal-record.ts";
import type { GoalDashboardKeybindings, GoalSettings } from "../goal-settings.ts";
import { sisyphusStepProgress } from "../goal-policy.ts";
import type { GoalLedgerEvent } from "../goal-ledger.ts";
import {
	anchoredScrollOffset,
	clampScrollOffset,
	compactTaskViewportRows,
	deriveGoalDashboardModel,
	expandedTaskViewportRows,
	latestCompletedNodeIndex,
	maxScrollOffset,
	taskViewportPageSize,
	type GoalDashboardModel,
} from "./goal-dashboard-model.ts";
import {
	clampLinesToWidth,
	renderAuditResultCard,
	renderAuditorDashboard,
	renderCompactDashboard,
	renderExpandedDashboard,
	renderUnfocusedDashboard,
} from "./goal-dashboard-renderer.ts";
import { deriveAuditResultCard, deriveAuditorDashboardModel } from "./auditor-dashboard-model.ts";

type GoalWidgetColor = Extract<ThemeColor, "accent" | "warning" | "success" | "error" | "dim" | "muted" | "text">;

export interface GoalWidgetRecord extends GoalDisplayRecordLike {
	id: string;
	createdAt: string;
	updatedAt: string;
	activePath?: string | null;
	archivedPath?: string | null;
	pauseReason?: string;
	pauseSuggestedAction?: string;
	taskList?: GoalTaskList | null;
	verificationContract?: string;
	tokenBudget?: number;
	currentTaskId?: string;
}

export const GOAL_WIDGET_KEY = "goal";

/**
 * Live display record for the widget/status line: the accounted usage view
 * (clone with live elapsed seconds) when accounting is active for the goal,
 * otherwise the goal as-is (P1-12 extraction from goal-state).
 */
export function liveDisplayGoal(goal: GoalRecord | null, accounting: { isActiveFor(goalId: string): boolean; liveSeconds(): number }): GoalRecord | null {
	if (!goal || goal.status !== "active" || !accounting.isActiveFor(goal.id)) return goal;
	const liveSeconds = accounting.liveSeconds();
	if (liveSeconds === 0) return goal;
	return {
		...goal,
		usage: { ...goal.usage, activeSeconds: goal.usage.activeSeconds + liveSeconds },
	};
}

/**
 * The above-editor widget registration factory (P1-12 extraction): builds the
 * GoalWidgetComponent factory the host UI calls at render time. Reads live
 * state through getters so renders always see the current goal.
 */
export function makeGoalWidgetFactory(opts: {
	getGoal: () => GoalWidgetRecord | null;
	getOpenGoalCount: () => number;
	getAuditorProgress: () => AuditorWidgetProgress | null;
	getSettings: () => GoalSettings;
	getDebugMode: () => boolean;
	getStalled: () => boolean;
	getExpanded?: () => boolean;
	getLedgerEvents?: () => GoalLedgerEvent[];
	getAuditResult?: () => AuditResultView | null;
}) {
	return (tui: TUI, theme: Theme) => new GoalWidgetComponent({
		tui,
		theme,
		getGoal: opts.getGoal,
		getOpenGoalCount: opts.getOpenGoalCount,
		getAuditorProgress: opts.getAuditorProgress,
		getSettings: opts.getSettings,
		getDebugMode: opts.getDebugMode,
		getStalled: opts.getStalled,
		getExpanded: opts.getExpanded,
		getLedgerEvents: opts.getLedgerEvents,
		getAuditResult: opts.getAuditResult,
	});
}

export interface AuditorWidgetProgress {
	currentTool?: string;
	currentToolArgs?: string;
	currentToolStartedAt?: number;
	recentOutput: string[];
	phase: "running" | "tool_executing" | "producing_report" | "thinking" | "done";
	elapsedMs: number;
	/** Current step label shown to the user */
	label?: string;
	/** Completion percentage from 0 to 100 */
	percentage?: number;
	/** §15: auditor identity (provider/model) for the audit dashboard header. */
	auditorLabel?: string;
}

export interface GoalWidgetOptions {
	theme: Theme;
	tui: TUI;
	getGoal: () => GoalWidgetRecord | null;
	getOpenGoalCount?: () => number;
	getAuditorProgress?: () => AuditorWidgetProgress | null;
	getSettings?: () => GoalSettings;
	getDebugMode?: () => boolean;
	/** F5: stalled badge (active auto-continue goal with no recent activity). */
	getStalled?: () => boolean;
	/** §10: dashboard expansion state (compact vs expanded task view). */
	getExpanded?: () => boolean;
	/** §12: durable ledger events for the recent-activity feed. */
	getLedgerEvents?: () => GoalLedgerEvent[];
	/** §15.4: finished audit result card (cleared after a short display). */
	getAuditResult?: () => AuditResultView | null;
}

function fit(value: string, width: number): string {
	return visibleWidth(value) > width ? truncateToWidth(value, width, "…") : value;
}

function heading(theme: Theme, width: number, left: string, right = ""): string {
	if (!right) return fit(left, width);
	const rightPart = ` ${right}`;
	const fill = Math.max(1, width - visibleWidth(left) - visibleWidth(rightPart));
	return fit(`${left}${theme.fg("dim", " ".repeat(fill))}${rightPart}`, width);
}

function branchLine(theme: Theme, width: number, isLast: boolean, content: string): string {
	const prefix = isLast ? "└─" : "├─";
	return fit(`${theme.fg("dim", prefix)} ${content}`, width);
}

function progressBar(pct: number, barWidth: number, theme: Theme): string {
	const safeBar = Math.max(3, barWidth);
	const filled = Math.min(safeBar, Math.max(0, Math.round((pct / 100) * safeBar)));
	const empty = safeBar - filled;
	return `[${theme.fg("accent", "█".repeat(filled))}${theme.fg("dim", "░".repeat(empty))}]`;
}


const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function spinnerFrame(): string {
	return SPINNER[Math.floor(Date.now() / 80) % SPINNER.length]!;
}

export interface AuditResultView {
	verdict: "approved" | "disapproved" | "error";
	report: string;
}

/**
 * Structured audit dashboard (§15): five check stages, elapsed duration, and a
 * progress bar, derived from the raw auditor progress stream. Raw tools and
 * recent output appear only with showToolDetails (expanded/debug audit mode)
 * or after a failed audit.
 */
export function renderAuditorWidgetLines(
	progress: AuditorWidgetProgress,
	theme: Theme,
	width: number,
	opts: { showToolDetails?: boolean; verdict?: "approved" | "disapproved" | "error" | null } = {},
): string[] {
	const model = deriveAuditorDashboardModel(progress, { auditorLabel: progress.auditorLabel, verdict: opts.verdict });
	return renderAuditorDashboard(model, theme, width, { showToolDetails: opts.showToolDetails });
}

/** §15.4: approval / rejection result card for a finished audit. */
export function renderAuditResultCardView(
	view: AuditResultView,
	theme: Theme,
	width: number,
): string[] {
	return renderAuditResultCard(deriveAuditResultCard(view.verdict, view.report), theme, width);
}

export function renderGoalWidgetLines(goal: GoalWidgetRecord | null, theme: Theme, width: number, options: { openGoalCount?: number; auditorProgress?: AuditorWidgetProgress | null; disableTasks?: boolean; stalled?: boolean; ledgerEvents?: GoalLedgerEvent[]; expanded?: boolean; debug?: boolean; model?: GoalDashboardModel | null; compactScrollOffset?: number; expandedScrollOffset?: number; expandedTaskRows?: number; keybindings?: GoalDashboardKeybindings } = {}): string[] {
	// When auditor progress is active, show the structured audit dashboard
	// instead of the normal goal widget (§15.3).
	if (options.auditorProgress) {
		return renderAuditorWidgetLines(options.auditorProgress, theme, width, {
			showToolDetails: options.expanded === true || options.debug === true,
		});
	}
	const openGoalCount = options.openGoalCount ?? 0;
	if (!goal) {
		// Unfocused panel when open goals exist; nothing when the pool is empty.
		return openGoalCount > 0 ? renderUnfocusedDashboard(openGoalCount, theme, width) : [];
	}
	const safeWidth = Math.max(1, width);
	const otherCount = Math.max(0, openGoalCount - 1);
	const model = options.model ?? deriveGoalDashboardModel(goal as GoalRecord | null, {
		focused: true,
		otherOpenGoals: otherCount,
		ledgerEvents: options.ledgerEvents ?? [],
		tasksDisabled: options.disableTasks === true,
	});
	if (!model) return [];
	const lines = options.expanded
		? renderExpandedDashboard(model, theme, safeWidth, { scrollOffset: options.expandedScrollOffset, rows: options.expandedTaskRows, keybindings: options.keybindings })
		: renderCompactDashboard(model, theme, safeWidth, { scrollOffset: options.compactScrollOffset, keybindings: options.keybindings });
	return clampLinesToWidth(lines, width);
}

export class GoalWidgetComponent implements Component {
	private theme: Theme;
	private tui: TUI;
	private getGoal: () => GoalWidgetRecord | null;
	private getOpenGoalCount: () => number;
	private getAuditorProgress: () => AuditorWidgetProgress | null;
	private getSettings: () => GoalSettings;
	private getDebugMode: () => boolean;
	private getStalled: () => boolean;
	private getExpanded: () => boolean;
	private getLedgerEvents: () => GoalLedgerEvent[];
	private getAuditResult: () => AuditResultView | null;

	// §9.6 scroll state: viewport offsets for the compact top-level list and
	// the expanded tree, compact scroll-focus engagement, and the re-anchor
	// bookkeeping (a new completion re-anchors to the latest completed task).
	private compactScrollOffset = 0;
	private expandedScrollOffset = 0;
	private lastRenderWidth = 100;
	private lastSeenGoalId: string | undefined;
	private lastSeenLatestCompletedAt: string | undefined;

	constructor(options: GoalWidgetOptions) {
		this.theme = options.theme;
		this.tui = options.tui;
		this.getGoal = options.getGoal;
		this.getOpenGoalCount = options.getOpenGoalCount ?? (() => (this.getGoal() ? 1 : 0));
		this.getAuditorProgress = options.getAuditorProgress ?? (() => null);
		this.getSettings = options.getSettings ?? (() => ({}));
		this.getDebugMode = options.getDebugMode ?? (() => false);
		this.getStalled = options.getStalled ?? (() => false);
		this.getExpanded = options.getExpanded ?? (() => false);
		this.getLedgerEvents = options.getLedgerEvents ?? (() => []);
		this.getAuditResult = options.getAuditResult ?? (() => null);
	}

	/** Whether the dashboard is currently in expanded mode (§10). */
	isExpanded(): boolean {
		return this.getExpanded();
	}

	update(): void {
		this.tui.requestRender();
	}

	/** Render debug info panel when debug mode is active */
	private renderDebugPanel(width: number): string[] {
		const t = this.theme;
		const lines: string[] = [];
		const safeWidth = Math.max(20, width);

		// Divider
		lines.push(t.fg("dim", "─".repeat(safeWidth)));
		lines.push(t.fg("warning", "⊙ [DEBUG MODE]"));
		lines.push("");

		const goal = this.getGoal();
		if (goal) {
			lines.push(t.fg("dim", `  id: ${goal.id}`));
			lines.push(t.fg("dim", `  status: ${goal.status}`));
			lines.push(t.fg("dim", `  objective: ${truncateText(goal.objective, 80)}`));
			lines.push(t.fg("dim", `  sisyphus: ${goal.sisyphus}`));
			lines.push(t.fg("dim", `  autoContinue: ${goal.autoContinue}`));
			lines.push(t.fg("dim", `  tokens: ${goal.usage.tokensUsed}`));
			lines.push(t.fg("dim", `  activeSeconds: ${goal.usage.activeSeconds}`));
			lines.push(t.fg("dim", `  createdAt: ${goal.createdAt}`));
			lines.push(t.fg("dim", `  updatedAt: ${goal.updatedAt}`));
			if (goal.pauseReason) lines.push(t.fg("dim", `  pauseReason: ${goal.pauseReason}`));
			if (goal.pauseSuggestedAction) lines.push(t.fg("dim", `  pauseSuggestedAction: ${goal.pauseSuggestedAction}`));
			if (goal.stopReason) lines.push(t.fg("dim", `  stopReason: ${goal.stopReason}`));
			if (goal.activePath) lines.push(t.fg("dim", `  activePath: ${goal.activePath}`));
			if (goal.archivedPath) lines.push(t.fg("dim", `  archivedPath: ${goal.archivedPath}`));
			if (goal.verificationContract) lines.push(t.fg("dim", `  vContract: ${truncateText(goal.verificationContract, 60)}`));

			// Task tree summary (from the shared dashboard model).
			const model = deriveGoalDashboardModel(goal as GoalRecord | null, { focused: true, otherOpenGoals: 0 });
			if (model?.taskProgress) {
				lines.push(t.fg("dim", `  tasks: ${model.taskProgress.completed}/${model.taskProgress.total}`));
			}
			if (model?.currentTask) {
				lines.push(t.fg("dim", `  next: ${model.currentTask.id} (${truncateText(model.currentTask.title, 40)})`));
			}
		} else {
			lines.push(t.fg("dim", "  (no goal)"));
		}

		lines.push("");
		lines.push(t.fg("dim", "── Debug keybindings ──"));
		lines.push(t.fg("dim", "  Ctrl+Shift+X  Toggle debug mode"));
		lines.push(t.fg("dim", "  Ctrl+Shift+N  Create test goal"));
		lines.push(t.fg("dim", "  Ctrl+Shift+T  Inject sample tasks"));
		lines.push(t.fg("dim", "  Ctrl+Shift+R  Mock audit animation"));
		lines.push(t.fg("dim", "  Ctrl+Shift+O  Open proposal dialog"));

		return lines;
	}

	render(width: number): string[] {
		const settings = this.getSettings();
		this.lastRenderWidth = Math.max(1, width);
		// §15.4: a finished audit shows its result card until cleared.
		const auditResult = this.getAuditResult();
		if (auditResult) {
			return clampLinesToWidth(renderAuditResultCardView(auditResult, this.theme, width), width);
		}
		const goal = this.getGoal();
		const otherCount = Math.max(0, this.getOpenGoalCount() - 1);
		const model = goal ? deriveGoalDashboardModel(goal as GoalRecord | null, {
			focused: true,
			otherOpenGoals: otherCount,
			ledgerEvents: this.getLedgerEvents(),
			tasksDisabled: settings.disableTasks === true,
		}) : null;
		this.maybeReanchor(model);
		let lines = renderGoalWidgetLines(this.getGoal(), this.theme, width, {
			openGoalCount: this.getOpenGoalCount(),
			auditorProgress: this.getAuditorProgress(),
			disableTasks: settings.disableTasks,
			stalled: this.getStalled(),
			expanded: this.getExpanded(),
			ledgerEvents: this.getLedgerEvents(),
			debug: this.getDebugMode(),
			model,
			compactScrollOffset: this.compactScrollOffset,
			expandedScrollOffset: this.expandedScrollOffset,
			expandedTaskRows: expandedTaskViewportRows(this.lastRenderWidth),
			keybindings: settings.keybindings?.dashboard,
		});
		if (this.getDebugMode()) {
			lines.push(...this.renderDebugPanel(width));
		}
		return clampLinesToWidth(lines, width);
	}

	/**
	 * §9.6 re-anchor rule: when the goal changes or a new task completes (the
	 * latest completedAt moves), reset both viewports to the anchored defaults
	 * so the most recently completed work stays visible. Between such events
	 * the user's manual scroll position is preserved.
	 */
	private maybeReanchor(model: GoalDashboardModel | null): void {
		const latestAt = latestCompletedNodeIndex(model?.taskTree ?? []) >= 0
			? model!.taskTree[latestCompletedNodeIndex(model!.taskTree)]!.completedAt
			: undefined;
		if (model?.goalId === this.lastSeenGoalId && latestAt === this.lastSeenLatestCompletedAt) return;
		this.lastSeenGoalId = model?.goalId;
		this.lastSeenLatestCompletedAt = latestAt;
		if (!model || model.taskTree.length === 0) {
			this.compactScrollOffset = 0;
			this.expandedScrollOffset = 0;
			return;
		}
		const topLevel = model.taskTree.filter((n) => n.depth === 0);
		this.compactScrollOffset = anchoredScrollOffset(topLevel, compactTaskViewportRows(this.lastRenderWidth));
		this.expandedScrollOffset = anchoredScrollOffset(model.taskTree, expandedTaskViewportRows(this.lastRenderWidth));
	}

	/**
	 * Scroll the compact task list with a Ctrl+Shift chord (§9.6). The chords
	 * are free in pi (the editor owns the plain arrows), so no focus state is
	 * needed — but they are consumed only when the compact list actually
	 * overflows its viewport, so they never swallow keystrokes for a short
	 * list. Returns true when the key was consumed.
	 */
	handleCompactScrollKey(key: "up" | "down" | "pageUp" | "pageDown" | "home" | "end"): boolean {
		const settings = this.getSettings();
		const goal = this.getGoal();
		const model = goal ? deriveGoalDashboardModel(goal as GoalRecord | null, {
			focused: true,
			otherOpenGoals: Math.max(0, this.getOpenGoalCount() - 1),
			ledgerEvents: this.getLedgerEvents(),
			tasksDisabled: settings.disableTasks === true,
		}) : null;
		const list = model?.taskTree.filter((n) => n.depth === 0) ?? [];
		const rows = compactTaskViewportRows(this.lastRenderWidth);
		if (list.length <= rows) return false;
		let offset = clampScrollOffset(this.compactScrollOffset, list.length, rows);
		if (key === "up") offset -= 1;
		else if (key === "down") offset += 1;
		else if (key === "pageUp") offset -= taskViewportPageSize(rows);
		else if (key === "pageDown") offset += taskViewportPageSize(rows);
		else if (key === "home") offset = 0;
		else if (key === "end") offset = maxScrollOffset(list.length, rows);
		offset = clampScrollOffset(offset, list.length, rows);
		this.compactScrollOffset = offset;
		this.tui.requestRender();
		return true;
	}

	/**
	 * Handle a navigation key for the expanded dashboard. The expanded
	 * dashboard is modal — while it is open it owns the arrow keys (like the
	 * session tree or model selector), so plain ↑/↓/PgUp/PgDn scroll the task
	 * tree and Esc collapses. Returns true when the key was consumed.
	 * Clamps at both ends; Home/End jump to the edges; PgUp/PgDn page by one
	 * viewport.
	 */
	handleNavigationKey(key: "up" | "down" | "pageUp" | "pageDown" | "home" | "end"): boolean {
		if (!this.getExpanded()) return false;
		const settings = this.getSettings();
		const goal = this.getGoal();
		const model = goal ? deriveGoalDashboardModel(goal as GoalRecord | null, {
			focused: true,
			otherOpenGoals: Math.max(0, this.getOpenGoalCount() - 1),
			ledgerEvents: this.getLedgerEvents(),
			tasksDisabled: settings.disableTasks === true,
		}) : null;
		const list = model?.taskTree ?? [];
		if (list.length === 0) return false;
		const rows = expandedTaskViewportRows(this.lastRenderWidth);
		const maxO = maxScrollOffset(list.length, rows);
		if (maxO <= 0) return false;
		let offset = clampScrollOffset(this.expandedScrollOffset, list.length, rows);
		if (key === "up") offset -= 1;
		else if (key === "down") offset += 1;
		else if (key === "pageUp") offset -= taskViewportPageSize(rows);
		else if (key === "pageDown") offset += taskViewportPageSize(rows);
		else if (key === "home") offset = 0;
		else if (key === "end") offset = maxO;
		offset = clampScrollOffset(offset, list.length, rows);
		this.expandedScrollOffset = offset;
		this.tui.requestRender();
		return true;
	}

	invalidate(): void {
		this.tui.requestRender();
	}
}
