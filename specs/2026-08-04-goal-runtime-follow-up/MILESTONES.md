# Milestones: Goal runtime follow-up

## 2026-08-04 — Full post-implementation assessment

- Reviewed the 0.23 tool/command surface, lifecycle, completion/auditor paths,
  settings UI, task transactions, service boundary, concurrency behavior,
  persistence/ledger, experiment harness, packaging, tests, and living docs.
- Confirmed the five-tool/ten-command simplification and the main hardening
  changes are present.
- Confirmed user-visible defects in settings selection, repeated profile
  toggles, integer parsing, missing /goal-clear confirmation, and task
  confirmation labels.
- Confirmed completion-result, audit-abort ledger, simultaneous-writer,
  experiment-matrix, provider-smoke, portability, residual drafting-code, and
  documentation gaps captured in PRODUCT.md and TECH.md.
- Typecheck passed.
- Package dry-run passed with 39 package files; test scripts, cache, and specs
  remain excluded from the published package.
- The published/runtime dependency audit reports zero findings. The complete
  development graph reports six high-severity findings rooted in the current
  Pi SDK toolchain; the available direct fix is a major SDK upgrade and is
  planned with compatibility validation.
- External real-model experiments were intentionally not run because they are
  manual, opt-in, and incur provider usage.

## 2026-08-04 — Test startup remediation implemented

- Added a direct Node test runner with automatic root-unit/integration
  discovery, one-process execution, and focused adapters for the Pi AI,
  coding-agent, and TUI runtime values used by tests.
- Rewired test, test:unit, and test:integration; retained the original
  real-SDK, process-isolated test:serial diagnostic.
- Verified test:all reports 461 pass and 0 fail (452 unit plus 9 integration).
- Observed in this workspace: test:all completes in roughly 12 to 28 seconds
  depending on mounted-volume cache state, versus a previous default that was
  still incomplete after roughly 127 seconds and roughly 11 minutes for the
  serial path. The new path is about 23 to 55 times faster than that
  authoritative serial baseline.
  Timings are evidence, not portable performance guarantees.

## 2026-08-04 — Stage 6: experiment harness enforcement and portability

- `SUPPORTED_CASES.json` is now ENFORCED in `resolve_case_dir`: exact
  case-id membership is required before directory resolution; raw case
  directories require the explicit `--allow-unsupported` diagnostic flag
  (`run.sh <raw-dir> --allow-unsupported`).
- The provider smoke request uses the selected `PI_GOAL_TEST_MODEL` instead
  of a hardcoded model, validates the HTTP status code and JSON shape
  (`choices` array on 200), and caps reported response text at 200 chars.
- Portable outer timeout: discovers `timeout`, then `gtimeout`, then a
  bundled Node watchdog (`harness/watchdog.mjs`, exit 124 on timeout,
  forwards child exit codes); otherwise fails with a clear prerequisite
  message. `run.sh` uses the resolved `TIMEOUT_PREFIX`.
- Shell tests (`tests/shell/harness.test.sh`, 17 assertions, run in the fast
  suite via `tests/goal-harness-shell.test.ts`): supported/unsupported
  resolution, raw-dir diagnostics, MODEL-aware smoke payload (stubbed curl),
  missing configuration, HTTP 429 + JSON shape failure, and timeout
  selection — all with stubbed curl/pi/tooling.
- Observations index (`experiments/observations/INDEX.md`): observation
  files are explicitly historical evidence, not current instructions; the
  experiment README and PLAN now document enforcement, the smoke behavior,
  portability, and the index.
- Validation: `npm run check` 0 errors; `test:all` 510/0; `test:serial`
  real-SDK 482/0; `git diff --check` clean.
## 2026-08-04 — Stage 5.1-C: capability parity without tool sprawl

- `update_goal` gained `paused` (required `reason`, optional
  `suggested_action`): an immediate agent-initiated pause on an active goal —
  `goal_paused` ledger event with `source: "agent"`, continuation stopped,
  pause reason/action persisted. `blocked` remains the three-consecutive-turn
  outcome and stays active-only gated.
- Abandonment stays user-owned: the model surface directs `update_goal` and
  `get_goal` callers to `/goal-clear` when a goal should be discarded; no
  `abort_goal` tool exists.
- Objective mutation stays user-started: requirement changes are directed to
  `/goal-tweak`; `propose_goal_tweak` is not restored as a steady-state tool.
- Optional `completion_summary` on `update_goal({status:"complete"})` is
  forwarded to the auditor as an UNTRUSTED `<executor_claim>` (never
  evidence, never an approval bypass); the auditor prompt cross-checks it
  against real artifacts and it cannot make a disapproved goal complete.
- Tests (+4 integration): immediate agent pause with reason/action and
  `goal_paused(source: agent)`; reason required + active-only gate; the
  completion claim reaches the auditor while a disapproval still keeps the
  goal open; source-level guidance assertions (no steady-state tweak/abort
  tools).
