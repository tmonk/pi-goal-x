# Experiment Plan

The experiment suite is an optional end-to-end harness for checking `pi-goal` behavior with real pi sessions and model calls.

Current supported coverage goals (C20-C26):

1. Explicit requests select `create_goal`; removed tools are never called.
2. Lifecycle changes remain user-owned slash commands.
3. The same blocker is attempted across three goal turns before
   `update_goal(status="blocked")`.
4. `update_goal(status="complete")` contains no paperwork and survives an
   evidence-based independent audit.
5. Focus remains human-owned while multiple goals remain durable.
6. `set_goal_tasks` owns structure and `update_goal_task` owns status.
7. Token-budget exhaustion wraps up without inventing completion.

B1-B2 and C1-C19 were MIGRATED to the five-tool interface by the hardening
work (2026-08-05): the full supported matrix is `SUPPORTED_CASES.json`
(B1-B2 + C1-C20 through C26), and removed tool names appear only in negative
rubric assertions.

## Release gate

C20-C26 remain the release evaluation set. Per the hardening plan's product
decision (and the author-only verification policy), real-model runs are the
manual, opt-in pre-release gate: run each case at least three times on the
supported model matrix and record pass rates in MILESTONES.md before a release.
They are NOT part of `npm test` and incur model usage.
