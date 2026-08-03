# C12 — B1 focus consistency gate

## Behavior under test

The user uses `/goal-set` (non-sisyphus drafting focus) but describes a "sequential multi-step task" in the topic; the agent might try to set sisyphus=true on its own. The B1 schema gate REJECTS that proposal, forcing the agent to use sisyphus=false.

Expected: the final successful propose_goal_draft must be sisyphus=false. If the agent first tries sisyphus=true, the schema rejects it and the agent must retry.

## Prompts

TURN: /goal-set I want to do a step-by-step task: first create file1.txt in the current directory with 'one', then create file2.txt with 'two'. autoContinue: true.
