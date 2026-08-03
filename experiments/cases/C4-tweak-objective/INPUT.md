# C4 — `/goal-tweak` should edit the current active goal's objective

## Behavior under test

Turn 1 creates a goal; Turn 2 uses `/goal-tweak` to have the agent revise the objective to expand scope. The agent should:

- not create a new goal (no create_goal call)
- not start new work
- apply the tweak through `propose_goal_tweak` — the sanctioned channel; the goal file itself is managed by the extension

Turn 1 is deliberately written as an "already complete" placeholder objective so autoContinue does not take over and run. Set autoContinue=false.

## Prompts

TURN: /goal-set Your objective is only a placeholder: in the sandbox current directory, create file base.txt with content "base". Done criterion: the file exists and content equals "base". autoContinue: false. I will use /goal-tweak to adjust this goal.
TURN: /goal-tweak Change the objective to: create both base.txt (content "base") and extra.txt (content "extra"). Both files must exist. After the change, only update the objective — do not execute immediately.
