# Tech: Goal confirmation scroll fix and full lifecycle-heading rendering

## Task-1 evidence — reproduction and root cause

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

### Why the overlay is not sufficient

pi's overlay path (`showOverlay` + `compositeOverlays`) composites the dialog
into the existing buffer in place — measured 0 viewport scrolls on open/close.
But any write to the main screen while the user is scrolled up still makes the
terminal exit scrollback mode (pi cannot detect or prevent this: the same
constraint f7a8e0d recorded, "Pi does not expose whether the terminal is
currently viewing scrollback"). The overlay therefore fixes the jump for the
following-mode user but cannot preserve the scrolled-up user's reading
position, which the product contract requires.

## Fix design

### Mechanism: alternate-screen modal (DECSET 1049)

The only main-screen-safe way to preserve scrollback position across a modal
is to render the modal in the terminal's alternate screen buffer:

- Enter: `\x1b[?1049h` — the terminal saves the main screen (content and
  scrollback view) untouched and switches to a fresh buffer with no scrollback.
- While active: all dialog rendering happens in the alternate buffer; nothing
  reaches the main screen, so the user's scroll position cannot be disturbed.
- Exit: `\x1b[?1049l` — the terminal repaints the main screen exactly as it
  was, cursor and scrollback position included ("as if the dialog never ran").

Widely supported (xterm, iTerm2, kitty, Ghostty, VSCode, alacritty, wezterm,
tmux). The alternate buffer has no scrollback in most terminals, so the dialog
component must fit the screen or scroll internally (see below).

### pi-tui change (required, in both the global pi install and the repo devDep copy)

Add alternate-screen modal support to `TUI` (dist/tui.js, 0.83.0, identical in
both locations):

- `enterAlternateScreen(component)`:
  - write `\x1b[?1049h`;
  - save the differential state (`previousLines`, `previousWidth`,
    `previousHeight`, `maxLinesRendered`, `previousViewportTop`, `cursorRow`,
    `hardwareCursorRow`);
  - reset the buffer state so the next render fully paints the alternate
    screen;
  - store the component and mark `altScreenActive = true`;
  - `render()` returns only the modal component's lines while active (the
    chat/footer/editor must not render into the alternate buffer).
- `exitAlternateScreen()`:
  - write `\x1b[?1049l` (terminal restores the main screen);
  - restore the saved differential state, so the next render diffs against the
    restored main-screen content and writes nothing until a real change occurs
    (no full clear, no scrollback erase);
  - `altScreenActive = false`.
- The questionnaire dialog is rendered full-width/full-screen inside the
  alternate buffer, so it must bound its own height and scroll internally when
  its content exceeds the terminal height (the current component renders
  unbounded lines; the task-list overlay already implements the scrolling
  pattern to reuse).

### pi-goal-x change

`runGoalQuestionnaire` and `showTaskConfirmation` opt in by calling
`tui.enterAlternateScreen(component)` from the `ctx.ui.custom` factory and
`tui.exitAlternateScreen()` before invoking `done` (wrapping the `done`
callback so the alternate screen is exited before pi's close path restores the
editor and requests a render). The `setShowHardwareCursor(false)` workaround
is retained as belt-and-braces but becomes mostly irrelevant since all dialog
writes are isolated.

Note: the running pi loads its own bundled pi-tui from
`/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/`,
so the patch must be applied there to take effect in the user's sessions, and
documented as an isolated pi-level patch (the published pi-goal-x package
cannot vendor pi internals through peerDependencies). The repo's devDependency
copy is patched identically so the unit suites exercise the same code.

## PR #11 port plan (task-3)

- `update_goal` renderCall: render `update_goal <status>` plus the full
  `reason` when present (wrapped by `Text`), never truncated.
- `set_goal_tasks` renderCall: drop `truncateText(change_summary, 80)` — render
  the full summary.
- `propose_goal_draft` renderCall already renders the full objective; add a
  regression assertion.
- Schemas/persistence/pause-block execution untouched; the fixed three/five
  tool profile untouched.
- Regression tests adapted from PR #11's `tests/goal-lifecycle-rendering.test.ts`
  to the current tool names, asserting full wrapped rendering for lifecycle
  reasons and proposal content (PR #11's "compact previews stay" assertion is
  intentionally inverted per the user's decision).

## Validation plan

- `npm run check` — 0 errors; `npm run test:all` — 0 failures.
- New tests: pi-tui alt-screen unit test (smcup/rmcup emitted, state saved and
  restored, post-restore identity render writes nothing); pi-goal-x dialog
  tests (factory enters/exits the alternate screen, exit precedes done);
  heading-rendering regression tests (full, wrapped, never truncated).
- `tests/no-status-refresh-timer.test.ts` still green (no periodic redraws).
- Manual terminal reproduction: long objective + scrollback review →
  propose_goal_draft → viewport must not move on open or close.
- `npm pack --dry-run` clean; `git diff --check` clean; CHANGELOG updated.
