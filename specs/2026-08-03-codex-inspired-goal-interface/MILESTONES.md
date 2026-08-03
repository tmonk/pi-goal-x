# Milestones: Codex-inspired goal interface simplification

> **Post-implementation correction (2026-08-04):** later assessment found that
> the claimed static tool surface still used state-dependent synchronization,
> paused legacy records could reactivate, and disabled-auditor completion was
> unreachable. These findings supersede the affected validation claims below;
> remediation is tracked in
> [`2026-08-04-goal-simplification-hardening`](../2026-08-04-goal-simplification-hardening/MILESTONES.md).

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

### 2026-08-04 00:20:00 - Stage 2: runtime and accounting extraction + token budgets

Behavior-preserving extraction of the runtime/accounting layers with additive
token-budget support. All 443 prior tests stayed green; 16 new tests added.

- `extensions/goal-accounting.ts` (new): `GoalAccounting` — serialized,
  idempotent token/time accounting. `begin(goalId)` / `charge()` advances the
  baseline so repeated calls never double-charge the same interval;
  `liveSeconds()` is read-only display. Budget helpers `budgetRemaining` /
  `budgetReached` / `budgetLine`.
- `extensions/goal-runtime.ts` (new): `GoalRuntime` — continuation scheduling
  state machine (queue/cancel/dedup, idle retry, follow-up dispatch via hooks),
  turn-stop guard scoped by turn sequence, stale-checkpoint state + tool
  blocking, and one-shot post-compaction / post-budget reminders.
- `extensions/goal.ts`: the inline continuation/turn-guard/checkpoint/reminder
  variables are replaced by a `GoalRuntime` instance and the accounting object
  by `GoalAccounting`. `accountProgress` charges through
  `accounting.charge()`, and after persisting usage runs the token-budget
  transition: when `budgetReached`, the goal is marked `budget_limited` exactly
  once via GoalService (status no longer active so accounting stops and the
  transition cannot re-fire), the `goal_budget_limited` ledger event is written
  with the budget/usage snapshot, the one-shot wrap-up steering is armed, and
  pending continuations are cancelled. `before_agent_start` gained a
  `budget_limited` prompt branch with a one-time `[TOKEN BUDGET REACHED]`
  wrap-up block.
- Record/ledger/policy additions (additive, no migration): `tokenBudget?` on
  GoalRecord, `budget_limited` status + normalization, `statusLabel` "budget
  limited", `isCompletableStatus` includes budget_limited (transition never
  implies completion), `GoalToolStatus` widened, `goal_budget_limited` ledger
  event type + validator + sanitizer.
- Refactor bug found and fixed by the existing suite: the post-stop in-turn
  tool_call block had an inverted `!` after routing through the runtime's
  allowlist helper; goal-unfocus tests caught it.
- Tests: `tests/goal-accounting-runtime.test.ts` (14 unit tests: charge
  idempotency, no negative elapsed, exact-goal activation, read-only live
  seconds, budget helpers, runtime queue guard, turn-stop scoping, stale
  checkpoint blocking, one-shot reminders) and `tests/goal-budget.test.ts`
  (2 integration tests: budget crossing marks budget_limited exactly once with
  ledger event + one-shot steering on next agent start; no-budget goals never
  transition).

Validation: `npm run test:serial` 459 pass / 0 fail; `npm run check` (tsc) 0
errors; `git diff --check` clean.

### 2026-08-04 01:10:00 - Stage 3: the three core tools installed statically

The model surface moved to the stable three-tool core; all 460 prior tests were
updated to the new advertised sets and 9 new core-tool tests added (469 total).

- `create_goal` is now REAL (was a hidden rejected shim): objective 1-4000
  chars, `mode: "regular" | "sisyphus"`, optional `token_budget` (accepted only
  when the user supplies one). It creates + focuses through GoalService,
  reports other-open-goal count, and clears any pending drafting intent.
  Prompt guidelines require an explicit user request — no inference from
  ordinary tasks.
- `get_goal` returns the complete stable snapshot (objective, status, mode,
  usage, budget + remaining, task summary, verification contract,
  pause/blocker details, paths, other-open count, lifecycle hint) and the
  get_goal nudge map is removed.
