# Technical plan: Goal runtime follow-up

## 1. Invariants

- Stages 1–4 are implemented in commits `7cd85db` through `93023b3`.
- The current working tree has restored the baseline drafting flow: `/goal`,
  `/sisyphus`, `/goal-direct`, `/sisyphus-direct`, `/goal-tweak`, the
  questionnaire tools, draft confirmation, and atomic initial task-list
  persistence. Stage 5 remains incomplete until the parity work below lands.
- Stages 6–8 remain planned unless a milestone explicitly marks their work
  shipped.

- Preserve create_goal, get_goal, update_goal, set_goal_tasks, and
  update_goal_task as the fixed execution surface.
  `/sisyphus`, `/goal-direct`, `/sisyphus-direct`, `/goal-list`, `/goal-focus`,
  `/goal-unfocus`, `/goal-settings`, `/goal-tweak`, `/goal-clear`,
  `/goal-pause`, and `/goal-resume`.
- The current palette has twelve top-level commands; Stage 5.1 adds
  `/goal-status` and `/goal-cancel`, producing a target fourteen-command
  palette while retaining distinct tab-completable actions.
- `/goal` and `/sisyphus` always draft; only the `-direct` commands bypass
  drafting.
- GoalService remains the only mutation boundary.
- Goal markdown remains authoritative durable state; focus remains
  session-local.
- Lifecycle transitions never rebuild the tool profile. Only session start and
  an effective disableTasks change install the three/five profile.
- Historical readers may parse old records/events, but current writers emit
  only current vocabulary.
- A transient drafting profile is distinct from the fixed execution profile.
  Drafting tools are installed only for an explicit user-started draft and are
  removed before execution begins.

## 2. Stage 1 — settings menu correctness (P1)

Refactor goal-commands.ts around one declarative row table:

    type SettingRow = {
      key: keyof GoalSettings;
      label: string;
      kind: boolean | text | thinking | positiveInteger;
    }

Render and dispatch from this same table so display and selection cannot drift.
Include all eight persisted fields. Replace tasksEnabledAtMenuStart with
lastInstalledTasksEnabled. After each successful save, compare the newly loaded
effective task setting with the last installed value, reinstall if changed,
then update the tracker.

Validate subtaskDepth with a full-string decimal check and
Number.isSafeInteger(n) with n at least 1. Do not use partial parseInt.

Tests:

- select and toggle every boolean row;
- edit and clear provider/model;
- accept every thinking level and reject unknown values;
- accept 1; reject 1.5, 1x, zero, negative, infinity, and unsafe values;
- toggle tasks off, on, and off in one menu while capturing every active
  profile;
- test file values and environment overrides separately.

## 3. Stage 2 — confirmation and audit UX (P1)

### Clear

After optional goal selection, snapshot the selected id and focus revision.
Call the UI confirmation API with a concise goal title/id. Reconcile and
validate the same focus token after confirmation, then archive. Cancellation
must be a complete no-op. Define headless behavior explicitly: either the
explicit slash command confirms the operation, or the handler returns guidance
without mutation.

### Task list

Replace showProposalDialog with a small showTaskListConfirmation component.
Copy only the needed scrolling and rendering behavior. Use task-specific labels
such as Confirm task list and Keep current tasks. Return only:

    { decision: confirm | cancel }

No goal-creation wording, questionnaire state, or auditor toggle is allowed.

### Audit abort

Do not append audit-skipped from the low-level abort callback. Record abort as
transient runtime state, then append one final event after the dialog choice:

- complete without audit: one audit-skipped event with user-aborted reason;
- continue working: no skip event, or a distinct audit-aborted event if
  attempt history is an explicit product requirement.

Make label and status literal. Continue working should leave the goal active.
If pausing is preferred, rename the option to Pause and continue later.

## 4. Stage 3 — completion transaction hardening (P1)

Change commitGoalCompletion to return a discriminated result and inspect
GoalService.apply:

    if (!outcome.ok) {
      return { ok: false, message: outcome.message, terminate: false };
    }
    return { ok: true, report, terminate };

All completion paths consume this result. A stale focus, missing file, write
failure, or invalid lifecycle state must never render a completed report or
request termination.

Add failure injection at write, focus-token validation, and deferred-archive
boundaries. Assert no success message, goal-completed event, or focus clearing
when the state mutation failed.

## 5. Stage 4 — cross-process mutation control (P1/P2)

