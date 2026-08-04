# pi-goal Architecture

This document describes the shipped `pi-goal` extension as it exists now. It focuses on implemented behavior.

## Runtime shape

`extensions/goal.ts` is a thin installer (under 50 lines). It registers the two
custom message renderers, builds the shared `GoalCore` (goal-state.ts), and
registers the command palette, the tool surface, and the lifecycle event
handlers from their dedicated modules:

| Module | Responsibility |
|---|---|
| `goal.ts` | Thin installer: renderers + module registration only |
| `goal-state.ts` | `GoalCore`: all mutable state (pool, focus, audit/UI flags), `GoalService`/`GoalRuntime`/`GoalAccounting` wiring, persistence and reconciliation closures, widget status |
| `goal-tools.ts` | Registration composition only: a 14-line installer that wires `registerCoreTools` + `registerTaskTools` |
| `goal-core-tools.ts` | `create_goal` / `get_goal` / `update_goal` executors plus the blocked flow |
| `goal-completion.ts` | The completion transaction: `runGoalCompletionFlow` (audit orchestration) + shared `commitGoalCompletion` |
| `goal-task-tools.ts` | `set_goal_tasks` / `update_goal_task` executors plus flat parent-linked conversion, id-stable merge, `countTasks` |
| `goal-task-confirmation.ts` | Task-only confirmation boundary (`{decision}` result, no auditor toggle) |
| `goal-commands.ts` | The curated ten-command palette and its handlers |
| `goal-events.ts` | The 13 lifecycle event handlers (`context`, `turn_start`, `tool_call`, `tool_execution_end`, `turn_end`, `message_end`, `session_start`, `session_before_compact`, `session_compact`, `session_tree`, `before_agent_start`, `agent_end`, `session_shutdown`) |
| `goal-widget.ts` | Terminal input keybindings (Esc pause / abort-audit, Ctrl+Shift+T overlay) and the hidden debug helpers |
| `goal-format.ts` | Pure formatting/message-introspection helpers and renderers |
| `goal-service.ts` | `GoalService` — the sole mutation boundary: ordered reconcile → id/focus-revision validation → clone-mutate → write/archive → ledger → memory commit → returned effects |
| `goal-runtime.ts` | `GoalRuntime` — continuation scheduling, stale checkpoint state, turn-stop guard, one-shot steering reminders |
| `goal-accounting.ts` | `GoalAccounting` — serialized idempotent token/time accounting, budget helpers |
| `goal-record.ts` | Goal record types, creation, cloning, usage normalization, persisted-record migration |
| `goal-pool.ts` | Open-goal pool helpers, focus resolution, list output, selector labels, unfocused summaries |
| `goal-core.ts` | Compact display formatting, status labels, objective title cleanup |
| `goal-contract.ts` | Record/input parser: verification-contract extraction and objective prompt-safety |
| `goal-policy.ts` | Lifecycle policy and validation (completion/blocked/resume/task gates), task-tree helpers, compaction policy, result reports |
| `goal-auditor.ts` | Independent pi auditor agent prompt/config/decision parsing and completion audit execution |
| `goal-ledger.ts` | Single-file goal ledger append/read/reconstruction (18 event types incl. `task_reopened`) |
| `goal-questionnaire.ts` | Proposal confirmation dialog helpers (drafting-era question tools removed) |
| `goal-tool-names.ts` | The five published tool-name constants, fixed three/five profiles, work/progress classification, post-stop allowlist |
| `prompts/goal-prompts.ts` | Bounded five-tool steering prompts (active-goal, continuation, stale-checkpoint, unfocused, budget-limited) |
| `storage/goal-files.ts` | Goal path safety, serialization/parsing, active-file scanning, active-file writes, archive writes, prompt-body merge from disk |
| `widgets/goal-widget.ts` | Above-editor Goal Beacon component |
| `widgets/goal-notifications.ts` | Widget-style notification text for goal lifecycle toasts |

The runtime is a focused-goal view over a project goal pool:

```ts
let goalsById: Map<string, GoalRecord>;
let focusedGoalId: string | null;
```

`goalsById` is reconstructed from `.pi/goals/active_goal_*.md` plus compatible
legacy session entries. `focusedGoalId` is reconstructed from branch-local
`pi-goal-focus` session entries. The focused id is not serialized into goal
markdown.

## Sole mutation boundary

`GoalService` owns the ordered mutation pipeline. Every goal-file write,
archive, and ledger append routes through it:

```text
reconcile (disk wins over stale memory)
  → expected-id / focus-revision validation (async operations invalidated on focus change)
  → mutate a clone (never the live object)
  → write or archive the active file
  → append ledger events (best-effort; failure is currently silent)
  → commit to memory + focus
  → return effects (ok, goal, focusChanged, messages)
```

If the write fails, nothing commits and nothing is appended. If the ledger
append fails after a successful write, the transition still stands and the
failure is surfaced through the `onDiagnostic` hook (an observable
`severity: warning, source: ledger` diagnostic) without rolling back the
authoritative state write. Handlers keep validation and
runtime/UI effects; they never touch storage directly. `goal.ts` has zero
direct write or ledger calls.

