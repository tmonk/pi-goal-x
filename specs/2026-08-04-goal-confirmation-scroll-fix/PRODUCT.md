# Product: Goal confirmation scroll fix and full lifecycle-heading rendering

## Status

Implemented (pivoted). Tasks 1–3 of the panel rework are complete: the
alternate-screen fix (which blanked the main screen and disabled terminal
scrollback while a dialog was open) has been reverted in favor of bounded,
bottom-anchored overlay panels; the alt-screen module and its tests are
deleted; panel regression tests are green. Task-4 (CHANGELOG, docs, full
validation) is in progress.

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

### Dialogs: bounded bottom panels, history visible, scrollback usable

- Every goal dialog — `propose_goal_draft` confirmation
  (`showProposalDialog`), the `goal_question` / `goal_questionnaire` tools
  (`runGoalQuestionnaire`), the `set_goal_tasks` task-list confirmation
  (`showTaskConfirmation`), and the audit escape dialog (`showEscapeDialog`) —
  opens as a bottom-anchored panel in the MAIN terminal screen, bounded to a
  fraction of the terminal height (the chat history above stays visible).
- The terminal scrollback remains fully usable while a dialog is open: the
  user can scroll up at any time to read earlier content. No DECSET 1049 /
  alternate buffer is used anywhere in the dialog flow (the alternate buffer
  has no scrollback, which the user rejected), and no `\x1b[2J` full clears.
- Opening, navigating, and closing the dialogs cause no viewport scroll
  churn: headless measurement of the TUI write stream shows no
  CRLF-at-bottom-row scroll bursts (the panel composites into the frame in
  place and is capped by `maxHeight`, so the total frame never overflows).
- Content taller than the panel scrolls internally (▴/▾ indicators,
  PgUp/PgDn/Home/End), defaulting to the actionable options/footer visible.
- No periodic redraws are introduced (the earlier scrollback fix must not
  regress; `tests/no-status-refresh-timer.test.ts` stays green).
- Manual reproduction in a real terminal confirms: panel at the bottom,
  history visible above, scroll-up works while open, no viewport jump on
  open/close.

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
