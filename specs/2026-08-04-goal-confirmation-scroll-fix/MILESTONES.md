# Milestones: Goal confirmation scroll fix and full lifecycle-heading rendering

## 2026-08-04 — Task-1 complete: reproduction and root cause

Goal confirmed with the user (propose_goal_draft):
- Fix the accept-goal dialog viewport yank, preserving scrollback reading
  position (user answered: "yanked out of scrollback where I was reading").
- PR #11 port: full behavior port, and — per user decision — the "compact
  previews stay" carve-out is dropped: ALL goal tool-call headings render full
  content, wrapped.
- Fix boundary (user answered): wherever the root cause is, including a pi
  TUI/SDK patch.

### Evidence gathered

- `experiments/scroll-repro/repro-dialog-render.mjs` — drives the real
  pi-tui 0.83.0 differential renderer headlessly with a fake terminal +
  terminal-emulation scroll counter. Current editor-swap dialog open causes
  up to ~120 viewport scrolls for a long proposal (78 open / 121 close at
  chat=120, dialog=80; 32 at chat=60, dialog=34). The overlay variant causes
  0 scrolls in every configuration tested.
- Traced pi's `showExtensionCustom` (interactive-mode.js): non-overlay
  `ctx.ui.custom` replaces the editor inside the main TUI buffer; the dialog
  render is unbounded (proposal wraps into 40–120+ lines).
- Verified the global pi install bundles its own pi-tui 0.83.0, byte-identical
  to the repo devDep copy — one patch applies to both.
- Verified no mouse reporting in pi-tui (wheel scrolling is terminal-native and
  does not trigger re-renders); the yank is the open/close write bursts.
- Web-verified DECSET 1049 alt-screen semantics: enter saves the main screen
  (content + scrollback view); exit restores it exactly; supported by xterm,
  iTerm2, kitty, Ghostty, VSCode, alacritty, wezterm, tmux.

### Root-cause conclusion

The dialog is rendered into the main TUI buffer via an editor swap; the
renderer's bottom-edge write bursts scroll the terminal viewport. A scrolled-up
user is yanked by the first write. Previous fixes (removed 1s status timer;
hardware-cursor suppression) did not touch this open/close churn. The overlay
path removes the churn but cannot preserve a scrolled-up user's position (any
main-screen write exits scrollback). Only an alternate-screen modal (DECSET
1049) satisfies the contract.

### Decisions

- Fix = pi-tui alt-screen modal support (`enterAlternateScreen` /
  `exitAlternateScreen`), patched in both the global pi install and the repo
  devDep copy, opted into by pi-goal-x's `runGoalQuestionnaire` and
  `showTaskConfirmation`.
- `set_goal_tasks` task confirmation is already overlay-based (0 scrolls) but
  will move to the alt screen with the rest for consistent reading-position
  preservation.
