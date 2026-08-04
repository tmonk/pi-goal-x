# pi-goal Agent Flow Design

This document explains the agent flow of the `pi-goal` project: how the user
states an objective, how the executing agent works, how the independent
auditor verifies, and how the runtime maintains state, the ledger, the UI, and
auto-continuation.

## 1. Core mental model

`pi-goal` is not another general-purpose agent; it is a pi extension. It adds a
"long-running goal runtime" layer on top of the main coding agent: goals are
created explicitly, go through a lifecycle, and completion is independently
audited.

The system has four roles:

| Role | Responsibility |
|---|---|
| User | Owns intent. Starts goals, pauses/resumes/clears them, chooses focus. |
| Executing agent | Works on the confirmed focused goal. Reports terminal outcomes via `update_goal`. |
| Auditor agent | An independent in-memory pi agent session that checks whether a completion claim actually satisfies the goal. |
| `pi-goal` runtime | Maintains goal state, the tool surface, prompts, the ledger, the UI widget, and auto-continuation. |

Core principle:

> The user owns intent; the executing agent does the work; the auditor
> independently verifies; the runtime coordinates and records.

## 2. Overall flow

```text
User command
  -> pi-goal command handler (/goal, /sisyphus, /goal-*)
  -> direct creation, or focus/lifecycle state update
  -> runtime reconciles from disk, re-computes prompts and the active tool subset
  -> executing agent works on the focused goal
  -> tool call / turn events update accounting and the ledger
  -> update_goal(complete) triggers the independent auditor
  -> approved -> goal archived at turn_end; rejected -> goal stays open
```

Five model tools are registered:

| Tool | Role |
|---|---|
| `create_goal` | Create and focus a new goal after an explicit user request |
| `get_goal` | Read-only snapshot of the focused goal |
| `update_goal` | Terminal outcomes: `complete` (audited) or `blocked` (three-turn rule) |
| `set_goal_tasks` | Define/replace the task tree (with confirmation) |
| `update_goal_task` | Per-task status updates without stopping the turn |

Lifecycle actions the model does not own (pause, resume, clear, focus, tweak,
settings) are user-owned slash commands.

## 3. Main state containers

The runtime keeps:

- a goal pool `goalsById: Map<goalId, GoalRecord>` reconstructed from
  `.pi/goals/active_goal_*.md` plus compatible legacy session entries;
- a session focus `focusedGoalId` reconstructed from branch-local
  `pi-goal-focus` custom session entries;
- `focusRevision` — incremented on every focus change, used to invalidate
  pending async operations (completion, task-list confirmation) so results
  cannot mutate a goal after the session detached from it.

## 4. Persistence: goal files and ledger

### 4.1 Goal files

```text
.pi/goals/active_goal_<timestamp>_<id>.md
.pi/goals/archived/goal_<timestamp>_<id>.md
```

Each file has extension-owned metadata and a user-editable `# Goal Prompt`
section. Before focused commands, tools, and lifecycle hooks act, the runtime
re-reads the focused active file and reconciles lifecycle state from disk, so
external changes win over stale memory. Session focus is never written into
these files.

### 4.2 Ledger files

The ledger is one project-level append-only JSONL file
(`.pi/goals/goal_events.jsonl`). Its 18 event types cover creation,
tweaks, focus changes, pause/resume/block/clear, completion requests, audit
start/result/skip, budget limits, and task-list changes. The runtime reads it
for auditor-rejection memory and compaction summaries; it is never rewritten
in place.

## 5. Command palette: the user owns intent

The curated ten-command palette:

