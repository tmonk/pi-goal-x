# pi-goal-x

`pi-goal-x` is a long-running goal extension for [pi](https://github.com/earendil-works/pi-coding-agent). It gives the agent a durable objective, a visible lifecycle, and schema-gated tools for drafting, executing, pausing, resuming, and completing work.

The extension is designed around one rule: **the user owns intent; the agent executes only after the goal is explicit and confirmed**.

## Features

- **Two goal styles** — Regular goals for open-ended research and implementation. Sisyphus goals for patient ordered execution, one step at a time.
- **Simple goal creation** — Use `/goal <objective>` to create and focus a goal directly, or `/sisyphus <objective>` for strict ordered execution.
- **Full lifecycle** — Pause, resume, clear, and complete through user commands and the five model tools. Auto-continue keeps the agent working across turns until completion, interruption, or the empty-turn guard.
- **Multiple open goals** — Keep several goals in `.pi/goals/`. Each session focuses one at a time; switch with `/goal-focus`.
- **Above-editor status widget** — See the current goal, status, file path, and progress at a glance while the agent works.
- **Structured task lists with subtasks** — Break goals into trackable tasks. Agents can mark individual tasks or subtasks complete without stopping the turn. Subtask IDs are validated for uniqueness and depth.
- **Verification contracts** — Attach plain-text requirements to a goal or task (e.g. "Run npm test, zero failures"). The independent auditor verifies them from actual evidence; per-task contracts require evidence on `update_goal_task`.
- **Independent completion auditor** — When a goal is marked complete, a separate pi agent inspects the workspace, verifies every success criterion, and approves or rejects before the goal is archived. You can press Escape during an audit to abort it. Configure the auditor model via `/goal-settings`.
- **Stable five-tool surface** — Agents see exactly `create_goal`, `get_goal`, `update_goal`, and (when tasks are enabled) `set_goal_tasks` / `update_goal_task`, installed statically without phase-dependent synchronization.
- **Immutable objective** — The agent cannot silently change your goal. Objective updates happen through user-owned `/goal-tweak`.
- **User-owned lifecycle** — Pause, resume, clear, focus, and settings are immediate user commands; the model reports only complete/blocked outcomes.
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
/goal add structured logging to the auth module
```

Flow:

1. `/goal <objective>` creates and focuses an active goal directly — the
   explicit command is the user's confirmation.
2. The full finalized objective is printed into the conversation and written to
   `.pi/goals/`.
3. The new goal becomes this session's focus. Existing open goals remain in
   `.pi/goals/` and can be selected later with `/goal-focus`.
4. The agent works only on the focused goal until it requests completion via
   `update_goal`, reports a blocker, produces an empty/non-progress turn, or the
   user interrupts.

### Sisyphus goal

```text
/sisyphus Refactor the auth flow: 1) extract token validation. 2) wire it into login. 3) update tests.
```

Sisyphus mode is for patient ordered execution. It uses the same lifecycle and tools as a regular goal; the difference is the prompt style and completion standard: preserve the user's order, do not rush, do not invent preflight/reconnaissance steps, and stop to ask when blocked.

If the objective is already final, `/goal` and `/sisyphus` start immediately —
there is no separate discussion/drafting step.

## User commands

The curated ten-command palette (each lifecycle action is independently
registered so tab completion is self-explanatory):

```text
/goal [objective]       With an objective: create and focus a regular goal directly.
                        With no arguments: show focused goal state.
