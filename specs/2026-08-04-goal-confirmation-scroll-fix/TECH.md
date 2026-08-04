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
  editor for the dialog component inline in the main TUI buffer. The render is
  byte-identical to 383ae52 for content that fits; for content taller than
  the terminal it is tail-sliced to the churn-guard bound (below). Hardware
  cursor suppression during the dialog is retained (pre-regression).
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

## Churn guard (the one addition to the 383ae52 surface)

Goal tweak (user): the tall-dialog close was observed as “the window takes
~10s to scroll back to the bottom” — confirmed as pi-tui's shrink
full-render wiping the scrollback. Fix = bound the questionnaire render to
the terminal height; no new machinery.

```ts
// in runGoalQuestionnaire's factory, before the first render:
const tuiInfo = tui as unknown as { terminal?: { rows?: number }; previousLines?: string[] };
const terminalRows = tuiInfo.terminal?.rows;
const baseFrame = tuiInfo.previousLines?.length;          // pre-dialog frame (chat+footer+editor)
const maxDialogLines = terminalRows && baseFrame ? Math.max(10, terminalRows - baseFrame + 1) : undefined;

// in render(), after the width safety net, before caching:
if (maxDialogLines !== undefined && lines.length > maxDialogLines) {
    lines = lines.slice(lines.length - maxDialogLines);   // tail slice
}
```

### Why it works

The dialog occupies the editor slot, so the opened frame is
`preDialogFrame − 1 + dialogLines`. With
`dialogLines ≤ terminalRows − preDialogFrame + 1` the frame is at most
`terminalRows`, so `previousViewportTop` stays 0 and on close pi-tui's
shrink decision `targetRow < prevViewportTop` is never true, and the
clear-path guard `extraLines > height` is never hit — the `fullRender(true)`
(`\x1b[2J\x1b[H\x1b[3J`) branch is unreachable. The tail slice keeps the
options/footer (the actionable part) in view; for content that fits, the
slice is a no-op and the render is identical to 383ae52.

Guarded to real TUI instances only (`terminal.rows`/`previousLines` exist):
the mock TUI in unit tests renders unbounded, so the 383ae52 test surface is
untouched. Tradeoff (accepted in the tweak): for a dialog taller than the
terminal, the dialog head is not written to the buffer — scrollback contains
the tail only. Pre-regression wrote the head but the close wiped everything
with 2J+3J.

### Spinner guard (the second churn source — “terminal scrolls back down after X seconds”)

User replication: “agent presents goal → user scrolls up to read it all →
terminal scrolls back down after X seconds” (viewport lands at 0/586 = the
bottom). Root cause found headlessly by reproducing the real session: while
the questionnaire dialog is open, the agent run is still active
(`_isAgentRunActive`), so pi's `WorkingStatusIndicator` (`Loader` in the
statusContainer) keeps ticking every 80ms and calls `ui.requestRender()` on
every tick. Each tick rewrites the spinner frame line (~44 bytes, measured
220 bytes per 5 ticks) — and in iTerm2/Ghostty/kitty (default “scroll to
bottom on output”) **any output while the user is scrolled up snaps the
viewport to the bottom**. This also affected the task-list/escape overlays
(they composite over the base frame, whose spinner line still changes).

Fix (one call pair per dialog, 383ae52 rendering untouched):

```ts
// in each dialog's factory, after the hardware-cursor suppression:
ctx.ui.setWorkingVisible(false);
// on close (submit() for the questionnaire; dispose() for the overlays):
ctx.ui.setWorkingVisible(true);
```

`setWorkingVisible(false)` → `clearStatusIndicator("working")` → the Loader
interval is disposed and the statusContainer cleared (replaced by the static
2-line `IdleStatus` when `clearOnShrink` is on — no periodic output). The
restore re-shows the spinner only if the session is still streaming
(`setWorkingVisible(true)` checks `session.isStreaming`), so it is safe in
every close path. In headless/mock contexts `setWorkingVisible` is a no-op.

## Why scrollback is "in full" now

1. **No alternate screen** — the alt-screen module is gone; no dialog flow
   emits `\x1b[?1049h`/`l`.
2. **No full clears in the dialog flow** — opening a dialog appends lines
   (no 2J/3J); closing emits at worst `\r\x1b[2K` row clears; `2J/3J` only
   occur in a pre-existing pi-tui edge case (see below).
3. **Full content in the buffer** — the inline questionnaire renders the
   complete proposal for content that fits, so the user can scroll up and
   read all of it while the dialog is open; taller-than-screen proposals
   render the tail (churn guard), which stays in the buffer instead of being
   wiped by the old close-time 2J+3J. (The reverted overlay panel composited
   only the tail onto the frame, so scrollback never contained the full
   dialog.)
4. **No viewport yank for content that fits** — measured 0 scrolls on
   open/nav/close; the renderer's viewport model stays put.
5. **No periodic output while the user is reading** — the goal dialogs pause
   pi's working spinner for their duration (`setWorkingVisible(false)`), so
   the ~80ms tick writes that previously snapped a scrolled-up viewport back
   to the bottom are gone (measured 0 bytes per tick).

## Verification methodology

`experiments/scroll-repro/repro-dialog-render.mjs` (383ae52 harness) models
the differential renderer; `experiments/scroll-repro/before-after-churn.mjs`
(committed) drives the **real** `runGoalQuestionnaire` through the **real**
pi-tui with a fake terminal and the **real pi frame layout** (header, chat,
status-with-spinner, editor, footer), using pi's exact `showExtensionCustom`
sequence (editor swap; `showOverlay` for the centered dialogs). It tracks
viewport scrolls (`\n` while the cursor is on the bottom row, measured from
the pre-render cursor row), DECSET 1049, `2J`, `3J`, the post-close cursor
row, `previousLines` content presence, and — the spinner phase — the bytes
emitted by five working-spinner ticks while the user is scrolled up reading
the dialog. Report mode measures the current behavior; `--expect-fixed`
asserts no 2J/3J, no viewport yank, a 0-churn fits scenario, and 0 bytes per
spinner tick. Results are tabulated in PRODUCT.md (all scenarios 0-churn for
fits and for tall dialogs with a fitting chat; no 1049; no 2J/3J anywhere;
chat visible above; tall-dialog tail in the buffer; 0 spinner bytes).

## Pre-existing pi-tui edge case — now eliminated by the churn guard

pi-tui's differential renderer, on a frame shrink where the content's last
row moved above the previous viewport top (`targetRow < prevViewportTop`),
calls `fullRender(true)` which emits `\x1b[2J\x1b[H\x1b[3J` — screen +
scrollback cleared. At 383ae52 this fired on closing a questionnaire whose
opened frame exceeded the terminal height (proposal taller than the screen;
the original spec's "close scroll churn") — the cause of the user's observed
~10s scroll-back-to-bottom. pi-tui is a dependency untouched by the three
commits, so the behavior was pre-existing; the extension's only lever is
bounding the dialog render, which is exactly what the churn guard does (the
opened frame never exceeds the terminal height, so the shrink full-render
branch is unreachable). The guard is verified by
`experiments/scroll-repro/before-after-churn.mjs` (`--expect-fixed`), which
previously failed with `2J=1 3J=1` on the tall-dialog close and now passes
with no 2J/3J anywhere (rows 24/40/60).
