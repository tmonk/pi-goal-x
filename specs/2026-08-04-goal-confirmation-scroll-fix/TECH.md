# Tech: Goal confirmation scroll fix and full lifecycle-heading rendering

## Task-1 evidence — reproduction and root cause (original bug)

### Reproduction (measured, headless)

`experiments/scroll-repro/repro-dialog-render.mjs` drives the real
`@earendil-works/pi-tui` 0.83.0 differential renderer with a fake terminal,
simulating the pi interactive layout (tall chat + footer + editor container)
and the exact `ctx.ui.custom` open/close sequence pi performs in
`showExtensionCustom`: on open, `editorContainer.clear()` + `addChild(dialog)`;
on close, the reverse. A terminal emulator tracks the cursor row and counts
viewport scrolls (`\n` while the cursor is on the bottom row).

| Scenario (rows=40) | Current (editor swap) open | Current close | Overlay open | Overlay close |
| --- | --- | --- | --- | --- |
| chat=60, dialog=34 | 32 scrolls | 0 | 0 | 0 |
| chat=120, dialog=80 (long proposal) | 78 scrolls | 121 | 0 | 0 |
| chat=30, dialog=34 | 24 scrolls | 0 | 0 | 0 |
| chat=10, dialog=34 | 4 scrolls | 0 | 0 | 0 |

### Root cause

1. `runGoalQuestionnaire` opens its dialog with `ctx.ui.custom(factory)` and
   **no options**. pi's `showExtensionCustom` therefore *replaces the editor
   inside the main TUI buffer* with the dialog component, whose render is
   unbounded (long proposals wrap into 40–120+ lines).
2. pi-tui's differential renderer writes the newly appended region as
   `\x1b[2K`-clear + line + `\r\n` per row, starting from the cursor's current
   position at the terminal's bottom row. Each `\r\n` while the cursor is on
   the bottom row scrolls the terminal viewport once — measured at up to ~120
   scrolls for a long proposal, ~32 for a typical one.
3. If the user is reading scrollback when the dialog opens (the exact
   scenario reported: reviewing a long objective / earlier context while asked
   to accept a goal), the first write burst makes the terminal exit scrollback
   mode and jump the viewport to the bottom — the user is "yanked out" and
   loses their reading position.
4. The dialog close performs the inverse buffer shrink, writing more lines at
   the bottom edge (121 scrolls for a long proposal at close).

### Why the previous fixes did not fully work

- f7a8e0d removed the 1s `STATUS_REFRESH_MS` timer that redrew the status bar +
  widget periodically. That eliminated the *periodic* yank, but the dialog
  open/close transitions still emit large write bursts — the yank persists at
  exactly the moment the user is asked to accept a goal.
- `tui.setShowHardwareCursor(false)` inside `runGoalQuestionnaire` reduces the
  ~60fps ANSI cursor-positioning noise during the dialog, but does not change
  the open/close buffer churn that causes the yank.

## Attempt 1: alternate-screen modal (DECSET 1049) — REVERTED

### What was built

`extensions/tui-alt-screen.ts` augmented the pi TUI prototype with
`enterAlternateScreen`/`exitAlternateScreen`/`isAlternateScreenActive`
(DECSET 1049), and all three dialogs (`runGoalQuestionnaire`,
`showTaskListConfirmationDialog`, `showEscapeDialog`) opted in: enter the
alternate buffer on open, exit before `done`, with a one-shot suppression so
the post-close identity re-render wrote zero bytes. The questionnaire gained
height-aware windowing (▴/▾ indicators + PgUp/PgDn/Home/End). This made the
dialog render into a buffer where NOTHING reaches the main screen: measured 0
viewport scrolls on open/close and 0 bytes after close
(`experiments/scroll-repro/validate-alt-screen.mjs`).

### Why it was reverted (measured, headless)