## Lifecycle

```text
/user command or explicit create_goal request
  ├─ /goal <objective> or /sisyphus <objective>
  │    └─ direct creation: objective (1–4000 chars) → active goal file → focused → autoContinue
  ├─ focused active goal
  │    ├─ autoContinue queues checkpoint turns
  │    ├─ update_goal({status:"blocked"}) records a distinct blocked state after the same
  │    │   blocker recurs on three consecutive turns
  │    └─ update_goal({status:"complete"}) starts the independent auditor; <approved/> archives
  ├─ paused/blocked goal
  │    ├─ /goal-resume restarts autoContinue
  │    └─ update_goal(complete) can complete from existing evidence
  ├─ multiple open goals
  │    ├─ /goal-list shows the project goal pool
  │    ├─ /goal-focus chooses the session focus
  │    ├─ /goal-unfocus clears only the session focus and leaves the shared goal open
  │    └─ unfocused sessions guide the user to choose instead of letting the agent decide
  └─ /goal-clear archives the focused goal (user-owned abandonment)
```

## Goal pool and session focus

The disk layout supports multiple active files. The extension treats those
files as the durable project-level open goal pool:

```text
.pi/goals/active_goal_<timestamp>_<id>.md
```

`readActiveGoalPool(ctx)` scans that directory, ignores invalid files and
symlinks, parses each safe active file, sanitizes metadata paths, drops
completed records, and returns a deterministic `Map<goalId, GoalRecord>`.

Session focus is separate. Focus changes append a custom session entry:

```ts
{
  version: 1,
  focusedGoalId: string | null,
  reason: "created" | "selected" | "unfocused" | "resumed" | "completed" | "cleared" | "migrated"
}
```

Because this is stored with `pi.appendEntry("pi-goal-focus", ...)`, it is
session/branch-local and is not sent to the LLM. On `session_start` and
`session_tree`, `loadState(ctx)` scans `ctx.sessionManager.getBranch()` for the
latest focus entry, scans active goal files, and resolves focus as follows:

1. Use a valid focused id from the latest focus entry.
2. If the latest focus entry explicitly has `focusedGoalId: null`, or points at
   a missing/stale goal, remain unfocused.
3. If no focus entry exists, merge a compatible legacy `pi-goal-state { version: 3, goal }`
   goal and focus it. If disk already has the same id, the disk record wins and
   the legacy session record only supplies focus.
4. If no focus entry exists and `autoSelectSingleGoal` is enabled, auto-focus
   the sole open goal for compatibility. The default is disabled.
5. Otherwise remain unfocused until the user explicitly selects a goal.
   `/goal-unfocus` appends a null focus entry so the current session stays
   detached without modifying the shared goal or appending a project-global
   focus event.

Focus is human-owned. No agent tool can switch focus. Lifecycle tools operate
only on the focused goal.

## Goal styles

### Regular goal

Regular goals are open-ended objectives. The agent decides the next concrete
action each checkpoint turn, then completes only after the objective is
actually satisfied.

### Sisyphus goal

Sisyphus is a light variant of the same goal lifecycle. It does not have a
separate execution state machine or step counter. The only differences are
prompt/criteria level:

- the objective is written as numbered ordered steps with per-step done criteria;
- continuations remind the agent not to rush, skip, or invent preflight steps;
- completion still uses `update_goal(status="complete")`, with the stricter
  expectation that the whole ordered objective is actually satisfied.

## Creation and tweaking

`/goal <objective>` and `/sisyphus <objective>` create and focus a goal
directly — the explicit command is the user's confirmation, so no separate
confirmation phase exists. A conversational request may call `create_goal`
directly when the user explicitly asks to start a persistent goal; the model
must not infer a goal from an ordinary one-off task. Creating a goal focuses it
and leaves other open goals untouched.

`/goal-tweak <new objective>` is a direct user-owned objective edit routed
through GoalService: it preserves usage/tasks/mode/budget, reactivates
`budget_limited` goals, clears any agent pause reason, and records a
`goal_tweaked` ledger event. There is no drafting orchestration, no
confirmation intent state, and no model-side objective mutation.

## Command focus behavior

- `/goal <objective>` creates a regular goal; bare `/goal` shows status.
- `/sisyphus <objective>` creates a Sisyphus goal; bare `/sisyphus` asks for an objective.
- `/goal-list` prints all open goals with id, status, mode, usage, objective title, path, and a focus marker.
- `/goal-focus` uses `ctx.ui.select` when multiple goals are open and updates only session focus.
- `/goal-unfocus` writes a null session focus entry, clears continuation/runtime state, aborts in-flight work and audits for that session, and leaves the shared active goal file and project-global focus ledger unchanged. Focus revision tokens prevent pending completion and task-list results from mutating a goal after detachment.
- `/goal-resume` resumes the focused paused goal; when unfocused with multiple open goals, it asks the user to choose. Choosing an already active goal only focuses it.
- `/goal-clear` archives only the focused/selected goal and never clears the whole pool at once.
- `/goal-pause` pauses the focused active goal; it asks the user to choose when unfocused with open goals.
- `/goal-settings` opens extension settings (disabled, provider, model, thinking_level, subtaskDepth, autoSelectSingleGoal).

