# Implementation log — scheduler summary simplification

## Re-application on top of the released 0.31.9 line

This work was first applied to a local `main` that was 80 commits behind (0.31.5). Releases
0.31.6 through 0.31.9 shipped in the meantime, so the work was redone against current `main`
before anything was merged. Differences found while redoing it:

- `main` had since gained `autoSelectSingleGoal`, `hideUnfocusedPrompt`, `goalsRoot`, and a
  README rewrite that moved the scheduling documentation into `docs/advanced-usage.md`.
- `schedulerSummary()` had been split into `schedulerSummaryParts()` returning
  `{ runs, instructions }`. That split is what this change needs, so the runs line is gated at
  its source and `schedulerSummary` joins only the non-empty parts.
- Issue #59 was already released in 0.31.7, so the `declare()` call in `goal-drafting.ts` that
  carries `next_action` exists on `main` and is updated here.
- Two prompt-cache tests on `main` assert the runs line; both were updated to assert its
  absence when the allowance is unlimited.

## The runs line

Verified by rendering rather than by inference:

| Case | Output |
| --- | --- |
| unlimited | `""` |
| limit 20, default | `Autonomous runs: 4/20.` |
| limit 20, setting off | `""` |
| limit 0, default | `Autonomous runs: 4/0 (automatic continuation disabled).` |
| limit 0, setting off | `""` |
| no scheduler state, limit 20 | `Autonomous runs: 0/20.` |

`showAutonomousRuns` was added at all seven `goal-settings.ts` sites, the `/goal-settings` row,
the boolean formatting branch in `settingsValue`, and the `/goal-status` provenance report. The
dashboard model takes the flag with `!== false` so an absent option keeps the default.

## The next-action removal

Removed from the state type, `GoalContinuation`, `normalizeGoalScheduler`, the rendered summary,
all five hardcoded strings in `goal-scheduler.ts`, `declare()` validation, the `update_goal`
schema, and the internal `declare()` call in `goal-drafting.ts`.

`normalizeGoalScheduler` strips the field after validation. The test covers all four `purpose`
values and confirms an invalid decision is still rejected, so the tolerance is scoped to the
removed field rather than a loss of validation.

## Repair and recovery guidance

While redoing this, a claim made during the original pass turned out to be wrong and was
corrected: the repair next-action text was reaching the model through the goal prompt, not only
rendering for the user. The e2e worker asserted that it "must reach the provider".

Removing it means a repair or recovery dispatch no longer carries per-run text. The mechanism is
unchanged — one repair, then pause with "No execution disposition after the contract-repair
prompt" — and in strict mode the static prompt still says a missing decision allows one repair.
This was raised and accepted deliberately rather than left as an oversight.

## Tests

New:

- `showAutonomousRuns` layering: project beats global in both directions, non-boolean values
  rejected, default on.
- Runs display: omitted when unlimited, reported when finite, hidden when the setting is off,
  `0` still reporting the disabled suffix.
- A ready disposition succeeds with no next action and the schema exposes no `next_action`.
- A goal saved with `decision.nextAction` normalizes, keeps `phase` and `used`, and strips the
  field.
- `tests/goal-tweak-status-persistence.test.ts` now seeds a legacy goal, so the end-to-end path
  is covered too.

Updated to the new contract, preserving each test's original subject:

- Prompt-cache test: was `7/unlimited`, now asserts no runs line when unlimited.
- Uncapped counting test: was `5/unlimited`, now asserts `used === 5` directly plus a finite
  render of `5/5`.
- "Cleared scheduling instructions vanish from retained history" used a `nextAction` as its
  standing instruction. A ready decision no longer carries text, so the instruction is now a
  saved wait reason. The test's subject is unchanged.
- `scheduler-sdk-worker.mjs`: the model call drops `next_action`. Two assertions were replaced
  rather than removed — the repair dispatch being spent, and the removed text never reaching
  the provider; and the goal prompt still arriving while a declared next action is never
  echoed.
- Integration settings-row count: 19 to 20, plus an assertion that the new row defaults to on.

## Wording

The `OUTCOMES` block said "Optional ready saves a next action". That described a parameter the
schema no longer accepts, so the clause is removed. Prohibitions that constrain the agent
("Never busy-poll", "The objective is immutable", and the rest) were left in place: they state
what the agent must not do, which is different from describing an absence.

## Validation

Recorded in the pull request. Unit, integration, and e2e suites pass with zero failures on
current `main`, along with `check`, `lint`, `test:selfcheck`, `context:gate`, and
`npm pack --dry-run`.