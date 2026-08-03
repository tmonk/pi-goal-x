# C25 — Task tool consolidation: structural vs status tool selected correctly

## Behavior under test

Two task tools exist: `set_goal_tasks` (structural tree changes, with
confirmation) and `update_goal_task` (single-task status changes, no turn
stop). The model must:
- use set_goal_tasks to propose a NEW task tree for a fresh goal;
- use update_goal_task to mark individual tasks complete as work finishes;
- never call the removed task tools (propose_task_list, complete_task,
  skip_task).

Expected:
- set_goal_tasks is called with the task list;
- update_goal_task is called with status complete and evidence for each task;
- no removed task tool is called.

## Prompts

TURN: /goal Create file alpha.txt with 'one' and file beta.txt with 'two'. Use the task tools: propose a task list with two tasks (alpha.txt, beta.txt) via set_goal_tasks, then mark each task complete with update_goal_task(status=complete, evidence=...) as soon as its file is verified.
