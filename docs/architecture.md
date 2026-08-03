# pi-goal Architecture

This document describes the shipped `pi-goal` extension as it exists now. It focuses on implemented behavior.

## Runtime shape

`extensions/goal.ts` is the orchestration layer. It owns pi integration points:

- slash commands;
- tool registration;
- session events;
- auto-continue timers;
- usage accounting;
- coordination with extracted prompt, storage, policy, questionnaire, goal-pool, and widget modules.

The runtime is a focused-goal view over a project goal pool:

```ts
let goalsById: Map<string, GoalRecord>;
let focusedGoalId: string | null;
```

`goalsById` is reconstructed from `.pi/goals/active_goal_*.md` plus compatible legacy session entries. `focusedGoalId` is reconstructed from branch-local `pi-goal-focus` session entries. The focused id is not serialized into goal markdown.

Reusable logic is split into smaller modules:

| Module | Responsibility |
|---|---|
| `goal-record.ts` | Goal record types, creation, cloning, usage normalization, persisted-record migration |
| `goal-pool.ts` | Open-goal pool helpers, focus resolution, list output, selector labels, unfocused summaries |
| `goal-core.ts` | Compact display formatting, status labels, objective title cleanup |
| `goal-draft.ts` | Lightweight confirmation prompt, plain-text draft confirmation report, proposal validation, drafting-stage tool gate |
| `goal-policy.ts` | Lifecycle policy, abort/pause/resume/complete validation, compaction policy, full result reports |
| `goal-auditor.ts` | Independent pi auditor agent prompt/config/decision parsing and completion audit execution |
| `goal-questionnaire.ts` | Built-in questionnaire types, normalization, answer formatting, TUI question runner, proposal confirmation dialog, question-tool registration |
| `goal-tool-names.ts` | Published tool-name constants, active-tool lists, post-stop allowlist, goal work-tool list, question-like tool detection |
| `prompts/goal-prompts.ts` | Active-goal, continuation, tweak-drafting, and stale-checkpoint prompt builders |
| `storage/goal-files.ts` | Goal path safety, serialization/parsing, active-file scanning, active-file writes, archive writes, prompt-body merge from disk |
| `widgets/goal-widget.ts` | Above-editor Goal Beacon component, blocker/status rendering, `+N open` and unfocused rendering |
| `widgets/goal-notifications.ts` | Widget-style notification text for goal lifecycle toasts |

## Lifecycle

```text
/user command
  ├─ /goals or /sisyphus
  │    └─ confirmationIntent = {focus, originalTopic, startedAt}
  │         ├─ agent clarifies, researches, or grills only when needed
  │         ├─ targeted reconnaissance is prompt-guided, not hard-blocked
  │         └─ propose_goal_draft validates focus/objective and asks user to confirm
  │              ├─ Continue Chatting: keep clarifying without creating a goal
  │              └─ Confirm: create active goal, write .pi/goals file, focus it, print full objective
  │
  ├─ /goals-set or /sisyphus-set
  │    └─ direct user command creates active goal, writes .pi/goals file, focuses it, and starts execution
  │
  ├─ focused active goal
  │    ├─ autoContinue queues checkpoint turns
  │    ├─ pause_goal pauses on real blockers
  │    ├─ abort_goal aborts/archives obsolete or impossible goals
  │    └─ update_goal starts independent auditor; <approved/> archives and prints full completion report
  │
  ├─ paused goal
  │    ├─ /goal-resume restarts autoContinue
  │    ├─ update_goal can complete from existing evidence
  │    └─ abort_goal can archive without resuming
  │
  ├─ multiple open goals
  │    ├─ /goal-list shows the project goal pool
  │    ├─ /goal-focus chooses the session focus
  │    ├─ /goal-unfocus clears only the session focus and leaves the shared goal open
  │    └─ unfocused sessions guide the user to choose instead of letting the agent decide
  │
  └─ /goal-clear or /goal-abort archives the focused goal or cancels drafting
```

## Goal pool and session focus

The disk layout already supports multiple active files. The extension now treats those files as the durable project-level open goal pool:

```text
.pi/goals/active_goal_<timestamp>_<id>.md
```

`readActiveGoalPool(ctx)` scans that directory, ignores invalid files and symlinks, parses each safe active file, sanitizes metadata paths, drops completed records, and returns a deterministic `Map<goalId, GoalRecord>`.

Session focus is separate. Focus changes append a custom session entry:

```ts
{
  version: 1,
  focusedGoalId: string | null,
  reason: "created" | "selected" | "unfocused" | "resumed" | "completed" | "cleared" | "aborted" | "migrated"
}
```

