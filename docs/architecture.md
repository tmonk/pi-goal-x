# pi-goal Architecture

This describes the extension as shipped. For how the agent, the auditor and
the runtime work together, see [agent flow design](agent-flow-design.md).

## Runtime shape

`extensions/goal.ts` is a thin installer. It registers two message renderers,
builds one `GoalCore`, then registers commands, tools and event handlers. A
delegated session (the auditor or Oracle) only installs the context filter.

`GoalCore` (`goal-state.ts`) is a facade with 28 members. The state lives in
`GoalSessionState`; each group of behavior lives in its own service, and
`createGoalCore` wires them together. Callers reach a service directly
(`core.state`, `view`, `focus`, `lifecycle`, `progress`, `watch`,
`goalService`, `scheduler`, `runtime`) and the few members left on the core are
shortcuts that join several services. Modules never take the whole core: each
declares only the slices it uses, taken from `goal-core-types.ts`, so its
signature shows what it touches and a test can fake just that.

```text
goal.ts
 └─ createGoalCore (goal-state.ts)
     ├─ GoalSessionState   pool, focus, revision, flags (no I/O, no UI)
     ├─ GoalFocus          change focus, drop a goal, restore focus at session start
     ├─ GoalLifecycle      create, stop, pause, archive, auditor toggle, save
     ├─ GoalProgress       charge tokens and time, enter budget_limited
     ├─ GoalWatch          stall and budget warnings
     ├─ GoalView           widget, status line, audit progress and result cards
     ├─ GoalService        the only writer: files, ledger, memory
     ├─ GoalRuntime        continuation, stale checkpoints, turn-stop guard
     ├─ GoalScheduler      durable dispatch intent, waits, run allowance
     ├─ GoalAccounting     idempotent token and time charging
     ├─ GoalInterruption   a user-stopped turn is not retried
     └─ GoalAuditMessages  audit transcript output, flushed when idle
```

## Modules

All files are in `extensions/`.

### Wiring and session

| File | Responsibility |
|---|---|
| `goal.ts` | Installer: renderers, core, commands, tools, events |
| `goal-state.ts` | `GoalCore` interface and `createGoalCore` wiring |
| `goal-core-types.ts` | The small slices of `GoalCore` (`GoalDiskSync`, `GoalUiRefresh`, ...) that modules combine with `&` |
| `goal-session-state.ts` | `GoalSessionState`, `ActiveGoalAudit`, `FocusToken` |
| `goal-focus.ts` | `GoalFocus` |
| `goal-lifecycle.ts` | `GoalLifecycle` |
| `goal-progress.ts` | `GoalProgress` |
| `goal-watch.ts` | `GoalWatch` |
| `goal-view.ts` | `GoalView` and the finished-audit card |
| `goal-session-safety.ts` | Stale-context detection, delegated-session filter, `GoalAuditMessages` |
| `goal-interruption.ts` | `GoalInterruption` |
| `goal-context.ts` | Registers the `context_with_system` filter |

### Tools, commands and events

| File | Responsibility |
|---|---|
| `goal-core-tools.ts` | `create_goal`, `get_goal`, `update_goal` |
| `goal-update-flows.ts` | The blocked flow (with Oracle) and the agent-pause flow |
| `goal-completion.ts` | Completion transaction: audit, then `commitGoalCompletion` |
| `goal-task-tools.ts` | `set_goal_tasks`, `update_goal_task` |
| `goal-task-tree.ts` | Flat to tree conversion, id-stable merge, counting, rendering, tool schema |
| `goal-task-confirmation.ts` | Task list confirmation dialog |
| `goal-task-index.ts`, `goal-task-count.ts`, `goal-task-derive.ts` | Cached task snapshots, the one subtree walker, tasks derived from an ordered objective |
| `goal-tool-inputs.ts` | Normalizes `update_goal` and task progress inputs |
| `goal-tool-names.ts` | Tool names, the fixed tool list, work/progress classification |
| `goal-drafting.ts` | Guided draft state, stored as `pi-goal-draft` session entries |
| `goal-drafting-tools.ts` | `goal_questionnaire`, `propose_goal_draft`, goal creation and tweak from a draft |
| `goal-control-tools.ts` | `goal_control` (`revise`, `archive`) and the shared clear confirmation and archive flow |
| `goal-commands.ts` | Command routing and handlers for the sixteen actions |
| `goal-controls.ts` | Action ids, key actions, command and key settings |
| `goal-settings-menu.ts` | The `/goal-settings` editor |
| `goal-events.ts` | Pi event handlers (see below) |
| `goal-messages.ts` | Reads what Pi hands us: continuation markers, aborted, failed and network-error turns, token use, progress tool calls |
| `goal-terminal-input.ts` | Key handling: pause, audit interrupt, dashboard keys, shortcuts |

