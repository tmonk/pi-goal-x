# Technical Spec: Codex-inspired goal interface simplification

> **Implementation assessment (2026-08-04):** this plan is the accepted design
> record, not a guarantee that every stage landed correctly. The full code and
> documentation audit, deviations, and remediation sequence are in the
> [goal simplification hardening plan](../2026-08-04-goal-simplification-hardening/TECH.md).

Product spec: `specs/2026-08-03-codex-inspired-goal-interface/PRODUCT.md`

## Executive technical direction

Replace the phase-oriented model interface with five stable tools, route all
mutations through a single internal `GoalService`, retain a curated set of
dedicated tab-completable slash commands, and split the 3,755-line
`extensions/goal.ts` orchestrator into bounded modules. Preserve the existing
persistence, goal pool, focus, task, contract, audit, continuation, compaction,
settings, and UI implementations behind the smaller surface.

The central design rule is borrowed directly from Codex's current source:
tools express durable model intents; a service owns validated state mutation;
runtime hooks own accounting and continuation; steering prompts own behavioral
policy; UI and external commands mutate through the same service.

## Source analysis

### Codex reference implementation

The reference source is `/Volumes/tom/projects/codex` at the revision available
on 2026-08-03. Relevant implementation points are:

| Concern | Codex source | Relevant behavior |
|---|---|---|
| Tool schemas | `codex-rs/ext/goal/src/spec.rs` | Exactly `get_goal`, `create_goal`, and `update_goal`; strict small schemas; `update_goal` accepts only `complete` or `blocked`. |
| Tool execution | `codex-rs/ext/goal/src/tool.rs` | Validates objective/budget, refuses a second unfinished thread goal, accounts usage before terminal updates, and returns remaining/final budget data. |
| Mutation service | `codex-rs/ext/goal/src/api.rs` | Separates persisted mutations from runtime effects and serializes external mutation against idle continuation. |
| Extension wiring | `codex-rs/ext/goal/src/extension.rs` | Installs a stable three-tool vector and delegates thread, turn, usage, and tool lifecycle events to the runtime/accounting layer. |
| Runtime | `codex-rs/ext/goal/src/runtime.rs` | Restores active goals, serializes goal mutations, starts idle continuations, handles external edits, and maps terminal errors or usage limits to stop states. |
| Accounting | `codex-rs/ext/goal/src/accounting.rs` | Tracks per-turn baselines and wall time, serializes progress accounting, excludes Plan mode, and avoids duplicate concurrent charges. |
| Steering | `codex-rs/ext/goal/src/steering.rs` and templates | Injects bounded internal context for continuation, objective edits, and budget exhaustion. The blocker threshold is prompt policy, not another persisted counter. |
| User command | `codex-rs/tui/src/chatwidget/slash_dispatch.rs` | One `/goal` namespace: bare summary, objective set, `edit`, `pause`, `resume`, and `clear`. |
| Goal UI | `codex-rs/tui/src/chatwidget/goal_menu.rs` and `tui/src/app/thread_goal_actions.rs` | User-controlled editing/status, replacement confirmation, resume prompt, usage display, and runtime-safe external mutation. |

Important source-level conclusions:

1. Codex does not dynamically vary the three model tools by goal phase. It
   installs the stable set when goals are enabled for a persisted thread.
2. `update_goal` has a one-field schema. The detailed completion and blocker
   policy lives in the tool description and continuation steering prompt.
3. The three-consecutive-turn blocker rule is not enforced by another runtime
   state machine. Persisted `blocked` is a distinct status after the model makes
   the terminal claim.
4. User-driven edit, pause, resume, and clear bypass model tools and use the
   goal service directly.
5. Objective edits preserve usage and usually preserve status; edits of a
   complete or budget-limited goal reactivate it.
6. Token budget exhaustion is a system transition with a one-time wrap-up
   prompt, not a model completion shortcut.
7. Goal context is injected as bounded internal context with explicit
   untrusted-data framing.

### Current pi-goal-x implementation

Current surface and complexity:

- `extensions/goal.ts`: 3,755 lines of command routing, tool handlers, pool and
  focus orchestration, confirmation/tweak state, continuation, accounting,
  audit UI, event hooks, and rendering glue.
- twelve registered goal tools: ten in `goal.ts` and two in
  `goal-questionnaire.ts`;
