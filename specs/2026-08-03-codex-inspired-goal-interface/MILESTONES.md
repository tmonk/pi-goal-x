# Milestones: Codex-inspired goal interface simplification

Free-form implementation log for meaningful milestones, failed attempts,
setbacks, fixes, validation, and decisions.

### 2026-08-03 22:10:00 - Full interface and architecture analysis completed

Inventoried the current pi-goal-x extension and compared it with both the
current Codex documentation and the source implementation at
`/Volumes/tom/projects/codex`.

Current pi-goal-x findings:

- `extensions/goal.ts` is 3,755 lines and combines installation, command
  routing, tool execution, runtime state, continuation, accounting, audit UI,
  and event handling.
- The extension registers twelve goal tools and fifteen slash commands or
  aliases.
- The active tool surface is phase-dependent through `syncGoalTools()` and
  exposes internal workflow phases such as draft proposal, tweak proposal,
  questionnaires, abort, and three separate task operations.
- The extension's differentiated behavior is valuable and should remain:
  multi-goal pool/focus, Sisyphus mode, task trees, contracts, semantic audit,
  disk reconciliation, ledger, compaction recovery, settings, and widget.

Codex source findings:

- `codex-rs/ext/goal/src/spec.rs` exposes only `create_goal`, `get_goal`, and
  `update_goal` with small stable schemas.
- `codex-rs/ext/goal/src/api.rs` centralizes external goal mutations in a goal
  service; `runtime.rs`, `accounting.rs`, `steering.rs`, `events.rs`, and the TUI
  each have distinct ownership.
- `update_goal` accepts only complete/blocked status. The three-turn blocker
  rule is prompt policy rather than another persisted counter.
- `/goal` is one command namespace for summary, objective set, edit, pause,
  resume, and clear.
- Token budget exhaustion is a system transition with one-time wrap-up
  steering and does not imply completion.

Decision: target five advertised model tools—three Codex-shaped core tools plus
two task tools—while retaining the extension's value-added internals. The
product and technical specs describe a staged, behavior-preserving extraction
before interface removal.

Validation notes:

- `npm run check` passed.
- The default parallel `npm test` run executed 350 of 355 tests successfully but
  five test-file workers failed to load TypeBox with `EMFILE`; these were loader
  failures, not assertion failures.
- The complete test suite passed with exit code 0 in serial mode using:
  `node --experimental-strip-types --test --test-concurrency=1 tests/*.test.ts`.

### 2026-08-03 22:20:00 - Plan ready for product review

Created `PRODUCT.md` and `TECH.md`. No runtime implementation changes were made.
The next action is review of the five-tool target, command compatibility policy,
and whether token-budget behavior belongs in the first implementation series or
a follow-up stage.

### 2026-08-03 22:35:00 - Dedicated commands retained for discoverability

User feedback established that frequent lifecycle actions should remain
separate slash commands because tab completion is easier than remembering
`/goal` subcommands. Updated PRODUCT first, then TECH, to specify a curated
ten-command palette: `/goal`, `/sisyphus`, `/goal-tweak`, `/goal-pause`,
`/goal-resume`, `/goal-clear`, `/goal-list`, `/goal-focus`, `/goal-unfocus`, and
`/goal-settings`.

The simplification now removes only redundant or workflow-specific commands:
`/goal-status`, `/goals`, `/goals-set`, `/sisyphus-set`, and `/goal-abort`.

### 2026-08-03 23:10:00 - Stage 0: characterization and interface contract

Stage 0 executed with zero runtime behavior change. Baseline artifacts committed:

- `tests/goal-surface-baseline.test.ts` — pins the current surface: 13 registered
  goal tools in registration order (goal_question, goal_questionnaire, get_goal,
  create_goal [hidden], propose_goal_draft, propose_goal_tweak, complete_goal,
  pause_goal, abort_goal, step_complete, propose_task_list, complete_task,
  skip_task), 15 registered commands, and the phase-advertised sets
  (ACTIVE 8 / PAUSED 5 / NO_FOCUSED [get_goal]).
- `tests/fixtures/goals/active_goal_fixture.md` and
  `tests/fixtures/ledger/goal_events_fixture.jsonl` — checked-in golden fixtures.
- `tests/goal-golden.test.ts` (15 tests) — golden coverage for goal-file v3
  serialization/parsing (prompt body authoritative, top-level task rendering),
  ledger read/reconstruct, focus resolution, compaction summary text, auditor
  decision markers, and archived-goal behavior.
