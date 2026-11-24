## 2026-11-24, third pass

- Plan written (TECH.md). Work split into separate PRs.

### Test hosts

- Moved the hand-rolled fake hosts in `goal-network-recovery`, `goal-stale-continuation-golden`, `goal-modal-escape`, `integration/extension` and `e2e/goal-lifecycle-dashboard` onto `tests/support/extension-harness.ts`. Assertions and test counts are unchanged (1258 before and after).
- The harness gained `terminalInput()` (the recorded `onTerminalInput` handler) and a `setWorkingVisible` stub. Callers that add helpers use `Object.assign(h, ...)`, not a spread, which would freeze the harness getters.
- Left as they were: `e2e/network-recovery-rpc.test.ts` and `e2e/run.ts` spawn the real `pi` process and build no host.
- Second pass: `goal-controls`, `goal-scheduler`, `goal-surface-baseline` and `goal-tool-visibility` now run on `createExtensionHarness`. The harness is split into `createFakeHost` (fake pi and ctx plus recorders) and the extension on top. `goal-progress-features` builds only a `GoalCore`, so it uses `createFakeHost` directly with `createGoalCore`. The host gained `createContext(overrides)` for tests that switch session or cwd, and `toolNames`/`commandNames`, which keep duplicate registrations that the `tools`/`commands` maps hide. All 1258 tests are kept.
- `goal-session-safety` keeps its own objects on purpose: it hands the code under test throwing getters, a Proxy pi and a partial core, which a full fake host would hide.

## Settings split

- `extensions/goal-settings.ts` (954 lines) is replaced by `extensions/settings/`: `schema.ts` (types, keybinding defaults, layer parser), `files.ts` (paths, layer reads, file cache), `resolve.ts` (layered snapshot, env overrides, report) and `mutate.ts` (path lock, atomic write). Imports run schema <- files <- resolve <- mutate, with no cycles.
- Only `extensions/goal.ts` is the package entry point, so no re-export shim was kept; all importers in extensions, tests and bench scripts point at the new modules.
- `invalidateGoalSettingsCache` now clears only the file cache. The resolved-snapshot cache is keyed on layer object identity, so fresh reads can never hit a stale entry.
- Parser cases for keybindings, oracle and networkRecovery became helper functions. Behavior and error messages are unchanged.
- `experiments/continuation/*` still names `goal-settings.ts`: it works on frozen `git archive` copies of old commits, so it was left alone.
- Validation: check, lint and all unit tests pass (1258 tests, 5 skipped, same as before).

## createGoalCore split

- `goal-state.ts` went from 1,039 to about 360 lines. The 60-member closure is
  now `GoalSessionState` (plain state) plus `GoalView`, `GoalFocus`,
  `GoalLifecycle`, `GoalProgress` and `GoalWatch`. `GoalCore` keeps its shape,
  so callers did not change.
- Three source-reading tests (mutation boundary, status timer, session state
  growth) now read the module that holds the code they check.
- 1,258 tests, 0 failures.

## Module cleanup

- `goal-questionnaire.ts` went from 1,066 to 839 lines. The dialog line-fitting helpers (`computeDialogLineLimit`, `fitDialogLines`, proposal segment scan) moved to the new `goal-dialog-fit.ts` (226 lines); two test files import them from there.
- Removed spec-section references (`§8.1`, `§16.6`, ...) from comments in service, events, commands and task-tools, and dropped a doc comment that sat above the wrong function.
- Removed an unused `ctx` parameter in `goal-ledger.ts` and one repeated session-file cast in `goal-commands.ts`.
- No exports were unused in the seven modules. `runGoalQuestionnaire` is still one long UI closure; splitting it is not clearly safer, so it was left.
- Validation: check, lint and all unit tests pass (1,253 tests, 5 skipped in this run).

## Questionnaire split