- Validation: `npm run check` 0 errors; `test:all` 509/0; `test:serial`
  real-SDK 481/0; `git diff --check` clean.
## 2026-08-04 — Stage 5.1-B: /goal-status and per-draft auditor selection

- Registered `/goal-status` (14-command palette): read-only focused-goal
  summary plus other-open-goal count, reusing the existing `showGoalStatus`
  helper; it never initiates drafting or an agent turn. `/goal-list` remains
  the pool view.
- Per-draft auditor selection: the draft session carries `auditorEnabled`
  (defaulting to `!settings.disabled`); the confirmation dialog receives it
  as `defaultAuditorEnabled` (its visible toggle renders the choice), and the
  confirmation text displays the selected auditor behavior. Continue
  refining preserves the user's toggle in memory and the durable session
  entry. Confirmation persists `skipAuditor` through the one creation
  transaction (`GoalCreationConfig.skipAuditor` → `createGoal`) and mutates
  it in the same `GoalService.apply` transaction on tweak. Headless
  confirmation uses the effective-settings default.
- Tests (+4): `/goal-status` reports focused and unfocused state without
  drafting; auditor choice persists on create and through continue refining;
  headless defaults (auditor on, or off when settings.disabled); tweak
  persists the choice in the same transaction.
- Validation: `npm run check` 0 errors; `test:all` 504/0; `test:serial`
  real-SDK 480/0; `git diff --check` clean.
## 2026-08-04 — Stage 5.1-A: durable draft state and /goal-cancel

- Replaced the module-local WeakMap-only draft marker with a branch-local
  custom session entry (`pi-goal-draft`, version 1) plus the in-memory cache.
  The entry is never a goal file or ledger event; a draft survives compaction
  and tree navigation and is rehydrated on `session_start`/`session_tree`
  (`rehydrateDraft`). Clearing appends a tombstone (`clearedAt`) — the SDK
  exposes only append, and the last entry wins.
- Rehydration validates a tweak draft's target against the focused goal; a
  stale tweak draft is tombstoned, reported, and the execution profile is
  restored. A live memory draft is validated the same way on reload.
- Second-draft protection: starting a draft while one is active offers
  Resume / Replace / Cancel (`ctx.ui.select`); headless replaces with an
  explicit warning — never silently.
- New `/goal-cancel` command (13-command palette): removes draft state and
  the transient drafting profile, writes no goal file/focus/ledger entry;
  a second cancel returns guidance. `/goal-abort` is not reintroduced.
- Profile installs are now idempotent (skip `setActiveTools` when the target
  set is already installed), reinforcing the invariant that lifecycle
  transitions never rebuild the tool surface; the integration harness's
  `getActiveTools` now mirrors `setActiveTools` (contract-faithful).
- Tests (+5 in `tests/goal-drafting.test.ts`, palette/surface counts updated
  to 13 commands): `/goal-cancel` durable no-op + tombstone; draft survives
  `session_tree` rehydration and confirms atomically; resume/replace/cancel
  second-draft choices including headless replacement; stale tweak
  invalidation on rehydration; direct creation interrupting and clearing an
  active draft.
- Validation: `npm run check` 0 errors; `test:all` 500/0; `test:serial`
  real-SDK 476/0; `git diff --check` clean.
## 2026-08-04 — Stage 5: guided drafting runtime completed and verified

- The restored drafting flow (committed at `5bf4f2c`) was completed with the
  remaining TECH §6 behaviors:
  - Explicit **Cancel — discard this draft** choice in the confirmation
    dialog (`ProposalDecision` now `confirm | continue | cancel`). Cancel
    clears draft state and drafting tools, restores the execution profile, and
    performs no durable goal/file/ledger mutation. Escape still maps to
    continue-refining so the user is never trapped.
  - **Sisyphus structural sufficiency** (`sisyphusObjectiveSufficient` in
    goal-contract.ts): numbered item markers (`1)`, `1.`, `Step N`) required
    for both `/sisyphus-direct` and guided sisyphus proposals; insufficient
    objectives are rejected with guidance to the guided flow.
  - **Contracts-disabled gating**: with `disableContracts` set, a
    `Verification contract:` line stays plain objective prose and is never
    promoted to the structured contract field (guided proposal and direct
    creation alike).
- Added `tests/goal-drafting.test.ts` (12 handler-level tests): dialog
  cancel durable no-op; continue-refining preserves answers and proposed
  tasks across a second proposal; atomic confirmation persists verification
  contract + nested parent-linked task tree and restores the execution
  profile; sisyphus mode mismatch and sufficiency validation; tasks-disabled
  and contracts-disabled variants; `/goal-tweak` confirmation under focus
  validation; stale-tweak-target rejection without mutation; explicit
  headless auto-confirm semantics (default confirm, `PI_GOAL_AUTO_CONFIRM=0`
  keeps pending, `=1` confirms with UI); batch questionnaire and single
  dependent-follow-up question handler tests. Plus unit coverage for
  `sisyphusObjectiveSufficient`.