## Tool surface

The extension registers a five-tool model vocabulary:

| Tool | Purpose |
|---|---|
| `create_goal` | Create and focus a new goal after an explicit user request (objective 1–4000 chars, optional `mode` regular/sisyphus and `token_budget`). |
| `get_goal` | Read-only complete focused goal snapshot. |
| `update_goal` | Terminal outcomes only: `complete` (audited from actual evidence) or `blocked` (after three consecutive identical blockers). |
| `set_goal_tasks` | Create or structurally replace the task tree (flat parent-linked input, confirmation dialog, id-stable merge). |
| `update_goal_task` | Update one task without stopping the turn: complete (evidence for contracted tasks), skipped (reason), pending (reopens skipped). |

The advertised profile is FIXED: exactly five goal tools when tasks are
enabled, exactly three when disabled. `installGoalToolProfile` is called only
at session start and after a settings change that toggles `disableTasks`;
focus, status, budget, completion, audit, and compaction transitions never add,
remove, or restore goal tools, and ordinary pi work tools are never touched.
Invalid lifecycle calls return concise state-aware tool results instead.

The `tool_call` interceptor blocks work tools after a stop tool has fired in
the same turn, and blocks work tools when the checkpoint that triggered the
turn is no longer actionable (stale checkpoint).

## Accounting, runtime, and token budgets

`GoalAccounting` (goal-accounting.ts) charges serialized, idempotent
token/time intervals per turn; a goal never double-charges the same interval.
`GoalRuntime` (goal-runtime.ts) owns continuation scheduling, the stale
checkpoint state, the turn-stop guard, and one-shot steering reminders.

An optional `token_budget` may be set at creation. When accounted usage
reaches the budget, `accountProgress` transitions the goal to the distinct
`budget_limited` status exactly once (status leaves `active`, so accounting
stops and the transition cannot re-fire), emits a `goal_budget_limited` ledger
event, arms the one-time wrap-up steering, and cancels pending continuations.
`budget_limited` never implies completion.

## Completion output

Completion is explicit and checked by an independent auditor agent.
`update_goal(status="complete")` is valid for active and paused goals; paused
goals do not need to be resumed just to record completion when existing
evidence is sufficient. There is no verification-summary parameter — the
auditor derives the requirements from the objective and any verification
contract and inspects the actual workspace.

Before archiving, the tool starts a separate in-memory pi session with a
focused auditor prompt. The auditor receives the objective, executor
completion claim, and goal metadata, can inspect the workspace with `read`,
`grep`, `find`, `ls`, and `bash`, and must end with exactly one marker:

- `<approved/>` allows archiving;
- `<disapproved/>`, no marker, an error, or abort rejects completion and leaves
  the goal open.

The auditor uses the current/default model unless
`.pi/pi-goal-x-settings.json` overrides `provider`, `model`, or `thinkingLevel`.
The user can Escape an in-flight audit to choose "complete without audit" or
"continue working". Archival is deferred to `turn_end` so the agent can see the
auditor result before the goal is archived. The global `disabled` setting is
an explicit user-owned switch: completion skips the auditor, records
`audit_skipped`, and proceeds through the normal deferred-completion path.

## Disk format and old-data reads

Active and archived goal files live under `.pi/goals/`. Each file has
extension-owned metadata and a user-editable `# Goal Prompt` section. Before
focused commands, tools, and lifecycle hooks act, the runtime re-reads the
focused active file and reconciles lifecycle state from disk; prompt-body
edits are picked up from `# Goal Prompt`. Path safety checks reject absolute
paths, traversal, NUL bytes, symlinks, and paths outside the goal directories.

Old readers remain for backward-compatible reads of existing data:
`readActiveGoalPool`, `readGoalLedger`, `mergeGoalPromptFromDisk`,
`latestAuditorResultForGoal`, and `normalizeGoalRecord` are all retained and in
use. The ledger is append-only JSONL and is never rewritten in place.

## Tests

Fast local tests live in `tests/` and run with:

```bash
npm run test:serial
npm run check
```

They cover: surface baselines (exactly the five tools and ten commands
registered), the current dynamic visibility behavior, golden file/ledger
fixtures, stale-continuation behavior,
GoalService mutation boundary, runtime/accounting, token-budget transitions,
task-tool consolidation, verification contracts, the independent auditor,
compaction recovery, and the bounded steering prompts. The separate
`tests/e2e/` directory is not included by the package test glob and still uses
removed signatures. In `experiments/`, C20-C26 target the current interface;
C1-C19 and B1-B2 remain historical until migrated.

## Hardening (0.23)

The 2026-08-04 hardening plan
([`specs/2026-08-04-goal-simplification-hardening`](../specs/2026-08-04-goal-simplification-hardening/TECH.md))
is implemented: paused-status normalization (status authoritative, legacy
`autoContinue: true` records stay paused), disk-fresh task transactions with
structural-field clearing, token-budget integer validation, `task_reopened`
ledger semantics with observable diagnostics, drafting-era module removal, and
the supported integration/experiment coverage described above.
