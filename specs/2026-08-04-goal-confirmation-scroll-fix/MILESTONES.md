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