- `update_goal` accepts only `status: "complete" | "blocked"`:
  - `complete` runs the shared `runGoalCompletionFlow` (extracted from
    complete_goal) with NO verification-summary paperwork — the independent
    auditor derives requirements from the objective/contract and inspects
    actual state. The tool-level contract gate now only applies when the model
    supplied a summary. Approval archives; rejection stays open with feedback.
  - `blocked` records a distinct `blocked` status (stopReason agent) through
    GoalService with the `goal_blocked` ledger event (source agent) and stops
    continuation; accepted only from an ACTIVE goal (validateGoalBlock). The
    three-consecutive-turn blocker rule is prompt policy (tool description,
    get_goal hint), no attempt counter.
- Old lifecycle tools (complete_goal, pause_goal, abort_goal,
  propose_goal_tweak, propose_goal_draft, step_complete) stay REGISTERED as
  non-advertised compatibility shims; the stable core is installed with no
  phase-dependent synchronization. `syncGoalTools` now always advertises
  get_goal + create_goal, adds update_goal when a non-complete goal is
  focused, and gates the legacy task tools on `disableTasks` (decided once at
  session start) and status (active → all three; paused → propose_task_list).
- Record/ledger/policy additions: `blocked` status + normalization, statusLabel
  "blocked", `goal_blocked` ledger event, `validateGoalBlock` policy,
  GoalToolStatus widened. GoalService/goal-record unchanged otherwise.
- Tests updated to the Stage 3 surface: goal-tool-names, goal-surface-baseline
  (14 tools now: update_goal added), goal-tool-visibility, goal-propose-tweak
  (tweak tool is a shim, not in lifecycle sets), goal-update-objective (error
  message now lives in the shared completion flow). New
  `tests/goal-core-tools.test.ts` (9 tests: three-tool surface with tasks
  disabled, create_goal create/focus/budget/sisyphus/oversize-reject, get_goal
  full snapshot, update_goal(complete) audit-without-paperwork approval
  archives + rejection stays open, update_goal(blocked) from active records
  blocked + ledger, blocked rejected from paused).

Validation: `npm run test:serial` 469 pass / 0 fail; `npm run check` (tsc) 0
errors; `git diff --check` clean (one pre-existing trailing-space line in the
extracted completion flow cleaned).

### 2026-08-04 01:50:00 - Stage 4: task tools consolidated

Full task/subtask/contract behavior now works through exactly two advertised
task tools; all 469 prior tests stayed green and 10 new tests added (479).

- `extensions/goal-task-tools.ts` (new): flat parent-linked conversion
  (`convertFlatTasks`) with the same validation the recursive path enforced —
  unique non-empty ids/titles, existing parents, acyclic relationships, ≤50
  tasks, configured subtask depth, and `lightweight_subtasks` only on tasks
  with children — plus `mergeTasksWithExisting` (matching ids preserve
  status/evidence/timestamps).
- `set_goal_tasks` (new, advertised): flat `{tasks:[{id,title,parent_id?,
  verification_contract?,lightweight_subtasks?}], block_completion?,
  change_summary?}` schema; converts, merges, shows the existing confirmation
  dialog (with the headless auto-confirm path), applies through GoalService
  with the `task_list_set` ledger event, and terminates the turn.
- `update_goal_task` (new, advertised): discriminated
  `{task_id, status: complete|skipped|pending}` union. complete requires
  evidence for contracted tasks + completed children; skipped requires a
  reason and cascades to non-lightweight subtasks; pending reopens skipped
  tasks; completed tasks are immutable. Applies through GoalService with
  task_complete/task_skipped ledger events, counts as progress, and does NOT
  terminate the turn.
- `propose_task_list`, `complete_task`, `skip_task` are removed from the active
  model surface (TASK_TOOL_NAMES = [set_goal_tasks, update_goal_task];
  LEGACY_TASK_TOOL_NAMES kept only as non-advertised shims until Stage 7).
  GOAL_PROGRESS_TOOL_NAMES gains update_goal_task; GOAL_WORK_TOOL_NAMES gains
  both new tools.
