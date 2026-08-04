# B2 — task completion via the current task tools (baseline)

## Behavior under test

The goal is a small two-file task. The agent should use the current-interface
task workflow:
- after the goal is created, set the task list via `set_goal_tasks` (two tasks:
  create alpha.txt, create beta.txt);
- as each file is created, mark its task complete via `update_goal_task` with
  an evidence note;
- when both tasks are complete, call `update_goal({status:"complete"})`.

## Prompts

TURN: /goal In the sandbox current directory, create file alpha.txt with content "one" and file beta.txt with content "two". Done criteria: both files exist with exactly those contents; no other files are modified. Use the goal task tools: after the goal is created, set a task list with two tasks (alpha.txt, beta.txt) via set_goal_tasks, mark each task complete via update_goal_task with an evidence note as soon as its file is verified, and only then call update_goal(status=complete). autoContinue: true.
