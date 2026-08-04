# Changelog

All notable changes to pi-goal-x are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
with the `0.x` prefix indicating pre-1.0 development.

---

## [Unreleased]

### Fixed

- **Goal dialogs no longer scroll the terminal viewport:** the accept-goal
  confirmation dialog (`propose_goal_draft`), the goal questionnaire, the
  task-list confirmation, and the audit escape dialog now render in a
  DECSET 1049 alternate screen instead of replacing the editor inline in the
  main TUI buffer. Rendering is fully isolated from the main screen, so a
  user reading scrollback keeps their reading position across dialog
  open/close, and the post-close identity re-render writes zero bytes. When
  alt-screen support is unavailable the dialogs fall back to pi's default
  rendering.
- **Goal tool-call headings always render their complete content:** `update_goal`
  shows the full agent reason (`paused`/`blocked`) and the full completion
  summary (`complete`); `set_goal_tasks` and `propose_goal_draft` previews are
  no longer truncated. Headings wrap to the terminal width via pi's `Text`
  component — no truncation anywhere (full port of the capyup/pi-goal #11
  behavior; the "compact previews stay" carve-out is intentionally dropped).

## [0.22.0] — 2026-08-04

Single consolidated release on the simplification branch: the codex-inspired
interface, the hardening pass, and the goal-runtime follow-up all ship
together as the one version after the 0.21 baseline.

### Added

- **Codex-inspired five-tool model surface:** `create_goal` (objective
  1–4000 chars, mode, optional `token_budget`), `get_goal` (stable snapshot,
  no nudge map), and `update_goal` — terminal outcomes `complete` (audited
  from actual evidence; optional `completion_summary` is an untrusted
  claim), `blocked` (set only after the same blocker recurs on three
  consecutive goal turns), and `paused` (immediate agent pause with required
  `reason` and optional `suggested_action`) — plus the two consolidated task
  tools `set_goal_tasks` (flat parent-linked task-tree definition with
  confirmation) and `update_goal_task` (per-task
  `complete`/`skipped`/`pending` status updates without stopping the turn).
- **Token-budget support:** optional `token_budget` on creation; when
  accounted usage reaches the budget the goal transitions to a distinct
  `budget_limited` status exactly once, emits a `goal_budget_limited` ledger
  event, and injects one-time wrap-up steering (summarize, do not start new
  work, do not claim completion).
- **Curated fourteen-command palette:** `/goal` and `/sisyphus` start
  guided drafting (bare `/goal` is never status); `/goal-direct` and
  `/sisyphus-direct` bypass it; `/goal-list`, `/goal-focus`, `/goal-unfocus`,
  `/goal-settings`, `/goal-tweak`, `/goal-clear`, `/goal-pause`,
  `/goal-resume`, plus `/goal-status` (read-only focused-goal summary) and
  `/goal-cancel` (discard the in-progress draft as a durable no-op).
- **Guided drafting runtime, restored as a first-class workflow.** Drafting
  runs in a transient, user-invoked profile with `goal_question`,
  `goal_questionnaire`, and `propose_goal_draft` (Confirm / Continue /
  Cancel with per-draft auditor selection); confirmation atomically creates
  the objective, verification contract, and task tree, then restores the
  execution profile. Drafts persist in branch-local `pi-goal-draft` session
  entries (survive compaction and tree navigation) with Resume/Replace/Cancel
  protection; Sisyphus proposals require ordered-step structure;
  contracts-disabled settings keep contract lines as plain prose.
- **GoalService/runtime/accounting extraction:** `goal.ts` is a thin
  installer; state lives in a shared `GoalCore` (goal-state.ts) with
  tools/commands/events/widget/format split into dedicated modules.
- **Cross-process mutation serialization:** goals carry a persisted
  monotonic `revision` (legacy records normalize to zero); `GoalService`
  acquires a per-goal filesystem lock, re-reads the authoritative file under
  it, and returns typed conflicts to stale writers instead of overwriting
  blindly. `update_goal_task` retries once only when the same task and
  status/structure remain unchanged; `set_goal_tasks` surfaces the typed
  conflict.
- **Enforced, portable experiment harness:** `SUPPORTED_CASES.json`
  membership is required before a run directory is created (raw dirs need
  `--allow-unsupported`); the provider smoke uses the selected model and
  validates HTTP status and JSON shape with capped response text; the outer
  timeout discovers `timeout`, `gtimeout`, then a bundled Node watchdog;
  shell tests with stubbed curl/pi cover resolution, payload, missing
  configuration, and timeout selection; an observations index marks old runs
  as historical evidence. Experiment cases B1–B2 and C1–C26 are migrated to
  the current interface with mechanical rubrics.
- **Test runner self-check:** `npm run test:selfcheck` asserts the
  discovered test entries match the pinned manifest.

### Changed

- **Settings menu is fully operable.** Every persisted field is selectable
  and editable through `/goal-settings` (`disableTasks`, `disableContracts`,
  `autoSelectSingleGoal`, `disabled`, `provider`, `model`, `thinkingLevel`,
  `subtaskDepth`); `subtaskDepth` validates the full input string (whole
  positive safe integers only) and repeated task toggles in one menu session
  reinstall the correct fixed three/five profile every time.
- **`/goal-clear` asks for confirmation.** Cancelling changes no file,
  focus entry, ledger entry, or runtime state (byte-for-byte no-op); headless
  runs return guidance without mutation. The focus is re-validated after the
  dialog so a stale confirmation never archives the wrong goal.
- **Task-list confirmation uses neutral labels.** The dialog offers Confirm
  task list / Keep current tasks and returns only a task decision — no
  goal-creation wording, questionnaire state, or auditor toggle.
- **Completion commits are failure-checked.** `commitGoalCompletion` returns
  a discriminated result and inspects `GoalService.apply`; a failed state
  mutation never renders a success report, a `goal_completed` event, or a
  focus clear, and deferred-archive failures surface as observable warnings.
- **Audit aborts produce one canonical outcome.** Escape during an audit
  records transient state only; the eventual user choice writes exactly one
  ledger event — `audit_skipped(user_aborted)` for complete-without-audit,
  nothing for continue-working — and continue-working leaves the goal active.
- **`/goal-tweak` is a guided, user-confirmed refinement** through
  GoalService (preserves usage/tasks/mode/budget, reactivates
  `budget_limited` goals), validated against the focused goal's revision and
  staying user-started — there is no steady-state `propose_goal_tweak`.
- **Capability parity without tool sprawl.** The agent can pause with a
  reason and optional suggested action; abandonment stays user-owned via
  `/goal-clear`; objective changes stay user-started via `/goal-tweak`;
  `completion_summary` is passed to the auditor as an untrusted claim —
  never evidence, never an approval bypass.
- **Bounded five-tool steering prompts** (10k fragment cap, objective
  escaping, three-turn blocker policy).