Because this is stored with `pi.appendEntry("pi-goal-focus", ...)`, it is session/branch-local and is not sent to the LLM. On `session_start` and `session_tree`, `loadState(ctx)` scans `ctx.sessionManager.getBranch()` for the latest focus entry, scans active goal files, and resolves focus as follows:

1. Use a valid focused id from the latest focus entry.
2. If the latest focus entry explicitly has `focusedGoalId: null`, or points at a missing/stale goal, remain unfocused.
3. If no focus entry exists, merge a compatible legacy `pi-goal-state { version: 3, goal }` goal and focus it. If disk already has the same id, the disk record wins and the legacy session record only supplies focus.
4. If no focus entry exists and `autoSelectSingleGoal` is enabled, auto-focus the sole open goal for compatibility. The default is disabled.
5. Otherwise remain unfocused until the user explicitly selects a goal. `/goal-unfocus` appends a null focus entry so the current session stays detached without modifying the shared goal or appending a project-global focus event. Resume and tree reconstruction preserve that explicit null focus.

Focus is human-owned. No agent tool can switch focus. Lifecycle tools operate only on the focused goal.

## Goal styles

### Regular goal

Regular goals are open-ended objectives. The agent decides the next concrete action each checkpoint turn, then completes only after the objective is actually satisfied.

### Sisyphus goal

Sisyphus is a light variant of the same goal lifecycle. It does not have a separate execution state machine or step counter. The only differences are prompt/criteria level:

- drafting asks for a patient ordered-execution style when relevant;
- continuations remind the agent not to rush, skip, or invent preflight steps;
- completion still uses `update_goal(status="complete")`, with the stricter expectation that the whole ordered objective is actually satisfied.

The legacy `step_complete` tool remains registered as a hidden compatibility no-op for old transcripts, but it is not exposed as an active work tool and is not required for completion.

## Drafting and confirmation

Drafting is now a lightweight user-intent confirmation conversation. For `/goals` and `/sisyphus`, the runtime stores only a thin session-local `confirmationIntent` with the requested focus, original topic, and start time. The agent may ask a focused question when the topic is vague, perform targeted read-only research when it improves the goal contract, grill assumptions or ordered steps, or proceed directly to `propose_goal_draft` when the request is already concrete.

`propose_goal_draft` enforces:

- a confirmation intent must be active;
- objective must be non-empty;
- `sisyphus` must match the command the user invoked.

A deprecated optional `draftId` parameter is accepted for compatibility but ignored; normal goal confirmation no longer depends on hidden prompt identity. Confirming a draft creates a new active goal and focuses it, leaving other active files untouched. Confirmation UI errors fail closed: the goal is not created and confirmation remains active. After confirmation, normal work tools are available for execution immediately.

## Command focus behavior

- `/goals` and `/sisyphus` start discussion-based confirmation before creating a new focused goal.
- `/goals-set` and `/sisyphus-set` directly create and focus a new open goal from the supplied objective.
- `/goal-list` prints all open goals with id, status, mode, usage, objective title, path, and a focus marker.
- `/goal-focus` uses `ctx.ui.select` when multiple goals are open and updates only session focus.
- `/goal-unfocus` writes a null session focus entry, clears continuation/runtime state, aborts in-flight work and audits for that session, and leaves the shared active goal file and project-global focus ledger unchanged. Focus revision tokens prevent pending completion, tweak, and task-list confirmation results from mutating a goal after detachment.
- `/goal-status` and `/goal` show the focused goal plus an `other open goals` hint.
- `/goal-resume` resumes the focused paused goal; when unfocused with multiple open goals, it asks the user to choose. Choosing an already active goal only focuses it.
- `/goal-clear` and `/goal-abort` archive only the focused/selected goal and never clear the whole pool at once.
- During goal confirmation, `/goal-clear` and `/goal-abort` only cancel the confirmation flow; they do not archive an unrelated focused goal unless the user invokes a lifecycle command after confirmation is cancelled.
- `/goal-tweak` revises only the focused active or paused goal; when unfocused with open goals, it asks the user to choose one.
- `/goal-pause` also asks the user to choose when the session is unfocused and open goals exist.
- `/goal-settings` opens extension settings. The current settings screen contains `auditor`, where provider/model/thinking_level are edited via free-text inputs.

When `propose_goal_draft` asks for confirmation, the UI shows a full plain-text draft report rather than a Markdown preview. On confirmation, the result prints the full finalized objective in the conversation. The same objective is also written to the active goal file.

## Tool visibility

Tool visibility is recomputed whenever state changes. Built-in work tools remain registered in the base prompt so they can be used after a confirmed draft; lifecycle-specific gates decide whether a call is allowed.