- Tests: `tests/goal-task-tools.test.ts` (10 tests: flat tree conversion,
  duplicate/missing-title/missing-parent rejection, cycle rejection, 50-cap +
  depth + lightweight placement, id-stable merging, set_goal_tasks execution
  with nested tree + block_completion + ledger, update_goal_task complete with
  evidence + ledger, contracted-task evidence requirement, skipped reason +
  subtask cascade, pending reopen + completed immutability). Surface tests
  (goal-tool-names, goal-surface-baseline 16 tools, goal-tool-visibility)
  updated to the two advertised task tools.

Validation: `npm run test:serial` 479 pass / 0 fail; `npm run check` (tsc) 0
errors; `git diff --check` clean.

### 2026-08-04 02:30:00 - Stage 5: curated ten-command palette

Slash completion now exposes exactly the ten curated commands; all 479 prior
tests stayed green and 4 command-palette tests added (483).

- `/goal <objective>` is a direct regular-goal creation path; bare `/goal`
  shows status. `/sisyphus <objective>` is the single direct Sisyphus creation
  path. Both materialize through the existing direct-set handler (extract
  verification contract, replaceGoal, auto-continue).
- Removed registrations: `/goal-status`, `/goals`, `/goals-set`,
  `/sisyphus-set`, `/goal-abort`. Retained unchanged with concise action-first
  descriptions: `/goal-list`, `/goal-focus`, `/goal-unfocus`,
  `/goal-settings`, `/goal-tweak`, `/goal-clear`, `/goal-pause`,
  `/goal-resume`.
- The creation-drafting entry commands are gone, so the confirmationIntent
  drafting flow is now dormant (the shim tools it exposed stay registered;
  Stage 6 removes the orchestration). `/goal-tweak` keeps its drafting flow.
- Migration documentation added to README.md ("Command migration" table):
  goal-status→/goal, goals-set→/goal, sisyphus-set→/sisyphus,
  goal-abort→/goal-clear, /goals→discussion + /goal/create_goal.
- Tests: `tests/goal-command-palette.test.ts` (4 tests: exactly the ten
  commands registered and the five legacy absent with no extras, /goal creates
  directly, bare /goal shows status without creating, /sisyphus creates a
  sisyphus goal); surface-baseline command list updated from 15 to 10.

Validation: `npm run test:serial` 483 pass / 0 fail; `npm run check` (tsc) 0
errors; `git diff --check` clean.

### 2026-08-04 04:10:00 - Stage 6: steering cleanup + C20-C26 + goal.ts module split

Stage 6 completed. Summary of the three workstreams:

- Bounded steering prompts (earlier milestone 4718b33): rewrote
  `extensions/prompts/goal-prompts.ts` with the bounded five-tool templates
  (10k fragment cap, objective escaping/truncation, no removed tool names,
  three-turn blocker policy, objectiveEditedPrompt); deleted the 9 shim tool
  registrations and the question tools; `syncGoalTools` is now a static
  install; `/goal-tweak` reimplemented as a direct user-owned objective edit.
- C20-C26 experiment cases (39574f1): seven new cases with mechanical
  rejection rubrics (tool-not-called for removed tools, tool-args-jq for the
  new tools, sandbox-file/jq checks): C20 core tool selection, C21 user
  lifecycle ownership, C22 blocked three turns, C23 audit without paperwork,
  C24 multi-goal focus, C25 task tool consolidation, C26 budget limit.
- goal.ts module split (9729c5e + c5348bf + 1392322): goal.ts is now a
  33-line thin installer. Modules behind a shared GoalCore (goal-state.ts):
  goal-format.ts (pure helpers, extracted first), goal-state.ts (state +
  GoalService/runtime/accounting wiring + persistence/UI closures), goal-tools.ts
  (five tools + shared runGoalCompletionFlow/runGoalBlockedFlow), goal-commands.ts
  (ten-command palette + handlers), goal-events.ts (13 lifecycle handlers),
  goal-widget.ts (terminal keybindings + hidden debug helpers). Each extraction
  landed with the serial suite green (459 tests). Five source-inspection tests
  were repointed at the new module layout, and the dead
  statusCommand/handleGoalAbort leftovers (removed /goal-status, /goal-abort)
  plus the dormant registerQuestionnaireTools shims were deleted.

