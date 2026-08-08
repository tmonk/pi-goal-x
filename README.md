# pi-goal-x

`pi-goal-x` is a goal-management extension for [pi](https://github.com/earendil-works/pi-coding-agent).

It gives the agent a persistent objective, a structured plan, visible progress, and an independent completion review. Goals remain available across sessions, so the agent can continue working with the same objective and progress record.

## Features

### Regular goals

Regular goals describe an outcome for the agent to achieve. The agent can investigate the work, choose an appropriate sequence, create tasks, and adapt its plan as it progresses.

Regular goals work well for research, implementation, debugging, documentation, and other work where the desired result is clear and the execution path can be determined during the task.

### Sisyphus goals

Sisyphus goals describe work that should be completed in a specific order. The agent follows the listed sequence one step at a time and preserves dependencies between steps.

Sisyphus goals work well for migrations, staged refactors, release procedures, data-processing workflows, and other tasks where each step prepares the way for the next.

### Guided goal creation

The `/goal` and `/sisyphus` commands start a guided drafting process. The agent can ask focused questions, clarify the objective, and propose a task plan for confirmation.

The proposal is written to the conversation as a durable summary (objective, plan, verification, automatic continuation, auditor state); confirming it creates and focuses the goal and starts working automatically.

### Direct goal creation

The `/goal-direct` and `/sisyphus-direct` commands create a goal immediately from a complete objective.

### Persistent progress

Open goals are stored in `.pi/goals/`. Their objectives, tasks, status, and progress remain available across sessions and context changes.

### Multiple open goals

A project can contain several open goals. Each session focuses on one goal at a time, and you can switch between them with `/goal-focus`.

### Tasks and subtasks

Goals can include structured tasks and subtasks. The agent updates their status and records completion evidence as work progresses.

### Verification contracts

Goals and tasks can include plain-text completion requirements, such as:

```text
Run npm test with zero failures.
```

The completion auditor checks these requirements against evidence from the workspace.

### Independent completion review

When the agent reports a goal as complete, a separate pi agent reviews the objective, tasks, verification requirements, and workspace.

Approved goals are archived as complete. Goals requiring additional work remain open with review feedback.

### Visible status

An above-editor widget shows the focused goal: its status, focus state, other open goals, time and token usage, task progress, the current task, and the goal file path.

Press `Ctrl+Shift+T` to expand the widget into the full unified dashboard — the complete task tree with the current task highlighted, the current task's verification contract and evidence, the goal-level verification contract, and a recent-activity feed derived from the durable goal ledger. Press `Esc` or `Ctrl+Shift+T` again to collapse it.

During an independent completion audit the widget shows a structured audit dashboard (five review stages and a progress bar); after the audit it shows the approval or changes-required result, then returns to the normal view.

### Goal controls

Slash commands let you pause, resume, revise, select, unfocus, and archive goals.

### Configurable behaviour

The settings menu controls task support, verification contracts, subtask depth, goal selection, and the completion auditor.

## Install

Install from npm:

```bash
pi install npm:pi-goal-x
```

Install from a local checkout:

```bash
pi install .
```

Run it once from a local checkout:

```bash
pi -e .
```

## Choose a goal style

Use a **regular goal** when you have a clear outcome and want the agent to determine how to reach it.

For example:

```text
/goal Add account deletion to the application, including the user interface, data cleanup, documentation, and tests.
```

The agent can decide how to investigate the application, divide the work, and order the implementation.

Use a **Sisyphus goal** when you already know the required sequence and want the agent to follow it step by step.

For example:

```text
/sisyphus Migrate authentication in this order:
1. Add the new token validator.
2. Update login to use it.
3. Update session refresh to use it.
4. Remove the old validator.
5. Run the authentication test suite.
```

The agent completes the migration in the stated order, preserving the dependency between each stage.

## Create a guided goal

Start a guided regular goal:

```text
/goal add structured logging to the authentication module
```

The agent can ask questions and propose a complete objective and task plan. Confirm the proposal to create the goal and begin work.

Start a guided Sisyphus goal:

```text
/sisyphus prepare and perform the customer-data migration
```

The agent can help define the ordered steps and present them for confirmation.

## Create a goal directly

Use `/goal-direct` when the objective already describes a complete outcome:

```text
/goal-direct Add a health-check endpoint that verifies database connectivity, returns the service status as JSON, documents the endpoint, and includes passing tests.
```

This creates and focuses the regular goal immediately.

Use `/sisyphus-direct` when the objective already contains the complete ordered process:

```text
/sisyphus-direct Upgrade the payment integration in this order:
1. Add support for the new API version.
2. Update payment creation.
3. Update refund handling.
4. Migrate the test fixtures.
5. Run the payment test suite.
6. Remove the old API integration.
```

This creates and focuses the ordered goal immediately.

## Manage goals

List open goals:

```text
/goal-list
```

Show the focused goal:

```text
/goal-status
```

Select an open goal for the current session:

```text
/goal-focus
```

Remove the current session’s focus while keeping the goal open:

```text
/goal-unfocus
```

Revise the focused objective and task plan:

```text
/goal-tweak <change>
```

Pause or resume the focused goal:

```text
/goal-pause
/goal-resume
```

Archive the focused goal:

```text
/goal-clear
```

Cancel an unconfirmed guided draft:

```text
/goal-cancel
```

Open the settings menu:

```text
/goal-settings
```

Pressing `Esc` during active work pauses the goal.

## Tasks and verification

The agent can divide a goal into tasks and subtasks and update them as work progresses. The current task is tracked explicitly (persisted as the goal's execution focus) and highlighted in the dashboard; starting a task with `update_goal_task(status="start")` sets it, and completing or skipping it clears it.

Verification contracts describe the evidence required for completion. They can apply to the entire goal or to an individual task.

Examples include:

```text
Run npm test with zero failures.
```

```text
Confirm the new command appears in the help menu.
```

```text
Verify that the generated report contains every required section.
```

## Unified dashboard

`pi-goal-x` renders one dashboard component in two modes; the above-editor widget, `/goal-status`, and the completion flow all derive from the same presentation model, so they can never disagree about the data.

### Compact mode

Always visible above the editor while a goal is focused:

```text
╭─ pi-goal-x ─ Add CSV export to reports ────────────────────────────╮
│ goal: running [12m47s 18.2K] (+2 open)                             │
├─ Tasks · ✓3 done · 2 open ──────────── [█████░░░] · Sub 2/3 [██░░] ┤
│ ✓ t1  Review reports page and data source                          │
│ ✓ t2  Implement filtered CSV export                                │
│ ▸ t3  Add the download button ☑ ▸ 2/3                              │
│ · t4  Add documentation                                            │
│ … +1 more task                                                     │
│ Current  t3 · Add the download button                              │
│ Verify   Run npm test with zero failures.                          │
│ File     .pi/goals/active_goal_...                                 │
╰─ Ctrl+Shift+T: expand tasks─────── Ctrl+Shift+A: toggle auditor ● ─╯
```

The green/gray `●` at the bottom-right of the border is the focused goal's
independent-auditor status (green = on, gray = off). Wide/medium footers
right-align the `Ctrl+Shift+A: toggle auditor` note beside the dot — it
shows the shortcut that turns the auditor on and off; narrow/minimal keep
just the dot.

### Expanded mode

`Ctrl+Shift+T` expands the same component: full task tree (✓ complete, ▸ current, ~ skipped, · pending), the current-task block with its contract and evidence, goal-level verification, and recent activity.

```text
├─ Progress ──────────────────────────────────────────────────────────┤
│ [██████░░░░] 3/5 tasks · 60%                                       │
├─ Tasks ─────────────────────────────────────────────────────────────┤
│ ✓ t1  Review reports page and data source                          │
│ ✓ t2  Implement filtered CSV export                                │
│ ▸ t3  Add the download button                                      │
│   ✓ t3.1  Add loading state                                         │
│   · t3.3  Add error handling                                        │
│ · t4  Add documentation                                             │
├─ Current task ──────────────────────────────────────────────────────┤
│ t3 · Add the download button                                        │
│ Subtasks [███████░░░] 2/3 · 67%                                     │
│ Contract: The button downloads a CSV using the active filters.      │
├─ Verification ──────────────────────────────────────────────────────┤
│ Run npm test with zero failures.                                    │
└─ Esc/Ctrl+Shift+T: collapse ────────────────────────────────────────┘
```

Every rendered line is width-aware: the dashboard adapts to wide, medium, narrow, and very-narrow terminals and never overflows the available width. It follows a pastel theme palette with a monochrome fallback: a light steel-gray-blue outer frame (`mdLink`) with gray interior rules, pastel-amber task rows with colour-coded markers and ids (✓ complete green, ▸ current teal, ~ skipped gray, · pending amber), accent-tinted progress and brand, and status symbols in their state color.

The task list is a scrollable **window** that by default is anchored to the most recently completed task — recent completions stay visible instead of the earliest tasks. The expanded dashboard is modal and scrolls with the plain `↑/↓`, `PgUp/PgDn`, and `Home/End` keys; the compact widget keeps the editor's arrows untouched and scrolls with the free `Ctrl+Shift+↑/↓` chords (pi leaves those unbound). A new completion re-anchors the window.

See [`docs/unified-dashboard.md`](docs/unified-dashboard.md) for the full layout specification, status states, scrolling behavior, and migration behavior.

## Completion review

When the agent reports a goal as complete, `pi-goal-x` starts an independent completion review.

The auditor examines:

* The objective
* The task plan and recorded evidence
* Verification contracts
* The current workspace

An approved goal is archived as complete, and the archive path is reported. Review feedback is added to any goal that requires further work, and the dashboard shows the changes-required result before returning to the normal view.

Press `Esc` to stop an active audit (completing without audit is recorded explicitly and never presented as independently approved).

## Goal storage

Open goals are stored in:

```text
.pi/goals/
```

Completed and cleared goals are stored in:

```text
.pi/goals/archived/
```

Each session can focus on one goal while the project keeps other goals open.

## Commands

```text
/goal [seed]                 Start a guided regular goal
/sisyphus [seed]             Start a guided ordered goal
/goal-direct <objective>     Create a regular goal immediately
/sisyphus-direct <objective> Create an ordered goal immediately
/goal-list                   List open goals
/goal-status                 Show the focused goal (unified dashboard)
/goal-status verbose         Show the focused goal with full diagnostic detail
/goal-focus                  Select an open goal
/goal-unfocus                Remove the session’s focus
/goal-tweak <change>         Revise the focused goal
/goal-pause                  Pause the focused goal
/goal-resume                 Resume a paused or blocked goal
/goal-settings               Open the settings menu
/goal-clear                  Archive the focused goal
/goal-cancel                 Cancel the current draft
```

## Configuration

Settings are stored in:

```text
.pi/pi-goal-x-settings.json
```

Use `/goal-settings` to configure task lists, verification contracts, subtask depth, automatic goal selection, and completion auditing. Goal objectives have no hard length limit by default; set `objectiveMaxChars` (or `PI_GOAL_OBJECTIVE_MAX_CHARS`, `0` = no limit) to cap objective length across `create_goal`, `propose_goal_draft`, and `/goal-tweak`.

Configure the task shortcuts in the same file when the terminal captures the defaults:

```json
{
  "keybindings": {
    "dashboard": {
      "toggleExpand": "ctrl+shift+t",
      "scrollUp": "ctrl+shift+up",
      "scrollDown": "ctrl+shift+down"
    }
  }
}
```

The default task bindings are `ctrl+shift+t`, `ctrl+shift+up`, and `ctrl+shift+down`. Use pi key names such as `ctrl+shift+up`.

## License

MIT
