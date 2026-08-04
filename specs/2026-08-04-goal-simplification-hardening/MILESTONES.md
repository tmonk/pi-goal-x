# Milestones: Goal simplification hardening

## 2026-08-04 — Full implementation assessment

- Reviewed the installed five-tool/ten-command implementation, runtime module
  split, service boundary, tasks, audit, persistence, accounting, unit tests,
  E2E artifacts, experiments, and living/historical documentation.
- Compared the implementation with the accepted 2026-08-03 product/technical
  spec and current Codex Goal semantics/source.
- Confirmed type checking passes.
- The authoritative serial unit suite passed: 459 tests, 0 failures, in
  649,859 ms. It has substantial inter-file startup gaps, reinforcing the plan
  to separate pure unit and handler-level integration suites.
- `npm pack --dry-run` passed and produced the expected 36-file package.
- Found release-blocking lifecycle issues: paused-record resurrection and the
  unreachable disabled-auditor completion path.
- Found the fixed-surface requirement is not implemented: lifecycle code still
  synchronizes a state-dependent subset and mutates ordinary Pi work-tool
  selection.
- Found task transaction, structural replacement, ledger semantics,
  diagnostics, E2E coverage, experiment currency, and documentation gaps
  detailed in PRODUCT.md and TECH.md.
- No runtime fixes were made during this assessment. Documentation corrections
  and this remediation plan are the only intended changes in this pass.

## Planned milestones

1. Lifecycle normalization and disabled-auditor completion fixed.
2. Fixed three/five tool profile installed; lifecycle synchronizer removed.
3. Task confirmation and disk-fresh transactions corrected.
4. Budget and ledger contracts hardened.
5. Drafting-era code and obsolete signatures deleted; tool modules split.
6. Unit, integration, E2E, and experiment suites aligned with the public API.
7. Living docs regenerated from verified behavior; full validation recorded.

## 2026-08-05 — Stages 1-7 landed; full validation

Implemented in dependency order per TECH.md, each stage as its own reviewable
commit with the suite green:

- Stage 1 (326702f): status-authoritative normalization (paused stays paused
  incl. legacy autoContinue:true through parse and restore); one
  commitGoalCompletion helper for all four completion paths;
  settings.disabled skips the auditor immediately; update_goal schema has only
  status.
- Stage 2 (80304d2): installGoalToolProfile replaces syncGoalTools — fixed
  3/5 profile installed only at session start and on disableTasks toggles;
  23 lifecycle sync sites removed; visibility tests rewritten as invariance
  tests with arbitrary host seeds.
- Stage 3 (7733747): typed GoalService.updateTask transaction (disk-fresh,
  typed failures); task-only confirmation component ({decision}); structural
  merge clears omitted fields; countTasks for all-node counts.
- Stage 4 (9746d36): token_budget Type.Integer({minimum:1}) + shared
  validateTokenBudgetInput; task_reopened event end-to-end with backwards
  read of the legacy unskip; appendGoalEvent discriminated result +
  onDiagnostic routing with failure-injection coverage.
- Stage 5 (8dc0ca0, 770ddf6): drafting-era coupling removed (goal-tool-names
  reduced, goal-draft deleted, obsolete policy builders deleted); goal-tools
  split into registration composition + core-tools + completion + task-tools
  + task-confirmation (14/223/363/498/38 lines).
- Stage 6 (3c92bac): B1-C19 migrated to the five-tool surface; supported-case
  matrix published; integration suite replaces the removed-surface e2e tests;
  test:unit/test:integration/test:all scripts.
- Stage 7: README/architecture/agent-flow/CHANGELOG/PLAN updated to verified
  behavior; version 0.23.0; SPECS.yaml status implemented.

### Validation evidence

- `npm run check` — 0 errors.
- `npm run test:unit` — 452 pass / 0 fail (parallel, ~3s).
- `npm run test:integration` — 7 pass / 0 fail (handler-level, auditor fixture).
- `npm run test:serial` — 452 pass / 0 fail (low-file-descriptor mode; the
  earlier ~11min serial runtime is dominated by inter-file startup gaps, which
  the parallel unit script removes).
- `npm pack --dry-run` — clean (pi-goal-x-0.23.0.tgz).
- `git diff --check` — clean.
- TECH section 9 regression matrix: tool profile (no focus / active / paused /
  blocked / budget / complete / task-disabled / settings reload) — invariance
  suite; lifecycle (paused legacy restore, user pause/resume, blocked/resume,
  deferred complete/archive) — golden + policy + core-tools suites; audit
  (approved, rejected, disabled setting, legacy skip, user abort, focus race)
  — integration + core-tools suites; tasks (set/replace/clear structure,
  complete/skip/reopen, external-edit race, task disabled) — task-tools suite;
  budget (integer boundary, invalid live/legacy values, one-shot transition) —
  budget + golden suites; persistence (multi-goal pool, focus branch, external
  edit/delete/archive, ledger failure) — pool + service + unfocus suites;
  compatibility (old v3 records, all historical ledger event types incl. the
  legacy unskip) — golden fixture suite.
- C20-C26 remain the author-only release gate (mechanical rubrics verified;
  real-model pass rates are recorded here before a release, per the product
  decision).

### Honest deviations

- goal-task-tools.ts holds both task executors and the conversion/merge
  helpers at 498 lines (nominal target 300-450; maintainability target, not a
  hard invariant).
- C20-C26 real-model pass rates are not recorded in this goal: per the
  confirmed decision, verification is author-only with mechanical rubrics and
  no model budget spent.

## 2026-08-05 — Independent-audit round: fixes applied

The first completion audit (independent auditor agent) found two blocking
items; both were fixed and re-validated:

1. **Settings-menu regression (goal-commands.ts).** The Stage 2
   `saveSettings` closure recursively called itself instead of
   `saveGoalSettingsFileConfig`, so every /goal-settings edit crashed with
   `RangeError: Maximum call stack size exceeded` and never persisted. Fixed
   the call site; added two handler-level regression tests that drive the
   actual goal-settings command through a UI stub (toggle `disabled` persists;
   field editing does not overflow). The tests fail on the old code.
2. **Living-doc closure.** README, docs/architecture.md, and
   docs/agent-flow-design.md still presented the pre-hardening 0.22 gaps
   (phase-dependent tool subset, host-tool force-enable, unreachable
   disabled-auditor completion, silent ledger failures, legacy e2e/experiment
   surfaces, "known 0.22 hardening gaps" section) as current. Rewrote every
   such passage to the implemented, tested 0.23 behavior; zero "0.22"/gap
   phrasing remains in the three living docs.

Re-validation after the fixes: `npm run check` 0 errors; `test:unit`
452 pass/0 fail; `test:integration` 9 pass/0 fail (two new settings-menu
tests); `test:serial` 452 pass/0 fail; `npm pack --dry-run` clean; `git diff
--check` clean.
