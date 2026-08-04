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

A self-contained module, `extensions/tui-alt-screen.ts`, augments the pi TUI
class at extension load time (`installTuiAltScreenSupport()`, called from
goal.ts): it adds `enterAlternateScreen(component)` / `exitAlternateScreen()` /
`isAlternateScreenActive()` to `TUI.prototype` (idempotent, feature-detected,
and deliberately inert unless called). This means the published extension
works against unpatched pi installs — no manual surgery on the global pi
package is required — and the same code doubles as the reference
implementation for an upstream pi-tui addition.

`runGoalQuestionnaire`, `showTaskListConfirmationDialog`, and
`showEscapeDialog` opt in from their `ctx.ui.custom` factories:

- `const altScreen = supportsAltScreen(tui)` (feature-detect);
- `tui.enterAlternateScreen(component)` before returning the component;
- a wrapped `finish` calls `tui.exitAlternateScreen()` BEFORE `done`, so pi's
  close path (restore editor + identity re-render) runs after the main screen
  has been restored;
- without support, the dialogs fall back to pi's default rendering (the
  previous behavior).

`exitAlternateScreen` also sets a one-shot suppression flag that makes the
identity re-render pi triggers after close write ZERO bytes: the terminal
restored the main screen byte-for-byte, and even the cosmetic
cursor-positioning write would yank a scrolled-up user back to the bottom.

The questionnaire gained height-aware rendering: the alternate buffer has no
terminal scrollback, so when its content exceeds the terminal height it shows
a ▴/▾-indicated window (bottom-anchored by default so the actionable options
and footer are immediately visible) and scrolls internally with
PgUp/PgDn/Home/End. The task-list confirmation and escape dialog kept their
boxed, bounded layouts (task confirmation previously used the overlay path;
both now render in the alternate screen for consistent reading-position
preservation).

Note: the running pi loads its own bundled pi-tui from
`/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/`.
The patch reaches pi's TUI instances because the extension imports
`TUI` from `@earendil-works/pi-tui` (a peerDependency, resolved to pi's copy)
and augments the shared prototype; if resolution ever yields a different
module instance, `supportsAltScreen` returns false and the dialogs degrade
gracefully to pi's default rendering instead of breaking.

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

## Tool-call headings (PR #11 port)

The old monolithic `extensions/goal.ts` (pre-simplification) rendered
`pause_goal`/`abort_goal` headings with `truncateText(args?.reason ?? "", 80)`;
PR #11 removed that truncation. On the simplification branch those tools no
longer exist, so the behavior is ported to the current renderCalls:

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

Execution paths, lifecycle schemas, and persistence are untouched — the
changes are renderCall-only.

## Validation plan

- `npm run check` — 0 errors; `npm run test:all` — 0 failures.
- New tests: `tests/tui-alt-screen.test.ts` (real TUI + fake terminal: smcup/
  rmcup emitted, render isolated, state restored, post-close identity render
  writes zero bytes, re-entrancy guard, idempotent install);
  `tests/goal-questionnaire-alt-screen.test.ts` (enter on open, exit before
  done, fallback, height windowing + PgUp/PgDn/Home/End scrolling);
  `tests/goal-dialog-alt-screen.test.ts` (task confirmation and escape dialog
  enter/exit ordering + fallback).
- Headless end-to-end validation: `experiments/scroll-repro/validate-alt-screen.mjs`
  runs the real TUI + patch with a buffer-aware ANSI emulator — main-screen
  scrolls on dialog open/close: 0/0 and 0 bytes after close (vs. 78/121 with
  the editor swap at chat=120/dialog=80).
- Manual terminal reproduction (documented in MILESTONES for interactive
  confirmation): run pi with a long conversation, scroll up to read earlier
  content, trigger propose_goal_draft — the viewport must not move when the
  Confirm dialog opens or closes.
- `tests/no-status-refresh-timer.test.ts` still green (no periodic redraws).
- `npm pack --dry-run` clean; `git diff --check` clean; CHANGELOG updated.
