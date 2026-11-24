# pi-goal-x Unified Dashboard and Goal Lifecycle Implementation Plan

## Delivery model

All work described in this document will be delivered in **one pull request**.

The pull request will include the data-model changes, runtime changes, unified dashboard, merged task view, goal-status redesign, audit presentation, migration handling, tests, documentation, and changelog updates. The work should be committed in reviewable internal commits, but it must land as a single coherent feature.

---

## 1. Objective

Upgrade `pi-goal-x` into a polished, complete goal-execution experience for long-running work.

The finished system must support the full lifecycle:

1. Guided goal creation.
2. Explicit confirmation.
3. Immediate automatic execution.
4. Persistent progress visibility.
5. Structured task and subtask tracking.
6. A clearly identified current task.
7. Visible verification requirements.
8. Human-readable recent activity.
9. Independent completion auditing.
10. Clear approval or rejection.
11. Reliable archival with a permanent record.

At any point, the user should be able to understand:

- What goal is focused.
- What state the goal is in.
- What the agent is doing now.
- What has already been completed.
- What remains.
- Which task and subtask are current.
- What evidence is required.
- How much active time and token usage has accumulated.
- Whether other goals remain open.
- Whether completion is being audited.
- Whether the audit passed or failed.
- Where the durable goal record is stored.

The design must work well in narrow and wide terminals, preserve compatibility with existing goal files, and avoid unnecessary terminal redraws that disrupt scrollback.

---

## 2. Design principles

### 2.1 One source of truth

The dashboard, `/goal-status`, completion summaries, and tests must all derive from the same presentation model.

There must not be separate formatting logic that gradually diverges between:

- The above-editor widget.
- The goal-status command.
- The task overlay.
- Audit progress.
- Completion messages.

### 2.2 Persist meaningful execution state

Anything important enough to show as factual progress must be derived from persisted state or the durable ledger.

Do not fabricate display-only state for:

- Current task.
- Task completion.
- Verification status.
- Audit result.
- Archive location.
- Recent activity.

### 2.3 Progressive disclosure

The default dashboard should be visually rich but compact.

More detail should be available by expanding the same dashboard rather than opening an unrelated interface.

The dashboard should have two presentation modes:

- **Compact mode:** persistent summary above the editor.
- **Expanded mode:** integrated task tree, current-task details, verification, evidence, and recent activity.

### 2.4 Terminal-first visual quality

The UI should be as polished as the host TUI permits:

- Balanced spacing.
- Clear visual hierarchy.
- Semantic color.
- Consistent borders.
- Stable alignment.
- Width-aware truncation.
- Useful progress bars.
- No line overflow.
- No dependence on color alone.

### 2.5 Minimal redraw churn

Normal goal rendering must not introduce a once-per-second redraw loop.

Elapsed time should refresh on meaningful events such as:

- Turn start.
- Turn end.
- Tool progress.
- Task updates.
- Goal updates.
- Focus changes.
- Explicit status requests.
- Audit progress.

The audit may retain a short-lived animation timer because it is a temporary foreground process.

---

## 3. Required user experience

## 3.1 Guided goal creation

Running:

```text
/goal <initial request>
```

must begin a guided drafting session.

The agent should:

- Identify material ambiguity.
- Ask only the questions required to make the goal executable.
- Offer recommended answers where appropriate.
- Allow custom answers.
- Build a complete objective.
- Propose a useful task plan when the work naturally decomposes.
- Define or extract a verification contract.
- Present the complete proposal for confirmation.

The confirmation experience must show:

- Goal type.
- Normalized objective.
- Constraints and boundaries.
- Automatic-continuation state.
- Auditor state.
- Proposed task hierarchy.
- Verification requirements.
- Token budget when configured.

The user must be able to:

- Confirm and begin.
- Continue refining.
- Cancel without creating a goal.

No persistent goal may be created before confirmation succeeds.

## 3.2 Direct creation

The direct commands must continue to work:

```text
/goal-direct <complete objective>
/sisyphus-direct <ordered objective>
```

Direct creation should:

- Validate the objective.
- Extract verification requirements.
- Create the goal.
- Focus it for the current session.
- Persist it.
- Start accounting.
- Begin automatic continuation when enabled.

## 3.3 Immediate automatic execution

After confirmation or direct creation:

- The goal becomes focused.
- The active goal file is written.
- Accounting begins.
- The agent starts the first execution turn automatically.
- Productive turns continue until the goal pauses, blocks, reaches a budget, or enters completion review.

Automatic continuation must stop when:

- The user pauses the goal.
- The agent reports a blocker.
- The goal is unfocused.
- The goal reaches its token budget.
- A stale continuation is detected.
- The current turn performed no meaningful work.
- The user interrupts execution.
- Completion review begins.
- The goal is completed.