Preferred design: optimistic revisions plus a short per-goal filesystem lock.

1. Add a persisted monotonic revision to current goal metadata; normalize
   missing historical values to zero.
2. During service reconciliation capture goal id, revision, and focus revision.
3. Acquire an exclusive per-goal lock through atomic creation under
   .pi/goals/.locks. Store pid/start metadata for diagnostics and implement
   bounded stale-lock recovery.
4. Re-read the active file while holding the lock. If revision differs, release
   and return a typed conflict. Never overwrite blindly.
5. Apply to the fresh clone, increment revision, atomically write, append the
   ledger event, update memory, and release in finally.
6. Keep ledger failure best-effort and diagnostic; state-write failure remains
   all-or-nothing.

If a portable lock is not reliable on supported filesystems, use a revisioned
compare-and-swap sidecar with atomic rename and document its assumptions.

set_goal_tasks is authoritative replacement. On conflict, return the current
revision and require a fresh proposal/confirmation; do not silently merge
unknown new structure. update_goal_task may retry once only if the same task
and relevant status/structure remain unchanged.

Tests use two GoalService instances plus barriers to force both writers past
their first read. Exactly one initial write succeeds. Cover objective, task
replacement, task status, archive, and delete races.

## 6. Stage 5 — restore the full drafting runtime (P0 product correction)

The partially implemented deletion of `goal-questionnaire.ts`, its tests, and
drafting state must be reversed. Restore/refactor the last known complete
questionnaire implementation before applying later cleanup.

### Draft state

Maintain session-local transient state separate from GoalRecord:

    type GoalDraft = {
      id: string;
      mode: regular | sisyphus | tweak;
      seed?: string;
      targetGoalId?: string;
      phase: questioning | refining | confirming;
      questionContext: structured answer history;
      proposedObjective?: string;
      proposedTasks?: GoalTaskList;
      proposedVerificationContract?: string;
    };

Persist enough state in branch-local custom session entries to survive
compaction/tree navigation without creating an active goal file. Never store a
half-confirmed draft in the project goal pool or ledger as a real goal.

### Commands

- `/goal [seed]`: start or resume a regular draft and trigger the drafting
  agent turn.
- `/sisyphus [seed]`: start or resume a Sisyphus draft. The final objective must
  contain ordered steps and explicit done criteria for each step.
- `/goal-direct <objective>`: use the existing direct creation transaction with
  regular mode; reject an empty objective.
- `/sisyphus-direct <objective>`: direct creation with Sisyphus validation;
  reject an empty or structurally insufficient objective.
- `/goal-tweak [seed]`: use the same drafting engine against the focused goal;
  confirmation atomically updates the objective/task structure under the
  revision lock.

Starting a new draft while another is active must ask whether to resume,
replace, or cancel it. Starting a draft never archives or mutates open goals.

### Transient drafting tools

Restore a bounded phase-only profile:

- `goal_question`: one structured question with optional choices and context;
- `goal_questionnaire`: a batch of related structured questions;
- `propose_goal_draft`: the complete objective plus optional task tree and
  verification contract for human confirmation.

These tools are not part of the steady three/five execution surface. Install
them only after `/goal`, `/sisyphus`, or `/goal-tweak`; reject calls without a
matching draft token; remove them on confirm/cancel/session cleanup. Ordinary
execution goal tools must not be used to create or mutate a goal while the
draft is unconfirmed.

### Agent drafting prompt

The drafting turn must instruct the agent to:

1. Inspect the seed and existing conversation before asking questions.
2. Ask only questions that materially resolve intent, scope, constraints,
   success criteria, boundaries, sequencing, risks, or verification.
3. Use a batch questionnaire when several independent unknowns exist; use a
   single question for a dependent follow-up.
4. Avoid fabricating defaults for material unknowns.
5. Propose a useful task hierarchy itself when tasks are enabled, including
   verification contracts/evidence expectations for tasks that need them.
6. For Sisyphus, preserve the user's ordered steps and define per-step done
   criteria; never merge or silently reorder them.
7. Call `propose_goal_draft` only when the objective, tasks, and verification
   contract are coherent enough to execute.

### Confirmation transaction

Render one scrollable confirmation view containing:

- mode and full objective;
- success criteria and boundaries;
- verification contract when enabled;
- the complete nested task tree when enabled;
- explicit Confirm, Continue refining, and Cancel choices.

