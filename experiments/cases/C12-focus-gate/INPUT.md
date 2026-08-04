# C12 — focus consistency: /goal stays regular even for step-by-step topics

## Behavior under test

The user uses /goal (regular focus) but describes a sequential multi-step
task. The agent must NOT set mode="sisyphus" on its own — sisyphus requires
the user to explicitly invoke /sisyphus.

## Prompts

TURN: /goal I want to do a step-by-step task: first create file1.txt in the current directory with 'one', then create file2.txt with 'two'. autoContinue: true.