- The questionnaire must gain internal scrolling when its content exceeds the
  terminal height (the alternate buffer has no scrollback; the task-list
  overlay's scrolling pattern is the template).

## Next

- Task-2: implement the pi-tui alt-screen patch + pi-goal-x opt-in with
  regression coverage.
- Task-3: PR #11 port (full wrapped headings, no truncation).
- Task-4: adapted regression tests, CHANGELOG, docs, full validation.

## 2026-08-04 — Task-2 implemented: alternate-screen dialogs, fully isolated

### Implemented

- `extensions/tui-alt-screen.ts`: self-contained, idempotent augmentation of
  the pi TUI prototype (`installTuiAltScreenSupport`) adding
  `enterAlternateScreen` / `exitAlternateScreen` / `isAlternateScreenActive`
  (DECSET 1049), with differential-state save/restore, a re-entrancy guard,
  and a one-shot suppression of the post-close identity render's cosmetic
  cursor write (zero bytes reach the main screen after the dialog closes).
  Installed from `extensions/goal.ts` at load; feature-detected at use, so
  unpatched environments fall back to pi's default dialogs.
- `extensions/goal-questionnaire.ts`: `runGoalQuestionnaire` enters the
  alternate screen on open and exits before `done`; gained height-aware
  rendering with internal scrolling (▴/▾ indicators, PgUp/PgDn/Home/End,
  bottom-anchored default so options/footer are visible immediately).
- `extensions/goal-task-confirmation.ts` and
  `extensions/widgets/goal-escape-dialog.ts`: same alt-screen wiring
  (replacing their previous overlay options).
- `tests/stubs/pi-tui.ts`: re-exports `Container` and `TUI` from
  `dist/tui.js` so the test suites can exercise the real class.

### Validation

- `npm run check` — 0 errors.
- `npm run test:unit` — 494 pass / 0 fail (incl. 12 new tests:
  `tests/tui-alt-screen.test.ts` ×5, `tests/goal-questionnaire-alt-screen.test.ts`
  ×4, `tests/goal-dialog-alt-screen.test.ts` ×3).
- `npm run test:integration` — green; `npm run test:serial` — 494 pass / 0 fail.
- `tests/.test-manifest.json` regenerated; `test:selfcheck` green.
- `experiments/scroll-repro/validate-alt-screen.mjs` (real TUI + patch,
  buffer-aware ANSI emulation): main-screen scrolls on dialog open/close are
  0/0 and the post-close identity render writes 0 bytes — vs 78/121 scrolls
  with the old editor swap at chat=120/dialog=80.
- `tests/no-status-refresh-timer.test.ts` still green (no periodic redraws).

### Manual reproduction (for interactive confirmation)

1. Run pi with the patched extension in a real terminal (iTerm2/kitty/etc.).
2. Have a long conversation / long goal objective so the chat buffer exceeds
   the screen, then scroll up to read earlier content.
3. Invoke /goal and let the agent propose a goal (propose_goal_draft).
4. Expected: the terminal viewport does NOT move when the Confirm / Continue
   Chatting dialog opens or closes; the dialog occupies a blank full screen;
   PgUp/PgDn scroll inside the dialog when the proposal exceeds the terminal
   height; after confirming, the user's scrollback view is exactly where it
   was before the dialog.

## 2026-08-04 — Task-3 complete: PR #11 port (full wrapped headings)

### Implemented

- `extensions/goal-core-tools.ts` — `update_goal` renderCall now renders the
  complete agent content: full `reason` for `status=paused`/`blocked`
  (colored warning), full `completion_summary` for `status=complete`;
  wrapped by the Text component, never truncated. Previously the heading
  showed only the status word ("update_goal paused").
- `extensions/goal-task-tools.ts` — `set_goal_tasks` renderCall no longer
  passes `change_summary` through `truncateText(..., 80)`; renders the full
  summary (falls back to a task count when absent). `truncateText` import
  removed from the file.
- `extensions/goal-drafting.ts` — `propose_goal_draft` already rendered the
  full objective; unchanged (now covered by regression tests).
- Verified by grep: no `renderCall` in any goal tool module uses
  `truncateText`; remaining truncations live only in non-heading surfaces
  (widget rows, pool/compaction lists, prompts) which are out of scope.

### Tests

- `tests/goal-lifecycle-rendering.test.ts` (7 tests) — adapted from PR #11's
  test to the five-tool surface: full paused reason >80 chars, full blocked
  reason, full completion summary, untruncated `set_goal_tasks` summary (the
  PR #11 "compact previews stay" assertion is inverted per the user's
  decision), full `propose_goal_draft` objective, task-count fallback, and
  narrow-width (40-col) wrapping that keeps full content and never ends in
  "...".

### Validation

- `npm run check` — 0 errors; `npm run test:unit` / `npm run test:serial` —
  501 pass / 0 fail; `test:selfcheck` OK (43 unit entries, manifest
  regenerated); `tests/no-status-refresh-timer.test.ts` green.
- Fixed two tsc errors surfaced in the task-2 test files (`Terminal` cast in
  `tests/tui-alt-screen.test.ts`, `Theme` typing in
  `tests/goal-dialog-alt-screen.test.ts`).
- CHANGELOG: new `[Unreleased]` section documenting both the scroll fix and
  the full-heading behavior.

## 2026-08-04 — PIVOT: alt-screen dialogs reverted; task-1 of the panel rework complete

### User-reported regression (accepted)

The DECSET 1049 alternate-screen fix took over the whole screen and disabled
terminal scrollback while any dialog was open: "the questionnaire now takes
over the screen, the user should be able to see all the history when it comes
up. it should be a panel at the bottom, as before" and "we are currently
unable to scroll up at all when these panels show!". The alternate buffer has
no terminal scrollback (and the main screen with the history is blanked), so
scroll-up is dead while the dialog is open. Goal tweaked to require bottom
panels in the main screen with usable scrollback.

### Task-1: measurement (`experiments/scroll-repro/validate-panel-overlay.mjs`)

Real pi-tui 0.83.0 + fake terminal, buffer-aware ANSI emulator, rows=40,
chat=120 (plus a short-chat=10 check):

- ALT SCREEN (current): open emits `\x1b[?1049h` (alternate buffer active →
  no scrollback while open, main screen blanked); only the close's `\x1b[?1049l`
  restores the main screen. Scroll-up dead during the dialog.
- OVERLAY PANEL (proposed, `overlay: true` + `anchor: bottom-*` +
  `maxHeight` bound): **0 main-screen scrolls on open, 0 on in-dialog
  navigation, 0 on close** (long and short chat); no 1049, no `\x1b[2J`;
  history above stays visible; scrollback usable.

### Root cause of the overlay's stability

`compositeOverlays` composites the panel INTO the existing main-screen frame
at a bottom-anchored row; `maxHeight` caps the panel. The frame length never
grows, so the differential renderer only does positioned rewrites
(`\x1b[<n>A/B`, `\x1b[2K`) — never `\r\n`-at-bottom-row appends — hence zero
scroll churn. `showOverlay` auto-focuses the component (keyboard input works)
and restores editor focus on hide. No pi SDK/TUI patch needed.

### Decision (recorded)

Delete `extensions/tui-alt-screen.ts` and `tests/tui-alt-screen.test.ts`;
remove `installTuiAltScreenSupport()` from `extensions/goal.ts`; rewrite the
alt-screen test files as overlay-panel tests; keep the questionnaire's
windowing but re-bind `maxDialogHeight` to the panel bound
(`max(10, floor(terminalRows * 0.45))`); restore the task-confirmation /
escape-dialog overlay configuration (pre-alt-screen), re-anchored to the
bottom and bounded.

### Next

- Task-2: implement the overlay-panel rendering in all three dialogs; delete
  tui-alt-screen.ts; npm run check 0 errors.
- Task-3: adapt/replace tests; task-4: CHANGELOG + docs + full validation.

## 2026-08-04 — Tasks 2–3 complete: bounded bottom overlay panels implemented

### Implemented

- All three dialogs now open via pi's built-in overlay path:
  `ctx.ui.custom(factory, { overlay: true, overlayOptions: { anchor:
  "bottom-center", width: "95%", maxHeight: "45%" } })` — main-screen panels,
  no alternate buffer, no full clears. `showOverlay` auto-focuses the
  component (keyboard works) and restores editor focus on close.
- `extensions/goal-questionnaire.ts`: removed the alt-screen enter/exit;
  re-bound the height window to the panel: `maxDialogHeight =
  Math.max(8, Math.floor(terminalRows * 0.45))` (was `terminalRows - 2` for
  the full-screen buffer); removed the trivial `finish` passthrough; kept the
  ▴/▾ + PgUp/PgDn/Home/End windowing and the hardware-cursor suppression.
- `extensions/goal-task-confirmation.ts` and
  `extensions/widgets/goal-escape-dialog.ts`: removed the alt-screen
  enter/exit/finish; restored the overlay configuration (pre-alt-screen look),
  re-anchored bottom-center and bounded.
- Deleted `extensions/tui-alt-screen.ts`, removed
  `installTuiAltScreenSupport()` from `extensions/goal.ts`, deleted
  `tests/tui-alt-screen.test.ts`, reverted the `Container`/`TUI` re-exports
  added to `tests/stubs/pi-tui.ts` (no longer needed).

### Tests (task-3)

- `tests/goal-questionnaire-panel.test.ts` (5 tests): custom() options assert
  `overlay: true`, `anchor: "bottom-center"`, `maxHeight: "45%"`; rendered
  output is windowed to the panel bound (rows=40 → ≤18 lines) with ▴
  indicator and footer visible; PgUp/PgDn/Home/End page the window; Enter
  submits the recommended option through done.
- `tests/goal-dialog-panel.test.ts` (4 tests): task confirmation and escape
  dialog open as bounded bottom-anchored overlays, render bounded, resolve
  through done, and restore the hardware cursor on dispose; default-path
  rendering still works.
- Old alt-screen test files deleted; manifest regenerated (42 unit entries);
  `test:selfcheck` OK.

### Validation

- `npm run check` — 0 errors.
- `npm run test:unit` / `npm run test:serial` — 497 pass / 0 fail;
  `npm run test:integration` — 28 pass / 0 fail;
  `tests/no-status-refresh-timer.test.ts` — green.
- `experiments/scroll-repro/validate-panel-overlay.mjs` — 0/0/0 main-screen
  scrolls on open/nav/close, no 1049/2J, long and short chats (task-1).

### Remaining (task-4)

- Full validation: `npm run test:all`, `npm pack --dry-run`, `git diff --check`.
- CHANGELOG updated (panel entry replaces the alt-screen entry); PRODUCT.md
  status updated. Manual terminal reproduction documented below.

### Manual reproduction (for interactive confirmation)

1. Run pi with the extension in a real terminal (iTerm2/kitty/etc.).
2. Have a long conversation / long goal objective so the chat buffer exceeds
   the screen.
3. Invoke /goal and let the agent propose a goal (propose_goal_draft).
4. Expected: the Confirm dialog opens as a bottom panel (≤ ~45% of the
   terminal height); the chat history above stays visible; the user can scroll
   up in the terminal scrollback at any time, including while the dialog is
   open; PgUp/PgDn scroll inside the panel when the proposal exceeds the panel
   height; closing the dialog leaves the viewport where it was (no jump).

---

## Milestone (final): full-surface revert to 383ae52, scrollback in full

Date: same session. User directive (two clarifications): "by revert, I mean
go back to 383ae52… just allowing scrollback!" and "revert to 383ae52 AND
enable scrollback IN FULL". This supersedes the overlay-panel direction above.

### Decision

The overlay/windowing machinery (61db55e) caused the reported "goal questions
overlap text at the bottom" regression (the bottom-center panel composites
via pi's `compositeLineAt`, which only replaces columns `[col, col+width)` —
chat/footer/editor text bled through on panel rows). The user rejected
bounding the dialog render ("by revert, I mean go back to 383ae52") and the
alt-screen and full-heading work. Final: the goal dialog + heading surface is
byte-identical to 383ae52, and terminal scrollback is verified fully enabled.