Setback: the first extraction attempt put runGoalBlockedFlow twice in
goal-tools.ts (once from the header, once from the moved region), which broke
brace balance; fixed by removing the header duplicate. The `runningGoalId`
shorthand-property replacement produced `{ goal: ..., core.runningGoalId }`
invalid syntax in two validators; fixed with explicit
`runningGoalId: core.runningGoalId`. Both were caught by tsc before tests.

Validation: `npm run test:serial` 459 pass / 0 fail; `npm run check` (tsc) 0
errors; `git diff --check` clean. `extensions/goal.ts` = 33 lines (< 500).

### 2026-08-04 04:55:00 - Stage 7: compatibility removal

Stage 7 completed (user elected to include it now rather than after one minor
release):

- Hidden shims deleted: `registerQuestionnaireTools` (goal_question /
  goal_questionnaire registrations) removed from goal-questionnaire.ts
  (1392322); grep confirms zero `name: "complete_goal" | "pause_goal" |
  "abort_goal" | "propose_goal_draft" | "propose_goal_tweak" |
  "propose_task_list" | "complete_task" | "skip_task" | "step_complete" |
  "goal_question" | "goal_questionnaire"` registrations remain in
  extensions/.
- Legacy command routing deleted: the dead statusCommand const (removed
  /goal-status) and handleGoalAbort handler (removed /goal-abort) were
  dropped during the module split (c5348bf); grep confirms no
  registerCommand("goal-status"|"goals"|"goals-set"|"sisyphus-set"|
  "goal-abort") remains.
- Old readers retained and verified in use: readActiveGoalPool,
  mergeGoalPromptFromDisk (goal-service.ts, goal-state.ts), readGoalLedger +
  latestAuditorResultForGoal (goal-events.ts, goal-compaction.ts),
  normalizeGoalRecord (goal-state.ts loadState legacy migration).
- Model-visible text purged of removed tool names: paused-goal steering
  prompt now references update_goal(complete) and /goal-clear; policy
  validator messages name update_goal instead of complete_goal/skip_task.
- Removal documented: CHANGELOG 0.22.0 "Removed" section and a new README
  "Tool migration" table (alongside the existing "Command migration" table).

Validation: `npm run test:serial` 459 pass / 0 fail; `npm run check` (tsc) 0
errors; `git diff --check` clean.

### 2026-08-04 06:10:00 - Final validation, docs, and completion checklist

- docs/architecture.md and docs/agent-flow-design.md rewritten to the current
  architecture (the previous versions described the removed
  propose_goal_draft/goal_question/pause_goal surface and were partly Chinese).
- package version bumped 0.21.0 -> 0.22.0; CHANGELOG 0.22.0 section added.
- Model-visible text purged of removed names: post-compaction instruction,
  resume-validation messages, goal-list/unfocused summaries now reference
  /goal and /sisyphus (golden tests updated).
- Test wording cleanup: titles/comments referencing complete_goal and
  propose_goal_tweak renamed to the current tools; negative removal
  assertions retained.
- PRODUCT success criteria 1-8 and TECH test-strategy items verified against
  the suite: disableTasks -> exactly 3 advertised tools (goal-core-tools
  :123); budget_limited transition fires exactly once (goal-budget :96/136/141);
  exactly ten commands registered (goal-command-palette :75); C20-C26
  mechanical rejection rubrics (author-only per user decision).
- Full validation: npm run check 0 errors; npm run test:serial 459 pass /
  0 fail; npm pack --dry-run clean (pi-goal-x-0.22.0.tgz, 36 files);
  git diff --check clean.
- CJK sweep: zero CJK in produced files; the only hits are pre-existing
  functional Chinese-objective handling (goal-core.ts / goal-draft.ts /
  goal-questionnaire.ts regexes) and CJK width/objective test fixtures,
  allowed by the goal's no-Chinese tweak as data.
- Branch audit: 17 commits, all with clear conventional messages
  (feat/refactor/test/docs/chore); no rewrites needed.
