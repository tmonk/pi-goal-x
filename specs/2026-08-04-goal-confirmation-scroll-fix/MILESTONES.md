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
