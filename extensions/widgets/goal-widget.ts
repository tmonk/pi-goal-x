import type { GoalKeybinding, GoalCommands } from "../goal-controls.ts";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import {
	type GoalDisplayRecordLike,
} from "../goal-display.ts";
import type { GoalRecord, GoalTaskList } from "../goal-record.ts";
import type { GoalDashboardKeybindings, GoalSettings } from "../settings/schema.ts";
import type { GoalLedgerEvent } from "../goal-ledger.ts";
import { deriveGoalDashboardModel, type GoalDashboardModel } from "./goal-dashboard-model.ts";
import { expandedTaskViewportRows } from "./task-viewport.ts";
import {
	clampLinesToWidth,
	renderAuditResultCard,
	renderAuditorDashboard,
	renderCompactDashboard,
	renderExpandedDashboard,
	renderUnfocusedDashboard,
} from "./goal-dashboard-renderer.ts";
import { TaskScroll, type ScrollKey } from "./task-scroll.ts";
import { boundWidgetRenderLines, measureDockReserve, newStableHeightState, applyStableHeightBound, WIDGET_HEIGHT_RESERVE } from "./widget-height.ts";
import { deriveAuditResultCard, deriveAuditorDashboardModel } from "./auditor-dashboard-model.ts";

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

interface GoalWidgetOptions {
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

// The height rules live in widget-height.ts; these names stay importable from here.
export { applyStableHeightBound, boundWidgetRenderLines, WIDGET_HEIGHT_RESERVE } from "./widget-height.ts";

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

	private lastRenderWidth = 100;
	private scroll = new TaskScroll();
	// The first render of each regime commits the rendered height; see
	// applyStableHeightBound.
	private stableHeightState = newStableHeightState();

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

	/** Whether the dashboard is currently in expanded mode. */
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
		this.lastRenderWidth = Math.max(1, width);
		// Read pi's terminal rows at render time so the widget never fills the
		// terminal. Mock TUIs without a `terminal` render unbounded.
		const terminalRows = (this.tui as unknown as { terminal?: { rows?: number } }).terminal?.rows;
		const natural = this.renderNatural(width);
		const regime = this.stableHeightRegime();
		// Reserve adapted to the actual dock chrome (status + editor + footer +
		// pending), falling back to the static reserve.
		const reserve = measureDockReserve(this.tui, this, width) ?? WIDGET_HEIGHT_RESERVE;
		return applyStableHeightBound(natural, terminalRows, this.stableHeightState, regime, reserve);
	}

	/** The current widget branch rendered unbounded (no terminal-height bound). */
	private renderNatural(width: number): string[] {
		const settings = this.getSettings();
		// A finished audit shows its result card until cleared.
		const auditResult = this.getAuditResult();
		if (auditResult) {
			return clampLinesToWidth(renderAuditResultCardView(auditResult, this.theme, width), width);
		}
		const model = this.currentModel(settings);
		const lines = renderGoalWidgetLines(this.getGoal(), this.theme, Math.max(1, width), {
			openGoalCount: this.getOpenGoalCount(),
			auditorProgress: this.getAuditorProgress(),
			disableTasks: settings.disableTasks,
			stalled: this.getStalled(),
			expanded: this.getExpanded(),
			ledgerEvents: this.getLedgerEvents(),
			model,
			compactScrollOffset: this.scroll.compactOffset,
			expandedScrollOffset: this.scroll.expandedOffset,
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
	 * expansion mode, task setting, and task presence. A change clears the
	 * latch so the new mode starts from its own natural height. Task presence
	 * re-latches a structurally empty goal when its first task appears.
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

	private currentModel(settings: GoalSettings): GoalDashboardModel | null {
		const goal = this.getGoal();
		const model = goal ? deriveGoalDashboardModel(goal as GoalRecord, {
			focused: true,
			otherOpenGoals: Math.max(0, this.getOpenGoalCount() - 1),
			ledgerEvents: this.getLedgerEvents(),
			tasksDisabled: settings.disableTasks === true,
			maxAutonomousRuns: settings.maxAutonomousRuns,
			idleContinuationBackoff: settings.idleContinuationBackoff,
			commands: settings.commands,
		}) : null;
		this.scroll.reanchor(model, this.lastRenderWidth);
		return model;
	}

	/**
	 * Scroll the compact task list with a Ctrl+Shift chord. The chords are free
	 * in pi (the editor owns the plain arrows), so no focus state is needed,
	 * but they are consumed only when the compact list actually overflows its
	 * viewport. Returns true when the key was consumed.
	 */
	handleCompactScrollKey(key: ScrollKey): boolean {
		if (this.getExpanded()) return false;
		if (!this.scroll.scrollCompact(key, this.currentModel(this.getSettings()), this.lastRenderWidth)) return false;
		this.tui.requestRender();
		return true;
	}

	/**
	 * Handle a navigation key for the expanded dashboard. It is modal: while
	 * open it owns the arrow keys (like the session tree or model selector), so
	 * plain up/down/PgUp/PgDn scroll the task tree and Esc collapses. Clamps at
	 * both ends; Home/End jump to the edges; PgUp/PgDn page by one viewport.
	 * Returns true when the key was consumed.
	 */
	handleNavigationKey(key: ScrollKey): boolean {
		if (!this.getExpanded()) return false;
		const result = this.scroll.scrollExpanded(key, this.currentModel(this.getSettings()), this.lastRenderWidth);
		if (result === "scrolled") this.tui.requestRender();
		return result !== "ignored";
	}

	invalidate(): void {
		this.tui.requestRender();
	}
}