- fifteen registered slash commands or aliases;
- `syncGoalTools()` reconstructs the active tool set from confirmation,
  tweaking, focused status, settings, and work-tool assumptions;
- the active-goal prompt names most lifecycle tools and repeats task/audit
  mechanics;
- task structure is exposed recursively through `Type.Any` and three different
  tools;
- completion requires model-supplied paperwork and then a separate semantic
  audit;
- persistent state is split between active goal markdown files, session focus
  entries, and a best-effort JSONL ledger.

The implementation is functionally mature and well covered. The problem is
surface-to-internals coupling, not a lack of lifecycle gates.

## Deliberate deviations from Codex

The target is Codex-inspired, not a source port.

| Codex | pi-goal-x target | Reason |
|---|---|---|
| One goal per thread | Multiple project goals, one focused per session | Existing high-value multi-session workflow. |
| Three tools | Three core tools plus two task tools | Preserve structured task trees and task evidence. |
| No separate completion agent | Independent semantic auditor | Existing completion-quality differentiator. |
| `update_plan` is separate transient progress | Persistent goal task tree | Existing cross-compaction and user-visible progress feature. |
| State database | Safe markdown files plus ledger and session focus | Existing Pi extension storage contract and inspectability. |
| `clear` deletes thread goal state | `clear` archives goal state | Preserve project history. |
| No Sisyphus mode | Optional goal mode metadata and discipline | Existing ordered-execution feature. |

## Target architecture

### Module boundaries

Refactor toward the following ownership. Exact filenames can be adjusted during
implementation, but responsibilities must not move back into `goal.ts`.

| Module | Responsibility | Target size |
|---|---|---:|
| `extensions/goal.ts` | Extension installation only: instantiate service/runtime, register command/tools/events, wire UI dependencies. | <500 lines |
| `extensions/goal-service.ts` | All validated mutations: create, get, user edit/status/clear, model terminal update, task set/update, archive, focus-safe compare-and-apply. | <600 lines |
| `extensions/goal-runtime.ts` | Per-session focus/runtime state, continuation scheduling, stale checkpoint handling, turn-stop state, compaction restore, disk reconciliation. | <600 lines |
| `extensions/goal-accounting.ts` | Per-turn token/time baselines, idempotent accounting, optional budget transition, completion budget report. | <350 lines |
| `extensions/tools/goal-tools.ts` | Specifications and thin executors for `create_goal`, `get_goal`, `update_goal`. | <400 lines |
| `extensions/tools/goal-task-tools.ts` | Specifications and thin executors for `set_goal_tasks`, `update_goal_task`. | <400 lines |
| `extensions/commands/goal-commands.ts` | Registration and handlers for the curated command palette, selectors, confirmations, and compatibility guidance. | <500 lines |
| `extensions/prompts/goal-prompts.ts` | Bounded continuation, objective-updated, budget-limit, stale, and unfocused steering text. | <350 lines |
| existing record/pool/files/ledger/auditor/widgets modules | Continue their current focused ownership; accept service inputs rather than calling orchestration state directly. | existing |

`GoalService` must be the only module allowed to perform a logical goal
mutation. Command and tool handlers call it and then apply returned runtime/UI
effects. Storage helpers remain lower-level serialization primitives.

### Service contract

Use explicit discriminated request types instead of boolean/optional argument
combinations:

```ts
type GoalStatus =
  | "active"
  | "paused"
  | "blocked"
  | "budget_limited"
  | "complete";

type GoalMutationSource = "user" | "agent" | "system";

interface GoalMutationToken {
  goalId: string;
  focusRevision: number;
}

interface GoalMutationOutcome {
  goal: GoalRecord | null;
  previousGoal: GoalRecord | null;
  focusChanged: boolean;
  archivedPath?: string;
  continuation: "start_if_idle" | "stop" | "unchanged";
  steering?: "objective_updated" | "budget_limit";
}
```

Required service methods:

```ts
getFocusedGoal(ctx): GoalRecord | null
createGoal(ctx, request, source): GoalMutationOutcome
editFocusedGoal(ctx, objective, source): GoalMutationOutcome
setFocusedGoalStatus(ctx, status, source): GoalMutationOutcome
clearFocusedGoal(ctx, source): GoalMutationOutcome
requestTerminalUpdate(ctx, status, source, signal): Promise<GoalMutationOutcome>
setTaskTree(ctx, request, token): Promise<GoalMutationOutcome>
updateTask(ctx, request, token): GoalMutationOutcome
reconcileFocusedGoal(ctx): GoalRecord | null
```

