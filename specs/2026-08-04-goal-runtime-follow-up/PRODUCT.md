# Product: Goal runtime follow-up

## Status

Implementing. Stages 1–4 are shipped; guided drafting is restored in the
working tree, but its compatibility and lifecycle edges still need completion.
This plan preserves the five-tool execution surface while restoring the full
guided goal-drafting experience as a transient, user-invoked mode.

## Outcome

Keep the Codex-inspired interface small and stable while making every retained
feature predictable and easy to operate:

- three core execution tools, plus two task tools when tasks are enabled;
- separate, tab-completable slash commands for frequent user-owned actions;
- durable goals, tasks, budgets, session-local focus, and independent audit;
- full guided drafting with structured questions, iterative refinement,
  agent-proposed tasks and verification contracts, and final confirmation;
- explicit direct commands for users who intentionally want to skip drafting;
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
2. The simplification work incorrectly treated the valuable human-facing
   drafting workflow as model-tool clutter. The questionnaire and proposal
   runtime must be restored and maintained, not deleted.
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

### Shipped baseline

The settings, confirmation/audit UX, completion-transaction, and
cross-process mutation requirements below are retained as historical design
records: their implementation landed in the current branch before this
drafting-parity update. The remaining implementation scope is Stage 5.1 and
the still-unshipped experiment, dependency, and release work.

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

### Goal creation and drafting

- `/goal [seed]` starts a guided regular-goal drafting phase. It never creates
  the durable goal immediately.
- `/sisyphus [seed]` starts the same guided phase with ordered-step and
  per-step-done-criteria requirements.
- `/goal-direct <objective>` creates a regular goal immediately and skips all
  drafting questions and confirmation.
- `/sisyphus-direct <objective>` creates a Sisyphus goal immediately and skips
  drafting.
- Bare `/goal` starts drafting with no seed; it is not the status command.
  `/goal-list` remains the human-facing status/list entry point.
- During drafting, the agent can ask one structured question or a batch
  questionnaire, discuss/refine answers in ordinary conversation, and submit a
  complete proposal for confirmation.
- The final proposal includes the full objective, success criteria,
  boundaries, verification contract when enabled, and an agent-chosen task
  tree when tasks are enabled.
- Confirmation creates the goal and its tasks atomically, focuses it, clears
  drafting state, restores the fixed execution profile, and begins normal
  execution. Continue-refining preserves the draft; cancel creates nothing.
- No active goal file or task list is written before final confirmation.

### Drafting versus execution surface

- The normal execution surface remains exactly the fixed three/five tools.
- Guided drafting may install a separate transient drafting profile containing
  structured question and final-proposal tools. These tools exist only while a
  user-started draft is active and disappear on confirm, cancel, or session
  cleanup.
- Simplification must remove obsolete duplication, not the questionnaire,
  proposal confirmation, task co-design, verification-contract formation, or
  iterative refinement experience.
- `/goal-tweak` should reuse the same refinement/questionnaire machinery for an
  existing objective rather than silently replacing it in one step.

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

## Restored-workflow parity

The first restoration corrected default drafting, questionnaires, task
proposal, and confirmation. These remaining reductions from v0.21 must be
implemented or resolved as explicit product decisions:

1. `/goal-cancel` clears an in-progress guided draft without creating,
   archiving, pausing, or modifying a durable goal. It replaces the
   overloaded historical `/goal-abort` draft-cancellation behavior.
2. `/goal-status` restores the compact focused-goal summary lost when bare
   `/goal` became the drafting entry. `/goal-list` remains the pool view.
3. Goal-draft confirmation offers a per-draft completion-auditor choice,
   defaulting to effective settings. Confirmation persists the selected value
   as `skipAuditor` on a created or tweaked goal.
4. Agent lifecycle ownership requires an explicit compatibility decision:
   restore bounded agent pause/abandon reports, or retain user-only pause and
   clear and document that agents can only report `blocked` after the
   three-consecutive-turn rule.
5. Agent-initiated objective-change proposals require the same decision. The
   user-started `/goal-tweak` flow is restored, but `propose_goal_tweak` is
   not. A retained user-owned model must ask the user to invoke `/goal-tweak`;
   a restored path must enter the same confirmation flow.
6. `update_goal({status:"complete"})` intentionally replaced `complete_goal`.
   Decide whether an optional, non-authoritative executor completion summary
   should again be supplied to the auditor.

## Non-goals

- Collapsing the interface to one universal tool.
- Removing or weakening guided drafting, questionnaires, task co-design, or
  final proposal confirmation.
- Exposing drafting tools during ordinary goal execution.
- Replacing frequent slash commands with a nested command grammar.
- Reintroducing an overloaded `/goal-abort` command; draft cancellation and
  durable-goal abandonment must have unambiguous separate semantics.
- Running paid model experiments as part of normal tests.

## Release criteria

1. All P1 flows have handler-level regression tests.
2. `/goal` and `/sisyphus` pass full questionnaire → refinement → proposal →
   atomic confirmation E2E tests, including agent-chosen nested tasks.
3. `/goal-direct` and `/sisyphus-direct` pass no-question immediate-creation
   tests.
4. A deterministic two-writer test proves the chosen conflict behavior.
5. Typecheck, dependency audits, all fast tests, the real-SDK compatibility run, package
   dry-run, and diff checks pass.
6. README, architecture, agent-flow, changelog, experiment docs, and the
   supported matrix describe only verified implementation.
7. `/goal-cancel`, `/goal-status`, per-draft auditor selection, and the final
   lifecycle/tweak/completion-summary compatibility decisions each have
   handler-level tests and accurate command/tool documentation.