`goal-events.ts` handles `context_with_system`, `before_provider_request`,
`agent_start`, `message_start`, `turn_start`, `tool_call`,
`tool_execution_end`, `turn_end`, `message_end`, `session_start`,
`session_before_compact`, `session_compact`, `session_compact_failed`,
`session_tree`, `before_agent_start`, `agent_end`, `agent_settled` and
`session_shutdown`. Its model-facing goal text comes from
`goal-context-parts.ts`, which uses `goal-compaction.ts` for the text after a compaction.

### Mutation, runtime and policy

| File | Responsibility |
|---|---|
| `goal-service.ts` | `GoalService`, the sole mutation boundary: locks, file writes, the ordered write, ledger, memory commit |
| `goal-service-types.ts` | Ref, mutation spec and outcome, task-update types |
| `goal-turn-buffer.ts` | `TurnBuffer`, the in-memory state of one turn's transaction |
| `goal-reconcile.ts` | `planReconcile`, a pure plan for reconciling memory with disk |
| `goal-task-update.ts` | Find, validate and apply task updates (single and batch) |
| `goal-usage-baseline.ts` | Additive merge of token and time usage |
| `goal-ledger-sink.ts` | Best-effort ledger append; only `GoalService` calls it |
| `goal-runtime.ts` | `GoalRuntime` |
| `goal-scheduler.ts` | `GoalScheduler`: reads settings and the clock, saves through the service |
| `goal-scheduler-rules.ts` | Pure decisions: idle pacing, waits, dispatch kind, claiming, release |
| `goal-scheduler-host.ts` | `SchedulerHost` and `InterruptionHost`: what each class needs from the core |
| `goal-scheduler-state.ts` | Persisted scheduler state and its summary text |
| `goal-wake-timer.ts` | Re-armable timer that does not keep the process alive |
| `goal-accounting.ts` | `GoalAccounting`, budget helpers, context usage line |
| `network-error-backoff.ts` | Retry plan for provider errors |
| `goal-policy.ts` | Gates for complete, blocked, pause and tasks; reports |
| `goal-record.ts` | Record types, creation, cloning, migration of saved records |
| `goal-pool.ts` | Open-goal pool, focus resolution, list and selector text |
| `goal-contract.ts` | Verification contract extraction, prompt-safe objectives |

### Audit and Oracle

| File | Responsibility |
|---|---|
| `goal-auditor.ts` | Runs the independent auditor session and parses its decision |
| `goal-auditor-prompt.ts` | The auditor prompt |
| `auditor-selector.ts` | Model and thinking-level choices for the auditor |
| `goal-oracle.ts` | Opt-in, read-only blocker Oracle |

### Ledger and storage

