# Product Spec: Codex-inspired goal interface simplification

> **Implementation assessment (2026-08-04):** the public five-tool and
> ten-command vocabulary landed, but success criteria 1-2 are not fully met and
> two lifecycle regressions remain. See the focused
> [goal simplification hardening spec](../2026-08-04-goal-simplification-hardening/PRODUCT.md).

## Summary

`pi-goal-x` should adopt Codex Goal mode's small, stable model interface without
discarding the extension's differentiating runtime features. The user should
see a curated set of dedicated, tab-completable commands for frequent actions,
without redundant aliases or commands for internal workflow phases. The model
should see five goal tools: three core lifecycle tools shaped like Codex
(`create_goal`, `get_goal`, and `update_goal`) plus two task tools that preserve
structured task tracking (`set_goal_tasks` and `update_goal_task`).

The redesign is an interface simplification, not a reduction to a trivial
single-goal implementation. Multiple durable goals, session-local focus,
Sisyphus execution discipline, task trees, verification contracts,
independent completion auditing, auto-continue, disk reconciliation, ledger
history, compaction recovery, settings, and the progress widget remain product
features.

## Problem

The extension currently exposes its internal workflow as product surface:

- fifteen slash commands or aliases;
- twelve registered goal-related tools, with as many as ten relevant in an
  active workflow;
- separate tools for drafting, tweaking, questioning, questionnaires,
  completion, pausing, aborting, task-list proposal, task completion, task
  skipping, and legacy step completion;
- dynamic tool-set synchronization whose correctness depends on drafting,
  tweaking, focus, lifecycle, and turn-stop state;
- prompts that teach the model the extension's orchestration mechanics in
  addition to the actual goal.

This increases tool-selection errors, prompt size, test surface, and user
learning cost. Several exposed tools represent implementation phases rather
than durable user intents.

## Product principles

1. **Small stable surface, rich internal behavior.** The model should express a
   small number of recognizable intents. The runtime remains responsible for
   confirmation, persistence, auditing, continuation, and UI updates.
2. **The user controls mutable intent.** The user can create, edit, pause,
   resume, clear, select, or unfocus goals. The model can report achievement or
   a repeated blocker; it cannot silently redefine or abandon the objective.
3. **One goal belongs to one session focus.** A session works against one
   focused goal, while the project may retain multiple open goals.
4. **Planning and goal persistence are separate concepts.** Normal conversation
   or a planning workflow refines an objective. Goal mode persists and pursues
   the resulting outcome.
5. **Completion means outcome, not activity.** Verification contracts and the
   independent auditor continue to guard completion.
6. **Compatibility is preserved in data, not in permanent interface clutter.**
   Existing goal files and ledger history remain readable. Obsolete commands
   and tools may have a bounded migration window, then leave the active
   surface.

## Retained value-added behavior

The simplification must retain all of the following:

- multiple open goals under `.pi/goals/`;
- session-local focus and explicit focus/unfocus behavior;
- regular and Sisyphus goal modes;
- active and paused lifecycle states and user pause/resume controls;
- auto-continue with empty-turn, stale-checkpoint, abort, and post-stop guards;
- structured tasks, recursive subtasks, skip state, task evidence, and optional
  completion blocking;
- goal- and task-level verification contracts;
- independent semantic completion audit and visible audit progress;
- disk-backed state, safe paths, external-edit reconciliation, archival, and
  ledger history;
- token/time usage accounting and compaction recovery;
- auditor/task/contract settings and the above-editor goal widget.

## Target user interface

### Curated tab-completable commands

Use dedicated slash commands for frequent lifecycle actions. This makes them
discoverable through tab completion and avoids requiring users to remember a
second-level subcommand grammar. Simplification comes from removing redundant
aliases and model-workflow commands, not from hiding every action under
`/goal`.