- `tests/goal-stale-continuation-golden.test.ts` (3 tests) — stale checkpoint
  aborts the turn and injects `[GOAL STALE goalId=...]`; matching checkpoint
  proceeds; a user turn cancels the pending continuation.
- `experiments/BASELINE.md` — surface snapshot, six-scenario case map, baseline
  corrections record, serial-test invocation note.
- `experiments/cases/B1-repeated-blocker/` and `experiments/cases/B2-task-completion/`
  — new baseline cases using the current interface (pause_goal with
  reason+suggestedAction for repeated blockers; propose_task_list + complete_task
  + complete_goal for task workflows).
- `package.json` — added `test:serial` script
  (`node --experimental-strip-types --test --test-concurrency=1 tests/*.test.ts`),
  the EMFILE-safe authoritative invocation.

Baseline corrections (mechanical, no behavior change):

- Experiment rubrics referenced `update_goal` (14 refs) and `apply_goal_tweak`
  (3 refs), which are NOT registered tools; normalized to `complete_goal` and
  `propose_goal_tweak` (the actual completion/tweak tools) across all case
  rubrics and INPUT narratives.
- C4 INPUT narrative updated: tweak applies through `propose_goal_tweak`, not by
  editing `active_goal_*.md` directly (matches the current sanctioned channel).
- C18 INPUT prose 12s → 20s to match the machine header `ABORT_AFTER_MS: 20000`.
- All experiment case INPUT/rubric narrative translated to English (no CJK);
  functional CJK fixtures in tests/ preserved as data; C1 rubric's full-width
  question-mark variant in the final-text pattern normalized to ASCII `[?]`.

Validation: `npm run test:serial` 0 failures; `npm run check` (tsc) 0 errors;
`git diff --check` clean. EMFILE from parallel test loading is a loader flake,
not a product failure (documented in experiments/BASELINE.md §4).

### 2026-08-03 23:50:00 - Stage 1: GoalService extracted as the sole mutation boundary

Behavior-preserving extraction. No public command/tool changed; all 431 prior
tests stayed green and 12 new tests were added.

- `extensions/goal-service.ts` (new, ~250 lines): `GoalService` owns the ordered
  mutation pipeline — (1) safe focused record reconciliation from disk,
  (2) expected goal id + focus revision validation, (3) mutation on a clone,
  (4) active-file write or archival, (5) best-effort ledger append,
  (6) in-memory pool/focus commit, (7) returned runtime/UI effects via ref hooks.
  A failed authoritative write throws before any memory/ledger/focus/archive
  commit; a failed ledger append after the write keeps the transition and
  reports diagnostics (matching existing best-effort ledger semantics).
- `extensions/goal.ts` now contains zero direct calls to
  writeActiveGoalFile/archiveGoalFile/atomicWriteGoalFile/appendGoalEvent/
  ensureDirectory/safeUnlinkGoalFile:
  - 8 mutation sites route through `goalService.apply` (archiveCurrentGoal,
    stopActiveGoal, propose_goal_tweak apply with reconcile:false to avoid
    clobbering the authoritative objective, the 4 completion writes, the 3 task
    tool writes, turn_end deferred archival);
  - creation routes through `goalService.create` (write → goal_created ledger →
    focus commit);
  - `persist()` and `reconcileFocusedGoalFromDisk()` delegate to the service;
  - all 19 ledger appends route through `goalService.appendEvents`;
  - debug widget file ops route through `goalService.writeDebugFile` /
    `removeDebugFile`.
- The service is constructed with a ref that binds the extension's closure state
  (pool, focus, revision token, focus-entry, continuation/accounting/nudge glue).
- Tests: `tests/goal-service.test.ts` (8 tests: write→ledger→memory ordering,
  ledger-factory failure does not roll back, expected-id mismatch rejection,
  stale focus-revision rejection, reconcile-first goal-loss abort, persist merges
  the authoritative prompt body from disk, create ordering, archive mode with
  commitFocused:false) and `tests/goal-mutation-boundary.test.ts` (4 source-level
  tests asserting goal.ts never invokes or imports the mutation primitives and
  always goes through GoalService).

Validation: `npm run test:serial` 443 pass / 0 fail; `npm run check` (tsc) 0
errors; `git diff --check` clean.