/sisyphus <objective>   Create and focus a Sisyphus-style goal (strict ordered steps) directly.
/goal-list              List all open goals in .pi/goals/ and the current focus
/goal-focus             Choose this session's focused goal
/goal-unfocus           Stop this session's goal work without modifying the shared goal
/goal-tweak <change>    Refine the focused goal's objective with the user
/goal-pause             Pause the focused active goal
/goal-resume            Resume a paused or blocked goal
/goal-settings          Configure pi-goal settings, including auditor model settings
/goal-clear             Archive the focused goal after confirmation
```

Pressing `Esc` or aborting an active run pauses the goal so it does not remain falsely active.

### Command migration

| Legacy command | New command |
|---|---|
| `/goal-status` | `/goal` (no arguments) |
| `/goals-set <x>` | `/goal <x>` |
| `/sisyphus-set <x>` | `/sisyphus <x>` |
| `/goal-abort` | `/goal-clear` |
| `/goals <topic>` | Normal discussion, then `/goal <objective>` or an explicit `create_goal` request |

`/goal-tweak`, `/goal-pause`, `/goal-resume`, `/goal-clear`, `/goal-list`,
`/goal-focus`, `/goal-unfocus`, and `/goal-settings` are retained unchanged.

## Multiple open goals and focus

`pi-goal` separates durable goals from session focus:

- **Goal pool**: every open goal is an `active_goal_*.md` file under `.pi/goals/`.
- **Focused goal**: the current pi session has one focused goal id stored in a `pi-goal-focus` custom session entry.
- **No focus in markdown**: goal files describe the goal itself; they do not record which session is focused on them.
- **Branch-local focus**: because focus is reconstructed from the current session branch, `/tree` navigation can restore a different focus for a different branch.
- **One continuation chain**: auto-continue only schedules work for the focused goal in the current session.

Creating a goal with `/goal <objective>` or `/sisyphus <objective>` never clears other open goals; it creates a new active goal file and focuses it. Use `/goal-list` to inspect open goals, `/goal-focus` to switch the session focus, and `/goal-unfocus` to detach the current session without pausing, modifying, archiving, or recording a project-ledger focus change for the shared goal. Unfocus also aborts in-flight work and audits owned by that session; asynchronous lifecycle results are discarded if focus changed while they were pending. If the latest focus entry explicitly clears focus, or points at a missing/stale goal, a remaining single open goal is not auto-focused and resume does not prompt to replace that explicit choice. By default (`autoSelectSingleGoal: false`) sessions start unfocused so focus stays session-scoped — useful when multiple sessions share the same `.pi/goals/` directory. Set `autoSelectSingleGoal: true` to restore the old behavior where a single open goal is auto-focused when no focus entry exists at all. If multiple open goals exist and the session has no valid focus, `/goal-resume`, `/goal-clear`, `/goal-pause`, and `/goal-tweak` ask the user to choose a goal instead of acting on all of them.

## Agent tools

The extension exposes a stable five-tool model surface (installed statically,
no phase-dependent synchronization):

| Tool | Purpose |
|---|---|
| `create_goal` | Create and focus a new goal after an explicit user request (objective 1–4000 chars, optional `mode` regular/sisyphus and `token_budget`). Never infer a goal from an ordinary task. |
| `get_goal` | Read-only complete focused goal snapshot: objective, status, mode, usage, budget + remaining, task summary, verification contract, blocker details, paths, other-open count. |
| `update_goal` | Report one of two terminal outcomes: `complete` (runs the independent auditor, which verifies from actual evidence — no paperwork field) or `blocked` (distinct agent-blocked state, only after the same blocker recurs on three consecutive turns). |
| `set_goal_tasks` | Create or structurally replace the task tree (flat parent-linked input, confirmation dialog, matching ids keep status/evidence). |
| `update_goal_task` | Update one task without stopping the turn: complete (evidence for contracted tasks), skipped (reason), pending (reopens skipped). |

Plus the ordinary Pi work tools (write/read/bash/edit). Lifecycle actions the
model does not own (pause, resume, clear, focus, tweak, settings) are
user-owned slash commands. When `disableTasks` is enabled, only the three core
tools are advertised.

## Goal creation

`/goal <objective>` and `/sisyphus <objective>` create and focus a goal
directly — the explicit command is the user's confirmation, so no second
confirmation phase is needed. A conversational request may call `create_goal`
directly when the user explicitly asks to start a persistent goal; the model
must not infer a goal from an ordinary one-off task. Users can refine an
unclear objective in normal conversation first, then say "make this a goal" or
invoke `/goal` with the final objective. A separate goal-specific
questionnaire/drafting state is not required.

The model may do minimal read-only reconnaissance before creating a goal, but
should not begin substantive implementation before the goal exists. When a
goal is created, the tool result includes the full final objective and the
normal work tools (`write`, `read`, `bash`, `edit`) are available for
execution.

## Completion behavior

Completion is explicit and checked by an independent pi auditor agent. The
model calls `update_goal` with the terminal outcome:

```json
{ "status": "complete" }
```

There is no paperwork field: the auditor derives the requirements from the
objective and any verification contract, and inspects the actual workspace
evidence (including the task tree and its evidence). `update_goal` accepts only
`complete` or `blocked`.

Before archiving the goal, completion starts a separate pi agent in an isolated
in-memory session. The auditor receives the objective, mode, verification
contract, task tree and task evidence, current usage/budget, and the workspace
path with read-only-oriented tools (`read`, `grep`, `find`, `ls`, `bash`). It
must end its report with exactly one marker:

- `<approved/>` archives the goal as complete.
- `<disapproved/>`, no marker, an error, or an abort rejects completion and
  leaves the goal open with the auditor feedback recorded.

The auditor is semantic, not a paperwork checklist: it should reject
scaffold-only, alpha, generated-template, proxy-metric, build-only, or weakly
verified completions when the real user outcome is not satisfied.

By default the auditor uses the current/default pi model. Configure it via
`.pi/pi-goal-x-settings.json`, or interactively with `/goal-settings`.

`blocked` records a distinct agent-blocked state and stops continuation. To
align with Codex behavior, the tool description and continuation prompt require
the same blocker to recur on three consecutive goal turns before the model
reports blocked; there is no separate attempt counter. A user pause
(`/goal-pause`, Esc) remains an immediate, distinct state. The model cannot
abort a goal — obsolete or abandoned goals are cleared by the user through
`/goal-clear`.

Sisyphus goals use the same lifecycle tools as regular goals; the difference is
the prompt/criteria execution standard. A paused goal can also be completed
directly when the agent already has enough evidence that every requirement is
satisfied.

## Schema gates

The shipped gates are intentionally small and mechanical.

| Gate | Prevents |
|---|---|
| Objective bound | `create_goal` / `/goal` objectives outside 1–4000 characters |
| Explicit request | The model inferring a goal from an ordinary task (prompt policy) |
| Completion auditor gate | Archiving completion unless an independent pi auditor agent returns `<approved/>` |
| Blocked-from-active | `update_goal(blocked)` on a non-active goal |
| Task schema gates | set_goal_tasks flat-input validation (ids, parents, acyclic, ≤50, depth, lightweight placement); update_goal_task evidence/reason/status rules |
| Post-stop block | Continuing to call tools after `update_goal` / `set_goal_tasks` / a user lifecycle command stops the turn |
| Empty-turn guard | Pure chat loops that would keep auto-continuing without meaningful goal work |
| Abort pause | Active goals staying active after user abort / Ctrl-C |
| Disk reconciliation | External pause/archive/delete/status changes being ignored or overwritten by stale memory |
| Post-compaction reminder | Losing the active objective after session compaction |
| Budget transition | Accounted usage crossing the token budget firing more than once |

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
