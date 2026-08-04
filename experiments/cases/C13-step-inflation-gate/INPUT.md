# C13 — step preservation: no agent step inflation in /sisyphus

## Behavior under test

The user gives an explicit 2-step plan via /sisyphus. The agent must preserve
the user's original 2 steps in the objective passed to
`create_goal(mode="sisyphus")` — no invented "step 0" reconnaissance or
"check/verify/prepare" steps.

## Prompts

TURN: /sisyphus Strictly do two things in order: 1) create a.txt in the current directory with content "alpha". 2) create b.txt in the current directory with content "beta". Adding any extra steps (including "check", "verify", "prepare" style ones) is not allowed. autoContinue: true.