Asynchronous audit and task confirmation calls capture a
`GoalMutationToken`. The service verifies it immediately before mutation so an
unfocus/focus change discards late results. This preserves the existing
`focusRevision` safety property.

### Stable tool installation

Remove `syncGoalTools()` and phase-specific goal allowlists. Register goal tools
once when the extension starts:

- tasks enabled: five tools;
- tasks disabled at session start: three core tools.

Do not mutate Pi's normal `read`, `bash`, `edit`, or `write` active-tool set.
Every goal tool validates current state in its executor. The tool result should
explain an invalid transition without relying on prior tool hiding.

Hidden compatibility shims, if Pi supports registered-but-not-advertised
tools, are kept outside the active set and removed after one release. If Pi
cannot guarantee that they are absent from the model request, do not register
them.

## Tool specifications

All schemas use `additionalProperties: false`.

### `create_goal`

```json
{
  "objective": "string, required, 1-4000 chars after trim",
  "token_budget": "positive integer, optional",
  "mode": "regular | sisyphus, optional; regular by default"
}
```

Policy:

- only for an explicit user or system/developer request;
- never infer persistence from an ordinary implementation task;
- `token_budget` is legal only when explicitly requested;
- creating adds a new open goal and focuses it; it does not archive other
  project goals;
- if a goal is already focused, the result explicitly reports the focus change;
- usage begins at zero and the accounting baseline resets after creation so
  pre-goal tokens from the current turn are not charged.

The optional `mode` is the smallest necessary deviation from Codex to preserve
Sisyphus. `/sisyphus …` sets it without asking the model to infer the mode.

### `get_goal`

Input is `{}`. Output is structured and text-rendered from one snapshot:

```ts
interface GoalToolResponse {
  goal: GoalRecord | null;
  remainingTokens: number | null;
  otherOpenGoalCount: number;
  completionBudgetReport: string | null;
}
```

Remove the repeated-call nudge map. The continuation prompt already carries
the current goal; `get_goal` remains available for explicit inspection and
post-compaction recovery.

### `update_goal`

```json
{ "status": "complete | blocked" }
```

No objective, reason, summary, verification summary, auditor bypass, pause,
resume, or clear fields are accepted.

For `complete`:

1. account progress through the tool call;
2. snapshot focused id/revision;
3. run the existing auditor against objective, contract, task state, current
   workspace, and ledger context;
4. if rejected/error/abort, keep the goal active and persist audit feedback;
5. if approved, set complete, write the final active record, archive, clear
   session focus, emit ledger/UI events, and return the final budget report;
6. retain the current explicit user bypass behavior only in UI when audit is
   disabled or the user aborts it; it is not a tool parameter.

For `blocked`:

1. accept only from active status;
2. account progress;
3. set distinct `blocked` status and `stopReason: "agent"`;
4. stop continuation and clear per-turn active accounting;
5. rely on tool/prompt policy and evaluations for the three-turn threshold,
   matching Codex instead of adding a second blocker counter.

Non-retryable runtime errors may also set `blocked` with system attribution.
User Escape or `/goal-pause` sets `paused`, not `blocked`.

### `set_goal_tasks`

Use a flat parent-linked input instead of recursive `Type.Any`:

```json
{
  "tasks": [
    {
      "id": "stable-slug",
      "title": "human-readable title",
      "parent_id": "optional parent id",
      "verification_contract": "optional evidence requirement",
      "lightweight_subtasks": false
    }
  ],
  "block_completion": false,
  "change_summary": "optional"
}
```

Runtime validation enforces non-empty unique ids/titles, existing parent ids,
acyclic parent relationships, maximum 50 total tasks, configured depth, and
valid lightweight-subtask placement. Convert the flat input to the existing
recursive `GoalTask[]` representation. Matching ids preserve status, evidence,
and timestamps. Show the existing confirmation UI before structural mutation.

### `update_goal_task`

Use a discriminated union:

