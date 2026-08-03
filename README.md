# pi-goal-x

`pi-goal-x` is a long-running goal extension for [pi](https://github.com/earendil-works/pi-coding-agent). It gives the agent a durable objective, a visible lifecycle, and schema-gated tools for drafting, executing, pausing, resuming, and completing work.

The extension is designed around one rule: **the user owns intent; the agent executes only after the goal is explicit and confirmed**.

## Features

- **Two goal styles** — Regular goals for open-ended research and implementation. Sisyphus goals for patient ordered execution, one step at a time.
- **Simple goal creation** — Use `/goals` to discuss and confirm a draft. Use `/goals-set` to skip discussion and start immediately.
- **Full lifecycle** — Pause blocked goals, resume when unblocked, abort obsolete work, complete when done. Auto-continue keeps the agent working across turns until completion, interruption, or the empty-turn guard.
- **Multiple open goals** — Keep several goals in `.pi/goals/`. Each session focuses one at a time; switch with `/goal-focus`.
- **Above-editor status widget** — See the current goal, status, file path, and progress at a glance while the agent works.
- **Structured task lists with subtasks** — Break goals into trackable tasks. Agents can mark individual tasks or subtasks complete without stopping the turn. Subtask IDs are validated for uniqueness and depth.
- **Verification contracts** — Attach plain-text requirements to a goal or task (e.g. "Run npm test, zero failures"). The agent must provide matching evidence before `complete_goal` or `complete_task` will succeed.
- **Independent completion auditor** — When a goal is marked complete, a separate pi agent inspects the workspace, verifies every success criterion, and approves or rejects before the goal is archived. You can press Escape during an audit to abort it. Configure the auditor model via `/goal-settings`.
- **Schema-gated tools** — Agents see only the tools relevant to the current lifecycle phase: drafting, active, paused, or tweaking. Lifecycle tools like `pause_goal`, `complete_task`, and `abort_goal` appear and disappear automatically.
- **Immutable objective** — The agent cannot silently change your goal. Objective updates require a `/goal-tweak` drafting flow with explicit user confirmation.
- **Built-in questionnaire tools** — During drafting, agents can ask structured questions through `goal_question` and `goal_questionnaire` without depending on external packages.
- **Disk-backed state** — Active and archived goals persist in `.pi/goals/`. Goal state survives session compaction, workspace switches, and context churn.
- **Configurable settings** — Tune the auditor model, disable the task system or contracts, and set subtask depth through `/goal-settings` or `.pi/pi-goal-x-settings.json`.

> **Fork of [@capyup/pi-goal](https://github.com/capyup/pi-goal)** — pi-goal-x preserves all upstream features and adds: verification contracts (per-goal and per-task), unified goal+task acceptance in a single confirmation dialog, recursive task lists with subtasks, an immutable objective enforced by tools, deferred archival with cleaner lifecycle hooks, an improved completion auditor with configurable model and progress widget, drafting UX refinements, and lifecycle reliability fixes.

## Install

From npm:

```bash
pi install npm:pi-goal-x
```

From a local checkout:

```bash
pi install .
```

Try once without installing:

```bash
pi -e .
```

## Quick start

### Regular goal

```text
/goals add structured logging to the auth module
```

Flow:

1. The agent clarifies, researches, or grills only when the goal contract needs it.
2. The agent calls `propose_goal_draft` with a concrete objective once the contract is clear.
3. pi shows a full plain-text confirmation report.
4. If confirmed, the full finalized goal is printed into the conversation and written to `.pi/goals/`.
5. The new goal becomes this session's focus. Existing open goals remain in `.pi/goals/` and can be selected later with `/goal-focus`.
6. The agent works only on the focused goal until it calls `complete_goal`, pauses, aborts, produces an empty/non-progress turn, or the user interrupts.

### Sisyphus goal

```text
/sisyphus Refactor the auth flow: 1) extract token validation. 2) wire it into login. 3) update tests.
```

Sisyphus mode is for patient ordered execution. It uses the same lifecycle and tools as a regular goal; the difference is the prompt style and completion standard: preserve the user's order, do not rush, do not invent preflight/reconnaissance steps, and stop to ask when blocked.

If the objective is already final and should start immediately, use:

```text
/goals-set add structured logging to the auth module
/sisyphus-set Refactor auth flow exactly as ordered: 1) extract token validation. 2) wire it into login. 3) update tests.
```

## User commands

```text
/goals <topic>          Discuss/research/grill a regular goal, then confirm a draft
/sisyphus <topic>       Discuss/grill a Sisyphus-style goal, then confirm a draft
/goals-set <objective>  Immediately create and start a regular goal
/sisyphus-set <objective> Immediately create and start a Sisyphus-style goal
/goal-status            Show focused goal state
/goal-list              List all open goals in .pi/goals/
/goal-focus             Choose this session's focused goal
/goal-unfocus           Stop this session's goal work without modifying the shared goal
/goal-tweak <change>    Draft a revision to the focused active/paused goal
/goal-pause             Pause the focused active goal
/goal-resume            Resume a paused goal
/goal-settings          Configure pi-goal settings, including auditor model settings
/goal-abort             Abort/archive the focused goal or cancel drafting
/goal-clear             Archive the focused goal or cancel drafting
```

Pressing `Esc` or aborting an active run pauses the goal so it does not remain falsely active.

## Multiple open goals and focus

`pi-goal` separates durable goals from session focus:

- **Goal pool**: every open goal is an `active_goal_*.md` file under `.pi/goals/`.
- **Focused goal**: the current pi session has one focused goal id stored in a `pi-goal-focus` custom session entry.
- **No focus in markdown**: goal files describe the goal itself; they do not record which session is focused on them.
- **Branch-local focus**: because focus is reconstructed from the current session branch, `/tree` navigation can restore a different focus for a different branch.
- **One continuation chain**: auto-continue only schedules work for the focused goal in the current session.

Creating a goal with `/goals`, `/sisyphus`, `/goals-set`, or `/sisyphus-set` no longer clears other open goals. It creates a new active goal file and focuses it. Use `/goal-list` to inspect open goals, `/goal-focus` to switch the session focus, and `/goal-unfocus` to detach the current session without pausing, modifying, archiving, or recording a project-ledger focus change for the shared goal. Unfocus also aborts in-flight work and audits owned by that session; asynchronous lifecycle results are discarded if focus changed while they were pending. If the latest focus entry explicitly clears focus, or points at a missing/stale goal, a remaining single open goal is not auto-focused and resume does not prompt to replace that explicit choice. By default (`autoSelectSingleGoal: false`) sessions start unfocused so focus stays session-scoped — useful when multiple sessions share the same `.pi/goals/` directory. Set `autoSelectSingleGoal: true` to restore the old behavior where a single open goal is auto-focused when no focus entry exists at all. If multiple open goals exist and the session has no valid focus, `/goal-resume`, `/goal-clear`, `/goal-abort`, `/goal-pause`, and `/goal-tweak` ask the user to choose a goal instead of acting on all of them.

## Agent tools

The extension exposes tools only when they make sense for the current lifecycle phase.

| Tool | Visible when | Purpose |
|---|---|---|
| `goal_question` | drafting / tweak drafting | Ask one focused user question |
| `goal_questionnaire` | drafting / tweak drafting | Ask multiple structured questions |
| `get_goal` | always | Read the focused goal state; mentions other open goals when present |
| `propose_goal_draft` | drafting only (goal creation) | Submit a concrete draft for user confirmation |
| `propose_goal_tweak` | tweak drafting only | Submit a revision to an existing goal (shows Confirm / Continue Chatting dialog) |
| `complete_goal` | focused active or paused goal | Mark the focused goal complete — supply a `verificationSummary` covering all contract items. When the auditor is disabled, supply `confirmBypassAuditor: true` after user confirmation to bypass the audit |
| `pause_goal` | focused active goal | Pause the focused goal because of a real blocker |
| `abort_goal` | focused active or paused goal | Abort/archive an obsolete, impossible, unsafe, or user-cancelled focused goal |
| `propose_task_list` | active or paused goal | Propose a structured task list for user confirmation (stops the turn) |
| `complete_task` | active or paused goal | Mark a task complete with optional `verificationSummary`. If the task has a `verificationContract`, the summary is required (does not stop turn) |
| `skip_task` | active or paused goal | Mark a task skipped with a required reason (does not stop turn) |
| `propose_goal_tweak` | tweak drafting only | Submit a revision to the focused goal (shows Confirm / Continue Chatting dialog) |
| `step_complete` | hidden / legacy | Compatibility no-op; Sisyphus no longer requires a step counter |
| `create_goal` | hidden | Direct calls are rejected; normal creation goes through `propose_goal_draft` |

## Drafting behavior

`/goals` and `/sisyphus` start a lightweight intent discussion, not a heavy runtime sub-state. The agent clarifies, researches, and grills only when needed, may proceed directly for fully specified requests, and then calls `propose_goal_draft` to show the user a Confirm / Continue Chatting dialog. `goal_question` and `goal_questionnaire` are available when structured input helps, but plain conversation is acceptable.

`/goals-set` and `/sisyphus-set` skip the discussion and confirmation dialog. They directly create and focus an active goal from the supplied objective so execution can begin immediately.

The agent may do minimal read-only reconnaissance when it directly improves the goal contract, but should not begin substantive implementation before confirmation. The strict runtime starts after the user confirms the draft and an active goal is created.

When a draft is proposed, the confirmation UI shows a full plain-text report with draft details, the original topic, and the proposed goal. If the confirmation UI throws in interactive mode, creation fails closed and confirmation remains active; it never auto-creates a goal. When a draft is confirmed, the tool result includes the full final objective, not a one-line summary, and normal work tools (`write`, `read`, `bash`, `edit`) are available for execution. This makes the confirmed contract visible in the conversation as well as on disk.

While goal confirmation or tweak drafting is active, old goal execution is suspended: active-goal prompts, accounting, and auto-continue checkpoints do not run for the previously focused goal.

## Completion behavior

Completion is also explicit and is checked by an independent pi auditor agent. The executor calls `complete_goal` with its completion claim:

```json
{
  "status": "complete",
  "completionSummary": "What was completed and what evidence proves it."
}
```

Before archiving the goal, `complete_goal` starts a separate pi agent in an isolated in-memory session. The auditor receives the objective, the executor's completion claim, and current goal metadata, then can inspect the workspace with read-only-oriented tools (`read`, `grep`, `find`, `ls`, and `bash`). It must end its report with exactly one marker:

- `<approved/>` archives the goal as complete.
- `<disapproved/>`, no marker, an error, or an abort rejects completion and leaves the goal open.

The auditor is semantic, not a paperwork checklist: it should reject scaffold-only, alpha, generated-template, proxy-metric, build-only, or weakly verified completions when the real user outcome is not satisfied.

By default the auditor uses the current/default pi model. Configure it via `.pi/pi-goal-x-settings.json`, or interactively with `/goal-settings` (see [Configuration](#configuration)).

The completion result prints a full report into the conversation:

- `Goal complete.`
- optional completion summary / evidence supplied by the executor
- the auditor's approval report
- full current goal details, including objective, status, usage, mode, and file path

Sisyphus goals use the same completion tool as regular goals. The stricter part is the prompt/criteria standard: the agent should only call completion after the whole ordered objective is actually satisfied and likely to survive independent auditing. A paused goal can also be completed directly when the agent already has enough evidence that every requirement is satisfied; it does not need a resume just to call `complete_goal`.

## Schema gates

The shipped gates are intentionally small and mechanical.

| Gate | Prevents |
|---|---|
| Focus consistency | `/goals` accidentally becoming Sisyphus, or `/sisyphus` becoming regular mode |
| Confirm-before-commit | The agent silently creating or replacing a discussion-based goal |
| Direct set intent | `/goals-set` and `/sisyphus-set` are explicit user shortcuts that bypass draft confirmation |
| Completion auditor gate | Archiving completion unless an independent pi auditor agent returns `<approved/>` |
| Abort gate | Aborting missing, stale, completed, or reasonless goals |
| Direct-create rejection | Hidden `create_goal` calls creating goals without the confirmation flow |
| Post-stop block | Continuing to call tools after `pause_goal`, `abort_goal`, `complete_goal`, or `propose_goal_tweak` stops the turn |
| Empty-turn guard | Pure chat loops that would keep auto-continuing without meaningful goal work |
| Abort pause | Active goals staying active after user abort / Ctrl-C |
| Disk reconciliation | External pause/archive/delete/status changes being ignored or overwritten by stale memory |
| Post-compaction reminder | Losing the active objective after session compaction |

## Files

```text
.pi/goals/active_goal_<timestamp>_<id>.md
.pi/goals/archived/goal_<timestamp>_<id>.md
```

Multiple `active_goal_*.md` files may exist simultaneously. This is the project-level open goal pool. The selected/focused goal is intentionally not stored in these files; focus lives in session custom state.

Each file contains:

1. extension-owned JSON metadata;
2. a user-editable `# Goal Prompt` section;
3. progress/status information.

Before commands, tools, and lifecycle hooks act on a focused goal, the runtime reconciles the focused record against the active goal file on disk. External archive/delete/status changes therefore win over stale in-memory state and cannot resurrect deleted active files. Prompt-body edits are still picked up from the `# Goal Prompt` section; focus is never stored in goal markdown.

Goal paths are constrained to `.pi/goals/` and `.pi/goals/archived/`; absolute paths, traversal, NUL bytes, symlinks, and unsafe metadata paths are rejected.

## Configuration

All settings live in a single file: **`.pi/pi-goal-x-settings.json`**

Configured interactively via `/goal-settings`, or edited directly:

```json
{
  "disableTasks": false,
  "disableContracts": false,
  "subtaskDepth": 1,
  "autoSelectSingleGoal": false,
  "provider": "fireworks",
  "model": "accounts/fireworks/models/deepseek-v4-flash",
  "thinkingLevel": "high",
  "disabled": false
}
```

| Field | Default | Purpose |
|---|---:|---|
| `disableTasks` | `false` | Suppress task list features entirely when `true` |
| `disableContracts` | `false` | Suppress verification contract enforcement when `true` |
| `subtaskDepth` | `1` | Maximum nesting depth for subtasks |
| `autoSelectSingleGoal` | `false` | When `true`, auto-focus the single open goal when a session has no focus entry (default keeps goals session-scoped) |
| `provider` | system default | Provider name for the auditor agent |
| `model` | system default | Model name for the auditor agent |
| `thinkingLevel` | system default | Thinking level: `off`, `minimal`, `low`, `medium`, `high`, `xhigh` |
| `disabled` | `false` | When `true`, skip the completion audit entirely |

**Env var overrides:**
- `PI_GOAL_DISABLE_TASKS=1` — disable task features (takes precedence over file)
- `PI_GOAL_DISABLE_CONTRACTS=1` — disable contract enforcement (takes precedence over file)
- `PI_GOAL_SETTINGS_FILE=custom-path.json` — alternative settings file path (relative to cwd or absolute)

## Environment variables

| Variable | Default | Purpose |
|---|---:|---|
| `PI_GOAL_AUTO_CONFIRM` | unset | When `1`, auto-confirms drafts in headless/test contexts |
| `PI_GOAL_DISABLE_TASKS` | — | When `1`, disable task features (overrides settings file) |
| `PI_GOAL_DISABLE_CONTRACTS` | — | When `1`, disable contract enforcement (overrides settings file) |
| `PI_GOAL_SETTINGS_FILE` | `.pi/pi-goal-x-settings.json` | Alternative settings file path (relative to cwd or absolute) |

## Development

```bash
npm install
npm test
npm run check
npm pack --dry-run
```

The fast unit suite uses Node's built-in test runner and covers core parsing, drafting gates, lifecycle policy, abort policy, questionnaire formatting, centralized tool names, Sisyphus prompt-style behavior, completion reporting, and display helpers.

The experiment harness under `experiments/` runs full pi sessions against real model calls and mechanical rubrics.

```bash
cd experiments
bash harness/run.sh C1-vague-goal-set --count 3 --grade --no-smoke
```

## Package contents

The npm package ships only the runtime extension, docs, and package metadata. The extension is split into small modules:

```text
extensions/goal.ts                 orchestration, commands, tools, events, timers
extensions/goal-record.ts          goal record types, normalization, creation helpers
extensions/goal-pool.ts            open-goal pool, focus resolution, list/selector text helpers
extensions/goal-core.ts            display helpers
extensions/goal-draft.ts           lightweight confirmation prompt, proposal validation, drafting tool gate
extensions/goal-policy.ts          lifecycle, pause/resume/complete, and Sisyphus policy
extensions/goal-auditor.ts         independent pi auditor agent for completion approval, config, and progress tracking
extensions/goal-ledger.ts         event append, read, validation, sanitization, and reconstruction
extensions/goal-questionnaire.ts   built-in question UI and question tool registration
extensions/goal-tool-names.ts      centralized published tool names and allowlists
extensions/prompts/goal-prompts.ts active, continuation, tweak, and stale prompts
extensions/storage/goal-files.ts   goal file paths, serialization, parsing, archive IO
extensions/widgets/goal-widget.ts  above-editor goal beacon component
extensions/widgets/goal-notifications.ts widget-style notification text
```

## Design principles

- **User owns intent**: only the user starts, replaces, resumes, clears, or confirms goals; the agent may only pause, complete, or abort through schema-gated lifecycle tools with evidence/reason.
- **One commit path**: normal goal creation goes through drafting and confirmation.
- **Schema beats prompt walls**: recurring failure modes are handled by validators and tool-call interceptors.
- **Visible contracts**: confirmed goals and completion reports are printed fully into the conversation.
- **Lifecycle-shaped tool surface**: the agent sees only tools appropriate to the current phase.
- **Disk-backed continuity**: goal state survives context churn and can be audited from `.pi/goals/`.
- **Human-owned focus**: the agent may work on the focused goal, but only user commands/UI selection switch focus.

## Relationship to pi-goal

pi-goal-x started as a fork of [@capyup/pi-goal](https://github.com/capyup/pi-goal), but it is maintained as an independent project and does **not** track an `upstream` remote. There is no sync workflow with the original repository; bug reports, feature requests, and contributions target this repository directly.

## Release policy

This repository can be validated locally with tests and packaging checks. Publishing a new npm version, pushing tags, and running `pi update` are explicit release steps and are not part of ordinary implementation goals unless requested.

## License

MIT