### Root cause of the overlap (documented)

The 61db55e panel used `overlayOptions: { anchor: "bottom-center", width:
"95%", maxHeight: "45%" }`. pi-tui's `compositeOverlays`/`compositeLineAt`
replaces only the panel's column span of each covered base line; the base
line's left/right margins and the frame text (chat, `─ footer ─`, `❯`
editor prompt) remain visible on panel rows. For a 120-col terminal with a
95%-wide panel, chat text bleeds through the panel's left and right edges —
the visible overlap.

### Implementation (smallest possible change)

- `git checkout 383ae52 --` the five extension files (`goal-questionnaire.ts`,
  `goal-task-confirmation.ts`, `widgets/goal-escape-dialog.ts`,
  `goal-core-tools.ts`, `goal-task-tools.ts`); `extensions/goal.ts` verified
  identical already. `git diff 383ae52 -- extensions/` → empty.
- Deleted the three tests added by the commits (`goal-dialog-panel.test.ts`,
  `goal-questionnaire-panel.test.ts`, `goal-lifecycle-rendering.test.ts`),
  restored `tests/.test-manifest.json`; `git diff 383ae52 -- tests/` → empty.
- Deleted `experiments/scroll-repro/validate-panel-overlay.mjs` and the
  session's temporary repro scripts, restored README.md; `git diff 383ae52 --
  experiments/` → empty. The 383ae52 harness
  (`repro-dialog-render.mjs` + README.md) remains.

### Validation (task-1 evidence, real components + real renderer)

Drove the real `runGoalQuestionnaire` / `showTaskConfirmation` /
`showEscapeDialog` through the real pi-tui differential renderer with a fake
terminal (rows=40, cols=120), mirroring pi's `showExtensionCustom` (editor
swap for non-overlay, `showOverlay` for the centered dialogs). Emulator
tracked viewport scrolls, DECSET 1049, `2J`, `3J`; `previousLines` inspected
for full content.

- short chat + short proposal (fits): open 0 / nav 0 / close 0 scrolls, no
  1049, no 2J/3J, full dialog in buffer, chat visible above.
- short chat + long proposal (73-line): open 87 scrolls (pre-existing
  383ae52 churn), nav 0, close 0 scrolls; full 40 detail + 30 task lines in
  buffer; chat above. Close emits 2J+3J — pre-existing pi-tui shrink path
  (`targetRow < prevViewportTop` → `fullRender(true)`), present at 383ae52,
  outside the reverted surface (the original spec's "close scroll churn").
- long chat (120) + short proposal: open 13 scrolls (pre-existing), nav 0,
  close 0, no clears.
- task-list confirmation / escape dialog (centered overlays): open 0 / close
  0 scrolls, no 1049, no 2J/3J, chat visible.
- `npm run check`: 0 errors. Unit suite: 482 pass / 0 fail (383ae52 test
  surface).

### Finding for the user (signoff decision)

Closing a questionnaire whose opened frame exceeded the terminal height
emits pi-tui's generic shrink `\x1b[2J\x1b[H\x1b[3J`, erasing terminal
scrollback. Present at 383ae52 (pi-tui untouched by the three commits);
fixing it requires either bounding the dialog render (rejected: new
machinery) or touching the pi-tui dependency (out of scope). Documented in
PRODUCT.md/TECH.md; left to the user's call at signoff.

---

## Milestone (final): churn guard — tall-dialog close no longer wipes scrollback

Date: same session (goal tweak). User observed the tall-dialog edge case in a
real terminal: closing a long proposal's questionnaire left the window taking
~10s (vs ~1s) to scroll back to the bottom — the 2J+3J shrink full-render.
User direction via `/goal-tweak`: keep the 383ae52 surface, **build a simple
programmatic before/after test first** ("We now know how to fix it, so we can
see before/after"), then apply the smallest fix.

### Task-1: committed before/after harness

`experiments/scroll-repro/before-after-churn.mjs` — drives the real
`runGoalQuestionnaire` through the real pi-tui renderer with a fake terminal
(mirroring pi's `showExtensionCustom` editor swap), printing per scenario:
open/nav/close scrolls, 2J/3J emissions, post-close cursor row + yank
verdict, and scrollback content. One command; report mode captures the
**before** state; `--expect-fixed` asserts the **after** state (exit 1 while
broken). Key emulator detail: the start row must be captured **before** the
render (`hardwareCursorRow − previousViewportTop` pre-render); capturing it
after over-counts scrolls (the diff renderer writes `\r\n` after each line
but none after the last). Before-state on the unbounded render: fits 0/0/0;
short chat + 73-line proposal open 87 / close 2J=1 3J=1; long chat (120) +
long proposal close 2J=1 3J=1.

### Task-2: the fix (smallest possible)

`extensions/goal-questionnaire.ts` (+17/−1): bound the render to the terminal
height with a tail slice —
`maxDialogLines = max(10, terminal.rows − previousLines.length + 1)`
(pre-dialog frame = chat + footer + editor), applied as
`lines.slice(lines.length − maxDialogLines)` before caching. The opened frame
never exceeds the terminal height, so pi-tui's shrink `fullRender(true)`
(`targetRow < prevViewportTop` / `extraLines > height`) is unreachable:
no 2J/3J, no viewport jump. Guarded to real TUI dimensions only, so the mock
TUI unit tests (and the 383ae52 test surface) are untouched; content that
fits renders byte-identically. Tradeoff (accepted in the tweak): a
taller-than-screen dialog shows the tail (options/footer + last content);
its head is not written to the buffer.

### Task-3: before/after delta

| Scenario (rows=40) | before | after |
| --- | --- | --- |
| fits | 0/0/0, full content | 0/0/0, full content (identical) |
| short chat + long proposal | open 87, close 2J=1 3J=1 (scrollback wiped) | open 0 / nav 0 / close 0, no 2J/3J |
| long chat (120) + long proposal | open 87, close 2J=1 3J=1 | open 9 (chat alone exceeds screen — pre-existing) / 0 / 0, no 2J/3J |

`--expect-fixed` passes (exit 0). Also verified at rows=24 and rows=60 (0
churn, no 2J/3J). `npm run check` 0 errors; unit suite 482 pass / 0 fail (no
test asserted the unbounded render). Working tree committed at 3/5 tasks
(harness + fix + README).

### Task-4: docs

PRODUCT.md/TECH.md updated (churn guard, before/after table, tail-slice
tradeoff replacing the "known edge case" note); CHANGELOG.md Unreleased gains
`### Fixed` entries for the guard and the harness; MILESTONES.md this entry.

### Remaining

Task-5 signoff: user visual confirmation in a real terminal — tall proposal
open/close clean, window returns to the bottom promptly, scrollback readable,
383ae52 surface intact for content that fits.

---

## Milestone (final, part 2): the real replication — “terminal scrolls back down after X seconds”

User signoff rejected the part-1 fix: “No - it still scrolls back down to
scroll 0/586 (in the example). You clearly have not been able to reproduce
this.” Clarification: “0/XXX is the bottom of the viewport” and “the
replication is: agent presents goal → user scrolls up to read it all →
terminal scrolls back down after X seconds.”

### Reproduction (committed harness upgraded)

Root cause found by driving the REAL questionnaire through the REAL pi-tui
with the REAL pi frame layout (header, chat, status-with-spinner, editor →
dialog, footer) and simulating pi's working spinner (Loader: 80ms tick →
`ui.requestRender()`): while the questionnaire dialog is open, the agent run
is still active (`_isAgentRunActive`), so the spinner keeps ticking and each
tick rewrites the spinner line (~44 bytes; measured 220 bytes per 5 ticks).
In iTerm2/Ghostty/kitty (default “scroll to bottom on output”), **any output
while the user is scrolled up snaps the viewport to the bottom** — the
“0/586” the user saw. The centered task-list/escape overlays had the same
problem (their composite frame includes the changing spinner line). The
earlier harness missed it because it never simulated the spinner or the real
layout.

### Fix (smallest possible)

Each goal dialog calls `ctx.ui.setWorkingVisible(false)` on open and
`setWorkingVisible(true)` on close (`submit()` for the questionnaire,
`dispose()` for the overlays) — `clearStatusIndicator` disposes the Loader
interval and empties the statusContainer (static 2-line IdleStatus when
clearOnShrink), so the ~80ms tick writes stop entirely. Headless/mock
contexts treat it as a no-op. The 383ae52 rendering is untouched.

### Before/after delta (harness, rows=40)

| Scenario | before (spinner active) | after (spinner paused) |
| --- | --- | --- |
| fits | 220 bytes / 5 ticks → snap | 0 bytes / 5 ticks, no snap |
| short chat + long proposal | 220 bytes / 5 ticks → snap | 0 bytes / 5 ticks |
| long chat (120) + long proposal | 220 bytes / 5 ticks → snap | 0 bytes / 5 ticks |
| task-list / escape overlays | ~215 bytes / 5 ticks → snap | 0 bytes / 5 ticks |

Combined with part-1 (tail-slice close guard): no 2J/3J anywhere, 0 bytes per
spinner tick, fits scenario byte-identical and 0-churn (verified rows
24/40/60). `npm run check` 0 errors; unit suite 482 pass / 0 fail;
`--expect-fixed` exit 0. Committed; docs updated.

### Signoff (task 5/5)

User re-tested in the real terminal and confirmed: “Excellent, fully working.
Finish.” — with the spinner paused, the tall proposal open/close is clean, the
viewport stays put while reading scrollback (no more “scrolls back down after
X seconds”), and the 383ae52 surface is intact for content that fits.