Confirm creates/updates through GoalService under focus/revision validation.
For new goals, objective plus tasks are one atomic state write followed by the
appropriate ledger events and focus entry. Continue refining returns the
agent/user to the same draft with prior answers intact. Cancel clears draft
state/tools and performs no durable goal mutation.

The task-only `set_goal_tasks` confirmation remains a separate neutral dialog
for execution-time restructuring; it must not replace or weaken the richer
goal-draft confirmation.

### Headless and compatibility behavior

In headless mode, structured questions fall back to clearly formatted text and
the draft remains pending until an explicit answer/proposal confirmation. Test
auto-confirm remains opt-in and must never become production default behavior.
Existing goal files and ledger records remain readable. Add migration tests for
sessions containing the prior DraftingFocus/custom entries.

### Tests

- command registration and exact guided/direct routing;
- vague seed requiring questions before proposal;
- batch questionnaire and dependent single follow-up;
- continue-refining preserves answers and proposed tasks;
- confirm atomically creates objective, verification contract, and nested task
  tree, then restores the three/five execution profile;
- cancel and aborted confirmation are durable no-ops;
- Sisyphus ordered-step fidelity and validation;
- `/goal-tweak` guided refinement under focus/revision races;
- tasks/contracts-disabled variants;
- compaction/tree restoration of an unconfirmed draft;
- real-SDK handler integration and at least one manual real-model scenario.

## 7. Stage 5.1 — drafting and lifecycle parity (P0/P1)

Complete the restored drafting workflow and recover compatible lifecycle
capabilities without re-expanding the steady execution tool palette. The
detailed sub-stages below are mandatory before Stage 6.

### A. Durable draft state and cancellation

Replace the module-local WeakMap-only draft marker with a branch-local custom
entry plus a GoalCore memory cache:

    type GoalDraftSession = {
      version: 1;
      mode: "goal" | "sisyphus" | "tweak";
      seed: string;
      targetGoalId?: string;
      startedAt: string;
      auditorEnabled: boolean;
    };

The entry is never a project goal or ledger event. Rehydrate it on
session_start/session_tree, validate a tweak target against the focused goal,
and install drafting tools only for a valid draft. Starting a second draft
must offer Resume, Replace, or Cancel; it must not silently discard the first.

Add `/goal-cancel`. It removes the branch-local draft entry/cache, restores
the normal execution profile, clears draft-only continuation state, and writes
no goal file, focus entry, or ledger event. Do not reintroduce `/goal-abort`.

### B. Focused status and auditor choice

Add `/goal-status` as a tab-completable read-only command. Reuse
showGoalStatus rather than duplicating pool/focus logic. It reports the
focused goal and other-open-goal count; `/goal-list` remains the pool view.

At draft start calculate defaultAuditorEnabled from effective settings and
pass it to showProposalDialog. Preserve it through Continue Chatting. Add
`skipAuditor?: boolean` to GoalCreationConfig and set it before the one
GoalService creation transaction. For tweaks, mutate skipAuditor in the same
GoalService.apply transaction as objective/task changes. Headless confirmation
uses effective settings unless the explicit test override is enabled. The
confirmation summary displays the selected auditor behavior.

### C. Capability parity without tool sprawl

Keep the compact execution surface. Implement compatibility through existing
contracts or user commands rather than reviving every old tool verbatim:

1. Add `paused` to update_goal with required `reason` and optional
   `suggested_action`. It performs the old immediate agent-pause transition,
   stops continuation, and records goal_paused with source `agent`. `blocked`
   remains the three-consecutive-turn outcome.
2. Do not let an agent archive/abandon a goal autonomously. When the old
   abort_goal conditions occur, return a structured request directing the
   user to `/goal-clear`; this preserves explicit authority.
3. Keep objective mutation user-started. Normal execution must direct
   requirement changes to `/goal-tweak`; do not restore propose_goal_tweak as
   a steady-state model tool.
4. Add optional `completion_summary` to update_goal({status:"complete"}).
   Pass it as an untrusted executor claim to the auditor prompt, never as
   completion evidence or an approval bypass.

### D. Required proof

- Draft survives compaction/tree navigation, and cancel is a durable no-op.
- A second draft cannot silently replace another draft.
- `/goal-status` reports state without initiating drafting.
- Auditor selection persists on create and tweak, including Continue Chatting
  and headless paths.
