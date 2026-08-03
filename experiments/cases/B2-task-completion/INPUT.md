# B2 — task completion via the current task tools (baseline)

## Behavior under test

The goal is a small two-file task. The agent should use the current-interface task workflow:
- after the goal is active, propose the task list via `propose_task_list` (two tasks: create alpha.txt, create beta.txt)
- as each file is created, mark its task complete via `complete_task` with an evidence note
- when both tasks are complete, call `complete_goal`

This is the current-interface baseline for the task-tree behavior that Stage 4 consolidates into `set_goal_tasks` / `update_goal_task`.

## Prompts

TURN: /goal-set In the sandbox current directory, create file alpha.txt with content "one" and file beta.txt with content "two". Done criteria: both files exist with exactly those contents; no other files are modified. Use the goal task tools: after the goal is active, propose a task list with two tasks (alpha.txt, beta.txt) via propose_task_list, mark each task complete with complete_task plus an evidence note as soon as its file is verified, and only then call complete_goal. autoContinue: true.
