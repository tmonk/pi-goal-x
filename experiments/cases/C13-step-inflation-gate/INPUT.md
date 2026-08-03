# C13 — B2 step preservation gate (no agent step inflation)

## Behavior under test

The user gives an explicit 2-step plan via `/goal-sisyphus`. The agent might try to "helpfully" add a "step 0: check whether X exists" reconnaissance step. The B2 schema gate REJECTS it, because proposed steps > user steps + 1. The agent must preserve the user's original 2 steps.

This is a direct reproduction of a Phase 4 C6 1/3 failure plus its fix verification.

## Prompts

TURN: /goal-sisyphus Strictly do two things in order: 1) create a.txt in the current directory with content "alpha". 2) create b.txt in the current directory with content "beta". Adding any extra steps (including "check", "verify", "prepare" style ones) is not allowed. autoContinue: true.