The alternate buffer has **no terminal scrollback**: while the dialog is open
the user cannot scroll up at all, and the main screen (with the chat history)
is blanked. `experiments/scroll-repro/validate-panel-overlay.mjs` measures
the flow: open emits `\x1b[?1049h` (alternate buffer active — scroll-up dead,
history invisible), and only the close's `\x1b[?1049l` restores the main
screen. The user explicitly rejected this: "the questionnaire now takes over
the screen, the user should be able to see all the history when it comes up"
and "we are currently unable to scroll up at all when these panels show".
Strict scrollback-position preservation (the alt screen's one advantage) is
traded for visible history + usable scrollback, per the user's decision.

## Attempt 2 (final design): bounded bottom-anchored overlay panels

### Mechanism

All three dialogs open via pi's built-in overlay path —
`ctx.ui.custom(factory, { overlay: true, overlayOptions })` — which
`interactive-mode.showExtensionCustom` forwards to `TUI.showOverlay`:

- `showOverlay` auto-focuses the component (`setFocus`) and saves the editor
  as `preFocus`; `hide()` restores editor focus and requests a render. The
  component receives keyboard input exactly like the non-overlay path.
- `compositeOverlays` renders the component at the resolved width, caps it to
  `maxHeight` (`overlayLines.slice(0, maxHeight)`), and composites the lines
  INTO the existing main-screen frame at a screen-relative row
  (`resolveOverlayLayout`, `anchor: "bottom-*"` → bottom of the terminal).
  **The frame length never grows** — the overlay replaces the bottom rows
  in place — so the differential renderer performs only positioned rewrites
  (`\x1b[<n>A/B`, `\x1b[2K`), never `\r\n`-at-bottom-row appends.
- Measured (`experiments/scroll-repro/validate-panel-overlay.mjs`, real TUI,
  fake terminal, buffer-aware emulator): **0 main-screen scrolls on open, on
  in-dialog navigation, and on close** — for both a long chat (120 lines) and
  a short chat (10 lines); no `\x1b[?1049` anywhere; no `\x1b[2J` full
  clears. History above the panel stays visible and terminal scrollback is
  fully usable while the dialog is open.

### Panel geometry and windowing

- `overlayOptions`: `{ anchor: "bottom-left" | "bottom-center", width: "95%",
  maxHeight: <percent of terminal height> }` — the panel occupies the bottom
  ~40–50% of the screen at most; the chat history fills everything above.
- The questionnaire keeps its height-aware rendering but re-binds the window
  to the panel bound: `maxDialogHeight = max(10, floor(terminalRows * 0.45))`
  (previously `terminalRows - 2`, which assumed a full-screen alternate
  buffer). Content taller than the panel windows internally with ▴/▾
  indicators and PgUp/PgDn/Home/End, defaulting to the actionable
  options/footer visible (bottom-anchored). The TUI's own `maxHeight` slice
  is a defensive second cap.
- The task-list confirmation and escape dialog restore their pre-alt-screen
  overlay configuration (which the user remembers as "as before"), re-anchored
  to the bottom and bounded.

### What is removed

- `extensions/tui-alt-screen.ts` (the prototype patch) — deleted; no dialog
  uses the alternate screen anymore. `installTuiAltScreenSupport()` is removed
  from `extensions/goal.ts`.
- `tests/tui-alt-screen.test.ts` — deleted (its contract no longer exists).
- `tests/goal-questionnaire-alt-screen.test.ts` and
  `tests/goal-dialog-alt-screen.test.ts` — rewritten to assert the overlay
  panel behavior (bounded, bottom-anchored, no 1049/2J, windowing).
- The `Container`/`TUI` re-exports added to `tests/stubs/pi-tui.ts` are kept
  only if still needed by the rewritten tests.

### Design notes

- The overlay path is pi's own mechanism, used by pi's built-in dialogs — no
  pi SDK/TUI patch is required and none is made. The extension only passes
  `overlay: true` + `overlayOptions` (SDK-supported types).
- `tui.setShowHardwareCursor(false)` during dialogs is retained (reduces the
  ~60fps cursor-positioning noise); it is belt-and-braces, not the fix.
- The panel's in-place rewrites do not scroll the terminal even when the user
  is scrolled up; the panel itself emits no output between key events, so a
  scrolled-up user can read history above the panel at any time. (Opening the
  panel does write at the bottom, which by terminal semantics brings a
  scrolled-up user back to the bottom — the inherent trade-off the user
  accepted in favor of visible history + usable scrollback.)

## PR #11 port (task-3, complete)

- `update_goal` (`extensions/goal-core-tools.ts`): the heading is
  `update_goal <status>` plus the COMPLETE agent content — `reason` for
  `paused`/`blocked` (colored `warning`), `completion_summary` for
  `complete` — wrapped by pi's `Text` component. No `truncateText`, no
  status-only degradation.
- `set_goal_tasks` (`extensions/goal-task-tools.ts`): `change_summary`
  renders in full (previously 80-char truncation); falls back to
  `<n> tasks` when absent. PR #11's "compact previews stay" carve-out is
  dropped per the user's decision — every heading is full.
- `propose_goal_draft` (`extensions/goal-drafting.ts`): already full.
- Grep-verified: no goal tool `renderCall` uses `truncateText`; remaining
  truncations are in non-heading surfaces (goal widget rows, pool/compaction
  summaries, prompts) and are intentionally unchanged.
- Execution paths, lifecycle schemas, and persistence are untouched — the
  changes are renderCall-only.

## Validation plan

- `npm run check` — 0 errors; `npm run test:all` — 0 failures.
- New/adapted tests: `tests/goal-questionnaire-panel.test.ts` (5 tests) and
  `tests/goal-dialog-panel.test.ts` (4 tests) assert — dialogs are opened with
  `overlay: true` + bounded `overlayOptions` (`anchor: "bottom-center"`,
  `maxHeight: "45%"`), rendered height is bounded, the questionnaire's
  windowing pages with PgUp/PgDn/Home/End (▴/▾ indicators), results resolve
  through done, and the hardware cursor is restored on dispose.
- Headless end-to-end validation: `experiments/scroll-repro/validate-panel-overlay.mjs`
  — 0/0/0 main-screen scrolls on open/nav/close, no 1049/2J, for long
  (120-line) and short (10-line) chats.
- Manual terminal reproduction (documented in MILESTONES for interactive
  confirmation): run pi with a long conversation, scroll up to read earlier
  content, trigger propose_goal_draft — the dialog appears as a bottom panel,
  the history above stays visible, scroll-up keeps working while the dialog is
  open, and closing leaves the viewport where it was.
- `tests/no-status-refresh-timer.test.ts` still green (no periodic redraws).
- `npm pack --dry-run` clean; `git diff --check` clean; CHANGELOG updated.
