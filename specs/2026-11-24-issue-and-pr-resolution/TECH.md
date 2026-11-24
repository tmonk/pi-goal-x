# Issue and PR resolution: technical notes

Base: `main` at 932a324, after the codebase cleanup (#136). None of the
contributed PRs applied cleanly on top of the cleanup, so each change was
carried over by hand, one commit per item, with a `Co-authored-by:` trailer.

## Changes

| Item | Source | Change |
| --- | --- | --- |
| W1 | #134, #126 | `applicableGoalTools` depends only on whether tasks are enabled. The drafting profile and its installer are gone. While a draft is open, `tool_call` blocks the five goal tools and points at `propose_goal_draft` or `/goal-cancel`. The profile is installed at session start and before each agent turn. #134's live-tail change was not taken. |
| W2 | #133, #132 | Resume dialogs need `ctx.mode === "tui"`, not just `ctx.hasUI`, which is also true over RPC. |
| W3 | #131, #130, #129 | Goal context and continuation scheduling both stop while `hasActiveDraft(core)` is true. |
| W4 | #128 | The status enum has no `""`. `prepareArguments` drops a blank top-level `status` before validation, so models that send `""` for every optional field still work. |
| W5 | #121, #122 | One line in the draft prompt, and the `objective` description, say the whole block goes in `objective`. |
| W6 | #96 | `/goal-resume` sends trimmed text as a follow-up (idle) or steer (busy) before the resume logic. |
| W7 | #135, #129 | The unfocused reminder says tracking is off and the agent should do the user's work. |
| W8 | #125 | A non-transient provider error, or exhausted retries, pauses the goal once the run settles. 499 counts as transient. |
| W9 | #108 | The task list moved from the goal state block into the per-turn snapshot, so task progress appends instead of resetting the tail. The retained counter cap went from 4 KB to 16 KB to fit task lists. |

## Gates that moved, and why

- **Context baseline** (`experiments/context/baseline-main.json`): re-measured.
  Tool schemas now include the drafting tools in every request, so tool schema
  size went from about 3.7-4.7k to 7.4k characters (5.3k with tasks off). This
  is the cost of a stable tool list. A changing list cost a full cache miss on
  every state change, which is far more.
- **Cache gate** (`experiments/context/cache-gate.mjs`): pinned to c4dc4cb, the
  commit after W1 and W9. Both change the cached payload on purpose.
- **Draft detection in fake providers**: tests and gate scripts used to spot a
  draft by the presence of `propose_goal_draft` in the tool list. That no
  longer works, so `experiments/draft-phase.mjs` reads the conversation
  instead, and in-process tests use `hasActiveDraft`.
- **Fake-host tool activation** (`capture-context.mjs`): `registerTool` now
  activates the tool, as Pi does.

## Verification

- `node scripts/run-unit-tests.mjs all`: 1,268 tests, 0 failures, 3 skipped
  (root-only).
- `node scripts/ci-checks.mjs`: every gate passes except the zero-skip rule,
  which only fails when run as root.
- `bench:naf` gate against `main`: 103 rows, no regressions.
