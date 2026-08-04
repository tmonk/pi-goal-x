# Scroll reproduction harness (headless, no model usage)

`repro-dialog-render.mjs` drives the real `@earendil-works/pi-tui` differential
renderer with a fake terminal to measure viewport scrolling caused by the goal
confirmation dialog's open/close transitions.

Usage:

```
node experiments/scroll-repro/repro-dialog-render.mjs [chatLines] [dialogLines] [terminalRows]
```

It runs two scenarios against the same chat/footer/editor layout:

- **A — current behavior**: `ctx.ui.custom` without overlay replaces the
  editor with the tall dialog (pi's `showExtensionCustom` editor swap).
- **B — overlay**: the dialog is composited in place by `showOverlay`.

A small terminal emulator tracks the cursor row and counts real viewport
scrolls (`\n` while the cursor is on the bottom row).

Findings (rows=40): scenario A open causes 4–120 viewport scrolls depending on
chat/dialog length (the write burst at the bottom row); scenario B causes 0 in
all configurations. See `specs/2026-08-04-goal-confirmation-scroll-fix/` for
the full root-cause write-up.

## Before/after churn measurement

`before-after-churn.mjs` drives the **real** `runGoalQuestionnaire` through
the real pi-tui renderer with a fake terminal and the **real pi frame layout**
(header, chat, status-with-working-spinner, editor → dialog, footer),
mirroring pi's `showExtensionCustom` editor swap. It measures per scenario:

- open / nav / close terminal scrolls (a `\n` feed on the bottom row scrolls)
- `\x1b[2J` / `\x1b[3J` emissions (screen clear / scrollback erase)
- post-close cursor row and a window-at-bottom verdict
- scrollback content (dialog tail in the main buffer, chat visible above)
- **spinner phase**: pi's working spinner ticks every ~80ms and
  `requestRender()`s; while the dialog is open and the user is scrolled up
  reading the proposal, every tick's output snaps the terminal viewport back
  to the bottom (the reported "terminal scrolls back down after X seconds"
  symptom). The fixed dialogs pause the spinner
  (`setWorkingVisible(false)`), so ticks must emit 0 bytes.

Usage:

```
node experiments/scroll-repro/before-after-churn.mjs              # report mode (measures current behavior)
node experiments/scroll-repro/before-after-churn.mjs 24           # report mode, rows=24
node experiments/scroll-repro/before-after-churn.mjs --expect-fixed  # assertion mode
```

Scenarios: A) fits on screen, B) proposal taller than the terminal, C) chat
taller than the terminal plus a tall proposal.

Report mode exits 0 always and is the **before** measurement. `--expect-fixed`
is the **after** assertion and fails (exit 1) on either churn bug:

1. **Tall-dialog close 2J+3J** (383ae52 unbounded render): closing a dialog
   taller than the terminal triggers pi-tui's generic shrink full-render
   (`\x1b[2J\x1b[H\x1b[3J`), erasing terminal scrollback and disturbing the
   viewport — fixed by bounding the render to the terminal height (tail
   slice).
2. **Periodic output while reading** (spinner): while a goal dialog is open,
   pi's working spinner writes ~44 bytes/tick (measured: 220 bytes per 5
   ticks), and any output while the user is scrolled up snaps the viewport to
   the bottom — fixed by `setWorkingVisible(false)` for the dialog duration
   (0 bytes/tick after the fix).