---

## 4. Unified dashboard

The current goal widget and task overlay will be merged into one unified dashboard component.

The separate task overlay should no longer be a parallel UI with separate formatting and navigation logic. Its useful behavior should move into the dashboard's expanded mode.

The existing task shortcut may be retained, but it should toggle the dashboard between compact and expanded task views.

Suggested behavior:

```text
Ctrl+Shift+T  Toggle expanded goal dashboard
```

If the host keybinding system supports a clearer default, use that instead, but keep the action discoverable in help and the dashboard footer.

## 4.1 Compact mode

Compact mode is always visible above the editor while a goal is focused.

Wide-terminal example:

```text
┌─ pi-goal-x ─ Add CSV export to reports ─────────────── 12m47s · 18.2K tok ─┐
│ ● In progress          Focused: yes        Other goals: 2                  │
│ Tasks  [██████░░░░] 3/5 · 60%                                              │
│ Current  t3 · Add the download button                                      │
│ Subtasks [███████░░░] 2/3 · 67%                                            │
│ Verify   Run npm test with zero failures.                                  │
│ File     .pi/goals/active_goal_...                                          │
└─ Enter/Ctrl+Shift+T: expand tasks ──────────────────────────────────────────┘
```

The exact shortcut hint should match the implemented interaction.

## 4.2 Expanded mode

Expanded mode replaces the separate task overlay and uses the same dashboard component.

It should show:

- Goal header.
- Goal status.
- Focus state.
- Time and token usage.
- Active or archived path.
- Overall task progress.
- Full task tree.
- Current task highlight.
- Current task verification contract.
- Current task evidence.
- Current task subtasks.
- Recent completed tasks.
- Recent activity.
- Goal-level verification contract.
- Other open goals.
- Useful keyboard hints.

Example:

```text
┌─ pi-goal-x ─ Add CSV export to reports ─────────────── 12m47s · 18.2K tok ─┐
│ Status: ● In progress   Focused: yes   Other goals: 2                      │
│ File: .pi/goals/active_goal_...                                             │
├─ Progress ──────────────────────────────────────────────────────────────────┤
│ [██████░░░░] 3/5 tasks · 60%                                               │
├─ Tasks ─────────────────────────────────────────────────────────────────────┤
│ ✓ t1  Review reports page and data source                                  │
│ ✓ t2  Implement filtered CSV export                                        │
│ ▸ t3  Add the download button                                              │
│   ✓ t3.1  Add loading state                                                 │
│   ✓ t3.2  Generate timestamped filename                                    │
│   ▸ t3.3  Add error handling                                                │
│ · t4  Add documentation                                                    │
│ · t5  Add and run tests                                                    │
├─ Current task ──────────────────────────────────────────────────────────────┤
│ t3 · Add the download button                                               │
│ Subtasks: [███████░░░] 2/3 · 67%                                           │
│ Contract: The button downloads a CSV using the active filters.              │
│ Evidence: Loading state and filename behavior implemented.                  │
├─ Verification ──────────────────────────────────────────────────────────────┤
│ Run npm test with zero failures.                                            │
├─ Recent activity ───────────────────────────────────────────────────────────┤
│ ✓ Completed filtered CSV serialization                                     │
│ ✓ Added loading and filename behavior                                      │
│ ▸ Started download error handling                                          │
└─ Esc/Ctrl+Shift+T: collapse ────────────────────────────────────────────────┘
```

## 4.3 Unfocused state

When open goals exist but none is focused:

```text
┌─ pi-goal-x ─ Goal focus required ───────────────────────────────────────────┐
│ 3 open goals are available.                                                │
│ Run /goal-focus to choose the goal for this session.                       │
└─────────────────────────────────────────────────────────────────────────────┘
```

## 4.4 Paused state

Paused goals should clearly show:

- Paused status.
- Who paused the goal.
- Pause reason.
- Suggested next action.
- Resume command.

## 4.5 Blocked state

Blocked goals should prominently show:

- Blocker.
- Suggested user action.
- Current task.
- Last useful progress.
- Resume or tweak command.

## 4.6 Budget-limited state

Budget-limited goals should show:

- Used and configured token budget.
- Percentage used.
- Goal status.
- Current task.
- Suggested next action.

## 4.7 Complete state

Before archival completes:

```text
┌─ pi-goal-x ─ Goal complete ─────────────────────────────────────────────────┐
│ ✓ All required work is complete.                                           │
│ Waiting for final archival.                                                │
└─────────────────────────────────────────────────────────────────────────────┘
```

After archival, the persistent dashboard should clear or focus the next goal according to existing settings.

---

## 5. Visual design specification

## 5.1 Border system

Use a consistent box-drawing system:

- `┌ ┐ └ ┘` for outer borders.
- `├ ┤` for section separators.
- `─` for horizontal rules.
- `│` for vertical edges.

The renderer must be capable of falling back to a simpler ASCII border if the host or environment cannot render box-drawing characters reliably.

## 5.2 Status symbols

Use symbols consistently:

- `●` running.
- `○` idle.
- `◐` paused.
- `⊘` blocked.
- `⛽` budget limited.
- `✓` complete.
- `◌` active audit stage.
- `·` pending.
- `✗` failed.
- `▸` current task or current subtask.

Status labels must remain explicit so the interface is understandable without symbols.

## 5.3 Progress bars

Use a fixed logical scale with width selected by available terminal space.

Examples:

```text
[██████░░░░] 3/5 · 60%
[███████░░░] 2/3 · 67%
```

Progress bars must:

- Clamp values to valid bounds.
- Handle zero tasks.
- Handle all-complete state.
- Avoid misleading percentages.
- Use semantic color where available.
- Remain readable without color.

## 5.4 Spacing and hierarchy

The dashboard should use:

- One-line title/header.
- Clear section separators.
- Consistent label widths where practical.
- One blank line only where it materially improves readability.
- Indentation for task hierarchy.
- Strong emphasis on the current task.
- Muted treatment for paths and secondary metadata.

## 5.5 Responsive layouts

Define explicit rendering modes.

### Wide: 100 columns and above

- Full border.
- Multiple fields on one line.
- Full task titles.
- Wider progress bars.
- Current-task details.
- Rich footer hints.

### Medium: 70–99 columns

- Full border.
- Mostly one field per line.
- Shorter progress bars.
- Truncated paths and contracts.
- Compact current-task block.

### Narrow: 50–69 columns

- Compact border.
- Short labels.
- Reduced metadata.
- One task line at a time.
- Current task and progress remain visible.

### Very narrow: below 50 columns

Render only the essential summary:

```text
┌ Goal · In progress ───────┐
│ CSV export                │
│ Tasks 3/5 · 60%           │
│ ▸ Add download button     │
│ Verify: npm test passes   │
└───────────────────────────┘
```

The renderer must never emit a line wider than the available terminal width.

## 5.6 ANSI and Unicode safety

All truncation and alignment must use visible-width-aware helpers.

Test with:

- ANSI colors.
- Unicode task titles.
- Double-width characters.
- Long paths.
- Long contracts.
- Long evidence.
- Long auditor names.

---

## 6. Shared dashboard view model

Create:

```text
extensions/widgets/goal-dashboard-model.ts
```

This module must contain pure data derivation only. It should not import TUI rendering components.

Suggested model:

```ts
export interface GoalDashboardModel {
  goalId: string;
  title: string;

  status: {
    code:
      | "running"
      | "idle"
      | "paused"
      | "blocked"
      | "budget_limited"
      | "complete";
    label: string;
    reason?: string;
    suggestedAction?: string;
  };

  focused: boolean;
  filePath?: string;

  usage: {
    activeSeconds: number;
    elapsedLabel: string;
    tokens: number;
    tokenLabel: string;
  };

  budget?: {
    used: number;
    total: number;
    percentage: number;
    remaining: number;
  };

  taskProgress?: {
    completed: number;
    total: number;
    percentage: number;
  };

  taskTree: DashboardTaskNode[];

  currentTask?: {
    id: string;
    title: string;
    depth: number;
    completedSubtasks: number;
    totalSubtasks: number;
    subtaskPercentage: number;
    verificationContract?: string;
    evidence?: string;
  };

  goalVerificationContract?: string;
  otherOpenGoals: number;
  recentActivity: GoalActivityItem[];
}

export interface DashboardTaskNode {
  id: string;
  title: string;
  status: "pending" | "complete" | "skipped";
  depth: number;
  isCurrent: boolean;
  verificationContract?: string;
  evidence?: string;
}
```

Add pure helpers:

```ts
deriveGoalDashboardModel(...)
deriveGoalStatus(...)
deriveTopLevelTaskProgress(...)
flattenTaskTree(...)
deriveCurrentTask(...)
deriveCurrentTaskSubtaskProgress(...)
deriveGoalActivity(...)
formatDashboardDuration(...)
formatCompactTokens(...)
formatBudget(...)
```

Use this model for:

- Persistent compact dashboard.
- Expanded dashboard.
- `/goal-status`.
- Audit transition back to normal display.
- Golden tests.
- Documentation examples.

---

## 7. Data model changes

## 7.1 Persist current task

Extend `GoalRecord`:

```ts
export interface GoalRecord {
  // Existing fields...
  currentTaskId?: string;
}
```

Keep it optional for compatibility.

Do not add `in_progress` to `TaskStatus`.

Task status should remain:

```ts
type TaskStatus = "pending" | "complete" | "skipped";
```