```ts
type UpdateGoalTaskRequest =
  | { task_id: string; status: "complete"; evidence?: string }
  | { task_id: string; status: "skipped"; reason: string }
  | { task_id: string; status: "pending" };
```

Rules:

- complete requires contract evidence when configured and completed/skipped
  non-lightweight descendants;
- skipped requires an explicit reason and remains prompt-restricted to user
  direction or a hard contradiction;
- pending only reopens skipped tasks;
- completed tasks cannot be reopened by the model;
- updates append existing task ledger events, persist, refresh UI, count as
  meaningful progress, and do not terminate the turn.

## Command design

Register exactly the curated ten-command palette:

```text
/goal
/goal <objective>
/sisyphus <objective>
/goal-tweak [replacement]
/goal-pause
/goal-resume
/goal-clear
/goal-list
/goal-focus [id]
/goal-unfocus
/goal-settings
```

Registration and parsing requirements:

- each frequent lifecycle action is independently registered so it appears in
  slash-command tab completion;
- `/goal` with no arguments shows status and with non-empty arguments creates a
  regular goal; it has no hidden subcommand grammar;
- `/sisyphus` with non-empty arguments creates a Sisyphus goal;
- preserve original objective casing, multiline text, paste placeholders,
  images, and mention bindings where Pi supports them;
- objective length after materialization is 1–4,000 characters; longer content
  is stored in a referenced goal file if the existing Pi host supports that
  safely, otherwise rejected with a file-reference suggestion;
- `/goal-tweak` uses a UI editor when replacement text is omitted;
- user edits preserve usage, tasks, mode, budget, and active/paused/blocked
  status; editing complete or budget-limited goals reactivates them;
- `/goal-clear` archives after confirmation and never represents completion;
- `/goal-resume` converts paused/blocked/budget-limited to active, resets the
  blocker audit conceptually, and queues continuation only after persistence;
- `/goal-focus` and `/goal-unfocus` change session state only;
- command descriptions use concise action-first wording so tab completion is
  self-explanatory;
- do not retain aliases that duplicate these commands in the completion list.

Legacy mapping:

| Legacy command | New command |
|---|---|
| `/goal-status` | `/goal` |
| `/goals-set <x>` | `/goal <x>` |
| `/sisyphus-set <x>` | `/sisyphus <x>` |
| `/goal-abort` | `/goal-clear` |
| `/goals <topic>` | normal discussion followed by `/goal <objective>` or explicit `create_goal` request |
| `/goal-tweak`, `/goal-pause`, `/goal-resume`, `/goal-clear`, `/goal-list`, `/goal-focus`, `/goal-unfocus`, `/goal-settings` | retained unchanged |
| `/sisyphus <topic>` | retained as the single Sisyphus creation command |

## State and persistence changes

### Record changes

Extend `GoalRecord` additively:

```ts
type GoalStatus = "active" | "paused" | "blocked" | "budget_limited" | "complete";

interface GoalRecord {
  // existing fields retained
  tokenBudget?: number;
  blockedReason?: string;       // only when supplied by system context; optional
  budgetLimitedAt?: string;
}
```

Keep `autoContinue` for file compatibility, but derive its effective value from
status: only `active` continues. New records set it true. Normalization must not
silently turn `paused` back into active merely because an old record has
`autoContinue: true`; status is authoritative.

This fixes a current normalization hazard in
`extensions/goal-record.ts`, where `paused + autoContinue` becomes active.

### Token accounting and budget

Retain the current Pi-available usage channels (`input + output`) unless Pi
exposes cached-input detail. Introduce per-turn baselines so goal creation in a
mid-turn does not charge earlier tokens. Accounting invariants:

- charge only while the focused goal id and captured revision still match;
- account elapsed wall time monotonically;
- perform a single compare-and-apply write for each snapshot;
- serialize concurrent tool-finish accounting with a promise queue or mutex;
- exclude goal terminal tools from generic post-tool double accounting;
- when `tokensUsed >= tokenBudget`, atomically mark `budget_limited`, stop new
  work, and inject the wrap-up prompt once per goal id;
- budget exhaustion never calls completion or bypasses audit;
- resuming a budget-limited goal requires the user to raise/remove the budget
  or explicitly resume under a defined policy.

### Ledger compatibility

Continue reading every existing event type. Add only:

- `goal_blocked` with `source: "agent" | "system"`;
- `goal_budget_limited` with budget/usage snapshot;
- `goal_budget_updated` when a user changes or removes a budget.

Do not rewrite old JSONL. Reconstruction treats legacy agent pauses with a
pause reason as paused, not blocked. Existing audit and task events retain
their schemas.

### Storage and archival

Keep `.pi/goals/active_goal_*.md` and archived paths. `GoalService` performs:

1. safe focused record reconciliation from disk;
2. expected goal id + focus revision check;
3. mutation on a clone;
4. active-file write;
5. ledger append best effort;
6. archival only for complete/clear;
7. in-memory pool/focus commit;
8. runtime/UI effects.

If the active-file write fails, do not commit memory, ledger, focus, or archive.
If ledger append fails after the authoritative file write, report diagnostics
but keep the successful state transition, matching current best-effort ledger
semantics.

## Runtime and steering

### Continuation scheduler

Keep one continuation chain for the focused active goal. Replace the broad
tool-name progress allowlist with outcome-based rules:

- any successfully executed non-goal work tool counts as progress;
- `update_goal_task` counts as progress;
- `get_goal`, `create_goal`, `set_goal_tasks`, question-like conversation, and
  rejected tool calls do not by themselves justify another turn;
- only `active` goals can queue;
- queued prompts carry goal id and focus revision and are neutralized if stale;
- a successful `update_goal`, user lifecycle mutation, focus change, abort, or
  terminal error cancels pending continuation.

### Continuation prompt

Replace the current tool-heavy prompt with a bounded template modeled on
Codex's continuation prompt. Include:

1. escaped, explicitly untrusted objective;
2. mode and status;
3. token/time usage, optional budget, and remaining tokens;
4. concise task summary and next pending task, capped by count/characters;
5. verification contract, capped;
6. instruction to preserve full scope and work from authoritative current
   state;
7. recommendation to use a plan only when multi-step;
8. requirement-by-requirement completion audit standard;
9. three-consecutive-turn blocker policy;
10. instruction to call only `update_goal` for true complete/blocked outcomes.

Do not enumerate removed tools or internal state. Hard-cap the complete injected
fragment below 10,000 characters and add tests for escaping and truncation.

Add separate bounded templates for:

- objective edited by user;
- budget reached;
- audit rejection continuation;
- stale checkpoint neutralization;
- unfocused open-goal guidance.

### Stop semantics

Keep the current same-turn post-stop guard, simplified to a runtime boolean tied
to goal id/revision. After successful `update_goal`, user pause/clear/unfocus,
or confirmed task-tree structural replacement, reject subsequent mutating goal
tools in the same turn. Ordinary already-running parallel tool calls must be
handled according to Pi's actual execution semantics and protected by the
mutation token rather than assumed sequential.

Escape during ordinary goal work pauses. Escape during audit retains the
existing explicit user choice. An abort/error accounts progress before changing
status.

## Auditor integration

The auditor remains independent and is invoked only inside
`requestTerminalUpdate(complete)`.

Revise its input to remove executor paperwork dependency. It receives:

- full objective and mode;
- verification contract;
- task tree and task evidence;
- current goal usage/budget;
- latest rejected audit, if any;
- workspace path and read-only-oriented tools.

The verdict marker contract remains `<approved/>` / `<disapproved/>` for the
first migration. A later internal cleanup may replace markers with structured
output, but that is not required for interface simplification.

Auditor disabled/bypass remains a user setting and UI decision. Remove
`confirmBypassAuditor` from model schema. Audit cancellation and late-result
focus checks remain mandatory.

## Settings

Retain current settings and add optional `tokenBudgetDefault` only if the user
explicitly requests a project default in a later change. Do not silently apply
a default budget in this migration because Codex only sets budgets explicitly.

At session start, load `disableTasks` once to decide whether three or five tools
are installed. Runtime settings that affect validation (`disableContracts`,
subtask depth, auditor config) remain read at mutation/audit time.

## Implementation stages

Each stage should be a reviewable change, ideally under 500 non-mechanical
lines. Do not combine the entire migration into one patch.

### Stage 0 — Characterization and interface contract

- Add source-level tests that enumerate all currently registered tools and
  commands.
- Add golden tests for existing goal files, focus restoration, task trees,
  contracts, audit approval/rejection, stale continuations, and compaction.