- Compaction/tree restoration of an unconfirmed draft and migration tests
  for legacy draft-session entries are deferred to Stage 5.1-A (durable
  branch-local draft state replaces the module WeakMap).
- Validation: `npm run check` 0 errors; `test:all` 495/0; `test:serial`
  real-SDK 471/0; `git diff --check` clean.
## 2026-08-04 — Baseline reconciliation after the product correction

- The working tree was re-baselined at `5bf4f2c` (restore guided drafting
  workflow) and `0a55f24` (rebaseline follow-up implementation plan). The
  superseded stage-5 deletion direction is void; MILESTONES product
  correction governs.
- Reconciliation fixes on top of the restored baseline:
  - `goal-drafting.ts` typecheck fixes: `target ?? undefined` for the
    proposal dialog argument, and an explicit narrow guard before
    `focusedOperationToken(target.id)` (the tweak path's target is
    `GoalRecord | null | undefined`; control-flow narrowing alone could not
    prove non-null after the mode guard).
  - `tests/goal-contract.test.ts` was a duplicate of the restored
    `tests/goal-draft.test.ts` (identical 31-line content, left over from the
    superseded rename); deleted.
  - `tests/goal-tool-names.test.ts` rewritten for the restored surface: the
    three drafting tool names live only in the transient `DRAFTING_GOAL_TOOLS`
    profile and never leak into the fixed three/five execution, work, or
    progress sets; steady-state lifecycle tools (`propose_goal_tweak`,
    `abort_goal`, `complete_task`, ...) and phase heuristics remain absent.
  - Deleted `tests/goal-source-boundary.test.ts` (asserted drafting
    vocabulary absence — opposite of the corrected product direction).
- Validation: `npm run check` 0 errors; `test:all` 482/0 fast tests
  (452 unit + 30 integration); `test:serial` real-SDK 458/0; `git diff
  --check` clean.
## Planned milestones

1. Complete Stage 5.1: persistent/cancellable drafts, focused status, and
   per-draft auditor selection.
2. Complete compatibility without tool sprawl: immediate agent pause,
   user-authorized abandonment guidance, user-started tweak enforcement, and
   optional untrusted completion summaries.
3. Experiment matrix, smoke model, and timeout behavior hardened.
4. Pi SDK development graph upgraded and audited.
5. Integration matrix and living docs closed; release validation recorded.

## 2026-08-04 — Product correction: drafting is a first-class workflow

The prior simplification plan incorrectly classified the human-facing drafting
experience as removable runtime complexity. User direction corrects this:

- `/goal [seed]` and `/sisyphus [seed]` must start full guided drafting.
- `/goal-direct <objective>` and `/sisyphus-direct <objective>` are the only
  creation paths that skip questions, refinement, task co-design, and final
  confirmation.
- The agent must be able to ask structured questions, refine in conversation,
  choose a useful task hierarchy, and propose objective, tasks, and verification
  contract together for one atomic confirmation.
- The fixed three/five tool profile remains the normal execution surface. A
  separate transient drafting profile is allowed only during a user-started
  draft and is removed before execution begins.

The in-progress Stage 5 deletion of questionnaire/drafting files is superseded
and must be reversed or repurposed, not completed.

## 2026-08-04 — Guided drafting restored

- Restored the questionnaire UI and drafting prompt helpers instead of
  completing their deletion.
- `/goal [seed]` and `/sisyphus [seed]` now enter a transient drafting tool
  profile; bare `/goal` asks the agent to establish the objective.
- Added explicit `/goal-direct` and `/sisyphus-direct` immediate-creation
  paths. They clear an in-progress draft before creating a goal.
- Added `propose_goal_draft` orchestration: it validates the selected mode,
  converts and validates the agent-proposed flat task tree with configured
  depth, displays objective and tasks for confirmation, and persists them in
  the creation transaction only after confirmation.
- `/goal-tweak` now starts a guided, confirmed refinement draft; no direct
  objective replacement occurs.
- Added surface and handler regression coverage for draft entry, headless
  confirmation, task-tree persistence, direct bypass, and profile restoration.

## 2026-08-04 — Post-restoration parity audit

- Identified remaining reductions relative to v0.21: no dedicated draft
  cancellation or focused-status command, no per-draft auditor toggle, no
  immediate agent pause, no agent-requested tweak entry, and no optional
  executor completion summary for the auditor.
- Added Stage 5.1 to PRODUCT.md and TECH.md. It restores `/goal-cancel`,
  `/goal-status`, persistent draft state, and per-draft auditor selection;
  it also specifies compact-contract replacements for pause, abandonment,
  tweak ownership, and completion claims.
