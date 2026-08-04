# C1 — vague topic should trigger clarifying questions, not goal creation

## Behavior under test

A vague topic must NOT create a goal immediately and must NOT start executing
work. The agent should ask the user clarifying questions (plain chat) before
any `create_goal` call.

## Prompts (one turn per line)

TURN: /goal help me organize my notes