- Add experiment baselines for premature completion, first-turn blocker,
  repeated blocker, task completion, goal edit, and multi-goal focus.
- Record serial-test invocation because the current parallel Node test run can
  hit `EMFILE` while loading TypeBox modules.

Exit: no behavior change; baseline artifacts make every later removal explicit.

### Stage 1 — Extract `GoalService`

- Move mutation code out of `goal.ts` without changing public commands/tools.
- Centralize reconciliation, expected id/revision validation, write/ledger/
  archive ordering, and returned runtime effects.
- Route existing handlers through the service.
- Keep all current tests green.

Exit: one mutation path; `goal.ts` no longer writes goal files directly.

### Stage 2 — Extract runtime and accounting

- Move continuation scheduling, stale checkpoint state, turn-stop guard,
  accounting, and compaction recovery into runtime/accounting modules.
- Add serialized idempotent accounting and optional token-budget fields/status.
- Add budget-limit steering and ledger event.
- Preserve current auto-continue behavior before changing tool names.

Exit: runtime is independently testable; budgeted goal tests pass.

### Stage 3 — Introduce the three core tools

- Implement new `create_goal`, `get_goal`, and `update_goal` specs/executors.
- Make `create_goal` real, objective-explicit, and baseline-safe.
- Move completion audit behind `update_goal(complete)` and remove evidence/
  bypass fields from the model schema.
- Add distinct blocked state behind `update_goal(blocked)`.
- Install the stable core set without phase-dependent synchronization.
- Keep old active tool names only as non-advertised compatibility shims if the
  host guarantees invisibility.

Exit: core goal lifecycle works with exactly three advertised tools when tasks
are disabled.

### Stage 4 — Consolidate task tools

- Add flat `set_goal_tasks` schema and tree conversion/validation.
- Add discriminated `update_goal_task` schema.
- Route current task behavior and ledger events through the service.
- Remove `propose_task_list`, `complete_task`, and `skip_task` from the active
  model surface.

Exit: full task/subtask/contract behavior works with two advertised tools.

### Stage 5 — Curate the command palette

- Register the ten product-specified commands with concise completion text.
- Change `/goal <objective>` and `/sisyphus <objective>` into the two direct
  creation paths.
- Preserve dedicated tweak, pause/resume, clear, list/focus/unfocus, and
  settings commands unchanged where their behavior already matches the spec.
- Remove drafting/tweak/questionnaire state and tools.
- Remove `/goal-status`, `/goals`, `/goals-set`, `/sisyphus-set`, and
  `/goal-abort`; add migration documentation.

Exit: slash completion exposes exactly the ten curated commands and no aliases.

### Stage 6 — Simplify steering and cleanup

- Replace active/continuation/edit/budget prompts with bounded templates.
- Remove `syncGoalTools`, legacy step tool, drafting/tweak orchestration,
  question-tool registration, obsolete allowlists, dead validators, and tests
  of removed behavior.
- Split remaining `goal.ts` responsibilities into the target modules.
- Update README, architecture, agent-flow design, changelog, package version,
  and experiment rubrics.

Exit: no obsolete tool or command appears in model context, help, docs, or
active tests; `goal.ts` is a thin installer.

### Stage 7 — Compatibility removal

- After one minor release and telemetry/issue review, delete hidden tool shims
  and legacy command routing that could not be removed earlier.
- Retain old file/ledger readers indefinitely unless a separately specified
  data migration replaces them.

## Test strategy

### Unit tests

- tool schemas deep-equal the five expected specs;
- installed tool names are exactly three or five;
- command parser table covers every subcommand and objective ambiguity;
- record normalization covers all statuses and old v3 records;
- paused status remains paused even with legacy `autoContinue: true`;
- flat task input converts to the same recursive tree and rejects missing
  parents, cycles, duplicates, and excess depth;
- task update union enforces evidence/reason/status rules;
- accounting baselines exclude pre-goal tokens and never double-charge;
- token budget transitions exactly once;
- prompts escape objective data and respect hard size caps;
- service mutations preserve write-before-ledger-before-memory semantics;
- late audit/task confirmation results fail the focus-revision check.

### Integration tests