- Agent pause is immediate while blocked remains three-turn gated.
- Executor completion summary reaches the auditor but cannot make an
  otherwise disapproved goal complete.
- Profile/host-tool tests cover cancel, rehydration, and direct interruption.

## 8. Stage 6 — experiment harness hardening (P1/P2)

- Parse SUPPORTED_CASES.json and require exact case-id membership before
  directory resolution. Raw directories require an explicit
  allow-unsupported diagnostic flag.
- Use the selected MODEL in the provider smoke request.
- Validate HTTP status and JSON shape; cap reported response text.
- Discover timeout, gtimeout, then a small Node watchdog; otherwise fail with a
  clear prerequisite message.
- Add shell tests for supported/unsupported resolution, custom-model payload,
  missing configuration, and timeout selection. Stub curl and pi.
- Add an observations index that marks old runs as historical evidence rather
  than current instructions.

## 9. Stage 7 — test runner and coverage

The assessment has introduced scripts/run-unit-tests.mjs plus explicit SDK
adapter hooks:

- discover root unit or integration test files automatically;
- resolve only the runtime-valued Pi AI, coding-agent, and TUI imports to small
  contract-faithful test adapters;
- execute entries in one Node process with test isolation disabled;
- make test:all run unit and integration entries in the same startup;
- retain test:serial as the real-SDK, process-isolated compatibility path.

Before landing, add a runner self-check or CI assertion comparing discovered
entries with expected totals. Record timings without promising
machine-independent performance. Run the real-SDK suite in release CI to
detect adapter drift.

Expand handler integration for Stages 1 through 3 and capture setActiveTools
calls rather than checking registered names alone.

Upgrade the Pi SDK development dependencies together to a mutually compatible
current release, then rerun typecheck, fast/real-SDK suites, auditor session
creation, and package installation against the peer ranges. Do not use a forced
audit fix that can split the SDK family across incompatible majors. The target
is zero full-development audit findings as well as the already-clean
published/runtime audit.

## 10. Stage 8 — documentation and release

Verify README commands, settings, tests, experiment migration, module map, and
known limitations; architecture mutation semantics and concurrency limits;
agent-flow command/module maps; experiment README, PLAN, and matrix; changelog;
and spec registry.

Do not rewrite old changelog entries merely because their names were valid in
old releases. Correct only claims about 0.23 and current behavior.

## 11. Validation matrix

| Area | Required proof |
|---|---|
| Settings | Every row round-trips; repeated task toggles capture correct profiles; exact integer validation |
| Clear | Cancel is byte-for-byte and no-ledger no-op; confirm archives one selected goal; focus race rejected |
| Tasks | Task-specific labels; cancel no-op; confirm transaction; no auditor state |
| Completion | Approved, disabled, legacy, and Escape paths; injected failures never report success |
| Audit ledger | Exactly one final event per abort choice |
| Concurrency | Deterministic two-writer conflict across every mutation family |
| Drafting | `/goal` and `/sisyphus` question/refine/propose/confirm; agent-selected nested tasks; transient tools disappear after exit |
| Direct creation | `/goal-direct` and `/sisyphus-direct` create immediately and never start questionnaires |
| Compatibility | Old goal/ledger/draft session fixtures parse and resume safely |
| Tests | Fast test:all, real-SDK serial, discovery count, no missed files |
| Dependencies | Full development and published/runtime audits; Pi SDK compatibility smoke |
| Package | Typecheck, diff check, package dry-run, no cache/test artifacts shipped |

## 12. Commit sequence

Historical shipped sequence:

1. Settings table, exact validation, and profile tests.
2. Clear, task, and audit confirmation semantics.
3. Completion-result propagation.
4. Revision/lock boundary and deterministic race tests.
5. Baseline guided drafting restoration, direct commands, transient profile,
   and questionnaire/task-co-design tests.

Remaining sequence:

1. Persistent draft session entry, resume/replace/cancel UI, and
   `/goal-cancel` tests.
2. `/goal-status`, per-draft auditor state/confirmation, and create/tweak
   transaction tests.
3. `update_goal` pause and completion-summary contract extensions, auditor
   trust-boundary tests, and abandonment guidance.
4. Experiment enforcement and portability.
5. Pi SDK dependency upgrade and compatibility validation.
6. Test-runner self-check, integration expansion, and living-doc closure.

Each commit keeps typecheck and the affected fast suites green.
