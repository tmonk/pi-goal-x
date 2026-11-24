# Third cleanup pass: plan

Starting point: `main` at 5d30208 (0.34.2). 1,258 tests pass, bench gate green.
No user-facing behavior changes. Every PR keeps `tsc`, ESLint, the full suite
and the bench gate green.

The first two passes (#137, #139) left a few big items open. This pass does
them, one PR each, so review stays small.

## PR 1: split `createGoalCore`

`createGoalCore` in `extensions/goal-state.ts` is one 1,000-line closure with
about 60 members. State, UI rendering, audit display, accounting, stall
detection and goal lifecycle all share its local variables.

Plan:

- `goal-session-state.ts`: a small class that owns the plain state: the goal
  pool, focused goal id, focus revision, explicit-focus flag, running goal id,
  modal depth, task-tools flag, the per-turn work flag, and the active audit.
  It has no UI and no I/O.
- `goal-view.ts`: everything that draws. Widget registration, coalesced
  `updateUI`, the audit progress and result card, the dashboard expand toggle,
  and the status line.
- `goal-watch.ts`: stall detection and budget warnings.
- `goal-lifecycle.ts`: set, stop, pause, archive, replace, remove, and the
  auditor toggle. These take the state and the services as constructor
  arguments.
- `goal-state.ts` shrinks to wiring. It builds the pieces and exposes the same
  `GoalCore` interface, so tools, commands, events and tests keep working
  unchanged. Later passes can narrow what each caller receives.

## PR 2: move the last hand-rolled hosts onto the shared harness

Network recovery, stale continuation, modal escape, integration and e2e tests
each build their own fake `ExtensionAPI` and `ExtensionContext`. Move them onto
`tests/support/extension-harness.ts`. Extend the harness where they need it
(dropped connections, fake timers, dialogs, the SDK worker). No test gets
weaker: assertions stay as they are, and the test count must not go down.

## PR 3: split `goal-settings.ts`

954 lines mixing the schema and parsing, file reading and caching, layered
resolution, and mutation with locking. Split into `settings/` modules for
schema and parsing, loading and caching, resolution, and mutation.
`goal-settings.ts` stays as a thin re-export only if outside callers need it;
otherwise callers import the new modules directly.

## PR 4: remaining rewrite pass

After the three above, look at the other large modules (`goal-questionnaire`,
`goal-ledger`, `goal-commands`, `goal-service`, `goal-events`) for dead code,
repeated blocks and unclear names. Only change what is clearly better.

## Checks

- `npm run check`, `npm run lint`, `node scripts/run-unit-tests.mjs all`
- Bench gate against `main` (see repo conventions).
- New test files need `node scripts/run-unit-tests.mjs --write-manifest`.