| File | Responsibility |
|---|---|
| `goal-ledger.ts` | Append and read the JSONL ledger, with a cache; re-exports the pieces below |
| `goal-ledger-events.ts` | The `GoalLedgerEvent` union (29 event types) |
| `goal-ledger-validate.ts` | Per-event field checks |
| `goal-ledger-reconstruct.ts` | Folds events into per-goal state, incrementally so a checkpoint can resume mid-stream |
| `goal-ledger-queries.ts` | Read-only lookups: latest audit, recent events for a goal |
| `goal-ledger-checkpoint.ts` | Derived checkpoint file (version 4), its types and codec |
| `goal-ledger-checkpoint-store.ts` | In-process checkpoint mirror, write throttle, file read and write |
| `goal-ledger-index.ts` | Bounded per-goal working set (recent events, audit, Oracle state) |
| `goal-activity.ts` | Ledger to readable activity items |
| `goal-detail.ts` | Lossless paged objective, task and history text |
| `goal-recovery.ts` | `/goal-recovery` report and guarded repair |
| `goal-session-health.ts` | Read-only checkpoint health report for session files |
| `storage/goal-files.ts` | Goal file read, write and archive, and the active pool scan |
| `storage/goal-paths.ts` | Goal directories, file-name patterns, path checks (no disk access) |
| `storage/goal-file-format.ts` | Goal file text format: JSON metadata plus markdown body (pure string work) |
| `storage/goal-pool-snapshot.ts` | One-file pool snapshot so a cold start skips scanning every goal file |
| `storage/goal-root.ts` | Where the goal pool lives (`goalsRoot`, `PI_GOAL_ROOT`) |
| `storage/goal-lock.ts`, `storage/file-lock.ts` | Per-goal lock and the shared cross-process file lock |
| `storage/atomic-rename.ts` | Atomic file replace, tolerant of Windows rename errors |

### Prompts and cache

| File | Responsibility |
|---|---|
| `prompts/goal-prompts.ts` | Checkpoint, goal state, stale and unfocused prompts |
| `prompts/goal-draft-prompts.ts` | Drafting prompt and confirmation text |
| `goal-prompt-cache.ts` | Moves the explicit cache breakpoint before the request-only tail |
| `goal-live-retention.ts` | Keeps earlier request-only tails so implicit-cache prefixes stay stable |

### Settings

| File | Responsibility |
|---|---|
| `settings/schema.ts` | Setting types, defaults, leaf parsers, key formats |
| `settings/files.ts` | Global and project settings paths, cached layer reads |
| `settings/resolve.ts` | Merge layers and environment into `GoalSettings`; effective report |
| `settings/mutate.ts` | Locked read-modify-write of one layer |
| `i18n/index.ts` | `t()` and `tn()`: English text at the call site is the key and the fallback |
| `i18n/locales.ts` | Registered translation catalogs and `configureLocale` |

### Questionnaire and dialogs

| File | Responsibility |
|---|---|
| `goal-questionnaire.ts` | `runGoalQuestionnaire`, `showProposalDialog` |
| `questionnaire/state.ts` | Plain state and the functions that change it |
| `questionnaire/keys.ts` | Key handling over that state |
| `questionnaire/render.ts`, `context.ts` | Layout and question context text |
| `questionnaire/basic-dialogs.ts` | One-dialog-per-question fallback |
| `questionnaire/types.ts` | Shared types |
| `goal-dialog-fit.ts` | Fit dialog lines to the terminal height |
| `goal-dialog-controls.ts` | Snapshot of dialog keys |

### Display

| File | Responsibility |
|---|---|
| `goal-format.ts` | Entry names, summaries, message renderers, message checks |
| `goal-display.ts` | Status labels, durations, token text, footer status |
| `goal-status.ts` | `/goal-status` text |
| `widgets/goal-dashboard-model.ts` | The one dashboard model (pure data, no TUI) |
| `widgets/dashboard-format.ts` | Plain-text numbers: durations, tokens, percentages, budget |
| `widgets/dashboard-box.ts` | Box drawing, padding and truncation within the terminal width |
| `widgets/goal-dashboard-renderer.ts` | Compact, expanded and unfocused renderers |
| `widgets/goal-audit-renderer.ts` | Audit dashboard and result card |
| `widgets/goal-widget.ts` | The above-editor widget component |
| `widgets/widget-height.ts` | Height cap and stable-height rules for the widget |
| `widgets/task-viewport.ts` | Pure task-list window and anchoring maths |
| `widgets/task-scroll.ts` | Mutable scroll offsets and the re-anchor rule |
| `widgets/auditor-dashboard-model.ts` | Audit progress and result models |
| `widgets/goal-controls-dialog.ts`, `choice-dialog.ts`, `goal-escape-dialog.ts` | Dialogs |
| `widgets/goal-notifications.ts`, `text-cache.ts` | Toast text, cached ANSI wrapping |

