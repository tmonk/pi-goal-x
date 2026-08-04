# Tech: Goal confirmation scroll fix — revert to 383ae52 with scrollback in full

## Final state: literal surface revert to 383ae52

The dialog and heading surface is byte-identical to commit `383ae52`
(`git diff 383ae52 -- extensions/` is empty), and the test/experiment surface
matches the 383ae52 tree as well (`git diff 383ae52 -- tests/ experiments/`
is empty).

### What the three commits had done (all reverted)

| Commit | Change | Reverted by |
| --- | --- | --- |
| b8cff1a | Dialogs in a DECSET 1049 alternate screen (`extensions/tui-alt-screen.ts` + opt-ins) | `git checkout 383ae52` (tui-alt-screen.ts deleted in 61db55e already) |
| a146edb | Full wrapped headings: `update_goal` echoes reason/summary; `set_goal_tasks` untruncated | `git checkout 383ae52` |
| 61db55e | Bottom-anchored overlay panels (`anchor:"bottom-center", width:"95%", maxHeight:"45%"`) + hand-rolled windowing (maxDialogHeight, scrollOffset/`MAX_SAFE_INTEGER` sentinel, ▴/▾ indicators, PgUp/PgDn/Home/End) | `git checkout 383ae52` |

### Restored code paths

- `extensions/goal-questionnaire.ts` — `runGoalQuestionnaire` uses plain
  `ctx.ui.custom(factory)` (no options). pi's `showExtensionCustom` swaps the
  editor for the dialog component inline in the main TUI buffer; render is
  unbounded (full proposal content in the buffer). Hardware cursor suppression
  during the dialog is retained (pre-regression).
- `extensions/goal-task-confirmation.ts` —
  `ctx.ui.custom(factory, { overlay: true, overlayOptions: { anchor: "center",
  width: "70%", minWidth: 50, maxHeight: "60%" } })`.
- `extensions/widgets/goal-escape-dialog.ts` —
  `ctx.ui.custom(factory, { overlay: true, overlayOptions: { anchor: "center",
  width: "70%", minWidth: 50, maxHeight: "50%" } })`.
- `extensions/goal-core-tools.ts` — `update_goal.renderCall` returns
  `Text(fg("toolTitle","update_goal ") + fg("muted", status))` (status only).
- `extensions/goal-task-tools.ts` — `set_goal_tasks.renderCall` returns
  `Text(fg("toolTitle","set_goal_tasks ") + fg("muted", truncateText(change_summary, 80) ?? `${tasks.length} tasks`))`;
  `truncateText` re-imported from `./goal-core.ts`.

### Removed surface (deleted)

- Tests added by the three commits: `tests/goal-dialog-panel.test.ts`,
  `tests/goal-questionnaire-panel.test.ts`, `tests/goal-lifecycle-rendering.test.ts`.
- `experiments/scroll-repro/validate-panel-overlay.mjs` (validated the
  reverted overlay panels) and the session's temporary repro scripts.
- `tests/.test-manifest.json` restored to the 383ae52 listing.

## Why scrollback is "in full" now

1. **No alternate screen** — the alt-screen module is gone; no dialog flow
   emits `\x1b[?1049h`/`l`.
2. **No full clears in the dialog flow** — opening a dialog appends lines
   (no 2J/3J); closing emits at worst `\r\x1b[2K` row clears; `2J/3J` only
   occur in a pre-existing pi-tui edge case (see below).
3. **Full content in the buffer** — the inline questionnaire renders the
   complete proposal; the user can scroll up and read all of it while the
   dialog is open. (The reverted overlay panel composited only the tail onto
   the frame, so scrollback never contained the full dialog.)
4. **No viewport yank for content that fits** — measured 0 scrolls on
   open/nav/close; the renderer's viewport model stays put.

## Verification methodology

`experiments/scroll-repro/repro-dialog-render.mjs` (383ae52 harness) models
the differential renderer; the final acceptance run drives the **real**
components through the **real** pi-tui with a fake terminal and pi's exact
`showExtensionCustom` sequence (editor swap for non-overlay, `showOverlay`
for the centered dialogs), tracking viewport scrolls (`\n` while the cursor
is on the bottom row), DECSET 1049, `2J`, and `3J` in the emitted stream, and
inspecting `previousLines` for full-content presence. Results are tabulated
in PRODUCT.md (all scenarios: 0 churn when content fits, no 1049, no 2J/3J on
open, full dialog content in the buffer, chat visible above; 2J/3J on close
only in the tall-dialog edge case below).

## Known pre-existing pi-tui edge case (documented, not introduced)

pi-tui's differential renderer, on a frame shrink where the content's last
row moved above the previous viewport top (`targetRow < prevViewportTop`),
calls `fullRender(true)` which emits `\x1b[2J\x1b[H\x1b[3J` — screen +
scrollback cleared. This fires when closing a questionnaire whose opened
frame exceeded the terminal height (a proposal taller than the screen; the
original spec's "close scroll churn"). pi-tui is a dependency untouched by
the three commits, so this behavior is present at 383ae52 and predates the
reverted work. The extension's only lever to avoid it would be bounding the
dialog render — new machinery, explicitly rejected ("revert exactly", "no new
dialog machinery"). Recorded for the user's decision at signoff.
