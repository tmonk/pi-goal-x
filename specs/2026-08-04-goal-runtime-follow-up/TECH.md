# Technical plan: Goal runtime follow-up

## 1. Invariants

- Preserve create_goal, get_goal, update_goal, set_goal_tasks, and
  update_goal_task.
- Preserve the ten top-level slash commands for tab completion.
- GoalService remains the only mutation boundary.
- Goal markdown remains authoritative durable state; focus remains
  session-local.
- Lifecycle transitions never rebuild the tool profile. Only session start and
  an effective disableTasks change install the three/five profile.
- Historical readers may parse old records/events, but current writers emit
  only current vocabulary.

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

## 6. Stage 5 — remove residual drafting surface (P2)

After task confirmation is extracted:

- delete goal-questionnaire.ts and its tests when no caller remains;
- remove the hidden debug proposal path or move a useful diagnostic into a
  clearly development-only module;
- remove current drafting and DraftingFocus writer vocabulary from record,
  formatting, and command modules;
- retain a narrow legacy parser only if a fixture proves persisted use;
- rename direct-set helpers away from draft/focus terminology;
- remove stale drafting comments in completion;
- deduplicate docblocks and normalize indentation in split tool/service files;
- remove completionSummary and verificationSummary auditor/report inputs if no
  active caller exists. Otherwise identify the consumer and contract-test it.

Add a source-boundary test asserting removed names are absent from current
runtime modules while legacy fixtures remain readable.

## 7. Stage 6 — experiment harness hardening (P1/P2)

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

## 8. Stage 7 — test runner and coverage

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

## 9. Stage 8 — documentation and release

Verify README commands, settings, tests, experiment migration, module map, and
known limitations; architecture mutation semantics and concurrency limits;
agent-flow command/module maps; experiment README, PLAN, and matrix; changelog;
and spec registry.

Do not rewrite old changelog entries merely because their names were valid in
old releases. Correct only claims about 0.23 and current behavior.

## 10. Validation matrix

| Area | Required proof |
|---|---|
| Settings | Every row round-trips; repeated task toggles capture correct profiles; exact integer validation |
| Clear | Cancel is byte-for-byte and no-ledger no-op; confirm archives one selected goal; focus race rejected |
| Tasks | Task-specific labels; cancel no-op; confirm transaction; no auditor state |
| Completion | Approved, disabled, legacy, and Escape paths; injected failures never report success |
| Audit ledger | Exactly one final event per abort choice |
| Concurrency | Deterministic two-writer conflict across every mutation family |
| Compatibility | Old fixtures parse; current writer emits no drafting vocabulary |
| Tests | Fast test:all, real-SDK serial, discovery count, no missed files |
| Dependencies | Full development and published/runtime audits; Pi SDK compatibility smoke |
| Package | Typecheck, diff check, package dry-run, no cache/test artifacts shipped |

## 11. Commit sequence

1. Settings table, exact validation, and profile tests.
2. Clear, task, and audit confirmation semantics.
3. Completion-result propagation.
4. Revision/lock boundary and deterministic race tests.
5. Drafting residue deletion and source-boundary tests.
6. Experiment enforcement and portability.
7. Pi SDK dependency upgrade and compatibility validation.
8. Test-runner self-check, integration expansion, and living-doc closure.

Each commit keeps typecheck and the affected fast suites green.
