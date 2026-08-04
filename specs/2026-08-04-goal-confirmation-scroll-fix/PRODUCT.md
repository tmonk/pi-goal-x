# Product: Goal confirmation scroll fix and full lifecycle-heading rendering

## Status

Implementing. Task-1 (reproduce and root-cause) is complete; the fix is being
designed against measured TUI renderer behavior.

## Outcome

Two user-facing defects on the simplification branch:

1. **The accept-goal dialog yanks the terminal viewport.** When
   `propose_goal_draft` opens the Confirm / Continue Chatting dialog (or the
   agent asks a goal question), the terminal viewport jumps — a user reading
   scrollback (e.g., a long objective or earlier context) is pulled out of
   their scroll position. Previous fixes removed the periodic 1s status
   redraw (f7a8e0d, `tests/no-status-refresh-timer.test.ts`) and suppressed
   the hardware cursor inside dialogs, but the dialog open/close render churn
   itself still moves the viewport.

2. **Goal tool-call headings truncate or omit lifecycle content.** PR #11
   ("fix: show full pause and abort reasons", tmonk/pi-goal-x#11) removed the
   80-column truncation from the `pause_goal`/`abort_goal` headings on the
   pre-simplification surface. Those tools no longer exist here — lifecycle is
   `update_goal` — so the fix must be ported to the current five-tool surface.
   Per the user's decision, the port goes further than PR #11: no goal
   tool-call heading truncates anything (the "compact previews stay" carve-out
   is dropped); every heading renders its complete content, wrapped by the
   TUI.

## Desired behavior

### Scroll / viewport

- Opening or closing any goal confirmation/questionnaire dialog never moves
  the terminal viewport: a user reading scrollback keeps their position across
  the dialog (verified interactively in a real terminal), and a user at the
  bottom sees the dialog appear/close without content jumping.
- The fix applies to every goal dialog that shares the mechanism:
  `propose_goal_draft` confirmation (`showProposalDialog`), the
  `goal_question` / `goal_questionnaire` tools (`runGoalQuestionnaire`), and
  the `set_goal_tasks` task-list confirmation (`showTaskConfirmation`).
- No periodic redraws are introduced (the earlier scrollback fix must not
  regress; `tests/no-status-refresh-timer.test.ts` stays green).

### Tool-call headings (PR #11 port)

- `update_goal` with `status: "paused"` renders the complete agent reason in
  the call heading (wrapped to the terminal width) — never truncated, and not
  only the status word.
- No goal tool-call heading truncates content: `set_goal_tasks`
  `change_summary` and `propose_goal_draft` `objective` render in full;
  `create_goal` and `update_goal_task` remain full.
- Lifecycle schemas, persistence, and pause/block execution semantics are
  unchanged.

## Out of scope

- Re-adding the removed `pause_goal` / `abort_goal` tools.
- Changing lifecycle schemas, persistence, or audit logic.
- Non-goal pi rendering behavior beyond the goal dialogs.