| Command | Behavior |
|---|---|
| `/goal <objective>` | Direct regular-goal creation; bare `/goal` shows status |
| `/sisyphus <objective>` | Direct Sisyphus creation (numbered ordered steps) |
| `/goal-list` | List all open goals and the current focus |
| `/goal-focus` | Choose this session's focused goal |
| `/goal-unfocus` | Detach the session without modifying the shared goal |
| `/goal-settings` | Auditor/settings editor |
| `/goal-tweak <new objective>` | Direct user-owned objective edit |
| `/goal-clear` | Archive the focused goal (user-owned abandonment) |
| `/goal-pause` | Pause the focused active goal (Esc also pauses) |
| `/goal-resume` | Resume a paused or blocked goal |

## 6. Goal creation flow

`/goal <objective>` and `/sisyphus <objective>` create and focus a goal
directly — the explicit command is the user's confirmation, so no separate
confirmation phase exists. A conversational request may call `create_goal`
directly when the user explicitly asks to start a persistent goal; the model
must not infer a goal from an ordinary one-off task. Creating a goal focuses
it and leaves other open goals untouched. `create_goal` accepts an objective
of 1–4000 characters, an optional `mode` (regular/sisyphus), and an optional
`token_budget`.

## 7. Tool surface and runtime gates

The model surface is a FIXED three/five profile (hardening stage 2):

- exactly five goal tools are installed when tasks are enabled — `create_goal`,
  `get_goal`, `update_goal`, `set_goal_tasks`, `update_goal_task`;
- exactly the three core tools when tasks are disabled;
- the profile is installed once at session start and after a settings change
  that toggles `disableTasks`; focus, status, budget, completion, audit, and
  compaction transitions never add/remove/restore goal tools;
- ordinary pi work tools (`read`, `write`, `edit`, `bash`, ...) are never
  touched by the extension;
- invalid lifecycle calls are rejected by the executor with a concise
  state-aware result (e.g. `update_goal(blocked)` from a paused goal), not by
  hiding tools.

The `tool_call` interceptor:

- blocks work tools after a stop tool has fired in the same turn (post-stop
  guard);
- blocks work tools when the checkpoint that triggered the turn is no longer
  actionable (stale checkpoint guard);
- tracks whether the turn did meaningful goal work (the empty-turn gate for
  auto-continuation).

## 8. Execution loop and auto-continue

When `autoContinue` is on, the extension queues continuation prompts after
agent turns for the focused goal only. The loop stops or pauses when:

- the agent calls `update_goal(status="complete")`;
- the agent calls `update_goal(status="blocked")`;
- the user invokes `/goal-pause`, `/goal-clear`, or the user aborts the turn;
- a turn ends without meaningful goal-work tool activity.

Continuation prompts include a goal id so stale prompts can be detected and
neutralized. If focus changes or the goal is archived before a queued
checkpoint runs, the checkpoint becomes stale and cannot drive task work.

## 9. Completion and the visible audit phases

### 9.1 The executing agent requests completion

`update_goal({status: "complete"})` has no verification-summary parameter. The
runtime validates that the goal is in a completable status, optionally warns
about pending tasks (`blockCompletion`), appends a `completion_requested`
ledger event, and starts the auditor. The global disabled-auditor branch is
currently defective in 0.22: it still requires a removed model bypass field
and therefore rejects completion.

### 9.2 The audit appears in the conversation

A `[GOAL AUDIT STARTED]`-style message is sent with `triggerTurn`, so the
executing agent's turn yields to the auditor. A `pi-goal-audit-event` message
with phase `started` is displayed, and the goal widget shows an audit progress
spinner. Escape during the audit opens a dialog to complete without audit or
continue working.

### 9.3 The independent auditor session

A separate in-memory pi session runs with a focused auditor prompt. The
auditor receives the objective, the executor's completion claim, and goal
metadata; it can inspect the workspace with `read`, `grep`, `find`, `ls`, and
`bash`; and it must end with exactly one marker: `<approved/>` or
`<disapproved/>` (an error or abort also rejects).

### 9.4 The audit result appears in the conversation

The result is sent as a `pi-goal-audit-event` with phase `approved` or
`rejected`, and an `audit_result` ledger event records the verdict. A rejected
completion leaves the goal open and the verdict is remembered so future
prompts inject the auditor's objections.

