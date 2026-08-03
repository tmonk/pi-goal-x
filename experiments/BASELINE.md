# pi-goal Experiment Baselines — Stage 0 snapshot

This file is the Stage 0 characterization baseline for the Codex-inspired goal interface
simplification (`specs/2026-08-03-codex-inspired-goal-interface`). It pins the CURRENT
(unchanged) interface surface, maps the behavioral scenarios covered by the case suite,
records the baseline corrections applied, and documents the serial test invocation used
to validate the suite without EMFILE flakiness.

Date: 2026-08-03. No behavior change was made in this stage.

## 1. Current interface snapshot (unchanged by Stage 0)

### Registered goal tools (13, in registration order)

1. `goal_question` (from extensions/goal-questionnaire.ts)
2. `goal_questionnaire` (from extensions/goal-questionnaire.ts)
3. `get_goal`
4. `create_goal` (registered but hidden — not advertised in any phase set)
5. `propose_goal_draft`
6. `propose_goal_tweak`
7. `complete_goal`
8. `pause_goal`
9. `abort_goal`
10. `step_complete` (legacy Sisyphus step tool)
11. `propose_task_list`
12. `complete_task`
13. `skip_task`

Pinned by `tests/goal-surface-baseline.test.ts`.

### Registered slash commands (15)

`goal`, `goal-status`, `goal-list`, `goal-focus`, `goal-unfocus`, `goal-settings`,
`goals`, `sisyphus`, `goals-set`, `sisyphus-set`, `goal-tweak`, `goal-clear`,
`goal-abort`, `goal-pause`, `goal-resume`.

Pinned by `tests/goal-surface-baseline.test.ts`.

### Phase-advertised tool sets (extensions/goal-tool-names.ts)

- ACTIVE_GOAL_TOOL_NAMES (8): `get_goal`, `complete_goal`, `pause_goal`, `abort_goal`,
  `propose_goal_tweak`, `propose_task_list`, `complete_task`, `skip_task`
- PAUSED_GOAL_TOOL_NAMES (5): `get_goal`, `complete_goal`, `abort_goal`,
  `propose_goal_tweak`, `propose_task_list`
- NO_FOCUSED_GOAL_TOOL_NAMES (1): `get_goal`
- Visibility is phase-dependent via `syncGoalTools()` (drafting / tweakDrafting / normal).
  Stage 3+ removes `syncGoalTools()` and installs a static surface.

## 2. Behavioral scenario map (baseline case suite)

| # | Scenario | Cases |
|---|----------|-------|
| 1 | Drafting → confirmation interview; vague topics must not create goals; full specs must not over-interview | C1, C2, C3, C4, C11, C12, C13, C19 |
| 2 | Completion integrity — no premature `complete_goal`; step verification gate | C2, C8, C10 |
| 3 | Blocker handling — structurally impossible tasks must end in `pause_goal`, never faked completion | C5, C6, C7, C14, B1 |
| 4 | Lifecycle state transitions — clear mid-run, abort mid-turn, resume-after-pause | C7, C9, C18 |
| 5 | Compaction + post-compaction resync mid-sisyphus | C16 |
| 6 | Task workflow via the current task tools (`propose_task_list` + `complete_task`) | B2 |

New baseline cases:
- `B1-repeated-blocker` — agent retries briefly, then `pause_goal({reason, suggestedAction})`;
  rubric rejects `complete_goal`, runaway retry loops, and fabricated `result.json`.
- `B2-task-completion` — agent proposes a task list and marks tasks complete with evidence
  before `complete_goal`; rubric requires `propose_task_list`, `complete_task` with
  non-empty evidence, and both sandbox files with exact contents.

## 3. Baseline corrections (mechanical, no behavior change)

- Rubrics referenced `update_goal` (14 refs) and `apply_goal_tweak` (3 refs) as model
  tools; neither is registered. The completion tool is `complete_goal` and the tweak tool
  is `propose_goal_tweak`. All rubric entries and INPUT narratives were normalized:
  - `tool-args-jq` `update_goal` `.status == "complete"` → `tool-called` `complete_goal`
  - `tool-args-jq-none` `update_goal` `.status == "complete"` → `tool-not-called` `complete_goal`
  - `tool-not-called` `update_goal` → `tool-not-called` `complete_goal`
  - `apply_goal_tweak` → `propose_goal_tweak`
- C4 INPUT described tweak as editing `active_goal_*.md` directly; the current design
  sanctions `propose_goal_tweak` as the only channel. Narrative updated to match.
- C18 INPUT prose said 12s but the machine header is `ABORT_AFTER_MS: 20000`; prose fixed
  to match the config.
- All case INPUT/rubric narrative content is English (no CJK characters). Functional CJK
  test data in `tests/` (width rendering, Chinese-objective fixtures) is preserved as data.
- C1 rubric's full-width question-mark variant in the final-text pattern removed (drafting runs in English).

## 4. Serial test invocation (EMFILE-safe)

The parallel Node test runner can hit EMFILE when loading many test files at once
(`node --experimental-strip-types --test tests/*.test.ts`). EMFILE is NOT a product
failure; the authoritative validation runs the suite serially:

```bash
npm run test:serial
# == node --experimental-strip-types --test --test-concurrency=1 tests/*.test.ts
```

Stage 0 exit criteria: existing suite passes serially with 0 failures; `npm run check`
(tsc) reports 0 errors; `git diff --check` is clean; no behavior change.
