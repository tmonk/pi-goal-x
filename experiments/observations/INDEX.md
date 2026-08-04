# Observations index

The files in this directory are **historical evidence**, not current
instructions. They document what was observed in past real-model runs so the
records survive; none of them describe the shipped behavior of the current
`pi-goal` runtime.

- `iteration-log.md` — historical iteration notes (drafting-era details
  pruned).
- `final-stability-sweep.md` — historical stability-sweep summary.
- `final-stability-sweep-phase2.md` … `final-stability-sweep-phase5.md` —
  historical per-phase stability-sweep records.

## How to read these files

- Treat every statement as a snapshot of a past run, not as the current
  contract.
- For current authoritative behavior, read in this order:
  1. `../SUPPORTED_CASES.json` — the enforced experiment case matrix.
  2. `../README.md` — how to run experiments and what they verify.
  3. `../PLAN.md` — the release-gate policy.
  4. `../BASELINE.md` — the historical Stage 0 snapshot (also evidence, not
     instructions).

## Writing new observations

Append a new dated file for a new sweep (e.g.
`final-stability-sweep-2026-08-10.md`) and add it to this index. Update this
index whenever a file is pruned, renamed, or removed so the status of every
observation file stays explicit.
