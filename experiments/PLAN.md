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

C1-C19 and B1-B2 are historical and currently unsupported. The hardening plan
requires migrating them or excluding them through a machine-readable supported
case list before `run.sh all` can be a release gate.
