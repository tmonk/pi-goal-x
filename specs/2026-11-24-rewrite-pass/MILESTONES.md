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

## Round three: storage and performance

Behavior is unchanged: goal file, snapshot, ledger and checkpoint formats, prompt text and cache keys are the same. Every export used by `experiments/` or tests is still exported from its old module.

- `storage/goal-files.ts` 656 -> 349 lines. The pure parts moved out: `goal-file-format.ts` (serialize and parse the goal file text, 121 lines), `goal-paths.ts` (directories, name patterns, safe-path checks, 90 lines) and `goal-pool-snapshot.ts` (the persisted pool snapshot, 164 lines). `goal-files.ts` keeps the disk access and the three in-memory caches, and re-exports the old names. The sync and async pool scans now share the root check, the name filter and the pool builders; the snapshot read and write twins share the parse and the directory preparation.
- `parseGoalFileContent` returns `undefined` for text with no readable JSON header and `null` for a readable header with no usable goal. The parse cache keeps the old rule (the second case is cached, the first is not).
- `goal-ledger.ts` 695 -> 375 lines. New modules: `goal-ledger-events.ts` (the event union, 33 lines), `goal-ledger-reconstruct.ts` (the incremental fold, 151), `goal-ledger-queries.ts` (latest-audit and recent-event lookups, 39) and `goal-ledger-checkpoint-store.ts` (checkpoint mirror, write throttle, file read and write, update after append, 158). `goal-ledger.ts` re-exports the event type, the fold and the queries, so importers did not change.
- `goal-recovery.ts` no longer keeps its own copies of `GOALS_DIR` and `safeLockName`; it takes them from `storage/`. `storage/goal-lock.ts` takes `GoalStorageContext` from `goal-root.ts`, which removes its import cycle with `goal-files.ts`. The orphaned doc comment above `normalizePositiveSafeInteger` in `goal-record.ts` is back on that function.
- Performance (profiled with `node --cpu-prof` on a 50-goal, 10k-event fixture): the ledger and snapshot paths are I/O bound. The CPU hotspots were JSON parsing and `isValidLedgerEvent`, which built an `Object.entries` array per event; the checks are now precomputed per event type. Cold checkpoint load 5.05 ms -> 4.39 ms and full ledger parse 21.5 ms -> 17.7 ms (same machine, alternating runs). A goal write dropped a duplicate `lstat` of the target (the atomic writer already does the symlink check) and the failing legacy-snapshot `unlink` after the first write per process: 2 fewer fs ops per mutation (`B2.mutationturn.task` 26 -> 24, `B7.tool.create_goal` 48 -> 44).
- Left alone: the pool snapshot read-modify-write per goal write (about 0.1 ms of CPU; caching it risks cross-process staleness), `goal-live-retention.ts` hashing every message per request (extensions may mutate message objects, so no cache is safe), and cold start (about 11 ms, nearly all module compile time, not storage code).
- Validation: check, lint and all unit tests pass (1,276 tests including six new ones in `tests/goal-storage-modules.test.ts`, 5 skipped). `bench:gate:naf` against a `.benchmark-base` worktree of origin/main passes; one earlier run failed `B1.ledgerstate.cold` while the machine was under heavy shared load and passed on rerun.

## Round three: service and scheduler

Behavior is unchanged: ledger event order and format, error messages, timing and cache keys are the same. Public exports (`GoalService`, `GoalServiceRef`, `GoalMutationOutcome`, `GoalTaskUpdateSpec`, `GoalScheduler`) are where they were, and the benchmark and profile scripts still load them.

- `goal-service.ts` 811 -> 538 lines. It keeps the locks, the file writes and the ordered write, ledger, memory commit. Moved out:
  - `goal-service-types.ts` (97): the ref, mutation spec/outcome and task-update types.
  - `goal-turn-buffer.ts` (81): `TurnBuffer`, the in-memory transaction state (open, stage, switch, reject, reset). The service still decides when to flush.
  - `goal-reconcile.ts` (57): `planReconcile`, a pure function that returns what reconciling with the disk should do (unchanged, pool only, focus, lost). The service applies the plan through its ref in the old order.
  - `goal-task-update.ts` (118): finding, validating and applying task updates, the current-task rule, `TaskLocator` and `applyTaskBatch`.
  - `goal-usage-baseline.ts` (52): `UsageBaseline`, `usageSince`, `addUsage` for the additive usage merge.
  - `goal-ledger-sink.ts` (31): the best-effort ledger append. It calls the ledger primitive, so it is added to the owner list in `tests/goal-mutation-boundary.test.ts`; GoalService is its only caller.
- `goal-scheduler.ts` 459 -> 410 lines. New `goal-scheduler-rules.ts` (122) holds the decisions as pure functions that take the time as an argument: idle pacing, wait declaration, wait hold (pause, timer or proceed), dispatch kind, claiming a dispatch, release to idle. `goal-wake-timer.ts` (22) is the unref'd re-armable timer. The scheduler reads settings and the clock, saves through the service and drives the timer.
- `GoalScheduler` now takes a `SchedulerHost` and `GoalInterruption` an `InterruptionHost` (`goal-scheduler-host.ts`, 48), listing only what each uses, instead of `GoalCore`. `hasActiveDraft`/`activeDraft` accept any object, since the drafting map is keyed by the core object.
- Tests: `tests/goal-service-parts.test.ts` (reconcile plan, task updates, usage baseline, turn buffer) and `tests/goal-scheduler-rules.test.ts` (pacing, waits, dispatch, timer) add 41 tests with no disk or session. Existing tests are unchanged. 1,311 tests, 0 failures, 5 skipped.
- Left as they were: the scheduler's run flags (`inRun`, `declared`, `denied`, `runGoalId` and so on) stay fields on the class, because `experiments/continuation/profile-worker.mjs` sets `inRun` directly and a test replaces the private `goalContent` method, which still exists and is called once per run. The service's lock, write and revision-check sequences stay in one file so the pipeline order reads in one place. `GoalCore` still builds the scheduler by passing itself in.
- One end-to-end SDK test (`goal-context-system-sdk`) failed once during a full run and passed alone and on the next full run; it did not touch changed code.
