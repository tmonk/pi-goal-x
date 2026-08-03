# pi-goal Experiments

This directory contains optional real-model experiment material for
`pi-goal-x`. Runs incur model usage and are not part of `npm test`.

The supported five-tool release cases are C20-C26:

- core five-tool selection and direct explicit goal creation;
- user ownership of lifecycle commands;
- the three-consecutive-turn blocked policy;
- completion audit from actual evidence without model paperwork;
- multiple open goals with session-local focus;
- consolidated task tools;
- token-budget wrap-up behavior.

C1-C19 and B1-B2 are pre-simplification cases. Their inputs/rubrics still
reference removed drafting and lifecycle tools and must not be treated as a
current gate. They will either be migrated or moved under an explicit legacy
directory by the hardening work. `BASELINE.md` remains a historical Stage 0
snapshot.

## Running

```bash
cd experiments
bash harness/run.sh C20-core-tool-selection --count 3 --grade --no-smoke
```

Experiment outputs under `runs/` are generated artifacts and are not part of the package release.