`currentTaskId` describes execution focus, while task status describes completion state.

## 7.2 Persist current subtask

A separate `currentSubtaskId` is not required if every task and subtask already has a globally unique ID.

`currentTaskId` may point to any node in the task tree.

The dashboard should derive:

- The current node.
- Its parent task when applicable.
- Its sibling/subtask progress.
- Its depth.

## 7.3 Add task-start ledger event

Add:

```ts
interface TaskStartedEvent {
  type: "task_started";
  goalId: string;
  taskId: string;
  at: string;
}
```

Use existing completion and skip events for terminal states.

## 7.4 Normalization rules

When loading a goal:

- Accept `currentTaskId` only when it references an existing pending task.
- Clear it when the task is complete.
- Clear it when the task is skipped.
- Clear it when the task no longer exists.
- Leave it absent for historical files.
- Do not rewrite old files solely because the field is absent.

For display only, if no persisted current task exists, the dashboard may fall back to the first pending task. The fallback must be visually or internally marked as inferred so it is not persisted accidentally.

## 7.5 Task-list replacement rules

When a task list is replaced or restructured:

- Preserve matching task statuses and evidence.
- Preserve `currentTaskId` only if the same ID remains pending.
- Otherwise clear it.
- Recompute dashboard state immediately.

---

## 8. Task tool changes

Extend `update_goal_task` to support explicit task execution focus.

Suggested input:

```ts
{
  task_id: string;
  action: "start" | "complete" | "skip";
  evidence?: string;
  reason?: string;
}
```

## 8.1 Start

Validation:

- A focused goal exists.
- The goal is active or valid for task editing.
- The task exists.
- The task is pending.

Effect:

- Set `currentTaskId`.
- Append `task_started`.
- Persist the goal.
- Refresh the dashboard.
- Include the task contract in the next continuation prompt.

## 8.2 Complete

Validation:

- The task exists.
- Required subtasks are complete unless lightweight rules permit otherwise.
- Required evidence is present.
- The task is not already complete or skipped.

Effect:

- Set status to complete.
- Save completion timestamp.
- Save evidence.
- Clear `currentTaskId` if it matches.
- Append `task_completed`.
- Optionally infer the next pending task for display.
- Refresh the dashboard.

## 8.3 Skip

Validation:

- The task exists.
- A reason is supplied when required.
- The task is not already terminal.

Effect:

- Set status to skipped.
- Save timestamp and reason.
- Clear `currentTaskId` if it matches.
- Append `task_skipped`.
- Refresh the dashboard.

---

## 9. Task progress semantics

## 9.1 Overall task progress

The main dashboard progress should count top-level tasks.

This keeps the main percentage aligned with major milestones.

A top-level task counts as done when it is:

- Complete.
- Skipped.

## 9.2 Expanded task tree

Expanded mode should show every task and subtask recursively.

Each task row should show:

- Completion marker.
- Current-task marker.
- ID.
- Title.
- Optional verification indicator.
- Optional evidence indicator.

Suggested markers:

```text
✓ complete
~ skipped
▸ current
· pending
```

## 9.3 Current-task subtask progress

For the current task:

- If it has direct children, show progress across those children.
- If the current task is itself a subtask, show progress among its siblings or omit the ratio if that would be confusing.
- Use one documented rule consistently.

Preferred rule:

- For a parent task, show direct-child completion.
- For a leaf task, omit subtask progress.

## 9.4 All tasks complete

When all top-level tasks are done:

```text
Tasks [██████████] 5/5 · 100%
Current: All tasks complete
```

The expanded dashboard should retain the completed task tree until audit or archival begins.

## 9.5 Tasks disabled

When tasks are disabled:

- Omit task sections.
- Keep goal status, verification, usage, path, and focus.
- Do not show empty separators.

---

## 10. Merging the existing task overlay

The useful behavior currently associated with the task overlay should be moved into the dashboard.

This includes:

- Recursive task rendering.
- Current selection.
- Task detail.
- Evidence.
- Verification contracts.
- Keyboard navigation where useful.
- Width-safe rendering.
- Task counts.
- Nested indentation.

Implementation direction:

1. Move reusable tree derivation into `goal-dashboard-model.ts`.
2. Move reusable task-row rendering into the dashboard renderer.
3. Add a dashboard expansion state to `GoalWidgetComponent`.
4. Route the task-overlay shortcut to `toggleExpanded()`.
5. Remove separate overlay registration after parity is achieved.
6. Retain compatibility helpers only where tests or external imports require them.
7. Update documentation and help text to describe one dashboard, not two interfaces.

The expanded dashboard should remain a passive status surface unless the current overlay already provides safe, well-tested navigation. Do not add task mutation directly to the dashboard in this change unless it can be done without confusing focus or input behavior.