| Command | Behavior |
|---|---|
| `/goal` | Show the focused goal, or a concise unfocused/open-goal summary. |
| `/goal <objective>` | Create, focus, and start a regular goal. |
| `/sisyphus <objective>` | Create, focus, and start a Sisyphus goal. |
| `/goal-tweak [replacement]` | Replace the focused objective through user confirmation; prompt for text when omitted. |
| `/goal-pause` | Pause the focused active goal. |
| `/goal-resume` | Resume a focused paused/blocked goal, or select an open goal first. |
| `/goal-clear` | Confirm and archive the focused goal without claiming completion. |
| `/goal-list` | Show all open goals and focus. |
| `/goal-focus [id]` | Focus an open goal; show a selector when the id is omitted. |
| `/goal-unfocus` | Detach the session without modifying the shared goal. |
| `/goal-settings` | Open the existing settings UI. |

This is a ten-command palette, reduced from fifteen. It intentionally preserves
the commands users are likely to discover and invoke directly while removing:

- `/goal-status`, because bare `/goal` already shows status;
- `/goals` and `/goals-set`, because `/goal <objective>` is the regular creation
  path and normal conversation handles refinement;
- `/sisyphus-set`, because `/sisyphus <objective>` is the single Sisyphus path;
- `/goal-abort`, because `/goal-clear` is the single user-owned abandonment and
  archival action.

Users can refine an unclear objective in normal conversation first, then say
"make this a goal" or invoke `/goal` with the final objective. A separate
goal-specific questionnaire state is not required.

### Five model-facing tools

#### `create_goal`

Creates and focuses a new goal after an explicit user request. It replaces
`propose_goal_draft` and the currently hidden/rejected `create_goal` tool.

Parameters:

- `objective: string` — required, trimmed, 1–4,000 characters;
- `mode?: "regular" | "sisyphus"` — defaults to regular;
- `token_budget?: number` — optional and accepted only when the user explicitly
  supplied a budget.

The tool is valid only after an explicit user or system/developer request; it
must not infer a persistent goal from an ordinary task. An explicit `/goal`
command creates directly. A conversational request may call the tool directly,
so a second goal-specific confirmation phase is not required. When other open
goals exist, the result states that the new goal became this session's focus
without archiving the others.

#### `get_goal`

Returns the complete focused goal snapshot: objective, status, mode, usage,
optional budget, remaining budget, task summary, verification contract,
pause/blocker details, paths, and count of other open goals. It is read-only
and always available.

#### `update_goal`

Lets the model report only one of two terminal outcomes for the current run:

- `status: "complete"`;
- `status: "blocked"`.

`complete` runs the existing verification-contract gate and independent
auditor. The auditor derives requirements from the objective and contracts and
inspects authoritative current state; the model does not fill a separate
completion-paperwork field. Approval archives the goal; rejection leaves it
open with the auditor feedback recorded. A budgeted completion result includes
the final consumed budget so the model can report it.

`blocked` records a distinct agent-blocked state and stops continuation. To
align with Codex behavior and avoid premature surrender, the tool description
and continuation prompt require the same blocker to recur on three consecutive
goal turns. The tool does not introduce another attempt counter or blocker
state machine; this is a model policy backed by real-model evaluations. A user
pause remains an immediate and distinct state.

The model cannot abort a goal. Obsolete, cancelled, or intentionally abandoned
goals are cleared by the user through `/goal-clear`.

#### `set_goal_tasks`

Creates or structurally replaces the task tree for the focused active or
paused goal. It preserves recursive subtasks, verification contracts,
lightweight subtasks, stable ids, and `blockCompletion`. Structural changes use
the existing confirmation dialog. Matching ids retain status and evidence.

#### `update_goal_task`

Updates one task without stopping the turn:

- `status: "complete"` requires evidence when the task has a verification
  contract and enforces completed children;
- `status: "skipped"` requires a reason and remains restricted to explicit user
  direction or a hard contradiction;
- `status: "pending"` reopens a skipped task, preserving the current unskip
  behavior. Completed tasks remain immutable through the model tool.

This replaces both `complete_task` and `skip_task` while retaining their
behavior.

## Tools removed from the active model surface

| Current tool | Replacement |
|---|---|
| `propose_goal_draft` | `create_goal` plus runtime confirmation |
| hidden/rejected `create_goal` | real `create_goal` |
| `goal_question` | normal conversation or host-provided question UI |
| `goal_questionnaire` | normal conversation or host-provided question UI |
| `propose_goal_tweak` | user-owned `/goal-tweak` |
| `complete_goal` | `update_goal(status="complete")` |
| `pause_goal` | `update_goal(status="blocked")` for the model; `/goal-pause` for the user |
| `abort_goal` | user-owned `/goal-clear` |
| `propose_task_list` | `set_goal_tasks` |
| `complete_task` | `update_goal_task(status="complete")` |
| `skip_task` | `update_goal_task(status="skipped" | "pending")` |
| `step_complete` | removed; Sisyphus remains prompt discipline |

