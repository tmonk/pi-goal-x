<div align="center">
  <img src="pi-goal-x.png" alt="pi-goal-x logo" width="560">
</div>

<div align="center">
  <a href="https://pi.dev/packages?type=extension" target="_blank" rel="noopener noreferrer">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="assets/badge-dark.svg">
      <img src="assets/badge-light.svg" alt="TOP 0.3% of Pi coding agent extensions: #7 of 3,275 by downloads · Sep 22, 2026 (best recorded rank)" width="480">
    </picture>
  </a>
</div>

# pi-goal-x

Adds `/goal` functionality to [pi](https://pi.dev). The agent helps you define a goal and plan, continues working on it automatically, and submits the result to an optional independent completion auditor.

The extension saves goal objectives, tasks, and progress across sessions. You can pause, resume, revise, or switch goals as your work changes.

## Install

```bash
pi install npm:pi-goal-x
```

## Create a goal

```text
/goal Add CSV export to the reports page, with documentation and tests.
```

The agent discusses the goal with you, asks focused questions where needed, and proposes an objective, task plan, and completion requirements. You review the proposal and choose whether to use the completion auditor. Once you confirm, the agent starts working and continues automatically while the goal is active.

You can specify completion requirements, such as passing the test suite or producing a report with every required section. The agent tracks tasks and subtasks, records evidence, and works toward those requirements. If it gets blocked and needs your input, you can resolve the issue and resume.

If you already have a complete objective, use `/goal-direct <objective>` to create the goal and start immediately without drafting.

## Goal types

| Type | Behaviour | Example uses |
| --- | --- | --- |
| **Regular** — `/goal` | An outcome to achieve, with the agent choosing and adapting the plan. | Features, debugging, research, and documentation. |
| **Sisyphus** — `/sisyphus` | An ordered plan that the agent follows one step at a time. | Migrations, staged refactors, and release procedures. |

For an ordered goal, you can provide the steps or define them with the agent:

```text
/sisyphus Migrate authentication in this order:
1. Add the new token validator.
2. Update login and session refresh to use it.
3. Remove the old validator.
4. Run the authentication tests.
```

Use `/sisyphus-direct <objective>` to start an ordered goal without drafting.

## Tasks and subtasks

The agent can divide a goal into tasks and subtasks, each describing part of the work required to complete it. During guided goal creation, you review the proposed plan before work begins.

For example, a CSV export goal could have this task plan:

```text
Add CSV export to reports
├─ Review the report data and active filters
├─ Implement CSV export
│  ├─ Generate the CSV from filtered results
│  └─ Add a download button
├─ Test the export
└─ Document how to use it
```

As work progresses, the agent marks the current task, records completed work, and explains any skipped tasks. The dashboard shows what is done and what remains, including progress within subtasks. Task progress is saved when you pause and remains available in later sessions.

Tasks can also have their own completion requirements—for example, “The download contains only rows matching the active filters.” The agent records evidence against those requirements, and the completion auditor uses that evidence when reviewing the overall result.

Use `/goal-tweak <change>` to discuss revisions to the goal and its plan. Task tracking, completion requirements, and subtask depth are configurable in `/goal-settings`.

## Completion auditor

When enabled, a separate agent reviews the work before the goal is accepted as complete. It checks the objective, tasks, recorded evidence, completion requirements, and workspace.

If the auditor approves, the goal is archived as complete. If it identifies unmet requirements, the goal remains open with feedback describing the work still needed. You can choose the auditor model in `/goal-settings` and toggle auditing for the focused goal with `Ctrl+Shift+A`.

## Progress and goal controls

The dashboard above the editor shows the goal's status, task progress, current task, elapsed time, and token usage. Press `Ctrl+Shift+T` to expand it for the full task tree, completion requirements, evidence, and recent activity. Audit progress and results appear there too.

A project can have several open goals, with one focused goal per session. Switch with `/goal-focus`, pause with `/goal-pause`, or use `/goal-tweak` to discuss changes to the current goal. Pressing `Esc` during active work also pauses the goal; in the expanded dashboard, it collapses the view.

## Commands

| Command | What it does |
| --- | --- |
| `/goal [idea]` | Discuss, plan, and confirm a regular goal. |
| `/sisyphus [idea]` | Discuss, plan, and confirm an ordered goal. |
| `/goal-direct <objective>` | Create and start a regular goal immediately. |
| `/sisyphus-direct <objective>` | Create and start an ordered goal immediately. |
| `/goal-list` | List open goals. |
| `/goal-status` | Show the focused goal and its progress. |
| `/goal-focus` | Choose an open goal to work on. |
| `/goal-unfocus` | Leave the current goal open without focusing on it. |
| `/goal-tweak <change>` | Revise the current goal with the agent. |
| `/goal-pause` | Pause work on the focused goal. |
| `/goal-resume` | Resume a paused or blocked goal. |
| `/goal-clear` | Archive the focused goal after confirmation. |
| `/goal-cancel` | Cancel an unconfirmed draft. |
| `/goal-settings` | Configure goal behaviour and the auditor. |

For troubleshooting, use `/goal-status verbose` for more detail, `/goal-status health` or `/goal-recovery` to check for problems, and `/goal-refresh` to reload saved goals and settings after external changes. `/goal-recovery repair` offers repairs after confirmation.

## Settings

Open `/goal-settings` to change these options. You can save defaults for all projects, override them for the current project, or remove an override to use the inherited value.

| Setting | What it controls |
| --- | --- |
| Explicit execution contracts (`strictExecutionContract`) | Opt-in ready/wait protocol with one missing-decision repair, then pause. Defaults to `false`: successful executions continue automatically. |
| Autonomous run allowance (`maxAutonomousRuns`) | Positive whole number of extension-started runs per creation or `/goal-resume` period. **Unset means unlimited; zero disables automatic continuation.** Settings edits change the limit without resetting usage. |
| Task tracking (`disableTasks`) | Turn task lists on or off. Set to `true` to disable them. |
| Subtask depth (`subtaskDepth`) | Limit how many levels of subtasks the agent can create. |
| Completion requirements (`disableContracts`) | Turn explicit goal and task completion requirements on or off. Set to `true` to disable them. |
| Unfocused reminder (`hideUnfocusedPrompt`) | When a session has no focused goal but open goals exist in the selected pool, the agent receives a `[PI GOAL UNFOCUSED]` reminder on every request. Set to `true` to stop that reminder. Defaults to `false`. This is independent of `hideUnfocusedBanner`, which hides only the unfocused widget and status hint. Neither setting selects or resumes a goal; the separate `autoSelectSingleGoal` setting still applies. |
| Auditor disabled | Turn off independent completion review. |
| Auditor provider, model, and thinking level | Choose which model reviews completed work and its reasoning effort. |

## License

MIT
