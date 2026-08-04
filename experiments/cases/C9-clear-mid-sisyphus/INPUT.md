# C9 — user runs /goal-clear while a sisyphus goal is executing; the agent stops

## Behavior under test

The user runs /goal-clear (user-owned) while a sisyphus goal is executing. The
agent must stop, and no active goal may be left behind.

## Prompts

TURN: /sisyphus "Step 1: create a.txt with 'a'. Step 2: append content of missing.txt to a.txt. missing.txt will be provided later by the user. After /goal-clear, do not try to recover or create missing files yourself."
TURN: /goal-clear
