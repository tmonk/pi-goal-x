# Milestones: PR #12 review items — four hardening fixes

## Plan

Read turnercore's "The List" comment on PR #12 via `gh`, follow the referenced
fork commits, confirm scope with the user via questionnaire, implement each
item at the confirmed level with tests, validate (tsc + full suite), document,
commit, and get user signoff.

## Reading the reference implementations (2026-08-04)

- `danim47c/pi-goal-x@9812cee` — readable, full patch: minimal
  `isErrorAssistantMessage` guard in the end-of-turn handlers.
- `bn-l/pi-goal-x@47632b7` + `02cb791` — readable, complete: `inGoalUiDialog`
  flag + try/finally/.finally around every goal dialog; commit message
  documents the onTerminalInput-before-overlay hazard. Also includes an
  out-of-scope session-resume auto-focus fix (not ported).
- `ll01/pi-goal-x@cb6760b` — readable, complete: `auditor-selector.ts`,
  filter-then-select flow, provider-only refusal. Bundles an out-of-scope
  run_bg completion gate (not ported).
- `bianyeyu/pi-goal-x@4d7a776` and `hieudmg/pi-goal-x` — both **404**
  (deleted/private); content-hash and persisted-failure-counter designs are
  unreadable, which informed the user's scope choices (minimal guard, no
  hashes).

User questionnaire outcome: (1) minimal danim47c guard; (2) bn-l port with
depth counter; (3) usage merge only; (4) ll01 selector + sections + wording.

## Implementation log

### 1. Provider-error continuation guard

- `goal-format.ts`: `isErrorAssistantMessage` / `hasErrorAssistantMessage`.
- `goal-events.ts`: guard in `turn_end` (refresh + updateUI + return) and in
  `agent_end` (persist + updateUI + return).
- Tests in the golden continuation-contract file. One harness subtlety
  discovered: `session_start` arms a continuation with the harness's non-idle
  ctx, so the turn_end positive tests must first cancel it with a user-driven
  `before_agent_start`, then drive `turn_end` with an idle ctx so the queued
  continuation actually sends.
- Result: 4 new tests; suite 486/0.

### 2. Modal Escape isolation

- `goal-state.ts`: `goalModalDepth` + `enterGoalModal`/`exitGoalModal`
  replace `showingEscapeDialog` (kept get/set for the depth value).
- `goal-widget.ts`: `goalModalDepth > 0 → return undefined`; task-list overlay
  `.finally()`.
- `try/finally` at: escape dialog, proposal dialog, both questionnaire tool
  paths, active-draft picker, goal picker, focus select, settings loop, resume
  focus picker, task-list confirmation.
- Test file drives the real extension: Ctrl+Shift+T opens the overlay via the
  keybinding (`\x1b[116;6u`), Escape in-modal never pauses, Escape after
  overlay close pauses.
- Result: 2 new tests; suite 488/0.

### 3. Additive usage merge

- `goal-service.ts`: `lastPersistedUsage` baseline, `trackBaseline` at
  reconcile/apply/create/persist, conflict branch merges the clamped delta
  onto the disk record.
- Found and fixed a real double-count bug during testing: the baseline after a
  merge must be the **written** usage (memory now holds it), not the pre-merge
  current usage, or the next success-path persist re-adds the merged delta.
- Result: 2 new two-writer tests; suite 490/0.

### 4. Settings redesign

- New `extensions/auditor-selector.ts` (ll01 port).
- Settings menu: sectioned rows, thinking selector, modelSelector
  filter-then-select flow; `resolveAuditorModel` provider-only refusal.
- Tests: 6 selector + 2 auditor + 1 sectioned-menu render.
- Result: 9 new tests; suite 499/0.

### 5. Validation, docs, signoff

- `npm run check` 0 errors; full unit suite 499 pass / 0 fail.
- Docs: PRODUCT/TECH/MILESTONES in `specs/2026-08-04-pr12-review-items/`;
  CHANGELOG entries.
- Commits landed; awaiting the user's real-terminal confirmation (Escape in
  proposal/settings dialogs closes without pausing, `/goal-settings` picker
  works, no regressions).