- `runGoalQuestionnaire` (about 650 lines of closure) is now thin wiring in `extensions/goal-questionnaire.ts` (248 lines, down from 839). The public exports stay there, so no importer changed; the answer and result types are re-exported from it.
- New `extensions/questionnaire/`: `types.ts` (question/answer/result types), `state.ts` (plain state plus the functions that change it: tabs, selection, scroll, answers, drafts), `keys.ts` (key handling over the state, with an `EditorPort` for the embedded editor), `render.ts` (layout and height fitting), `context.ts` (styling of a question's context block) and `basic-dialogs.ts` (the one-dialog-per-question fallback). `fitOptionsInFrame` moved into `goal-dialog-fit.ts` beside the other fitting helpers.
- Render layout values (`optionsStartIndex`, `optionRanges`, `questionBlockEnd`) live in a `RenderLayout` that is kept between renders, because the old closure variables were never reset either and tabs without options relied on the stale values.
- `tests/questionnaire-state.test.ts` adds 12 tests for the state functions, which run without a terminal. Existing tests are unchanged.
- Validation: check, lint and all unit tests pass (1,270 tests, 5 skipped).

## Simplification pass

Behavior is unchanged: tool schemas, prompt text, error messages, ledger and goal file formats and cache keys are the same, and no tests were added or removed (1,258 tests before rebasing onto the questionnaire split, 1,270 after; 5 skipped, 0 failures). One commit per module.

- `goal-ledger.ts` 992 -> 695 lines. `isValidLedgerEvent` is now a table of per-event field checks in `goal-ledger-validate.ts` (66 lines, with `sanitizeEvent`). The checkpoint types and JSON codec moved to `goal-ledger-checkpoint.ts` (224 lines); its parser is split into goal-state, runtime-index and recent-event parsers. The three copies of "write the checkpoint, then reset the write throttle" are one call, and the event switch merges the completed/aborted cases. Exports are unchanged (`goal-ledger.ts` re-exports the checkpoint file name and version).
- `goal-service.ts` 819 -> 811 lines. `apply` is split into `applyBuffered` and `applyLocked` with one `commitMutation` tail. `updateTask` is split into a buffered path and the locked attempt, sharing `withUpdatedTask` and `taskLedgerEvents`. The batch update uses a small `TaskLocator` class. `persist` and the turn-conflict branch use named helpers. The two misplaced doc comments now sit above the type they describe.
- `goal-events.ts` 705 -> 583 lines. The model-facing goal state (stale, unfocused, paused, budget-limited, blocked, active) moved to `goal-context-parts.ts` (145 lines), one function per status. Archiving a completed goal and the superseded-session check are named helpers.
- `goal-commands.ts` 863 -> 544 lines. The settings menu moved to `goal-settings-menu.ts` (337 lines): one editor function per row kind picked from a table, one `valueAtPath`, one source-label function. The goal picker used by `/goal-focus` and `chooseOpenGoal` is one function, and "pick a goal when none is focused" is shared by pause, resume, clear and tweak.
- `goal-task-tools.ts` 598 -> 300 lines. Tree conversion, merging, counting, rendering and `taskTreeSchema` moved to `goal-task-tree.ts` (209 lines). The four single-task statuses share one `updateOne` helper, and the batch and single paths share their lifecycle checks. The single-task messages differ from the batch messages and were kept as they were. Three tests and `goal-drafting` import from the new module.
- `goal-core-tools.ts` 538 -> 268 lines. The blocked (with Oracle) and agent-pause flows moved to `goal-update-flows.ts` (230 lines). `get_goal` builds its lines in `verboseGoalLines` and `compactGoalLines`. `goalTextResult` in `goal-format.ts` replaces the repeated `{content, details}` literals. The source-reading tests still find `update_goal` in this file.
- `goal-drafting.ts` 485 -> 184 lines. Draft session state stays; the tools moved to `goal-drafting-tools.ts` (397 lines), where the long propose execute is split into `createGoalFromDraft`, `applyGoalTweak` and `tweakLedgerEvents`, and the call renderer is its own function. Two tests import `proposalText` from the new file.
- `goal-auditor.ts` 456 -> 329 lines. The prompt builder moved to `goal-auditor-prompt.ts` (111 lines) and is re-exported. Session event handling is a progress tracker object, tool labels and percentages are one table, and the three "aborted" results share one helper. Removed an unreachable branch in `resolveAuditorModel`.
- `goal-scheduler.ts` 445 -> 459 lines. Wait validation (`declareWait`), the wait hold in `schedule` and the dispatch authorization in `claim` are named methods; the long closures are gone.
- Not touched: `goal-questionnaire.ts` and its helpers, README, CI, `experiments/continuation/prepare.mjs` (it patches frozen archive copies of old commits).
- Validation per module: check, lint and all unit tests pass.

## Round three: widgets

Rendered output is unchanged. Before and after, a scratch script rendered 2,808 outputs with a colored theme (every goal state, 12 widths from 10 to 140, compact and expanded, scroll offsets, audit dashboard and result cards, unfocused panel, the widget component with scroll keys and resizes) and the JSON was byte-identical. The existing golden tests pass without edits.

- `goal-dashboard-renderer.ts` 670 -> 472 lines. The two big render functions are lists of small section renderers with one signature (`(ctx) => string[]`): header, status, scheduling, budget, tasks, current task, verification, stop details, file path and footer for the compact dashboard; summary, progress, tasks, current task, verification, activity and footer for the expanded one. The audit dashboard and result card moved to `goal-audit-renderer.ts` (73 lines) and are re-exported.
- `dashboard-box.ts` (200 lines) is the one place that fits, pads and truncates a line: a `Box` class (`header`, `line`, `rule`, `footer`, `wrapped`), the colour helpers, layout modes and the progress bar. The renderers no longer pass `theme` and `width` to every row.
- `goal-widget.ts` 601 -> 342 lines. The height bound (`WIDGET_HEIGHT_RESERVE`, `boundWidgetRenderLines`, the stable-height latch and the dock measurement) is `widget-height.ts`; scroll offsets, the re-anchor rule and scroll keys are `TaskScroll` in `task-scroll.ts`. The component keeps rendering and delegates keys. The old names are still exported from `goal-widget.ts`.
- `goal-dashboard-model.ts` 530 -> 401 lines. Number formatting is `dashboard-format.ts` (`percentageOf` now serves the budget text as well) and viewport maths is `task-viewport.ts`; the model re-exports both, so no importer changed. Removed an unused second `formatAuditElapsed` in `auditor-dashboard-model.ts`, and the copy of the compact token formatter in `goal-status.ts`.
- `goal-format.ts` 384 -> 251 lines. Reading injected continuation markers and assistant turns (aborted, error, transient network error, token use, progress tool calls) is `goal-messages.ts` (157 lines), re-exported from `goal-format.ts`.
- Hot path: the profile showed `sameTasks` in `goal-task-index.ts` taking about 70% of `deriveGoalDashboardModel`, because it read nine fields through a keyed loop for every task on every frame. It now reads the fields directly (same comparison, same in-place-edit detection). Per call on a 40-task goal with 200 ledger events, this machine: model derive 29.2 -> 5.4 us, `GoalWidgetComponent.render` compact 61.3 -> 41.4 us and expanded 102.2 -> 67.9 us. The section renderers themselves are within noise (compact 26.6 -> 24.9 us, expanded 45.3 -> 40.2 us); the rest of the frame is `visibleWidth` on ANSI strings.
- Tried and dropped: measuring each box row once, and skipping the second line clamp in the component. Both left the timings unchanged, because the SDK already caches widths, so they only added code.
- Left alone: `goal-controls-dialog.ts` (a settings dialog with its own input handling, no shared fitting code), `goal-dialog-fit.ts` (already the single dialog-fitting module after the questionnaire split), `goal-notifications.ts` (9 lines), `goal-status.ts` text building (plain-text, no width logic beyond its own box). Caching the whole model by goal identity was not done: `liveDisplayGoal` clones the goal on every call, and the service may edit tasks in place, so identity is not a safe key.
- Known quirk kept as is: at widths below about 20, a header with right-side meta and a wrapped block can be wider than the box; the component's clamp cuts them. `tests/dashboard-box.test.ts` (9 tests) pins the box row widths at 24 and 60 and the scroll rules.
- Validation: check, lint and all unit tests pass (1,274 tests, 5 skipped). The `real SDK: system deltas` e2e test timed out twice when the suite ran while another heavy command did; it passes alone and on a quiet run.