### 9.5 Archiving

On approval, the goal is set complete in memory and the active file is written
without archiving; archival is deferred to `turn_end` so the agent can see the
auditor result first. At `turn_end` the goal is archived, a `goal_completed`
ledger event is appended, and the session focus is cleared.

## 10. Blocked, pause, and post-stop behavior

- `update_goal({status: "blocked"})` records a distinct `blocked` status with
  an agent stop reason and stops continuation. The three-consecutive-turn
  blocker rule is prompt policy, not a persisted counter.
- `/goal-pause` and Esc set `paused` (user-owned) with `autoContinue: false`.
- `/goal-resume` reactivates a paused or blocked goal.
- After any stop tool fires in a turn, subsequent tool calls in the same turn
  are blocked except read-only inspection.

## 11. Compaction and auditor-rejection memory

On session compaction the runtime persists the current goal, re-arms
accounting, and arms a deterministic post-compaction summary for the next
agent turn. Auditor rejections are read from the ledger and injected into
future prompts so the agent addresses them before requesting completion again.

## 12. Token budgets

An optional `token_budget` may be set at creation. When accounted usage
reaches the budget, the goal transitions to a distinct `budget_limited` status
exactly once, a `goal_budget_limited` ledger event is emitted, one-time
wrap-up steering is injected (summarize; do not start new substantive work; do
not claim completion unless real), and pending continuations are cancelled.
`budget_limited` never implies completion.

## 13. Module map

```text
goal.ts (thin installer)
├─ goal-state.ts     GoalCore: state + service/runtime/accounting wiring
├─ goal-tools.ts     five tools + completion/blocked flows
├─ goal-commands.ts  ten-command palette
├─ goal-events.ts    13 lifecycle event handlers
├─ goal-widget.ts    terminal keybindings + debug helpers
├─ goal-format.ts    pure formatting/message helpers
├─ goal-service.ts   sole mutation boundary
├─ goal-runtime.ts   continuation/stale-checkpoint/turn-stop
├─ goal-accounting.ts serialized accounting + budgets
├─ goal-policy.ts    lifecycle/task validation + reports
├─ goal-auditor.ts   independent audit session
├─ goal-ledger.ts    ledger reads
├─ goal-record.ts    record types/creation/migration
├─ goal-pool.ts      pool/focus helpers
├─ prompts/          bounded five-tool steering prompts
├─ storage/          goal file IO (reads + serializers)
└─ widgets/          goal widget, notifications, escape dialog, task overlay
```

## 14. Key design trade-offs

- **Five tools, user-owned lifecycle.** A small stable surface is easier to
  prompt-bound than a large phase-dependent one; lifecycle actions are user
  commands so the model cannot pause/resume/clear on its own.
- **GoalService as the sole mutation boundary.** Ordering (reconcile → write →
  ledger → memory) is enforced in one place; handlers cannot corrupt files or
  ledger state.
- **Auditor from actual evidence, not paperwork.** Removing the
  verification-summary field pushes the auditor to inspect real artifacts,
  which is a stronger completion gate.
- **Budget exhaustion is a system transition, not completion.** The
  `budget_limited` status stops continuation and arms wrap-up steering without
  implying the goal is done.
- **Disk is authoritative.** Reconciliation before every focused action means
  external edits and multi-session use stay consistent; old readers keep
  existing data readable.

## 15. Current hardening plan

This document describes 0.22 as implemented, including the deviations called
out above. The prioritized correction plan is
[`specs/2026-08-04-goal-simplification-hardening`](../specs/2026-08-04-goal-simplification-hardening/TECH.md).
It also addresses paused-record resurrection, stale task-tree overwrites,
task-confirmation audit coupling, budget validation, ledger semantics, legacy
runtime code, and unsupported E2E/experiment assets.
