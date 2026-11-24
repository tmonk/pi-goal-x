## 2026-11-24, third pass

- Plan written (TECH.md). Work split into separate PRs.

### Test hosts

- Moved the hand-rolled fake hosts in `goal-network-recovery`, `goal-stale-continuation-golden`, `goal-modal-escape`, `integration/extension` and `e2e/goal-lifecycle-dashboard` onto `tests/support/extension-harness.ts`. Assertions and test counts are unchanged (1258 before and after).
- The harness gained `terminalInput()` (the recorded `onTerminalInput` handler) and a `setWorkingVisible` stub. Callers that add helpers use `Object.assign(h, ...)`, not a spread, which would freeze the harness getters.
- Left as they were: `e2e/network-recovery-rpc.test.ts` and `e2e/run.ts` spawn the real `pi` process and build no host. Other suites with their own hosts (`goal-controls`, `goal-progress-features`, `goal-scheduler`, `goal-session-safety`, `goal-surface-baseline`, `goal-tool-visibility`) were outside this pass.

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
