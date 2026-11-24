# Codebase cleanup: technical plan

Baseline: `main` at b0fc15e (0.34.1). 49 extension modules, 19,526 lines;
100 test files, 27,211 lines; `npm test` 1,233 tests.

## Findings

1. **Dead production code.** A scan of every export against every other
   extension module found code only tests reached:
   - `widgets/task-list-overlay.ts` (409 lines) and `toggleTaskViaService`:
     superseded by the expanded dashboard, never opened.
   - The `PI_GOAL_DEBUG` subsystem in `goal-widget.ts` (~300 lines), its
     widget panel, `GoalCore.debugMode`, and `GoalService.writeDebugFile` /
     `removeDebugFile`.
   - Deprecated or duplicate helpers: `continuationPrompt`,
     `objectiveEditedPrompt`, `validateTaskCompletion`, `validateTaskSkip`,
     `validateTaskListProposal` (set_goal_tasks validates on its own),
     `evaluateDraftingToolGate` (always returned "allow"),
     `validateGoalDraftProposal`, `oracleStateForFingerprint` (a second
     reducer next to the ledger index the runtime uses), and smaller items.
   - 100+ unused imports, helpers and locals. The lint config says tsc reports
     unused symbols, but `noUnusedLocals` was never enabled.
2. **Duplicated storage primitives.** Two copies of the create/retry/stale-
   recovery lock loop (`storage/goal-lock.ts`, `goal-settings.ts`) and six
   temp-file-then-rename writers (goal files, three pool-snapshot writers,
   ledger checkpoint, settings). The settings writer leaked a descriptor when
   it fsynced the directory.
3. **Misleading module names.** `goal-widget.ts` held keybindings while the
   widget lived in `widgets/goal-widget.ts`; `goal-core.ts` held display
   helpers while `GoalCore` lived in `goal-state.ts`; `goal-draft.ts` and
   `goal-drafting.ts` read as duplicates; `goal-tools.ts` was a 16-line
   pass-through.
4. **Test scaffolding copied per file.** Nine suites built their own fake
   `ExtensionAPI` and `ExtensionContext` (40 to 60 lines each). Several tests
   covered test-only functions instead of the shipped paths.
5. **Inconsistent indentation.** 23 extension modules and 27 test files mixed
   1-, 2- and 4-space indentation with tabs, sometimes within one function.
6. **Environment-dependent failures.** Three permission fault-injection tests
   fail when run as root. The runner passed `--import` as a path, which
   Windows parses as a URL scheme, and wrote manifest entries as `.tests/...`.
7. **Stale documentation.** Five superseded plans and surveys sat in `docs/`
   (three shipped in the npm package) next to current docs.

## Plan

Each step is one commit and keeps `tsc`, ESLint and the full suite green.

1. Remove the dead code in finding 1. Where a test covered a removed helper
   that duplicated shipped logic, point it at the shipped path (oracle state
   now comes from `buildLedgerIndex`, checkpoint markers from
   `checkpointTriggerPrompt`). Tests of removed behavior go with it.
2. Add `storage/file-lock.ts` (one lock loop; callers pass bounds and their
   timeout error) and `writeFileAtomicSync` / `writeFileAtomic` in
   `storage/atomic-rename.ts` (temp file opened with `wx`, mode preserved
   under any umask, optional fsync of file and directory, temp removed on
   failure, symlink targets refused). Route every writer and both locks
   through them.
3. Skip permission fault injection as root via `tests/support/permissions.ts`.
4. Rename `goal-widget.ts` to `goal-terminal-input.ts`, `goal-core.ts` to
   `goal-display.ts`, `goal-draft.ts` to `prompts/goal-draft-prompts.ts`, and
   fold `goal-tools.ts` into `goal.ts`. The mutation-boundary test now scans
   every module instead of a hand-kept list.
5. Add `tests/support/extension-harness.ts` and make the nine copies thin
   adapters over it. Enable `noUnusedLocals` and remove what it reports.
6. Move superseded docs to `specs/history/`, drop them from `files`, and fix
   the runner's `--import` URL and manifest paths.
7. Recompute leading whitespace from the syntax tree for every TypeScript
   file, verify `git diff -w` is empty and every literal is byte-identical,
   and add a local ESLint rule that keeps tab indentation.
8. Update `docs/architecture.md`, `docs/agent-flow-design.md` and the
   changelog.

## Verification

- `npm run check`, `npm run lint`, `node scripts/run-unit-tests.mjs all`
  after every step.
- CI (`validate`): type check, lint, the full runtime/package/cache checks and
  the benchmark regression gate against `main`.

## Deferred

These are worth doing but each is large enough to deserve its own review:

- Split `goal-settings.ts` (1,300 lines) into schema/parsing, layered
  resolution and mutation modules.
- Break `createGoalCore` (a 1,000-line closure with 60 members) into the
  state it owns and services that receive it.
- Retire `saveGoalSettingsFileConfig` and `parseGoalSettings` (now used only
  by tests) in favor of `mutateSettingsLayer` and `parseSettingsLayer`.
- Rename phase-named suites (`goal-enhancements`, `goal-features`,
  `goal-optimization`, `goal-comprehensive-optimization`,
  `goal-stabilization-lifecycle`) after the behavior they cover, and move
  `tui-test-utils.ts`, `stabilization-utils.ts` and the SDK workers into
  `tests/support/`.
- Migrate the remaining hand-rolled hosts (network recovery, stale
  continuation, modal escape, integration, e2e) to the shared harness.
