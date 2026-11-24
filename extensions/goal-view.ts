import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { commandHint, type GoalCommands } from "./goal-controls.ts";
import type { GoalAccounting } from "./goal-accounting.ts";
import { goalActivityEvents } from "./goal-ledger.ts";
import { otherOpenGoalCount } from "./goal-pool.ts";
import { nowIso } from "./goal-record.ts";
import type { GoalSessionState } from "./goal-session-state.ts";
import { loadGoalSettings } from "./settings/resolve.ts";
import { goalStorageContext } from "./storage/goal-root.ts";
import type { AuditVerdict } from "./widgets/auditor-dashboard-model.ts";
import {
	GOAL_WIDGET_KEY,
	liveDisplayGoal,
	makeGoalWidgetFactory,
	type AuditorWidgetProgress,
	type GoalWidgetComponent,
} from "./widgets/goal-widget.ts";

/** The finished-audit card that shows briefly before the dashboard returns. */
export interface AuditResultCard {
	verdict: AuditVerdict;
	report: string;
	at: string;
}

const AUDIT_RESULT_SHOWN_MS = 6000;

interface GoalViewDeps {
	session: GoalSessionState;
	accounting: GoalAccounting;
	isInterruptionHeld(): boolean;
	getCommands(): GoalCommands | undefined;
	isStalled(): boolean;
}

/**
 * Everything the user sees: the dashboard widget above the editor, the footer
 * status hint, and the audit progress and result cards. It reads goal state
 * from the session when it draws and never changes goals itself.
 *
 * The widget is registered once with a factory that reads live state at render
 * time. Later changes only ask it to render again. Elapsed time is not ticked
 * on a timer, because terminal redraws pull users out of scrollback while they
 * review long goals.
 */
export class GoalView {
	auditProgress: AuditorWidgetProgress | null = null;
	auditAnimationTimer: ReturnType<typeof setInterval> | null = null;
	auditResult: AuditResultCard | null = null;
	readonly widgetRef: { current: GoalWidgetComponent | null } = { current: null };
	private auditResultTimer: ReturnType<typeof setTimeout> | null = null;
	// Survives the host re-creating the widget, so it lives here and not in the widget.
	private dashboardExpanded = false;
	private widgetRegistered = false;
	private flushScheduled = false;
	private lastCtx: ExtensionContext | null = null;
	private deps: GoalViewDeps;

	constructor(deps: GoalViewDeps) {
		this.deps = deps;
	}

	isDashboardExpanded(): boolean {
		return this.dashboardExpanded;
	}

	toggleDashboardExpanded(): void {
		this.dashboardExpanded = !this.dashboardExpanded;
		this.widgetRef.current?.invalidate();
	}

	/** The focused goal with live token and time usage added. */
	goalForDisplay() {
		return liveDisplayGoal(this.deps.session.goal, this.deps.accounting);
	}

	setAuditResult(verdict: AuditVerdict, report: string): void {
		const result = { verdict, report, at: nowIso() };
		this.auditResult = result;
		if (this.auditResultTimer) clearTimeout(this.auditResultTimer);
		this.auditResultTimer = setTimeout(() => {
			if (this.auditResult !== result) return;
			this.auditResult = null;
			this.auditResultTimer = null;
			this.widgetRef.current?.invalidate();
		}, AUDIT_RESULT_SHOWN_MS);
		this.auditResultTimer.unref?.();
		this.widgetRef.current?.invalidate();
	}

	clearAuditResult(): void {
		if (this.auditResultTimer) clearTimeout(this.auditResultTimer);
		this.auditResultTimer = null;
		this.auditResult = null;
	}

	stopAuditAnimation(): void {
		if (!this.auditAnimationTimer) return;
		clearInterval(this.auditAnimationTimer);
		this.auditAnimationTimer = null;
	}

	/** The user pressed Escape during an audit: stop it and wait for their choice. */
	abortAudit(): void {
		const audit = this.deps.session.activeAudit;
		if (!audit || audit.phase !== "running") return;
		audit.phase = "awaiting-choice";
		audit.controller.abort();
		this.stopAuditAnimation();
		this.auditProgress = null;
		this.widgetRef.current?.invalidate();
	}

	/**
	 * Coalesced widget updates. A tool handler calls this two to four times in
	 * one synchronous block; those collapse into one microtask render that reads
	 * the latest state.
	 */
	update(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		this.lastCtx = ctx;
		if (this.flushScheduled) return;
		this.flushScheduled = true;
		queueMicrotask(() => {
			this.flushScheduled = false;
			if (this.lastCtx) this.render(this.lastCtx);
		});
	}

	clear(ctx: ExtensionContext): void {
		this.lastCtx = null;
		this.widgetRegistered = false;
		this.widgetRef.current = null;
		if (!ctx.hasUI) return;
		ctx.ui.setStatus("goal", undefined);
		ctx.ui.setWidget(GOAL_WIDGET_KEY, undefined);
	}

	private render(ctx: ExtensionContext): void {
		const { session } = this.deps;
		if (!this.deps.isInterruptionHeld()) ctx.ui.setStatus("goal-interrupt", undefined);
		const totalOpen = otherOpenGoalCount(session.goalsById, null);
		if (!session.goal && totalOpen === 0) {
			this.clear(ctx);
			return;
		}
		if (!session.goal) {
			// hideUnfocusedBanner hides both the unfocused widget and the status
			// hint. The model-facing [PI GOAL UNFOCUSED] prompt is not affected.
			if (loadGoalSettings(ctx.cwd).hideUnfocusedBanner === true) {
				this.clear(ctx);
				return;
			}
			ctx.ui.setStatus("goal", `goal: unfocused [${totalOpen} open] - ${commandHint("goal-focus", this.deps.getCommands())}`);
			this.showWidget(ctx);
			return;
		}
		// The dashboard is the one home for a focused goal's status, so clear any
		// stale footer hint left from when no goal was focused.
		ctx.ui.setStatus("goal", undefined);
		this.showWidget(ctx);
	}

	private showWidget(ctx: ExtensionContext): void {
		if (this.widgetRegistered) {
			this.widgetRef.current?.update();
			return;
		}
		const { session } = this.deps;
		const cwd = ctx.cwd;
		const storage = goalStorageContext(ctx);
		ctx.ui.setWidget(
			GOAL_WIDGET_KEY,
			makeGoalWidgetFactory({
				getGoal: () => this.goalForDisplay() ?? session.goal,
				getOpenGoalCount: () => otherOpenGoalCount(session.goalsById, null),
				getAuditorProgress: () => this.auditProgress,
				getSettings: () => ({ ...loadGoalSettings(cwd), commands: this.deps.getCommands() }),
				getStalled: () => this.deps.isStalled(),
				getExpanded: () => this.dashboardExpanded,
				getLedgerEvents: () => session.goal ? goalActivityEvents(storage, session.goal.id) : [],
				getAuditResult: () => this.auditResult,
				componentRef: this.widgetRef,
			}),
			{ placement: "aboveEditor" },
		);
		this.widgetRegistered = true;
	}
}
