import { matchesKey } from "@earendil-works/pi-tui";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildDraftConfirmationText } from "./goal-draft.ts";
import { showProposalDialog } from "./goal-questionnaire.ts";
import { cloneGoal, createGoal, nowIso, type GoalTask } from "./goal-record.ts";
import { serializeGoalFile } from "./storage/goal-files.ts";
import { showTaskListOverlay } from "./widgets/task-list-overlay.ts";
import type { AuditorWidgetProgress } from "./widgets/goal-widget.ts";
import type { GoalCore } from "./goal-state.ts";

const DEBUG_GOALS_DIR = ".pi/goals/debug";

/**
 * Terminal input keybindings (Escape pause/abort-audit, Ctrl+Shift+T task
 * overlay, and the hidden debug-mode bindings) plus the debug goal/task/audit
 * helpers. Re-registered at session start/tree navigation; the handler reads
 * live state through the core at event time.
 */
let debugGoalCounter = 0;
let debugMockAuditTimer: ReturnType<typeof setInterval> | null = null;

export function syncTerminalInputPause(core: GoalCore, ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		core.terminalInputUnsubscribe?.();
		core.terminalInputUnsubscribe = ctx.ui.onTerminalInput((data) => {
			// If an audit is running, Escape aborts the audit instead of pausing.
			// Must return { consume: true } so the TUI doesn't also process the key
			// and abort the running tool execution, which would cascade into pausing
			// the entire goal (agent_end sees ctx.signal?.aborted and calls pauseActiveGoal).
			if (core.showingEscapeDialog) return undefined;
			if (matchesKey(data, "escape") && core.auditProgress) {
				core.abortAudit(ctx);
				return { consume: true };
			}
			if (matchesKey(data, "escape") && core.state.goal?.status === "active" && core.state.goal.autoContinue) {
				core.pauseActiveGoal(ctx);
				return { consume: true };
			}

			// Ctrl+Shift+T — show task list overlay for all open goals
			if (matchesKey(data, "ctrl+shift+t")) {
				showTaskListOverlay(ctx, core.goalsById, core.focusedGoalId);
				return { consume: true };
			}

			// ── Debug mode keybindings (hidden from normal view) ────────────────

			// Ctrl+Shift+X — toggle debug mode on/off
			if (matchesKey(data, "ctrl+shift+x")) {
				core.debugMode = !core.debugMode;
				ctx.ui.notify(core.debugMode ? "Debug mode ON" : "Debug mode OFF", "info");
				core.goalWidgetComponentRef.current?.invalidate();
				return { consume: true };
			}

			// Only process the following debug keybindings when debug mode is active
			if (!core.debugMode) return undefined;

			// Ctrl+Shift+N — create a test goal
			if (matchesKey(data, "ctrl+shift+n")) {
				createDebugGoal(ctx);
				return { consume: true };
			}

			// Ctrl+Shift+T — inject sample tasks into current goal
			if (matchesKey(data, "ctrl+shift+t")) {
				injectDebugTasks(ctx);
				return { consume: true };
			}

			// Ctrl+Shift+R — start mock completion audit
			if (matchesKey(data, "ctrl+shift+r")) {
				startMockAudit(ctx);
				return { consume: true };
			}

			// Ctrl+Shift+O — open proposal dialog with sample data
			if (matchesKey(data, "ctrl+shift+o")) {
				openDebugProposal(ctx);
				return { consume: true };
			}

			return undefined;
		});

		/** Toggle a test goal: create (first press) or remove (second press) */
		function createDebugGoal(ctx: ExtensionContext): void {
			const prev = core.state.goal;
			if (prev && prev.id.startsWith("debug-")) {
				// Toggle off — remove debug goal entirely (no archive, full delete)
				const filePath = `${DEBUG_GOALS_DIR}/debug_goal.md`;
				core.goalService.removeDebugFile(ctx, filePath);
				const prevId = prev.id;
				core.state.goal = null;
				if (core.focusedGoalId === prevId) {
					core.goalsById.delete(prevId);
					core.assignFocusedGoalId(null);
				}
				core.clearStoppedRuntimeState();
				core.syncGoalTools();
				core.updateUI(ctx);
				ctx.ui.notify("Debug goal removed", "info");
				return;
			}

			// Toggle on — create a new debug goal, write to temp dir
			debugGoalCounter++;
			const goal = createGoal({
				objective: "=== Goal ===\nObjective: Debug test goal",
				autoContinue: true,
				sisyphus: false,
			});
			goal.id = `debug-${nowIso().replace(/[:.]/g, "-")}-${debugGoalCounter}`;
			goal.createdAt = nowIso();
			goal.updatedAt = nowIso();
			goal.activePath = `${DEBUG_GOALS_DIR}/debug_goal.md`;
			core.goalService.writeDebugFile(ctx, goal.activePath, serializeGoalFile(goal));
			core.setGoal(goal, ctx, false, "created"); // no persist (we already wrote the file)
			ctx.ui.notify(`Debug goal created: ${goal.id}`, "info");
		}

		/** Inject 3-4 sample tasks into the current goal */
		function injectDebugTasks(ctx: ExtensionContext): void {
			if (!core.state.goal) {
				ctx.ui.notify("No goal to inject tasks into; create one first (Ctrl+Shift+N)", "warning");
				return;
			}
			const now = nowIso();
			const tasks: GoalTask[] = [
				{
					id: "t1",
					title: "Set up project structure",
					status: "complete",
					completedAt: now,
					subtasks: [
						{ id: "t1a", title: "Initialize repo", status: "complete", completedAt: now },
						{ id: "t1b", title: "Add build config", status: "pending" },
					],
				},
				{
					id: "t2",
					title: "Implement core feature",
					status: "pending",
				},
				{
					id: "t3",
					title: "Write tests",
					status: "pending",
				},
			];
			const next = cloneGoal(core.state.goal);
			next.taskList = { tasks, blockCompletion: false, proposedAt: now };
			next.updatedAt = now;
			core.setGoal(next, ctx);
			ctx.ui.notify("Sample tasks injected (3 tasks, 1 completed)", "info");
		}

		/** Stop mock audit timer if running */
		function stopMockAuditTimer(): void {
			if (debugMockAuditTimer) {
				clearInterval(debugMockAuditTimer);
				debugMockAuditTimer = null;
			}
		}

		/** Start a mock completion audit that transitions through phases */
		function startMockAudit(ctx: ExtensionContext): void {
			stopMockAuditTimer();
			const startedAt = Date.now();
			const phases: { phase: AuditorWidgetProgress["phase"]; atMs: number; label: string; percentage: number }[] = [
				{ phase: "tool_executing", atMs: 0, label: "Checking test results...", percentage: 10 },
				{ phase: "tool_executing", atMs: 800, label: "Verifying requirements...", percentage: 30 },
				{ phase: "thinking", atMs: 1800, label: "Evaluating completion criteria...", percentage: 60 },
				{ phase: "producing_report", atMs: 3200, label: "Writing audit report...", percentage: 85 },
				{ phase: "done", atMs: 4800, label: "Audit complete", percentage: 100 },
			];
			core.auditProgress = {
				recentOutput: [],
				phase: "running",
				elapsedMs: 0,
			};
			core.goalWidgetComponentRef.current?.invalidate();

			debugMockAuditTimer = setInterval(() => {
				const elapsed = Date.now() - startedAt;
				let currentPhase: AuditorWidgetProgress["phase"] = "done";
				let currentLabel = "Audit complete";
				let currentPct = 100;
				for (let i = phases.length - 1; i >= 0; i--) {
					if (elapsed >= phases[i].atMs) {
						currentPhase = phases[i].phase;
						currentLabel = phases[i].label;
						currentPct = phases[i].percentage;
						break;
					}
				}
				core.auditProgress = {
					phase: currentPhase,
					label: currentLabel,
					percentage: currentPct,
					elapsedMs: elapsed,
					recentOutput: core.auditProgress?.recentOutput ?? [],
				};
				if (currentPhase === "done") {
					if (core.auditProgress) core.auditProgress.recentOutput = [
						"✓ All requirements verified",
						"✓ Tests pass: 310/310",
						"✓ No truncation cap remaining",
					];
					stopMockAuditTimer();
					// Auto-clear audit after 3 more seconds
					setTimeout(() => {
						core.auditProgress = null;
						core.goalWidgetComponentRef.current?.invalidate();
					}, 3000);
				}
				core.goalWidgetComponentRef.current?.invalidate();
			}, 100);
			debugMockAuditTimer.unref?.();
		}

		/** Render task lines for the debug proposal dialog. */
		function renderDebugTaskLines(tasks: GoalTask[], indent = 0): string[] {
			const prefix = "  ".repeat(indent);
			const lines: string[] = [];
			for (const t of tasks) {
				const marker = t.status === "complete" ? "[x]" : t.status === "skipped" ? "[~]" : "[ ]";
				const lw = t.lightweightSubtasks ? " (lightweight)" : "";
				lines.push(`${prefix}${marker} ${t.id}: ${t.title}${lw}`);
				if (t.subtasks && t.subtasks.length > 0) {
					lines.push(...renderDebugTaskLines(t.subtasks, indent + 1));
				}
			}
			return lines;
		}

		/** Show the proposal dialog using real goal state — no hardcoded text */
		function openDebugProposal(ctx: ExtensionContext): void {
			// Build a fresh debug goal + tasks in memory for the dialog
			debugGoalCounter++;
			const goal = createGoal({
				objective: `=== Goal ===
Objective: Add collapsible task sections to the goal widget so large task lists are navigable

Success criteria:
- Tasks are grouped into sections by status (pending, active, complete) with visible section headers
- Each section header is toggleable — clicking it expands or collapses that section
- When collapsed, the section shows a header line only with a task count badge
- When expanded, tasks render with normal indentation and per-line styling
- Default state: pending section expanded, active and complete sections collapsed
- Section state is tracked per-render (no persistence needed)
- All 310 existing tests still pass

Boundaries:
- In scope: GoalWidgetComponent.render() grouping logic, section header toggling, expand/collapse state per render cycle
- Out of scope: task reordering, drag-and-drop, keyboard navigation for sections, persistence of section state across pi restarts
- Out of scope: modifying GoalTask or GoalRecord types

Constraints:
- Render width must respect the existing width parameter — no hardcoded widths
- Section collapse state is a render-only map, not stored in goal record
- Collapse toggle must be keyboard-accessible via existing widget interaction model
- Do not change the GoalWidgetComponent public API (constructor options, render signature)
- Section headers must use theme.fg("accent", ...) consistent with existing render patterns

Verification contract:
- Run npm test and confirm 310/310 pass (0 failures)
- Read render method and confirm task grouping logic exists
- Read expand/collapse toggle handler and confirm it inverts section state
- Confirm collapsed sections only render the header line with task count
- Confirm expanded sections render tasks with correct indentation and styling`,
				autoContinue: true,
				sisyphus: false,
			});
			goal.id = `debug-${nowIso().replace(/[:.]/g, "-")}-${debugGoalCounter}`;
			goal.createdAt = nowIso();
			goal.updatedAt = nowIso();

			const now = nowIso();
			const tasks: GoalTask[] = [
				{
					id: "t1",
					title: "Set up project structure",
					status: "complete",
					completedAt: now,
					subtasks: [
						{ id: "t1a", title: "Initialize repo", status: "complete", completedAt: now },
						{ id: "t1b", title: "Add build config", status: "pending" },
					],
				},
				{
					id: "t2",
					title: "Implement core feature",
					status: "pending",
					subtasks: [
						{ id: "t2a", title: "Status grouping logic", status: "pending" },
						{ id: "t2b", title: "Section header component", status: "pending" },
						{ id: "t2c", title: "Expand/collapse state", status: "pending" },
						{ id: "t2d", title: "Task count badge", status: "pending" },
					],
				},
				{ id: "t3", title: "Update tests", status: "pending" },
				{ id: "t4", title: "Manual TUI verification", status: "pending" },
			];
			goal.taskList = { tasks, blockCompletion: false, proposedAt: now };

			// Build proposal from goal state — exactly like the real flow
			const confirmationText = buildDraftConfirmationText({
				focus: "goal",
				originalTopic: "Refactor the goal widget component to support collapsible task sections",
				objective: goal.objective,
				autoContinue: goal.autoContinue,
			});

			// Append the task proposal to the confirmation text
			const taskLines = renderDebugTaskLines(tasks).map((l) => `│   ${l}`);
			const taskProposal = [
				"",
				"│ Proposed task list:",
				"",
				...taskLines,
			].join("\n");

			showProposalDialog(ctx, confirmationText + taskProposal, "goal", true);
		}
}
