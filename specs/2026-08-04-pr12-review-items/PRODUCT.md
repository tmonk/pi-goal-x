# Product: PR #12 review items — four hardening fixes

## Status

Shipped (all four review items at the confirmed levels, tested, documented).

## Outcome

Address the four items in turnercore's "The List" review comment on PR #12
(`simplification → main`), at the levels the user confirmed via questionnaire:

1. **Failure-safe provider auto-pause — minimal level.** A turn/run whose
   assistant message has `stopReason: "error"` (provider failure or genuinely
   empty terminal response) never queues an auto-continuation. The user-visible
   effect: after a provider error the goal stops self-continuing instead of
   entering an unbounded checkpoint/error retry storm. The persisted
   failure-counter + configurable threshold version was deliberately **not**
   built (hieudmg's implementation is unreadable; the minimal danim47c guard
   was confirmed instead).
2. **Modal Escape isolation — full.** While any goal-owned modal is open
   (questionnaire, task-list confirmation, goal-settings menu, goal
   picker/focus selects, task-list overlay, escape dialog), every key — Escape
   included — is owned by the dialog; the global Escape-to-pause handler yields
   (`undefined`). A depth counter (enter/exit via `try/finally` and `.finally`)
   keeps nested goal modals guarded. User-visible: Escape in a proposal or
   settings dialog closes the dialog and never pauses the running goal.
3. **Concurrency — additive usage merge only.** `persist()` no longer drops the
   session's usage/accounting delta on a revision conflict: it merges the delta
   additively onto the disk record and advances its revision, never clobbering
   the disk's authoritative fields. Canonical content hashes were **not** built
   (bianyeyu's implementation is unreadable; value judged speculative).
4. **Goal Settings redesign — ll01 port + sections + wording.** `/goal-settings`
   is now sectioned (Goal behavior / Task tracking / Completion auditor); the
   provider/model rows open a searchable auditor model picker (current
   session/default entry, authenticated models from the model registry with a
   ✓ marker on the exact current selection, and an advanced manual
   provider/model entry); thinking level is a selector (`(default)` +
   off/minimal/low/medium/high/xhigh); the auditor enable/disable row reads
   "auditor disabled". Provider-only auditor configuration is refused with a
   clear error instead of silently picking the first available model.

## Behavior notes

- The four fixes are additive guards: rendering, dialog surfaces, and the
  existing 383ae52-restored UI are untouched; closed/normal paths behave
  exactly as before.
- Accounting on error turns still runs (tokens/elapsed are charged); only the
  continuation queue is suppressed.
- Usage merge keeps usage monotonic (deltas are clamped at zero) and preserves
  the disk's objective/tasks/status on conflict.