- **Pi SDK family upgraded to 0.83** (`pi-ai`, `pi-coding-agent`, `pi-tui`
  together; no forced audit-fix split). Both the full development graph and
  the published/runtime graph audit clean (transitive advisories fixed with
  same-major overrides; the lock was generated with npm 12 because npm 11
  ignores overrides and `npm ci` replays the resolved versions).
- **Test runner consolidation.** Unit and handler-integration tests are
  automatically discovered and run in one Node process with
  contract-faithful test adapters for the small Pi SDK runtime surface they
  exercise; `test:serial` remains the real-SDK, process-isolated
  compatibility path. `tests/e2e/extension.test.ts` is replaced by
  `tests/integration/extension.test.ts` (the handler-level integration suite
  drives the actual registered tools with an auditor fixture).

### Fixed

- **Persisted lifecycle status is authoritative.** The paused `&&`
  autoContinue `=>` active migration is deleted: a persisted paused record
  (including the legacy `{status:"paused", autoContinue:true}` case) stays
  paused through every read, markdown parse, and session restore.
  `autoContinue` is an execution preference and never rewrites status.
- **Disabled-auditor completion is reachable.** `settings.disabled: true` is
  an explicit user-owned setting that skips the auditor, records
  `audit_skipped`, and completes through the normal deferred-completion path
  — no model-only bypass field. All successful completion commits
  (audit-approved, globally disabled, legacy per-goal skip, Escape bypass)
  share one transaction helper.
- **Disk-fresh task transactions.** `update_goal_task` reconciles the
  focused record, validates the focus token, loads the task from the
  disk-refreshed clone, validates the transition against it, and updates only
  that task's path, returning typed failures for
  removed-task/task-list races. Concurrent external task edits survive unless
  the operation changes the same task.
- **Structural task replacement clears omitted fields.** Matching task ids
  preserve only runtime progress (status, evidence, completion/skip
  timestamps, skip reason); omitted structural fields (verification contract,
  lightweight flag, children, parentage) are cleared, not inherited.
- **Token budget hardening.** `token_budget` is a positive safe integer in
  the schema and at runtime; fractional, zero, negative, infinite, and unsafe
  values are rejected live and normalized to absent when persisted.
- **Ledger vocabulary and diagnostics.** Reopening a task writes
  `task_reopened` (the old synthetic `task_skipped` unskip reason still reads
  back); `appendGoalEvent` returns a discriminated result and every
  GoalService ledger loop routes failures through an observable
  `onDiagnostic` hook without rolling back the authoritative state write.
- **Fixed three/five tool profile.** `installGoalToolProfile` installs
  exactly five goal tools with tasks enabled, exactly three when disabled,
  only at session start and on `disableTasks` settings toggles; lifecycle
  transitions never add/remove/restore goal tools and ordinary pi work tools
  are never touched.

### Removed

- **Hidden tool shims and legacy command routing:** the `complete_goal`,
  `pause_goal`, `abort_goal`, `propose_goal_tweak`, `propose_task_list`,
  `complete_task`, `skip_task`, and `step_complete` tool registrations are
  gone from the active surface; the `/goals`, `/goals-set`, `/sisyphus-set`,
  and `/goal-abort` command registrations are gone. The drafting tools
  (`goal_question`, `goal_questionnaire`, `propose_goal_draft`) live only
  inside the transient drafting profile, and the restored `/goal-status` is a
  read-only command. Old goal-file and ledger readers
  (`readActiveGoalPool`, `readGoalLedger`, `mergeGoalPromptFromDisk`,
  `latestAuditorResultForGoal`, `normalizeGoalRecord`) remain for
  backward-compatible reads of existing data. See the README “Command
  migration” and “Tool migration” tables.
- Obsolete abort/pause/completion-summary policy builders.

---

## [0.21.0] — 2026-08-03

### Added

- **`/goal-unfocus` command:** Detaches the current session from its focused goal,
  stops or aborts that session's continuation and in-flight goal work, and records a
  session-local null focus entry with reason `unfocused` without pausing, modifying,
  archiving, or writing a focus event for the shared goal in `.pi/goals/`. Pending
  audits and confirmation flows revalidate session focus before applying results.

### Documentation

- Clarified that `autoSelectSingleGoal: false` keeps focus—not the shared project goal
  files—session-scoped.

## [0.20.1] — 2026-08-03

### Fixed

