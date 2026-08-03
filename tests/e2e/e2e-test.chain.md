---
name: e2e-test
description: "Historical pi-goal E2E chain; unsupported on the 0.22 five-tool interface."
---

# Unsupported historical chain

Do not copy or run this chain. Its former completion protocol used removed tool
names and was not exercised by `npm test`.

Use `npm run test:serial` for the current local gate. A replacement integration
suite that exercises `create_goal`, `get_goal`, `update_goal`,
`set_goal_tasks`, and `update_goal_task` through registered handlers is planned
in the
[2026-08-04 hardening spec](../../specs/2026-08-04-goal-simplification-hardening/TECH.md).
