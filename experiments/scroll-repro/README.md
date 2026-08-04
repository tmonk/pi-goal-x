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
