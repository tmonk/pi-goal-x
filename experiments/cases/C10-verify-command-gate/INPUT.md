# C10 — evidence-gated completion: every task carries evidence; the auditor verifies actual files

## Behavior under test

In the current interface, per-step verification is owned by the independent
auditor (from actual evidence) plus task evidence via `update_goal_task`. The
agent must:
- create the three files;
- set a task list and mark each task complete via `update_goal_task` with an
  evidence note that a verifier could re-run;
- call `update_goal({status:"complete"})` only after all tasks are done.

## Prompts

TURN: /sisyphus "Sisyphus 3 steps with strict verification: 1) create file alpha.txt containing exactly 'hello' (no newline). 2) create file beta.txt containing exactly 'world' (no newline). 3) create file gamma.txt containing exactly 'hello world' (no newline). After the goal is created, use set_goal_tasks with three tasks, mark each complete via update_goal_task with an evidence note that proves the file content (e.g. a bash -c check), and only then call update_goal(status=complete). Do NOT call update_goal(status=complete) until all 3 tasks have succeeded. autoContinue: true."
