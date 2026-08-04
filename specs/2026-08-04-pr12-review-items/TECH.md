# Tech: PR #12 review items — four hardening fixes

## 1. Provider-error continuation guard (minimal, danim47c 9812cee port)

Reference: `danim47c/pi-goal-x@9812cee` ("fix: stop auto-continue after
provider errors") — `isErrorAssistantMessage` = `role === "assistant" &&
stopReason === "error"`.

- `extensions/goal-format.ts`: added `isErrorAssistantMessage` and
  `hasErrorAssistantMessage` beside the existing aborted/toolUse variants.
- `extensions/goal-events.ts`:
  - `turn_end`: after the aborted check, `isErrorAssistantMessage(message)` →
    `refreshGoalDisplayFromDisk` + `updateUI` + `return` (before the archive
    and continuation-queue block). Accounting already ran at the top.
  - `agent_end`: after the aborted check, `hasErrorAssistantMessage(event.messages)`
    → `persist` + `updateUI` + `return` (no `queueContinuation`). This is the
    path the review comment flags ("agent_end can still queue another
    continuation after an unsuccessful turn").

Tests (`tests/goal-stale-continuation-golden.test.ts`, "provider-error guard"
section): error `turn_end` never queues; normal work turn still queues (idle
ctx, after cancelling the session-start armed continuation via a user-driven
`before_agent_start`); error `agent_end` never queues; normal `agent_end`
still queues.

## 2. Modal Escape isolation (bn-l 47632b7 + 02cb791 port)

Reference: bn-l's commit message documents the hazard — "The onTerminalInput
handler runs before the focused TUI overlay, so it was consuming Escape and
calling pauseActiveGoal() before the dialog could process the key." Their fix:
an `inGoalUiDialog` flag checked first in `onTerminalInput`, set with
`try/finally` around every goal-owned dialog.

Our port uses a **depth counter** (the comment asks for a "nesting/depth
mechanism"):

- `extensions/goal-state.ts`: `showingEscapeDialog: boolean` replaced by
  `goalModalDepth` (+ `enterGoalModal()` / `exitGoalModal()`, clamped ≥ 0),
  exposed on the `GoalCore` interface.
- `extensions/goal-widget.ts` `syncTerminalInputPause`: first line of the
  handler `if (core.goalModalDepth > 0) return undefined;` — no key
  interception while any goal modal is open. Ctrl+Shift+T task-list overlay is
  fire-and-forget, so it uses `.finally(() => core.exitGoalModal())`.
- `try/finally` wraps: escape dialog (`goal-completion.ts`), proposal dialog
  and both questionnaire tool paths plus the active-draft picker
  (`goal-drafting.ts`), goal picker / focus select / settings menu loop
  (`goal-commands.ts`), resume focus picker (`goal-events.ts`), task-list
  confirmation (`goal-task-tools.ts`).

Tests: `tests/goal-modal-escape.test.ts` drives the real extension — Ctrl+Shift+T
(`\x1b[116;6u`) opens the task-list overlay through the keybinding (enters the
modal), Escape while open returns `undefined` and never calls
`pauseActiveGoal` (asserted via the absence of the "Goal paused." notify),
and after the overlay's `done()` closes it (modal exits), Escape pauses again.
Regression guard: Escape with no modal open still pauses.

## 3. Additive usage merge on persist revision conflict

`extensions/goal-service.ts` `persist()` previously returned `null` on a
revision mismatch, silently dropping the session's token/time accounting
deltas in multi-process scenarios. Now:

- The conflict branch re-reads the disk goal, computes the session delta since
  the **baseline** (`lastPersistedUsage`), clamps at zero, and writes the disk
  record with `usage = disk + delta`, `revision = disk + 1`, `updatedAt = now`,
  with all authoritative fields (objective/tasks/status) taken from disk via
  `mergeGoalPromptFromDisk`. Returns `null` only when the delta is zero.
- Baseline tracking (`trackBaseline`) keeps the delta exact and prevents
  double-counting: it is recorded at reconcile (`reconcileFocused`), apply
  commit, create, and every successful persist/merge — the value memory usage
  is relative to. The first-persist fallback (no baseline yet) uses the disk
  usage read at conflict time.
- A merge's baseline is the **written** usage (what memory now holds), so a
  subsequent success-path persist does not re-add the merged delta.

Tests (`tests/goal-service.test.ts`, "persist additive usage merge on revision
conflict"): writer A persists baseline (50/10), writer B bumps revision and
usage (70/12) and changes the objective; A persists with 80/17 → merged 100/19,
revision advanced, B's objective preserved, and a following persist does not
double-count. A second test covers the no-baseline fallback (100/30 added,
B's objective preserved).

## 4. Goal Settings redesign (ll01 cb6760b port + sections + wording)

Reference: `ll01/pi-goal-x@cb6760b` added `auditor-selector.ts` and a
filter-then-select flow, and made `resolveAuditorModel` refuse provider-only
config.

- `extensions/auditor-selector.ts` (new): `AuditorModelSummary`,
  `AuditorChoice` (`default` | `model` | `manual`), `auditorModelLabel`,
  `configuredAuditorModelKey`, `buildAuditorModelChoices` (default entry shows
  the session model or "(system default)", ✓ on the exact configured
  `provider/model`, authenticated models sorted, trailing manual entry),
  `filterAuditorModelChoices` (keeps default+manual; filters models by label),
  `parseManualAuditorModel` (strict `provider/model`), `thinkingLevelChoices`.
- `extensions/goal-commands.ts` settings menu: `SETTING_ROWS` gains a
  `section` field ("Goal behavior" / "Task tracking" / "Completion auditor")
  and the menu renders section headers (selecting one continues); the
  `disabled` row label reads "auditor disabled"; the `thinking` row uses
  `thinkingLevelChoices` select; the `provider`/`model` rows (kind
  `modelSelector`) run the filter-then-select picker using
  `ctx.modelRegistry.getAvailable()` and `ctx.model`, applying the same
  `provider+model` pair; `settingsLines` unchanged for save notifications.
- `extensions/goal-auditor.ts`: `resolveAuditorModel` (now exported) refuses
  provider-only configuration — "Provider-only auditor configuration is
  refused; select an explicit model for provider: X" — instead of silently
  picking the first available model; the error surfaces as a disapproved audit
  result.

Tests: `tests/goal-auditor-selector.test.ts` (6 tests: choices/✓ markers,
filter, manual parse, key, thinking levels) and additions to
`tests/goal-auditor.test.ts` (provider-only refusal; explicit + session-model
resolution) and `tests/goal-command-palette.test.ts` (sectioned menu render
with the "auditor disabled" wording).