---

## 11. Verification visibility

## 11.1 Goal-level verification

Show the goal-level verification contract in:

- Compact dashboard.
- Expanded dashboard.
- `/goal-status`.
- Completion review.
- Archive record.

Compact mode may show a truncated first line.

Expanded mode should show the complete contract, wrapped safely.

## 11.2 Task-level verification

Show the current task's verification contract in the current-task section.

The full task tree may show a small indicator for tasks with contracts, with the full contract shown when the task is current or selected.

## 11.3 Detailed summary

Update `detailedSummary` to include:

```text
Verification: <contract>
```

where a contract exists.

---

## 12. Human-readable activity feed

Create:

```text
extensions/goal-activity.ts
```

Suggested model:

```ts
export interface GoalActivityItem {
  at: string;
  kind:
    | "goal"
    | "task"
    | "verification"
    | "audit"
    | "archive";
  text: string;
}
```

Map durable events to readable activity:

```text
goal_created
→ Created and focused the goal.

task_started
→ Started “Add download button.”

task_completed
→ Completed “Implement CSV export.”

task_skipped
→ Skipped “Legacy fallback” — out of scope.

goal_tweaked
→ Updated the goal objective and task plan.

audit_started
→ Started independent completion review.

audit_approved
→ Independent auditor approved completion.

audit_rejected
→ Completion review requested additional work.

goal_archived
→ Archived the completed goal.
```

Rules:

- Prefer task title over task ID.
- Include evidence only when concise.
- Exclude low-value checkpoint noise.
- Deduplicate repeated lifecycle events.
- Default to the latest three to five useful entries.
- Preserve full history for verbose status and archived records.

---

## 13. `/goal-status` redesign

`/goal-status` should render the same unified dashboard model as the above-editor widget.

It should be visually polished, not a plain diagnostic dump.

## 13.1 Standard mode

Standard output should contain:

1. A static text rendering of the compact dashboard.
2. Current-task details.
3. Recent activity.
4. Last audit result when available.

Example:

```text
┌─ pi-goal-x ─ Add CSV export to reports ─────────────── 12m47s · 18.2K tok ─┐
│ ● In progress          Focused: yes        Other goals: 2                  │
│ Tasks  [██████░░░░] 3/5 · 60%                                              │
│ Current  t3 · Add the download button                                      │
│ Subtasks [███████░░░] 2/3 · 67%                                            │
│ Verify   Run npm test with zero failures.                                  │
│ File     .pi/goals/active_goal_...                                          │
├─ Recent activity ───────────────────────────────────────────────────────────┤
│ ✓ Completed filtered CSV serialization                                     │
│ ✓ Added loading and filename behavior                                      │
│ ▸ Started download error handling                                          │
└─────────────────────────────────────────────────────────────────────────────┘
```

The command output should not include effective settings by default.

## 13.2 Verbose mode

Add:

```text
/goal-status verbose
```

Verbose output may include:

- Goal ID.
- Revision.
- Full objective.
- Complete task tree.
- Full task evidence.
- Full verification contracts.
- Recent ledger history.
- Effective settings and provenance.
- Token budget detail.
- Pause or blocker detail.
- Active and archived paths.
- Last audit report.

## 13.3 Expanded dashboard parity

The standard `/goal-status` output should closely match the expanded dashboard's information hierarchy.

The two surfaces may differ in interaction, but not in data or terminology.

---

## 14. Guided drafting improvements

Preserve the existing questionnaire capabilities:

- Single or multiple questions.
- Recommended answers.
- Custom answers.
- Tab navigation.
- Auditor toggle.
- Continue refining.
- Cancel.
- Terminal-height safety.

Add a durable proposal summary to the terminal transcript:

```text
Proposed objective:
Add CSV export to the reports page using active filters and visible-column
order, with documentation and passing tests.

Proposed plan:
1. Review the reports page and data source.
2. Implement filtered CSV export.
3. Add the download control.
4. Add documentation.
5. Add and run tests.

Verification:
Run npm test with zero failures.

Automatic continuation: enabled
Independent auditor: enabled
```

After confirmation:

```text
✓ Goal created and focused.
Continuing automatically with the confirmed plan.
```

Expanded detail may include:

- Goal ID.
- Active file path.
- Task count.
- Verification contract.
- Auditor configuration.
- Token budget.

Capture questionnaire answers before clearing draft state so the confirmed goal report can include them reliably.

---

## 15. Structured audit dashboard

The audit view should use the same visual system as the goal dashboard.

## 15.1 Audit model

Extend auditor progress with structured checks:

```ts
export type AuditCheckState =
  | "pending"
  | "running"
  | "passed"
  | "failed";

export interface AuditCheck {
  id:
    | "objective"
    | "verification"
    | "tasks"
    | "workspace"
    | "decision";
  label: string;
  state: AuditCheckState;
  detail?: string;
}

export interface AuditorDashboardModel {
  auditorLabel: string;
  elapsedMs: number;
  percentage?: number;
  checks: AuditCheck[];
  currentTool?: string;
  currentToolArgs?: string;
  recentOutput: string[];
}
```

## 15.2 Audit stages

The auditor should report:

1. Objective and success criteria.
2. Verification contracts.
3. Tasks and evidence.
4. Workspace inspection.
5. Final decision.

## 15.3 Audit rendering

Example:

```text
┌─ Independent completion audit ─ provider/model ─────────────────── 2m18s ─┐
│ ✓ Objective and success criteria                                           │
│ ✓ Verification contracts                                                   │
│ ✓ Tasks and recorded evidence                                              │
│ ◌ Workspace inspection                                                     │
│ · Final decision                                                           │
│ [███████░░░] 72%                                                           │
└─ Esc: stop audit ───────────────────────────────────────────────────────────┘
```

Raw tools and recent output should appear only:

- In expanded audit mode.
- In debug mode.
- When an unexpected audit failure needs diagnostic detail.

## 15.4 Audit result

Approval:

```text
┌─ Audit result ─ APPROVED ───────────────────────────────────────────────────┐
│ ✓ Objective satisfied.                                                     │
│ ✓ Verification requirements satisfied.                                     │
│ ✓ Required tasks and evidence accepted.                                    │
└─────────────────────────────────────────────────────────────────────────────┘
```

Rejection:

```text
┌─ Audit result ─ CHANGES REQUIRED ───────────────────────────────────────────┐
│ ✗ Tests were not run after the final implementation change.                │
│ ✗ Task “Update documentation” has no completion evidence.                  │
└─────────────────────────────────────────────────────────────────────────────┘
```

On rejection:

- Keep the goal open.
- Persist the report.
- Add findings to the next continuation.
- Restore the normal dashboard.
- Show the required next work clearly.

---

## 16. Completion and archival flow

## 16.1 Completion request

When the agent requests completion:

- Reconcile the goal from disk.
- Validate lifecycle state.
- Validate task-completion rules.
- Account remaining usage.
- Append `completion_requested`.
- Launch the auditor.

## 16.2 Auditor disabled

When auditing is disabled:

- Record `audit_skipped`.
- State why it was skipped.
- Use the same completion transaction.
- Do not present the result as independently approved.

## 16.3 User abort during audit

Preserve the existing Escape flow.

The user should be able to:

- Continue working.
- Complete without audit.

Completing without audit must:

- Record the bypass explicitly.
- Never be labeled approved.
- Continue through normal archival.

## 16.4 Approval

On approval:

- Persist the audit report.
- Mark the goal complete.
- Stop continuation.
- Allow the final executor summary.
- Archive at the correct deferred lifecycle point.

## 16.5 Rejection

On rejection:

- Persist the audit report.
- Keep the goal open.
- Surface actionable findings.
- Resume normal work state.
- Allow the agent to continue correcting the implementation.

## 16.6 Archive transaction

The archive operation should:

1. Acquire the goal lock.
2. Confirm the expected revision.
3. Write the completed archived record.
4. Retire the active record.
5. Append `goal_archived`.
6. Update memory.
7. Clear or change focus according to settings.
8. Emit the actual archive path.

Success message:

```text
Goal archived.
File: .pi/goals/archived/goal_...
```

Failure behavior:

- Do not claim success.
- Keep the complete record recoverable.
- Report the remaining active or temporary path.
- Write a diagnostic ledger event when possible.

---

## 17. Repository changes

## 17.1 New files

```text
extensions/widgets/goal-dashboard-model.ts
extensions/widgets/goal-dashboard-renderer.ts
extensions/goal-activity.ts
tests/goal-dashboard-model.test.ts
tests/goal-activity.test.ts
tests/goal-dashboard-golden.test.ts
tests/e2e/goal-lifecycle-dashboard.test.ts
docs/unified-dashboard.md
```

`goal-dashboard-renderer.ts` may be folded into `goal-widget.ts` if keeping a separate renderer does not improve clarity. The important requirement is to keep pure model derivation separate from TUI integration.

## 17.2 Primary modified files

```text
extensions/goal-record.ts
extensions/goal-ledger.ts
extensions/goal-task-tools.ts
extensions/goal-format.ts
extensions/goal-state.ts
extensions/goal-drafting.ts
extensions/goal-questionnaire.ts
extensions/goal-completion.ts
extensions/goal-auditor.ts
extensions/goal-commands.ts
extensions/widgets/goal-widget.ts
extensions/widgets/task-list-overlay.ts
extensions/storage/goal-files.ts
README.md
CHANGELOG.md
tests/.test-manifest.json
```

