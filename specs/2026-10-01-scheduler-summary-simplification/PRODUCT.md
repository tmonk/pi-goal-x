# Scheduler summary simplification

Two changes to the scheduling summary that pi-goal-x shows the user and the model. One hides a
line that reports nothing; the other deletes a concept.

## 1. The autonomous-runs line

`schedulerSummaryParts()` produced a first line for every render:

```
Autonomous runs: 4/unlimited.
```

`unlimited` is the default, so with no cap configured the line reported an allowance that does
not exist.

New behavior:

- **Allowance unlimited** (limit undefined): the line is empty. It does not appear in the
  dashboard, `/goal-status`, `get_goal`, the agent prompt, or the live execution-state message.
- **Finite allowance** (limit set, including `0`): the line is reported, including the existing
  `(automatic continuation disabled)` suffix when the limit is `0`.
- A new boolean setting, `showAutonomousRuns`, controls the finite case. Default **on**. It is
  documented, layered across project and global scopes like every other setting, and listed in
  `/goal-settings`.

Enforcement is unchanged. `maxAutonomousRuns` still caps runs and still disables automatic
continuation at `0`. A goal under a finite allowance still runs out of allowance the same way;
only the display is affected.

## 2. The next-action concept

A ready disposition carried a free-text next action in four places: the persisted
`GoalSchedulerState.decision.nextAction`, the `next_action` parameter the model had to supply,
the validation in `scheduler.declare()`, and a `Next action: ...` line in the rendered summary.

All four are removed. The model declares `{ kind: "ready" }`.

`decision.purpose` (`ready`, `repair`, `kickoff`, `recovery`) is kept. It selects the dispatch
kind, and dispatch, repair, kickoff, recovery, and wait behavior are otherwise unchanged.

Goals saved before this change carry `decision.nextAction` on disk. `normalizeGoalScheduler`
accepts them and strips the field. A goal is never treated as invalid because it carries the
removed field: rejection would coerce it to `phase: "interrupted"` with
`used: Number.MAX_SAFE_INTEGER`, stranding it.

Guidance moves with the contract. The `OUTCOMES` block said "Optional ready saves a next
action", which now describes a parameter the schema rejects, so that clause is removed.

## Known consequence

Removing the next action also removes the per-run text that a repair or recovery dispatch
carried into the model's live execution state. The dispatch mechanism is unchanged — a missing
declaration still costs one repair and then pauses — but the model no longer receives that
reminder on those runs. This was raised during the work and accepted deliberately; in strict
mode the static prompt still states that a missing decision allows one repair.

## Success criteria

1. With an unlimited allowance, no runs line appears in any rendered surface.
2. With a finite allowance, the line is reported by default; the setting hides it when off.
3. `showAutonomousRuns` is a documented, layered boolean, default on, listed in `/goal-settings`.
4. `nextAction` is gone from the state type, the continuation type, normalization, the tool
   schema, and `declare()` validation.
5. `decision.purpose` and all dispatch behavior are unchanged.
6. A goal file containing `decision.nextAction` loads, normalizes, and runs.
7. `update_goal({ continuation: { kind: "ready" } })` succeeds.
8. `npm run check`, `npm run lint`, and the unit, integration, and e2e suites pass with zero
   failures. No test is deleted or weakened; assertions bound to the removed display are
   updated to the new contract.
9. README and `docs/advanced-usage.md` no longer document `next_action`.

## Scope

In scope: `goal-scheduler-state.ts`, `goal-scheduler.ts`, `goal-core-tools.ts`,
`goal-settings.ts`, `goal-commands.ts`, the prompt and dashboard rendering paths, the tests and
fixtures that assert the old text, README and `docs/advanced-usage.md`, and this spec directory.

Out of scope: changing how many runs are allowed or how enforcement works; the wait or dispatch
machinery; `decision.purpose`; the pi 1.0.0 compatibility work; and behavioral prohibitions in
the prompt, which constrain what the agent does rather than describe what something lacks.

## Constraints

- **Parity outside the two removals.** Enforcement, dispatch, repair, recovery, and wait
  semantics behave as before.
- **Never invalidate on-disk goals.** Reading legacy `nextAction` is allowed; writing it is not.
- **Guidance and schema ship together** so the model is never told to send a rejected
  parameter.
- **Wording.** State what something does rather than what it lacks. Removing a negative must
  not drop information the reader needs.
- **Tests are the regression gate.** Update assertions to the new contract; do not loosen them.
- Do not reformat or refactor untouched scheduling code.