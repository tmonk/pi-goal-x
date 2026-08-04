# Product: Goal confirmation scroll fix — revert to 383ae52 with scrollback in full

## Status

Implemented. Per explicit user direction, the goal dialog and heading surface
is reverted **exactly** to commit `383ae52` — the state before the
alternate-screen (b8cff1a), full-heading (a146edb), and overlay-panel
(61db55e) commits — plus one minimal churn guard: the questionnaire render is
bounded to the terminal height (tail slice) so that closing a proposal taller
than the screen can no longer trigger pi-tui's shrink full-render
(`\x1b[2J\x1b[H\x1b[3J`). Verified with a committed programmatic before/after
harness: dialogs stay in the main terminal buffer (no DECSET 1049 alternate
screen, no `\x1b[2J`/`\x1b[3J` scrollback erases anywhere in the dialog
flow), complete chat content and the full dialog (for content that fits)
remain in the buffer and readable via terminal scrollback, and
opening/navigating/closing never yank the viewport for content that fits on
screen — or for taller-than-screen proposals (the pre-regression behavior
only kept them readable via scrollback up until the close, which then wiped
it). Plus the goal dialogs pause pi's working spinner for their duration, so
the terminal no longer "scrolls back down after X seconds" while the user is
reading the proposal in scrollback.

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
  buffer: question title, rich context renderer, tabs, options list, input
  mode, submit view, recommended default highlighted. No overlay options, no
  windowing, no internal scrolling UI. The render is byte-identical to the
  pre-regression UI for content that fits on screen; content taller than the
  terminal is tail-sliced to the terminal-height bound so the opened frame
  never exceeds the screen (see “Churn guard” below). While any goal dialog
  is open, pi's working spinner is paused (`setWorkingVisible(false)`) so its
  ~80ms re-renders cannot snap a scrolled-up reader back to the bottom.
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
- No `\x1b[2J`/`\x1b[3J` clears on open, navigate, or close — including for
  proposals taller than the terminal (the churn guard keeps the opened frame
  ≤ terminal height, so pi-tui's shrink full-render never fires).
- The chat history and the full dialog content (for content that fits) are
  written into the main terminal buffer, so the user can scroll up and read
  everything while a dialog is open.
- **0 viewport scrolls** on open, navigate, and close for content that fits
  on screen, and for taller-than-screen proposals with a chat that fits
  (measured through the real pi-tui renderer).

### Churn guard (the one addition to the 383ae52 surface)

Two orthogonal churn sources were fixed with minimal extension-side guards
(the task-list confirmation and escape overlays keep their exact 383ae52
overlay configuration):

**1. Tall-dialog close 2J+3J.** `runGoalQuestionnaire` bounds its render to
the terminal height: `maxDialogLines = max(10, terminalRows − preDialogFrame
+ 1)`, where `preDialogFrame` is the height of the frame before the dialog
swaps into the editor slot (`tui.previousLines`). With the frame at most
`terminalRows` tall, closing never shrinks past the previous viewport top and
pi-tui's generic `fullRender(true)` path (the `\x1b[2J\x1b[H\x1b[3J` scrollback
wipe) is never entered. The tail slice keeps the actionable options/footer in
view and preserves the exact pre-regression rendering whenever the dialog
fits. Only engaged when real TUI dimensions are available (mocks render
unbounded as before). Tradeoff, accepted by the user via goal tweak: for a
dialog taller than the terminal, the head of the dialog is not written to the
buffer (scrollback contains the tail only) — previously it was written but
wiped on close by the 2J+3J full render.

**2. Periodic output while reading (spinner).** The user's real-terminal
replication: “agent presents goal → user scrolls up to read it all → terminal
scrolls back down after X seconds” (viewport lands at 0/586 = the bottom).
While a goal dialog is open, pi's working spinner (`Loader`) ticks every
~80ms and calls `requestRender()`; each tick rewrites the spinner line (~44
bytes/tick, measured 220 bytes per 5 ticks), and in iTerm2/Ghostty/kitty
default behavior **any output while the user is scrolled up snaps the
viewport back to the bottom**. Each goal dialog calls
`ctx.ui.setWorkingVisible(false)` when it opens and
`setWorkingVisible(true)` on close/dispose, stopping the spinner for the
dialog duration — measured 0 bytes per tick afterwards. `setWorkingVisible`
is a no-op in headless/mock contexts, so the 383ae52 test surface is
untouched.

## Verification (headless, real renderer)

Driven the real restored components (`runGoalQuestionnaire`,
`showTaskConfirmation`, `showEscapeDialog`) through the real
`@earendil-works/pi-tui` differential renderer with a fake terminal, using
pi's exact `showExtensionCustom` open/close sequence
(`experiments/scroll-repro/before-after-churn.mjs`, report mode = before,
`--expect-fixed` = after):

| Scenario (rows=40) | open scrolls | nav | close | 1049 | 2J/3J | spinner ticks (bytes) | full dialog in buffer | chat above |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| short chat + short proposal (fits) | 0 | 0 | 0 | none | none | 0 / 5 | ✓ | ✓ |
| short chat + long proposal (73-line) | 0 (was 87) | 0 | 0 | none | **none (was 2J+3J)** | 0 / 5 (was 220) | tail (29 lines) | ✓ |
| long chat (120) + long proposal | 8 (chat alone exceeds screen; pre-existing) | 0 | 0 | none | none (was 2J+3J) | 0 / 5 (was 220) | tail (10 lines) | ✓ |
| task-list confirmation (overlay) | 0 | — | 0 | none | none | 0 / 5 (was ~215) | — | ✓ |
| escape dialog (overlay) | 0 | — | 0 | none | none | 0 / 5 (was ~215) | — | ✓ |

Before/after delta (the regressions the tweak fixed): on the unbounded 383ae52
render, the tall-dialog scenarios emitted `2J=1 3J=1` on close — pi-tui's
shrink full-render wiping terminal scrollback and leaving the viewport at the
top, so the window took ~10s to scroll back to the bottom. And while any
dialog was open, pi's working spinner wrote ~44 bytes every ~80ms — in a real
terminal (iTerm2/Ghostty/kitty default) any output while the user is scrolled
up snaps the viewport to the bottom, so reading the proposal in scrollback
ended with the terminal "scrolling back down after X seconds" (the user's
0/586 observation). After the guards: no 2J/3J anywhere, 0 bytes per spinner
tick, viewport never jumps, `--expect-fixed` passes (also verified at
rows=24 and rows=60).

`npm run check`: 0 errors. Full unit suite: 482 pass / 0 fail (the 383ae52
test surface; the three commits' tests were removed; no test asserted the
unbounded render).

## Out of scope

- Any new dialog machinery beyond the churn guard (windowing, internal
  scrolling, overlays beyond the restored 383ae52 options, alternate screen).
- Changes to lifecycle schemas, persistence, or audit logic.
- pi-tui / pi runtime internals (the guard works entirely within the
extension's render).