- explicit conversational `create_goal` and direct `/goal` creation;
- attempt to infer a goal from an ordinary task does not call `create_goal`;
- multiple open goals survive creating/focusing another goal;
- user edit preserves usage/tasks/mode and injects updated-objective steering;
- pause/resume/blocked/budget-limited/complete transitions;
- first blocker and second blocker continue; third repeated blocker calls
  `update_goal(blocked)` in model evaluation;
- completion audit approval archives, rejection stays active, disabled audit
  uses user bypass UI only;
- task-tree structural confirmation and non-stopping task updates;
- stale continuation after focus/unfocus/clear cannot mutate shared state;
- compaction and session branch focus restoration;
- external file edit/archive/delete reconciliation;
- Escape during work and Escape during audit;
- normal Pi tools remain available and are never rewritten by goal tool setup.

### Real-model experiments

Update the existing C1–C19 harness cases and add:

- `C20-core-tool-selection`: only five goal tools, correct intent selection;
- `C21-user-lifecycle-ownership`: model does not edit/clear/pause via invented
  tool fields;
- `C22-blocked-three-turns`: no premature block; terminal update on third
  identical impasse;
- `C23-audit-without-paperwork`: completion works from actual evidence without
  a verification-summary parameter;
- `C24-multi-goal-focus`: creating/focusing one goal does not mutate others;
- `C25-task-tool-consolidation`: structural vs status tool selected correctly;
- `C26-budget-limit`: wraps up without claiming completion or starting more
  substantive work.

Each rubric should mechanically reject removed tool names.

### Validation commands

```bash
npm run check
node --experimental-strip-types --test --test-concurrency=1 tests/*.test.ts
npm pack --dry-run
git diff --check
```

Run the normal `npm test` as an additional check after addressing its parallel
file-descriptor behavior; do not treat the observed `EMFILE` loader failures as
product test failures when the same suite passes serially.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Stable tools allow invalid phase calls | Small schemas plus authoritative service validators and actionable tool results. |
| Removing verification summary weakens completion | Auditor derives requirements and inspects actual state; contract/task evidence remains available; add audit-without-paperwork evals. |
| Prompt-only blocker threshold is inconsistent across models | Mirror Codex wording exactly in tool + continuation prompt and gate release on repeated-blocker evaluations. |
| Multiple goals diverge from Codex single-thread semantics | Keep one session focus, include focused id/revision on every async mutation, and report other-open count. |
| New statuses break old parsing | Additive normalization with exhaustive tests; never rewrite files solely to migrate. |
| Task consolidation produces a large schema | Flat parent-linked representation, 50-task cap, and runtime conversion. |
| Command removal surprises users | One release mapping in README/changelog and clear unknown-command guidance where host APIs permit. |
| Large refactor causes regressions | Service/runtime extraction lands behavior-preserving before interface removal; each stage independently shippable. |
| Auditor async result lands after focus change | Existing focus revision token moves into the service and remains mandatory. |
| Budget accounting charges the creation turn incorrectly | Reset token/time baseline at `create_goal`, matching Codex's source behavior. |

## Rollback strategy

Each stage is independently revertible until command/tool removal:

- state additions are optional and old readers ignore them;
- service/runtime extractions preserve old handlers initially;
- new tools can ship behind a single extension setting during one release if
  needed for model A/B evaluation;
- do not dual-write a new storage format;
- retain old data readers and archived files throughout;
- if model evaluations regress, restore the old advertised tool set while
  keeping the service/runtime decomposition, then iterate on schemas/prompts.

## Completion checklist

- [ ] Five-tool target reviewed and approved.
- [ ] Codex source revision/path recorded in the implementation milestone.
- [ ] Stage 0 characterization committed.
- [ ] GoalService is the sole mutation boundary.
- [ ] Runtime/accounting extracted and budget behavior verified.
- [ ] Three core tools installed statically.
- [ ] Two task tools preserve current task behavior.
- [ ] Ten-command curated palette replaces redundant command sprawl while
      retaining tab-completable lifecycle actions.
- [ ] Draft/question/tweak/legacy tools are absent from model context.
- [ ] Existing files/ledger/session focus remain compatible.
- [ ] Auditor, Sisyphus, pool, focus, widget, compaction, and settings pass
      regression tests.
- [ ] Serial unit suite, type check, package dry run, and experiment suite pass.
- [ ] README, architecture docs, changelog, and milestones match shipped
      behavior.