- Goal confirmation keeps `propose_goal_draft` stable and exposes `goal_question`, `goal_questionnaire`, and `get_goal` when structured clarification helps; workhorse tools are prompt-guided rather than hidden by a hard whitelist.
- Tweak drafting exposes question tools, `get_goal`, and `apply_goal_tweak`.
- Active goals expose `get_goal`, `update_goal`, `pause_goal`, and `abort_goal`.
- Paused goals expose `get_goal`, `update_goal`, and `abort_goal`, so the agent can complete or abandon a paused goal without resuming substantive work.
- Unfocused sessions with open goals expose no lifecycle mutation tools; prompts and status guide the user to `/goal-focus`.
- `step_complete` is hidden legacy compatibility.
- `create_goal` remains hidden and direct calls are rejected; normal creation goes through `propose_goal_draft`.

The `tool_call` interceptor blocks:

- non-`get_goal` tools after a stop tool has fired in the same turn.

## Disk format

Active and archived goal files live under `.pi/goals/`. Multiple active files may exist simultaneously.

```text
.pi/goals/active_goal_<timestamp>_<id>.md
.pi/goals/archived/goal_<timestamp>_<id>.md
```

Each file has extension-owned metadata and a user-editable `# Goal Prompt` section. Before focused commands, tools, and lifecycle hooks act, the runtime re-reads the focused active file and reconciles lifecycle state from disk. External pause/archive/delete/status changes therefore win over stale memory and deleted active files are not resurrected. Prompt-body edits are still picked up from `# Goal Prompt`; session focus is never written to these files.

Path safety checks reject absolute paths, traversal, NUL bytes, symlinks, and paths outside the goal directories.

## Auto-continue and stop conditions

When `autoContinue` is on, the extension queues continuation prompts after agent turns for the focused goal only. The loop stops or pauses when:

- the agent calls `update_goal(status="complete")`;
- the agent calls `pause_goal`;
- the agent calls `abort_goal`;
- the user invokes `/goal-pause`, `/goal-clear`, or `/goal-abort`;
- the user aborts the turn;
- a turn ends without meaningful goal-work tool activity.

Continuation prompts include a goal id so stale prompts can be detected and neutralized. If focus changes or the goal is archived before a queued checkpoint runs, the checkpoint becomes stale and cannot drive task work.

`get_goal`, question tools, and draft proposal tools are not meaningful progress for the empty-turn gate. Only lifecycle mutations and actual workhorse tools mark a turn as goal work for continuation purposes.

## Completion output

Completion is intentionally verbose in the tool result and guarded by an independent auditor agent. `complete_goal(status="complete")` is valid for active and paused goals; paused goals do not need to be resumed just to record completion when existing evidence is sufficient.

Before archiving, the tool starts a separate in-memory pi session with a focused auditor prompt. The auditor receives the objective, executor completion summary, and goal metadata, can inspect the workspace with `read`, `grep`, `find`, `ls`, and `bash`, and must end with exactly one marker:

- `<approved/>` allows archiving;
- `<disapproved/>`, no marker, an error, or abort rejects completion and leaves the goal open.

The auditor uses the current/default model unless `.pi/pi-goal-x-settings.json` overrides `provider`, `model`, or `thinkingLevel`. `/goal-settings` opens a TUI showing all settings (disabled, provider, model, thinking_level, subtaskDepth, disableTasks, disableContracts); each editable field opens a free-text input and saves back to `.pi/pi-goal-x-settings.json`.

The user sees:

- a `Goal complete.` header;
- the executor's optional completion summary/evidence;
- the auditor's approval report;
- the full current goal details.

This mirrors creation: the finalized goal is visible when created, and the final report is visible when completed. The gate is intentionally semantic rather than paperwork-based: scaffold-only, alpha, generated-template, proxy-metric, build-only, or weakly verified completions should be disapproved by the auditor.

## Tests

Fast local tests live in `tests/` and run with:

```bash
npm test
npm run check
```

They cover:

- parsing and display helpers;
- lightweight confirmation prompt and proposal gates;
- questionnaire normalization and answer formatting;
- tool-name constants and question-like detection;
- lifecycle policy, including abort and paused-goal completion;
- auditor config/prompt/marker parsing, including disapproval winning over approval;
- goal-pool and focus resolution helpers;
- active goal file scanning;
- unfocused prompt guidance;
- focused/unfocused widget rendering;
- Sisyphus prompt-style behavior;
- auto-continue empty-turn guard behavior;
- full creation/completion report formatting.

The `experiments/` harness provides end-to-end coverage with real pi sessions and model calls.
