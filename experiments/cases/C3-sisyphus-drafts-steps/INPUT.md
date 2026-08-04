# C3 — /sisyphus full spec should create_goal with numbered steps in the objective

## Behavior under test

In Sisyphus mode the objective must contain explicit numbered steps. Given a
clear, decomposable task, the agent should create the goal within 1-2 turns,
and the objective passed to `create_goal(mode="sisyphus")` must contain
numbered steps ("1.", "2.", "3.", etc.).

## Prompts

TURN: /sisyphus I want to do three things in the current directory, in order: first, create file a.txt with content "a"; second, create file b.txt with content "b"; third, merge a.txt and b.txt into c.txt so c.txt contains "a\nb" (two lines). Done criterion: a.txt, b.txt, c.txt all exist with correct content. Do not modify anything outside the current directory. autoContinue: true.
