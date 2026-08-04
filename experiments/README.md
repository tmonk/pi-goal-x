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

B1-B2 and C1-C19 have been MIGRATED to the current interface: every case now
targets the five tools (create_goal, get_goal, update_goal, set_goal_tasks,
update_goal_task), the ten-command palette, and user-owned lifecycle commands,
with removed tool names appearing only in negative rubric assertions. The full
supported matrix is machine-readable in `SUPPORTED_CASES.json`; `BASELINE.md`
remains a historical Stage 0 snapshot.

## Running

Every case in `SUPPORTED_CASES.json` is runnable with the harness:

```bash
cd experiments
bash harness/run.sh C20-core-tool-selection --count 3 --grade --no-smoke
bash harness/run.sh B2-task-completion --count 3 --grade --no-smoke
```

The harness installs the fixed three/five-tool profile at session start, so
real-model runs exercise the same tool surface as the local suites.

## Supported case matrix

`SUPPORTED_CASES.json` is the machine-readable list of supported cases
(B1-B2 + C1-C26 after migration). In 0.23 it is documentation rather than an
enforced allowlist: `run.sh <case-id>` accepts any existing case directory with
an `INPUT.md`. Matrix enforcement is part of the runtime follow-up plan.

Experiment outputs under `runs/` are generated artifacts and are not part of the package release.
