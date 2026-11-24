import type { GoalKeybinding, GoalCommands } from "../goal-controls.ts";
import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { visibleWidth } from "@earendil-works/pi-tui";
import { truncateToWidth } from "./text-cache.ts";
import {
	displayObjectiveTitle,
	formatDuration,
	formatTokenValue,
	type GoalDisplayRecordLike,
} from "../goal-display.ts";
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
	getStalled: () => boolean;
	getExpanded?: () => boolean;
	getLedgerEvents?: () => GoalLedgerEvent[];
	getAuditResult?: () => AuditResultView | null;
	/** Receives the live widget so terminal shortcuts can scroll its viewports. */
	componentRef?: { current: GoalWidgetComponent | null };
}) {
	return (tui: TUI, theme: Theme) => {
		const component = new GoalWidgetComponent({
			tui,
			theme,
			getGoal: opts.getGoal,
			getOpenGoalCount: opts.getOpenGoalCount,
			getAuditorProgress: opts.getAuditorProgress,
			getSettings: opts.getSettings,
			getStalled: opts.getStalled,
			getExpanded: opts.getExpanded,
			getLedgerEvents: opts.getLedgerEvents,
			getAuditResult: opts.getAuditResult,
		});
		if (opts.componentRef) opts.componentRef.current = component;
		return component;
	};
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

// ── terminal-height bound (spec 2026-08-10-widget-height-bound-scrollback-fix) ──

/**
 * Minimum rows reserved below/around the widget so pi's frame stays usable
 * when the widget is at its cap: status line (1) + editor minimum (3) +
 * footer (1) + a chat row (1). With the widget capped at
 * `terminalRows − WIDGET_HEIGHT_RESERVE`, the widget never fills the terminal:
 * the chat row stays in the frame, the widget's top lines stay within the
 * viewport (no pi-tui full-render scrollback wipe), and the editor/footer
 * stay visible — the equal-height scroll-up failure is impossible. Kept at
 * the minimum that still guarantees the chat row: a larger reserve would
 * slice dashboards that genuinely fit (e.g. the expanded 24-line dashboard
 * on a 30-row terminal renders unchanged at 24 + 5 chrome + 1 chat = 30).
 */
export const WIDGET_HEIGHT_RESERVE = 6;

/**
 * Deterministic height guard: cap rendered lines to the terminal height minus
 * the reserved chrome. Head slice, because the dashboard's content priority
 * is top-down (identity → status → progress → tasks → details → hints); the
 * goal identity/status and the interactive task list stay in frame. Pure
 * index function — stable across renders, so the widget never shrinks on its
 * own and can never trigger pi-tui's clearOnShrink full-render
 * (`\x1b[2J\x1b[H\x1b[3J` scrollback wipe). No-op (unbounded) when
 * terminalRows is missing (mock TUI, headless contexts, /goal-status text).
 *
 * This pure head-slice is the terminal bound for direct callers. The live
 * component additionally applies the stable-height bound
 * (spec 2026-08-11-stable-widget-height) so the rendered height stays
 * constant within each regime — see applyStableHeightBound.
 */
export function boundWidgetRenderLines(lines: string[], terminalRows: number | undefined): string[] {
	if (!terminalRows || terminalRows <= 0) return lines;
	const cap = Math.max(1, terminalRows - WIDGET_HEIGHT_RESERVE);
	if (lines.length <= cap) return lines;
	return lines.slice(0, cap);
}

/**
 * Stable rendered height per regime (spec 2026-08-11-stable-widget-height).
 *
 * The widget's natural (unbounded) height varies with goal state — activity
 * feed growth, current-task contract/evidence wrapping, verification text,
 * budget, task growth (measured 4..31 lines on a 24-row terminal). Every
 * natural-height change alters the dock height → the terminal buffer's line
 * count changes → the terminal scrolls to the bottom and the user cannot hold
 * a scroll position to read the chat. The latch makes the rendered height
 * invariant to goal-state changes in EVERY case (fits and capped):
 *
 * - the first render of each regime commits the rendered height
 *   (min(natural, cap)) and every later render of that regime renders exactly
 *   that many lines — growth is head-sliced, shrink is blank-padded, the
 *   height never changes;
 * - resizing the terminal clears the latch and re-evaluates
 *   min(natural, newCap): growing the terminal reveals more of the widget,
 *   shrinking re-caps;
 * - a regime change (goal id/status, widget state kind, compact↔expanded,
 *   tasks disabled, first task appearing) clears the latch so the
 *   new mode starts from its own natural height.
 *
 * Pure given the persisted latch state: deterministic, no timers, no
 * randomness — the same goal state on the same terminal renders the same
 * lines on every render.
 */
export function applyStableHeightBound(
	lines: string[],
	terminalRows: number | undefined,
	state: { stickyCap: number | undefined; stickyRegime: string | undefined; stickyTerminalRows: number | undefined; stickyReserve?: number },
	regime: string,
	reserve: number = WIDGET_HEIGHT_RESERVE,
): string[] {
	if (!terminalRows || terminalRows <= 0) return lines;
	const cap = Math.max(1, terminalRows - reserve);
	if (state.stickyTerminalRows !== terminalRows) {
		// Terminal resized: adapt to the new height (grow/shrink to fit).
		state.stickyCap = undefined;
		state.stickyTerminalRows = terminalRows;
	}
	if (state.stickyReserve !== reserve) {
		// The chrome below the widget changed (editor grew/shrunk, status,
		// footer, pending): re-evaluate so the widget's block plus the chrome
		// never exceeds the terminal — otherwise the chat's appended lines
		// and the status line land above pi-tui's viewport top and every
		// agent write triggers a 2J+3J scrollback wipe (spec 2026-08-11).
		state.stickyCap = undefined;
		state.stickyReserve = reserve;
	}
	if (state.stickyRegime !== regime) {
		// Mode/state changed: the latch belongs to one regime.
		state.stickyCap = undefined;
		state.stickyRegime = regime;
	}
	if (state.stickyCap === undefined) {
		// First render of the regime: latch the height — the natural height
		// when it fits, else the cap. Constant from here on, fits AND capped.
		state.stickyCap = Math.min(lines.length, cap);
	}
	if (lines.length > state.stickyCap) {
		// Growth past the committed height: head-slice (the dashboard's
		// content priority is top-down), so the buffer line count never
		// changes.
		return lines.slice(0, state.stickyCap);
	}
	if (lines.length < state.stickyCap) {
		// Natural dipped below the committed height: pad deterministically so
		// the buffer line count never changes. Blank rows after the box footer
		// — honest filler (the …/↑ N more markers are only for hidden content).
		const padded = lines.slice();
		while (padded.length < state.stickyCap) padded.push("");
		return padded;
	}
	// Exactly the committed height: unchanged.
	return lines;
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
 * recent output appear only with showToolDetails (expanded audit mode)
 * or after a failed audit.
 */
export function renderAuditorWidgetLines(
	progress: AuditorWidgetProgress,
	theme: Theme,
	width: number,
	opts: { showToolDetails?: boolean; verdict?: "approved" | "disapproved" | "error" | null; interruptKey?: GoalKeybinding } = {},
): string[] {
	const model = deriveAuditorDashboardModel(progress, { auditorLabel: progress.auditorLabel, verdict: opts.verdict });
	return renderAuditorDashboard(model, theme, width, { showToolDetails: opts.showToolDetails, interruptKey: opts.interruptKey });
}

/** §15.4: approval / rejection result card for a finished audit. */
export function renderAuditResultCardView(
	view: AuditResultView,
	theme: Theme,
	width: number,
): string[] {
	return renderAuditResultCard(deriveAuditResultCard(view.verdict, view.report), theme, width);
}

export function renderGoalWidgetLines(goal: GoalWidgetRecord | null, theme: Theme, width: number, options: { commands?: GoalCommands; openGoalCount?: number; auditorProgress?: AuditorWidgetProgress | null; disableTasks?: boolean; stalled?: boolean; ledgerEvents?: GoalLedgerEvent[]; expanded?: boolean; model?: GoalDashboardModel | null; compactScrollOffset?: number; expandedScrollOffset?: number; expandedTaskRows?: number; keybindings?: GoalDashboardKeybindings; auditorKey?: GoalKeybinding; interruptAuditKey?: GoalKeybinding; /** Terminal-height bound (see boundWidgetRenderLines); undefined = unbounded. */ terminalRows?: number } = {}): string[] {
	// When auditor progress is active, show the structured audit dashboard
	// instead of the normal goal widget (§15.3).
	if (options.auditorProgress) {
		return boundWidgetRenderLines(renderAuditorWidgetLines(options.auditorProgress, theme, width, {
			showToolDetails: options.expanded === true,
			interruptKey: options.interruptAuditKey,
		}), options.terminalRows);
	}
	const openGoalCount = options.openGoalCount ?? 0;
	if (!goal) {
		// Unfocused panel when open goals exist; nothing when the pool is empty.
		return boundWidgetRenderLines(openGoalCount > 0 ? renderUnfocusedDashboard(openGoalCount, theme, width, options.commands) : [], options.terminalRows);
	}
	const safeWidth = Math.max(1, width);
	const otherCount = Math.max(0, openGoalCount - 1);
	const model = options.model ?? deriveGoalDashboardModel(goal as GoalRecord | null, {
		focused: true,
		otherOpenGoals: otherCount,
		ledgerEvents: options.ledgerEvents ?? [],
		tasksDisabled: options.disableTasks === true,
		commands: options.commands,
	});
	if (!model) return [];
	const lines = options.expanded
		? renderExpandedDashboard(model, theme, safeWidth, { scrollOffset: options.expandedScrollOffset, rows: options.expandedTaskRows, keybindings: options.keybindings })
		: renderCompactDashboard(model, theme, safeWidth, { scrollOffset: options.compactScrollOffset, keybindings: options.keybindings, auditorKey: options.auditorKey });
	return boundWidgetRenderLines(clampLinesToWidth(lines, width), options.terminalRows);
}

export class GoalWidgetComponent implements Component {
	private theme: Theme;
	private tui: TUI;
	private getGoal: () => GoalWidgetRecord | null;
	private getOpenGoalCount: () => number;
	private getAuditorProgress: () => AuditorWidgetProgress | null;
	private getSettings: () => GoalSettings;
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

	// Stable-height latch (spec 2026-08-11-stable-widget-height): the first
	// render of each regime commits the rendered height (natural when it fits,
	// else the cap); the height stays constant (head-slice growth, pad shrink)
	// until the regime, the terminal size, or the measured dock chrome changes,
	// so the buffer line count never changes and the terminal stops jumping to
	// the bottom.
	private stableHeightState: { stickyCap: number | undefined; stickyRegime: string | undefined; stickyTerminalRows: number | undefined; stickyReserve?: number } = {
		stickyCap: undefined,
		stickyRegime: undefined,
		stickyTerminalRows: undefined,
		stickyReserve: undefined,
	};

	constructor(options: GoalWidgetOptions) {
		this.theme = options.theme;
		this.tui = options.tui;
		this.getGoal = options.getGoal;
		this.getOpenGoalCount = options.getOpenGoalCount ?? (() => (this.getGoal() ? 1 : 0));
		this.getAuditorProgress = options.getAuditorProgress ?? (() => null);
		this.getSettings = options.getSettings ?? (() => ({}));
		this.getStalled = options.getStalled ?? (() => false);
		this.getExpanded = options.getExpanded ?? (() => false);
		this.getLedgerEvents = options.getLedgerEvents ?? (() => []);
		this.getAuditResult = options.getAuditResult ?? (() => null);
	}

	/** Whether the dashboard is currently in expanded mode (§10). */
	isExpanded(): boolean {
		return this.getExpanded();
	}

	/** Pi 1.4's public focus getter and main-editor app wiring survive custom editors. */
	isMainEditorFocused(): boolean | undefined {
		const tui = this.tui as TUI & {getFocusedComponent?: () => Component | null};
		if (typeof tui.getFocusedComponent !== "function") return undefined;
		const focused = tui.getFocusedComponent() as (Component & {onSubmit?: unknown; actionHandlers?: unknown}) | null;
		// Pi copies these public app handlers when installing a replacement CustomEditor.
		// A foreign text editor can have getText/setText without owning app actions.
		return !!focused && typeof focused.onSubmit === "function"
			&& focused.actionHandlers instanceof Map && focused.actionHandlers.has("app.clear");
	}

	update(): void {
		this.tui.requestRender();
	}

	render(width: number): string[] {
		const settings = this.getSettings();
		this.lastRenderWidth = Math.max(1, width);
		// Terminal-height bound (spec 2026-08-10): read pi's terminal rows at
		// render time so the widget never fills the terminal — the chat/editor
		// stay visible and scrollable and the widget can never trigger pi-tui's
		// shrink full-render (\x1b[2J\x1b[H\x1b[3J) scrollback wipe. Same cast
		// pattern as the questionnaire churn guard; mock TUIs without a
		// `terminal` render unbounded.
		const terminalRows = (this.tui as unknown as { terminal?: { rows?: number } }).terminal?.rows;
		// Render the current branch unbounded (natural), then apply the
		// stable-height bound (spec 2026-08-11): the rendered height latches at
		// the first render of each regime and stays constant (fits and capped),
		// so the dock height / buffer line count stop changing and the
		// terminal stops jumping to the bottom.
		const natural = this.renderNatural(width);
		const regime = this.stableHeightRegime();
		// Reserve adapted to the actual dock chrome (status + editor + footer +
		// pending): the widget's block plus the chrome must never exceed the
		// terminal, or the chat's appended lines and the status line land above
		// pi-tui's viewport top and every agent write wipes the scrollback.
		const reserve = this.measureDockReserve(width) ?? WIDGET_HEIGHT_RESERVE;
		return applyStableHeightBound(natural, terminalRows, this.stableHeightState, regime, reserve);
	}

	/**
	 * Measure the rendered height of the dock chrome around the widget
	 * (pending + status + editor + widgetBelow + footer) at the current width,
	 * so the widget can size itself so its block plus the chrome never exceeds
	 * the terminal (spec 2026-08-11): pi-tui full-renders (2J+3J, scrollback
	 * wipe) whenever the first changed line is above its tracked viewport top
	 * (`previousBufferLength − terminalRows`); when the widget's block pushes
	 * the chat's append point and the status line above that, every agent
	 * write wipes the terminal scrollback and the user is forced to the
	 * bottom. Returns undefined (→ the static WIDGET_HEIGHT_RESERVE fallback)
	 * when the TUI exposes no measurable dock (mock TUIs, headless).
	 */
	private measureDockReserve(width: number): number | undefined {
		type DockChild = { children?: DockChild[]; render?: (w: number) => string[] };
		const tui = this.tui as unknown as { children?: DockChild[] };
		const top = tui.children;
		if (!Array.isArray(top) || top.length < 2) return undefined;
		// Locate the dock list and the widget's own container:
		// regular mode — top-level [document, pending, status, widgetAbove,
		//   editor, widgetBelow, footer] with the widget directly inside
		//   widgetContainerAbove;
		// fullscreen mode — top-level [transcript, dock] with the widget
		//   inside widgetContainerAbove inside the dock VStack.
		let dockList: typeof top | undefined;
		let widgetContainer: (typeof top)[number] | undefined;
		for (const c of top) {
			const kids = Array.isArray(c.children) ? c.children : undefined;
			if (kids?.includes(this)) {
				dockList = top;
				widgetContainer = c;
				break;
			}
			const nested = kids?.find((cc) => Array.isArray(cc.children) && cc.children!.includes(this)) as (typeof top)[number] | undefined;
			if (nested) {
				dockList = kids!;
				widgetContainer = nested;
				break;
			}
		}
		if (!dockList || !widgetContainer) return undefined;
		let total = 0;
		for (let i = 0; i < dockList.length; i++) {
			const c = dockList[i]!;
			// Skip the document container / transcript (its height cancels out
			// of the viewport math: it sits above both the chat's append point
			// and the viewport top) and the widget's own container.
			if (dockList === top && i === 0) continue;
			if (c === widgetContainer) continue;
			if (typeof c?.render !== "function") continue;
			try {
				const lines = c.render(width);
				if (Array.isArray(lines)) total += lines.length;
			} catch {
				// A sibling render failure must never break the widget; fall
				// back to the static reserve.
				return undefined;
			}
		}
		// +1 slack so the strictest safety condition (chat append point below
		// the viewport top) holds even at the boundary.
		return total + 1;
	}

	/** The current widget branch rendered unbounded (no terminal-height bound). */
	private renderNatural(width: number): string[] {
		const settings = this.getSettings();
		const safeWidth = Math.max(1, width);
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
			maxAutonomousRuns: settings.maxAutonomousRuns,
			idleContinuationBackoff: settings.idleContinuationBackoff,
			commands: settings.commands,
		}) : null;
		this.maybeReanchor(model);
		const lines = renderGoalWidgetLines(this.getGoal(), this.theme, safeWidth, {
			openGoalCount: this.getOpenGoalCount(),
			auditorProgress: this.getAuditorProgress(),
			disableTasks: settings.disableTasks,
			stalled: this.getStalled(),
			expanded: this.getExpanded(),
			ledgerEvents: this.getLedgerEvents(),
			model,
			compactScrollOffset: this.compactScrollOffset,
			expandedScrollOffset: this.expandedScrollOffset,
			expandedTaskRows: expandedTaskViewportRows(this.lastRenderWidth),
			keybindings: settings.keybindings?.dashboard,
			auditorKey: settings.keybindings?.toggleAuditor,
			commands: settings.commands,
			interruptAuditKey: settings.keybindings?.interruptAudit,
		});
		return clampLinesToWidth(lines, width);
	}

	/**
	 * Stable-height regime key: the latch belongs to one goal, goal status,
	 * widget state kind (focused / audit / result / unfocused / none),
	 * expansion mode, task setting, and task presence — a change
	 * clears the latch so the new mode starts from its own natural height.
	 * Task presence re-latches a structurally empty goal (0 tasks → tiny
	 * dashboard) when its first task appears — a rare structural jump, not
	 * steady-state churn.
	 */
	private stableHeightRegime(): string {
		const settings = this.getSettings();
		const goal = this.getGoal();
		let stateKind: string;
		if (this.getAuditResult()) stateKind = "result";
		else if (this.getAuditorProgress()) stateKind = "audit";
		else if (goal) stateKind = "focused";
		else stateKind = this.getOpenGoalCount() > 0 ? "unfocused" : "none";
		const hasTasks = (goal?.taskList?.tasks?.length ?? 0) > 0;
		return [goal?.id ?? "∅", goal?.status ?? "∅", stateKind, String(this.getExpanded()), String(settings.disableTasks === true), String(hasTasks)].join("|");
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
		if (this.getExpanded()) return false;
		const settings = this.getSettings();
		const goal = this.getGoal();
		const model = goal ? deriveGoalDashboardModel(goal as GoalRecord | null, {
			focused: true,
			otherOpenGoals: Math.max(0, this.getOpenGoalCount() - 1),
			ledgerEvents: this.getLedgerEvents(),
			tasksDisabled: settings.disableTasks === true,
			maxAutonomousRuns: settings.maxAutonomousRuns,
			idleContinuationBackoff: settings.idleContinuationBackoff,
			commands: settings.commands,
		}) : null;
		this.maybeReanchor(model);
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
			maxAutonomousRuns: settings.maxAutonomousRuns,
			idleContinuationBackoff: settings.idleContinuationBackoff,
			commands: settings.commands,
		}) : null;
		this.maybeReanchor(model);
		const list = model?.taskTree ?? [];
		if (list.length === 0) return false;
		const rows = expandedTaskViewportRows(this.lastRenderWidth);
		const maxO = maxScrollOffset(list.length, rows);
		if (maxO <= 0) return true;
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
