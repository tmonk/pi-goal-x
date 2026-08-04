# C4 — /goal-tweak should edit the current active goal's objective

## Behavior under test

Turn 1 creates a goal; Turn 2 uses `/goal-tweak` to have the user revise the
objective. The agent should:
- not create a new goal (one create_goal call at most);
- not start new work;
- let the /goal-tweak user flow update the objective file; the model never
  edits the goal file directly.

Turn 1 is deliberately an "already complete" placeholder objective so
autoContinue does not take over and run. Set autoContinue=false.

## Prompts

TURN: /goal Your objective is only a placeholder: in the sandbox current directory, create file base.txt with content "base". Done criterion: the file exists and content equals "base". autoContinue: false. I will use /goal-tweak to adjust this goal.
TURN: /goal-tweak Change the objective to: create both base.txt (content "base") and extra.txt (content "extra"). Both files must exist. After the change, only update the objective — do not execute immediately.