## Lifecycle behavior

1. A user starts a goal through `/goal …`, `/sisyphus …`, or an explicit
   conversational request that leads to `create_goal`.
2. The runtime writes the goal record, focuses it, injects the concise execution
   contract, and starts auto-continue. The explicit creation command or tool
   request is the user's confirmation.
3. The model works with ordinary Pi tools. It reads state only when needed and
   optionally manages the existing task tree through the two task tools.
4. Each turn either makes meaningful progress, reports a blocker, or requests
   completion. Empty turns do not auto-continue.
5. A completion request is audited. Approval archives; rejection continues the
   same goal with feedback.
6. A repeated model blocker pauses the goal. User pause, tweak, resume, focus,
   unfocus, and clear remain immediate user operations.

## Compatibility and migration

- Existing `GoalRecord` version 3 files, active goals, archived goals, task
  trees, verification contracts, and ledger events remain readable.
- The persisted status vocabulary expands additively to `active`, `paused`,
  `blocked`, `budget_limited`, and `complete`. Existing `paused` records retain
  their meaning. `blocked` is reserved for the model's strict repeated-blocker
  outcome; `paused` is controlled by the user or interruption handling.
- Optional `tokenBudget` is additive. When accounted usage reaches it, the
  runtime marks the goal `budget_limited`, injects a one-time wrap-up steering
  prompt, and stops substantive auto-continuation. No blocker-attempt metadata
  is introduced.
- Old tool names may exist as hidden compatibility shims for one minor release,
  but they must never be included in the active tool list or prompt. The shims
  translate to the new service operations and emit a deprecation result.
- Legacy slash commands remain for one minor release only if Pi can hide them
  from completion. If Pi cannot hide registered commands, remove them in the
  simplifying release and document the mapping prominently.
- No migration rewrites user goal files in place. New fields are written on the
  next state change.

## Success criteria

1. A normal active goal exposes exactly five goal tools; disabling tasks exposes
   only the three core tools.
2. Goal tool visibility is stable across active, paused, blocked,
   budget-limited, complete, compaction, focus changes, and resumed sessions;
   runtime correctness does not depend on repeatedly rebuilding a large
   dynamic allowlist.
3. The slash-command completion surface contains exactly the ten curated
   commands documented above and no redundant creation/status/abort aliases.
4. All retained features listed above work through the new interface.
5. Existing active and archived goal files load without migration errors.
6. The core execution prompt explains outcome, current state, verification,
   blocker behavior, and the next useful task without enumerating obsolete
   orchestration tools.
7. Tool-selection evaluations show no calls to removed tools and no confusion
   between completion, blocking, clearing, and task updates.
8. Type checking, unit tests in serial mode, focused integration tests, package
   dry run, and real-model experiment cases pass.

## Non-goals

- Collapsing the extension to a single goal or a single tool.
- Removing the goal pool, focus model, tasks, contracts, auditor, ledger,
  compaction support, settings, widget, or Sisyphus mode.
- Making the task system the definition of semantic completion.
- Letting the model edit or clear user intent without confirmation.
- Replacing Pi's ordinary file, shell, and editing tools.
- Rebuilding Pi Plan mode inside the goal extension.

## Decisions

- The target is five model-facing tools, not one. The three Codex-shaped tools
  carry core lifecycle semantics; two additional tools preserve structured task
  value without leaking separate proposal/complete/skip phases.
- Multiple project goals remain supported, but a session still has exactly one
  focused goal.
- Independent audit remains an internal phase of `update_goal(complete)`, not a
  separate model tool.
- Objective tweaking, pause/resume, clearing, list/focus/unfocus, and settings
  remain dedicated user commands for tab-completion discoverability.
- Goal-specific question tools, proposal tools, and heavyweight drafting state
  are removed. Explicit user intent replaces a second confirmation protocol.
- Existing task and contract richness is retained behind two task tools.