## Sole mutation boundary

`GoalService` is the only code that writes goal files, archives or ledger
events. Each mutation runs in this order:

```text
reconcile (disk wins over stale memory)
  -> check expected goal id and focus revision
  -> mutate a clone
  -> write or archive the file, under the per-goal lock
  -> append ledger events (best effort)
  -> commit to memory and focus
  -> return effects (ok, goal, focusChanged, messages)
```

If the write fails, nothing is committed or appended. If only the ledger
append fails, the change stands and a `warning` diagnostic is reported. A stale
writer gets a typed conflict that carries the current revision, instead of
overwriting.

## Goal pool and focus

Open goals are the files `.pi/goals/active_goal_<timestamp>_<id>.md` (or the
same layout under `goalsRoot`). `readActiveGoalPool` scans them, skips invalid
files and symlinks, and returns the open records.

Focus belongs to the session. Each change appends a `pi-goal-focus` session
entry, so focus is branch-local and never sent to the model. On `session_start`
and `session_tree` focus is resolved in this order:

1. The latest focus entry, if its goal still exists.
2. An explicit `null` entry, or a stale id: stay unfocused.
3. No entry: merge a legacy `pi-goal-state` goal and focus it.
4. No entry and `autoSelectSingleGoal` on: focus the only open goal.
5. Otherwise stay unfocused until the user chooses.

No agent tool can change focus.

## Tools

The goal tool list is fixed so the provider's prompt cache is not thrown away:
`create_goal`, `get_goal`, `update_goal`, `set_goal_tasks`, `update_goal_task`,
`goal_questionnaire` and `propose_goal_draft`. Only `disableTasks` removes the
two task tools. Status, focus, drafting and audits never change the list.
Executors reject calls that do not fit the current state, and the `tool_call`
handler blocks the goal tools while a draft is open, blocks work tools after a
stop tool in the same turn, and blocks work tools from a stale checkpoint.

## Runtime, accounting and scheduling

- `GoalAccounting` charges each token and time interval once.
- `GoalRuntime` queues continuations, tracks the stale checkpoint and the
  turn-stop guard, and sends one-shot reminders.
- `GoalScheduler` persists dispatch intent, waits and the run allowance
  (`maxAutonomousRuns`). Continuation is immediate by default; with
  `idleContinuationBackoff` repeated idle runs wait 30 seconds, doubling to
  five minutes. See [advanced usage](advanced-usage.md).
- `agent_settled` with `aborted` stops continuation and pauses the goal.
- A `token_budget` moves the goal to `budget_limited` once, appends
  `goal_budget_limited`, arms wrap-up steering and cancels continuations. It
  never means complete.

## Completion

`update_goal({status: "complete"})` is valid for active and paused goals. The
runtime starts an independent auditor session that ends with `<approved/>` or
`<disapproved/>`; anything else rejects. On approval the goal is marked
complete in memory and archived at `turn_end`, so the agent sees the audit
result first. `disabled: true` skips the audit and records `audit_skipped`.
Escape during an audit offers "complete without audit" or "continue working".

## Disk format

Goal files hold extension metadata and a user-editable `# Goal Prompt`
section. Before focused commands and hooks act, the runtime re-reads the active
file and reconciles from disk. Path checks reject absolute paths, traversal,
NUL bytes and symlinks. The ledger (`goal_events.jsonl`) is append-only and is
never rewritten. Checkpoints beside it are derived and rebuilt from the ledger
when old or corrupt. Older goal files, ledgers and session entries stay
readable.

## Tests

```bash
npm run check
npm run test:all
```

Unit and integration suites run through `scripts/run-unit-tests.mjs` with
small test adapters for the Pi SDK. `test:serial` runs the same files with the
real SDK, one process at a time. `tests/e2e/run.ts` is a manual real-model run.
Shared helpers live in `tests/support/`.

See also [prompt caching](prompt-caching.md), [controls](controls.md) and the
[unified dashboard](unified-dashboard.md). Design history is in `specs/`.
