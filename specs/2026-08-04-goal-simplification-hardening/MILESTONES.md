# Milestones: Goal simplification hardening

## 2026-08-04 — Full implementation assessment

- Reviewed the installed five-tool/ten-command implementation, runtime module
  split, service boundary, tasks, audit, persistence, accounting, unit tests,
  E2E artifacts, experiments, and living/historical documentation.
- Compared the implementation with the accepted 2026-08-03 product/technical
  spec and current Codex Goal semantics/source.
- Confirmed type checking passes.
- The authoritative serial unit suite passed: 459 tests, 0 failures, in
  649,859 ms. It has substantial inter-file startup gaps, reinforcing the plan
  to separate pure unit and handler-level integration suites.
- `npm pack --dry-run` passed and produced the expected 36-file package.
- Found release-blocking lifecycle issues: paused-record resurrection and the
  unreachable disabled-auditor completion path.
- Found the fixed-surface requirement is not implemented: lifecycle code still
  synchronizes a state-dependent subset and mutates ordinary Pi work-tool
  selection.
- Found task transaction, structural replacement, ledger semantics,
  diagnostics, E2E coverage, experiment currency, and documentation gaps
  detailed in PRODUCT.md and TECH.md.
- No runtime fixes were made during this assessment. Documentation corrections
  and this remediation plan are the only intended changes in this pass.

## Planned milestones

1. Lifecycle normalization and disabled-auditor completion fixed.
2. Fixed three/five tool profile installed; lifecycle synchronizer removed.
3. Task confirmation and disk-fresh transactions corrected.
4. Budget and ledger contracts hardened.
5. Drafting-era code and obsolete signatures deleted; tool modules split.
6. Unit, integration, E2E, and experiment suites aligned with the public API.
7. Living docs regenerated from verified behavior; full validation recorded.
