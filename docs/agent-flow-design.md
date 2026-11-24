# pi-goal Agent Flow Design

How a goal moves from the user's request to an audited completion: who does
what, which tools the model sees, and how the runtime keeps going between
turns. For the module layout see [architecture](architecture.md).

## 1. Roles

| Role | Responsibility |
|---|---|
| User | Owns intent: starts, pauses, resumes, clears and focuses goals. |
| Executing agent | Works on the focused goal and reports outcomes through `update_goal`. |
| Auditor | An independent in-memory pi session that checks a completion claim against the workspace. |
| Runtime | Keeps state, prompts, the ledger, the widget and continuation. |

The user owns intent, the agent does the work, the auditor verifies, and the
runtime coordinates and records.

## 2. Overall flow

```text
user command (/goal, /sisyphus, /goal-*)
  -> guided draft and confirmation, or direct creation, or a lifecycle change
  -> runtime reconciles from disk and builds the request-only goal state
  -> agent works on the focused goal
  -> turn events update accounting and the ledger
  -> update_goal(complete) starts the auditor
  -> approved: archived at turn_end; rejected: goal stays open
```

## 3. State

- The goal pool: one file per open goal, `.pi/goals/active_goal_<timestamp>_<id>.md`.
- Session focus: the latest `pi-goal-focus` session entry. It is never written
  into goal files.
- `focusRevision`: bumps on every focus change. Pending completion and task
  confirmations carry it, so a result cannot land on a goal the session has
  since left.
- The ledger: one append-only file, `goal_events.jsonl`, with 29 event types
  covering creation, tweaks, focus, pause, resume, block, completion requests,
  audits, budgets, tasks and Oracle runs. It feeds the dashboard, activity
  feed, auditor-rejection memory and compaction text. Archived goals move to
  `.pi/goals/archived/`.

Before a focused command, tool or hook acts, the runtime re-reads the active
file, so edits made outside the session win over stale memory.

## 4. Commands

The user-owned palette has sixteen actions. Names can be changed in
`/goal-settings`; see [controls](controls.md).

| Command | Behavior |
|---|---|
| `/goal [seed]`, `/sisyphus [seed]` | Guided draft, then explicit confirmation |
| `/goal-direct <objective>`, `/sisyphus-direct <objective>` | Create at once, no draft |
| `/goal-tweak <change>` | Guided, confirmed change to the objective, tasks or budget |
| `/goal-pause`, `/goal-resume` | Pause (Esc also pauses) and resume |
| `/goal-clear` | Archive after confirmation; cancelling changes nothing |
| `/goal-list`, `/goal-status [verbose\|health]` | Read-only views |
| `/goal-focus`, `/goal-unfocus` | Choose, or detach from, the session's goal |
| `/goal-refresh` | Reload goal files and settings |
| `/goal-recovery [repair]` | Storage report; repair needs confirmation |
| `/goal-settings` | Settings and controls |
| `/goal-cancel` | Cancel a guided draft |

A Sisyphus goal is the same lifecycle with prompt-level differences: the
objective is numbered ordered steps with done criteria, and continuations tell
the agent not to skip or invent steps.

## 5. Creating a goal

`/goal` and `/sisyphus` start a guided draft, stored as `pi-goal-draft`
session entries so it survives compaction and tree moves. The agent asks
questions with `goal_questionnaire`, then calls `propose_goal_draft` with the
objective and an optional task tree. One dialog offers Confirm or Continue
Chatting. Confirm creates and focuses the goal in one step. `/goal-tweak`
uses the same flow for the focused goal and records `goal_tweaked` only after
confirmation.

## 6. Tools and guards

The tool list is fixed, because it sits at the start of the cached prompt:

| Tool | Role |
|---|---|
| `create_goal` | Create and focus a goal after an explicit user request |
| `get_goal` | Read the goal: summary, or paged objective, tasks and history |
| `update_goal` | `complete` (audited), `blocked` (needs the same blocker three turns running), `paused` (with a reason) |
| `set_goal_tasks` | Create or replace the task tree, after confirmation |
| `update_goal_task` | Start, complete, skip or reopen one task, or a batch |
| `goal_questionnaire`, `propose_goal_draft` | Drafting only |

Only `disableTasks` removes the two task tools. Pause, resume, clear, focus and
settings are user commands, not tools. A wrong call, such as `blocked` from a
paused goal, is rejected with a short explanation instead of hiding the tool.

The `tool_call` handler:

- blocks the goal tools while a draft is open, and refuses the drafting tools
  when no draft is open;
- blocks work tools after a stop tool in the same turn (only `get_goal` is
  allowed);
- blocks work tools when the checkpoint behind the turn is stale;
- records whether the turn did real goal work.

## 7. Continuation

With `autoContinue`, the runtime queues a checkpoint turn after each agent turn
for the focused goal only. Each checkpoint names its goal id, so a checkpoint
that arrives after a focus change or archive is stale and cannot drive work.
Continuation stops when:

- the agent completes or blocks the goal;
- the user pauses, clears or aborts;
- the token budget is reached;
- a turn ends with no goal work (when idle pacing is on, it slows down first);
- a run allowance, wait or provider error holds it.

`GoalScheduler` stores this intent on the goal, so it survives a reload.
Provider errors back off and retry, and a goal that runs out of retries is
paused with the error as the reason. Details are in
[advanced usage](advanced-usage.md).

## 8. Completion and the audit

1. `update_goal(complete)` must come from an active or paused goal. Open
   `blockCompletion` tasks warn. The runtime appends `completion_requested`.
2. If `disabled` is set, the audit is skipped and `audit_skipped` is recorded.
3. Otherwise a `pi-goal-audit-event` message (phase `started`) is shown, the
   widget shows audit progress, and the auditor session starts. It sees the
   objective, the claim and goal metadata, can use `read`, `grep`, `find`,
   `ls` and `bash`, and must end with `<approved/>` or `<disapproved/>`. An
   error, abort or missing marker rejects.
4. The verdict is shown and recorded as `audit_result`. A rejection leaves the
   goal open and its objections are put in later prompts.
5. On approval the goal is marked complete in memory and archived at
   `turn_end`, with `goal_completed` appended and focus cleared.

Escape during an audit offers "complete without audit" or "continue working".

## 9. Blocked, paused, budget and compaction

- `blocked` records a stop reason and ends continuation. If the Oracle is
  enabled, one read-only consultation runs first.
- `/goal-pause` and Esc set `paused` with `autoContinue` off. `/goal-resume`
  restarts a paused or blocked goal.
- At the `token_budget` the goal becomes `budget_limited` once, a wrap-up
  reminder is sent, and continuations are cancelled. It never implies done.
- On compaction the runtime re-arms accounting and adds a short summary after
  compaction: the focus, recent events, the last rejection and the number of
  other open goals.

## 10. Design choices

- **Fixed tool list.** A stable list keeps the prompt cache; state-aware
  executors reject bad calls instead.
- **One mutation boundary.** `GoalService` fixes the order reconcile, write,
  ledger, memory, so handlers cannot corrupt files or the ledger.
- **No verification summary.** The auditor works from real artifacts, not from
  a claim written by the agent being checked.
- **Budget is not completion.** `budget_limited` stops work without saying done.
- **Disk is authoritative.** Reconciling first picks up outside edits and
  avoids bringing back deleted files.
- **Cross-process safety.** Each goal has a `revision`, and a short per-goal
  lock under `.pi/goals/.locks` guards writes. A stale writer gets a typed
  conflict. `update_goal_task` retries once only if the same task is
  unchanged.