## 17.3 Supporting changes as required

```text
extensions/goal-policy.ts
extensions/goal-prompts.ts
extensions/goal-core-tools.ts
extensions/goal-service.ts
extensions/goal-events.ts
tests/tui-test-utils.ts
```

---

## 18. Implementation sequence inside the single PR

The pull request should be developed in this order to keep the branch continuously testable.

### 18.1 Presentation foundation

- Add the dashboard model.
- Add task-tree flattening.
- Add progress derivation.
- Add status derivation.
- Add activity derivation.
- Add model tests.

### 18.2 Current-task persistence

- Add `currentTaskId`.
- Add normalization.
- Add task-start events.
- Extend task tools.
- Add migration and lifecycle tests.

### 18.3 Unified dashboard component

- Add compact rendering.
- Add expanded rendering.
- Merge task-overlay behavior.
- Add expansion state.
- Add responsive layouts.
- Add width and golden tests.

### 18.4 Goal-status integration

- Render from the same dashboard model.
- Add standard and verbose modes.
- Remove default settings noise.
- Add activity and last-audit sections.

### 18.5 Drafting polish

- Add durable proposal summaries.
- Improve confirmation output.
- Preserve questionnaire answer summaries.

### 18.6 Audit integration

- Add structured audit stages.
- Add audit dashboard rendering.
- Add approval and rejection result cards.
- Preserve Escape and bypass behavior.

### 18.7 Completion and archival polish

- Add explicit archive-success output.
- Add archive-failure handling.
- Add the complete end-to-end lifecycle test.

### 18.8 Documentation and final verification

- Update README.
- Add unified dashboard documentation.
- Update command help.
- Add migration notes.
- Update changelog.
- Run all checks.

---

## 19. Testing strategy

## 19.1 Dashboard model tests

Cover:

- Active goal without tasks.
- Active goal with partial tasks.
- All tasks complete.
- Current top-level task.
- Current nested task.
- Current parent with subtasks.
- Current leaf task.
- Invalid `currentTaskId`.
- Removed current task.
- Skipped tasks.
- Disabled tasks.
- Goal verification.
- Task verification.
- Multiple open goals.
- Token budget.
- Paused state.
- Blocked state.
- Budget-limited state.
- Complete state.

## 19.2 Task lifecycle tests

Verify:

- `start` sets `currentTaskId`.
- Starting another task replaces it.
- Completing the current task clears it.
- Skipping the current task clears it.
- Structural task changes preserve a valid current ID.
- Structural task changes clear an invalid ID.
- Existing status, timestamps, and evidence remain intact.

## 19.3 Activity tests

Verify:

- Ledger events map to readable text.
- Task titles replace IDs.
- Checkpoint noise is excluded.
- Evidence is truncated safely.
- Events are correctly ordered.
- Duplicate events are merged.
- Default output is capped.
- Full history remains available.

## 19.4 Dashboard golden tests

Render compact and expanded dashboards at:

```text
40 columns
50 columns
60 columns
80 columns
100 columns
140 columns
```

Cover:

- Running goal.
- Running goal with tasks.
- Current task with subtasks.
- Long objective.
- Long file path.
- Long verification contract.
- Unicode content.
- Paused goal.
- Blocked goal.
- Budget-limited goal.
- Complete goal.
- Unfocused state.
- Audit running.
- Audit approved.
- Audit rejected.

For every rendered line:

```ts
assert.ok(visibleWidth(line) <= width);
```

## 19.5 Dashboard interaction tests

Verify:

- Compact mode is the default.
- Task shortcut expands the dashboard.
- The same shortcut or Escape collapses it.
- Expanded mode does not corrupt editor input.
- Goal state updates are visible in both modes.
- Audit mode temporarily replaces the normal view.
- Normal mode returns after rejection or audit completion.
- Separate task-overlay registration is removed.

## 19.6 Drafting tests

Verify:

- Questions precede proposals when needed.
- Recommended answers work.
- Custom answers work.
- Proposal includes objective, tasks, verification, continuation, and auditor state.
- Continue refining does not create a goal.
- Cancel does not create a goal.
- Confirm creates exactly one goal.
- The goal is focused.
- Questionnaire answers appear in the creation report.
- Draft state survives compaction.
- Stale tweak drafts are safely discarded.

## 19.7 Audit tests

Verify each transition:

```text
objective: pending → running → passed
verification: pending → running → passed
tasks: pending → running → passed
workspace: pending → running → passed
decision: pending → running → passed or failed
```

Also verify:

- Auditor identity is shown.
- Percentage is clamped.
- Expanded diagnostics retain tool details.
- Escape behavior works.
- Rejection keeps the goal open.
- Approval enters deferred completion.
- The normal dashboard returns correctly.

