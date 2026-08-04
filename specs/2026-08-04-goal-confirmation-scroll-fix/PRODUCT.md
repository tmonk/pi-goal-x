# Product: Goal confirmation scroll fix — revert to 383ae52 with scrollback in full

## Status

Implemented. Per explicit user direction, the goal dialog and heading surface
is reverted **exactly** to commit `383ae52` — the state before the
alternate-screen (b8cff1a), full-heading (a146edb), and overlay-panel
(61db55e) commits — while verifying that terminal scrollback is enabled **in
full**: dialogs stay in the main terminal buffer (no DECSET 1049 alternate
screen, no `\x1b[2J`/`\x1b[3J` scrollback erases in the dialog flow), the
complete chat and dialog content remain in the buffer and readable via
terminal scrollback, and opening/navigating/closing never yanks the viewport
for content that fits on screen.

## What was tried and rejected (why we are here)

1. **b8cff1a — alternate-screen dialogs (DECSET 1049).** Blanked the main
   screen and disabled terminal scrollback while a dialog was open. The user
   rejected this: scrollback must stay usable. Reverted.
2. **a146edb — full wrapped headings (PR #11 port).** Changed `update_goal`
   to echo the full agent reason/summary and `set_goal_tasks` to render the
   change summary untruncated. The user chose a full-surface revert over a
   dialogs-only revert. Reverted.
3. **61db55e — bounded bottom overlay panels.** Replaced the alt-screen with
   bottom-anchored `maxHeight` overlay panels plus hand-rolled internal
   windowing (▴/▾ indicators, PgUp/PgDn/Home/End). The panel composites over
   the existing frame, so chat/footer/editor text bled through on panel rows
   — "goal questions overlap text at the bottom". The user rejected the whole
   overlay/windowing machinery. Reverted.

## Final behavior (restored 383ae52 surface)

### Dialogs

- **Accept-goal questionnaire (`propose_goal_draft` / `goal_questionnaire` /
  `goal_question` — `runGoalQuestionnaire`):** plain `ctx.ui.custom(factory)`
  with no options — the dialog replaces the editor inline in the main TUI
  buffer, rendered unbounded exactly as pre-regression: question title, rich
  context renderer, tabs, options list, input mode, submit view, recommended
  default highlighted. No overlay options, no windowing, no internal scrolling
  UI.
- **Task-list confirmation (`showTaskConfirmation`):** centered main-screen
  overlay `{ anchor: "center", width: "70%", minWidth: 50, maxHeight: "60%" }`.
- **Audit escape dialog (`showEscapeDialog`):** centered main-screen overlay
  `{ anchor: "center", width: "70%", minWidth: 50, maxHeight: "50%" }`.

### Tool-call headings

- `update_goal` renders the status word only (`update_goal paused`), not the
  agent's reason/summary.
- `set_goal_tasks` renders `truncateText(change_summary, 80)` or
  `` `${tasks.length} tasks` ``.

### Scrollback (the "IN FULL" requirement)

- No DECSET 1049 anywhere in the dialog flow (the alt-screen is deleted).
- No `\x1b[2J`/`\x1b[3J` clears while opening, navigating, or closing a
  dialog whose content fits on screen.
- The full dialog content and the chat history are written into the main
  terminal buffer, so the user can scroll up and read everything while a
  dialog is open.
- For content that fits on screen: **0 viewport scrolls** on open, navigate,
  and close (measured through the real pi-tui renderer).

## Verification (headless, real renderer)

Driven the real restored components (`runGoalQuestionnaire`,
`showTaskConfirmation`, `showEscapeDialog`) through the real
`@earendil-works/pi-tui` differential renderer with a fake terminal, using
pi's exact `showExtensionCustom` open/close sequence:

| Scenario (rows=40) | open scrolls | nav | close | 1049 | 2J/3J on open | full dialog in buffer | chat above |
| --- | --- | --- | --- | --- | --- | --- | --- |
| short chat + short proposal (fits) | 0 | 0 | 0 | none | none | ✓ | ✓ |
| short chat + long proposal | 87 (pre-existing) | 0 | 0 (2J+3J on close — see note) | none | none | ✓ (all 40 detail + 30 task lines) | ✓ |
| long chat (120) + short proposal | 13 (pre-existing) | 0 | 0 | none | none | ✓ | ✓ |
| task-list confirmation (overlay) | 0 | — | 0 | none | none | — | ✓ |
| escape dialog (overlay) | 0 | — | 0 | none | none | — | ✓ |

`npm run check`: 0 errors. Full unit suite: 482 pass / 0 fail (matches the
383ae52 test surface; the three commits' tests were removed).

### Known pre-existing edge case (out of the reverted surface)

Closing a questionnaire whose **opened frame exceeded the terminal height**
(proposal longer than the screen) triggers pi-tui's generic shrink path
(`deleted lines moved viewport up → fullRender(true)`), which emits
`\x1b[2J\x1b[H\x1b[3J` — clearing the screen and the terminal scrollback.
This behavior is pi-tui's differential-renderer behavior present at 383ae52
(the three commits never touched pi-tui), it predates the reverted work, and
it is orthogonal to the dialog/heading surface. The same shrink decision is
what the original spec measured as "close scroll churn". Fixing it would
require either bounding the dialog render (new machinery, rejected) or
touching the pi-tui dependency (out of scope). Recorded here for the user's
decision at signoff; the fits-on-screen flows (the common case) are fully
clean.

## Out of scope

- Any new dialog machinery (windowing, internal scrolling, overlays beyond
  the restored 383ae52 options, alternate screen).
- Changes to lifecycle schemas, persistence, or audit logic.
- pi-tui / pi runtime internals.
