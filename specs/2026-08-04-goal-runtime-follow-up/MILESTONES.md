# Milestones: Goal runtime follow-up

## 2026-08-04 — Full post-implementation assessment

- Reviewed the 0.23 tool/command surface, lifecycle, completion/auditor paths,
  settings UI, task transactions, service boundary, concurrency behavior,
  persistence/ledger, experiment harness, packaging, tests, and living docs.
- Confirmed the five-tool/ten-command simplification and the main hardening
  changes are present.
- Confirmed user-visible defects in settings selection, repeated profile
  toggles, integer parsing, missing /goal-clear confirmation, and task
  confirmation labels.
- Confirmed completion-result, audit-abort ledger, simultaneous-writer,
  experiment-matrix, provider-smoke, portability, residual drafting-code, and
  documentation gaps captured in PRODUCT.md and TECH.md.
- Typecheck passed.
- Package dry-run passed with 39 package files; test scripts, cache, and specs
  remain excluded from the published package.
- The published/runtime dependency audit reports zero findings. The complete
  development graph reports six high-severity findings rooted in the current
  Pi SDK toolchain; the available direct fix is a major SDK upgrade and is
  planned with compatibility validation.
- External real-model experiments were intentionally not run because they are
  manual, opt-in, and incur provider usage.

## 2026-08-04 — Test startup remediation implemented

- Added a direct Node test runner with automatic root-unit/integration
  discovery, one-process execution, and focused adapters for the Pi AI,
  coding-agent, and TUI runtime values used by tests.
- Rewired test, test:unit, and test:integration; retained the original
  real-SDK, process-isolated test:serial diagnostic.
- Verified test:all reports 461 pass and 0 fail (452 unit plus 9 integration).
- Observed in this workspace: test:all completes in roughly 12 to 28 seconds
  depending on mounted-volume cache state, versus a previous default that was
  still incomplete after roughly 127 seconds and roughly 11 minutes for the
  serial path. The new path is about 23 to 55 times faster than that
  authoritative serial baseline.
  Timings are evidence, not portable performance guarantees.

## Planned milestones

1. Settings menu made declarative and fully operable.
2. Clear, task, and audit confirmation semantics corrected.
3. Completion failures propagated without success reports.
4. Cross-process revision/locking semantics implemented and race-tested.
5. Residual drafting runtime, UI, and policy code deleted.
6. Experiment matrix, smoke model, and timeout behavior hardened.
7. Pi SDK development graph upgraded and audited.
8. Integration matrix and living docs closed; release validation recorded.