## 19.8 Persistence and migration tests

Legacy goal files must:

- Load without `currentTaskId`.
- Preserve task state.
- Preserve usage.
- Preserve verification.
- Preserve lifecycle status.
- Archive correctly.

New goal files must:

- Persist `currentTaskId`.
- Remove stale IDs during normalization.
- Survive restart.
- Survive session refocus.
- Preserve revision safety.

## 19.9 End-to-end lifecycle test

Create a deterministic lifecycle scenario:

1. Start a guided goal.
2. Answer clarification questions.
3. Confirm a five-task plan.
4. Verify goal creation, focus, persistence, and automatic continuation.
5. Start the first task.
6. Complete three of five top-level tasks.
7. Verify the compact dashboard shows:
   - `3/5`.
   - `60%`.
   - Current task.
   - Subtask progress.
   - Verification contract.
8. Expand the dashboard.
9. Verify the complete task tree and current-task block.
10. Complete all tasks.
11. Request completion.
12. Simulate all audit stages.
13. Approve.
14. Verify deferred completion.
15. Verify archive creation.
16. Verify the final archive path.
17. Reload and verify the goal is no longer active.

## 19.10 Full regression suite

All existing tests must remain green, including coverage for:

- Accounting.
- Automatic continuation.
- Auditor selection.
- Drafting.
- Escape handling.
- Goal focus.
- Mutation boundaries.
- Overflow.
- Task rendering.
- Deferred archival.
- Session growth.
- Tool visibility.
- Width safety.

Required commands:

```text
npm run check
npm test
npm run test:integration
npm run test:all
```

Run any project benchmark or self-check commands required by the repository before merge.

---

## 20. Backward compatibility

The change must preserve:

- Existing goal-file formats.
- Existing archived goals.
- Existing settings.
- Existing slash commands.
- Existing direct-goal behavior.
- Existing Sisyphus behavior.
- Existing auditor configuration.
- Existing task evidence.
- Existing focus behavior.

Compatibility rules:

- New persisted fields are optional.
- Historical records normalize safely.
- Existing task IDs remain authoritative.
- Existing command names do not change.
- Existing task-overlay shortcut may be retained, but it now expands the unified dashboard.
- Headless behavior remains functional without TUI rendering.
- Audit-disabled behavior remains explicit and distinguishable from approval.

---

## 21. Documentation updates

Update the README to explain:

- Guided goal creation.
- Immediate automatic continuation.
- The unified dashboard.
- Compact and expanded modes.
- Current-task tracking.
- Task-tree integration.
- Verification visibility.
- Recent activity.
- Independent auditing.
- Approval, rejection, and archival.
- Keyboard shortcuts.
- Standard and verbose goal-status modes.

Add:

```text
docs/unified-dashboard.md
```

The document should include:

- Layout examples for wide and narrow terminals.
- Status-state examples.
- Expanded task view.
- Audit view.
- Keybindings.
- Accessibility and width behavior.
- Migration behavior.

Update `CHANGELOG.md` with:

- Unified dashboard.
- Merged task overlay.
- Persisted current-task state.
- Improved goal-status.
- Structured audit progress.
- Archive-result improvements.

---

## 22. Acceptance criteria

The single pull request is complete when all of the following are true:

- `/goal` supports clarification and explicit confirmation.
- No guided goal is created before confirmation.
- Confirmed goals are immediately focused and started.
- Automatic continuation works without repetitive user prompts.
- A polished dashboard is visible for focused goals.
- The dashboard has compact and expanded modes.
- The existing task overlay is merged into the dashboard.
- The expanded dashboard shows the complete task tree.
- The current task is persisted and clearly highlighted.
- Current-task subtask progress is visible.
- Task and goal verification contracts are visible.
- Time, token usage, focus, path, and other open goals are visible.
- Progress is derived from persisted goal state.
- Recent activity is derived from the durable ledger.
- `/goal-status` uses the same presentation model.
- `/goal-status` is visually polished.
- `/goal-status verbose` contains diagnostic detail.
- Completion launches an independent auditor.
- Audit progress uses a structured checklist.
- Auditor identity and elapsed time are visible.
- Audit rejection leaves the goal open with actionable feedback.
- Audit approval proceeds through deferred archival.
- Successful archival reports the real archive path.
- Failed archival is never reported as successful.
- Legacy goal files continue to work.
- Compact and expanded layouts fit narrow and wide terminals.
- No rendered line exceeds terminal width.
- Normal goal rendering does not disrupt scrollback with continuous redraws.
- Separate task-overlay registration is removed after feature parity.
- All existing tests pass.
- New model, lifecycle, rendering, migration, audit, interaction, and end-to-end tests pass.
- README, dashboard documentation, and changelog are updated.