- **Republished to match merged main:** The 0.20.0 npm tarball was built from the
  integration branch before the merge and omitted the local main line changes
  (`propose_goal_tweak` tasks parameter with inheritance and box-drawn display,
  `renderConfirmationTasks` refactor, deferred `syncGoalTools`, test/CHANGELOG updates).
  0.20.1 ships the full merged tree at `origin/main` (merge commit 3274063), including
  all five integrated PRs (#4-#8).

## [0.20.0] — 2026-08-03

### Added

- **`autoSelectSingleGoal` setting (opt-in single-open auto-focus):** Sessions now start
  unfocused by default so goals stay session-scoped when multiple sessions share the same
  `.pi/goals/` directory (e.g. an Obsidian vault). Set `autoSelectSingleGoal: true` in
  `.pi/pi-goal-x-settings.json` (or via `/goal-settings`) to restore the previous behavior
  where a single open goal is auto-focused when no focus entry exists. (PR #4)

### Fixed

- **Terminal scrollback preserved while goals are active:** Removed the private 1-second
  status-refresh timer that forced TUI redraws (`ui.setStatus` + widget update), which
  pulled users out of terminal scrollback while reviewing long goals. The widget still
  catches up on natural renders. (PR #5)

- **Completion auditor lost Cursor / extension-provider auth on pi 0.81+:** Nested
  `createAgentSession` for the independent auditor still passed `modelRegistry`, but pi
  0.81+ only accepts `modelRuntime`. Combined with the auditor's empty resource loader
  (no `pi-cursor-sdk`), that built a fresh runtime without the registered `cursor` provider
  and failed with `No API key found for cursor` even when `auth.json` had a Cursor API key.
  The auditor now reuses the parent session's ModelRuntime (via `modelRegistry.runtime`)
  while still passing `modelRegistry` for older SDKs. (PR #6)

- **Goal state no longer appended to the session on every persistence event:** Full goal
  snapshots were duplicated into the session JSONL on every update, which could bloat a
  multi-day session to hundreds of MB and exhaust the heap. Goal files under `.pi/goals/`
  remain authoritative; legacy snapshot reads are kept for migration. (PR #7)

- **`syncGoalTools()` deferred out of top-level extension load:** It now runs in
  `session_start`, eliminating the spurious "Extension runtime not initialized. Action
  methods cannot be called during extension loading" error logged on every session start.
  No behavior change — `before_agent_start` already re-syncs before every real turn. (PR #8)

## [0.19.0] — 2026-06-14

### Added

- **propose_goal_tweak: tasks parameter, inheritance, and box-drawn task display:**
  `propose_goal_tweak` now accepts an optional `tasks` parameter (same schema as
  `propose_goal_draft`). When omitted, the current goal's task list is inherited
  automatically. The confirmation dialog displays the task list in a box-drawn
  format (`┌─ TASKS ──┐`) matching `propose_goal_draft`. The drafting prompt
  surfaces the current task list and instructs the agent to edit inherited content
  directly rather than rewriting from scratch. Task validation (subtask depth)
  is applied. Tasks are persisted on the goal record when confirmed. (6 tests,
  390 total pass.)

### Refactored

- **DRY shared confirmation rendering:** Extracted `formatModeLabel`,
  `formatPrefixedLines`, `formatSection`, and `renderConfirmationTasks` helpers
  from the duplicated inline rendering in `buildDraftConfirmationText` and
  `buildTweakConfirmationText`. `goal.ts` now imports `renderConfirmationTasks`
  from `goal-draft.ts` instead of defining its own local copy. `buildDraftConfirmationText`
  shrank 44% (16→9 lines), `buildTweakConfirmationText` shrank 70% (56→17 lines).

## [0.18.10] — 2026-06-12

### Fixed

- **syncGoalTools deferred from top-level to session_start:** Removed the top-level
  `syncGoalTools()` call that fired during extension loading, before the runtime was
  initialized. This was the cause of the "Extension runtime not initialized. Action
  methods cannot be called during extension loading" error. `syncGoalTools()` is now
  called inside the `session_start` handler, after `loadState()`. Added an e2e test
  that verifies no `getActiveTools()` calls occur during extension registration and
  that the call only fires after `session_start`.

## [0.18.9] — 2026-06-10

### Fixed

- **turnSeq scoping for turnStoppedFor:** Added a per-turn generation counter so stale
  turn-stop markers from prior turns or session resumes cannot accidentally block an
  active goal's tool calls. A new `advanceTurnSeq()` function increments the counter at
  the start of each turn; `currentTurnStoppedGoalId()` returns the stopped goal only if
  its sequence matches the current turn.

- **Stale continuation checkpoint guards:** Added `checkpointGoalId` tracking and
  `isActionableContinuationGoal()` to prevent work tools from executing when a queued
  continuation fires for a goal that has been paused, cleared, or replaced. The
  `before_agent_start` handler now reconciles from disk and aborts the turn for stale
  checkpoints. The `tool_call` handler also blocks work tools mid-turn when a stale
  checkpoint is detected.

  These changes incorporate selected improvements from PR #1 by codewithkenzo.

## [0.18.8] — 2026-06-10

### Changed

- **README restructured for user-facing clarity:** Merged "What's different from upstream" and
  "What it provides" into a single 13-item headline Features section placed at the top of the
  document. The fork context is condensed to a one-paragraph note below Features. Stale
  `update_goal` references replaced with `complete_goal`. The rest of the document (Install,
  Quick start, Commands, etc.) is preserved unchanged.

## [0.18.7] — 2026-06-07

### Fixed

- **Lifecycle tools now reliably visible for active goals with task lists:** Two root
  causes were identified and fixed:

  1. **`turn_start` did not sync tools** — The `turn_start` handler reset per-turn flags
     but never called `syncGoalTools()`. Tools were only synced later in
     `before_agent_start`, creating a gap where the system prompt could be built with
     stale tools. Added `syncGoalTools()` to `turn_start`.

  2. **Non-progress research tools blocked lifecycle tools** — The `tool_call` handler
     set `turnStoppedFor` for any non-progress tool call (e.g., `web_search`,
     `code_search`, `fetch_content`). This blocked ALL subsequent tool calls including
     `complete_task` and `complete_goal`. The `goalWorkToolCalledThisTurn` flag already
     prevents infinite continuation chains; `turnStoppedFor` is only needed for
     post-stop commands (pause/abort/complete). Removed the problematic `else` branch.

### Added

- **4 new tests for lifecycle tool reliability:**
  - `active goal with task list exposes all lifecycle tools`
  - `active goal with task list shows correct tools across multiple turns`
  - `complete_task tool executes and stays active after marking tasks done`
  - `turn_start re-syncs active tools after external removal`

## [0.18.6] — 2026-06-05

### Fixed

- **Esc → "keep working on goal" now pauses the goal:** When the user presses Escape
  during a completion audit and selects "continue working," the goal is paused
  (status → "paused") instead of staying active. The agent stops and waits for the
  user to manually resume via `/goal-resume`, preventing confusing auto-continuation.
  `turnStoppedFor` is also set to block subsequent tool calls in the same turn.

- **Noisy audit-escape notifications removed:** The `ctx.ui.notify("Audit skipped by
  user.", "warning")` call in `abortAudit()` is removed. The "continue working"
  branch no longer sends a `pi.sendMessage()` with audit-skipped content or returns
  "Resume working toward the goal." — it returns a clean "Goal paused" message
  instead.

### Added

- **Tests for escape dialog wiring:** 3 new tests verify `complete_goal` has the
  `confirmBypassAuditor` parameter, the `tool_call` handler is registered, and the
  escape dialog handler paths are wired.

## [0.18.5] — 2026-06-02

### Fixed

- **`syncGoalTools` error during extension loading:** Removed `syncGoalTools()` call from
  `loadState()` (called by `session_start` and `session_tree` handlers) to prevent
  "Extension runtime not initialized" error when the runtime hasn't finished binding yet.
  The first tool sync now happens in `before_agent_start`, which fires after the runtime
  is fully initialized.

### Changed

- **Tests updated for new lifecycle flow:** Four tests in `goal-tool-visibility.test.ts`
  updated to invoke `before_agent_start` after `session_start`, matching the new lifecycle
  ordering where `session_start` loads state but does not sync tools.

## [0.18.4] — 2026-05-31

### Added

- **Task list overlay (`Ctrl+Shift+T`)** — a scrollable modal overlay showing all tasks for open goals, triggered by `Ctrl+Shift+T`. Includes status icons (✓ complete, ◌ pending, — skipped), tree branch lines for subtasks, scroll indicators (▴/▾), keyboard navigation (↑↓/jk/PgUp/PgDn/Home/End), and Esc/Enter to dismiss. All styling uses TUI theme colors. (`extensions/widgets/task-list-overlay.ts`)

- **Default to current goal, 'a' toggle** — the overlay now defaults to showing only the focused goal's tasks. Pressing `a` toggles between "current goal" and "all open goals" views. Footer shows context-sensitive hint ("show all" / "show current"). Scroll position resets on toggle. (`extensions/widgets/task-list-overlay.ts`)

- **Text wrapping for long titles** — `wrapTextWithAnsi` replaced truncation in the overlay. Task titles and goal headers wrap at word boundaries with continuation-line indentation. Goal status labels overflow to their own dim line when the title is long. (`extensions/widgets/task-list-overlay.ts`)

- **Lifecycle tool visibility tests** — comprehensive test suite in `tests/goal-tool-names.test.ts` (94 new tests) covering all status × phase combinations for goal lifecycle tools (pause, complete, abort, propose_goal_tweak, propose_task_list, complete_task, skip_task). `tests/goal-tool-visibility.test.ts` (391 new tests) covers lifecycle event-driven tool visibility.

### Fixed

- **`syncGoalTools` bare `try-catch`** — the catch block in `syncGoalTools` was silently swallowing errors from `getActiveTools()` and subsequent `addTool`/`removeTool` calls. Replaced with a logging catch and added a defensive `Array.isArray` guard on the `getActiveTools()` return value so type mismatches (e.g., `Map` instead of `string[]`) don't corrupt tool state.

- **e2e mock tool tracking** — `getActiveTools()` in the e2e mock was returning a `Map` instead of `string[]`, and `setActiveTools` was a no-op, preventing `syncGoalTools` from properly tracking lifecycle tool visibility. Fixed to return `string[]` and update internal state.

## [0.18.3] — 2026-05-30

### Fixed

- **`addWrappedPipe` overflow in questionnaire** — `addWrappedPipe` in `goal-questionnaire.ts` was wrapping content at the full terminal width then prepending `│   ` (4 visible chars) to continuation lines, causing a terminal-width overflow crash (visibleWidth > safeWidth). Fixed by wrapping at `safeWidth - pipeWidth` so continuation lines with the pipe prefix stay within bounds.

- **Escape dialog header overflow** — the header text `"Audit interrupted by Escape  (continue = default)"` (53 visible chars) was not truncated to `innerWidth` at narrow terminal widths, causing overflow. Fixed by adding `truncateToWidth()` to the header line.

### Added

- **Overflow regression tests** (`tests/overflow-regression.test.ts`) — 20 new tests covering the `addWrappedPipe` fix at every width 20-120, with styled ANSI content, CJK wide characters, mixed content, single long words, exact wrap boundaries, whitespace handling, minimum width, and the exact crash scenario reproduction. Also covers `truncateToWidth` safety net at every width 1-120, with ANSI codes, and CJK chars.

- **Escape dialog overflow regression tests** (`tests/goal-escape-dialog.test.ts`) — parameterized tests at widths 50/60/70/80/90/109 asserting no rendered line exceeds the terminal width.

- **Widget overflow regression tests** (`tests/goal-widget.test.ts`) — parameterized widget safety net tests at widths 50/70/100/109/120, auditor progress crash regression, and unfocused widget with 38 open goals at width 109.

## [0.18.2] — 2026-05-29

### Changed

- **Co-proposal prompt guidance** — the drafting protocol in `goal-draft.ts` and the continuation prompt in `goal-prompts.ts` now instruct agents to include the task list in the `tasks` parameter of `propose_goal_draft` when the objective decomposes into milestones. The old guidance encouraging `propose_task_list` after goal confirmation has been removed.

## [0.18.1] — 2026-05-29

### Fixed

- **TUI crash guard** — pi-tui differential render no longer throws a fatal error when a line's visible width exceeds terminal width. Both the incremental render path and the full-redraw path now truncate overflowing lines with `truncateToWidth()` instead of crashing.
- **Widget safety net** — `GoalWidgetComponent.render()` post-processes every line and truncates any that exceeds the render width, defending against widget edge cases that could bypass per-line truncation.

### Added

- **Regression test** — `goal-widget.test.ts`: "GoalWidgetComponent safety net truncates any line exceeding width" asserts that rendering at width 50 with extreme-length content produces no line with `visibleWidth > 50`.

## [0.18.0] — 2026-05-29

### Added

- **Hidden TUI debug mode** — Ctrl+Shift+X toggles a debug panel in the goal widget with raw goal field display, task tree summary, and legend. Ctrl+Shift+N creates/removes a test goal (writes to `.pi/goals/debug/`), Ctrl+Shift+T injects sample tasks, Ctrl+Shift+R starts a mock completion audit, and Ctrl+Shift+O opens the proposal confirmation dialog with a realistic proposal built from typed `GoalTask[]` objects through the real rendering pipeline.
- **`addWrappedPipe` helper** — pipe-prefixed (`│   `) lines that wrap now prepend `│   ` to every continuation line so wrapped text stays inside the ASCII box.
- **Task checkbox detection inside pipe sections** — `│   [x] t1: ...` lines are now properly detected as task checkboxes (not misinterpreted as key-value pairs) and render with per-status coloring inside the box.

### Changed

- **MAX_CONTEXT_LINES removal** — the 12-line truncation cap (`MAX_CONTEXT_LINES = 12`) is removed from `goal-questionnaire.ts`. The full proposal is now visible without truncation. Replaced `addContextWrapped` with `renderContextLines` that renders every line with per-line styling.
- **Enriched confirmation dialog** — `buildDraftConfirmationText` and `buildTweakConfirmationText` now emit `─── Section Name ───` markers that `renderContextLines` converts to full-width box-drawing borders (`┌─ Section Name padding─┐`). Task checkbox items get per-status coloring (`[x]` success green, `[ ]` warning yellow) with item titles in muted. Goal structure lines (`=== Goal ===`, `Objective:`, `Success criteria:`, `Boundaries:`, `Constraints:`, `Verification contract:`, `If blocked:`) are detected and styled as accent.
- **Pipe prefix for all objective content** — `buildDraftConfirmationText` and `buildTweakConfirmationText` now prefix every objective line with `│   ` (except lines already starting with `│`). Task checkbox lines and box-drawing borders inside the objective text now appear inside the ASCII box with consistent indentation.
- **Debug proposal task lines** — `renderDebugTaskLines` output in the debug Ctrl+Shift+O dialog is now prefixed with `│   ` to match the box layout.

## [0.17.0] — 2026-05-29

### Added

- **`auditorEnabled` in questionnaire results** — `runGoalQuestionnaire` accepts an optional `auditorToggleInit` parameter and returns `auditorEnabled` in the result object. The confirmation dialog shows an "Auditor enabled/disabled" toggle indicator.
- **Per-goal `skipAuditor` field** — users can toggle the auditor off or on during goal confirmation. The choice is persisted on the goal record as `skipAuditor: true/false`. `complete_goal` skips the audit when `skipAuditor` is true on the target goal.
- **`isAuditorEnabledByDefault`** — new helper in `goal-settings.ts` that returns `true` unless `disabled: true` in the settings file or the `PI_GOAL_SETTINGS_FILE` env var.
- **Recursive duplicate task ID detection** — `checkDuplicateTaskIds` recursively validates all task IDs across the entire tree, preventing collisions between parent/subtask or sibling subtasks. Added to `validateTaskListProposal`.

### Changed

- **Task section appears first in draft context** — when both a goal objective and task list are proposed together, the task summary section appears FIRST in the context so it stays visible even when dialog context was previously capped.
- **`findTaskInTree` for task operations** — `validateTaskCompletion` and `validateTaskSkip` now use `findTaskInTree` instead of flat array lookup, enabling subtask tree operations.
- **Allow re-skipping already-skipped tasks** — `validateTaskSkip` no longer rejects already-skipped tasks, enabling toggle behavior.
- **Prompt wording cleanup** — `complete_goal` prompt guidance trimmed to remove redundant phrasing.
- **`complete_goal` status default** — `status=complete` is now the default when `status` parameter is omitted.
- **Audit flow with per-goal toggle** — when `skipAuditor` is true on a goal, the audit is skipped during `complete_goal` and a ledger event `audit_skipped` is appended.

### Fixed

- **Dialog failure fallback** — `showProposalDialog` catches errors in interactive mode and notifies the user; creation fails closed and never auto-creates a goal on dialog failure.

## [0.16.1] — 2026-05-28

### Added

- **Escape-to-skip audit** — pressing Escape during an auditor run now aborts it and completes the goal immediately. The skip is recorded in the ledger with the reason `user_aborted` and auditor model metadata.
- **Audit progress widget** — the TUI shows a spinner, progress bar, step labels, current tool, and output lines while the auditor runs.
- **Audit abort detection** — the auditor detects aborts from both exceptions and `session.prompt()` returning after an abort signal, preventing stuck goals or ghost states.
- **COMPLETED status for Sisyphus** — completed Sisyphus goals now show a `COMPLETED` status label instead of a generic complete indicator.
- **Multi-session focus isolation** — goal focus data uses `goalFocusDetails` which includes the goal id and reason but not full balance data, preventing cross-session focus leakage.

### Fixed

- Fixed a merge bug where `propose_task_list` could produce a duplicate task list when called during a continuation.

## [0.16.0] — 2026-05-28

### Added

- **TUI Escape dialog during audit** — pressing Escape during a completion audit now shows a TUI confirmation dialog with two options: "Mark complete without audit" (bypasses auditor, marks goal complete immediately, agent receives structured message) and "Continue working" (skips audit, agent resumes). Replaces the old agent-mediated "Use goal_question" pattern.
- **`showEscapeDialog()` widget** — new `extensions/widgets/goal-escape-dialog.ts` with headless fallback.

### Changed

- **Goal prompt updated** — no longer instructs the agent to handle Escape via goal_question; describes the automatic TUI dialog instead.

## [0.15.1] — 2026-05-28

### Fixed

- **Error messages referencing old file** — four user-facing messages in goal.ts no longer mention `.pi/goal-settings.json` (now say "settings").
- **README stale reference** — feature bullet now points at `.pi/pi-goal-x-settings.json`.
- **Cleaned up orphaned file** — removed stale `.pi/goal-auditor.json` from disk.

## [0.15.0] — 2026-05-28

### Changed

- **Unified settings file** — all settings now live in a single `.pi/pi-goal-x-settings.json` file instead of two separate files. The unified file includes `disableTasks`, `disableContracts`, `subtaskDepth`, `provider`, `model`, `thinkingLevel`, and `disabled`. Clean break: old `.pi/goal-settings.json` and `.pi/goal-auditor.json` files are no longer read. Users must manually merge into the new file.
- **`loadGoalSettings` replaces `loadGoalAuditorConfig`** — the auditor now reads its config (provider, model, thinkingLevel, disabled) from the unified settings file via `loadGoalSettings()`. Old individual `loadGoalAuditorConfig`, `loadGoalAuditorFileConfig`, `saveGoalAuditorFileConfig`, `parseGoalAuditorConfig`, and `goalAuditorConfigPath()` functions removed from `goal-auditor.ts`.
- **Auditor env vars removed** — `PI_GOAL_AUDITOR_PROVIDER`, `PI_GOAL_AUDITOR_MODEL`, and `PI_GOAL_AUDITOR_THINKING_LEVEL` removed. Replaced with single `PI_GOAL_SETTINGS_FILE` env var that points at an alternative settings file path (relative to cwd or absolute). `PI_GOAL_DISABLE_TASKS` and `PI_GOAL_DISABLE_CONTRACTS` remain unchanged.
- **`/goal-settings` TUI updated** — now shows all settings in one list (disabled, provider, model, thinking_level, subtaskDepth, disableTasks, disableContracts) instead of a separate auditor-only sub-menu.

## [0.14.0] — 2026-05-28

### Added

- **Unified goal + task acceptance** — `propose_goal_draft` accepts an optional `tasks` array parameter (full task list structure). The confirmation dialog shows the goal objective AND proposed task list together in a single rich TUI view with box-drawing panel (`┌─ TASKS ───┐`), section headers, and hierarchical indentation for subtasks. One confirmation (single enter press) creates both the goal and its task list atomically. Backward compatible: existing `propose_task_list` flow unchanged.
- **Recursive sub-task system** — `GoalTask` type gains optional `subtasks?: GoalTask[]` (recursive — sub-tasks are full task records with id, title, status, evidence, completedAt, verificationContract, and their own subtasks). `GoalSettings` gains `subtaskDepth?: number` field (default 1) in `.pi/goal-settings.json`. Depth validation/policy in `goal-policy.ts` enforces the limit at all proposal points. `lightweightSubtasks?: boolean` flag allows parent completion without child enforcement.
- **Depth-validated proposal flow** — subtask depth is validated BEFORE showing the confirmation dialog (moves pre-dialog to match `propose_task_list` behavior). `findSubtaskDepthViolation` and `validateTaskListProposal` used in both `propose_goal_draft` and `propose_task_list`.
- **Subtask enforcement on complete/skip** — `complete_task` rejects when a task has pending full subtasks (`checkSubtasksComplete`). `skip_task` cascades skip to all child subtasks (`skipAllSubtasks`). Both use `findTaskInTree`/`updateTaskInTree` helpers.
- **Hierarchical task display** — `taskListBlock` in prompts renders subtask trees with indentation via `renderTaskTree`. `buildTaskSummary`/`taskSummaryBlock` recursive. Widget (`goal-widget.ts`) counts subtasks recursively in `countFlatTasks` and finds next pending task via BFS `findFirstPending`.
- **Scroll fix for proposal dialogs** — `runGoalQuestionnaire` suppresses hardware cursor during dialog (`setShowHardwareCursor(false)`) to reduce ~60fps ANSI cursor-positioning writes that fight manual scrolling. Cursor restored on dialog close. Affects `propose_goal_draft`, `propose_task_list`, and all goal questionnaire dialogs.
- **E2E test coverage** — unified acceptance flow (goal creation + task list + subtasks + verification contract, disk round-trip verified) and scroll fix (headless dialog path exercises cursor operations).
- **Subtask normalization/roundtrip** — `normalizeTaskList`, `normalizeTaskItem`, and `cloneGoal` handle recursive subtask structures.
- **Subtask depth edge cases** — tests for depth below 1, non-integer, negative, and missing config file defaults.

### Changed

- **`subtaskDepth` default is 1** — one level of nesting (tasks → subtasks). Set via `.pi/goal-settings.json`. No config file means default 1.

## [0.13.0] — 2026-05-28

### Added

- **Verification contract system** — goals and individual tasks can now define a `Verification contract:` section specifying what verification evidence is required before completion, enforced at both the prompt and tool level. Key properties:
  - **`Verification contract:` section** — when drafting a goal (via `propose_goal_draft` or `/goals-set`/`/sisyphus-set`), include a `Verification contract: <description>` section in the objective. The contract is extracted, stored on the goal record, and stripped from the visible objective text.
  - **`complete_goal` `verificationSummary`** — the old optional `testResults` parameter is replaced with a required `verificationSummary` (plain text). If the goal has a contract, the call is rejected unless `verificationSummary` is non-empty.
  - **Per-task contracts** — `propose_task_list` supports an optional `verificationContract` per task. `complete_task` gains an optional `verificationSummary` parameter; if the task has a contract, the summary is required.
  - **Prompt hardening** — `goalPrompt` and `continuationPrompt` include a VERIFICATION CONTRACT section instructing the agent to provide evidence against every contract item before calling `complete_goal`/`complete_task`.
  - **Auditor integration** — the auditor receives both the `verificationContract` and `verificationSummary` and cross-checks the agent's claims against real artifacts.
  - **Backward compatible** — goals/tasks without a `Verification contract:` section work exactly as before.

### Changed

- **`complete_goal` `testResults` removed** — fully replaced by `verificationSummary`. The deprecated `AuditorTestResults` interface is deleted; `AuditorVerificationEvidence` is the only interface used.
- **`buildGoalAuditorPrompt`** — now accepts `verificationSummary` instead of `testResults`; renders `<verification_summary>` and `<verification_contract>` blocks instead of `<test_evidence>`.

## [0.12.0] — 2026-05-27

### Added

- **Task list system** — goals can now include a structured task list with `propose_task_list`, `complete_task`, and `skip_task` tools. Key properties:
  - **`propose_task_list`** — agent proposes a task list to the user via a Confirm / Continue Chatting dialog (mirrors `propose_goal_draft` pattern). Stops the turn. Merges with existing tasks, preserving statuses of matching IDs.
  - **`complete_task`** — marks a task complete with optional evidence (≤200 chars). Does **not** stop the turn, allowing the agent to continue work.
  - **`skip_task`** — marks a task skipped with a required reason. Does **not** stop the turn.
  - **`complete_goal` task gate** — when `blockCompletion: true` and pending tasks exist, `complete_goal` surfaces a soft guard warning rather than blocking outright. The gate is prompt-level only; the agent can still complete.
  - **Ledger events** — `task_list_set`, `task_complete`, `task_skipped` events recorded for full traceability.
  - **Serialization** — tasks persisted as `## Tasks` markdown section in goal files with `[x]`/`[ ]`/`[~]` markers, evidence, skip reasons, and `blockCompletion` comment.
  - **Prompt injection** — `taskListBlock` renders the active task list in both `goalPrompt` and `continuationPrompt`, including the TASK GATE warning when `blockCompletion` is enabled and pending tasks exist.
  - **Widget display** — heading shows `N/M tasks`; body shows the next pending task or `All tasks complete`.
  - **Auditor integration** — task summary block included in auditor prompt's `<goal_details>`.
  - **Optional** — goals without a `taskList` work exactly as before.

### Changed

- **`update_goal` renamed to `complete_goal`** — the completion tool is now named `complete_goal` to make its sole purpose unambiguous (marking the goal complete). The old name `update_goal` sounded generic and tempted agents to call it when work was unfinished. Prompt guidelines on the renamed tool were tightened: added "Do NOT call complete_goal if any work remains, even if substantial progress was made." All internal references, tests, prompts, and documentation updated.

## [0.11.0] — 2026-05-27

### Removed

- **`apply_goal_tweak` fully removed** — replaced with `propose_goal_tweak`, a confirmation-dialog tool that mirrors `propose_goal_draft` exactly. The old `apply_goal_tweak` (which applied tweaks inline without user confirmation) is deleted entirely from source: constant, registration, imports, handler, and all references. The `/goal-tweak` flow now shows a Confirm / Continue Chatting dialog before applying the revision.

### Added

- **`propose_goal_tweak` tool** — registered alongside `propose_goal_draft`, available exclusively during `/goal-tweak` drafting. Uses `showProposalDialog()` and `buildTweakConfirmationText()` to present the current objective, change summary, and proposed new objective. On Confirm: writes the new objective, clears drafting state, terminates the turn. On Continue Chatting: keeps drafting active for further refinement.
- **Comprehensive test coverage** — 13 new tests across three layers:
  - Unit: `buildTweakConfirmationText` renders normal/sisyphus modes and edge cases (3 tests).
  - Integration: tool registration, schema validation, rejection gates (no goal set, no `/goal-tweak` flow), prompt guidelines, renderCall/renderResult (11 tests).
  - E2E: real `pi --fork --mode json` test verifying `propose_goal_tweak` is rejected without an active `/goal-tweak` drafting flow (1 test).
  - Total test count: 143 tests (up from 131), all passing, TypeScript zero errors.

### Changed

- **`/goal-tweak` notification** now says "started a `/goal-tweak` flow on `{objective}` — I'll draft the change and propose the revision for you to Confirm." reflecting the new confirmation pattern.
- **`syncGoalTools()` and `fullGoalToolVisibility()`** — `propose_goal_tweak` shown during tweak drafting, hidden otherwise. Removed dead `draftingHiddenWorkTools` constant referencing `TWEAK_APPLY_TOOL_NAME`.
- **`goalTweakDraftingPrompt`** guides the agent to use `propose_goal_tweak` with confirmation dialog.
- **Test assertions updated** in `goal-tool-names.test.ts`, `goal-draft.test.ts`, `goal-update-objective.test.ts`, `goal-prompts.test.ts` — all references to `apply_goal_tweak` / `TWEAK_APPLY_TOOL_NAME` replaced with `propose_goal_tweak` / `PROPOSE_TWEAK_TOOL_NAME`.

---

## [0.10.2] — 2026-05-26

### Removed

- **`updatedObjective` from `update_goal`** — the goal objective can no longer be changed through `update_goal`. The parameter is removed from the schema, `additionalProperties: false` enforces strict rejection of unknown params, and the Phase 1 handler block that processed it is deleted. Objective changes now go exclusively through `apply_goal_tweak`, gated behind user-initiated `/goal-tweak`.

### Changed

- **`update_goal` error message** — simplified to: `"update_goal requires status=complete when marking a goal complete."` (no more branching on `updatedObjective` vs `status`).
- **Prompt guidelines** — `update_goal` prompt, `goalPrompt()`, and `continuationPrompt()` now state the goal objective is **immutable** and instruct the agent to ask the user to run `/goal-tweak` to revise it.
- **Test coverage** — old quick-sync/combined e2e tests replaced with schema-rejection and completion-only mock-pi tests. 2 new source-inspection unit tests verify `additionalProperties: false` and absence of `updatedObjective`.
- **Docs** — `README.md` rewritten ("Goal objective is immutable" section). Agent and chain docs (`e2e-test-runner.md`, `e2e-test.chain.md`) cleaned up.

---

## [0.10.1] — 2026-05-26

### Added

- **`testResults` attestation** — the executor can pass structured test evidence (`exitCode`, `suiteName`, `output`, `timestamp`) via `update_goal({testResults})`. The auditor receives it as a `<test_evidence>` block and is instructed to check it before re-running test suites, skipping redundant re-runs.
- **Full test coverage for `testResults`** — 6 unit tests covering rendering of full/minimal/null evidence blocks, multi-line output indentation, non-passing exit codes, and the checklist instruction to check evidence before re-running. 1 integration test verifying the handler accepts `testResults` without error.

### Changed

- **`buildGoalAuditorPrompt` checklist renumbering** — when `testResults` is provided, the checklist has 5 items (with step 3 about checking test evidence). Without it, the checklist has 4 items (no evidence step), ensuring step numbers always align.

---

## [0.10.0] — 2026-05-26

### Added

- **Auditor progress visibility** — the auditor agent now has a `report_auditor_progress` tool to report its current step label (e.g. "Inspecting files...") and completion percentage at natural phase boundaries. The prompt instructs the model to use it at starting → inspecting → verifying → evaluating → reporting phases.
- **Progress bar widget** — when the auditor reports progress, the TUI widget renders a progress bar (`[████░░░░] 40%`) alongside the step label, giving the user a clear visual sense of completion.
- **Thinking phase awareness** — silent thinking phases (model reasoning without tool calls) are now detected via `thinking_start`/`thinking_end` stream events. The widget shows a distinct `⟡ thinking...` label with elapsed time and hides the Esc-to-skip hint during thinking.
- **`AuditorProgress` / `AuditorWidgetProgress` types** — extended with optional `label` and `percentage` fields for the progress tool and widget.
- **Widget tests for progress bar** — 5 new tests covering progress bar rendering at 0%/40%/100%, thinking phase display, step labels, undefined-percentage fallback, and narrow-width boundaries.

### Changed

- **`runGoalCompletionAuditor`** now passes the `report_auditor_progress` tool via `customTools` to the auditor agent session. Initial progress ("Starting audit..." / 0%) is emitted before the session starts. The `buildGoalAuditorPrompt` includes a "Progress reporting:" section with usage examples.
- **`renderAuditorWidgetLines`** — enhanced to display step label, progress bar, and thinking-phase icon/label. All existing display elements (spinner, tool name, output lines, Esc-to-skip) are preserved.

---

## [0.9.0] — 2026-05-26

### Added

- **`update_goal({updatedObjective})`** — the agent can now sync the goal objective mid-flight when user requirements change, without completing the goal. The `status` parameter is now optional, allowing a pure objective-update call. This ensures the completion auditor evaluates against the latest requirements.
- **`validateGoalUpdate()`** extracted to `goal-policy.ts` — validates that the target goal is active/paused (rejects null or already-complete goals with specific messages). Used by the handler and testable independently.
- **Comprehensive e2e test suite**: 131 tests covering function-level integration (12 tests, 9-scenario matrix + 3 edge-case gates), mock-pi handler tests (4), file-validity/chain checks (6), and real `pi --fork --mode json` fork tests (3 scenarios).
- **Deterministic fork tests**: the `--mode json` fork test uses `--append-system-prompt` + `--tools get_goal,update_goal` to force the AI model to always call the required tools. Validates `tool_execution_start`/`tool_execution_end` JSON events with field-level assertions — no free-text AI output parsing.

### Changed

- **Goal archival deferred until after agent turn completes**: `update_goal` marks the goal complete in-memory and writes an active file (not archived). The `turn_end` lifecycle hook detects completed goals and archives them — after the agent has received the audit/skip result. Previously archival happened inline within the tool handler, before the agent could see the result.
- **`buildCompletionReport` supports `auditSkippedReason`**: skip notifications (disabled auditor, Esc abort) are now included in the tool output text.
- **`accountProgress` guard**: skips `reconcileFocusedGoalFromDisk` for completed goals, preventing lifecycle conflicts.

### Fixed

- **Combined path correct ordering**: when `updatedObjective` + `status: "complete"` are passed together, the objective update is applied first, then the normal completion+audit flow runs against the updated objective.
- **Completion gate timing**: `turnStoppedFor` and `terminate: true` are no longer set for pure objective-sync calls — only for actual completions.

---

## [0.8.2] — 2026-05-26

### Fixed

- **Goal archival deferred until after agent turn completes**: previously, `update_goal` archived the goal file inline within the tool handler before the agent could see the audit result (or skip notification). Now the goal is marked complete in-memory and written as an active file (not archived) during `update_goal`, and archival happens at `turn_end` — after the agent has received the audit/skip result.

### Added

- **`buildCompletionReport` supports `auditSkippedReason`**: skip notifications (disabled auditor, Esc abort) are now included in the tool output text, ensuring the agent sees why the audit was skipped before the goal is archived.
- **Tests**: verify `writeActiveGoalFile` no longer auto-archives for complete status (deferred archival), and `buildCompletionReport` correctly handles `auditSkippedReason` with precedence over `auditorReport`.

---

## [0.8.1] — 2026-05-19

### Changed

- **Audit log messages clarified**: `extensions/goal.ts` — disabled/aborted audit messages now read naturally as goal completion notices ("Goal completed — auditor disabled in settings." / "Goal completed — auditor bypassed (user pressed Escape during audit).").

---

## [0.8.0] — 2026-05-17

### Added

- **C19 iteration-frustration benchmark**: new spec under `specs/` exercising the proposal-refinement cycle with repeated rejection scenarios.
- Spec metadata files: `PRODUCT.md`, `TECH.md`, `MILESTONES.md` for the C19 benchmark.

### Changed

- **Normalized proposal-refinement cycle language**: `extensions/goal-draft.ts`, `extensions/goal-questionnaire.ts`, and `extensions/goal.ts` — consistent terminology across the drafting/refinement pipeline.
- Updated test assertions (`tests/goal-draft.test.ts`) to match the new language.

---

## [0.7.2] — 2026-05-17

### Added

- Gallery image metadata and placeholder screenshot for `pi.dev/packages`.

---

## [0.7.1] — 2026-05-17

### Fixed

- Version metadata in package manifest after 0.7.0 release commit.

---

## [0.7.0] — 2026-05-17

### Added

- **Goal auditor lifecycle** (`feat(auditor)`):
  - `disabled` config flag to turn off auditing entirely.
  - Real-time progress callbacks during audit execution.
  - `audit_skipped` event type recorded in the ledger with reason + auditor metadata.
- **Auditor progress widget**: live spinner, tool tracking, and skip hint in the TUI.
- **Auditor integration**:
  - Escape-key handling during audit (skip with Esc, prevents cascading goal pause).
  - `createSession` factory wiring `AbortSignal` to `session.abort()`.
  - Audit abort detection (both thrown and non-thrown `session.prompt` aborts).
  - Goal completes on audit abort instead of leaving an open state.

### Fixed

- Audit cancellation loop: `confirmBypassAuditor` param respected, skip-once with `triggerTurn` mirroring disabled-bypass path.
- Corrected Esc-to-skip widget message to reflect actual behavior.

### Tests

- Unit tests for disabled config, `audit_skipped` events, and widget skip hint.
- Abort-scenario tests for `runGoalCompletionAuditor`.
- Post-prompt abort detection test.
- Goal policy test validating completion report includes full auditor output.

---

## [0.6.0] — 2026-05-12

### Added

- **Split goal intent and direct set commands**: `/goals-set` / `/sisyphus-set` — create and start a goal immediately from the supplied objective, skipping the discussion flow.

### Changed

- `specs/` directory excluded from npm package.

---

## [0.5.0] — 2026-05-12

### Removed

- Token budget system removed from the drafting runtime.
- **Simplified drafting runtime**: removed token-budget tracking and associated complexity.

---

## [0.4.1] — 2026-05-12

### Added

- **Visible audit dialogue**: the completion auditor now prints its dialogue into the conversation, giving full visibility into the audit reasoning.

---

## [0.4.0] — 2026-05-12

### Changed

- Goal runtime updates — internal refactoring and lifecycle improvements.

---

## [0.3.1] — 2026-05-12

### Added

- **Independent goal completion auditor**: standalone audit step that reviews goal completion before finalizing.

---

## [0.3.0] — 2026-05-12

### Fixed

- **Oracle goal lifecycle audit fixes**: corrected audit lifecycle handling in Oracle-based goal execution.

---

## [0.2.7] — 2026-05-12

### Added

- **Goal abort lifecycle**: proper abort handling for in-progress goals.

---

## [0.2.6] — 2026-05-12

### Changed

- Split goal internals — refactored monolithic goal module into focused sub-modules.

---

## [0.2.5] — 2026-05-12

### Added

- Full `/sisyphus` command now required (no short-form aliases that could cause ambiguity).

---

## [0.2.4] — 2026-05-12

### Changed

- Grouped goal widgets — reorganized widget components for maintainability.

---

## [0.2.3] — 2026-05-12

### Changed

- Simplified Sisyphus goal flow — streamlined the Sisyphus execution loop.

---

## [0.2.2] — 2026-05-12

### Fixed

- Simplified goal widget header — removed redundant status information from the widget display.

---

## [0.2.1] — 2026-05-12

### Added

- **Goal widget component**: initial TUI widget showing goal status in the editor.

---

## [0.2.0] — 2026-05-12

### Added

- **Componentized goal drafting UX**: `/goals` and `/sisyphus` drafting flow extracted into reusable components.

---

## [0.1.2] — 2026-05-11

### Fixed

- Built-in question tools now correctly prefixed to avoid naming collisions.

---

## [0.1.1] — 2026-05-11

### Added

- **Built-in goal questionnaire drafting UI**: interactive questionnaire for goal refinement before confirmation.

---

## [0.1.0] — 2026-05-11

### Added

- Initial release of pi-goal-x (fork of `@capyup/pi-goal`).
- Core goal lifecycle: draft, confirm, execute, pause, resume, complete.
- Two goal styles: regular goals and Sisyphus ordered-execution goals.
- Intent-before-run flow (`/goals`, `/sisyphus`).
- `propose_goal_draft` confirmation gate.
- Auto-continue loop with empty-turn guard.
- Schema-gated lifecycle transitions.
- Multiple open goals with session-local focus.
- Goal status overlay widget.
- MIT license.

<!-- Version links for navigation -->

[0.18.4]: https://github.com/tmonk/pi-goal-x/releases/tag/v0.18.4
[0.18.3]: https://github.com/tmonk/pi-goal-x/releases/tag/v0.18.3
[0.16.0]: https://github.com/tmonk/pi-goal-x/releases/tag/v0.16.0
[0.15.1]: https://github.com/tmonk/pi-goal-x/releases/tag/v0.15.1
[0.15.0]: https://github.com/tmonk/pi-goal-x/releases/tag/v0.15.0
[0.14.0]: https://github.com/tmonk/pi-goal-x/releases/tag/v0.14.0
[0.13.0]: https://github.com/tmonk/pi-goal-x/releases/tag/v0.13.0
[0.12.0]: https://github.com/tmonk/pi-goal-x/releases/tag/v0.12.0
[0.11.0]: https://github.com/tmonk/pi-goal-x/releases/tag/v0.11.0
[0.10.2]: https://github.com/tmonk/pi-goal-x/releases/tag/v0.10.2
[0.10.1]: https://github.com/tmonk/pi-goal-x/releases/tag/v0.10.1
[0.10.0]: https://github.com/tmonk/pi-goal-x/releases/tag/v0.10.0
[0.9.0]: https://github.com/tmonk/pi-goal-x/releases/tag/v0.9.0
[0.8.1]: https://github.com/tmonk/pi-goal-x/releases/tag/v0.8.1
[0.8.0]: https://github.com/tmonk/pi-goal-x/releases/tag/v0.8.0
[0.7.2]: https://github.com/tmonk/pi-goal-x/releases/tag/v0.7.2
[0.7.1]: https://github.com/tmonk/pi-goal-x/releases/tag/v0.7.1
[0.7.0]: https://github.com/tmonk/pi-goal-x/releases/tag/v0.7.0
[0.6.0]: https://github.com/tmonk/pi-goal-x/releases/tag/v0.6.0
[0.5.0]: https://github.com/tmonk/pi-goal-x/releases/tag/v0.5.0
[0.4.1]: https://github.com/tmonk/pi-goal-x/releases/tag/v0.4.1
[0.4.0]: https://github.com/tmonk/pi-goal-x/releases/tag/v0.4.0
[0.3.1]: https://github.com/tmonk/pi-goal-x/releases/tag/v0.3.1
[0.3.0]: https://github.com/tmonk/pi-goal-x/releases/tag/v0.3.0
[0.2.7]: https://github.com/tmonk/pi-goal-x/releases/tag/v0.2.7
[0.2.6]: https://github.com/tmonk/pi-goal-x/releases/tag/v0.2.6
[0.2.5]: https://github.com/tmonk/pi-goal-x/releases/tag/v0.2.5
[0.2.4]: https://github.com/tmonk/pi-goal-x/releases/tag/v0.2.4
[0.2.3]: https://github.com/tmonk/pi-goal-x/releases/tag/v0.2.3
[0.2.2]: https://github.com/tmonk/pi-goal-x/releases/tag/v0.2.2
[0.2.1]: https://github.com/tmonk/pi-goal-x/releases/tag/v0.2.1
[0.2.0]: https://github.com/tmonk/pi-goal-x/releases/tag/v0.2.0
[0.1.2]: https://github.com/tmonk/pi-goal-x/releases/tag/v0.1.2
[0.1.1]: https://github.com/tmonk/pi-goal-x/releases/tag/v0.1.1
[0.1.0]: https://github.com/tmonk/pi-goal-x/releases/tag/v0.1.0
