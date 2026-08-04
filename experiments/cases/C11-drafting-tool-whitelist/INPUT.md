# C11 — creation is a direct explicit tool call (no drafting surface)

## Behavior under test

The drafting phase and its tool whitelist are removed: goal creation is a
direct `create_goal` call on the explicit /goal request, and goal work happens
after creation. The agent must not confuse the removed drafting flow with the
stable surface.

## Prompts

TURN: /goal In the current directory, create a README.md with content "Test C11". If the current directory already has a README file, skip it. autoContinue: true.
