# Product: Goal runtime follow-up

## Status

Ready for review. This remediation plan follows the independent post-0.23
implementation assessment. It preserves the five-tool model surface and the
ten-command user palette.

## Outcome

Keep the Codex-inspired interface small and stable while making every retained
feature predictable and easy to operate:

- three core model tools, plus two task tools when tasks are enabled;
- separate, tab-completable slash commands for frequent user-owned actions;
- durable goals, tasks, budgets, session-local focus, and independent audit;
- no legacy drafting UI or vocabulary leaking into the current workflow;
- safe destructive actions and safe multi-session writes;
- fast local validation and an enforceable experiment release set.

## Assessment summary

The 0.23 hardening solved the major lifecycle and surface problems: persisted
status is authoritative, auditor-disable completion works, the goal-tool
profile is fixed, task operations reconcile from disk before mutation, token
budgets are validated, task reopening has an honest ledger event, and ledger
failures are observable.

The follow-up audit found these remaining gaps.

### P1 — user-visible correctness

1. The settings menu displays disableTasks and disableContracts but refuses to
   select them. autoSelectSingleGoal is selectable in code but is not displayed,
   so it is also unreachable.
2. Toggling task availability twice in one menu session can leave the installed
   three/five profile inconsistent because saves compare with the value captured
   only when the menu opened.
3. subtaskDepth accepts values such as 1.5 as 1 through partial integer parsing.
4. /goal-clear archives immediately even though its description and product
   contract promise confirmation.
5. Task-list confirmation returns a task-only decision but presents Confirm
   Goal Draft and create-this-goal labels.
6. A failed completion commit can still produce a success-looking report
   because the shared helper does not inspect the typed service result.
7. Escape-aborted audits can append duplicate audit-skipped events, and the
   continue-working choice currently pauses the goal despite its label.

### P1/P2 — durability and simplification

1. Reconciliation happens at operation start, but there is no cross-process
   lock or compare-and-swap. Truly simultaneous writers remain last-write-wins.
2. goal-questionnaire.ts, drafting event/focus vocabulary, hidden debug
   helpers, and unused completion-paperwork policy remain after the advertised
   drafting cleanup.
3. Experiment case resolution does not enforce SUPPORTED_CASES.json, the
   provider smoke test ignores a model override, and timeout behavior assumes
   GNU tooling that is not standard on macOS.
4. Integration coverage does not exercise every settings row, repeated task
   toggles, clear cancellation, commit failure, duplicate audit events, or a
   captured active-tool profile.
5. The published dependency set audits clean when development dependencies are
   omitted, but the current Pi SDK development graph reports six high-severity
   advisories. The direct SDK fix is a major-version upgrade and needs
   compatibility validation rather than an automatic audit-force rewrite.

## Product requirements

### Settings

- Every displayed settings row is selectable and every selectable field is
  displayed.
- Boolean settings toggle directly; typed settings validate the entire input.
- A disableTasks change immediately installs the correct fixed profile.
  Repeated toggles in one menu session must remain correct.
- Headless /goal-settings continues to report the file path without attempting
  an interactive edit.

### Destructive and confirmation UX

- /goal-clear asks for confirmation after selection and before archive.
  Cancellation changes no file, focus entry, ledger entry, or runtime state.
- Task-list confirmation uses task-specific neutral language and returns only
  a task decision. It has no auditor or goal-creation controls.
- Audit-abort choices say what they do. Continue working leaves the goal active;
  a pause choice must explicitly say Pause and continue later.

### Completion and ledger correctness

- A completion report claims success only after GoalService returns ok.
- An aborted audit produces exactly one canonical ledger outcome for the
  eventual user choice.
- Write and ledger diagnostics remain observable.

### Concurrent mutation safety

- Goal mutations across processes are serialized or guarded by an optimistic
  revision check.
- A stale writer receives a typed conflict and retries only when its operation
  is still valid.
- Whole-tree task replacement is documented as authoritative after conflict
  validation; it must not claim to preserve structure it intentionally omits.

### Runtime simplification

- Remove the questionnaire/proposal implementation once task confirmation has
  its own small component.
- Remove or rename drafting-only event types, focus fields, debug paths,
  comments, and tests. Preserve read compatibility only for proven historical
  records.
- Remove unused completion and verification paperwork from the active auditor
  contract, or document and test a concrete consumer.

### Validation and experiments

- Normal unit and integration commands use automatic discovery, one-process
  execution, and explicit test-only SDK adapters; every run reports every case.
- Keep a real-SDK, process-isolated serial path for compatibility diagnosis.
- Enforce the supported experiment matrix before creating a run directory.
- Smoke-test the selected provider/model pair and use a portable timeout.
- Real-model experiments stay manual and opt-in.
- Upgrade the development Pi SDK family as one compatible set and require both
  the full development audit and the published/runtime audit to pass, or record
  a time-bounded exception with exact reachability analysis.

## Non-goals

- Collapsing the interface to one universal tool.
- Returning to phase-dependent tool visibility.
- Replacing frequent slash commands with a nested command grammar.
- Adding agent-owned pause, resume, clear, focus, or settings tools.
- Running paid model experiments as part of normal tests.

## Release criteria

1. All P1 flows have handler-level regression tests.
2. A deterministic two-writer test proves the chosen conflict behavior.
3. Typecheck, dependency audits, all fast tests, the real-SDK compatibility run, package
   dry-run, and diff checks pass.
4. README, architecture, agent-flow, changelog, experiment docs, and the
   supported matrix describe only verified implementation.
